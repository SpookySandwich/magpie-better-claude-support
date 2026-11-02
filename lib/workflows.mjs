import { readFile, mkdir, symlink } from "node:fs/promises";
import { join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { parse } from "acorn";
import {
  cleanProjectionTemp,
  projectionIOError,
  projectionState,
  replaceProjection,
} from "./workflow-projection.mjs";

function literal(node) {
  if (node?.type === "Literal") return node.value;
  if (node?.type === "ArrayExpression") return node.elements.map(literal);
  if (node?.type === "ObjectExpression")
    return Object.fromEntries(
      node.properties
        .filter((p) => p.type === "Property" && !p.computed && p.kind === "init")
        .map((p) => [p.key.name ?? p.key.value, literal(p.value)]),
    );
  return undefined;
}

// Parse data only. Workflow scripts are never evaluated by the bridge.
export function workflowMeta(script) {
  try {
    const ast = parse(script, {
      ecmaVersion: "latest",
      sourceType: "module",
      allowReturnOutsideFunction: true,
    });
    const declaration = ast.body[0]?.declaration?.declarations?.find((d) => d.id.name === "meta");
    const meta = literal(declaration?.init) ?? {};
    return {
      ...meta,
      phases: (Array.isArray(meta.phases) ? meta.phases : []).filter(
        (p) => p && typeof p.title === "string",
      ),
    };
  } catch {
    return { phases: [] };
  }
}

export function workflowLaunch(content) {
  const text =
    typeof content === "string" ? content : (content ?? []).map((p) => p.text ?? "").join("\n");
  const field = (name) => new RegExp(`(?:^|\\n)${name}:\\s*([^\\r\\n]+)`).exec(text)?.[1]?.trim();
  const runId = field("Run ID"),
    transcriptDir = field("Transcript dir");
  if (!runId || !/^wf_[a-zA-Z0-9-]+$/.test(runId) || !transcriptDir) return;
  return {
    runId,
    transcriptDir,
    taskId: /Task ID:\s*(\S+)/.exec(text)?.[1],
    scriptPath: field("Script file"),
    summary: field("Summary"),
    text,
  };
}

async function json(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" || error instanceof SyntaxError) return;
    throw error;
  }
}

export function foldWorkflow(meta, journal, native = {}, status) {
  const phases = new Map((meta.phases ?? []).map((p) => [p.title, p]));
  for (const phase of native.phases ?? [])
    if (phase?.title) phases.set(phase.title, { ...phases.get(phase.title), ...phase });
  const agents = new Map();
  for (const event of native.workflowProgress ?? []) {
    if (event.type === "workflow_phase" && event.title)
      phases.set(event.title, { ...phases.get(event.title), ...event });
    if (event.type === "workflow_agent" && event.agentId)
      agents.set(event.agentId, { ...agents.get(event.agentId), ...event });
  }
  for (const event of journal) {
    if (!event.agentId) continue;
    const previous = agents.get(event.agentId) ?? {};
    const agent = {
      type: "workflow_agent",
      agentId: event.agentId,
      label: event.label ?? previous.label ?? event.agentId,
      ...previous,
      ...(event.phase ? { phaseTitle: event.phase } : {}),
    };
    if (event.type === "started") agent.state ??= "running";
    if (event.type === "result") {
      agent.state = "done";
      agent.resultPreview =
        typeof event.result === "string" ? event.result : JSON.stringify(event.result);
    }
    if (["error", "failed"].includes(event.type)) agent.state = "failed";
    if (agent.phaseTitle && !phases.has(agent.phaseTitle))
      phases.set(agent.phaseTitle, { title: agent.phaseTitle });
    agents.set(event.agentId, agent);
  }
  for (const agent of agents.values())
    if (["start", "progress"].includes(agent.state)) agent.state = "running";
  const finalStatus = status ?? native.status ?? "running";
  if (["cancelled", "failed"].includes(finalStatus))
    for (const agent of agents.values())
      if (!["done", "failed", "cancelled"].includes(agent.state)) agent.state = finalStatus;
  return {
    ...native,
    _magpieSnapshotVersion: 1,
    workflowName: meta.name ?? native.workflowName,
    summary: meta.description ?? native.summary,
    status: finalStatus,
    phases: [...phases.values()],
    agentCount: agents.size,
    workflowProgress: [...agents.values()],
  };
}

