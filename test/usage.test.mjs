import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseClaudeUsage,
  readClaudeUsage,
  subscriptionUsage,
  creditUsage,
  tokenCost,
  every,
} from "../lib/usage.mjs";

const fixture = fileURLToPath(new URL("./fixtures/claude.mjs", import.meta.url));
const at = (iso) => Date.parse(iso);

// As Claude Code 2.1.303 printed it on 2026-10-22.
const reading = `You are currently using your subscription to power your Claude Code usage

Current session: 5% used · resets Oct 22, 4:50pm (America/New_York)
Current week (all models): 1% used · resets Oct 22, 8pm (America/New_York)
Current week (Fable): 1% used · resets Oct 22, 8pm (America/New_York)

What's contributing to your limits usage?
Approximate, based on local sessions on this machine — does not include other devices or claude.ai.
Last 24h · 9844 requests · 193 sessions
  74% of your usage was while 4+ sessions ran in parallel`;

test("/usage reads as Magpie's Claude Code card reads it", () => {
  assert.deepEqual(parseClaudeUsage(reading, at("2026-10-22T19:00:00Z")), [
    { name: "5 hours", used: 5, span: 18000, resetsAt: "2026-10-22T20:50:00.000Z" },
    { name: "7 days", used: 1, span: 604800, resetsAt: "2026-10-23T00:00:00.000Z" },
    { name: "7 days · Fable", used: 1, span: 604800, model: "fable", resetsAt: "2026-10-23T00:00:00.000Z" },
  ]);
  const colored = "\x1b[1mCurrent session: 13% used · resets Oct 1 at 3:30pm (Asia/Shanghai)\x1b[0m\nCurrent session: 99% used";
  assert.deepEqual(parseClaudeUsage(colored, at("2026-10-01T03:00:00Z")), [
    { name: "5 hours", used: 13, span: 18000, resetsAt: "2026-10-01T07:30:00.000Z" },
  ]);
  const plain = parseClaudeUsage("Current week (Sonnet 5.5): 40% used", at("2026-10-01T03:00:00Z"));
  assert.deepEqual(plain, [{ name: "7 days · Sonnet 5.5", used: 40, span: 604800, model: "sonnet-5-5" }]);
});

test("/usage resets without a year or a date", () => {
  const reset = (line, now) => parseClaudeUsage(line, at(now))[0].resetsAt;
  const week = (when) => `Current week (all models): 10% used · resets ${when}`;
  const session = (when) => `Current session: 10% used · resets ${when}`;
  assert.equal(reset(week("Jan 2 at 9am (UTC)"), "2026-12-30T00:00:00Z"), "2027-01-02T09:00:00.000Z");
  assert.equal(reset(week("Dec 31 at 11pm (UTC)"), "2027-01-01T01:00:00Z"), "2026-12-31T23:00:00.000Z");
  assert.equal(reset(week("Oct 22, 2026 at 3pm (UTC)"), "2026-10-01T00:00:00Z"), "2026-10-22T15:00:00.000Z");
  assert.equal(reset(week("Oct 9, 2:59PM (UTC)"), "2026-10-08T00:00:00Z"), "2026-10-09T14:59:00.000Z");
  assert.equal(reset(session("3pm (UTC)"), "2026-10-22T13:00:00Z"), "2026-10-22T15:00:00.000Z");
  // tomorrow's 3pm is further than five hours: the window reads as renewed
  assert.equal(reset(session("3pm (UTC)"), "2026-10-22T16:00:00Z"), "2026-10-22T15:00:00.000Z");
  assert.equal(reset(session("12:30am (UTC)"), "2026-10-22T22:00:00Z"), "2026-10-23T00:30:00.000Z");
  assert.equal(reset(session("3pm (Mars/Olympus)"), "2026-10-22T13:00:00Z") !== undefined, true);
});

test("/usage without an allowance is an error", () => {
  const now = at("2026-10-22T19:00:00Z");
  assert.throws(() => parseClaudeUsage("Error: 401 Unauthorized\n" + reading, now), /told no allowance: Error: 401/);
  assert.throws(() => parseClaudeUsage("You've hit your limit · resets 8pm", now), /told no allowance/);
  assert.throws(
    () => parseClaudeUsage("You are currently using your subscription to power your Claude Code usage.", now),
    /temporarily unavailable/,
  );
  assert.throws(() => parseClaudeUsage("", now), /temporarily unavailable/);
  assert.throws(() => parseClaudeUsage("Usage is shown on claude.ai\nmore", now), /told no allowance: Usage is shown on claude.ai$/);
});

