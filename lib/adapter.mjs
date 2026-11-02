import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { stat } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeError, readRequest, planTurn, digest } from "./context.mjs";
import { Sessions } from "./sessions.mjs";
import { runTurn } from "./native.mjs";
import { connectBroker } from "./broker.mjs";
import { requestIdentity } from "./identity.mjs";
import { nativeCatalogPrompt } from "./native-catalog.mjs";
import { secretRequests } from "./secrets.mjs";

const apiError = (error) => ({
  error: {
    message: error.message,
    type: error.safeToFallback ? error.type : "native_harness_error",
    code: error.code ?? "native_task_failed",
  },
});
const tokensOf = (usage) => ({
  input: usage?.input_tokens ?? 0,
  read: usage?.cache_read_input_tokens ?? 0,
  write: usage?.cache_creation_input_tokens ?? 0,
  output: usage?.output_tokens ?? 0,
});

// One reply is a whole Claude Code turn of many model calls. Its own usage is
// the last call's, which OpenCode reads as how full the context is; the rest of
// the turn's total goes in magpie_deferred, which Magpie bills with this reply
// and never passes on (yetone/magpie#1053).
function usageOf(usage, lastCallUsage = usage) {
  const total = tokensOf(usage);
  const last = tokensOf(lastCallUsage);
  const own = {}, rest = {};
  for (const key of Object.keys(total)) {
    own[key] = Math.min(last[key], total[key]);
    rest[key] = total[key] - own[key];
  }
  const prompt_tokens = own.input + own.read + own.write;
  return {
    prompt_tokens,
    completion_tokens: own.output,
    total_tokens: prompt_tokens + own.output,
    prompt_tokens_details: { cached_tokens: own.read, cache_write_tokens: own.write },
    ...(Object.values(rest).some(Boolean)
      ? {
          magpie_deferred: {
            prompt_tokens: rest.input + rest.read + rest.write,
            completion_tokens: rest.output,
            cached_tokens: rest.read,
            cache_write_tokens: rest.write,
          },
        }
      : {}),
  };
}

