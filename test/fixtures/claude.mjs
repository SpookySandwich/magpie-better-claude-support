import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const settings = args.includes("--settings") ? JSON.parse(value("--settings")) : {};
const session = value(args.includes("--resume") ? "--resume" : "--session-id");
const send = (event) => process.stdout.write(JSON.stringify(event) + "\n");
// `claude -p /usage --output-format json`: the text comes from USAGE_FIXTURE.
// An inherited CLAUDE* variable is told as an error, as it would change the reading.
if (value("-p") === "/usage") {
  if (process.env.USAGE_HANG === "1") {
    setInterval(() => {}, 1000);
  } else {
    const leaked = Object.keys(process.env).filter((key) => /^(ANTHROPIC_|CLAUDE)/i.test(key));
    send({
      type: "result",
      subtype: "success",
      is_error: leaked.length > 0,
      result: leaked.length ? `leaked ${leaked.join(" ")}` : (process.env.USAGE_FIXTURE ?? ""),
    });
    process.exit(0);
  }
} else {
// Mirrors the shape of Claude Code 2.1.303's initialize model picker.
const efforts = ["low", "medium", "high", "xhigh", "max"];
const models = [
  ["default", "claude-opus-5-5", "Default (recommended)", "Opus 5.5 · Best for everyday, complex tasks"],
  ["opus", "claude-opus-5-5", "Opus", "Opus 5.5 · Best for everyday, complex tasks"],
  ["claude-fable-5-1[1m]", "claude-fable-5-1", "Fable", "Fable 5.1 · Most capable"],
  ["sonnet", "claude-sonnet-5-5", "Sonnet", "Sonnet 5.5 · Efficient for routine tasks"],
  ["haiku", "claude-haiku-5-5", "Haiku", "Haiku 5.5 · Fastest for quick answers"],
].map(([value, resolvedModel, displayName, description]) => ({
  value,
  resolvedModel,
  displayName,
  description,
  supportsEffort: true,
  supportedEffortLevels: efforts,
}));
let prompt;
// CASE_PARK: a background task outlives a foreground turn that only an
// interrupt ends; later prompts in the same process answer "attached".
let parking, foreground = false;
function text(value) {
  send({ type: "stream_event", event: { type: "message_start" } });
  send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: value } } });
}
function finish() {
  const text = parking
    ? `attached ${parking}`
    : prompt.includes("CASE_AUTH")
    ? `auth ${process.env.ANTHROPIC_API_KEY ?? "login"} ${process.env.ANTHROPIC_BASE_URL ? "proxied" : "direct"}`
    : `fixture ${settings.ultracode ? "ultracode" : value("--effort")} ${args.includes("--resume") ? "resumed" : "new"}`;
  send({
    type: "stream_event",
    event: { type: "content_block_delta", delta: { type: "text_delta", text } },
  });
  send({
    type: "result",
    subtype: "success",
    session_id: session,
    result: text,
    usage: { input_tokens: 10, output_tokens: 4 },
  });
  send({ type: "system", subtype: "session_state_changed", state: "idle" });
}
createInterface({ input: process.stdin }).on("line", (line) => {
  const event = JSON.parse(line);
  if (event.type === "control_request")
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: event.request_id,
        response: event.request?.subtype === "initialize" ? { models } : {},
      },
    });
  // Claude Code 2.1.303 ends an interrupted turn this way; tasks keep running.
  // Text already in flight can still precede the result.
  if (event.type === "control_request" && event.request?.subtype === "interrupt" && foreground) {
    foreground = false;
    setTimeout(() => {
      text(" (interrupted tail)");
      send({ type: "result", subtype: "error_during_execution", is_error: true, errors: ["interrupted"] });
      send({ type: "system", subtype: "session_state_changed", state: "idle" });
    }, 50);
  }
  if (event.type === "user" && parking && !event.message.content.includes("CASE_PARK")) {
    prompt = event.message.content;
    // The harness must wait for the interrupted turn's result before it sends.
    if (foreground || prompt.includes("FAIL_ATTACHED")) {
      send({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: [foreground ? "prompt sent before the interrupted turn ended" : "attached failure"],
      });
      send({ type: "system", subtype: "session_state_changed", state: "idle" });
      return;
    }
    finish();
    return;
  }
  if (event.type === "user") {
    prompt = event.message.content;
    send({
      type: "system",
      subtype: "init",
      session_id: session,
      model: value("--model"),
      tools: settings.ultracode ? ["Read", "Write", "Workflow"] : ["Read", "Write"],
      permissionMode: "manual",
    });
    if (prompt.includes("CASE_REFUSAL")) {
      const kind = prompt.match(/CASE_REFUSAL_(\w+)/)?.[1] ?? "QUOTA";
      const [error, text] = {
        QUOTA: ["rate_limit", "You've hit your limit · resets 3pm (America/New_York)"],
        QUOTA_SUCCESS: ["rate_limit", "You've hit your limit · resets 3pm (America/New_York)"],
        OVERLOAD: ["server_error", 'API Error: 529 {"error":{"type":"overloaded_error","message":"Overloaded"}}'],
        AUTH: ["authentication_failed", "API Error: 401 OAuth token has expired"],
        CREDIT: ["billing_error", "Your credit balance is too low to access the Anthropic API."],
        INVALID: ["invalid_request", "API Error: 400 invalid_request_error: malformed request"],
        CONTEXT: ["invalid_request", "API Error: 400 prompt is too long"],
        LATE: ["rate_limit", "You've hit your limit"],
        TOOL: ["rate_limit", "You've hit your limit"],
        DELAY: ["rate_limit", "You've hit your limit"],
      }[kind];
      if (kind === "LATE")
        send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Started work." } } });
      if (kind === "TOOL") {
        send({ type: "assistant", message: { content: [{ type: "tool_use", id: "write-refusal", name: "Write", input: {} }] } });
        writeFileSync("effect.txt", "one native effect");
      }
      const refuse = () => {
        send({ type: "assistant", error, message: { content: [{ type: "text", text }] } });
        send(kind === "QUOTA_SUCCESS"
          ? { type: "result", subtype: "success", result: text }
          : { type: "result", subtype: "error_during_execution", is_error: true, errors: [text] });
      };
      if (kind === "DELAY") setTimeout(refuse, 100);
      else refuse();
      return;
    }
    if (prompt.includes("CASE_CALLS")) {
      // Two model calls and a subagent's; the result sums the whole turn.
      const call = (usage, parent_tool_use_id) =>
        send({ type: "assistant", parent_tool_use_id, message: { content: [], usage } });
      call({ input_tokens: 3, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200, output_tokens: 50 });
      call({ input_tokens: 9, cache_read_input_tokens: 5000, output_tokens: 1 }, "task-one");
      call({ input_tokens: 2, cache_read_input_tokens: 1200, cache_creation_input_tokens: 80, output_tokens: 30 });
      send({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "calls" } } });
      send({
        type: "result",
        subtype: "success",
        session_id: session,
        result: "calls",
        usage: { input_tokens: 14, cache_read_input_tokens: 7200, cache_creation_input_tokens: 280, output_tokens: 81 },
      });
      send({ type: "system", subtype: "session_state_changed", state: "idle" });
      return;
    }
    if (prompt.includes("CASE_WAIT")) {
      setInterval(() => {}, 1000);
      return;
    }
    if (prompt.includes("CASE_PARK")) {
      parking = process.pid;
      foreground = true;
      send({ type: "system", subtype: "task_started", task_id: "background-park" });
      text("parking");
      setTimeout(() => {
        writeFileSync("background.txt", "finished");
        send({ type: "system", subtype: "task_updated", task_id: "background-park", patch: { status: "completed" } });
        send({ type: "system", subtype: "task_notification", task_id: "background-park", status: "completed" });
        // Claude answers a finished task with a turn of its own.
        text("background finished. ");
        send({ type: "result", subtype: "success", session_id: session, result: "background finished. " });
        send({ type: "system", subtype: "session_state_changed", state: "idle" });
      }, Number(process.env.PARK_FIXTURE_MS ?? 1500));
      return;
    }
    if (prompt.includes("CASE_BACKGROUND")) {
      send({ type: "system", subtype: "session_state_changed", state: "idle" });
      send({ type: "system", subtype: "task_started", task_id: "background-one" });
      send({ type: "result", subtype: "success", session_id: session, result: "working" });
      setTimeout(() => {
        send({
          type: "system",
          subtype: "task_updated",
          task_id: "background-one",
          patch: { status: "completed" },
        });
        send({ type: "assistant", message: { content: [] } });
        finish();
      }, 350);
      return;
    }
    if (prompt.includes("CASE_FAIL")) {
      writeFileSync("effect.txt", "one native effect");
      send({
        type: "result",
        subtype: "error_during_execution",
        is_error: true,
        errors: ["fixture failed"],
      });
      return;
    }
    if (prompt.includes("CASE_PERMISSION")) {
      send({
        type: "control_request",
        request_id: "permission",
        request: {
          subtype: "can_use_tool",
          tool_name: "Write",
          input: { file_path: "approved.txt", content: "approved" },
          tool_use_id: "write-one",
        },
      });
      return;
    }
    finish();
  }
  if (event.type === "control_response" && event.response.request_id === "permission") {
    if (event.response.response.behavior === "allow") writeFileSync("approved.txt", "approved");
    finish();
  }
});
}