test("/usage runs Claude Code without the inherited Claude environment", async (t) => {
  const root = fileURLToPath(new URL("../.tmp/", import.meta.url));
  await mkdir(root, { recursive: true });
  const home = await mkdtemp(join(root, "usage-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".claude"));
  await writeFile(
    join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { subscriptionType: "max", rateLimitTier: "default_claude_max_20x" } }),
  );
  await writeFile(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "fixture@example.com" } }));
  const environment = {
    ...process.env,
    CLAUDE_CODE_ENTRYPOINT: "claude-desktop",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    ANTHROPIC_API_KEY: "inherited",
    USAGE_FIXTURE: reading,
  };
  const options = { executable: process.execPath, prefixArgs: [fixture], environment, home, now: at("2026-10-22T19:00:00Z") };
  assert.equal(await readClaudeUsage(options), reading);
  const usage = await subscriptionUsage(options);
  assert.equal(usage.plan, "Max 20x");
  assert.equal(usage.user, "fixture@example.com");
  assert.equal(usage.signIn, "kept");
  assert.deepEqual(
    usage.windows.map((w) => [w.name, w.used]),
    [["5 hours", 5], ["7 days", 1], ["7 days · Fable", 1]],
  );
  await assert.rejects(readClaudeUsage({ ...options, environment: { ...environment, USAGE_FIXTURE: "" } }).then((text) => parseClaudeUsage(text)), /temporarily unavailable/);
  await assert.rejects(
    readClaudeUsage({ ...options, timeoutMs: 150, environment: { ...environment, USAGE_HANG: "1" } }),
    /did not answer in time/,
  );
  await assert.rejects(readClaudeUsage({ ...options, executable: join(home, "missing.exe"), prefixArgs: [] }), /Cannot start Claude Code/);
});

// Claude Code's tokens on 2026-10-21, by model, from the usage report.
const oct21 = [
  { model: "claude-fable-5-1", uncached_input_tokens: 32, output_tokens: 4 },
  { model: "claude-haiku-5-5", uncached_input_tokens: 22, cache_read_input_tokens: 150913, cache_creation: { ephemeral_5m_input_tokens: 50930 }, output_tokens: 914 },
  { model: "claude-opus-5-5", uncached_input_tokens: 2010, cache_read_input_tokens: 88792058, cache_creation: { ephemeral_5m_input_tokens: 4220355 }, output_tokens: 1462528 },
  { model: "claude-sonnet-5-5", uncached_input_tokens: 98, cache_read_input_tokens: 1348180, cache_creation: { ephemeral_5m_input_tokens: 373651 }, output_tokens: 4372 },
];

test("tokens are priced at list price", () => {
  assert.equal(Math.round(oct21.reduce((sum, row) => sum + tokenCost(row), 0) * 100) / 100, 69.38);
  assert.equal(tokenCost({ model: "claude-opus-5-5", cache_creation: { ephemeral_1h_input_tokens: 1e6 } }), 8);
  // an unknown model is priced as the dearest
  assert.equal(tokenCost({ model: "claude-newmodel-9", output_tokens: 1e6 }), 50);
});

function anthropic({ costs, hours, status = 200 }) {
  const asked = [];
  const fetcher = async (url, init) => {
    asked.push({ url: new URL(url), headers: init.headers });
    const pages = url.pathname.endsWith("cost_report") ? costs : hours;
    const page = Number(url.searchParams.get("page") ?? 0);
    return {
      ok: status === 200,
      status,
      json: async () =>
        status === 200
          ? { data: pages[page], has_more: page + 1 < pages.length, next_page: page + 1 < pages.length ? String(page + 1) : null }
          : { error: { message: "invalid x-api-key" } },
    };
  };
  return { fetcher, asked };
}

const day = (date, cents) => ({ starting_at: `${date}T00:00:00Z`, results: cents === undefined ? [] : [{ currency: "USD", amount: String(cents) }] });
const hour = (iso, rows) => ({ starting_at: iso, results: rows });
const credit = { usd: 200, since: "2026-10-08", expires: "2026-11-03T00:00:00Z" };

