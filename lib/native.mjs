import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeError } from "./context.mjs";
import { Workflows } from "./workflows.mjs";
import { upstreamRefusal } from "./refusal.mjs";
import { restoreHooks } from "./secrets.mjs";

export function stopProcessTree(child) {
  if (!child.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === "win32") {
    const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

// Every inherited ANTHROPIC_* and CLAUDE* variable is stripped. A Magpie started
// from inside a Claude desktop session passes on that session's
// CLAUDE_CODE_ENTRYPOINT, host auth refresh and account ids, and with them
// Claude Code runs on the desktop's claude.ai login even when given an API key.
export function cleanEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(ANTHROPIC_|CLAUDE)/i.test(key)));
}

// The monthly source authenticates Claude Code with its own Console API key,
// which takes precedence over the CLI's claude.ai login. A user-scoped key also
// names the workspace it bills.
export function launchEnvironment(apiKey, environment = process.env, workspace) {
  const env = cleanEnvironment(environment);
  Object.assign(env, {
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_SDK_READS_SESSION_STATE: "1",
  });
  if (apiKey) env.ANTHROPIC_API_KEY = apiKey;
  if (apiKey && workspace) env.ANTHROPIC_CUSTOM_HEADERS = `anthropic-workspace-id: ${workspace}`;
  return env;
}

export function permissionModeOf(options) {
  const selected = options.mode ?? options.defaultPermissionMode ?? "yolo";
  return selected === "plan"
    ? "plan"
    : ["yolo", "never", "bypassPermissions"].includes(selected)
      ? "bypassPermissions"
      : "manual";
}

export function launchArgs(options) {
  const permissionMode = permissionModeOf(options);
  const args = [
    "-p",
    "--input-format",
    "stream-json",
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--model",
    options.launchModel ?? options.model,
    "--effort",
    options.effort,
    "--settings",
    JSON.stringify({
      ultracode: options.ultracode && !options.auxiliary,
      effortLevel: options.effort,
    }),
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    permissionMode,
    "--permission-prompt-tool",
    "stdio",
  ];
  if (permissionMode === "bypassPermissions") args.push("--dangerously-skip-permissions");
  if (options.auxiliary) args.push("--tools", "");
  args.push(
    options.conversationId ? "--resume" : "--session-id",
    options.conversationId ?? options.newConversationId,
  );
  if (options.mcpServers && Object.keys(options.mcpServers).length)
    args.push("--mcp-config", JSON.stringify({ mcpServers: options.mcpServers }));
  return args;
}

const PARKED = Symbol("parked"),
  FAILED = Symbol("failed");
// How long an attaching turn waits for Claude to finish the interrupted turn.
const SETTLE_MS = 15000;
// unsent: canceled before its prompt reached the parked process.
const parkedError = (unsent = false) =>
  Object.assign(new DOMException("Native Claude canceled.", "AbortError"), { parked: true, unsent });

export async function runTurn(options, callbacks = {}) {
  if (options.live) return options.live.turn(options, callbacks);
  options.signal?.throwIfAborted();
  if (options.source === "monthly" && !options.apiKey)
    throw new BridgeError(
      "Sign in to Claude monthly credits with a Console API key.",
      "native_auth_required",
    );
  return launch(options).turn(options, callbacks);
}

