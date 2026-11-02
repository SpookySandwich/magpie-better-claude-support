import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { BridgeError, digest } from "./context.mjs";
import { acquireLease } from "./lease.mjs";

// Independent from Antigravity's store: same conversation can visit both.
// V3 records the auxiliary identity protocol. Read V1/V2 in place; when a caller acquires a
// more precise session identity, consult matching V1 history without moving or
// deleting it. Older writers must reject V3 rather than share its new semantics.
const VERSION = 3;

async function readState(stem) {
  let state;
  try {
    state = JSON.parse(await readFile(`${stem}.json`, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (state && (![1, 2, VERSION].includes(state.version) || !Array.isArray(state.hashes)))
    throw new BridgeError(
      "Unsupported native session version; preserve it and start a new conversation.",
      "native_session_version",
    );
  return state;
}

function related(state, request, requestKind, legacyMayBePrimary) {
  return (
    state &&
    request &&
    (state.version === 1 ||
      state.requestKind === requestKind ||
      (legacyMayBePrimary &&
        state.version === 2 &&
        state.requestKind === "primary" &&
        state.requestHash === request.requestHash)) &&
    (state.requestHash === request.requestHash ||
      (state.hashes.length > 0 &&
        state.hashes.length < request.hashes.length &&
        state.hashes.every((hash, i) => hash === request.hashes[i])))
  );
}

export class Sessions {
  constructor(directory) {
    this.directory = directory;
  }
  async acquire(
    identity,
    { legacyIdentity, request, requestKind, legacyMayBePrimary, waitMs, signal } = {},
  ) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const stem = join(this.directory, digest(identity));
    const lock = await acquireLease(`${stem}.lock`, { waitMs, signal });
    let releasing;
    let legacyLease;
    const release = () =>
      (releasing ??= (async () => {
        try {
          await legacyLease?.release();
        } finally {
          await lock.release();
        }
      })());
    let previous;
    try {
      previous = await readState(stem);
      if (!previous && legacyIdentity) {
        const legacyStem = join(this.directory, digest(legacyIdentity));
        const legacy = await readState(legacyStem);
        if (related(legacy, request, requestKind, legacyMayBePrimary)) {
          // A new identity must never resume a native conversation that is still
          // owned by the old identity, even if it has already saved its result.
          legacyLease = await this.acquire(legacyIdentity, { waitMs, signal });
          if (related(legacyLease.previous, request, requestKind, legacyMayBePrimary)) {
            // Retain the old lock for the entire turn, and fork on the next user
            // message. Two children must never resume one native transcript.
            previous = { ...legacyLease.previous, conversationId: null };
          }
        }
      }
    } catch (error) {
      await release();
      throw error;
    }
    return {
      previous,
      release,
      async save(state) {
        if (releasing)
          throw new BridgeError("Native session lease has been released.", "native_session_lease");
        const temporary = `${stem}.${randomUUID()}.tmp`;
        try {
          await writeFile(temporary, JSON.stringify({ ...state, version: VERSION }), {
            mode: 0o600,
          });
          await rename(temporary, `${stem}.json`);
        } catch (error) {
          await release();
          throw error;
        } finally {
          await unlink(temporary).catch(() => {});
        }
      },
    };
  }
}
