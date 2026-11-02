import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createAdapter } from "../lib/adapter.mjs";
import { runTurn, launchEnvironment } from "../lib/native.mjs";
import { resolveModel, readRequest, digest } from "../lib/context.mjs";
import { discoverModels, modelCatalog } from "../lib/models.mjs";
import { Sessions } from "../lib/sessions.mjs";

const fixture = fileURLToPath(new URL("./fixtures/claude.mjs", import.meta.url));
async function setup(t) {
  const root = fileURLToPath(new URL("../.tmp/", import.meta.url));
  await mkdir(root, { recursive: true });
  const cwd = await mkdtemp(join(root, "test-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return {
    executable: process.execPath,
    prefixArgs: [fixture],
    cwd,
    stateDirectory: join(cwd, "state"),
    source: "subscription",
    model: "claude-sonnet-5-5",
    effort: "high",
    ultracode: false,
    timeoutMs: 15000,
  };
}
const message = (content) => ({ role: "user", content });
const request = (messages, effort = "high", model = "claude-sonnet-5-5") => ({
  headers: { "x-magpie-session": "fixture" },
  body: JSON.stringify({ model, reasoning_effort: effort, messages }),
});

test("effort selection is exact and workflow mode is explicit", () => {
  for (const effort of ["low", "medium", "high", "xhigh", "max"])
    assert.deepEqual(resolveModel("claude-opus-5-5", effort), {
      model: "claude-opus-5-5",
      effort,
      ultracode: false,
    });
  assert.deepEqual(resolveModel("claude-opus-5-5@ultracode", "xhigh"), {
    model: "claude-opus-5-5",
    effort: "xhigh",
    ultracode: true,
  });
  assert.throws(() => resolveModel("claude-opus-5-5@ultracode", "max"));
  assert.throws(() => resolveModel("claude-opus-5-5", "ultracode"));
});
test("inherited API auth is stripped and monthly uses only its own key", () => {
  const inherited = {
    PATH: "keep",
    ANTHROPIC_BASE_URL: "bad",
    ANTHROPIC_API_KEY: "inherited",
    ANTHROPIC_AUTH_TOKEN: "bad",
    CLAUDE_CODE_OAUTH_TOKEN: "bad",
    CLAUDECODE: "1",
    // what a Magpie started from a Claude desktop session passes on
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    CLAUDE_CODE_SDK_HAS_HOST_AUTH_REFRESH: "1",
    CLAUDE_CODE_ACCOUNT_UUID: "bad",
    claude_agent_socket: "bad",
  };
  const leaked = Object.keys(inherited).filter((key) => key !== "PATH");
  const subscription = launchEnvironment(undefined, inherited);
  assert.equal(subscription.PATH, "keep");
  for (const key of leaked) assert.equal(subscription[key], undefined, key);
  const monthly = launchEnvironment("own-key", inherited);
  assert.equal(monthly.ANTHROPIC_API_KEY, "own-key");
  for (const key of leaked.filter((key) => key !== "ANTHROPIC_API_KEY")) assert.equal(monthly[key], undefined, key);
  assert.equal(monthly.ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.equal(
    launchEnvironment("own-key", inherited, "wrkspc_fixture").ANTHROPIC_CUSTOM_HEADERS,
    "anthropic-workspace-id: wrkspc_fixture",
  );
  assert.equal(launchEnvironment(undefined, inherited, "wrkspc_fixture").ANTHROPIC_CUSTOM_HEADERS, undefined);
  assert.equal(resolveModel("claude-haiku-5-5", "low").model, "claude-haiku-5-5");
  for (const id of ["auto/claude-opus-5-5", "claude-native-monthly/claude-opus-5-5", "group/foo"])
    assert.throws(() => resolveModel(id));
});
test("models are discovered from Claude Code's picker", async () => {
  const models = await discoverModels({ executable: process.execPath, prefixArgs: [fixture] });
  assert.deepEqual(
    [...models.values()].map(({ id, launch, name }) => [id, launch, name]),
    [
      ["claude-opus-5-5", "claude-opus-5-5", "Claude Opus 5.5"],
      ["claude-fable-5-1", "claude-fable-5-1[1m]", "Claude Fable 5.1"],
      ["claude-sonnet-5-5", "claude-sonnet-5-5", "Claude Sonnet 5.5"],
      ["claude-haiku-5-5", "claude-haiku-5-5", "Claude Haiku 5.5"],
    ],
  );
  const catalog = modelCatalog(models);
  assert.equal(Object.keys(catalog).length, 8);
  assert.deepEqual(Object.keys(catalog["claude-haiku-5-5"].variants), [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  assert.deepEqual(Object.keys(catalog["claude-fable-5-1@ultracode"].variants), ["xhigh"]);
  assert.equal(catalog["claude-fable-5-1@ultracode"].name, "Claude Fable 5.1 Ultra Code");
});
test("picker values launch the requested model", async (t) => {
  const options = await setup(t);
  const result = await runTurn({
    ...options,
    model: "claude-fable-5-1",
    launchModel: "claude-fable-5-1[1m]",
    prompt: "hello",
  });
  assert.equal(result.initialized.model, "claude-fable-5-1[1m]");
  await assert.rejects(
    runTurn({ ...options, model: "claude-fable-5-1", launchModel: "claude-opus-5-5", prompt: "hi" }),
    /expected claude-fable-5-1/,
  );
});
test("monthly runs Claude Code directly on its API key", async (t) => {
  const options = await setup(t);
  await assert.rejects(
    runTurn({ ...options, source: "monthly", prompt: "CASE_AUTH" }),
    (error) => error.code === "native_auth_required",
  );
  const monthly = await runTurn({
    ...options,
    source: "monthly",
    apiKey: "fixture-key",
    prompt: "CASE_AUTH",
  });
  assert.equal(monthly.text, "auth fixture-key direct");
  const subscription = await runTurn({ ...options, apiKey: "ignored", prompt: "CASE_AUTH" });
  assert.equal(subscription.text, "auth login direct");
});
test("native CLI tools receive permission decisions", async (t) => {
  const options = await setup(t);
  const result = await runTurn(
    { ...options, prompt: "CASE_PERMISSION", ultracode: true, effort: "xhigh" },
    { onPermission: async (permission) => ({ behavior: "allow", updatedInput: permission.input }) },
  );
  assert.ok(result.initialized.tools.includes("Workflow"));
  assert.equal(await readFile(join(options.cwd, "approved.txt"), "utf8"), "approved");
});
test("workflow continuation outlives an intermediate result", async (t) => {
  const options = await setup(t);
  const result = await runTurn({
    ...options,
    prompt: "CASE_BACKGROUND",
    ultracode: true,
    effort: "xhigh",
  });
  assert.match(result.text, /ultracode/);
});
test("successful tasks replay results and resume after a mode change", async (t) => {
  const options = await setup(t);
  const adapter = createAdapter(options);
  const first = await adapter("", request([message("hello")]));
  const text = (await first.json()).choices[0].message.content;
  assert.match(text, /high new/);
  const replay = await adapter("", request([message("hello")]));
  assert.equal(replay.headers.get("x-native-replayed-result"), "true");
  const second = await adapter(
    "",
    request(
      [message("hello"), { role: "assistant", content: text }, message("continue")],
      "xhigh",
      "claude-sonnet-5-5@ultracode",
    ),
  );
  assert.match((await second.json()).choices[0].message.content, /ultracode resumed/);
});

test("a reply's usage is its last call's and Magpie bills the rest of the turn", async (t) => {
  const options = await setup(t);
  const adapter = createAdapter(options);
  const own = {
    prompt_tokens: 1282,
    completion_tokens: 30,
    total_tokens: 1312,
    prompt_tokens_details: { cached_tokens: 1200, cache_write_tokens: 80 },
  };
  const magpie_deferred = { prompt_tokens: 6212, completion_tokens: 51, cached_tokens: 6000, cache_write_tokens: 200 };
  const whole = await adapter("", request([message("CASE_CALLS")]));
  assert.deepEqual((await whole.json()).usage, { ...own, magpie_deferred });
  const streamed = await adapter("", {
    ...request([message("CASE_CALLS again")]),
    body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true, messages: [message("CASE_CALLS again")] }),
  });
  const usage = (await streamed.text())
    .split("\n\n")
    .map((line) => line.replace(/^data: /, ""))
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line).usage)
    .find(Boolean);
  assert.deepEqual(usage, { ...own, magpie_deferred });
  // A turn without per-call usage tells its total, as before.
  const plain = await adapter("", request([message("hello")]));
  assert.deepEqual((await plain.json()).usage, {
    prompt_tokens: 10,
    completion_tokens: 4,
    total_tokens: 14,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
  });
});
test("failure after an effect cannot automatically replay", async (t) => {
  const options = await setup(t);
  const adapter = createAdapter(options);
  const input = request([message("CASE_FAIL")]);
  assert.equal((await adapter("", input)).status, 409);
  assert.equal(await readFile(join(options.cwd, "effect.txt"), "utf8"), "one native effect");
  assert.equal((await (await adapter("", input)).json()).error.code, "native_turn_already_started");
});
test("cancellation terminates the native process and fences replay", async (t) => {
  const options = await setup(t);
  const adapter = createAdapter(options);
  const ctl = new AbortController();
  const input = request([message("CASE_WAIT")]);
  const timer = setTimeout(() => ctl.abort(), 500);
  await assert.rejects(adapter("", { ...input, signal: ctl.signal }), { name: "AbortError" });
  clearTimeout(timer);
  assert.equal((await (await adapter("", input)).json()).error.code, "native_turn_already_started");
});

