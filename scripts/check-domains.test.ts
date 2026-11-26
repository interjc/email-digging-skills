import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { MxRecord } from 'node:dns';
import { parse as parseYaml } from 'yaml';
import {
  buildMaskedJson,
  checkDomains,
  DOMAIN_CHECK_FILE,
  renderDomainCheckSummary,
} from './check-domains.ts';
import type { AmbiguousTypoEntry, ObviousTypoEntry } from './check-domains.ts';
import type { DnsResolver } from './lib/email/dns-check.ts';
import { openDb, migrate } from './lib/db.ts';
import { loadOverrides } from './lib/overrides.ts';
import { layoutDirs, workspaceLayout } from './lib/paths.ts';
import type { WorkspaceLayout } from './lib/paths.ts';

const repo = path.resolve(import.meta.dirname, '..');

function setupEmptyWorkspace(): { ws: string; layout: WorkspaceLayout; root: string } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 't12-cd-'));
  const ws = path.join(base, 'ws');
  const root = path.join(base, 'repo');
  fs.mkdirSync(root);
  const layout = workspaceLayout(ws);
  for (const d of layoutDirs(layout)) fs.mkdirSync(d, { recursive: true });
  const db = openDb(layout.dbPath);
  migrate(db, path.join(repo, 'schema', 'migrations'));
  db.close();
  return { ws, layout, root };
}

function seedContacts(
  dbPath: string,
  rows: Array<{
    email: string;
    domain: string;
    status: 'valid' | 'role' | 'typo_suspect';
    suggested: string | null;
    orphanedAt?: string | null;
    source?: string;
  }>,
): void {
  const db = openDb(dbPath);
  try {
    const sources = new Set(rows.map((r) => r.source ?? 'shop-alpha'));
    for (const s of sources) {
      db.prepare("INSERT OR IGNORE INTO sources (name, kind, consent_basis, priority, updated_at) VALUES (?, 'product', 'opt_in', 1, '2026-11-26T00:00:00Z')").run(s);
    }
    const insertContact = db.prepare(
      `INSERT INTO contacts (email, email_domain, email_status, flags, suggested_email, created_at, updated_at, orphaned_at)
       VALUES (?, ?, ?, '[]', ?, '2026-11-26T00:00:00Z', '2026-11-26T00:00:00Z', ?)`,
    );
    const insertSource = db.prepare(
      `INSERT INTO contact_sources (contact_id, source, raw_email, raw_fields)
       VALUES (?, ?, ?, '{}')`,
    );
    for (const r of rows) {
      const info = insertContact.run(r.email, r.domain, r.status, r.suggested, r.orphanedAt ?? null);
      insertSource.run(info.lastInsertRowid, r.source ?? 'shop-alpha', r.email);
    }
  } finally {
    db.close();
  }
}

