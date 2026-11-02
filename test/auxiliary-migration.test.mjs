import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createAdapter } from "../lib/adapter.mjs";
import { requestIdentity } from "../lib/identity.mjs";
import { readRequest } from "../lib/context.mjs";
import {
  auxiliarySession,
  kinds,
  body,
  answer,
  setup,
  seed,
  statePath,
} from "./fixtures/auxiliary.mjs";
const task = (kind = "title", text) => ({
  headers: { "x-claude-native-session": auxiliarySession("ses_child", kind) },
  body: body(text),
});

test("encoded auxiliary upgrades preserve V1 and formerly primary-shaped V2 replay fences", async (t) => {
  for (const version of [1, 2])
    for (const kind of kinds)
      for (const status of ["running", "failed", "canceled", "complete"]) {
        const options = await setup(t, () =>
          assert.fail("Old effects replayed after identity upgrade"),
        );
        const input = task(kind);
        const old = await seed(options, "ses_child", input, version, status);
        const result = await createAdapter(options)("", input);
        if (status === "complete") {
          assert.equal(result.headers.get("x-native-replayed-result"), "true");
          assert.equal((await result.json()).choices[0].message.content, "saved answer");
        } else assert.equal((await result.json()).error.code, "native_turn_already_started");
        assert.equal(await old.unchanged(), true);
        assert.equal((await readdir(options.stateDirectory)).length, 1);
      }
});

test("encoded requests retain V2 explicit-auxiliary state keys for completed and interrupted results", async (t) => {
  for (const kind of kinds)
    for (const status of ["complete", "failed"]) {
      const options = await setup(t, () => assert.fail("Existing auxiliary state bypassed"));
      const input = task(kind);
      const oldIdentity = requestIdentity(
        new Headers({ "x-opencode-session": "ses_child", "x-magpie-request-kind": kind }),
        null,
        readRequest(input.body),
      );
      const old = await seed(options, oldIdentity.clientSession, input, 2, status, kind);
      const result = await createAdapter(options)("", input);
      if (status === "complete")
        assert.equal(result.headers.get("x-native-replayed-result"), "true");
      else assert.equal((await result.json()).error.code, "native_turn_already_started");
      assert.equal(await old.unchanged(), true);
    }
});

test("exact legacy matches retain live leases, while unrelated V2 primary leases do not collide", async (t) => {
  for (const same of [false, true]) {
    let launched = 0;
    const options = await setup(t, async () => {
      launched++;
      return answer();
    });
    const input = task();
    const old = await seed(
      options,
      "ses_child",
      same ? input : task("title", "unrelated primary"),
      2,
      "running",
    );
    const lock = old.path.replace(/\.json$/, ".lock");
    const bytes = JSON.stringify({ pid: process.pid });
    await writeFile(lock, bytes);
    const result = await createAdapter(options)("", input);
    if (same) assert.equal((await result.json()).error.code, "native_session_busy");
    else assert.equal(result.status, 200);
    assert.equal(launched, same ? 0 : 1);
    assert.equal(await old.unchanged(), true);
    assert.equal(await readFile(lock, "utf8"), bytes);
  }
});

test("new auxiliary work forks legacy primary history and writes V3 with protocol provenance", async (t) => {
  let turn;
  const options = await setup(t, async (value) => {
    turn = value;
    return answer();
  });
  const first = task();
  const old = await seed(options, "ses_child", first, 2, "complete");
  const input = task("title", "new auxiliary work");
  assert.equal((await createAdapter(options)("", input)).status, 200);
  assert.equal(turn.conversationId, undefined);
  assert.equal(turn.auxiliary, true);
  assert.equal(await old.unchanged(), true);
  const identity = requestIdentity(new Headers(input.headers), null, readRequest(input.body));
  const saved = JSON.parse(await readFile(statePath(options, identity.clientSession), "utf8"));
  assert.equal(saved.version, 3);
  assert.equal(saved.requestKind, "title");
  assert.equal(saved.auxiliaryIdentityVersion, 1);
});

test("unknown state versions and malformed/future wire identities reject before native execution", async (t) => {
  const options = await setup(t, () => assert.fail("Unrecognized identity launched native tools"));
  const adapter = createAdapter(options);
  for (const wire of [
    "magpie-aux:",
    "magpie-aux:v2:title:ses_child",
    "magpie-aux:v1:primary:ses_child",
    "magpie-aux:v1:future:ses_child",
    "magpie-aux:v1:title:",
    "magpie-aux:v1:title:child:extra",
    `magpie-aux:v1:title:${"x".repeat(65)}`,
    "magpie-aux:v1:title:a.b",
  ]) {
    const result = await adapter("", {
      headers: { "x-claude-native-session": wire },
      body: body(),
    });
    assert.equal((await result.json()).error.code, "native_auxiliary_identity");
  }
  const conflict = task();
  conflict.headers["x-magpie-request-kind"] = "primary";
  assert.equal(
    (await (await adapter("", conflict)).json()).error.code,
    "native_auxiliary_identity",
  );
  assert.deepEqual(await readdir(options.stateDirectory), []);
  const input = task();
  const old = await seed(options, "ses_child", input, 99, "running");
  assert.equal((await (await adapter("", input)).json()).error.code, "native_session_version");
  assert.equal(await old.unchanged(), true);
});
