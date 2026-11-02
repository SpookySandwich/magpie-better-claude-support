// One Claude provider over both sources, as Magpie's ChatGPT accounts go on
// past their allowance on their credits: the subscription answers first, and
// the Console API key's credit takes a turn once the subscription's window for
// its model is used up.

// Initial refusals the credit can satisfy: the subscription's limit (429) and
// its overage billing (402). Anything else is the subscription's own answer.
const SWITCH = new Set([402, 429]);

// Whether a reading's windows say the subscription can't take model: one that
// counts it (every model's, or one scoped to its family) is used up and hasn't
// renewed.
export function spentFor(windows, model, now = Date.now()) {
  return (windows ?? []).some(
    (w) =>
      w.used >= 100 &&
      (!w.model || model.includes(w.model)) &&
      !(Date.parse(w.resetsAt) <= now),
  );
}

function modelOf(body) {
  try {
    return String(JSON.parse(body).model ?? "").toLowerCase();
  } catch {
    return "";
  }
}

// subscription and credit are adapters (fetch); credit is undefined without an
// API key. reading() is the subscription's last usage reading. A refusal rests
// the model on the credit for restMs, so a turn doesn't start Claude Code only
// to be refused again before the next reading shows the window used up.
export function createSwitch({ subscription, credit, reading, restMs = 10 * 60000, now = Date.now }) {
  const resting = new Map();
  return async (url, init = {}) => {
    if (!credit) return subscription(url, init);
    const model = modelOf(init.body);
    const spent = resting.get(model) > now() || spentFor(reading()?.windows, model, now());
    if (!spent) {
      const response = await subscription(url, init);
      if (!SWITCH.has(response.status)) return response;
      resting.set(model, now() + restMs);
      await response.body?.cancel();
    }
    return credit(url, init);
  };
}

// The merged usage card: the subscription's windows, then the credit's. A
// subscription window used up is set aside while credit is left, so Magpie
// keeps routing here and the switch spends the credit; the credit itself never
// holds the provider, since the subscription is what renews.
export function mergedUsage(subscription, credit) {
  const credits = credit?.windows ?? [];
  if (!subscription.windows && !credits.length) return subscription;
  const left = credits.some((w) => w.used < 100);
  return {
    plan: [subscription.plan, credits.length ? "API credit" : undefined].filter(Boolean).join(" + "),
    ...(subscription.user ? { user: subscription.user } : {}),
    ...(credit?.balance ? { balance: credit.balance } : {}),
    windows: [
      ...(subscription.windows ?? []).map((w) => (left && w.used >= 100 ? { ...w, aside: true } : w)),
      ...credits.map((w) => ({ ...w, aside: true })),
    ],
    signIn: "kept",
  };
}