test("credit left is the cost report's settled days and today's tokens", async () => {
  const { fetcher, asked } = anthropic({
    costs: [
      [day("2026-10-08", 100.5), day("2026-10-09", 0)],
      [day("2026-10-20", 1000), day("2026-10-21", 6939.24)],
    ],
    hours: [
      [hour("2026-10-21T03:00:00Z", oct21)],
      [hour("2026-10-22T01:00:00Z", [{ model: "claude-haiku-5-5", output_tokens: 2e6 }]), hour("2026-10-22T02:00:00Z", [])],
    ],
  });
  const usage = await creditUsage({ apiKey: "sk-fixture", credit, fetcher, now: at("2026-10-22T15:00:00Z") });
  // settled 80.3974 + today's 2M Haiku output tokens at $0.50/M
  assert.equal(usage.balance, "$118.60");
  assert.equal(usage.plan, "API credit");
  assert.equal(usage.until, "2026-11-03T00:00:00.000Z");
  assert.equal(usage.renew, "off");
  assert.equal(usage.signIn, "kept");
  const [window] = usage.windows;
  assert.equal(window.name, "Credit");
  assert.equal(window.display, "≈$81.40 / $200.00");
  assert.equal(Math.round(window.amount * 1e4) / 1e4, 81.3974);
  assert.equal(window.limit, 200);
  assert.equal(window.unit, "USD");
  assert.equal(Math.round(window.used * 100) / 100, 40.7);
  assert.equal(window.runsOutAt, "2026-11-03T00:00:00.000Z");
  assert.equal(Math.round(window.runsOut * 100) / 100, 118.6);
  assert.equal(asked.length, 4);
  for (const { headers } of asked) {
    assert.equal(headers["x-api-key"], "sk-fixture");
    assert.equal(headers["anthropic-workspace-id"], undefined);
  }
  const urls = asked.map((a) => a.url);
  const cost = urls.find((url) => url.pathname === "/v1/organizations/cost_report");
  const usageReport = urls.find((url) => url.pathname === "/v1/organizations/usage_report/messages");
  assert.equal(cost.searchParams.get("starting_at"), "2026-10-08T00:00:00Z");
  assert.equal(cost.searchParams.get("bucket_width"), "1d");
  assert.equal(usageReport.searchParams.get("starting_at"), "2026-10-21T00:00:00Z");
  assert.equal(usageReport.searchParams.get("bucket_width"), "1h");
  assert.deepEqual(usageReport.searchParams.getAll("group_by[]"), ["model"]);
  assert.equal(urls.filter((url) => url.searchParams.get("page") === "1").length, 2);
});

test("a day the cost report hasn't settled is priced from its tokens", async () => {
  const { fetcher } = anthropic({
    costs: [[day("2026-10-20", 1000), day("2026-10-21")]],
    hours: [[hour("2026-10-21T03:00:00Z", oct21)]],
  });
  const usage = await creditUsage({ apiKey: "k", credit, fetcher, now: at("2026-10-22T00:10:00Z") });
  assert.equal(usage.windows[0].display, "≈$79.38 / $200.00");
  const settled = anthropic({ costs: [[day("2026-10-20", 1000)]], hours: [[]] });
  const exact = await creditUsage({ apiKey: "k", credit, fetcher: settled.fetcher, now: at("2026-10-22T00:10:00Z") });
  assert.equal(exact.windows[0].display, "$10.00 / $200.00");
  assert.equal(exact.balance, "$190.00");
});

test("credit after it expires, unset, or refused", async () => {
  const { fetcher } = anthropic({ costs: [[day("2026-10-20", 1000)]], hours: [[]] });
  const lapsed = await creditUsage({ apiKey: "k", credit, fetcher, now: at("2026-11-03T00:00:01Z") });
  assert.equal(lapsed.balance, "$0.00");
  assert.equal(lapsed.windows[0].used, 100);
  assert.equal(lapsed.windows[0].display, "expired 2026-11-03");
  assert.equal(lapsed.windows[0].runsOutAt, undefined);
  assert.match((await creditUsage({ apiKey: "k", credit: undefined, fetcher })).error, /credit option/);
  const refused = anthropic({ costs: [], hours: [], status: 401 });
  await assert.rejects(creditUsage({ apiKey: "k", credit, fetcher: refused.fetcher }), /HTTP 401 invalid x-api-key/);
});

test("readings are shared for a period and failures are kept as errors", async () => {
  let reads = 0;
  const cached = every(60000, async (fail) => {
    reads++;
    if (fail) throw new Error("broken");
    return { windows: [] };
  });
  const [a, b] = await Promise.all([cached("one", false), cached("one", false)]);
  assert.equal(a, b);
  assert.equal(reads, 1);
  await cached("one", false);
  assert.equal(reads, 1);
  assert.deepEqual(await cached("two", true), { error: "broken", signIn: "kept" });
  assert.deepEqual(await cached("two", false), { error: "broken", signIn: "kept" });
  assert.equal(reads, 2);
  cached.clear("two");
  assert.deepEqual(await cached("two", false), { windows: [] });
  assert.equal(reads, 3);
});

test("a due reading refreshes behind the last one, which a failure leaves standing", async () => {
  let fail = false,
    reads = 0;
  const read = async () => {
    reads++;
    if (fail) throw new Error("slow report");
    return { reads };
  };
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const always = every(0, read);
  // the first reading is waited for; a due one starts behind the last
  assert.deepEqual(await always("k"), { reads: 1 });
  assert.deepEqual(await always("k"), { reads: 1 });
  await settle();
  fail = true;
  assert.deepEqual(await always("k"), { reads: 2 });
  await settle();
  assert.deepEqual(await always("k"), { reads: 2 });
  assert.equal(reads, 4);
  const shortLived = every(0, read, 0);
  fail = false;
  await shortLived("k");
  fail = true;
  await shortLived("k");
  await settle();
  assert.deepEqual(await shortLived("k"), { error: "slow report", signIn: "kept" });
});
