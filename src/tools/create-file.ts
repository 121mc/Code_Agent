import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { classifyFileAction, resolveWorkspacePath } from "../permissions.js";
import { recordModifiedFile, recordPreEditSnapshot, type SessionState } from "../session.js";

export async function resolveCreateTarget(root: string, path: string) {
  if (!path.trim()) throw new Error("create_file.path must not be empty.");
  const permission = classifyFileAction(root, path, "create");
  if (permission.decision === "block") throw new Error(permission.reason);
  const rootRealPath = await realpath(root);
  const relativePath = relative(root, resolveWorkspacePath(root, path));
  if (!relativePath) throw new Error("Cannot create the workspace root as a file.");
  const fullPath = join(rootRealPath, relativePath);
  await checkParents(rootRealPath, dirname(fullPath), false);
  if (await statIfPresent(fullPath)) throw new Error("File already exists; use edit_file instead.");
  return { rootRealPath, fullPath, relativePath: relativePath.replace(/\\/g, "/"), permission };
}

// Recheck after confirmation, create each parent safely, and never overwrite a file.
export async function runCreateFileTool(
  root: string,
  session: SessionState,
  args: { path: string; content: string },
  approvedFullPath: string
) {
  const target = await resolveCreateTarget(root, args.path);
  if (target.fullPath !== approvedFullPath) throw new Error("Approved file target changed before execution.");
  await checkParents(target.rootRealPath, dirname(target.fullPath), true);
  await writeFile(target.fullPath, args.content, { flag: "wx" });
  recordPreEditSnapshot(session, target.relativePath, "");
  recordModifiedFile(session, target.relativePath);
  session.filesCreated.push(target.relativePath);
  return { ok: true, output: `Created ${target.relativePath}.` };
}

async function checkParents(root: string, parent: string, create: boolean) {
  let directory = root;
  for (const part of relative(root, parent).split(sep).filter(Boolean)) {
    directory = join(directory, part);
    let info = await statIfPresent(directory);
    if (!info && create) {
      try { await mkdir(directory); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      info = await lstat(directory);
    }
    if (info && (info.isSymbolicLink() || !info.isDirectory())) {
      throw new Error("File creation requires normal workspace directories, not symlinks or junctions.");
    }
  }
}

async function statIfPresent(path: string) {
  try { return await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}