// One Claude Code process. A turn canceled while background tasks (workflows,
// background agents or shells) still run interrupts only Claude's own turn and
// parks the process through options.onPark; the next turn of the conversation
// attaches to it instead of killing those tasks.
function launch(options) {
  const conversationId = options.conversationId ?? randomUUID();
  const child = spawn(
    options.executable,
    [...(options.prefixArgs ?? []), ...launchArgs({ ...options, newConversationId: conversationId })],
    {
      cwd: options.cwd,
      env: launchEnvironment(
        options.source === "monthly" ? options.apiKey : undefined,
        options.environment,
        options.workspace,
      ),
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let protocolError, initialized, lastState, lastResult, fallbackTimer, timer, interrupting;
  let restorer = options.restorer;
  let stderr = "",
    canceled = false,
    launched = false,
    turnActive = true,
    pendingPermissions = 0,
    unseen = "",
    capturing = false;
  // The attached turn; none while parked. Parked, only text Claude writes after
  // the interrupted turn ends (its answer to a task that finished) is kept, for
  // the next turn to show first.
  let turn;
  const callbacks = () => turn?.callbacks ?? {};
  const activeTasks = new Set();
  const eventJobs = new Set();
  let eventQueue = Promise.resolve();
  const deliveries = new Set();
  // Stop/timeout must release callback waits as well as the native process.
  // Workflow persistence still drains in order after delivery is detached.
  const deliver = (callback, value) => {
    if (canceled || protocolError) return;
    return new Promise((resolve, reject) => {
      const finish = (response) => {
        deliveries.delete(finish);
        resolve(response);
      };
      deliveries.add(finish);
      Promise.resolve()
        .then(() => {
          if (!canceled && !protocolError) return callback?.(value);
        })
        .then(finish, (error) => {
          deliveries.delete(finish);
          reject(error);
        });
    });
  };
  // This is an idle budget, not a maximum turn duration. Real native events
  // and changed workflow snapshots extend it; polling and gateway keepalives
  // do not, so an active task that stops making progress still expires.
  const activity = () => {
    if (canceled || protocolError || child.exitCode !== null || child.signalCode !== null) return;
    clearTimeout(timer);
    // Waiting for the person is not idle execution. The broker's watch still
    // owns disconnect/Stop, and a response starts a fresh execution budget.
    if (pendingPermissions) return;
    timer = setTimeout(
      () =>
        fail(
          new BridgeError("Native Claude task timed out waiting for activity.", "native_timeout"),
        ),
      options.timeoutMs ?? 1800000,
    );
  };
  const workflows = new Workflows(
    { ...options, newConversationId: conversationId },
    (event, changed) => {
      if (changed) activity();
      return deliver(callbacks().onEvent, event);
    },
  );
  const send = (value) => {
    if (!canceled && !protocolError && !child.stdin.destroyed && !child.stdin.writableEnded) {
      child.stdin.write(JSON.stringify(value) + "\n");
      activity();
    }
  };
  const prompt = (content) => {
    lastResult = undefined;
    turnActive = true;
    send({
      type: "user",
      session_id: conversationId,
      parent_tool_use_id: null,
      message: { role: "user", content },
    });
  };
  const fail = (error) => {
    protocolError ??= error;
    clearTimeout(timer);
    for (const finish of deliveries) finish();
    stopProcessTree(child);
  };
  const finishInput = () => {
    if (lastResult && !turnActive && !activeTasks.size && (lastState === "idle" || !lastState))
      child.stdin.end();
  };
  const started = () => {
    if (!turn || turn.started) return;
    turn.started = true;
    turn.callbacks.onStarted?.();
    // What a parked process wrote for the person comes before this reply.
    if (turn.carried) {
      const target = turn,
        carried = turn.carried;
      target.text = carried + target.text;
      eventQueue = eventQueue
        .then(() => deliver(target.parked ? undefined : target.callbacks.onText, carried))
        .catch(fail);
    }
  };
  const attachable = () =>
    !canceled &&
    !protocolError &&
    child.exitCode === null &&
    child.signalCode === null &&
    !child.stdin.destroyed &&
    !child.stdin.writableEnded;
  const park = () => {
    const parked = turn;
    turn = undefined;
    parked.parked = true;
    capturing = !turnActive;
    if (turnActive) {
      interrupting = Promise.withResolvers();
      send({
        type: "control_request",
        request_id: `native-interrupt-${randomUUID()}`,
        request: { subtype: "interrupt" },
      });
    }
    // Pending permission waits answer "deny" through the parked callbacks.
    for (const finish of deliveries) finish();
    parked.onPark(live);
    parked.parking.resolve(PARKED);
  };
  const abort = () => {
    if (turn?.onPark && activeTasks.size && initialized && attachable()) return park();
    canceled = true;
    clearTimeout(timer);
    for (const finish of deliveries) finish();
    stopProcessTree(child);
  };
  activity();
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-4000);
  });
  child.stdin.on("error", () => {});
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  const emit = (event) => {
    // An event belongs to the turn attached when Claude wrote it.
    const target = turn;
    const job = (eventQueue = eventQueue
      .then(async () => {
        await workflows.event(event);
        await deliver(target && !target.parked ? target.callbacks.onEvent : undefined, event);
      })
      .catch(fail));
    eventJobs.add(job);
    job.finally(() => eventJobs.delete(job));
  };
  const workflowTimer = setInterval(() => {
    eventQueue = eventQueue.then(() => workflows.refreshAll()).catch(fail);
  }, 1000);
  lines.on("line", (line) => {
    if (!line.trim() || canceled || protocolError) return;
    try {
      if (line.length > 16 * 1024 * 1024) throw new Error("Event exceeds 16 MiB.");
      const event = JSON.parse(line);
      activity();
      // A real model message, native tool or background task commits this
      // turn. Initialization and quota diagnostics do not. Commit before
      // delivering permission/tool events, including tools with no text.
      // Background work an attached turn inherited from a parked one does not.
      const inherited =
        turn?.inherited &&
        (event.parent_tool_use_id || (event.type === "system" && turn.inherited.has(event.task_id)));
      if (!inherited && ((event.type === "assistant" && !event.error) ||
          (event.type === "stream_event" &&
            ["message_start", "content_block_start", "content_block_delta"].includes(event.event?.type)) ||
          event.type === "control_request" ||
          (event.type === "user" && event.message?.content?.some?.((part) => part.type === "tool_result")) ||
          (event.type === "system" && ["task_started", "task_progress", "task_notification"].includes(event.subtype))))
        started();
      if (event.type === "assistant" && event.error && turn && !inherited) {
        turn.upstreamError = {
          type: event.error,
          message: (event.message?.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"),
        };
      }
      if (
        event.type === "control_response" &&
        event.response?.request_id === "native-initialize"
      ) {
        if (event.response.subtype !== "success")
          throw new Error(event.response.error ?? "Claude initialization failed.");
        prompt(options.prompt);
      }
      if (event.type === "control_request") {
        const request = event.request;
        const job = (async () => {
          if (request?.subtype === "hook_callback" && restorer) {
            send({
              type: "control_response",
              response: {
                subtype: "success", request_id: event.request_id,
                response: restorer.hook(request),
              },
            });
            return;
          }
          if (request?.subtype !== "can_use_tool")
            throw new BridgeError(`Unsupported Claude control request: ${request?.subtype}`);
          pendingPermissions++;
          clearTimeout(timer);
          let response;
          try {
            response = (await deliver(callbacks().onPermission, request)) ?? {
              behavior: "deny",
              message: "No permission handler connected.",
            };
          } finally {
            pendingPermissions--;
            activity();
          }
          send({
            type: "control_response",
            response: { subtype: "success", request_id: event.request_id, response },
          });
        })().catch((error) => {
          send({
            type: "control_response",
            response: { subtype: "error", request_id: event.request_id, error: error.message },
          });
          fail(error);
        });
        eventJobs.add(job);
        job.finally(() => eventJobs.delete(job));
      }
      if (event.type === "system" && event.subtype === "init") {
        initialized = {
          model: event.model,
          tools: event.tools,
          permissionMode: event.permissionMode,
        };
        // A picker value such as claude-fable-5-1[1m] initializes the same model.
        if (event.model?.replace(/\[[^\]]*\]$/, "") !== options.model)
          throw new Error(`Claude initialized ${event.model}, expected ${options.model}.`);
        if (options.ultracode && !options.auxiliary && !event.tools?.includes("Workflow"))
          throw new Error("Ultra Code was requested but Claude did not enable Workflow.");
        callbacks().onConversation?.(event.session_id ?? conversationId);
      }
      if (event.type === "system" && event.subtype === "session_state_changed") {
        lastState = event.state ?? event.session_state;
        finishInput();
      }
      if (event.type === "system" && event.subtype === "task_started")
        activeTasks.add(event.task_id);
      if (
        event.type === "system" &&
        (event.subtype === "task_notification" ||
          (event.subtype === "task_updated" &&
            ["completed", "failed", "stopped"].includes(event.patch?.status)))
      ) {
        activeTasks.delete(event.task_id);
        finishInput();
      }
      if (event.type === "stream_event" && !event.parent_tool_use_id) {
        if (event.event?.type === "message_start") turnActive = true;
        if (
          event.event?.type === "content_block_delta" &&
          event.event.delta?.type === "text_delta"
        ) {
          const delta = event.event.delta.text;
          const target = turn;
          if (target) {
            target.text += delta;
            target.replied = true;
            // A parked turn's reply stream is closed; its text stays undelivered.
            eventQueue = eventQueue
              .then(() => deliver(target.parked ? undefined : target.callbacks.onText, delta))
              .catch(fail);
          } else if (capturing) unseen += delta;
        }
      }
      if (event.type === "assistant" && !event.parent_tool_use_id) {
        turnActive = true;
        // The turn's last model call tells how full the context is now.
        if (turn && event.message?.usage) turn.lastCallUsage = event.message.usage;
      }
      if (
        (["assistant", "user", "system"].includes(event.type) && !event.error) ||
        (event.type === "stream_event" &&
          event.event?.type === "content_block_delta" &&
          event.event.delta?.type === "thinking_delta")
      )
        emit(event);
      if (event.type === "result") {
        lastResult = event;
        turnActive = false;
        if (turn) {
          turn.result = event;
          if (event.is_error || event.subtype !== "success") {
            // Ending input would end the background tasks with the failed
            // turn: it fails alone and the process parks for the next one.
            if (turn.onPark && activeTasks.size && attachable()) {
              const failed = turn;
              turn = undefined;
              failed.parked = true;
              capturing = true;
              failed.onPark(live);
              failed.parking.resolve(FAILED);
              return;
            }
            child.stdin.end();
            return;
          }
        } else {
          // The interrupted turn's result, or a turn Claude ran by itself for a
          // finished task. Neither ends the process while tasks still run.
          capturing = true;
          interrupting?.resolve();
          interrupting = undefined;
        }
        if (lastState) finishInput();
        else {
          clearTimeout(fallbackTimer);
          fallbackTimer = setTimeout(finishInput, 200);
        }
      }
    } catch (error) {
      fail(new BridgeError(`Claude protocol error: ${error.message}`, "native_protocol_error"));
    }
  });
  const exit = new Promise((resolve, reject) => {
    child.once("error", (error) =>
      reject(
        new BridgeError(`Cannot start Claude Code: ${error.message}`, "native_cli_unavailable"),
      ),
    );
    child.once("close", (code) => resolve(code));
  });
  const done = (async () => {
    try {
      const code = await exit;
      clearInterval(workflowTimer);
      await eventQueue;
      await Promise.all(eventJobs);
      const current = turn;
      if (
        current &&
        !canceled &&
        !protocolError &&
        !current.upstreamError &&
        code === 0 &&
        current.result?.subtype === "success" &&
        !current.result.is_error &&
        initialized &&
        !current.replied &&
        current.result.result
      ) {
        current.text += current.result.result;
        await deliver(current.callbacks.onText, current.result.result);
      }
      const final = current ? current.result : lastResult;
      await workflows.close(
        canceled
          ? "cancelled"
          : protocolError || code !== 0 || final?.is_error || final?.subtype !== "success"
            ? "failed"
            : undefined,
      );
      return code;
    } finally {
      clearInterval(workflowTimer);
      clearTimeout(timer);
      clearTimeout(fallbackTimer);
      lines.close();
      interrupting?.resolve();
      restorer?.dispose();
    }
  })();
  const live = {
    conversationId,
    exited: done.then(
      () => {},
      () => {},
    ),
    // Whether a turn with these options can continue in this process: same
    // conversation and launch selection, and Claude done with the interrupted
    // turn (its result would otherwise end the attached one).
    async accepts(next) {
      // An unknown launch value (failed model probe) still means next.model.
      if (
        next.conversationId !== conversationId ||
        next.model !== options.model ||
        (next.launchModel && options.launchModel && next.launchModel !== options.launchModel) ||
        next.effort !== options.effort ||
        Boolean(next.ultracode) !== Boolean(options.ultracode) ||
        permissionModeOf(next) !== permissionModeOf(options)
      )
        return false;
      if (interrupting) {
        const wait = new AbortController();
        await Promise.race([
          interrupting.promise,
          delay(SETTLE_MS, undefined, { signal: wait.signal }).catch(() => {}),
        ]);
        wait.abort();
      }
      return !interrupting && attachable();
    },
    // Input ended: Claude finishes what it has (e.g. its answer to a finished
    // task) and exits; nothing can attach anymore.
    draining: () =>
      !canceled &&
      !protocolError &&
      child.exitCode === null &&
      child.signalCode === null &&
      child.stdin.writableEnded,
    hasUnseen: () => unseen.length > 0,
    takeUnseen() {
      const value = unseen;
      unseen = "";
      return value;
    },
    stop() {
      if (turn) return;
      canceled = true;
      clearTimeout(timer);
      stopProcessTree(child);
    },
    async turn(turnOptions, turnCallbacks = {}) {
      const signal = turnOptions.signal;
      if (launched && signal?.aborted) {
        turnOptions.onPark?.(live);
        throw parkedError(true);
      }
      const first = !launched;
      launched = true;
      const current = (turn = {
        callbacks: turnCallbacks,
        onPark: turnOptions.onPark,
        text: "",
        started: false,
        parked: false,
        parking: Promise.withResolvers(),
        // Shown once the turn starts: the adapter's, then the parked text.
        carried: (turnOptions.carriedText ?? "") + (first ? "" : live.takeUnseen()),
        inherited: first ? undefined : new Set(activeTasks),
      });
      // The process owns the restorer of the turn it serves, parked or not.
      if (turnOptions.restorer && turnOptions.restorer !== restorer) {
        restorer?.dispose();
        restorer = turnOptions.restorer;
      }
      capturing = false;
      signal?.addEventListener("abort", abort, { once: true });
      try {
        if (signal?.aborted) abort();
        if (first)
          send({
            type: "control_request",
            request_id: "native-initialize",
            request: {
              subtype: "initialize",
              ...(options.restorer ? { hooks: restoreHooks } : {}),
            },
          });
        else prompt(turnOptions.prompt);
        const code = await Promise.race([done, current.parking.promise]);
        if (code === PARKED) throw parkedError();
        if (canceled) throw new DOMException("Native Claude canceled.", "AbortError");
        if (protocolError) throw protocolError;
        const result = current.result;
        if (code !== 0 || result?.is_error || result?.subtype !== "success" || current.upstreamError) {
          const message = result?.errors?.join("; ") || current.upstreamError?.message || result?.result || stderr.trim() || `exit ${code}`;
          // Parked work stays with this source, so a parked failure is final.
          if (code === FAILED)
            throw Object.assign(new BridgeError(`Claude task failed: ${message}`, "native_task_failed"), { parked: true });
          const refusal = !current.started && upstreamRefusal(message, current.upstreamError?.type);
          throw Object.assign(new BridgeError(`Claude task failed: ${message}`, "native_task_failed"),
            refusal ? { ...refusal, safeToFallback: true } : {});
        }
        if (!initialized) throw new BridgeError("Claude did not initialize.", "native_protocol_error");
        if (!current.text.trim()) throw new BridgeError("Claude returned no answer.", "native_empty_answer");
        return {
          text: current.text,
          conversationId: result.session_id ?? conversationId,
          usage: result.usage,
          lastCallUsage: current.lastCallUsage,
          initialized,
          models: Object.keys(result.modelUsage ?? {}),
          source: options.source,
          effort: options.effort,
          ultracode: options.ultracode,
        };
      } finally {
        signal?.removeEventListener("abort", abort);
        // Text the person never saw waits for the next turn of a parked process.
        if (current.parked && !current.started && current.carried) unseen = current.carried + unseen;
        if (!current.parked && child.exitCode === null) stopProcessTree(child);
      }
    },
  };
  return live;
}
