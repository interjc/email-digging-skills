import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { lockPath, withWorkspaceLock } from './lock.ts';
import { PreconditionError } from './errors.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'lock-test-')));

test('the lock exists while fn runs (pid, command, start time) and is removed afterwards', async () => {
  const ws = tmp();
  const result = await withWorkspaceLock(ws, 'init-workspace', async () => {
    const info = JSON.parse(fs.readFileSync(lockPath(ws), 'utf8'));
    assert.equal(info.pid, process.pid);
    assert.equal(info.command, 'init-workspace');
    assert.ok(!Number.isNaN(Date.parse(info.started_at)));
    return 42;
  });
  assert.equal(result, 42);
  assert.ok(!fs.existsSync(lockPath(ws)));
});

test('creates a missing workspace directory', async () => {
  const ws = path.join(tmp(), 'new', 'ws');
  await withWorkspaceLock(ws, 'x', () => undefined);
  assert.ok(fs.statSync(ws).isDirectory());
});

test('released when fn throws, and the error propagates', async () => {
  const ws = tmp();
  await assert.rejects(() => withWorkspaceLock(ws, 'x', () => { throw new Error('boom'); }), /boom/);
  assert.ok(!fs.existsSync(lockPath(ws)));
  await withWorkspaceLock(ws, 'x', () => undefined); // usable again
});

test('a second command is refused while the first runs (exit-2 PreconditionError naming the owner)', async () => {
  const ws = tmp();
  await withWorkspaceLock(ws, 'clean-and-merge', async () => {
    await assert.rejects(
      () => withWorkspaceLock(ws, 'add-source', () => undefined),
      (err: unknown) => err instanceof PreconditionError && /in use by "clean-and-merge"/.test(err.message) && /pid \d+/.test(err.message),
    );
    // the failed attempt did not remove the first command's lock
    assert.ok(fs.existsSync(lockPath(ws)));
  });
  assert.ok(!fs.existsSync(lockPath(ws)));
});

test('concurrent attempts: exactly one wins', async () => {
  const ws = tmp();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const first = withWorkspaceLock(ws, 'a', () => gate);
  const results = await Promise.allSettled([1, 2, 3].map((n) => withWorkspaceLock(ws, `b${n}`, () => undefined)));
  assert.ok(results.every((r) => r.status === 'rejected'));
  release();
  await first;
});

test('a stale lock (owner pid gone) is reported, never removed automatically', async () => {
  const ws = tmp();
  // A pid that is certainly dead: a child that already exited.
  const dead = spawnSync(process.execPath, ['-e', '0']).pid as number;
  fs.writeFileSync(lockPath(ws), `${JSON.stringify({ pid: dead, command: 'old-run', started_at: '2026-01-01T00:00:00.000Z' })}\n`);
  await assert.rejects(
    () => withWorkspaceLock(ws, 'init-workspace', () => undefined),
    (err: unknown) => err instanceof PreconditionError && /stale/.test(err.message) && /old-run/.test(err.message) && /delete .*\.lock/.test(err.fix ?? ''),
  );
  assert.ok(fs.existsSync(lockPath(ws)), 'the stale lock is left for the human');
});

test('an unreadable lock file is treated as held', async () => {
  const ws = tmp();
  fs.writeFileSync(lockPath(ws), '');
  await assert.rejects(() => withWorkspaceLock(ws, 'x', () => undefined), /unreadable/);
});