const streamed = (messages) => ({
  headers: { "x-magpie-session": "fixture" },
  body: JSON.stringify({ model: "claude-sonnet-5-5", reasoning_effort: "high", stream: true, messages }),
});
const answer = async (response) => (await response.json()).choices[0].message.content;
// Cancel CASE_PARK once its background task has started, as a steer does.
async function park(adapter) {
  const stop = new AbortController();
  const first = await adapter("", { ...streamed([message("CASE_PARK")]), signal: stop.signal });
  assert.equal(first.status, 200);
  stop.abort();
  await first.text();
}
const afterPark = (text = "follow up") =>
  request([message("CASE_PARK"), { role: "assistant", content: "parking" }, message(text)]);

test("a turn canceled while background tasks run parks Claude Code and the next turn attaches", async (t) => {
  const options = await setup(t);
  const adapter = createAdapter({ ...options, leaseWaitMs: 5000 });
  await park(adapter);
  assert.match(await answer(await adapter("", afterPark())), /^attached \d+background finished\. $/);
  assert.equal(await readFile(join(options.cwd, "background.txt"), "utf8"), "finished");
});
test("a parked process that finished alone is resumed and its report comes first", async (t) => {
  const options = await setup(t);
  const adapter = createAdapter({
    ...options,
    leaseWaitMs: 5000,
    environment: { ...process.env, PARK_FIXTURE_MS: "300" },
  });
  await park(adapter);
  await delay(1500);
  assert.equal(await answer(await adapter("", afterPark())), "background finished. fixture high resumed");
});
const locks = async (options) =>
  (await readdir(options.stateDirectory)).filter((name) => name.endsWith(".lock"));