export class Workflows {
  constructor(options, emit) {
    this.root =
      options.workflowDirectory ??
      join(
        homedir(),
        ".config",
        "magpie",
        "claude-native-workflows",
        "v1",
        options.source,
        options.newConversationId,
      );
    this.projects = options.projectsDirectory ?? join(homedir(), ".claude", "projects");
    this.cwd = options.cwd;
    this.emit = emit;
    this.calls = new Map();
    this.runs = new Map();
  }
  async event(event) {
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use" && block.name === "Workflow") {
        let script = block.input.script;
        if (!script && block.input.scriptPath)
          script = await readFile(resolve(this.cwd, block.input.scriptPath), "utf8").catch(
            () => "",
          );
        this.calls.set(block.id, { meta: workflowMeta(script ?? ""), input: block.input });
      }
      if (block.type !== "tool_result" || block.is_error || !this.calls.has(block.tool_use_id))
        continue;
      const launch = workflowLaunch(block.content);
      if (!launch) continue;
      const source = resolve(launch.transcriptDir),
        within = relative(resolve(this.projects), source);
      if (
        !within ||
        within.startsWith("..") ||
        isAbsolute(within) ||
        !source.replaceAll("\\", "/").endsWith(`/subagents/workflows/${launch.runId}`)
      ) {
        if (!this.invalidProjectionReported) {
          this.invalidProjectionReported = true;
          console.warn("Workflow projection rejected an invalid source location.");
        }
        continue;
      }
      const shadow = join(this.root, "subagents", "workflows", launch.runId);
      const run = {
        ...launch,
        ...this.calls.get(block.tool_use_id),
        toolUseId: block.tool_use_id,
        source,
        shadow,
      };
      this.runs.set(launch.runId, run);
      // Preserve raw native paths. A saved magpie_workflow event alone points
      // at the external projection, so failed storage cannot invent durability.
      await this.refresh(run);
    }
    if (
      event.type === "system" &&
      ["task_progress", "task_updated", "task_notification"].includes(event.subtype)
    ) {
      const run = [...this.runs.values()].find((r) => r.taskId === event.task_id);
      const status = event.patch?.status ?? event.status;
      if (run && event.workflow_progress) {
        run.progress = event.workflow_progress;
        run.usage = event.usage;
      }
      if (run && ["completed", "failed", "stopped"].includes(status)) {
        run.status = status === "stopped" ? "cancelled" : status;
      }
      if (run) await this.refresh(run);
    }
  }
  async refresh(run) {
    let projection;
    try {
      projection = await this.save(run);
      projectionState(run, false);
    } catch (error) {
      if (!projectionIOError(error)) throw error;
      projectionState(run, true);
      return false;
    }
    if (projection) await this.emit(projection.event, projection.changed);
    return true;
  }
  async save(run) {
    await cleanProjectionTemp(run);
    await mkdir(join(this.root, "subagents", "workflows"), { recursive: true });
    await mkdir(join(this.root, "workflows"), { recursive: true });
    try {
      await symlink(run.source, run.shadow, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const nativePath = join(run.source, "..", "..", "..", "workflows", `${run.runId}.json`);
    const native = await json(nativePath);
    const text = await readFile(join(run.source, "journal.jsonl"), "utf8").catch((error) => {
      if (error.code === "ENOENT") return "";
      throw error;
    });
    const journal = text.split(/\r?\n/).flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
    const snapshot = foldWorkflow(
      run.meta,
      journal,
      {
        ...native,
        ...(run.progress ? { workflowProgress: run.progress } : {}),
        ...(run.usage
          ? {
              totalTokens: run.usage.total_tokens,
              totalToolCalls: run.usage.tool_uses,
              durationMs: run.usage.duration_ms,
            }
          : {}),
      },
      run.status,
    );
    Object.assign(snapshot, { runId: run.runId, taskId: run.taskId, scriptPath: run.scriptPath });
    for (const agent of snapshot.workflowProgress) {
      const metadata = await json(join(run.source, `agent-${agent.agentId}.meta.json`));
      if (metadata?.model) agent.model ??= metadata.model;
      if (metadata?.workflowPhase) agent.phaseTitle ??= metadata.workflowPhase;
    }
    const bytes = JSON.stringify(snapshot);
    const changed = !run.projectionFailed && run.observedBytes !== bytes;
    run.observedBytes = bytes;
    if (run.bytes === bytes) return;
    const path = join(this.root, "workflows", `${run.runId}.json`);
    await replaceProjection(run, path, bytes);
    run.bytes = bytes;
    return {
      changed,
      event: {
        type: "system",
        subtype: "magpie_workflow",
        version: 1,
        tool_use_id: run.toolUseId,
        task_id: run.taskId,
        snapshot,
        launchText: run.text.replace(run.transcriptDir, run.shadow),
      },
    };
  }
  async refreshAll() {
    for (const run of this.runs.values()) await this.refresh(run);
  }
  async close(status) {
    for (const run of this.runs.values()) {
      if (!run.status && status) run.status = status;
      // Cancellation can close the callback connection before the final disk
      // snapshot. Persist every run even when its UI subscriber has gone away.
      for (let attempt = 0; attempt < 3; attempt++) {
        const saved = await this.refresh(run).catch((error) => {
          if (status !== "cancelled") throw error;
          return true;
        });
        if (saved) break;
      }
      for (let attempt = 0; run.tempPath && attempt < 3; attempt++) {
        await cleanProjectionTemp(run).catch((error) => {
          if (!projectionIOError(error)) throw error;
          projectionState(run, true);
        });
      }
    }
  }
}
