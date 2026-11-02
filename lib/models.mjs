import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { BridgeError, EFFORTS } from "./context.mjs";
import { launchEnvironment, stopProcessTree } from "./native.mjs";

// Claude Code reports its model picker in the stream-json initialize response;
// no model request is sent. Asking with the source's own credentials keeps the
// list to what that source's turns can run.
export function discoverModels(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.executable,
      [
        ...(options.prefixArgs ?? []),
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--tools",
        "",
        "--no-session-persistence",
      ],
      {
        cwd: tmpdir(),
        env: launchEnvironment(options.apiKey, options.environment, options.workspace),
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stderr = "",
      settled = false;
    const settle = (error, models) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.stdin.end();
      stopProcessTree(child);
      if (error) reject(error);
      else resolve(models);
    };
    const timer = setTimeout(
      () => settle(new BridgeError("Claude Code did not report its models in time.")),
      options.timeoutMs ?? 30000,
    );
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-2000);
    });
    child.stdin.on("error", () => {});
    child.once("error", (error) =>
      settle(new BridgeError(`Cannot start Claude Code: ${error.message}`, "native_cli_unavailable")),
    );
    child.once("close", (code) =>
      settle(new BridgeError(`Claude Code exited before reporting models: ${stderr.trim() || `exit ${code}`}`)),
    );
    createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type !== "control_response" || event.response?.request_id !== "native-models") return;
      try {
        if (event.response.subtype !== "success")
          throw new BridgeError(event.response.error ?? "Claude initialization failed.");
        settle(null, nativeModels(event.response.response?.models));
      } catch (error) {
        settle(error);
      }
    });
    child.stdin.write(
      JSON.stringify({
        type: "control_request",
        request_id: "native-models",
        request: { subtype: "initialize" },
      }) + "\n",
    );
  });
}

// Picker aliases such as "opus" resolve to full IDs, and "default" repeats one
// of them. A full picker value keeps Claude Code's own suffix, such as [1m].
export function nativeModels(picker) {
  const models = new Map();
  for (const entry of Array.isArray(picker) ? picker : []) {
    const id = entry.resolvedModel?.replace(/\[[^\]]*\]$/, "");
    if (entry.value === "default" || !/^claude-[a-z0-9.-]+$/.test(id ?? "") || models.has(id))
      continue;
    models.set(id, {
      id,
      launch: entry.value?.startsWith(id) ? entry.value : id,
      name: `Claude ${entry.description?.split(" · ")[0] || entry.displayName || id}`,
      efforts:
        entry.supportsEffort === false
          ? []
          : (entry.supportedEffortLevels ?? EFFORTS).filter((effort) => EFFORTS.includes(effort)),
    });
  }
  if (!models.size) throw new BridgeError("Claude Code reported no models.");
  return models;
}

// Claude Code does not report limits. Every current Claude model has a 1M
// context window and 128K output.
export function modelCatalog(models) {
  return Object.fromEntries(
    [...models.values()].flatMap((model) =>
      [false, true]
        .filter((ultracode) => !ultracode || model.efforts.includes("xhigh"))
        .map((ultracode) => {
          const modelId = `${model.id}${ultracode ? "@ultracode" : ""}`;
          const efforts = ultracode ? ["xhigh"] : model.efforts;
          return [
            modelId,
            {
              id: modelId,
              name: `${model.name}${ultracode ? " Ultra Code" : ""}`,
              api: {
                id: modelId,
                npm: "@ai-sdk/openai-compatible",
                url: "http://claude-native.invalid/v1",
              },
              capabilities: {
                reasoning: true,
                toolcall: true,
                input: { text: true, image: true },
                output: { text: true },
              },
              reasoning: true,
              variants: Object.fromEntries(
                efforts.map((effort) => [effort, { reasoningEffort: effort }]),
              ),
              limit: { context: 1000000, output: 128000 },
              modalities: { input: ["text", "image"], output: ["text"] },
            },
          ];
        }),
    ),
  );
}