function envelope(request, response, replay = false) {
  const id = `chatcmpl-native-${randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const headers = {
    "x-native-harness": "claude-code",
    "x-native-source": response.source,
    ...(replay ? { "x-native-replayed-result": "true" } : {}),
  };
  const chunk = (delta, finish_reason = null) => ({
    id,
    object: "chat.completion.chunk",
    created,
    model: request.publicModel,
    choices: [{ index: 0, delta, finish_reason }],
  });
  if (request.stream)
    return new Response(
      [
        chunk({ role: "assistant", content: response.text }),
        { ...chunk({}, "stop"), usage: usageOf(response.usage, response.lastCallUsage) },
        "[DONE]",
      ]
        .map((event) => `data: ${typeof event === "string" ? event : JSON.stringify(event)}\n\n`)
        .join(""),
      { headers: { ...headers, "content-type": "text/event-stream" } },
    );
  return Response.json(
    {
      id,
      object: "chat.completion",
      created,
      model: request.publicModel,
      choices: [
        { index: 0, message: { role: "assistant", content: response.text }, finish_reason: "stop" },
      ],
      usage: usageOf(response.usage, response.lastCallUsage),
    },
    { headers },
  );
}

// Claude Code processes whose turn was canceled, or failed, while background
// tasks ran, by state directory and conversation. Each keeps its conversation's
// lease until it exits or the conversation's next turn takes it over.
const parkedProcesses = new Map();
// What such a process wrote for the person before it exited, by the same key.
const unshown = new Map();
const within = async (promise, ms) => {
  const wait = new AbortController();
  await Promise.race([promise, delay(ms, undefined, { signal: wait.signal }).catch(() => {})]);
  wait.abort();
};

export function createAdapter(options) {
  const sessions = new Sessions(options.stateDirectory);
  // Stop and a steer both cancel the turn; only a steer sends the next prompt
  // right away. A canceled turn's process that no turn takes is stopped.
  const graceMs = options.parkGraceMs ?? 60000;
  // How long a turn waits for a parked process that is finishing on its own.
  const drainMs = options.drainWaitMs ?? 300000;
  const keep = (key, entry, grace) => {
    if (grace) {
      entry.grace = setTimeout(() => entry.live.stop(), graceMs);
      entry.grace.unref?.();
    }
    parkedProcesses.set(key, entry);
    entry.live.exited.then(async () => {
      if (parkedProcesses.get(key) !== entry) return;
      parkedProcesses.delete(key);
      clearTimeout(entry.grace);
      if (entry.live.hasUnseen()) unshown.set(key, (unshown.get(key) ?? "") + entry.live.takeUnseen());
      await entry.lease.release();
    });
  };
  return async (_url, init = {}) => {
    let lease, request, plan, saved, cwd, broker, identity, restorer, key, entry, previous;
    const ctl = new AbortController();
    const abort = () => ctl.abort();
    init.signal?.addEventListener("abort", abort, { once: true });
    if (init.signal?.aborted) abort();
    const detach = () => init.signal?.removeEventListener("abort", abort);
    try {
      ctl.signal.throwIfAborted();
      const restored = await (options.secretRequests ?? secretRequests).bind(init.body, options.redactKeyPath);
      restorer = restored.restorer;
      request = readRequest(restored.body);
      broker = await connectBroker(options.brokerDirectory, request.bridge, ctl.signal);
      broker.watch?.(ctl);
      const headers = new Headers(init.headers);
      const directory =
        broker.context?.cwd ??
        (headers.get("x-magpie-work-dir")
          ? decodeURIComponent(headers.get("x-magpie-work-dir"))
          : options.cwd);
      if (!directory || !isAbsolute(directory))
        throw new BridgeError("A native Windows project directory is required.");
      cwd = resolve(directory);
      if (!(await stat(cwd)).isDirectory())
        throw new BridgeError("Project path must be a directory.");
      identity = requestIdentity(headers, broker.context, request);
      // One state per source; model/effort edits resume only with matching history.
      const scope = {
        clientSession: identity.clientSession,
        cwd,
        executable: options.executable,
        source: options.source,
      };
      key = `${options.stateDirectory}
${digest(scope)}`;
      entry = parkedProcesses.get(key);
      if (entry) {
        // This conversation's parked process hands over its lease.
        parkedProcesses.delete(key);
        clearTimeout(entry.grace);
        lease = entry.lease;
        previous = entry.state;
      } else lease = await sessions.acquire(scope, {
        request,
        requestKind: identity.kind,
        waitMs: options.leaseWaitMs,
        signal: ctl.signal,
        ...(identity.auxiliaryIdentityVersion ? { legacyMayBePrimary: true } : {}),
        legacyIdentity: identity.legacySession
          ? { ...scope, clientSession: identity.legacySession }
          : undefined,
      });
      previous ??= lease.previous;
      if (previous?.requestHash === request.requestHash && previous.status !== "refused") {
        if (previous.status !== "complete")
          throw new BridgeError(
            "This native turn already started and did not complete. Send a new user message; automatic replay is blocked.",
            "native_turn_already_started",
          );
        const response = envelope(request, previous.response, true);
        restorer.dispose();
        ctl.abort();
        await lease.release();
        detach();
        return response;
      }
      plan = planTurn(request, previous);
      saved = {
        status: "running",
        requestHash: request.requestHash,
        hashes: request.hashes,
        source: options.source,
        model: request.model,
        effort: request.effort,
        ultracode: request.ultracode,
        conversationId: plan.conversationId ?? null,
        startedAt: new Date().toISOString(),
        requestKind: identity.kind,
        ...(identity.auxiliaryIdentityVersion
          ? { auxiliaryIdentityVersion: identity.auxiliaryIdentityVersion }
          : {}),
      };
      await lease.save(saved);
      if (!identity.auxiliary)
        await broker.historyBegin?.({
          version: 1,
          sessionId: identity.clientSession,
          cwd,
          source: options.source,
          requestHash: request.requestHash,
        });
    } catch (error) {
      restorer?.dispose();
      ctl.abort();
      // A turn that fails before it runs leaves the parked process as it was.
      if (entry) {
        if (saved) await lease.save(entry.state).catch(() => {});
        keep(key, entry, true);
      } else if (lease) await lease.release();
      detach();
      if (error.name === "AbortError") throw error;
      return Response.json(apiError(error), { status: 400 });
    }
    let persistQueue = Promise.resolve();
    const persist = () => {
      const snapshot = structuredClone(saved);
      persistQueue = persistQueue.then(() => lease.save(snapshot));
      return persistQueue;
    };
    const perform = async (onText, onStarted) => {
      let parkedLive, parkedAs;
      try {
        // Launch Claude Code's own picker value (e.g. Fable's [1m]) when known.
        const models = await options.discover?.().catch(() => undefined);
        const turn = {
          ...options,
          cwd,
          ...request,
          ...plan,
          launchModel: models?.get(request.model)?.launch,
          prompt: identity.auxiliary
            ? plan.prompt
            : nativeCatalogPrompt(plan.prompt, broker.context?.nativeCatalog),
          mode: identity.auxiliary ? "plan" : broker.context?.mode,
          auxiliary: identity.auxiliary,
          mcpServers: identity.auxiliary ? {} : broker.context?.mcpServers,
          restorer: options.restoreSecrets === false || identity.auxiliary ? undefined : restorer,
          signal: ctl.signal,
          ...(identity.auxiliary ? {} : { onPark: (live) => (parkedLive = live) }),
        };
        let carriedText = unshown.get(key) ?? "";
        unshown.delete(key);
        // Continue in this conversation's parked process, or stop it when this
        // turn no longer follows it (edited history, other model or mode).
        const live = entry?.live;
        if (live) {
          const follows = plan.conversationId === live.conversationId;
          if (follows && live.draining()) await within(live.exited, drainMs);
          if (follows && (await live.accepts(turn))) turn.live = live;
          else {
            live.stop();
            await live.exited;
            if (follows) carriedText += live.takeUnseen();
          }
        }
        if (carriedText) turn.carriedText = carriedText;
        const response = await (options.runTurn ?? runTurn)(
          turn,
          {
            onText,
            onStarted,
            onConversation(id) {
              saved.conversationId = id;
              persist().catch(() => ctl.abort());
            },
            onPermission: (permission) =>
              identity.auxiliary
                ? { behavior: "deny", message: "Auxiliary requests cannot execute native tools." }
                : broker.permission(permission),
            onEvent: (event) => (identity.auxiliary ? undefined : broker.event(event)),
          },
        );
        saved = { ...saved, status: "complete", conversationId: response.conversationId, response };
        await persist();
        return response;
      } catch (error) {
        // A turn canceled before its prompt reached the parked process leaves
        // the conversation where the parked turn left it.
        if (error.parked)
          parkedAs = error.unsent ? "unsent" : error.name === "AbortError" ? "canceled" : "failed";
        saved = error.unsent && previous
          ? { ...previous }
          : {
              ...saved,
              status: error.parked
                ? "parked"
                : error.name === "AbortError"
                  ? "canceled"
                  : error.safeToFallback
                    ? "refused"
                    : "failed",
              error: { message: error.message, code: error.code },
            };
        await persist().catch(() => {});
        throw error;
      } finally {
        ctl.abort();
        await persistQueue.catch(() => {});
        if (parkedLive && parkedAs) {
          // The parked process keeps the lease, and the secret restorer of the
          // turn it served; an unsent turn's restorer was never handed over.
          if (parkedAs === "unsent") restorer?.dispose();
          keep(key, { live: parkedLive, lease, state: saved }, parkedAs !== "failed");
        } else {
          restorer?.dispose();
          await lease.release();
        }
        detach();
      }
    };
    if (!request.stream) {
      try {
        return envelope(request, await perform());
      } catch (error) {
        if (error.name === "AbortError") throw error;
        // 409 stays terminal even if a late failure's text mentions quota;
        // Magpie may retry a 400 containing those words on another source.
        return Response.json(apiError(error), { status: error.safeToFallback ? error.status : 409 });
      }
    }
    let disconnected = false;
    let committed = false;
    const ready = Promise.withResolvers();
    const encoder = new TextEncoder();
    const id = `chatcmpl-native-${randomUUID()}`,
      created = Math.floor(Date.now() / 1000);
    const body = new ReadableStream({
      start(controller) {
        const send = (value) => {
          if (!disconnected)
            controller.enqueue(
              encoder.encode(
                `data: ${typeof value === "string" ? value : JSON.stringify(value)}\n\n`,
              ),
            );
        };
        const chunk = (delta, finish_reason = null, usage) => ({
          id,
          object: "chat.completion.chunk",
          created,
          model: request.publicModel,
          choices: [{ index: 0, delta, finish_reason }],
          ...(usage ? { usage } : {}),
        });
        // Hold HTTP headers until Claude accepts the turn. An initial upstream
        // refusal can then return its real HTTP status for Magpie's fallback.
        // Once work starts, later errors must remain in the same stream.
        const commit = () => {
          if (committed) return;
          committed = true;
          send(chunk({ role: "assistant" }));
          ready.resolve();
        };
        // Protocol converters may drop SSE comments. A valid empty delta keeps
        // tool-only native turns flowing through Chat Completions gateways.
        const heartbeat = setInterval(() => {
          if (committed) send(chunk({}));
        }, options.heartbeatMs ?? 10000);
        perform((content) => { commit(); send(chunk({ content })); }, commit)
          .then(
            (response) => {
              commit();
              send(chunk({}, "stop", usageOf(response.usage, response.lastCallUsage)));
              send("[DONE]");
              if (!disconnected) controller.close();
            },
            (error) => {
              if (!committed && error.safeToFallback) {
                ready.resolve(Response.json(apiError(error), { status: error.status }));
                controller.close();
                return;
              }
              if (!committed && error.name === "AbortError") {
                ready.reject(error);
                controller.close();
                return;
              }
              if (!committed) {
                ready.resolve(Response.json(apiError(error), { status: 409 }));
                controller.close();
                return;
              }
              commit();
              if (!disconnected) {
                // Empty deltas do not commit Magpie's held stream. Say the
                // actual failure as text, then end with a terminal state error.
                // The error's words must also be nonretryable when Magpie
                // collects a stream for a nonstreaming caller (it discards the
                // collected text on error). Keep the original in saved.error.
                send(chunk({ content: `\n\n${error.message}\n` }));
                send(apiError({
                  code: error.code,
                  message: "Native turn state is invalid for automatic replay after execution starts. Send a new user message to continue.",
                }));
                controller.close();
              }
            },
          )
          .finally(() => clearInterval(heartbeat));
      },
      cancel() {
        disconnected = true;
        ctl.abort();
      },
    });
    const refusal = await ready.promise;
    if (refusal) return refusal;
    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        "x-native-harness": "claude-code",
        "x-native-source": options.source,
      },
    });
  };
}
