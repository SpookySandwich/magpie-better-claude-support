import test from "node:test";
import assert from "node:assert/strict";
import { requestIdentity } from "../lib/identity.mjs";
import { decodeAuxiliaryIdentity } from "../lib/auxiliary-identity.mjs";
import { readRequest } from "../lib/context.mjs";
import {
  globalPlugin,
  acpPlugin,
  identityHook,
  auxiliarySession,
  auxiliaryIdentityVersion,
  kinds,
  body,
  event,
} from "./fixtures/auxiliary.mjs";
const direct = { plugin: { list: async () => [] } };

test("staged and enabled global hooks preserve GPT/Gemini/Cursor auxiliaries without inventory calls", async () => {
  for (const version of [auxiliaryIdentityVersion, 1]) {
    const hook = identityHook(
      { plugin: { list: () => assert.fail("Nonnative model queried ACP inventory") } },
      version,
    );
    for (const id of [
      "codex/gpt-6-astra",
      "magpie/codex/gpt-6-astra",
      "codex/gpt-6-astra#xhigh",
      "auto/gpt-6",
      "group/magpie-gpt-ultra",
      "auto/gemini-3-pro",
      "cursor/claude-opus-5-5",
      "anthropic/claude-opus-5-5",
    ]) {
      for (const kind of ["primary", ...kinds, "future-kind"]) {
        const e = event(kind, id);
        await hook(e);
        assert.equal(e.request.headers.get("x-opencode-session"), e.sessionID);
        assert.equal(await e.request.text(), body());
      }
    }
  }
});

test("registered global hook retains magpie provider scope and staged native fail-closed behavior", async () => {
  let hook;
  await globalPlugin.setup({
    ...direct,
    session: {
      hook: async (name, fn, options) => {
        assert.equal(name, "http.request");
        assert.deepEqual(options, { providerID: "magpie" });
        hook = fn;
      },
    },
  });
  assert.equal(auxiliaryIdentityVersion, 1);
  const staged = identityHook(direct, 0);
  for (const id of [
    "auto/claude-opus-5-5",
    "magpie/auto/claude-sonnet-5-5",
    "claude-native-subscription/claude-sonnet-5-5@ultracode",
    "claude-native-monthly/claude-opus-5-5",
    "claude-opus-5-5",
    "group/magpie-sonnet-native",
    "group/magpie-opus-claude-code",
    "group/magpie-opus-ultracode",
  ]) {
    const primary = event("primary", id);
    await hook(primary);
    assert.equal(primary.request.headers.get("x-opencode-session"), "ses_child");
    for (const kind of kinds) await assert.rejects(staged(event(kind, id)), /awaits harness 0.2.2/);
  }
});

test("enabled transport changes only native auxiliary headers and round-trips the mirrored protocol", async () => {
  for (const kind of kinds) {
    const e = event(kind);
    const original = e.request;
    await identityHook(direct, 1)(e);
    assert.equal(e.request, original);
    assert.equal(e.sessionID, "ses_child");
    assert.equal(await e.request.text(), body());
    const encoded = e.request.headers.get("x-opencode-session");
    assert.equal(encoded, `magpie-aux:v1:${kind}:ses_child`);
    assert.deepEqual(decodeAuxiliaryIdentity(encoded), { kind, session: "ses_child" });
  }
  assert.ok(auxiliarySession("s".repeat(64), "compaction").length <= 128);
  for (const session of [undefined, null, 123, "", "x:y", "x/y", "a".repeat(65)])
    assert.throws(() => auxiliarySession(session, "title"));
  await assert.rejects(
    identityHook(direct, 1)(event("future-kind")),
    /Unsupported Magpie request kind/,
  );
  await assert.rejects(
    identityHook({ plugin: { list: async () => ({}) } }, 1)(event("title")),
    /identity owner/,
  );
  await assert.rejects(identityHook(direct, 2)(event("title")), /awaits harness/);
});

test("actual ACP and global callbacks preserve raw identity and ancestry in either hook order", async () => {
  for (const wrapped of [false, true]) {
    const callbacks = [];
    const plugins = [{ id: "magpie-acp-runtime", state: { status: "active" } }];
    const ctx = {
      options: { version: 1 },
      plugin: { list: async () => (wrapped ? { data: plugins } : plugins) },
      session: {
        hook: async (name, fn) => {
          if (name === "http.request") callbacks.push(fn);
        },
        get: async ({ sessionID }) => (sessionID === "ses_child" ? { parentID: "ses_parent" } : {}),
      },
    };
    await acpPlugin.setup(ctx);
    for (const version of [0, 1]) {
      const global = identityHook(ctx, version);
      for (const order of [
        [global, callbacks[0]],
        [callbacks[0], global],
      ]) {
        for (const kind of ["primary", ...kinds]) {
          const e = event(kind);
          for (const hook of order) await hook(e);
          assert.equal(e.request.headers.get("x-opencode-session"), "ses_child");
          assert.equal(e.request.headers.get("x-magpie-request-kind"), kind);
          assert.equal(e.request.headers.get("x-magpie-ancestors"), '["ses_parent"]');
          assert.equal(await e.request.text(), body());
        }
      }
    }
  }
  const failed = {
    plugin: { list: async () => [{ id: "magpie-acp-runtime", state: { status: "failed" } }] },
  };
  const e = event("title");
  await identityHook(failed, 1)(e);
  assert.equal(e.request.headers.get("x-opencode-session"), auxiliarySession("ses_child", "title"));
});

test("broker identity and kind stay authoritative over conflicting caller metadata", () => {
  const request = readRequest(body());
  const headers = new Headers({
    "x-claude-native-session": "magpie-aux:v99:invalid:x",
    "x-magpie-request-kind": "future-kind",
  });
  for (const context of [
    { sessionId: "broker-primary", requestKind: "primary", auxiliary: false },
    { sessionId: "broker-primary" },
  ]) {
    const identity = requestIdentity(headers, context, request);
    assert.equal(identity.clientSession, "broker-primary");
    assert.equal(identity.kind, "primary");
    assert.equal(identity.auxiliary, false);
  }
  headers.set("x-magpie-request-kind", "primary");
  const auxiliary = requestIdentity(
    headers,
    { sessionId: "broker:aux:old", auxiliary: true, requestKind: "compaction" },
    request,
  );
  assert.equal(auxiliary.clientSession, "broker:aux:old");
  assert.equal(auxiliary.kind, "compaction");
  assert.equal(auxiliary.auxiliary, true);
});
