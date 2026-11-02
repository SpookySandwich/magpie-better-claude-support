import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { cleanEnvironment, stopProcessTree } from "./native.mjs";

// Usage for Magpie's auth.usage hook. The subscription reads Claude Code's own
// /usage, as Magpie's built-in Claude Code card does (claude_usage_cli.go,
// ported). The API key reads the Console credit from Anthropic's cost report
// for finished UTC days and prices the usage report's tokens for the rest.

const HOUR = 3600000;
const DAY = 24 * HOUR;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SLACK = 2 * HOUR;

// "Current session: 13% used · resets Oct 1 at 3:30pm (Asia/Shanghai)",
// "Current week (all models): 4% used · resets Oct 3, 2pm (UTC)",
// "Current week (Fable): 0% used"
const LINE = /^Current (session|week(?: \(([^)]+)\))?):\s*([0-9.]+)% used(?:\s*·\s*resets (.+))?$/;
// An account error stays visible even when it also mentions a rate limit.
const DENIED =
  /\b(401|403)\b|not (logged|signed) in|signed out|sign-in (has )?expired|unauthorized|forbidden|authentication (failed|required)|invalid (access )?token|(session|usage) limit|hit your limit|using your overages/i;
const BILLING_ONLY = "You are currently using your subscription to power your Claude Code usage";

export function parseClaudeUsage(text, now = Date.now()) {
  const lines = text.replace(/\x1b\[[0-9;]*m/g, "").trim().split(/\r?\n/).map((line) => line.trim());
  const denied = lines.find((line) => DENIED.test(line));
  if (denied) throw new Error(`Claude Code's /usage told no allowance: ${clip(denied)}`);
  const windows = [];
  for (const line of lines) {
    const m = line.match(LINE);
    if (!m || !Number.isFinite(Number(m[3]))) continue;
    const scope = m[2]?.trim();
    const week = m[1] !== "session";
    const window = {
      name: !week ? "5 hours" : scope && !/^all models$/i.test(scope) ? `7 days · ${scope}` : "7 days",
      used: Number(m[3]),
      span: week ? 7 * 24 * 3600 : 5 * 3600,
    };
    if (week && scope && !/^all models$/i.test(scope))
      window.model = scope.toLowerCase().replace(/[ .]/g, "-");
    if (windows.some((w) => w.name === window.name)) continue;
    const resets = m[4] && resetTime(m[4], now, window.span * 1000);
    if (resets !== undefined) window.resetsAt = new Date(resets).toISOString();
    windows.push(window);
  }
  if (!windows.length) {
    if (!lines.join("") || lines.some((line) => line.replace(/\.$/, "") === BILLING_ONLY))
      throw new Error("Claude Code's /usage is temporarily unavailable");
    throw new Error(`Claude Code's /usage told no allowance: ${clip(lines[0])}`);
  }
  return windows;
}

const clip = (line) => (line.length > 120 ? `${line.slice(0, 120)}…` : line);

// "Oct 1 at 3:30pm (Asia/Shanghai)", "Oct 9, 2:59pm (UTC)" or "3pm (Asia/Shanghai)",
// in the zone named, else local time. A date with no year is in the first year
// it is less than a day past and no further ahead than its window (plus slack);
// otherwise the latest year it is past, so the window reads as renewed.
export function resetTime(text, now, span) {
  let zone;
  let s = text.trim();
  const named = s.match(/^(.*?)\s*\(([^)]+)\)$/);
  if (named) {
    s = named[1];
    zone = validZone(named[2]);
  }
  const latest = now + span + SLACK;
  const dated = s.match(/^([a-z]{3})[a-z]* (\d{1,2})(?:, (\d{4}))?(?: at |, )(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (dated) {
    const month = MONTHS.indexOf(dated[1].toLowerCase());
    if (month < 0) return undefined;
    const [hour, minute] = clock(dated[4], dated[5], dated[6]);
    const day = Number(dated[2]);
    if (dated[3]) return zoned(Number(dated[3]), month, day, hour, minute, zone);
    const year = wall(now, zone).year;
    let past;
    for (let y = year - 1; y <= year + 1; y++) {
      const t = zoned(y, month, day, hour, minute, zone);
      if (t >= now - DAY && t <= latest) return t;
      if (t < now) past = t;
    }
    return past;
  }
  const timed = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i);
  if (!timed) return undefined;
  const [hour, minute] = clock(timed[1], timed[2], timed[3]);
  const today = wall(now, zone);
  for (let d = 0; d <= 2; d++) {
    const t = zoned(today.year, today.month, today.day + d, hour, minute, zone);
    if (t < now) continue;
    if (t <= latest) return t;
    break;
  }
  for (let d = 0; d >= -2; d--) {
    const t = zoned(today.year, today.month, today.day + d, hour, minute, zone);
    if (t < now) return t;
  }
}

function clock(hour, minute, half) {
  return [(Number(hour) % 12) + (half.toLowerCase() === "pm" ? 12 : 0), Number(minute ?? 0)];
}

function validZone(zone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return zone;
  } catch {
    return undefined;
  }
}

