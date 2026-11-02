import { createHmac, createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

const placeholders = () => /\{\{([A-Z][A-Z0-9_]{0,23})_([a-z2-7]{8})\}\}/g;
const markers = () => /(?:\n\n)?<magpie_native_restore v="1" id="([a-f0-9-]{36})"\/>/g;
export const RESTORE_CALLBACK = "magpie-native-restore-v1";
export const restoreHooks = {
  PreToolUse: [{ hookCallbackIds: [RESTORE_CALLBACK], timeout: 5 }],
};

// Magpie v0.1.1901: HMAC-SHA256(kind + NUL + value), first 40 bits in base32.
// This verifies candidates supplied by this request; it does not search for
// secrets or consult another conversation's mappings.
export function placeholderFor(key, kind, value) {
  const bytes = createHmac("sha256", key).update(kind + "\0" + value).digest();
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = 0, count = 0, tag = "";
  for (const byte of bytes.subarray(0, 5)) {
    bits = (bits << 8) | byte;
    count += 8;
    while (count >= 5) {
      count -= 5;
      tag += alphabet[(bits >>> count) & 31];
    }
  }
  return `{{${kind}_${tag}}}`;
}

// Try complete, bounded alignments. Every substituted span must verify, and
// every other character must agree. No partial or fuzzy mapping is accepted.
export function alignSecrets(original, masked, key, budget = { attempts: 4096, bytes: 8 * 1024 * 1024 }) {
  const tokens = [...masked.matchAll(placeholders())];
  if (!tokens.length || tokens.length > 128) return;
  const literals = [];
  let from = 0;
  for (const token of tokens) {
    literals.push(masked.slice(from, token.index));
    from = token.index + token[0].length;
  }
  literals.push(masked.slice(from));
  if (!original.startsWith(literals[0])) return;
  const visit = (index, offset, pairs) => {
    if (index === tokens.length) return offset === original.length ? pairs : undefined;
    const [token, kind] = tokens[index];
    const next = literals[index + 1];
    // Literal placeholders in the incoming transcript are data, not evidence
    // of a value. They may coexist with newly masked values in the same text.
    if (original.startsWith(token + next, offset)) {
      const found = visit(index + 1, offset + token.length + next.length, pairs);
      if (found) return found;
    }
    const last = index === tokens.length - 1;
    let end = last ? original.length - next.length
      : next ? original.indexOf(next, offset + 1) : offset + 1;
    while (end > offset && end <= original.length && end - offset <= 65536) {
      if (--budget.attempts < 0 || (budget.bytes -= (end - offset) * 3) < 0) return;
      if (original.startsWith(next, end)) {
        const value = original.slice(offset, end);
        if (placeholderFor(key, kind, value) === token && (!pairs.has(token) || pairs.get(token) === value)) {
          const found = visit(index + 1, end + next.length, new Map([...pairs, [token, value]]));
          if (found) return found;
        }
      }
      if (last) break;
      end = next ? original.indexOf(next, end + 1) : end + 1;
    }
  };
  return visit(0, literals[0].length, new Map());
}

function messageTexts(body) {
  const strings = [], system = [];
  for (const message of body.messages ?? []) {
    const text = typeof message.content === "string" ? message.content
      : Array.isArray(message.content) ? message.content
        .filter((part) => ["text", "input_text", "output_text"].includes(part.type))
        .map((part) => part.text).join("\n") : "";
    if (["system", "developer"].includes(message.role)) system.push(text);
    else if (text) strings.push(text);
    for (const call of message.tool_calls ?? []) {
      if (typeof call.function?.arguments === "string") strings.push(call.function.arguments);
    }
  }
  // Protocol conversion can combine system messages and text content parts.
  if (system.length) strings.unshift(system.join("\n\n"));
  return strings;
}

function stripMarker(body) {
  const ids = [];
  body.messages = body.messages.map((message) => {
    if (!["system", "developer"].includes(message.role)) return message;
    const strip = (text) => text.replace(markers(), (_, id) => { ids.push(id); return ""; });
    if (typeof message.content === "string") return { ...message, content: strip(message.content) };
    if (Array.isArray(message.content)) return { ...message, content: message.content.map((part) =>
      part.type === "text" ? { ...part, text: strip(part.text) } : part) };
    return message;
  }).filter((message) => !["system", "developer"].includes(message.role) ||
    (Array.isArray(message.content) ? message.content.some((part) => part.type !== "text" || part.text) : message.content));
  return ids;
}

export function createRestorer(values = new Map()) {
  const own = new Map(values);
  const rewrite = (input) => {
    if (typeof input === "string") return input.replace(placeholders(), (token) => own.get(token) ?? token);
    if (Array.isArray(input)) return input.map(rewrite);
    if (input && typeof input === "object")
      return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, rewrite(value)]));
    return input;
  };
  return {
    rewrite,
    dispose() { own.clear(); },
    hook(request) {
      if (request.callback_id !== RESTORE_CALLBACK || request.input?.hook_event_name !== "PreToolUse")
        throw new Error("Unexpected native restoration callback.");
      const input = request.input.tool_input;
      if (!input || typeof input !== "object" || Array.isArray(input))
        throw new Error("Invalid native tool input.");
      const updatedInput = rewrite(input);
      return JSON.stringify(updatedInput) === JSON.stringify(input) ? {}
        : { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput } };
    },
  };
}

