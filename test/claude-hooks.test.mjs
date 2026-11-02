import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { launchEnvironment, stopProcessTree } from "../lib/native.mjs";
import { restoreHooks } from "../lib/secrets.mjs";

// Only initializes the CLI protocol; sends no user turn or model request.
test("installed Claude CLI accepts the native PreToolUse callback registration", {
  skip: !process.env.CLAUDE_HOOK_TEST, timeout: 30000,
}, async (t) => {
  const child = spawn(process.env.CLAUDE_HOOK_TEST, ["-p", "--input-format", "stream-json",
    "--output-format", "stream-json", "--verbose", "--setting-sources", "",
    "--strict-mcp-config", "--tools", "", "--no-session-persistence"], {
    env: launchEnvironment(), windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const lines = createInterface({ input: child.stdout });
  t.after(async () => {
    lines.close();
    const closed = once(child, "close");
    stopProcessTree(child);
    if (child.exitCode === null) await closed;
  });
  child.stderr.resume();
  const response = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", () => reject(new Error("CLI closed before initialization.")));
    lines.on("line", (line) => {
      const event = JSON.parse(line);
      if (event.type === "control_response" && event.response?.request_id === "restore-probe") resolve(event.response);
    });
  });
  child.stdin.write(JSON.stringify({ type: "control_request", request_id: "restore-probe",
    request: { subtype: "initialize", hooks: restoreHooks } }) + "\n");
  assert.equal((await response).subtype, "success");
});