// The wall clock in zone (local time when undefined) at instant t.
function wall(t, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    })
      .formatToParts(t)
      .map((part) => [part.type, Number(part.value)]),
  );
  return { ...parts, month: parts.month - 1 };
}

// The instant the wall clock in zone reads y-m-d h:mi.
function zoned(year, month, day, hour, minute, zone) {
  const target = Date.UTC(year, month, day, hour, minute);
  let t = target;
  for (let i = 0; i < 3; i++) {
    const w = wall(t, zone);
    const shown = Date.UTC(w.year, w.month, w.day, w.hour, w.minute);
    if (shown === target) break;
    t += target - shown;
  }
  return t;
}

// Runs `claude -p /usage`, a command Claude Code answers itself without asking
// a model. Nonessential traffic must stay on, or /usage only repeats a cached
// reading.
export async function readClaudeUsage(options) {
  const cwd = await mkdtemp(join(tmpdir(), "claude-usage-"));
  let exited;
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(
        options.executable,
        [
          ...(options.prefixArgs ?? []),
          "-p",
          "/usage",
          "--output-format",
          "json",
          "--tools",
          "",
          "--strict-mcp-config",
          "--setting-sources",
          "",
          "--no-session-persistence",
        ],
        {
          cwd,
          env: {
            ...cleanEnvironment(options.environment),
            DISABLE_TELEMETRY: "1",
            DISABLE_ERROR_REPORTING: "1",
            DISABLE_AUTOUPDATER: "1",
          },
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      exited = new Promise((done) => {
        if (child.exitCode !== null || child.signalCode !== null) return done();
        child.once("close", done);
        child.once("error", done);
      });
      let stdout = "",
        stderr = "";
      const timer = setTimeout(() => {
        stopProcessTree(child);
        reject(new Error("Claude Code's /usage did not answer in time."));
      }, options.timeoutMs ?? 30000);
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr = (stderr + chunk).slice(-2000)));
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(new Error(`Cannot start Claude Code: ${error.message}`));
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        let result;
        try {
          result = JSON.parse(stdout);
        } catch {
          return reject(new Error(`Claude Code: ${clip(stderr.trim() || stdout.trim() || `exit ${code}`)}`));
        }
        if (result.is_error || typeof result.result !== "string")
          return reject(new Error(`Claude Code: ${clip(String(result.result ?? `exit ${code}`))}`));
        resolve(result.result);
      });
    });
  } finally {
    if (exited) {
      let wait;
      await Promise.race([exited, new Promise((done) => (wait = setTimeout(done, 2000)))]);
      clearTimeout(wait);
    }
    await rm(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => {});
  }
}

// The plan and email of the CLI's claude.ai login, as Claude Code saved them.
export async function claudeAccount(home = homedir()) {
  const read = (file) => readFile(file, "utf8").then(JSON.parse, () => ({}));
  const [credentials, state] = await Promise.all([
    read(join(home, ".claude", ".credentials.json")),
    read(join(home, ".claude.json")),
  ]);
  const type = credentials.claudeAiOauth?.subscriptionType;
  const tier = credentials.claudeAiOauth?.rateLimitTier?.match(/_(\d+x)$/)?.[1];
  return {
    plan: type ? `${type[0].toUpperCase()}${type.slice(1)}${tier ? ` ${tier}` : ""}` : undefined,
    user: state.oauthAccount?.emailAddress,
  };
}

export async function subscriptionUsage(options) {
  const now = options.now ?? Date.now();
  const [account, windows] = await Promise.all([
    claudeAccount(options.home),
    (options.readUsage ?? readClaudeUsage)(options).then((text) => parseClaudeUsage(text, now)),
  ]);
  return { ...account, windows, signIn: "kept" };
}

// USD per million tokens: input, output, cache read. Cache writes cost 1.25x
// input for five minutes and 2x for an hour. Haiku's are its <=100K-prompt rates.
const PRICES = {
  fable: [10, 50, 0.25],
  opus: [4, 20, 0.2],
  sonnet: [2, 10, 0.2],
  haiku: [0.1, 0.5, 0.01],
};

// A newer model of a family is priced as the family's current one; anything
// unknown as the dearest, so the balance is never overstated.
export function tokenCost(row) {
  const [input, output, cached] =
    PRICES[Object.keys(PRICES).find((family) => row.model?.includes(family))] ?? PRICES.fable;
  return (
    ((row.uncached_input_tokens ?? 0) * input +
      (row.cache_creation?.ephemeral_5m_input_tokens ?? 0) * input * 1.25 +
      (row.cache_creation?.ephemeral_1h_input_tokens ?? 0) * input * 2 +
      (row.cache_read_input_tokens ?? 0) * cached +
      (row.output_tokens ?? 0) * output) /
    1e6
  );
}

