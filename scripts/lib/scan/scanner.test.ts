import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { DuckDBInstance } from '@duckdb/node-api';
import { isAllowedEmail, scanBuffer } from './scanner.ts';

const CLI_PATH = resolve(import.meta.dirname, '../../check-staged-emails.ts');

// Construct disallowed addresses at runtime so this test file has no literal real addresses.
const makeAddr = (local: string, ...domainLabels: string[]): string =>
  `${local}@${domainLabels.join('.')}`;

function initTempGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'email-scan-repo-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir });
  return dir;
}

function runCli(args: string[], cwd: string): { status: number | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd,
    encoding: 'utf8',
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('isAllowedEmail (R7 allow rules)', () => {
  it('allows example domains, typo test variants, RFC 2606 TLDs, localhost, and masked forms', () => {
    for (const ok of [
      'taro@example.com',
      'taro@example.jp',
      'taro@example.net',
      'taro@example.org',
      'taro@example.con',
      'taro@example.co.jo',
      'taro@example.ne.jo',
      'taro@mail.example.com',
      'taro@foo.example',
      'taro@foo.test',
      'u1234567890abcdef@d12345678.invalid',
      'admin@localhost',
      't***@g***l.com',
    ]) {
      assert.equal(isAllowedEmail(ok), true, `expected allowed: ${ok}`);
    }
  });

  it('rejects real domains and deceptive example-* lookalikes', () => {
    for (const bad of [
      makeAddr('taro', 'gmail', 'com'),
      makeAddr('a', 'gmial', 'com'),
      makeAddr('taro', 'docomo', 'ne', 'jp'),
      makeAddr('taro', 'example', 'gmail', 'com'),
      makeAddr('taro', 'example', 'com', 'evil', 'org'),
      makeAddr('taro', 'notexample', 'com'),
    ]) {
      assert.equal(isAllowedEmail(bad), false, `expected disallowed: ${bad}`);
    }
  });
});

describe('scanBuffer encoding and binary formats', () => {
  it('scans cp932 without false positives on 0x40 trail bytes and catches disallowed addresses', () => {
    const disallowed = makeAddr('taro', 'realcorp', 'jp');
    // CP932 bytes: '氏名' (8E 81 96 BC) + ',' + 'メールアドレス' + '\n' + '山田　太郎' (with 81 40 fullwidth space!) + ',' + disallowed
    const cp932Buf = Buffer.concat([
      Buffer.from([0x8e, 0x81, 0x96, 0xbc]), // 氏名
      Buffer.from(',email\n', 'ascii'),
      Buffer.from([0x8e, 0x52, 0x93, 0x63, 0x81, 0x40, 0x91, 0xbe, 0x98, 0x59]), // 山田　太郎 (contains 0x40 trail byte)
      Buffer.from(`,${disallowed}\n`, 'ascii'),
    ]);

    const findings = scanBuffer(cp932Buf, 'members.csv');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.line, 2);
    assert.equal(findings[0]?.masked, 't***@r***p.jp');
    assert.ok(!findings[0]?.masked.includes(disallowed));
  });

  it('scans UTF-16LE with BOM', () => {
    const disallowed = makeAddr('hanako', 'realmail', 'net');
    const bom = Buffer.from([0xff, 0xfe]);
    const body = Buffer.from(`name\temail\n花子\t${disallowed}\n`, 'utf16le');
    const findings = scanBuffer(Buffer.concat([bom, body]), 'unicode.txt');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.line, 2);
    assert.equal(findings[0]?.masked, 'h***@r***l.net');
  });

  it('scans full-width addresses after NFKC', () => {
    const fullwidth = ['ｔａｒｏ', 'ｒｅａｌｍａｉｌ．ｃｏｍ'].join('＠');
    const findings = scanBuffer(Buffer.from(`${fullwidth}\n`, 'utf8'), 'notes.txt');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.masked, 't***@r***l.com');
  });

  it('scans arbitrary binary files for ASCII runs', () => {
    const disallowed = makeAddr('ops', 'realvendor', 'io');
    const bin = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x00]),
      Buffer.from(disallowed, 'ascii'),
      Buffer.from([0x00, 0x00, 0x89, 0x50]),
    ]);
    const findings = scanBuffer(bin, 'blob.bin');
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.masked, 'o***@r***r.io');
  });
});

