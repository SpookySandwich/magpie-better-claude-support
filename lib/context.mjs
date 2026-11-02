import { createHash } from "node:crypto";
import { imageBlock } from "./images.mjs";

export class BridgeError extends Error {
  constructor(message, code = "invalid_native_request") {
    super(message);
    this.code = code;
  }
}
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"];
export const BRIDGE_MARKER =
  /(?:^|\n)<magpie_native_bridge v="1" id="([a-f0-9-]{36})" request="([a-f0-9-]{36})"\/>(?:\n|$)/;

export function resolveModel(id, effort) {
  const ultracode = id.endsWith("@ultracode");
  const model = ultracode ? id.slice(0, -10) : id;
  // The plugin lists what Claude Code reports; Claude Code checks the rest.
  if (!/^claude-[a-z0-9.-]+$/.test(model))
    throw new BridgeError(`Unsupported native Claude model: ${id}`);
  if (effort != null && !EFFORTS.includes(effort))
    throw new BridgeError(`Unsupported Claude effort: ${effort}`);
  if (ultracode && effort != null && effort !== "xhigh")
    throw new BridgeError("Ultra Code requires xhigh effort.");
  return { model, effort: ultracode ? "xhigh" : (effort ?? "high"), ultracode };
}

function contentParts(content) {
  if (content == null) return [];
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) throw new BridgeError("Expected message content.");
  return content.map((part) => {
    if (["text", "input_text", "output_text"].includes(part.type) && typeof part.text === "string")
      return { type: "text", text: part.text };
    if (["image", "image_url", "input_image"].includes(part.type)) return imageBlock(part);
    throw new BridgeError(`Unsupported native content block: ${part.type}.`);
  });
}

export function readRequest(body) {
  let input;
  try {
    input = JSON.parse(body);
  } catch {
    throw new BridgeError("Expected JSON.");
  }
  if (!Array.isArray(input.messages) || !input.messages.length)
    throw new BridgeError("Expected Chat Completions messages.");
  if (input.tool_choice === "required" || typeof input.tool_choice === "object")
    throw new BridgeError(
      "Native Claude executes its own tools; forced caller tool calls are unsupported.",
    );
  let bridge;
  const messages = input.messages
    .map((message) => {
      if (!["system", "developer", "user", "assistant", "tool"].includes(message.role))
        throw new BridgeError("Unsupported message role.");
      const content = contentParts(message.content);
      const hasImages = content.some((part) => part.type === "image");
      let text = content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (["system", "developer"].includes(message.role)) {
        if (hasImages) throw new BridgeError("Images must be in conversation messages.");
        const marker = text.match(BRIDGE_MARKER);
        if (marker) {
          bridge = { id: marker[1], request: marker[2] };
          text = text.replace(BRIDGE_MARKER, "\n").trim();
        }
      }
      return {
        role: message.role,
        text,
        ...(hasImages ? { content } : {}),
        ...(message.tool_calls?.length ? { historicalToolCalls: message.tool_calls } : {}),
        ...(message.tool_call_id ? { historicalToolId: message.tool_call_id } : {}),
      };
    })
    .filter(
      (message) =>
        message.text || message.content || message.historicalToolCalls || message.historicalToolId,
    );
  if (!messages.some((message) => message.role === "user"))
    throw new BridgeError("A user task is required.");
  const selection = resolveModel(input.model, input.reasoning_effort ?? input.reasoning?.effort);
  return {
    ...selection,
    publicModel: input.model,
    stream: input.stream === true,
    messages,
    bridge,
    hashes: messages.map(digest),
    requestHash: digest({ ...selection, messages }),
  };
}

function describe(message) {
  return `${message.role.toUpperCase()}: ${message.text}${message.historicalToolCalls ? `\nHistorical tools: ${JSON.stringify(message.historicalToolCalls)}` : ""}${message.historicalToolId ? `\nHistorical result for: ${message.historicalToolId}` : ""}`;
}

function promptMessages(messages) {
  return messages.flatMap((message) =>
    message.content
      ? [
          { type: "text", text: `${message.role.toUpperCase()}:` },
          ...message.content,
          ...(message.historicalToolCalls || message.historicalToolId
            ? [{ type: "text", text: describe({ ...message, text: "" }) }]
            : []),
        ]
      : [{ type: "text", text: describe(message) }],
  );
}

export function planTurn(request, previous) {
  // A parked turn's process saw its prompt; it is attached to or resumed.
  const resume =
    ["complete", "parked"].includes(previous?.status) &&
    previous.conversationId &&
    previous.hashes.length < request.hashes.length &&
    previous.hashes.every((hash, i) => hash === request.hashes[i]);
  let messages = resume ? request.messages.slice(previous.hashes.length) : request.messages;
  if (resume) while (messages[0]?.role === "assistant") messages = messages.slice(1);
  const current = messages.findLastIndex((message) => message.role === "user");
  if (current < 0) throw new BridgeError("No new user turn.");
  const instructions =
    "Complete the current user task using your native Claude Code tools. Honor the client instructions below. Tool names in historical context refer to past actions; do not replay them. Use your native equivalents for caller tool descriptions.";
  if (messages.some((message) => message.content))
    return {
      conversationId: resume ? previous.conversationId : undefined,
      prompt: [
        { type: "text", text: instructions },
        ...promptMessages(messages.filter((m) => ["system", "developer"].includes(m.role))),
        { type: "text", text: "<conversation_history>" },
        ...promptMessages(
          messages.slice(0, current).filter((m) => !["system", "developer"].includes(m.role)),
        ),
        { type: "text", text: "</conversation_history>\n<current_turn>" },
        ...promptMessages(messages.slice(current)),
        { type: "text", text: "</current_turn>" },
      ],
    };
  return {
    conversationId: resume ? previous.conversationId : undefined,
    prompt: [
      instructions,
      ...messages.filter((m) => ["system", "developer"].includes(m.role)).map(describe),
      ...(current
        ? [
            `<conversation_history>\n${messages
              .slice(0, current)
              .filter((m) => !["system", "developer"].includes(m.role))
              .map(describe)
              .join("\n\n")}\n</conversation_history>`,
          ]
        : []),
      `<current_turn>\n${messages.slice(current).map(describe).join("\n\n")}\n</current_turn>`,
    ].join("\n\n"),
  };
}
