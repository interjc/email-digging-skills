// Exclusive workspace lock (D26). Mutating commands run inside withWorkspaceLock so two of them can
// never write the same workspace at once. The lock is `<ws>/.lock`, created with O_EXCL ('wx') and
// holding the owner's pid, command and start time. A lock whose process is gone is reported as stale
// and must be removed by the human: the pipeline never decides that for them.

import fs from 'node:fs';
import path from 'node:path';
import { PreconditionError } from './errors.ts';

export interface LockInfo {
  pid: number;
  command: string;
  started_at: string;
}

export function lockPath(workspace: string): string {
  return path.join(workspace, '.lock');
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readLock(file: string): LockInfo | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LockInfo>;
    if (typeof parsed.pid === 'number' && typeof parsed.command === 'string' && typeof parsed.started_at === 'string') {
      return parsed as LockInfo;
    }
  } catch {
    // unreadable or half-written
  }
  return null;
}

function busyError(file: string, info: LockInfo | null): PreconditionError {
  if (info === null) {
    return new PreconditionError(
      `The workspace is locked (${file}) but the lock file is unreadable.`,
      `if no pipeline command is running, delete ${file} and run again.`,
    );
  }
  const who = `"${info.command}" (pid ${info.pid}, started ${info.started_at})`;
  return pidAlive(info.pid)
    ? new PreconditionError(`The workspace is in use by ${who}.`, 'wait for it to finish, then run again.')
    : new PreconditionError(
        `The workspace lock is stale: ${who} is no longer running.`,
        `check that the workspace is intact, then delete ${file} and run again.`,
      );
}

/**
 * Run `fn` while holding the exclusive lock of `workspace`. Creates the workspace directory when
 * missing. Throws PreconditionError (exit 2) when another command holds the lock or a stale lock exists.
 * The lock is released when `fn` settles, and (best effort) when the process exits.
 */
export async function withWorkspaceLock<T>(workspace: string, command: string, fn: () => T | Promise<T>): Promise<T> {
  fs.mkdirSync(workspace, { recursive: true });
  const file = lockPath(workspace);
  const info: LockInfo = { pid: process.pid, command, started_at: new Date().toISOString() };
  const body = `${JSON.stringify(info)}\n`;

  let fd: number;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw busyError(file, readLock(file));
    throw err;
  }
  try {
    fs.writeSync(fd, body);
  } finally {
    fs.closeSync(fd);
  }

  const release = (): void => {
    // Remove only our own lock.
    const current = readLock(file);
    if (current && current.pid === info.pid && current.started_at === info.started_at && current.command === command) {
      fs.rmSync(file, { force: true });
    }
  };
  process.once('exit', release);
  try {
    return await fn();
  } finally {
    process.removeListener('exit', release);
    release();
  }
}
