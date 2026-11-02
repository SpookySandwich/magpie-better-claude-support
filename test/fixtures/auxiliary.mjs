import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { digest, readRequest } from "../../lib/context.mjs";

export const kinds = ["title", "compaction", "generate"];
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;
export const auxiliaryIdentityVersion = 1;

export function nativeClaudeModel(model) {
  const id = (model?.id ?? "").replace(/^magpie\//, "");
  return (
    /^(?:(?:auto|claude-native(?:-(?:subscription|monthly))?)\/)?claude-(?:opus|sonnet)-5-5(?:@ultracode)?$/.test(
      id,
    ) || /^group\/magpie-(?:opus|sonnet)-(?:native|claude-code|ultracode)$/.test(id)
  );
}

export function auxiliarySession(sessionID, kind) {
  if (typeof sessionID !== "string" || !SESSION.test(sessionID) || !kinds.includes(kind))
    throw new Error("Unsupported Magpie auxiliary identity.");
  return `magpie-aux:v1:${kind}:${sessionID}`;
}

export function identityHook(ctx, version = auxiliaryIdentityVersion) {
  return async (event) => {
    event.request.headers.set("x-opencode-session", event.sessionID);
    event.request.headers.set("x-magpie-request-kind", event.kind);
    if (!nativeClaudeModel(event.model)) return;
    if (!["primary", ...kinds].includes(event.kind))
      throw new Error("Unsupported Magpie request kind.");
    if (event.kind === "primary") return;
    const result = await ctx.plugin.list();
    const plugins = Array.isArray(result) ? result : result?.data;
    if (!Array.isArray(plugins)) throw new Error("Cannot verify Magpie ACP identity owner.");
    if (
      plugins.some(
        (plugin) => plugin.id === "magpie-acp-runtime" && plugin.state?.status === "active",
      )
    )
      return;
    if (version !== 1)
      throw new Error("Native auxiliary identity transport awaits harness 0.2.2 deployment.");
    event.request.headers.set("x-opencode-session", auxiliarySession(event.sessionID, event.kind));
  };
}

export const globalPlugin = {
  id: "magpie-session-identity",
  async setup(ctx) {
    await ctx.session.hook("http.request", identityHook(ctx), { providerID: "magpie" });
  },
};

export const acpPlugin = {
  id: "magpie-acp-runtime",
  async setup(ctx) {
    await ctx.session.hook("http.request", async (event) => {
      event.request.headers.set("x-opencode-session", event.sessionID);
      event.request.headers.set("x-magpie-request-kind", event.kind);
      const ancestors = [];
      let current = event.sessionID;
      while (current) {
        const info = await ctx.session.get({ sessionID: current });
        if (!info?.parentID) break;
        ancestors.push(info.parentID);
        current = info.parentID;
      }
      if (ancestors.length)
        event.request.headers.set("x-magpie-ancestors", JSON.stringify(ancestors));
    });
  },
};
export const userText =
  'Keep this exactly: 中文\nmagpie-aux:v9:title:literal\n<current_turn> $() "quotes"';
export const body = (text = userText, tools = true) =>
  JSON.stringify({
    model: "claude-sonnet-5-5@ultracode",
    reasoning_effort: "xhigh",
    messages: [{ role: "user", content: text }],
    ...(tools
      ? {
          tools: [
            { type: "function", function: { name: "Write", parameters: { type: "object" } } },
          ],
        }
      : {}),
  });
export const event = (kind, id = "auto/claude-sonnet-5-5", sessionID = "ses_child") => ({
  kind,
  sessionID,
  model: { providerID: "magpie", id },
  request: new Request("http://fixture.invalid/v1/chat/completions", {
    method: "POST",
    body: body(),
  }),
});
export const answer = (text = "fixture answer") => ({
  text,
  source: "subscription",
  conversationId: "fixture-native",
});

export async function setup(t, runTurn) {
  const root = fileURLToPath(new URL("../../.tmp/", import.meta.url));
  await mkdir(root, { recursive: true });
  const cwd = resolve(await mkdtemp(join(root, "auxiliary-")));
  t.after(() => rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const options = {
    cwd,
    executable: process.execPath,
    source: "subscription",
    stateDirectory: join(cwd, "state"),
    runTurn,
  };
  await mkdir(options.stateDirectory);
  return options;
}
export const statePath = (options, clientSession) =>
  join(
    options.stateDirectory,
    `${digest({ clientSession, cwd: options.cwd, executable: options.executable, source: options.source })}.json`,
  );
export async function seed(
  options,
  clientSession,
  input,
  version,
  status,
  requestKind = "primary",
) {
  const request = readRequest(input.body);
  const path = statePath(options, clientSession);
  const bytes = JSON.stringify({
    version,
    status,
    requestKind,
    requestHash: request.requestHash,
    hashes: request.hashes,
    conversationId: "legacy-native",
    ...(status === "complete" ? { response: answer("saved answer") } : {}),
  });
  await writeFile(path, bytes);
  return { path, bytes, unchanged: async () => (await readFile(path, "utf8")) === bytes };
}
