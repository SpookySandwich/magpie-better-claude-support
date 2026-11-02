import { BridgeError } from "./context.mjs";

// Mirrored by the external OpenCode magpie-session-identity hook. This namespace
// can only restrict a request. It must never supply a permission or broker context.
export const AUXILIARY_PREFIX = "magpie-aux:";
export const AUXILIARY_VERSION = 1;
export const AUXILIARY_KINDS = ["title", "compaction", "generate"];
const SESSION = /^[A-Za-z0-9_-]{1,64}$/;

export function decodeAuxiliaryIdentity(value) {
  if (!value?.startsWith(AUXILIARY_PREFIX)) return null;
  const [, version, kind, session, ...extra] = value.split(":");
  if (
    version !== `v${AUXILIARY_VERSION}` ||
    !AUXILIARY_KINDS.includes(kind) ||
    !SESSION.test(session ?? "") ||
    extra.length
  )
    throw new BridgeError("Unsupported native auxiliary identity.", "native_auxiliary_identity");
  return { kind, session };
}
