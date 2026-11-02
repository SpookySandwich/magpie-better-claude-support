import test from "node:test";
import assert from "node:assert/strict";
import { createSwitch, mergedUsage, spentFor } from "../lib/switch.mjs";

const body = (model) => JSON.stringify({ model, messages: [{ role: "user", content: "hi" }] });
const source = (name, status = 200) => {
  const calls = [];
  const fetch = async (_url, init) => {
    calls.push(JSON.parse(init.body).model);
    return new Response(name, { status });
  };
  return Object.assign(fetch, { calls });
};

test("the subscription answers while it has room", async () => {
  const subscription = source("subscription");
  const credit = source("credit");
  const fetch = createSwitch({ subscription, credit, reading: () => undefined });
  assert.equal(await (await fetch("", { body: body("claude-opus-5-5") })).text(), "subscription");
  assert.deepEqual(credit.calls, []);
});

test("a limit refusal moves the turn to the credit and rests the model there", async () => {
  let now = 1000;
  const subscription = source("limit", 429);
  const credit = source("credit");
  const fetch = createSwitch({ subscription, credit, reading: () => undefined, restMs: 500, now: () => now });
  assert.equal(await (await fetch("", { body: body("claude-opus-5-5") })).text(), "credit");
  assert.equal(await (await fetch("", { body: body("claude-opus-5-5") })).text(), "credit");
  assert.deepEqual(subscription.calls, ["claude-opus-5-5"]);
  // another model is still asked of the subscription
  await fetch("", { body: body("claude-sonnet-5-5") });
  assert.deepEqual(subscription.calls, ["claude-opus-5-5", "claude-sonnet-5-5"]);
  now += 600;
  await fetch("", { body: body("claude-opus-5-5") });
  assert.equal(subscription.calls.length, 3);
});

test("overage billing (402) switches too, other failures stay the subscription's", async () => {
  for (const [status, expected] of [[402, "credit"], [409, "failed"], [529, "failed"], [401, "failed"]]) {
    const fetch = createSwitch({ subscription: source("failed", status), credit: source("credit"), reading: () => undefined });
    assert.equal(await (await fetch("", { body: body("claude-opus-5-5") })).text(), expected, String(status));
  }
});

test("a reading with the model's window used up skips the subscription", async () => {
  const subscription = source("subscription");
  const credit = source("credit");
  const windows = [
    { name: "7 days", used: 40 },
    { name: "7 days · Fable", used: 100, model: "fable", resetsAt: "2030-01-01T00:00:00Z" },
  ];
  const fetch = createSwitch({ subscription, credit, reading: () => ({ windows }) });
  assert.equal(await (await fetch("", { body: body("claude-fable-5-1") })).text(), "credit");
  assert.equal(await (await fetch("", { body: body("claude-opus-5-5") })).text(), "subscription");
});

test("without an API key every turn is the subscription's", async () => {
  const fetch = createSwitch({ subscription: source("limit", 429), reading: () => undefined });
  assert.equal((await fetch("", { body: body("claude-opus-5-5") })).status, 429);
});

test("spentFor ignores windows whose reset has passed", () => {
  const now = Date.parse("2026-10-25T00:00:00Z");
  assert.equal(spentFor([{ used: 100, resetsAt: "2026-10-24T00:00:00Z" }], "claude-opus-5-5", now), false);
  assert.equal(spentFor([{ used: 100, resetsAt: "2026-10-26T00:00:00Z" }], "claude-opus-5-5", now), true);
  assert.equal(spentFor([{ used: 100 }], "claude-opus-5-5", now), true);
});

const credit = (used) => ({
  plan: "API credit",
  balance: "$120.00",
  windows: [{ name: "Credit", used, unit: "USD" }],
});

test("the merged card sets a used-up subscription window aside while credit is left", () => {
  const sub = {
    plan: "Max 20x",
    user: "me@example.com",
    windows: [
      { name: "5 hours", used: 100 },
      { name: "7 days", used: 60 },
    ],
  };
  const merged = mergedUsage(sub, credit(40));
  assert.equal(merged.plan, "Max 20x + API credit");
  assert.equal(merged.balance, "$120.00");
  assert.deepEqual(
    merged.windows.map((w) => [w.name, Boolean(w.aside)]),
    [["5 hours", true], ["7 days", false], ["Credit", true]],
  );
  // no credit left: the subscription's windows hold the provider again
  assert.equal(mergedUsage(sub, credit(100)).windows[0].aside, undefined);
  // no API key: the subscription's card as it was
  assert.deepEqual(mergedUsage(sub, undefined).windows, sub.windows);
});

test("the merged card keeps the credit when the subscription reading failed", () => {
  const merged = mergedUsage({ error: "unavailable" }, credit(10));
  assert.deepEqual(merged.windows.map((w) => w.name), ["Credit"]);
  assert.deepEqual(mergedUsage({ error: "unavailable" }, undefined), { error: "unavailable" });
});
