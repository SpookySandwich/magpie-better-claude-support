import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createAdapter } from "../lib/adapter.mjs";
import { digest, readRequest } from "../lib/context.mjs";
import { requestIdentity } from "../lib/identity.mjs";
import { Sessions } from "../lib/sessions.mjs";

async function setup(t, runTurn) {
  const root = new URL("../.tmp/", import.meta.url);
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(join(fileURLToPath(root), "isolation-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const options = {
    cwd: resolve(cwd),
    executable: process.execPath,
    source: "subscription",
    stateDirectory: join(cwd, "state"),
    runTurn,
  };
  await mkdir(options.stateDirectory);
  return options;
}
const input = (session, text = "Do task", extra = {}) => ({
  headers: { "x-opencode-session": session, "x-magpie-session": "parent", ...extra },
  body: JSON.stringify({ model: "claude-sonnet-5-5", messages: [{ role: "user", content: text }] }),
});
const response = (text = "complete") => ({
  text,
  conversationId: "native-conversation",
  source: "subscription",
});
const statePath = (options, clientSession) =>
  join(
    options.stateDirectory,
    `${digest({ clientSession, cwd: options.cwd, executable: options.executable, source: options.source })}.json`,
  );
async function seed(options, clientSession, request, status, extra = {}) {
  const path = statePath(options, clientSession);
  const parsed = readRequest(request.body);
  const bytes = JSON.stringify({
    version: 1,
    status,
    requestHash: parsed.requestHash,
    hashes: parsed.hashes,
    conversationId: "legacy-native",
    ...extra,
  });
  await writeFile(path, bytes);
  return { path, bytes };
}

test("concurrent child sessions ignore a shared parent affinity, including legacy primary headers", async (t) => {
  const entered = Promise.withResolvers(),
    done = Promise.withResolvers();
  let launches = 0;
  const options = await setup(t, async () => {
    if (++launches === 2) entered.resolve();
    await done.promise;
    return response();
  });
  const adapter = createAdapter(options);
  t.after(() => done.resolve());
  const calls = ["child-a", "child-b"].map((id) =>
    adapter("", input(id, "same task", { "x-claude-native-session": "parent" })),
  );
  await Promise.race([
    entered.promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Children collided")), 2000).unref(),
    ),
  ]);
  done.resolve();
  assert.deepEqual(
    (await Promise.all(calls)).map((r) => r.status),
    [200, 200],
  );
  assert.equal(launches, 2);
  assert.equal(
    (await readdir(options.stateDirectory)).filter((n) => n.endsWith(".json")).length,
    2,
  );
});

test("both OpenCode header spellings preserve child identity and same-child exclusion", async (t) => {
  const entered = Promise.withResolvers(),
    done = Promise.withResolvers();
  const options = await setup(t, async () => {
    entered.resolve();
    await done.promise;
    return response();
  });
  const adapter = createAdapter(options);
  t.after(() => done.resolve());
  const first = adapter("", input("child"));
  await entered.promise;
  const retry = input("child");
  delete retry.headers["x-opencode-session"];
  retry.headers["x-opencode-session-id"] = "child";
  assert.equal((await (await adapter("", retry)).json()).error.code, "native_session_busy");
  done.resolve();
  assert.equal((await first).status, 200);
});

test("V1 interrupted history survives an identity upgrade and still fences replay", async (t) => {
  for (const status of ["running", "failed", "canceled"]) {
    const options = await setup(t, () =>
      assert.fail("An interrupted native task must not relaunch"),
    );
    const task = input("child");
    const old = await seed(options, "parent", task, status);
    const result = await createAdapter(options)("", task);
    assert.equal((await result.json()).error.code, "native_turn_already_started");
    assert.equal(await readFile(old.path, "utf8"), old.bytes);
    assert.deepEqual(await readdir(options.stateDirectory), [old.path.split(/[\\/]/).at(-1)]);
  }
});

test("V1 completed history replays without launch; a new turn forks ambiguous legacy ownership", async (t) => {
  let captured;
  const options = await setup(t, async (turn) => {
    captured = turn;
    return response();
  });
  const task = input("child");
  const old = await seed(options, "parent", task, "complete", {
    response: response("legacy answer"),
  });
  const adapter = createAdapter(options);
  const replay = await adapter("", task);
  assert.equal(replay.headers.get("x-native-replayed-result"), "true");
  assert.equal((await replay.json()).choices[0].message.content, "legacy answer");
  assert.equal(captured, undefined);
  const next = {
    ...task,
    body: JSON.stringify({
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "Do task" },
        { role: "assistant", content: "legacy answer" },
        { role: "user", content: "new authorized task" },
      ],
    }),
  };
  assert.equal((await adapter("", next)).status, 200);
  assert.equal(captured.conversationId, undefined);
  assert.match(captured.prompt, /legacy answer/);
  assert.equal(await readFile(old.path, "utf8"), old.bytes);
  assert.equal(JSON.parse(await readFile(statePath(options, "child"), "utf8")).version, 3);
});

