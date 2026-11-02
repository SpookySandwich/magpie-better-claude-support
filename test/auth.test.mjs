import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import {
  combinedAuth,
  fallbackKey,
  savedFallbackKey,
  subscriptionMethods,
  subscriptionStatus,
} from "../lib/auth.mjs";
import { ClaudePlugin } from "../index.mjs";

const fixture = fileURLToPath(new URL("./fixtures/auth.mjs", import.meta.url));
function options(scenario, extra = {}) {
  return {
    executable: process.execPath,
    prefixArgs: [fixture],
    environment: {
      ...process.env,
      ANTHROPIC_API_KEY: "must-not-inherit",
      CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
      AUTH_SCENARIO: scenario,
      ...extra,
    },
  };
}

test("auth checks the actual subscription, not executable presence or an API login", async () => {
  assert.equal((await subscriptionStatus(options("existing"))).email, "fixture@example.com");
  assert.equal(await subscriptionStatus(options("missing")), undefined);
  assert.equal(await subscriptionStatus(options("api")), undefined);
  await assert.rejects(subscriptionStatus(options("malformed")), /unreadable/);
  await assert.rejects(
    subscriptionStatus({ executable: "missing-fixture-executable" }),
    /Cannot start/,
  );
});

test("existing subscription is verified and reused with optional API fallback", async () => {
  let cleared = 0;
  const [subscription] = subscriptionMethods({
    ...options("existing"),
    previousKey: async () => "saved-key",
    onLogin: () => {
      cleared++;
    },
  });
  const login = await subscription.authorize();
  assert.equal(login.url, "");
  assert.match(login.instructions, /fixture@example.com/);
  assert.deepEqual(await login.callback(), {
    ...combinedAuth({ email: "fixture@example.com" }, "saved-key"),
    type: "success",
  });
  assert.equal(cleared, 1);
  assert.deepEqual(await (await subscription.authorize({ apiKey: "   " })).callback(), {
    ...combinedAuth({ email: "fixture@example.com" }, "saved-key"),
    type: "success",
  });
  assert.deepEqual(await (await subscription.authorize({ apiKey: " fixture-key " })).callback(), {
    ...combinedAuth({ email: "fixture@example.com" }, "fixture-key"),
    type: "success",
  });
});

test("re-login reads saved fallback key from plugin-auth.json when input is empty", async (t) => {
  const root = await mkdtemp(fileURLToPath(new URL("../.tmp/auth-saved-", import.meta.url)));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(
    join(root, "plugin-auth.json"),
    JSON.stringify({
      "claude-native#2iop9a": combinedAuth({ email: "fixture@example.com" }, "persisted-key"),
    }),
  );
  assert.equal(await savedFallbackKey(root, "claude-native#2iop9a"), "persisted-key");
  assert.equal(await savedFallbackKey(root), "persisted-key");
});

test("one account and one combined sign-in method are advertised", async () => {
  const plugin = await ClaudePlugin({ directory: ".tmp" });
  assert.equal(plugin.auth.single, true);
  assert.equal(plugin.auth.methods.length, 1);
  assert.equal(plugin.auth.methods[0].type, "oauth");
});

test("combined credentials retain fallback and read pre-upgrade records", () => {
  assert.equal(fallbackKey(combinedAuth({ email: "fixture@example.com" }, "key")), "key");
  assert.equal(fallbackKey(combinedAuth({ email: "fixture@example.com" })), undefined);
  assert.equal(fallbackKey({ type: "api", key: "legacy-key" }), "legacy-key");
  assert.equal(fallbackKey({ type: "oauth", refresh: "local-cli" }), undefined);
  assert.throws(
    () => fallbackKey({ claudeNative: { version: 2, apiKey: "future" } }),
    /Unsupported/,
  );
});

test("missing subscription starts native browser login and verifies the result", async (t) => {
  const root = await mkdtemp(fileURLToPath(new URL("../.tmp/auth-", import.meta.url)));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [method] = subscriptionMethods(options("login", { AUTH_MARKER: join(root, "signed-in") }));
  const login = await method.authorize();
  assert.equal(login.url, "https://claude.com/cai/oauth/authorize?client_id=fixture&state=fixture");
  assert.equal(login.opened, true);
  assert.equal((await login.callback()).type, "success");
});

test("failed or stalled browser login is not marked signed in", async () => {
  const [failed] = subscriptionMethods(options("failed"));
  assert.equal((await (await failed.authorize()).callback()).type, "failed");
  const [stalled] = subscriptionMethods({ ...options("no-link"), linkTimeoutMs: 200 });
  await assert.rejects(stalled.authorize(), /could not start browser sign-in/);
});