async function report(path, params, apiKey, fetcher) {
  const buckets = [];
  let page;
  do {
    const url = new URL(`/v1/organizations/${path}`, "https://api.anthropic.com");
    for (const [name, value] of params) url.searchParams.append(name, value);
    if (page) url.searchParams.set("page", page);
    const response = await fetcher(url, {
      headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01" },
      // the reports sometimes take tens of seconds; a read outlasting Magpie's
      // wait still lands in the cache for its next ask (every)
      signal: AbortSignal.timeout(60000),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok)
      throw new Error(`Anthropic ${path}: HTTP ${response.status} ${body.error?.message ?? ""}`.trim());
    buckets.push(...(body.data ?? []));
    page = body.has_more ? body.next_page : undefined;
  } while (page);
  return buckets;
}

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, "Z");
// Whole cents as the Console's Billing page shows them: what is left rounded
// down, what is spent up.
const money = (usd, round = Math.floor) =>
  `$${(round(usd * 100 + (round === Math.ceil ? -1e-6 : 1e-6)) / 100).toFixed(2)}`;

// credit: { usd, since, expires } as the Console's Billing page shows the grant.
// Days the cost report has settled are exact; the rest (today, and yesterday
// until it settles) are the usage report's tokens at list price, ~20 min behind.
export async function creditUsage({ apiKey, credit, fetcher = fetch, now = Date.now() }) {
  const usd = Number(credit?.usd);
  const since = Date.parse(credit?.since);
  const expires = credit?.expires ? Date.parse(credit.expires) : undefined;
  if (!(usd > 0) || Number.isNaN(since))
    return {
      error: 'Set the plugin\'s credit option, e.g. {"usd":200,"since":"2026-10-08","expires":"2026-11-03"}.',
      signIn: "kept",
    };
  const today = Math.floor(now / DAY) * DAY;
  const recent = Math.max(Math.floor(since / DAY) * DAY, today - DAY);
  const [costs, usage] = await Promise.all([
    report("cost_report", [["starting_at", iso(since)], ["bucket_width", "1d"], ["limit", "31"]], apiKey, fetcher),
    report(
      "usage_report/messages",
      [["starting_at", iso(recent)], ["bucket_width", "1h"], ["group_by[]", "model"], ["limit", "48"]],
      apiKey,
      fetcher,
    ),
  ]);
  const settled = new Map();
  for (const bucket of costs) {
    const cents = (bucket.results ?? []).reduce((sum, item) => sum + Number(item.amount ?? 0), 0);
    settled.set(bucket.starting_at.slice(0, 10), cents / 100);
  }
  const priced = new Map();
  for (const bucket of usage) {
    const day = bucket.starting_at.slice(0, 10);
    const cost = (bucket.results ?? []).reduce((sum, row) => sum + tokenCost(row), 0);
    priced.set(day, (priced.get(day) ?? 0) + cost);
  }
  let spent = 0,
    estimated = false;
  for (const day of new Set([...settled.keys(), ...priced.keys()])) {
    if (settled.get(day) > 0 || !(priced.get(day) > 0)) spent += settled.get(day) ?? 0;
    else {
      spent += priced.get(day);
      estimated = true;
    }
  }
  const lapsed = expires !== undefined && now >= expires;
  const left = lapsed ? 0 : Math.max(0, usd - spent);
  return {
    plan: "API credit",
    balance: money(left),
    until: expires === undefined ? undefined : new Date(expires).toISOString(),
    renew: "off",
    windows: [
      {
        name: "Credit",
        used: lapsed ? 100 : (spent / usd) * 100,
        amount: lapsed ? usd : spent,
        limit: usd,
        unit: "USD",
        display: lapsed
          ? `expired ${new Date(expires).toISOString().slice(0, 10)}`
          : `${estimated ? "≈" : ""}${money(spent, Math.ceil)} / ${money(usd)}`,
        ...(expires !== undefined && !lapsed
          ? { runsOutAt: new Date(expires).toISOString(), runsOut: left }
          : {}),
      },
    ],
    signIn: "kept",
  };
}

// Magpie asks every minute or so while requests flow, and gives up on a read
// after 20 s. Each key reads at most once per period, in the background once
// there is a reading: callers get the last one at once. A failed read leaves
// the last good reading standing for up to keep, so one slow report or CLI
// run doesn't blank the card; after that the error shows.
export function every(ms, read, keep = 30 * 60000) {
  const entries = new Map();
  return Object.assign(
    (key, ...args) => {
      let entry = entries.get(key);
      if (!entry) entries.set(key, (entry = {}));
      if (!entry.pending && !(Date.now() - entry.at < ms))
        entry.pending = read(...args)
          .then(
            (value) => Object.assign(entry, { value, good: Date.now() }),
            (error) => {
              if (!(Date.now() - entry.good < keep)) entry.value = { error: error.message, signIn: "kept" };
            },
          )
          .then(() => Object.assign(entry, { pending: undefined, at: Date.now() }).value);
      return "value" in entry ? Promise.resolve(entry.value) : entry.pending;
    },
    { clear: (key) => (key === undefined ? entries.clear() : entries.delete(key)) },
  );
}
