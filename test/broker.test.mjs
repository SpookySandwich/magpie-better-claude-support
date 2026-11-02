import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connectBroker } from "../lib/broker.mjs";
import { readRequest } from "../lib/context.mjs";

async function startBrokerFixture(t, handler) {
  const root = fileURLToPath(new URL("../.tmp/", import.meta.url));
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(join(root, "magpie-broker-"));
  const id = randomUUID();
  const token = randomUUID();
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      res.writeHead(401).end();
      return;
    }
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const reply = await handler(body);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(reply));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await writeFile(
    join(directory, `${id}.json`),
    JSON.stringify({
      version: 1,
      url: `http://127.0.0.1:${server.address().port}/native`,
      token,
    }),
  );
  t.after(async () => {
    server.closeAllConnections();
    server.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    markerText: `<magpie_native_bridge v="1" id="${id}" request="${randomUUID()}"/>`,
  };
}

test("ACP broker forwards native permission approval and tool events", async (t) => {
  const events = [];
  const fixture = await startBrokerFixture(t, async (msg) => {
    if (msg.kind === "context") {
      return { sessionId: "session", mode: "plan", mcpServers: {} };
    }
    if (msg.kind === "permission") {
      return { behavior: "allow", updatedInput: msg.payload.input };
    }
    if (msg.kind === "event") {
      events.push(msg.payload);
      return { ok: true };
    }
    return {};
  });
  const request = readRequest(
    JSON.stringify({
      model: "claude-sonnet-5-5",
      messages: [
        { role: "system", content: fixture.markerText },
        { role: "user", content: "test" },
      ],
    }),
  );
  const client = await connectBroker(fixture.directory, request.bridge);
  assert.equal(client.context.sessionId, "session");
  assert.equal(client.context.mode, "plan");
  const permission = await client.permission({
    tool_name: "Write",
    tool_use_id: "file",
    input: { file_path: "file.txt", content: "test" },
  });
  assert.equal(permission.behavior, "allow");
  await client.event({
    type: "assistant",
    message: {
      content: [{ type: "tool_use", id: "file", name: "Write", input: permission.updatedInput }],
    },
  });
  await client.event({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "file", content: "written" }] },
  });
  assert.equal(events.length, 2);
});

test("auxiliary requests have independent sessions and cannot approve tools", async (t) => {
  const fixture = await startBrokerFixture(t, async (msg) => {
    if (msg.kind === "context") {
      return {
        sessionId: "session:aux:1",
        auxiliary: true,
        requestKind: "title",
        mcpServers: {},
      };
    }
    if (msg.kind === "permission") {
      return { behavior: "deny", message: "Auxiliary requests cannot approve tools." };
    }
    return {};
  });
  const request = readRequest(
    JSON.stringify({
      model: "claude-sonnet-5-5",
      messages: [
        { role: "system", content: fixture.markerText },
        { role: "user", content: "Name this conversation" },
      ],
    }),
  );
  const client = await connectBroker(fixture.directory, request.bridge);
  assert.match(client.context.sessionId, /^session:aux:/);
  assert.equal(client.context.auxiliary, true);
  assert.deepEqual(client.context.mcpServers, {});
  assert.equal((await client.permission({ tool_name: "Write", input: {} })).behavior, "deny");
});

test("without a broker marker connectBroker runs in direct mode and denies interactive permissions", async () => {
  const client = await connectBroker("unused", undefined);
  assert.equal(client.context, null);
  await client.event({ type: "assistant" });
  const decision = await client.permission({ tool_name: "Write", input: {} });
  assert.equal(decision.behavior, "deny");
});

test("native watchdog renews an expired lease and observes cancellation on its next lease", async (t) => {
  let watches = 0;
  const fixture = await startBrokerFixture(t, async (body) =>
    body.kind === "context"
      ? { cancellationWatch: true }
      : ++watches === 1
        ? { canceled: false, done: false }
        : { canceled: true, done: true },
  );
  const request = readRequest(
    JSON.stringify({
      model: "claude-sonnet-5-5",
      messages: [
        { role: "system", content: fixture.markerText },
        { role: "user", content: "watch" },
      ],
    }),
  );
  const ctl = new AbortController();
  const client = await connectBroker(fixture.directory, request.bridge, ctl.signal);
  const aborted = once(ctl.signal, "abort");
  client.watch(ctl);
  await aborted;
  assert.equal(watches, 2);
});
