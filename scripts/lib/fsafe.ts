// Safe writes into the workspace (D32). Every write of a file that may already exist goes through
// writeFileInWorkspace: a new temp file (`wx`) in the same directory is renamed over the target, so a
// symlink sitting at the target path is replaced, never followed (a symlink to a tracked file in a
// checkout would otherwise get its content overwritten).

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface WriteInWorkspaceOpts {
  /** The workspace directory; `dir` must resolve (realpath) inside its realpath. */
  workspace: string;
  /** File mode of the new file. Default 0o600. */
  mode?: number;
}

/** realpath of the deepest existing ancestor + the not-yet-existing rest. */
function realpathLoose(p: string): string {
  const rest: string[] = [];
  let cur = path.resolve(p);
  for (;;) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === '') return true;
  return rel.split(path.sep)[0] !== '..' && !path.isAbsolute(rel);
}

/**
 * Write `<dir>/<name>` atomically and without following a symlink at the target. `dir` is resolved with
 * realpath and must lie inside the workspace's realpath (a missing `dir` is created, after that check).
 * `name` must be a plain file name. Returns `<dir>/<name>` as given. Nothing is written when refused.
 */
export function writeFileInWorkspace(
  dir: string, name: string, content: string | Uint8Array, opts: WriteInWorkspaceOpts,
): string {
  if (name !== path.basename(name) || name === '' || name === '.' || name === '..' || name.includes('\0')) {
    throw new Error(`invalid file name: ${name}`);
  }
  const realWs = fs.realpathSync(opts.workspace);
  const realDir = realpathLoose(dir);
  if (!isInside(realDir, realWs)) {
    throw new Error(`refusing to write ${name}: ${dir} resolves to ${realDir}, which is outside the workspace ${realWs}`);
  }
  // R6-1: a symlinked directory inside the workspace (e.g. output/reports -> overrides) stays inside the
  // workspace but sends the file somewhere else. The directory must resolve to the path it names.
  const logical = path.resolve(dir);
  const wsLogical = path.resolve(opts.workspace);
  const rel = isInside(logical, wsLogical) ? path.relative(wsLogical, logical) : path.relative(realWs, logical);
  if (path.join(realWs, rel) !== realDir) {
    throw new Error(`refusing to write ${name}: ${dir} is redirected by a symlink inside the workspace (resolves to ${realDir}); restore the normal workspace layout`);
  }
  fs.mkdirSync(realDir, { recursive: true });
  const finalDir = fs.realpathSync(realDir);
  if (!isInside(finalDir, realWs)) {
    throw new Error(`refusing to write ${name}: ${dir} resolves to ${finalDir}, which is outside the workspace ${realWs}`);
  }

  const tmp = path.join(finalDir, `.${name}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.writeFileSync(tmp, content, { flag: 'wx', mode: opts.mode ?? 0o600 });
  try {
    fs.renameSync(tmp, path.join(finalDir, name));
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return path.join(dir, name);
}
