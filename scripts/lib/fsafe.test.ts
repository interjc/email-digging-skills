import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileInWorkspace } from './fsafe.ts';

const tmp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fsafe-test-')));

function workspace(): { base: string; ws: string; dir: string } {
  const base = tmp();
  const ws = path.join(base, 'ws');
  const dir = path.join(ws, 'resources', 'shop');
  fs.mkdirSync(dir, { recursive: true });
  return { base, ws, dir };
}

test('writes a new file with mode 0600 (default) or the given mode, leaving no temp file', () => {
  const { ws, dir } = workspace();
  assert.equal(writeFileInWorkspace(dir, 'a.md', 'hello\n', { workspace: ws }), path.join(dir, 'a.md'));
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'hello\n');
  assert.equal(fs.statSync(path.join(dir, 'a.md')).mode & 0o777, 0o600);
  writeFileInWorkspace(dir, 'b.md', 'x', { workspace: ws, mode: 0o644 });
  assert.equal(fs.statSync(path.join(dir, 'b.md')).mode & 0o777, 0o644);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a.md', 'b.md']);
});

test('replaces an existing file atomically', () => {
  const { ws, dir } = workspace();
  fs.writeFileSync(path.join(dir, 'a.md'), 'old');
  writeFileInWorkspace(dir, 'a.md', 'new', { workspace: ws });
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'new');
});

test('a symlink at the target is replaced, never followed: the tracked file it pointed to is unchanged', () => {
  const { base, ws, dir } = workspace();
  // a checkout with a tracked file, and the draft path symlinked to it
  const checkout = path.join(base, 'checkout');
  fs.mkdirSync(checkout);
  execFileSync('git', ['init', '-q'], { cwd: checkout });
  fs.writeFileSync(path.join(checkout, 'tracked.txt'), 'tracked content\n');
  execFileSync('git', ['add', 'tracked.txt'], { cwd: checkout });
  fs.symlinkSync(path.join(checkout, 'tracked.txt'), path.join(dir, 'meta.draft.md'));

  writeFileInWorkspace(dir, 'meta.draft.md', 'draft\n', { workspace: ws });

  assert.equal(fs.readFileSync(path.join(checkout, 'tracked.txt'), 'utf8'), 'tracked content\n');
  assert.equal(fs.lstatSync(path.join(dir, 'meta.draft.md')).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(path.join(dir, 'meta.draft.md'), 'utf8'), 'draft\n');
  assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: checkout, encoding: 'utf8' }).includes('tracked.txt'), true, 'still just staged-new, unmodified');
  assert.equal(execFileSync('git', ['diff', '--stat'], { cwd: checkout, encoding: 'utf8' }), '');
});

test('a dangling symlink at the target is replaced too', () => {
  const { base, ws, dir } = workspace();
  fs.symlinkSync(path.join(base, 'nowhere'), path.join(dir, 'a.md'));
  writeFileInWorkspace(dir, 'a.md', 'x', { workspace: ws });
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'x');
  assert.ok(!fs.existsSync(path.join(base, 'nowhere')));
});

test('a directory that resolves outside the workspace is refused and nothing is written', () => {
  const { base, ws } = workspace();
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(elsewhere, path.join(ws, 'output'));
  assert.throws(() => writeFileInWorkspace(path.join(ws, 'output'), 'a.md', 'x', { workspace: ws }), /outside the workspace/);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
  // a sibling whose name merely starts with the workspace name is outside too
  const sibling = path.join(base, 'ws-other');
  fs.mkdirSync(sibling);
  assert.throws(() => writeFileInWorkspace(sibling, 'a.md', 'x', { workspace: ws }), /outside the workspace/);
  assert.deepEqual(fs.readdirSync(sibling), []);
});

test('a directory named "..private" inside the workspace is inside, not outside', () => {
  const { ws } = workspace();
  const dir = path.join(ws, '..private');
  fs.mkdirSync(dir);
  writeFileInWorkspace(dir, 'a.md', 'x', { workspace: ws });
  assert.equal(fs.readFileSync(path.join(dir, 'a.md'), 'utf8'), 'x');
});

test('a missing directory inside the workspace is created; a missing one outside is not', () => {
  const { base, ws } = workspace();
  writeFileInWorkspace(path.join(ws, 'output', 'reports'), 'r.md', 'x', { workspace: ws });
  assert.ok(fs.existsSync(path.join(ws, 'output', 'reports', 'r.md')));
  assert.throws(() => writeFileInWorkspace(path.join(base, 'new-dir'), 'r.md', 'x', { workspace: ws }), /outside the workspace/);
  assert.ok(!fs.existsSync(path.join(base, 'new-dir')));
});

test('invalid file names are refused', () => {
  const { ws, dir } = workspace();
  for (const name of ['../x', 'a/b', '', '.', '..', 'a\0b']) {
    assert.throws(() => writeFileInWorkspace(dir, name, 'x', { workspace: ws }), /invalid file name/, JSON.stringify(name));
  }
});

test('a failed rename removes the temp file (target is a directory)', () => {
  const { ws, dir } = workspace();
  fs.mkdirSync(path.join(dir, 'a.md'));
  assert.throws(() => writeFileInWorkspace(dir, 'a.md', 'x', { workspace: ws }));
  assert.deepEqual(fs.readdirSync(dir), ['a.md']);
});