test("unrelated V1 parent task and live parent lock cannot collide with a new child", async (t) => {
  const options = await setup(t, async () => response());
  const old = await seed(options, "parent", input("parent", "another task"), "running");
  const lock = old.path.replace(/\.json$/, ".lock");
  const lockBytes = JSON.stringify({ pid: process.pid });
  await writeFile(lock, lockBytes);
  const adapter = createAdapter(options);
  assert.equal((await adapter("", input("child", "new child task"))).status, 200);
  assert.equal(await readFile(lock, "utf8"), lockBytes);
  assert.equal(await readFile(old.path, "utf8"), old.bytes);
});

test("matching V1 task with a live owner remains busy during migration", async (t) => {
  const options = await setup(t, () => assert.fail("Live native task must retain its lock"));
  const task = input("child");
  const old = await seed(options, "parent", task, "running");
  const lock = old.path.replace(/\.json$/, ".lock");
  const bytes = JSON.stringify({ pid: process.pid });
  await writeFile(lock, bytes);
  assert.equal(
    (await (await createAdapter(options)("", task)).json()).error.code,
    "native_session_busy",
  );
  assert.equal(await readFile(lock, "utf8"), bytes);
});

test("explicit auxiliary kinds have independent state and cannot execute tools or Ultra Code", async (t) => {
  const entered = Promise.withResolvers(),
    done = Promise.withResolvers();
  const seen = [];
  const options = await setup(t, async (turn, callbacks) => {
    seen.push(turn);
    if (!turn.auxiliary) {
      entered.resolve();
      await done.promise;
    } else {
      assert.equal(turn.mode, "plan");
      assert.deepEqual(turn.mcpServers, {});
      assert.equal((await callbacks.onPermission({ tool_name: "Write" })).behavior, "deny");
    }
    return response();
  });
  t.after(() => done.resolve());
  const adapter = createAdapter(options);
  const primary = adapter(
    "",
    input("child", "same prompt", {
      "x-magpie-request-kind": "primary",
      "x-magpie-session": "child",
    }),
  );
  await entered.promise;
  for (const kind of ["title", "compaction", "generate"]) {
    assert.equal(
      (
        await adapter(
          "",
          input("child", "same prompt", {
            "x-magpie-request-kind": kind,
            "x-magpie-session": "child",
          }),
        )
      ).status,
      200,
    );
  }
  done.resolve();
  assert.equal((await primary).status, 200);
  assert.equal(seen.length, 4);
  assert.equal(seen[0].auxiliary, false);
});

test("broker-scoped auxiliary identity stays compatible and unknown kinds fail closed", () => {
  const request = readRequest(input("child").body);
  const headers = new Headers({ "x-opencode-session": "parent" });
  assert.equal(
    requestIdentity(headers, { sessionId: "parent:aux:old", auxiliary: true }, request)
      .clientSession,
    "parent:aux:old",
  );
  headers.set("x-magpie-request-kind", "future-kind");
  assert.throws(
    () => requestIdentity(headers, null, request),
    (e) => e.code === "native_request_kind",
  );
});

test("release is idempotent and cannot remove the next owner's lock", async (t) => {
  const options = await setup(t);
  const sessions = new Sessions(options.stateDirectory),
    identity = { clientSession: "child" };
  const old = await sessions.acquire(identity);
  await old.release();
  const next = await sessions.acquire(identity);
  await old.release();
  await assert.rejects(
    old.save({ status: "running", hashes: [] }),
    (e) => e.code === "native_session_lease",
  );
  await assert.rejects(sessions.acquire(identity), (e) => e.code === "native_session_busy");
  await next.release();
});