export class SecretRequests {
  #entries = new Map();
  #bytes = 0;
  constructor({ ttlMs = 5 * 60000, maxEntries = 64, maxBytes = 32 * 1024 * 1024,
    maxRequestBytes = 4 * 1024 * 1024 } = {}) {
    Object.assign(this, { ttlMs, maxEntries, maxBytes, maxRequestBytes });
  }
  capture(body) {
    if (!Array.isArray(body.messages)) return;
    const copy = structuredClone(body);
    // Never accept a caller-provided handle to an earlier capture.
    stripMarker(copy);
    const texts = messageTexts(copy);
    const bytes = texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0);
    if (bytes > this.maxRequestBytes || bytes > this.maxBytes) return;
    while (this.#entries.size >= this.maxEntries || this.#bytes + bytes > this.maxBytes)
      this.release(this.#entries.keys().next().value);
    const id = randomUUID();
    const timer = setTimeout(() => this.release(id), this.ttlMs);
    timer.unref?.();
    this.#entries.set(id, { texts, bytes, timer });
    this.#bytes += bytes;
    copy.messages.push({ role: "system", content: `<magpie_native_restore v="1" id="${id}"/>` });
    return { id, body: copy };
  }
  release(id) {
    const entry = this.#entries.get(id);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.#bytes -= entry.bytes;
    entry.values?.clear();
    this.#entries.delete(id);
  }
  async bind(raw, keyPath) {
    const body = JSON.parse(raw);
    if (!Array.isArray(body.messages)) return { body: raw, restorer: createRestorer() };
    const ids = stripMarker(body);
    const clean = JSON.stringify(body);
    const empty = () => ({ body: clean, restorer: createRestorer() });
    if (ids.length !== 1) return empty();
    const entry = this.#entries.get(ids[0]);
    if (!entry) return empty();
    const masked = messageTexts(body);
    const fingerprint = createHash("sha256").update(JSON.stringify(masked)).digest("hex");
    if (entry.values) return entry.fingerprint === fingerprint
      ? { body: clean, restorer: createRestorer(entry.values) } : empty();
    let key;
    try { key = await readFile(keyPath); } catch { return empty(); }
    if (key.length < 32 || this.#entries.get(ids[0]) !== entry) { key.fill(0); return empty(); }
    if (entry.values) {
      key.fill(0);
      return entry.fingerprint === fingerprint
        ? { body: clean, restorer: createRestorer(entry.values) } : empty();
    }
    const values = new Map(), conflicts = new Set();
    const budget = { attempts: 16384, bytes: 32 * 1024 * 1024 };
    try {
      for (const text of masked) {
        if (!placeholders().test(text)) continue;
        // Matching is confined to this capture. Even after protocol conversion,
        // full text alignment and keyed verification are required.
        for (const original of entry.texts) {
          const pairs = alignSecrets(original, text, key.subarray(0, 32), budget);
          if (!pairs) continue;
          for (const [token, value] of pairs) {
            if (values.has(token) && values.get(token) !== value) conflicts.add(token);
            values.set(token, value);
          }
        }
      }
    } finally { key.fill(0); }
    for (const token of conflicts) values.delete(token);
    this.#bytes -= entry.bytes;
    entry.bytes = [...values].reduce((sum, [token, value]) => sum + Buffer.byteLength(token) + Buffer.byteLength(value), 0);
    this.#bytes += entry.bytes;
    entry.texts = [];
    entry.values = values;
    entry.fingerprint = fingerprint;
    return { body: clean, restorer: createRestorer(values) };
  }
}

// Both module entries are imported in the same Magpie plugin host.
export const secretRequests = new SecretRequests();
