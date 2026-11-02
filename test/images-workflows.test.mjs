import test from "node:test";
import assert from "node:assert/strict";
import { readRequest, planTurn } from "../lib/context.mjs";
import { launchArgs } from "../lib/native.mjs";
import { workflowMeta, workflowLaunch, foldWorkflow } from "../lib/workflows.mjs";

const request = (messages) => readRequest(JSON.stringify({ model: "claude-sonnet-5-5", messages }));
test("images reach native blocks and participate in replay identity", () => {
  const image = { type: "image_url", image_url: { url: "data:image/png;base64,aGVsbG8=" } };
  const input = request([
    { role: "user", content: [{ type: "text", text: "Inspect this" }, image] },
  ]);
  const prompt = planTurn(input).prompt;
  assert.ok(Array.isArray(prompt));
  assert.deepEqual(
    prompt.find((p) => p.type === "image"),
    { type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } },
  );
  assert.notEqual(
    input.requestHash,
    request([{ role: "user", content: "Inspect this" }]).requestHash,
  );
  const next = request([
    { role: "user", content: [{ type: "text", text: "Inspect this" }, image] },
    { role: "assistant", content: "seen" },
    { role: "user", content: "Recall it" },
  ]);
  const resumed = planTurn(next, {
    status: "complete",
    conversationId: "old",
    hashes: input.hashes,
  });
  assert.equal(resumed.conversationId, "old");
  assert.equal(typeof resumed.prompt, "string");
  assert.ok(!resumed.prompt.includes("aGVsbG8="));
});
test("legacy text hashes and session continuation remain compatible", () => {
  const input = request([{ role: "user", content: "hello" }]);
  assert.deepEqual(input.messages, [{ role: "user", text: "hello" }]);
  const next = request([
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
    { role: "user", content: "continue" },
  ]);
  assert.equal(
    planTurn(next, {
      version: 1,
      status: "complete",
      conversationId: "legacy",
      hashes: input.hashes,
    }).conversationId,
    "legacy",
  );
});
test("native permission mode defaults to auto approve and honors supervised and plan", () => {
  const selected = (mode) => {
    const args = launchArgs({
      model: "claude-sonnet-5-5",
      effort: "high",
      mode,
      newConversationId: "test",
    });
    return args[args.indexOf("--permission-mode") + 1];
  };
  assert.equal(selected(), "bypassPermissions");
  assert.equal(selected("yolo"), "bypassPermissions");
  assert.equal(selected("build"), "manual");
  assert.equal(selected("default"), "manual");
  assert.equal(selected("plan"), "plan");
  const auxiliary = launchArgs({
    model: "claude-sonnet-5-5",
    effort: "xhigh",
    ultracode: true,
    auxiliary: true,
  });
  assert.equal(JSON.parse(auxiliary[auxiliary.indexOf("--settings") + 1]).ultracode, false);
  assert.equal(auxiliary[auxiliary.indexOf("--tools") + 1], "");
});
test("phase data is parsed without executing scripts and journal labels stay associated", () => {
  const meta = workflowMeta(
    "export const meta = { name: 'check', phases: [{title: 'Research', model: 'haiku'}, {title: 'Verify', detail: 'check', model:'haiku'}] }; throw new Error('must not execute'); return 0;",
  );
  const run = foldWorkflow(
    meta,
    [
      { type: "started", agentId: "a", label: "first", phase: "Research" },
      { type: "result", agentId: "a", result: "42" },
      { type: "started", agentId: "b", label: "second", phase: "Verify" },
    ],
    {},
    "cancelled",
  );
  assert.deepEqual(
    run.phases.map((p) => p.title),
    ["Research", "Verify"],
  );
  assert.deepEqual(
    run.workflowProgress.map((a) => [a.label, a.phaseTitle, a.state]),
    [
      ["first", "Research", "done"],
      ["second", "Verify", "cancelled"],
    ],
  );
});
test("workflow launch parses run metadata and terminal fold settles open agents", () => {
  const launched = workflowLaunch(
    "Workflow launched in background\nRun ID: wf_check-1\nTask ID: task-1\nScript file: file.js\nTranscript dir: /tmp/wf\nSummary: check",
  );
  assert.equal(launched.runId, "wf_check-1");
  assert.equal(launched.taskId, "task-1");
  assert.equal(launched.scriptPath, "file.js");
  const active = foldWorkflow(
    { phases: [{ title: "Research", model: "haiku" }] },
    [{ type: "started", agentId: "a", label: "worker", phase: "Research" }],
    {},
    "running",
  );
  assert.equal(active.status, "running");
  assert.equal(active.workflowProgress[0].state, "running");
  const stopped = foldWorkflow(
    { phases: [{ title: "Research", model: "haiku" }] },
    [{ type: "started", agentId: "a", label: "worker", phase: "Research" }],
    {},
    "cancelled",
  );
  assert.equal(stopped.status, "cancelled");
  assert.equal(stopped.workflowProgress[0].state, "cancelled");
});

test("live telemetry enriches agent details and retains declared stage descriptions", () => {
  const run = foldWorkflow(
    { phases: [{ title: "Research", detail: "Compute", model: "haiku" }] },
    [{ type: "started", agentId: "a", label: "compute", phase: "Research" }],
    {
      workflowProgress: [
        { type: "workflow_phase", title: "Research", index: 1 },
        {
          type: "workflow_agent",
          agentId: "a",
          state: "progress",
          model: "claude-haiku-5-5",
          tokens: 123,
          phaseTitle: "Research",
          promptPreview: "7 times 8",
        },
      ],
    },
  );
  assert.equal(run.phases[0].detail, "Compute");
  assert.equal(run.workflowProgress[0].state, "running");
  assert.equal(run.workflowProgress[0].model, "claude-haiku-5-5");
  assert.equal(run.workflowProgress[0].tokens, 123);
});