test("a parked process keeps its lease, and Stop with no next turn stops it", async (t) => {
  const options = await setup(t);
  const adapter = createAdapter({ ...options, leaseWaitMs: 5000, parkGraceMs: 300 });
  await park(adapter);
  assert.equal((await locks(options)).length, 1);
  await delay(2500);
  assert.deepEqual(await locks(options), []);
  await assert.rejects(readFile(join(options.cwd, "background.txt")), { code: "ENOENT" });
});
test("an attached turn that fails while tasks run parks again for the next turn", async (t) => {
  const options = await setup(t);
  const adapter = createAdapter({ ...options, leaseWaitMs: 5000 });
  await park(adapter);
  const failed = await adapter("", afterPark("FAIL_ATTACHED"));
  assert.equal(failed.status, 409);
  assert.match((await failed.json()).error.message, /attached failure/);
  const next = request([
    message("CASE_PARK"),
    { role: "assistant", content: "parking" },
    message("FAIL_ATTACHED"),
    message("follow up"),
  ]);
  assert.match(await answer(await adapter("", next)), /^attached \d+background finished\. $/);
  assert.equal(await readFile(join(options.cwd, "background.txt"), "utf8"), "finished");
});
test("a turn that does not follow the parked one stops its process", async (t) => {
  const options = await setup(t);
  const adapter = createAdapter({ ...options, leaseWaitMs: 5000 });
  await park(adapter);
  assert.equal(await answer(await adapter("", request([message("something else")]))), "fixture high new");
  await delay(2000);
  await assert.rejects(readFile(join(options.cwd, "background.txt")), { code: "ENOENT" });
});

