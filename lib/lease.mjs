import { link, open, readFile, realpath, unlink } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { BridgeError, digest } from "./context.mjs";

// Lock format is independent of session V3. Keep pid for old readers; they do
// not honor the kernel guard, so drain old hosts before deploying this writer.
const VERSION = 1;
const POLL_MS = 250;
const busy = () => new BridgeError("Native conversation is busy.", "native_session_busy");
const review = (path, reason, code = "native_session_lock_invalid") =>
  new BridgeError(
    `${reason} Preserve ${path}. Start a new conversation, or stop all hosts using this state directory and inspect the lock before manual recovery.`,
    code,
  );

async function ownerAt(path) {
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    throw review(path, "Native session lock is malformed; its owner cannot be established.");
  }
  if (!owner || typeof owner !== "object" || Array.isArray(owner))
    throw review(path, "Native session lock has no valid owner.");
  if (Object.hasOwn(owner, "version") && owner.version !== VERSION)
    throw review(path, "Unsupported native session lock version.", "native_session_lock_version");
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || owner.pid > 0x7fffffff)
    throw review(path, "Native session lock has no valid owner PID.");
  if (
    owner.version === VERSION &&
    (typeof owner.nonce !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(owner.nonce))
  )
    throw review(path, "Native session lock has no valid owner nonce.");
  // Legacy is exactly the old {pid} shape, not an unknown unversioned format.
  if (!Object.hasOwn(owner, "version") && Object.keys(owner).some((key) => key !== "pid"))
    throw review(path, "Unrecognized legacy native session lock metadata.");
  return owner;
}

async function guard(path) {
  const directory = await realpath(dirname(path));
  const key = digest(`${directory}/${basename(path)}`.replaceAll("\\", "/").toLowerCase());
  // Windows named pipes and Linux abstract sockets disappear on process exit.
  // A filesystem sentinel for this guard would need the same unsafe reclamation
  // we are guarding. Unsupported platforms fail closed instead of falling back.
  const address =
    process.platform === "win32"
      ? `\\\\.\\pipe\\magpie-native-lease-${key}`
      : process.platform === "linux"
        ? `\0magpie-native-lease-${key}`
        : undefined;
  if (!address)
    throw review(
      path,
      "This platform has no supported native lease guard.",
      "native_session_lock_platform",
    );
  const server = createServer((socket) => socket.destroy());
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(address, resolve);
    });
  } catch (error) {
    if (error.code === "EADDRINUSE") throw busy();
    throw review(
      path,
      `Cannot acquire native lease guard (${error.code ?? "unknown"}).`,
      "native_session_lock_guard",
    );
  }
  let closing;
  return () =>
    (closing ??= new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    }));
}

// A canceled turn keeps its lease until Claude Code exits and its events
// drain, so a follow-up sent right after Stop or a steer can find it held.
// Wait a bounded time for that release; only the busy outcome is retried.
export async function acquireLease(path, { waitMs = 0, signal } = {}) {
  const deadline = Date.now() + waitMs;
  for (;;) {
    signal?.throwIfAborted();
    try {
      return await claim(path);
    } catch (error) {
      if (error.code !== "native_session_busy" || Date.now() >= deadline) throw error;
    }
    await delay(Math.min(POLL_MS, Math.max(0, deadline - Date.now())), undefined, { signal });
  }
}

async function claim(path) {
  // Hold the kernel guard for the entire lease, including inspection, dead-PID
  // removal and release. Two reclaimers cannot observe/delete across generations.
  const unguard = await guard(path);
  const owner = { version: VERSION, pid: process.pid, nonce: randomUUID() };
  const temporary = `${path}.${owner.nonce}.tmp`;
  let published = false;
  try {
    const previous = await ownerAt(path);
    if (previous) {
      try {
        process.kill(previous.pid, 0);
        throw busy();
      } catch (error) {
        if (error.code === "native_session_busy") throw error;
        if (error.code !== "ESRCH")
          throw review(
            path,
            "Native session lock owner liveness is unknown.",
            "native_session_lock_owner_unknown",
          );
      }
      await unlink(path);
    }
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(owner));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      // Same-directory hard link: atomically exposes complete bytes, EEXIST on
      // contention. Never rename over an owner and never fall back to open(wx).
      await link(temporary, path);
      published = true;
    } catch (error) {
      if (error.code === "EEXIST") throw busy();
      throw review(
        path,
        `Atomic native lease publication failed (${error.code ?? "unknown"}); a filesystem supporting hard links is required.`,
        "native_session_lock_publish",
      );
    }
  } finally {
    await unlink(temporary).catch(() => {});
    if (!published) await unguard();
  }
  let releasing;
  return {
    release() {
      return (releasing ??= (async () => {
        try {
          const current = await ownerAt(path);
          if (
            current?.version === VERSION &&
            current.pid === owner.pid &&
            current.nonce === owner.nonce
          )
            await unlink(path);
        } finally {
          await unguard();
        }
      })());
    },
  };
}
