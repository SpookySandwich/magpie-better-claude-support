import { writeFile, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export function projectionIOError(error) {
  return /^(EACCES|EBUSY|EDQUOT|EEXIST|EIO|EISDIR|EMFILE|ENAMETOOLONG|ENFILE|ENOENT|ENOSPC|ENOTDIR|ENOTEMPTY|EPERM|EROFS|ESTALE)$/.test(
    error?.code ?? "",
  );
}
export function projectionState(run, failed) {
  if (Boolean(run.projectionFailed) === failed) return;
  run.projectionFailed = failed;
  console.warn(
    failed
      ? "Workflow projection unavailable; latest status is not saved."
      : "Workflow projection recovered; latest status saved.",
  );
}
export async function cleanProjectionTemp(run) {
  if (!run.tempPath) return;
  try {
    await unlink(run.tempPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  delete run.tempPath;
}
export async function replaceProjection(run, path, bytes) {
  await cleanProjectionTemp(run);
  run.tempPath = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(run.tempPath, bytes, { flag: "wx" });
    await rename(run.tempPath, path);
  } finally {
    await cleanProjectionTemp(run);
  }
}