function unmaskedAddresses(text: string): string[] {
  const re = /[^\s@＠﹫<>"'`()[\]{}:,;|]+[@＠﹫][^\s@＠﹫<>"'`()[\]{}:,;|]+/gu;
  return (text.match(re) ?? []).filter((m) => !m.includes('*'));
}

function dnsErr(code: string): NodeJS.ErrnoException {
  const err = new Error(`DNS ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

function makeFakeResolver(
  records: Record<string, { mx?: MxRecord[] | string; a?: string[] | string; aaaa?: string[] | string }>,
  queried: string[] = [],
): DnsResolver {
  const lookup = async <T>(field: 'mx' | 'a' | 'aaaa', host: string): Promise<T> => {
    queried.push(host);
    const value = records[host]?.[field];
    if (value === undefined) throw dnsErr('ENOTFOUND');
    if (typeof value === 'string') throw dnsErr(value);
    return value as T;
  };
  return {
    resolveMx: (host) => lookup<MxRecord[]>('mx', host),
    resolve4: (host) => lookup<string[]>('a', host),
    resolve6: (host) => lookup<string[]>('aaaa', host),
  };
}

test('check-domains without --dns marks all undecided suspects ambiguous, skips decided and orphaned, and makes no DNS calls', async () => {
  const { ws, layout, root } = setupEmptyWorkspace();
  seedContacts(layout.dbPath, [
    { email: 'yuta@example.con', domain: 'example.con', status: 'typo_suspect', suggested: 'yuta@example.com' },
    { email: 'decided@example.co.jo', domain: 'example.co.jo', status: 'typo_suspect', suggested: 'decided@example.co.jp' },
    { email: 'orphan@example.con', domain: 'example.con', status: 'typo_suspect', suggested: 'orphan@example.com', orphanedAt: '2026-11-26T01:00:00Z' },
    { email: 'ok@example.com', domain: 'example.com', status: 'valid', suggested: null },
  ]);
  const typoOverridePath = path.join(layout.overrides, 'typo-decisions.yaml');
  const overrideBefore = '- email: decided@example.co.jo\n  action: reject\n';
  fs.writeFileSync(typoOverridePath, overrideBefore);

  const throwingResolver: DnsResolver = {
    resolveMx: async () => { throw new Error('network should not be called'); },
    resolve4: async () => { throw new Error('network should not be called'); },
    resolve6: async () => { throw new Error('network should not be called'); },
  };

  const result = await checkDomains({ workspace: ws, repoRoot: root, dns: false, resolver: throwingResolver });
  assert.equal(result.report.dns_checked, false);
  assert.equal(result.report.total, 1);
  assert.equal(result.report.obvious.length, 0);
  assert.equal(result.report.ambiguous.length, 1);
  assert.deepEqual(result.report.ambiguous[0], {
    email: 'yuta@example.con',
    suggested: 'yuta@example.com',
    action: null,
    reason: 'DNS not checked (run with --dns)',
    note: null,
    sources: ['shop-alpha'],
  });

  // Never writes to overrides/
  assert.equal(fs.readFileSync(typoOverridePath, 'utf8'), overrideBefore);

  // Writes domain-check.yaml with full values and copy instruction
  const yamlText = fs.readFileSync(path.join(layout.reports, DOMAIN_CHECK_FILE), 'utf8');
  assert.match(yamlText, /copy the entries you agree with into overrides\/typo-decisions\.yaml/i);
  assert.ok(yamlText.includes('yuta@example.con'));

  // Stdout summary is masked
  const summary = renderDomainCheckSummary(result);
  assert.match(summary, /y\*\*\*@e\*\*\*e\.con → y\*\*\*@e\*\*\*e\.com/);
  assert.match(summary, /DNS not checked \(run with --dns\)/);
  assert.deepEqual(unmaskedAddresses(summary), []);
});

test('check-domains with --dns splits obvious vs ambiguous, queries bare domains only, and writes copy-ready YAML', async () => {
  const { ws, layout, root } = setupEmptyWorkspace();
  seedContacts(layout.dbPath, [
    // Obvious: typed refuses (ENOTFOUND), suggested accepts (MX -> A)
    { email: 'taro@gmaill.com', domain: 'gmaill.com', status: 'typo_suspect', suggested: 'taro@gmail.com' }, // email-scan:allow
    // Ambiguous: typed accepts mail (registered typo domain with its own MX)
    { email: 'hana@outlool.com', domain: 'outlool.com', status: 'typo_suspect', suggested: 'hana@outlook.com' }, // email-scan:allow
    // Ambiguous: typed unknown (ETIMEOUT)
    { email: 'ken@hotmal.com', domain: 'hotmal.com', status: 'typo_suspect', suggested: 'ken@hotmail.com' }, // email-scan:allow
    // Ambiguous: typed refuses, suggested refuses (null MX on example.com)
    { email: 'yuki@example.con', domain: 'example.con', status: 'typo_suspect', suggested: 'yuki@example.com' },
  ]);

  const queried: string[] = [];
  const resolver = makeFakeResolver(
    {
      'gmaill.com': { mx: 'ENOTFOUND' },
      'gmail.com': { mx: [{ priority: 5, exchange: 'mx.gmail.example' }] },
      'mx.gmail.example': { a: ['192.0.2.1'] },
      'outlool.com': { mx: [{ priority: 10, exchange: 'mx.outlool.example' }] },
      'mx.outlool.example': { a: ['192.0.2.2'] },
      'outlook.com': { mx: [{ priority: 10, exchange: 'mx.outlook.example' }] },
      'mx.outlook.example': { a: ['192.0.2.3'] },
      'hotmal.com': { mx: 'ETIMEOUT' },
      'hotmail.com': { mx: [{ priority: 10, exchange: 'mx.hotmail.example' }] },
      'mx.hotmail.example': { a: ['192.0.2.4'] },
      'example.con': { mx: 'ENOTFOUND' },
      'example.com': { mx: [{ priority: 0, exchange: '.' }] },
    },
    queried,
  );

  const result = await checkDomains({ workspace: ws, repoRoot: root, dns: true, resolver });
  assert.equal(result.report.dns_checked, true);
  assert.equal(result.report.total, 4);
  assert.equal(result.report.obvious.length, 1);
  assert.equal(result.report.ambiguous.length, 3);

  const ob = result.report.obvious[0] as ObviousTypoEntry;
  assert.equal(ob.email, 'taro@gmaill.com'); // email-scan:allow
  assert.equal(ob.suggested, 'taro@gmail.com'); // email-scan:allow
  assert.equal(ob.action, 'accept');
  assert.match(ob.note, /typed domain refuses.*suggested domain accepts/);

  const byEmail = new Map(result.report.ambiguous.map((e) => [e.email, e]));
  assert.match(byEmail.get('hana@outlool.com')?.reason ?? '', /typed domain accepts mail/); // email-scan:allow
  assert.match(byEmail.get('ken@hotmal.com')?.reason ?? '', /typed domain unknown: timeout/); // email-scan:allow
  assert.match(byEmail.get('yuki@example.con')?.reason ?? '', /suggested domain does not accept mail/);

  // Only bare domains queried, never local parts
  assert.ok(queried.every((h) => !h.includes('@') && !h.includes('taro') && !h.includes('hana') && !h.includes('ken')));

  // Copy-ready YAML: obvious entries load directly via loadOverrides; ambiguous entries load once action is filled
  const yamlText = fs.readFileSync(result.report_path, 'utf8');
  const parsed = parseYaml(yamlText) as { obvious: ObviousTypoEntry[]; ambiguous: AmbiguousTypoEntry[] };
  assert.equal(parsed.obvious.length, 1);
  assert.equal(parsed.ambiguous.length, 3);
  assert.equal(parsed.ambiguous[0]?.action, null);

  const tmpOv = fs.mkdtempSync(path.join(os.tmpdir(), 't12-cd-ov-'));
  fs.writeFileSync(
    path.join(tmpOv, 'typo-decisions.yaml'),
    JSON.stringify([...parsed.obvious, ...parsed.ambiguous.map((e) => ({ ...e, action: 'reject' }))]),
  );
  const loaded = loadOverrides(tmpOv);
  assert.equal(loaded.typo.length, 4);
  assert.equal(loaded.typo[0]?.action, 'accept');
  assert.ok(loaded.typo[0]?.note);

  // Stdout shows obvious before ambiguous, masks typed addresses, shows provider domain for provider suggestions
  const summary = renderDomainCheckSummary(result);
  assert.ok(summary.indexOf('Obvious: 1') < summary.indexOf('Ambiguous: 3'));
  assert.match(summary, /t\*\*\*@g\*\*\*l\.com → gmail\.com/);
  assert.match(summary, /y\*\*\*@e\*\*\*e\.con → y\*\*\*@e\*\*\*e\.com/);
  assert.deepEqual(unmaskedAddresses(summary), []);

  // Masked JSON includes counts and masked entries
  const jsonObj = buildMaskedJson(result) as {
    counts: { total: number; obvious: number; ambiguous: number };
    obvious: Array<{ email: string; suggested: string; suggested_provider: string | null }>;
    ambiguous: Array<{ email: string; suggested: string | null; suggested_provider: string | null }>;
  };
  assert.deepEqual(jsonObj.counts, { total: 4, obvious: 1, ambiguous: 3 });
  assert.equal(jsonObj.obvious[0]?.email, 't***@g***l.com');
  assert.equal(jsonObj.obvious[0]?.suggested_provider, 'gmail.com');
  assert.deepEqual(unmaskedAddresses(JSON.stringify(jsonObj)), []);
});

test('check-domains exits 0 and prints "no undecided typo suspects" when nothing needs checking', async () => {
  const { ws, layout } = setupEmptyWorkspace();
  seedContacts(layout.dbPath, [
    { email: 'ok@example.com', domain: 'example.com', status: 'valid', suggested: null },
  ]);

  const cli = spawnSync('node', ['scripts/check-domains.ts', '--workspace', ws], { cwd: repo, encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.match(cli.stdout, /no undecided typo suspects/);

  const cliJson = spawnSync('node', ['scripts/check-domains.ts', '--workspace', ws, '--json'], { cwd: repo, encoding: 'utf8' });
  assert.equal(cliJson.status, 0, cliJson.stderr);
  const parsed = JSON.parse(cliJson.stdout) as { counts: { total: number; obvious: number; ambiguous: number } };
  assert.deepEqual(parsed.counts, { total: 0, obvious: 0, ambiguous: 0 });
});

test('check-domains enforces workspace guard, lock, symlink safety, and D32 JSON sanitization', async () => {
  // Missing workspace -> exit 2
  const missing = path.join(os.tmpdir(), `t12-missing-${Date.now()}`);
  const fail = spawnSync('node', ['scripts/check-domains.ts', '--workspace', missing], { cwd: repo, encoding: 'utf8' });
  assert.equal(fail.status, 2);

  const { ws, layout, root } = setupEmptyWorkspace();
  seedContacts(layout.dbPath, [
    { email: 'yuta@example.con', domain: 'example.con', status: 'typo_suspect', suggested: 'yuta@example.com', source: '@weird' },
  ]);

  // Symlink at output/reports/domain-check.yaml is replaced, never followed
  const outsideFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 't12-out-')), 'victim.yaml');
  fs.writeFileSync(outsideFile, 'keep me');
  fs.symlinkSync(outsideFile, path.join(layout.reports, DOMAIN_CHECK_FILE));
  await checkDomains({ workspace: ws, repoRoot: root, dns: false });
  assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep me');
  assert.ok(fs.lstatSync(path.join(layout.reports, DOMAIN_CHECK_FILE)).isFile());

  // --json sanitizes per value before serializing (D32)
  const j = spawnSync('node', ['scripts/check-domains.ts', '--workspace', ws, '--json'], { cwd: repo, encoding: 'utf8' });
  assert.equal(j.status, 0, j.stderr);
  const out = JSON.parse(j.stdout) as { ambiguous: Array<{ sources: string[] }> };
  assert.deepEqual(out.ambiguous[0]?.sources, ['***']);
  assert.ok(!j.stdout.includes('@weird'));
  assert.deepEqual(unmaskedAddresses(j.stdout), []);

  // Lock held -> PreconditionError (exit 2)
  fs.writeFileSync(path.join(ws, '.lock'), JSON.stringify({ pid: process.pid, command: 'clean-and-merge', started_at: '2026-11-26T00:00:00Z' }));
  await assert.rejects(
    checkDomains({ workspace: ws, repoRoot: root, dns: false }),
    (err: Error) => err.name === 'PreconditionError' && /in use/.test(err.message),
  );
});
