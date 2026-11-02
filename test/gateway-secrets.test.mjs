import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { stopProcessTree } from "../lib/native.mjs";

test("installed Magpie masks a request, then the native tool receives the original synthetic value", {
  skip: !process.env.MAGPIE_GATEWAY_TEST,
  timeout: 90000,
}, async (t) => {
  const cleanup = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); });
  const parent = fileURLToPath(new URL("../.tmp/", import.meta.url));
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(join(parent, "gateway-secrets-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const config = join(root, "config", "magpie");
  const plugin = join(root, "plugin");
  await mkdir(config, { recursive: true });
  await mkdir(plugin);
  // Synthetic data is generated locally and never sent to a model provider.
  const secret = "synthetic_gateway_value_" + "abcdefghij";
  await writeFile(join(config, "redact.key"), Buffer.alloc(32, 19));
  await writeFile(join(config, "settings.json"), JSON.stringify({
    redact: true, redactWords: [secret], redactModelOff: true,
  }));
  await writeFile(join(plugin, "package.json"), JSON.stringify({
    name: "native-restore-fixture", type: "module", main: "./index.mjs", magpie: { hooks: "./gateway.hooks.mjs" },
  }));
  const moduleURL = (path) => JSON.stringify(new URL(path, import.meta.url).href);
  await writeFile(join(plugin, "gateway.hooks.mjs"), `export { onRequest, onResponse } from ${moduleURL("../gateway.hooks.mjs")};`);
  await writeFile(join(plugin, "index.mjs"), `
    import assert from 'node:assert/strict';
    import { join } from 'node:path';
    import { writeFile } from 'node:fs/promises';
    import { createAdapter } from ${moduleURL("../lib/adapter.mjs")};
    import { runTurn } from ${moduleURL("../lib/native.mjs")};
    export default async ({ directory }) => ({
      config(cfg) { cfg.provider['claude-native'] = { name: 'Fixture', npm: '@ai-sdk/openai-compatible',
        api: 'http://fixture.invalid/v1', models: { 'claude-sonnet-5-5': { name: 'Fixture' } } }; },
      auth: { provider: 'claude-native', methods: [], async loader() {
        return { baseURL: 'http://fixture.invalid/v1', fetch: createAdapter({
          cwd: ${JSON.stringify(root)}, stateDirectory: join(directory, 'fixture-state'),
          source: 'subscription', redactKeyPath: join(directory, 'redact.key'), timeoutMs: 10000,
          executable: ${JSON.stringify(process.execPath)}, prefixArgs: [${JSON.stringify(fileURLToPath(new URL("./fixtures/restore-cli.mjs", import.meta.url)))}],
          runTurn: async (options, callbacks) => {
            const token = options.prompt.match(/\\{\\{[A-Z_]+_[a-z2-7]{8}\\}\\}/)?.[0];
            assert.ok(token, 'gateway must mask the synthetic value');
            assert.ok(!options.prompt.includes(${JSON.stringify(secret)}), 'prompt stays masked');
            assert.ok(!options.prompt.includes('magpie_native_restore'), 'marker is removed');
            await writeFile(join(${JSON.stringify(root)}, 'masked-prompt.txt'), options.prompt);
            return runTurn({ ...options, prompt: JSON.stringify({ nested: [{ text: token }], file_path: 'synthetic.txt' }) },
              { ...callbacks, onPermission: (request) => ({ behavior: 'allow', updatedInput: request.input }) });
          },
        }) };
      } },
    });
  `);
  await writeFile(join(config, "plugins.json"), JSON.stringify({ plugins: [{ spec: plugin }] }));
  await writeFile(join(config, "plugin-auth.json"), JSON.stringify({ "claude-native": { type: "api", key: "fixture-only" } }));
  await writeFile(join(config, "providers.json"), JSON.stringify({ groups: [{
    id: "native-test", name: "Fixture group", routing: "order", affinity: "off", members: ["claude-native/claude-sonnet-5-5"],
  }] }));
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = `127.0.0.1:${probe.address().port}`;
  await new Promise((resolve) => probe.close(resolve));
  const gateway = spawn(process.env.MAGPIE_GATEWAY_TEST, ["serve"], {
    windowsHide: true,
    env: { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
      USERPROFILE: root, APPDATA: join(root, "appdata"), LOCALAPPDATA: join(root, "localappdata"),
      MAGPIE_ADDR: address, MAGPIE_NO_ACCOUNTS: "0", DO_NOT_TRACK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  gateway.stdout.on("data", (chunk) => { log = (log + chunk).slice(-5000); });
  gateway.stderr.on("data", (chunk) => { log = (log + chunk).slice(-5000); });
  cleanup.push(async () => {
    const closed = once(gateway, "close");
    stopProcessTree(gateway);
    if (gateway.exitCode === null) await closed;
  });
  let ready = false;
  for (let i = 0; i < 150; i++) {
    try {
      const response = await fetch(`http://${address}/v1/models`, { signal: AbortSignal.timeout(1000) });
      if (response.ok && (await response.text()).includes("claude-native/claude-sonnet-5-5")) { ready = true; break; }
    } catch {}
    assert.equal(gateway.exitCode, null, log);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, log);
  for (const model of ["claude-native/claude-sonnet-5-5", "group/native-test"]) {
    const response = await fetch(`http://${address}/v1/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", "x-opencode-session": model },
      body: JSON.stringify({ model, messages: [{ role: "user", content: `Use this synthetic value: ${secret}` }] }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    assert.equal(response.status, 200, text + log);
    assert.equal((JSON.parse(text)).choices[0].message.content, "approved", text);
    assert.equal(await readFile(join(root, "synthetic.txt"), "utf8"), secret);
    assert.ok(!(await readFile(join(root, "masked-prompt.txt"), "utf8")).includes(secret));
  }
});
