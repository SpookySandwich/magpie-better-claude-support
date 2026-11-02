import { join } from "node:path";
import { homedir } from "node:os";
import { fallbackKey, savedFallbackKey, subscriptionMethods } from "./lib/auth.mjs";
import { createAdapter } from "./lib/adapter.mjs";
import { discoverModels, modelCatalog } from "./lib/models.mjs";
import { every, subscriptionUsage, creditUsage } from "./lib/usage.mjs";
import { createSwitch, mergedUsage } from "./lib/switch.mjs";

// One model probe per executable and credential lasts for the host's lifetime.
// A failed probe is retried on the next call.
const probes = new Map();
function discover(executable, apiKey, workspace) {
  const key = `${executable}\n${apiKey ?? ""}\n${workspace ?? ""}`;
  if (!probes.has(key))
    probes.set(
      key,
      discoverModels({ executable, apiKey, workspace }).catch((error) => {
        probes.delete(key);
        throw error;
      }),
    );
  return probes.get(key);
}

// Magpie's usage cards: one /usage run or report read per source every 5 minutes.
const usage = every(5 * 60000, (read) => read());

const executableOf = (options) =>
  options.executable ??
  join(homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");

// Keep the established per-source state directories so existing conversations
// resume after the separate provider registrations are removed.
function adapterOptionsOf(source, directory, options) {
  return {
    source,
    restoreSecrets: options.restoreSecrets !== false,
    redactKeyPath: join(directory, "redact.key"),
    executable: executableOf(options),
    cwd: options.workingDirectory,
    stateDirectory: options.stateDirectory
      ? join(options.stateDirectory, source)
      : join(directory, "claude-native-sessions", source),
    brokerDirectory:
      options.brokerDirectory ??
      join(directory, "acp-runtime"),
    timeoutMs: options.timeoutMs ?? 1800000,
    // How long a new turn waits for a just-canceled turn to release its lease.
    leaseWaitMs: options.leaseWaitMs ?? 15000,
    defaultPermissionMode: options.defaultPermissionMode ?? "yolo",
  };
}

// Both sources as one provider (lib/switch.mjs). Signed in with a Console API
// key it has the credit to go on with; with the Claude Code login alone it is
// the subscription.
export const ClaudePlugin = async ({ directory, magpie }, options = {}) => {
  const id = "claude-native";
  const executable = executableOf(options);
  const workspace = options.workspace;
  const subscription = createAdapter({
    ...adapterOptionsOf("subscription", directory, options),
    discover: () => discover(executable),
  });
  let reading, lastKey;
  const subKey = `subscription\n${executable}`;
  const readSubscription = () =>
    usage(subKey, () => subscriptionUsage({ executable })).then(
      (value) => (reading = value),
    );
  const readCredit = (key) =>
    usage(`monthly\n${key}\n${JSON.stringify(options.credit)}`, () =>
      creditUsage({ apiKey: key, credit: options.credit }),
    );
  return {
    async config(cfg) {
      cfg.provider ??= {};
      cfg.provider[id] ??= {
        name: "Claude",
        npm: "@ai-sdk/openai-compatible",
        api: "http://claude-native.invalid/v1",
        models: await discover(executable).then(modelCatalog, () => ({})),
      };
    },
    auth: {
      provider: id,
      single: true,
      maxConcurrency: 0,
      methods: subscriptionMethods({
        executable,
        previousKey: async () => (await savedFallbackKey(directory, magpie?.account?.(id), id)) ?? lastKey,
        onLogin: () => {
          reading = undefined;
          usage.clear(subKey);
        },
      }),
      async loader(getAuth) {
        const auth = await getAuth();
        if (!auth) return {};
        const key = fallbackKey(auth);
        if (key) lastKey = key;
        return {
          baseURL: "http://claude-native.invalid/v1",
          fetch: createSwitch({
            subscription,
            credit: key
              ? createAdapter({
                  ...adapterOptionsOf("monthly", directory, options),
                  apiKey: key,
                  workspace,
                  discover: () => discover(executable, key, workspace),
                })
              : undefined,
            reading: () => reading,
          }),
        };
      },
      // The subscription's windows and, signed in with a key, the credit left.
      async usage(getAuth) {
        const auth = await getAuth();
        const key = fallbackKey(auth);
        if (key) lastKey = key;
        const [sub, credit] = await Promise.all([
          readSubscription(),
          key ? readCredit(key) : undefined,
        ]);
        return mergedUsage(sub, credit);
      },
    },
    provider: {
      id,
      async models() {
        return modelCatalog(await discover(executable));
      },
    },
    "chat.headers": async (input, output) => {
      if (input.model?.providerID === id && input.sessionID)
        output.headers["x-claude-native-session"] = input.sessionID;
    },
  };
};
