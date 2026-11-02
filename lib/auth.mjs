import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { cleanEnvironment, stopProcessTree } from "./native.mjs";

const REQUIRED =
  "Sign in to a Claude subscription first using the subscription sign-in option (or run claude auth login --claudeai).";

// V1 keeps both sources in one Magpie OAuth record. Claude owns the actual
// subscription tokens; the optional Console key stays in Magpie's auth store.
export function combinedAuth(account, apiKey) {
  return {
    type: "oauth",
    refresh: "local-cli",
    access: "local-cli",
    expires: 0,
    accountId: account.email || "local-claude-subscription",
    claudeNative: { version: 1, ...(apiKey ? { apiKey } : {}) },
  };
}

export function fallbackKey(auth) {
  if (auth?.claudeNative) {
    if (auth.claudeNative.version !== 1)
      throw new Error("Unsupported Claude connection version. Update the plugin before using it.");
    return auth.claudeNative.apiKey;
  }
  // Existing API and local-cli records remain usable until reconnected.
  return auth?.type === "api" ? auth.key : undefined;
}

export async function savedFallbackKey(directory, account, id = "claude-native") {
  if (!directory) return undefined;
  for (const file of ["plugin-auth.json", "auth.json"]) {
    const all = await readFile(join(directory, file), "utf8").then(JSON.parse, () => undefined);
    if (!all || typeof all !== "object") continue;
    const keys = [
      ...(account ? [account] : []),
      ...Object.keys(all)
        .filter((k) => k === id || k.startsWith(`${id}#`))
        .sort((a, b) => (a === id ? -1 : b === id ? 1 : a.localeCompare(b))),
    ];
    for (const key of keys) {
      try {
        const apiKey = fallbackKey(all[key]);
        if (apiKey) return apiKey;
      } catch {}
    }
  }
}

// Ask the CLI that will execute requests, with the same isolated environment.
// A binary on disk or a Console API key is not a subscription login.
export function subscriptionStatus(options) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      options.executable,
      [...(options.prefixArgs ?? []), "auth", "status", "--json"],
      {
        env: cleanEnvironment(options.environment),
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    const timer = setTimeout(() => {
      stopProcessTree(child);
      reject(new Error("Claude Code's authentication check timed out."));
    }, options.statusTimeoutMs ?? 15000);
    child.stdout.on("data", (chunk) => {
      stdout = (stdout + chunk).slice(-65536);
    });
    child.stderr.resume();
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("Cannot start Claude Code to verify its subscription login."));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      let status;
      try {
        status = JSON.parse(stdout);
      } catch {
        reject(new Error("Claude Code returned an unreadable authentication status."));
        return;
      }
      if (!status.loggedIn) return resolve(undefined);
      if (code !== 0)
        return reject(new Error("Claude Code could not verify its authentication status."));
      resolve(
        status.authMethod === "claude.ai" && status.apiProvider === "firstParty"
          ? status
          : undefined,
      );
    });
  });
}

// The CLI owns OAuth, credential storage and refresh. Only its authorization
// URL leaves this helper; raw output can contain sensitive authentication data.
async function startLogin(options) {
  const child = spawn(
    options.executable,
    [...(options.prefixArgs ?? []), "auth", "login", "--claudeai"],
    {
      env: cleanEnvironment(options.environment),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    found,
    settled = false;
  const link = new Promise((resolve) => {
    found = resolve;
  });
  const done = new Promise((resolve) => {
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(linkTimer);
      found("");
      resolve(ok);
    };
    const timer = setTimeout(() => {
      stopProcessTree(child);
      finish(false);
    }, options.loginTimeoutMs ?? 300000);
    const linkTimer = setTimeout(() => {
      stopProcessTree(child);
      finish(false);
    }, options.linkTimeoutMs ?? 15000);
    const read = (chunk) => {
      // Strip terminal ANSI styling before reading the CLI's authorization URL.
      // eslint-disable-next-line no-control-regex
      output = (output + chunk).slice(-65536).replace(/\x1b\[[0-9;]*m/g, "");
      const complete = output.slice(0, output.lastIndexOf("\n") + 1);
      const url = complete.match(
        /https:\/\/(?:claude\.ai|claude\.com|platform\.claude\.com|console\.anthropic\.com)\/[^\s<>"']*oauth\/authorize\?[^\s<>"']+/,
      )?.[0];
      if (url) {
        clearTimeout(linkTimer);
        found(url);
      }
    };
    child.stdout.on("data", read);
    child.stderr.on("data", read);
    child.once("error", () => finish(false));
    child.once("close", (code) => finish(code === 0));
  });
  const url = await link;
  if (!url) {
    if (await done) return { url: "", done };
    throw new Error(
      "Claude Code could not start browser sign-in. Run claude auth login --claudeai in a terminal, then reconnect here.",
    );
  }
  return { url, done };
}

export function subscriptionMethods(options) {
  const status = () => subscriptionStatus(options);
  return [
    {
      type: "oauth",
      label: "Claude subscription (optional API credit fallback)",
      prompts: [
        {
          type: "text",
          key: "apiKey",
          message:
            "Console API key for fallback after subscription limits (optional). This updates your single Claude connection. Leave empty to keep any existing fallback key, or use subscription only if none was saved. Your existing Claude login will be verified; otherwise browser sign-in will open.",
          placeholder: "sk-ant-… (optional)",
        },
      ],
      async authorize(inputs = {}) {
        const prior = inputs.apiKey?.trim() ? undefined : await options.previousKey?.();
        const current = await status();
        const login = current ? undefined : await startLogin(options);
        return {
          url: login?.url ?? "",
          opened: Boolean(login?.url),
          method: "auto",
          instructions: current
            ? `Using the existing Claude subscription${current.email ? ` for ${current.email}` : ""}.`
            : "Complete Claude's subscription sign-in in your browser. Claude Code keeps and refreshes the login.",
          async callback() {
            try {
              if (login && !(await login.done))
                return { type: "failed", error: "Claude subscription sign-in did not complete." };
              const account = await status();
              if (!account) return { type: "failed", error: REQUIRED };
              const key = inputs.apiKey?.trim() || prior || (await options.previousKey?.());
              await options.onLogin?.();
              return { ...combinedAuth(account, key), type: "success" };
            } catch (error) {
              return { type: "failed", error: error.message };
            }
          },
        };
      },
    },
  ];
}
