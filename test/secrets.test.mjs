import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SecretRequests, placeholderFor, alignSecrets, createRestorer, RESTORE_CALLBACK } from "../lib/secrets.mjs";
import { readRequest } from "../lib/context.mjs";
import { createAdapter } from "../lib/adapter.mjs";
import { runTurn } from "../lib/native.mjs";
import { onRequest, onResponse } from "../gateway.hooks.mjs";

const key = Buffer.alloc(32, 19);
const secret = 'synthetic-"\\\n密码-🙂';
const token = placeholderFor(key, "SECRET", secret);
const message = (content) => ({ role: "user", content });
const request = (content) => ({ model: "claude-sonnet-5-5", messages: [message(content)] });
const masked = (body, value = secret, replacement = token) => JSON.stringify(body, (_key, item) =>
  typeof item === "string" ? item.replaceAll(value, replacement) : item);
async function setup(t) {
  const parent = fileURLToPath(new URL("../.tmp/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const cwd = await mkdtemp(join(parent, "secrets-"));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const keyPath = join(cwd, "redact.key");
  await writeFile(keyPath, key);
  return { cwd, keyPath };
}

test("placeholder verification agrees with an independent base32 vector", () => {
  // Independently encoded from the HMAC's first five bytes using BigInt.
  assert.equal(placeholderFor(Buffer.alloc(32, 19), "SECRET", "fixture-value"), "{{SECRET_xhp3zcut}}");
  assert.deepEqual(alignSecrets(`value: ${secret}`, `value: ${token}`, key), new Map([[token, secret]]));
  assert.equal(alignSecrets(`value: wrong`, `value: ${token}`, key), undefined);
  assert.equal(alignSecrets(`value: ${secret}`, `value: ${token}`, Buffer.alloc(32)), undefined);
});

test("alignment handles repeated delimiters, adjacent tokens and literal placeholders", () => {
  const a = "one: two", b = "three";
  const ta = placeholderFor(key, "SECRET", a), tb = placeholderFor(key, "API_KEY", b);
  assert.deepEqual(alignSecrets(`prefix ${a}: ${b}!`, `prefix ${ta}: ${tb}!`, key), new Map([[ta, a], [tb, b]]));
  assert.deepEqual(alignSecrets(a + b, ta + tb, key), new Map([[ta, a], [tb, b]]));
  assert.deepEqual(alignSecrets(`${ta} / ${a}`, `${ta} / ${ta}`, key), new Map([[ta, a]]));
  assert.equal(alignSecrets(`${a} changed`, `${ta} suffix`, key), undefined);
  assert.equal(alignSecrets(a, ta, key, { attempts: 0, bytes: 100 }), undefined);
});

test("nested tool inputs restore exactly once without changing keys or permissions", () => {
  const restorer = createRestorer(new Map([[token, secret]]));
  const input = JSON.parse(JSON.stringify({ nested: [{ text: token }], code: `use('${token}')`,
    [token]: "keep key", "__proto__": null, number: 7, flag: false, empty: null }));
  const output = restorer.hook({ callback_id: RESTORE_CALLBACK,
    input: { hook_event_name: "PreToolUse", tool_input: input } });
  assert.equal(output.hookSpecificOutput.updatedInput.nested[0].text, secret);
  assert.equal(output.hookSpecificOutput.updatedInput[token], "keep key");
  assert.equal(output.hookSpecificOutput.permissionDecision, undefined);
  assert.equal(input.nested[0].text, token);
  assert.equal(restorer.rewrite("{{SECRET_aaaaaaaa}}"), "{{SECRET_aaaaaaaa}}");
  const once = createRestorer(new Map([[token, "{{SECRET_aaaaaaaa}}"], ["{{SECRET_aaaaaaaa}}", "do not recurse"]]));
  assert.equal(once.rewrite(token), "{{SECRET_aaaaaaaa}}");
  assert.deepEqual(restorer.hook({ callback_id: RESTORE_CALLBACK,
    input: { hook_event_name: "PreToolUse", tool_input: { plain: "hello" } } }), {});
  assert.throws(() => restorer.hook({ callback_id: "wrong" }), /Unexpected/);
  const proto = restorer.rewrite(JSON.parse('{"__proto__":{"polluted":true}}'));
  assert.equal(Object.getPrototypeOf(proto), Object.prototype);
  assert.equal({}.polluted, undefined);
  restorer.dispose();
  assert.equal(restorer.rewrite(token), token);
});

test("request captures isolate concurrent conversations and retry only the same transcript", async (t) => {
  const { keyPath } = await setup(t);
  const store = new SecretRequests();
  const a = store.capture(request(`first ${secret}`));
  const b = store.capture(request(`second ${token}`));
  t.after(() => { store.release(a.id); store.release(b.id); });
  const [boundA, boundB] = await Promise.all([store.bind(masked(a.body), keyPath), store.bind(masked(b.body), keyPath)]);
  assert.equal(boundA.restorer.rewrite(token), secret);
  assert.equal(boundB.restorer.rewrite(token), token);
  assert.equal((await store.bind(masked(a.body), keyPath)).restorer.rewrite(token), secret);
  const changed = structuredClone(a.body);
  changed.messages[0].content = `other ${token}`;
  assert.equal((await store.bind(JSON.stringify(changed), keyPath)).restorer.rewrite(token), token);
  store.release(a.id);
  assert.equal((await store.bind(masked(a.body), keyPath)).restorer.rewrite(token), token);
  // An active turn owns its copy until the adapter finishes, even after TTL.
  assert.equal(boundA.restorer.rewrite(token), secret);
  boundA.restorer.dispose();
});

test("markers are stripped before hashes, preserve whitespace and survive merged system content", async (t) => {
  const { keyPath } = await setup(t);
  const store = new SecretRequests();
  const original = { ...request(`task ${secret}`), messages: [
    { role: "system", content: "  system text  " }, message(`task ${secret}`),
  ] };
  const capture = store.capture(original);
  t.after(() => store.release(capture.id));
  const bound = await store.bind(masked(capture.body), keyPath);
  assert.deepEqual(readRequest(bound.body), readRequest(masked(original)));
  assert.doesNotMatch(bound.body, /magpie_native_restore/);
  const mergedStore = new SecretRequests();
  const merged = mergedStore.capture({ ...request("hello"), messages: [
    { role: "system", content: `first ${secret}` }, { role: "system", content: "second" }, message("hello"),
  ] });
  t.after(() => mergedStore.release(merged.id));
  const converted = { ...merged.body, messages: [
    { role: "system", content: merged.body.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") }, message("hello"),
  ] };
  assert.equal((await mergedStore.bind(masked(converted), keyPath)).restorer.rewrite(token), secret);
});

test("unknown handles, missing keys, expired captures and bounds never guess", async (t) => {
  const { keyPath, cwd } = await setup(t);
  const store = new SecretRequests({ ttlMs: 15, maxEntries: 1 });
  const a = store.capture(request(secret));
  const b = store.capture(request(secret));
  assert.equal((await store.bind(masked(a.body), keyPath)).restorer.rewrite(token), token);
  assert.equal((await store.bind(masked(b.body), join(cwd, "missing"))).restorer.rewrite(token), token);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await store.bind(masked(b.body), keyPath)).restorer.rewrite(token), token);
  assert.equal(new SecretRequests({ maxRequestBytes: 1 }).capture(request(secret)), undefined);
  const fresh = new SecretRequests();
  const c = fresh.capture(b.body);
  t.after(() => fresh.release(c.id));
  assert.notEqual(c.id, b.id);
  assert.equal(c.body.messages.filter((m) => /magpie_native_restore/.test(m.content)).length, 1);
});

test("gateway hook captures eligible routes, honors opt-out and releases the request", () => {
  for (const model of ["claude-native/claude-sonnet-5-5", "group/claude-high"]) {
    const context = { protocol: "chat", state: {}, options: {} };
    assert.ok(onRequest({ ...request(secret), model }, context));
    assert.ok(context.state.restoreRequest);
    onResponse({}, context);
  }
  for (const [model, protocol, options] of [["other/model", "chat", {}],
    ["group/test", "anthropic", {}], ["group/test", "chat", { restoreSecrets: false }]]) {
    assert.equal(onRequest({ ...request(secret), model }, { protocol, options, state: {} }), undefined);
  }
});

test("adapter keeps secrets out of prompts/state and disposes the turn mapping", async (t) => {
  const { keyPath, cwd } = await setup(t);
  const store = new SecretRequests();
  const capture = store.capture(request(`task ${secret}`));
  t.after(() => store.release(capture.id));
  let held;
  const adapter = createAdapter({ cwd, stateDirectory: join(cwd, "state"), source: "subscription",
    redactKeyPath: keyPath, secretRequests: store,
    runTurn: async (options) => {
      held = options.restorer;
      assert.equal(held.rewrite(token), secret);
      assert.ok(options.prompt.includes(token));
      assert.ok(!options.prompt.includes(secret));
      assert.ok(!options.prompt.includes("magpie_native_restore"));
      return { text: "done", conversationId: "fixture", source: "subscription" };
    } });
  const response = await adapter("", { body: masked(capture.body) });
  assert.equal(response.status, 200, await response.text());
  assert.equal(held.rewrite(token), token);
  for (const file of await readdir(join(cwd, "state"), { recursive: true })) {
    if (!file.endsWith(".json")) continue;
    const state = await readFile(join(cwd, "state", file), "utf8");
    assert.ok(!state.includes(secret) && !state.includes(JSON.stringify(secret).slice(1, -1)));
    assert.ok(!state.includes("magpie_native_restore"));
  }
});

test("native stdio callback rewrites a tool without granting supervised permission", async (t) => {
  const { cwd } = await setup(t);
  const input = { nested: [{ text: token }], file_path: "synthetic.txt" };
  for (const allowed of [true, false]) {
    const result = await runTurn({
      cwd, executable: process.execPath,
      prefixArgs: [fileURLToPath(new URL("./fixtures/restore-cli.mjs", import.meta.url))],
      source: "subscription", model: "claude-sonnet-5-5", effort: "high", mode: "manual",
      prompt: JSON.stringify(input), restorer: createRestorer(new Map([[token, secret]])), timeoutMs: 5000,
    }, { onPermission: (request) => {
      assert.equal(request.input.nested[0].text, secret);
      return allowed ? { behavior: "allow", updatedInput: request.input } : { behavior: "deny", message: "test denied" };
    } });
    assert.equal(result.text, allowed ? "approved" : "denied");
    if (allowed) {
      assert.equal(await readFile(join(cwd, "synthetic.txt"), "utf8"), secret);
      await rm(join(cwd, "synthetic.txt"));
    } else {
      await assert.rejects(readFile(join(cwd, "synthetic.txt")), { code: "ENOENT" });
    }
  }
});
