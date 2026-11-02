import assert from "node:assert/strict";
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
let callback, input;
createInterface({ input: process.stdin }).on("line", (line) => {
  const event = JSON.parse(line);
  if (event.type === "control_request") {
    const hooks = event.request.hooks.PreToolUse;
    assert.equal(hooks.length, 1);
    callback = hooks[0].hookCallbackIds[0];
    send({ type: "control_response", response: { subtype: "success", request_id: event.request_id, response: {} } });
  }
  if (event.type === "user") {
    input = JSON.parse(event.message.content);
    send({ type: "system", subtype: "init", model: value("--model"), tools: ["Write"], session_id: "fixture" });
    send({ type: "control_request", request_id: "restore", request: {
      subtype: "hook_callback", callback_id: callback, input: {
        hook_event_name: "PreToolUse", tool_name: "Write", tool_input: input, tool_use_id: "write-one",
      }, tool_use_id: "write-one",
    } });
  }
  if (event.type === "control_response" && event.response.request_id === "restore") {
    const output = event.response.response.hookSpecificOutput;
    assert.equal(output.hookEventName, "PreToolUse");
    assert.equal(output.permissionDecision, undefined);
    input = output.updatedInput;
    send({ type: "control_request", request_id: "permission", request: {
      subtype: "can_use_tool", tool_name: "Write", input, tool_use_id: "write-one",
    } });
  }
  if (event.type === "control_response" && event.response.request_id === "permission") {
    const allowed = event.response.response.behavior === "allow";
    if (allowed) writeFileSync(input.file_path, input.nested[0].text);
    send({ type: "result", subtype: "success", session_id: "fixture", result: allowed ? "approved" : "denied" });
    send({ type: "system", subtype: "session_state_changed", state: "idle" });
  }
});
