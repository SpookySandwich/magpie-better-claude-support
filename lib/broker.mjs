import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { BridgeError } from "./context.mjs";

// The broker is authenticated loopback HTTP. node:http has no implicit fetch
// idle deadline: permission waits live until the owning turn is canceled.
// Context/events must respond promptly; watch leases renew every 20 seconds.
const budgets = { "history.begin": 30000, context: 30000, event: 30000, watch: 45000 };

async function callBroker(entry, marker, kind, payload, signal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let timedOut = false;
  const timer =
    budgets[kind] &&
    setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, budgets[kind]);
  try {
    return await new Promise((resolve, reject) => {
      const req = request(
        entry.url,
        {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${entry.token}` },
          signal: controller.signal,
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("error", reject);
          res.on("end", () => {
            if (res.statusCode !== 200) {
              reject(
                new BridgeError(
                  `Native ACP bridge ${kind} disconnected (HTTP ${res.statusCode}).`,
                  "native_client_disconnected",
                ),
              );
              return;
            }
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
              reject(
                new BridgeError(
                  `Native ACP bridge ${kind} returned invalid JSON.`,
                  "native_bridge_protocol_error",
                ),
              );
            }
          });
        },
      );
      req.on("error", reject);
      req.end(JSON.stringify({ version: 1, request: marker.request, kind, payload }));
    });
  } catch (error) {
    if (signal?.aborted)
      throw new DOMException("Native ACP bridge request canceled.", "AbortError");
    if (timedOut)
      throw new BridgeError(`Native ACP bridge ${kind} timed out.`, "native_bridge_timeout");
    if (error instanceof BridgeError) throw error;
    // Do not include the authenticated URL, headers, or upstream response body.
    throw new BridgeError(
      `Native ACP bridge ${kind} connection failed.`,
      "native_client_disconnected",
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export async function connectBroker(directory, marker, signal) {
  if (!marker)
    return {
      context: null,
      event: async () => {},
      permission: async () => ({
        behavior: "deny",
        message: "Open this task through the Magpie ACP bridge to answer permission prompts.",
      }),
    };
  const entry = JSON.parse(await readFile(join(directory, `${marker.id}.json`), "utf8"));
  const url = new URL(entry.url);
  if (
    entry.version !== 1 ||
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !entry.token
  )
    throw new BridgeError("Unsupported native bridge endpoint.");
  const call = (kind, payload) => callBroker(entry, marker, kind, payload, signal);
  const context = await call("context", {});
  return {
    context,
    watch(controller) {
      if (!context.cancellationWatch) return;
      (async () => {
        while (!controller.signal.aborted) {
          const result = await call("watch", {});
          if (result.canceled) controller.abort();
          if (result.done || result.canceled) break;
        }
      })().catch(() => controller.abort());
    },
    historyBegin:
      context.nativeHistoryVersion === 1 ? (payload) => call("history.begin", payload) : undefined,
    event: (payload) => call("event", payload),
    permission: (payload) => call("permission", payload),
  };
}
