import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createAdapter } from "../lib/adapter.mjs";
import { stopProcessTree } from "../lib/native.mjs";

// Opt in with MAGPIE_GATEWAY_TEST=<magpie executable>. Uses an isolated config,
// fake credentials and local CLI fixtures; never contacts a model provider.
test("installed Magpie falls back on initial refusals, but never replays native tool effects", {
  skip: !process.env.MAGPIE_GATEWAY_TEST,
  timeout: 90000,
}, async (t) => {
  // node:test runs after-hooks in registration order; unwind in reverse so the
  // gateway has exited and released its files before the folder is removed.
  const cleanup = [];
  t.after(async () => { for (const step of cleanup.reverse()) await step(); });
  const root = await mkdtemp(join(fileURLToPath(new URL("../.tmp/", import.meta.url)), "gateway-"));
  cleanup.push(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));
  const adapter = createAdapter({
    executable: process.execPath,
    prefixArgs: [fileURLToPath(new URL("./fixtures/claude.mjs", import.meta.url))],
    cwd: root,
    stateDirectory: join(root, "state"),
    source: "subscription",
    timeoutMs: 10000,
    heartbeatMs: 5,
  });
  const cases = [
    ["TOOL", true, false], ["LATE", true, false], ["QUOTA", true, true],
    ["TOOL", false, false], ["QUOTA", false, true], ["INVALID", true, false],
    ["OVERLOAD", true, true], ["AUTH", true, true],
    ["QUOTA_SUCCESS", true, true],
  ];
  let calls = [];
  const upstream = createServer(async (req, res) => {
    if (req.url.endsWith("/models")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "claude-sonnet-5-5" }] }));
      return;
    }
    let body = "";
    for await (const chunk of req) body += chunk;
    const subscription = req.url.startsWith("/subscription/");
    calls.push(subscription ? "subscription" : "api");
    if (!subscription) {
      res.setHeader("content-type", "text/event-stream");
      res.end('data: {"id":"fallback","model":"claude-sonnet-5-5","choices":[{"index":0,"delta":{"role":"assistant","content":"API fallback answered"},"finish_reason":null}]}\n\ndata: {"id":"fallback","model":"claude-sonnet-5-5","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
      return;
    }
    const response = await adapter("", { body, headers: req.headers });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    for await (const chunk of response.body) res.write(chunk);
    res.end();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  cleanup.push(() => { upstream.closeAllConnections(); upstream.close(); });
  const base = `http://127.0.0.1:${upstream.address().port}`;
  const probe = createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const address = `127.0.0.1:${probe.address().port}`;
  await new Promise((resolve) => probe.close(resolve));
  const config = join(root, "config", "magpie");
  await mkdir(config, { recursive: true });
  await writeFile(join(config, "providers.json"), JSON.stringify({
    providers: cases.flatMap((_, i) => ["subscription", "api"].map((id) => ({ id: `fixture-${id}-${i}`, name: id,
      key: "fixture-only", chat: `${base}/${id}/v1`, models: ["claude-sonnet-5-5"], maxConcurrency: 0 }))),
    groups: cases.map((_, i) => ({ id: `fixture-${i}`, name: `fixture-${i}`, routing: "order", affinity: "off",
      members: [`fixture-subscription-${i}/claude-sonnet-5-5`, `fixture-api-${i}/claude-sonnet-5-5`] })),
  }));
  await writeFile(join(config, "plugins.json"), '{"plugins":[]}');
  const gateway = spawn(process.env.MAGPIE_GATEWAY_TEST, ["serve"], {
    windowsHide: true,
    env: { ...process.env, XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
      MAGPIE_ADDR: address, MAGPIE_NO_ACCOUNTS: "1", DO_NOT_TRACK: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  gateway.stdout.on("data", (b) => { log = (log + b).slice(-4000); });
  gateway.stderr.on("data", (b) => { log = (log + b).slice(-4000); });
  cleanup.push(async () => { const closed = once(gateway, "close"); stopProcessTree(gateway); if (gateway.exitCode === null) await closed; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`http://${address}/v1/models`)).ok) break; } catch {}
    assert.equal(gateway.exitCode, null, log);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  // Independent providers prevent one case's quota rest affecting another.
  for (const [i, [kind, stream, fallback]] of cases.entries()) {
    calls = [];
    const response = await fetch(`http://${address}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-opencode-session": `fixture-${i}` },
      body: JSON.stringify({ model: `group/fixture-${i}`, stream, reasoning_effort: "high", messages: [{ role: "user", content: `CASE_REFUSAL_${kind}` }] }),
      signal: AbortSignal.timeout(20000),
    });
    const text = await response.text();
    assert.deepEqual(calls, fallback ? ["subscription", "api"] : ["subscription"], `${kind}: ${response.status} ${text} ${log}`);
    assert.equal(text.includes("API fallback answered"), fallback);
  }
});