describe('check-staged-emails CLI in temporary git repositories', () => {
  it('exits 0 for allowed example domains and masked forms', () => {
    const repo = initTempGitRepo();
    try {
      writeFileSync(
        join(repo, 'allowed.txt'),
        [
          'taro@example.com',
          'hanako@example.jp',
          'ops@example.net',
          'team@example.org',
          'typo1@example.con',
          'typo2@example.co.jo',
          'sub@foo.example',
          'qa@bar.test',
          'u0123456789abcdef@d01234567.invalid',
          'root@localhost',
          't***@g***l.com',
        ].join('\n'),
        'utf8',
      );
      execFileSync('git', ['add', 'allowed.txt'], { cwd: repo });

      const res = runCli([], repo);
      assert.equal(res.status, 0);
      assert.equal(res.stdout, '');

      const jsonRes = runCli(['--json'], repo);
      assert.equal(jsonRes.status, 0);
      const parsed = JSON.parse(jsonRes.stdout) as { ok: boolean; findings: unknown[] };
      assert.equal(parsed.ok, true);
      assert.equal(parsed.findings.length, 0);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('exits 1 for a staged disallowed address, masks output, and ignores unstaged edits', () => {
    const repo = initTempGitRepo();
    const disallowed = makeAddr('alice', 'realcompany', 'com');
    try {
      const target = join(repo, 'notes.md');
      // Stage clean content first
      writeFileSync(target, 'Contact: alice@example.com\n', 'utf8');
      execFileSync('git', ['add', 'notes.md'], { cwd: repo });

      // Write disallowed address ONLY to working tree (unstaged)
      writeFileSync(target, `Line 1 ok\nContact: ${disallowed}\n`, 'utf8');
      const stagedClean = runCli([], repo);
      assert.equal(stagedClean.status, 0, 'unstaged edits must not trigger staged scan');

      // Now stage the disallowed content
      execFileSync('git', ['add', 'notes.md'], { cwd: repo });
      const stagedDirty = runCli([], repo);
      assert.equal(stagedDirty.status, 1);
      assert.equal(stagedDirty.stdout.trim(), 'notes.md:2: a***@r***y.com');
      assert.ok(!stagedDirty.stdout.includes(disallowed), 'raw email must never be printed');

      // --json also masks and exits 1
      const jsonDirty = runCli(['--json'], repo);
      assert.equal(jsonDirty.status, 1);
      assert.ok(!jsonDirty.stdout.includes(disallowed));
      const parsed = JSON.parse(jsonDirty.stdout) as {
        ok: boolean;
        mode: string;
        findings: Array<{ file: string; line: number; masked: string }>;
      };
      assert.equal(parsed.ok, false);
      assert.equal(parsed.mode, 'staged');
      assert.deepEqual(parsed.findings, [
        { file: 'notes.md', line: 2, masked: 'a***@r***y.com' },
      ]);

      // Commit and verify --all detects tracked file
      execFileSync('git', ['commit', '-q', '-m', 'add notes'], { cwd: repo });
      const stagedAfterCommit = runCli([], repo);
      assert.equal(stagedAfterCommit.status, 0);

      const allAfterCommit = runCli(['--all'], repo);
      assert.equal(allAfterCommit.status, 1);
      assert.equal(allAfterCommit.stdout.trim(), 'notes.md:2: a***@r***y.com');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('skips lines containing email-scan:allow while flagging other lines', () => {
    const repo = initTempGitRepo();
    const typoAddr = makeAddr('a', 'gmial', 'com');
    const leakedAddr = makeAddr('bob', 'realorg', 'org');
    try {
      const file = join(repo, 'typo.test.ts');
      writeFileSync(
        file,
        `const allowed = '${typoAddr}'; // email-scan:allow\n`,
        'utf8',
      );
      execFileSync('git', ['add', 'typo.test.ts'], { cwd: repo });
      assert.equal(runCli([], repo).status, 0);

      writeFileSync(
        file,
        `const allowed = '${typoAddr}'; // email-scan:allow\nconst oops = '${leakedAddr}';\n`,
        'utf8',
      );
      execFileSync('git', ['add', 'typo.test.ts'], { cwd: repo });
      const res = runCli([], repo);
      assert.equal(res.status, 1);
      assert.equal(res.stdout.trim(), 'typo.test.ts:2: b***@r***g.org');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('catches disallowed emails in staged cp932 and UTF-16LE files', () => {
    const repo = initTempGitRepo();
    const cp932Addr = makeAddr('suzuki', 'company-jp', 'co', 'jp');
    const utf16Addr = makeAddr('tanaka', 'acme-corp', 'net');
    try {
      const cp932Buf = Buffer.concat([
        Buffer.from([0x8e, 0x81, 0x96, 0xbc]), // 氏名
        Buffer.from(',email\n', 'ascii'),
        Buffer.from([0x97, 0xeb, 0x96, 0xd8]), // 鈴木
        Buffer.from(`,${cp932Addr}\n`, 'ascii'),
      ]);
      writeFileSync(join(repo, 'cp932.csv'), cp932Buf);

      const utf16Buf = Buffer.concat([
        Buffer.from([0xff, 0xfe]),
        Buffer.from(`氏名\temail\n田中\t${utf16Addr}\n`, 'utf16le'),
      ]);
      writeFileSync(join(repo, 'utf16.txt'), utf16Buf);

      execFileSync('git', ['add', 'cp932.csv', 'utf16.txt'], { cwd: repo });

      const res = runCli([], repo);
      assert.equal(res.status, 1);
      assert.ok(!res.stdout.includes(cp932Addr));
      assert.ok(!res.stdout.includes(utf16Addr));
      const lines = res.stdout.trim().split('\n');
      assert.deepEqual(lines, [
        'cp932.csv:2: s***@c***p.co.jp',
        'utf16.txt:2: t***@a***p.net',
      ]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('scans staged .xlsx files created via DuckDB', async () => {
    const repo = initTempGitRepo();
    const disallowed = makeAddr('kenji', 'realdomain', 'com');
    const okPath = join(repo, 'clean.xlsx');
    const badPath = join(repo, 'leaked.xlsx');

    try {
      const db = await DuckDBInstance.create(':memory:');
      const conn = await db.connect();
      await conn.run('INSTALL excel; LOAD excel;');
      await conn.run(
        `COPY (SELECT 'kenji@example.com' AS email) TO '${okPath.replaceAll("'", "''")}' (FORMAT xlsx);`,
      );
      await conn.run(
        `COPY (SELECT '${disallowed}' AS email) TO '${badPath.replaceAll("'", "''")}' (FORMAT xlsx);`,
      );
      conn.closeSync();
      db.closeSync();

      execFileSync('git', ['add', 'clean.xlsx'], { cwd: repo });
      const cleanRes = runCli([], repo);
      assert.equal(cleanRes.status, 0);
      assert.equal(cleanRes.stdout, '');

      execFileSync('git', ['add', 'leaked.xlsx'], { cwd: repo });
      const dirtyRes = runCli([], repo);
      assert.equal(dirtyRes.status, 1);
      assert.ok(!dirtyRes.stdout.includes(disallowed));
      assert.match(dirtyRes.stdout.trim(), /^leaked\.xlsx:\d+: k\*\*\*@r\*\*\*n\.com$/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('scans staged SQLite databases accurately even with adjacent TEXT columns', async () => {
    const repo = initTempGitRepo();
    const disallowed = makeAddr('sato', 'realorg', 'jp');
    const cleanDb = join(repo, 'clean.db');
    const dirtyDb = join(repo, 'dirty.db');

    try {
      const { DatabaseSync } = await import('node:sqlite');

      const d1 = new DatabaseSync(cleanDb);
      d1.exec('CREATE TABLE contacts (email TEXT, created_at TEXT, name TEXT);');
      d1.prepare('INSERT INTO contacts VALUES (?, ?, ?)').run(
        'sato@example.com',
        '2025-01-01',
        'Alice',
      );
      d1.close();

      execFileSync('git', ['add', 'clean.db'], { cwd: repo });
      assert.equal(runCli([], repo).status, 0);

      const d2 = new DatabaseSync(dirtyDb);
      d2.exec('CREATE TABLE contacts (email TEXT, created_at TEXT, name TEXT);');
      d2.prepare('INSERT INTO contacts VALUES (?, ?, ?)').run(
        disallowed,
        '2025-01-01',
        'Alice',
      );
      d2.close();

      execFileSync('git', ['add', 'dirty.db'], { cwd: repo });
      const res = runCli([], repo);
      assert.equal(res.status, 1);
      assert.ok(!res.stdout.includes(disallowed));
      assert.equal(res.stdout.trim(), 'dirty.db:1: s***@r***g.jp');
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('exits 2 when invoked outside a git repository', () => {
    const nonRepo = mkdtempSync(join(tmpdir(), 'email-scan-nogit-'));
    try {
      const res = runCli([], nonRepo);
      assert.equal(res.status, 2);
      assert.ok(res.stderr.length > 0);
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