test('real parallel processes: only one holds the lock', () => {
  const ws = tmp();
  const script = `
    import { withWorkspaceLock } from ${JSON.stringify(path.join(import.meta.dirname, 'lock.ts'))};
    try { await withWorkspaceLock(process.argv[1], 'p', () => new Promise((r) => setTimeout(r, 600))); console.log('won'); }
    catch (e) { console.log('refused'); }
  `;
  const kids = [0, 1, 2].map(() => spawn(process.execPath, ['--input-type=module', '-e', script, ws], { stdio: ['ignore', 'pipe', 'inherit'] }));
  return Promise.all(kids.map((k) => new Promise<string>((res) => {
    let out = '';
    k.stdout.on('data', (d: Buffer) => { out += d; });
    k.on('close', () => res(out.trim()));
  }))).then((outs) => {
    assert.equal(outs.filter((o) => o === 'won').length, 1, outs.join(','));
    assert.equal(outs.filter((o) => o === 'refused').length, 2, outs.join(','));
    assert.ok(!fs.existsSync(lockPath(ws)));
  });
});

// --- round 2 (review R2) ---------------------------------------------------------------------------

test('busy and stale errors mask address-like text read from the lock file', async () => {
  const ws = tmp();
  fs.writeFileSync(lockPath(ws), JSON.stringify({ pid: process.pid, command: 'run for leak@example.com', started_at: '2026-01-01T00:00:00.000Z' }));
  await assert.rejects(() => withWorkspaceLock(ws, 'x', () => undefined), (err: unknown) => {
    const e = err as PreconditionError;
    return /in use by/.test(e.message) && !e.message.includes('leak@') && !(e.fix ?? '').includes('leak@');
  });
  const dead = spawnSync(process.execPath, ['-e', '0']).pid as number;
  fs.writeFileSync(lockPath(ws), JSON.stringify({ pid: dead, command: 'leak﹫example.com', started_at: '2026-01-01T00:00:00.000Z' }));
  await assert.rejects(() => withWorkspaceLock(ws, 'x', () => undefined), (err: unknown) => /stale/.test((err as Error).message) && !(err as Error).message.includes('leak'));
});

test('the lock body is written by the same exclusive create; a failed write after creation removes the file', async () => {
  const ws = tmp();
  const realWrite = fs.writeFileSync;
  const calls: Array<{ flag: unknown }> = [];
  // Simulate a disk-full failure after the file was created.
  (fs as { writeFileSync: unknown }).writeFileSync = (file: fs.PathOrFileDescriptor, data: unknown, options?: { flag?: string; mode?: number }) => {
    if (String(file) === lockPath(ws)) {
      calls.push({ flag: options?.flag });
      realWrite(file, '', options as fs.WriteFileOptions); // the exclusive create succeeded, the content did not land
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC', syscall: 'write' });
    }
    return realWrite(file, data as string, options as fs.WriteFileOptions);
  };
  try {
    await assert.rejects(() => withWorkspaceLock(ws, 'x', () => undefined), /ENOSPC/);
  } finally {
    (fs as { writeFileSync: unknown }).writeFileSync = realWrite;
  }
  assert.deepEqual(calls, [{ flag: 'wx' }], 'one exclusive create, no separate open/write');
  assert.ok(!fs.existsSync(lockPath(ws)), 'no empty lock left behind');
  await withWorkspaceLock(ws, 'x', () => undefined); // not blocked by a leftover
});

test('a failure to open the lock (not a failure after creation) never deletes an existing file', async () => {
  const ws = tmp();
  fs.writeFileSync(lockPath(ws), 'someone else');
  const realWrite = fs.writeFileSync;
  (fs as { writeFileSync: unknown }).writeFileSync = (file: fs.PathOrFileDescriptor, data: unknown, options?: unknown) => {
    if (String(file) === lockPath(ws)) throw Object.assign(new Error('EACCES: permission denied, open'), { code: 'EACCES', syscall: 'open' });
    return realWrite(file, data as string, options as fs.WriteFileOptions);
  };
  try {
    await assert.rejects(() => withWorkspaceLock(ws, 'x', () => undefined), /EACCES/);
  } finally {
    (fs as { writeFileSync: unknown }).writeFileSync = realWrite;
  }
  assert.equal(fs.readFileSync(lockPath(ws), 'utf8'), 'someone else');
});