test("V1 state at the unchanged identity resumes and upgrades in place", async (t) => {
  let captured;
  const options = await setup(t, async (turn) => {
    captured = turn;
    return response();
  });
  const first = input("child");
  const old = await seed(options, "child", first, "complete", {
    response: response("legacy answer"),
  });
  const next = {
    ...first,
    body: JSON.stringify({
      model: "claude-sonnet-5-5",
      messages: [
        { role: "user", content: "Do task" },
        { role: "assistant", content: "legacy answer" },
        { role: "user", content: "Continue" },
      ],
    }),
  };
  assert.equal((await createAdapter(options)("", next)).status, 200);
  assert.equal(captured.conversationId, "legacy-native");
  assert.equal(JSON.parse(await readFile(old.path, "utf8")).version, 3);
});

test("legacy dead-owner lock recovery keeps interrupted state and malformed locks remain fenced", async (t) => {
  const options = await setup(t, () => assert.fail("Interrupted effects must not replay"));
  const task = input("child");
  const old = await seed(options, "child", task, "running");
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(child, "close");
  const lock = old.path.replace(/\.json$/, ".lock");
  await writeFile(lock, JSON.stringify({ pid: child.pid }));
  const adapter = createAdapter(options);
  assert.equal((await (await adapter("", task)).json()).error.code, "native_turn_already_started");
  assert.equal(await readFile(old.path, "utf8"), old.bytes);
  await writeFile(lock, "partial old lock");
  assert.equal((await (await adapter("", task)).json()).error.code, "native_session_lock_invalid");
  assert.equal(await readFile(lock, "utf8"), "partial old lock");
});

test("stream keepalives survive comment-dropping converters without completing or changing text", async (t) => {
  const done = Promise.withResolvers();
  const options = await setup(t, async (_turn, callbacks) => {
    callbacks.onStarted();
    await done.promise;
    callbacks.onText("answer");
    return response("answer");
  });
  t.after(() => done.resolve());
  const task = input("child");
  task.body = JSON.stringify({ ...JSON.parse(task.body), stream: true });
  const stream = await createAdapter({ ...options, heartbeatMs: 10 })("", task);
  const reader = stream.body.getReader(),
    decoder = new TextDecoder();
  const readEvent = async () => {
    const { value } = await reader.read();
    return decoder
      .decode(value)
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)));
  };
  assert.equal((await readEvent())[0].choices[0].delta.role, "assistant");
  const heartbeat = (await readEvent())[0];
  assert.deepEqual(heartbeat.choices[0].delta, {});
  assert.equal(heartbeat.choices[0].finish_reason, null);
  done.resolve();
  let rest = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    rest += decoder.decode(value);
  }
  assert.match(rest, /"content":"answer"/);
  assert.match(rest, /data: \[DONE\]/);
  assert.equal(
    (await readdir(options.stateDirectory)).some((name) => name.endsWith(".lock")),
    false,
  );
});

test("a held lease is awaited for a bounded time, and the wait can be aborted", async (t) => {
  const options = await setup(t);
  const sessions = new Sessions(options.stateDirectory),
    identity = { clientSession: "child" };
  const held = await sessions.acquire(identity);
  let started = Date.now();
  setTimeout(() => held.release(), 300);
  const next = await sessions.acquire(identity, { waitMs: 5000 });
  assert.ok(Date.now() - started >= 250, "waited for the release");
  started = Date.now();
  await assert.rejects(
    sessions.acquire(identity, { waitMs: 400 }),
    (e) => e.code === "native_session_busy",
  );
  assert.ok(Date.now() - started >= 400, "gave up only at the deadline");
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 100);
  await assert.rejects(
    sessions.acquire(identity, { waitMs: 5000, signal: ctl.signal }),
    (e) => e.name === "AbortError",
  );
  await next.release();
});

test("a follow-up sent while a canceled turn shuts down runs instead of failing busy", async (t) => {
  const entered = Promise.withResolvers();
  let launches = 0;
  const options = await setup(t, async ({ signal }) => {
    if (++launches > 1) return response("follow-up");
    entered.resolve();
    await once(signal, "abort");
    // Claude Code exits and its events drain after the kill.
    await delay(300);
    throw new DOMException("Native Claude canceled.", "AbortError");
  });
  const adapter = createAdapter({ ...options, leaseWaitMs: 5000 });
  const stop = new AbortController();
  const first = adapter("", { ...input("child"), signal: stop.signal }).catch((e) => e);
  await entered.promise;
  stop.abort();
  const followUp = await adapter("", input("child", "Follow-up"));
  assert.equal(followUp.status, 200);
  assert.equal((await followUp.json()).choices[0].message.content, "follow-up");
  assert.equal((await first).name, "AbortError");
  assert.equal(launches, 2);
});