test("initial subscription refusals preserve HTTP status before streaming and allow a later retry", async (t) => {
  const options = await setup(t);
  const adapter = createAdapter({ ...options, heartbeatMs: 5 });
  for (const [kind, status] of [["QUOTA", 429], ["QUOTA_SUCCESS", 429], ["DELAY", 429], ["OVERLOAD", 529], ["AUTH", 401], ["CREDIT", 402]]) {
    for (const stream of [false, true]) {
      const input = request([message(`CASE_REFUSAL_${kind}`)]);
      input.headers["x-opencode-session"] = `${kind}-${stream}`;
      input.body = JSON.stringify({ ...JSON.parse(input.body), stream });
      for (let attempt = 0; attempt < 2; attempt++) {
        const response = await adapter("", input);
        assert.equal(response.status, status, `${kind}, stream=${stream}, attempt=${attempt}`);
        assert.match(response.headers.get("content-type"), /application\/json/);
        assert.match((await response.json()).error.code, /^native_upstream_/);
      }
    }
  }
});

test("invalid requests and context overflow are not classified as source refusals", async (t) => {
  const options = await setup(t);
  for (const kind of ["INVALID", "CONTEXT"]) {
    await assert.rejects(runTurn({ ...options, prompt: `CASE_REFUSAL_${kind}` }), (error) => {
      assert.equal(error.safeToFallback, undefined);
      assert.equal(error.code, "native_task_failed");
      return true;
    });
  }
});

test("quota failures after text or native tools stay terminal and fence replay", async (t) => {
  const options = await setup(t);
  const adapter = createAdapter(options);
  for (const kind of ["LATE", "TOOL"]) {
    for (const stream of [false, true]) {
      const input = request([message(`CASE_REFUSAL_${kind}`)]);
      input.headers["x-opencode-session"] = `${kind}-${stream}`;
      input.body = JSON.stringify({ ...JSON.parse(input.body), stream });
      const response = await adapter("", input);
      assert.equal(response.status, stream ? 200 : 409);
      if (stream) {
        const text = await response.text();
        assert.match(text, /"role":"assistant"/);
        assert.match(text, /"code":"native_task_failed"/);
        assert.doesNotMatch(text, /native_upstream_/);
      } else assert.equal((await response.json()).error.code, "native_task_failed");
      assert.equal((await (await adapter("", input)).json()).error.code, "native_turn_already_started");
    }
  }
  assert.equal(await readFile(join(options.cwd, "effect.txt"), "utf8"), "one native effect");
});

test("canceling before acceptance aborts a pending streaming request and releases its lease", async (t) => {
  const options = await setup(t);
  const ctl = new AbortController();
  const input = request([message("CASE_WAIT")]);
  input.body = JSON.stringify({ ...JSON.parse(input.body), stream: true });
  const timer = setTimeout(() => ctl.abort(), 500);
  t.after(() => clearTimeout(timer));
  await assert.rejects(createAdapter(options)("", { ...input, signal: ctl.signal }), { name: "AbortError" });
  assert.equal((await readdir(options.stateDirectory)).some((name) => name.endsWith(".lock")), false);
});
test("broker metadata is removed before prompts and request hashes", () => {
  const base = JSON.parse(request([message("hello")]).body);
  const requestA = readRequest(JSON.stringify(base));
  const requestB = readRequest(
    JSON.stringify({
      ...base,
      messages: [
        {
          role: "system",
          content:
            '\n<magpie_native_bridge v="1" id="12345678-1234-1234-1234-123456789abc" request="12345678-1234-1234-1234-123456789def"/>',
        },
        ...base.messages,
      ],
    }),
  );
  assert.equal(requestA.requestHash, requestB.requestHash);
  assert.ok(requestB.bridge);
});
test("unknown future session data is preserved", async (t) => {
  const options = await setup(t),
    sessions = new Sessions(options.stateDirectory),
    identity = { test: true };
  const lease = await sessions.acquire(identity);
  await lease.save({ status: "complete", hashes: [] });
  await lease.release();
  const path = join(options.stateDirectory, `${digest(identity)}.json`);
  const bytes = JSON.stringify({ version: 99, hashes: [] });
  await writeFile(path, bytes);
  await assert.rejects(
    sessions.acquire(identity),
    (error) => error.code === "native_session_version",
  );
  assert.equal(await readFile(path, "utf8"), bytes);
  assert.ok(!(await readdir(options.stateDirectory)).some((name) => name.endsWith(".lock")));
});
