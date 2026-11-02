import { randomUUID } from "node:crypto";
import { BridgeError, digest } from "./context.mjs";
import { AUXILIARY_VERSION, decodeAuxiliaryIdentity } from "./auxiliary-identity.mjs";

const KINDS = ["primary", "title", "compaction", "generate"];

export function requestIdentity(headers, context, request) {
  const oldSession =
    context?.sessionId || headers.get("x-claude-native-session") || headers.get("x-magpie-session");
  const wireSession =
    context?.sessionId ||
    headers.get("x-opencode-session") ||
    headers.get("x-opencode-session-id") ||
    headers.get("x-claude-native-session") ||
    headers.get("x-magpie-session");
  // A connected broker is authoritative. Otherwise recover the restrictive
  // metadata from Magpie's computed conversation ID after header filtering.
  const encoded = context ? null : decodeAuxiliaryIdentity(wireSession);
  const session = encoded?.session ?? wireSession;
  const kind = context
    ? context.requestKind
    : (encoded?.kind ?? headers.get("x-magpie-request-kind"));
  if (kind != null && !KINDS.includes(kind))
    throw new BridgeError("Unsupported native request kind.", "native_request_kind");
  if (
    encoded &&
    headers.has("x-magpie-request-kind") &&
    headers.get("x-magpie-request-kind") !== kind
  )
    throw new BridgeError("Conflicting native auxiliary identity.", "native_auxiliary_identity");
  const legacySession = encoded?.session ?? oldSession;
  // An absent tools array is also valid for a primary request. Only explicit
  // metadata may downgrade a direct request to an auxiliary generation.
  const auxiliary = context?.auxiliary === true || (kind != null && kind !== "primary");
  const clientSession =
    auxiliary && !context?.auxiliary
      ? `${session ?? randomUUID()}:aux:${digest({ kind, requestHash: request.requestHash })}`
      : (session ?? randomUUID());
  return {
    clientSession,
    legacySession: legacySession && legacySession !== clientSession ? legacySession : undefined,
    auxiliary,
    kind: kind ?? (auxiliary ? "generate" : "primary"),
    ...(encoded ? { auxiliaryIdentityVersion: AUXILIARY_VERSION } : {}),
  };
}
