# magpie-better-claude-support

English | [简体中文](README.md)

[![CI](https://github.com/SpookySandwich/magpie-better-claude-support/actions/workflows/ci.yml/badge.svg)](https://github.com/SpookySandwich/magpie-better-claude-support/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![magpie](https://img.shields.io/badge/magpie-plugin-111827)](https://github.com/yetone/magpie)
[![node](https://img.shields.io/badge/node-%E2%89%A524-3c873a)](package.json)
[![stars](https://img.shields.io/github/stars/SpookySandwich/magpie-better-claude-support?style=flat&label=stars)](https://github.com/SpookySandwich/magpie-better-claude-support/stargazers)

Run the **real** Claude Code engine inside [Magpie](https://github.com/yetone/magpie) — with full native tools, `@ultracode` multi-agent workflows, and zero-downtime failover from your Claude subscription to Anthropic Console API credit.

---

## Why This Plugin Exists

Magpie's built-in Claude integration launches the Claude CLI as a stripped-down text generator (`--tools ""`), disabling Claude Code's native toolchain and halting your work the moment a 5-hour subscription window reaches 100%.

**`magpie-better-claude-support`** (Provider ID: `claude-native`) replaces that compromise with a single unified provider that runs the genuine Claude Code runtime at full strength and keeps sessions alive across quota boundaries.

| Capability | Magpie Built-in (`claude`) | `magpie-better-claude-support` (`claude-native`) |
| :--- | :--- | :--- |
| **Claude Native Tools & Workflows** | Disabled (`--tools ""`) | **Full native toolset + `@ultracode` multi-agent orchestration** |
| **When 5h / Weekly Quota Hits 100%** | Hard stop (`429` error) | **Seamless failover to Anthropic Console API credit** |
| **Usage Dashboard** | Subscription windows only | **Unified card: 5h/7d subscription windows + live API dollar balance** |
| **Model & Effort Catalog** | Hardcoded in binary | **Zero-cost live discovery directly from your installed Claude CLI** |
| **Gateway Redaction Compatibility** | Redacted placeholders break local tool execution | **Prompt stays redacted in transit; real secrets are restored locally before tool execution** |
| **Turn Latency** | Cold-starts a new CLI process on every print turn | **Warm process parking reuses the live CLI session across turns** |
| **Crash / Retry Safety** | Blind gateway retries can re-run file edits | **Session lease guards prevent side-effecting turns from replaying** |

---

## Core Advantages

### 1. Genuine Claude Code Runtime & `@ultracode`
Instead of reducing Claude Code to a chat-completion proxy, this provider runs Claude with its own native tools (`Read`, `Edit`, `Write`, `Bash`, `Workflow`) and system instructions. Every model that supports `xhigh` reasoning automatically exposes an `@ultracode` variant that unlocks parallel multi-stage subagent workflows and waits for all background agents to settle before completing a turn.

### 2. Uninterrupted Subscription → API Credit Failover
Every turn prioritizes your Claude Pro/Max subscription at zero marginal cost. When a 5-hour or weekly window reaches 100%—or Anthropic returns an initial `402` / `429` refusal—traffic automatically shifts to your fallback Anthropic Console API key (`ANTHROPIC_API_KEY`) and returns to the subscription as soon as the window resets.

### 3. Unified Subscription & Credit Telemetry
Anthropic does not offer a balance API for Console credits, leaving API fallback users blind. This plugin combines settled daily charges from the Anthropic Admin cost report with real-time hourly token usage (within ~0.2% of final billing) to display your remaining dollar grant alongside your 5-hour and 7-day subscription windows on a single Magpie card.

### 4. Live Model & Effort Discovery
No plugin update is required when Anthropic ships a new model or context tier. On startup, the provider queries the installed Claude CLI's own model picker without sending a billable request, automatically surfacing every model and reasoning effort level (`low`, `medium`, `high`, `xhigh`, `max`) your account can access.

### 5. Local Secret Restoration Under Gateway Redaction
When Magpie's privacy redaction masks API keys or tokens in outbound prompts, an unassisted agent will write literal placeholder strings into your files or shell commands. This plugin keeps prompts masked on the wire to Anthropic while verifying Magpie's local redaction key to restore the original values right before a local tool executes.

### 6. Warm Process Reuse & Replay Protection
Idle Claude CLI processes stay parked between turns to eliminate cold-start overhead. If a network drop or client retry repeats a request after native tools have already begun modifying files, atomic session leases block the duplicate run so side effects never execute twice.

### 7. Strict Credential Isolation
Launching Magpie from inside a desktop agent or polluted shell often leaks `CLAUDE*` or `ANTHROPIC_*` environment variables, causing API-key turns to silently bill your subscription (or vice versa). Every child process starts in a sanitized environment with explicit credential and workspace binding.

---

## Quick Start

### 1. Install the Plugin

Install directly from GitHub via the Magpie CLI (or paste `github:SpookySandwich/magpie-better-claude-support` into **Plugins** in the Magpie UI):

```bash
magpie plugin add github:SpookySandwich/magpie-better-claude-support
```

### 2. Sign In

Connect your Claude subscription and optionally provide an Anthropic Console API key for automatic fallback:

```bash
magpie plugin login claude-native
```

* **Subscription only**: Leave the optional API key prompt blank. If your local `claude` CLI is already signed in, it is verified and reused immediately; otherwise, browser sign-in launches automatically.
* **Subscription + API fallback**: Paste an Anthropic Console key (`sk-ant-api...` or user-scoped `sk-ant-usr...`). Re-signing in later with an empty prompt preserves your saved fallback key.

---

## Optional Configuration: Track Console Credit Balance

To display your remaining Console credit balance and expiration on the Magpie usage card (and bind user-scoped `sk-ant-usr...` keys to a specific workspace), pass your workspace ID and credit grant details via `magpie plugin options`:

```bash
magpie plugin options magpie-better-claude-support '{"workspace":"wrkspc_YOUR_ID","credit":{"usd":200,"since":"2026-10-01","expires":"2026-12-31T00:00:00Z"}}'
```

| Option | Description |
| :--- | :--- |
| `workspace` | Anthropic Console workspace ID (`wrkspc_...`), required when billing a user-scoped key (`sk-ant-usr...`). |
| `credit.usd` | Total credit grant in USD as shown on the Anthropic Console Billing page. |
| `credit.since` | Start date (`YYYY-MM-DD`) of the credit grant. |
| `credit.expires` | ISO-8601 UTC timestamp when the credit grant expires. |
| `defaultPermissionMode` | Permission mode for direct gateway callers (`"yolo"` by default, or `"default"` / `"plan"`). |
| `restoreSecrets` | Set to `false` to disable automatic local restoration of Magpie-redacted placeholders (`true` by default). |

---

## License

[MIT](LICENSE) © [SpookySandwich](https://github.com/SpookySandwich)
