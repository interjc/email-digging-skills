// check-domains [--workspace <p>] [--dns] [--auto-accept] [--json]
// Sort undecided typo suspects into obvious and ambiguous so a human can confirm fixes faster (D34).
// Without --dns: no network; every suspect is ambiguous.
// With --dns: classifies typed and suggested domains via the host's DNS resolver (RFC 5321 §5.1 / RFC 7505).
// Writes output/reports/domain-check.yaml with full values; never writes to overrides/. stdout is masked (D28).

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { EXIT } from './lib/types.ts';
import { parseCliArgs, printWarnings, runCli } from './lib/cli.ts';
import { PreconditionError } from './lib/errors.ts';
import { repoRoot, requireWorkspace } from './lib/paths.ts';
import type { WorkspaceInfo } from './lib/paths.ts';
import { withWorkspaceLock } from './lib/lock.ts';
import { openDb } from './lib/db.ts';
import { loadOverrides } from './lib/overrides.ts';
import { normalizeOverrideEmail } from './lib/merge.ts';
import { writeFileInWorkspace } from './lib/fsafe.ts';
import { maskEmail } from './lib/mask.ts';
import { sanitizeDeep, sanitizeText } from './lib/sanitize.ts';
import { isProviderDomain } from './lib/email/providers.ts';
import { canonicalHost, classifyDomains, createHostResolver } from './lib/email/dns-check.ts';
import type { DnsResolver, DomainClassification } from './lib/email/dns-check.ts';

export const DOMAIN_CHECK_FILE = 'domain-check.yaml';
const SHOW = 20;
const DNS_NOT_CHECKED_REASON = 'DNS not checked (run with --dns)';

export interface ObviousTypoEntry {
  email: string;
  suggested: string;
  action: 'accept';
  note: string;
  sources: string[];
}

export interface AmbiguousTypoEntry {
  email: string;
  suggested: string | null;
  action: null;
  reason: string;
  note: null;
  sources: string[];
}

/** D35: a suggestion to a curated popular provider, written to overrides by --auto-accept. */
export interface AutoAcceptedEntry {
  email: string;
  suggested: string;
  action: 'accept';
  note: string;
  sources: string[];
}

export interface DomainCheckReport {
  generated_at: string;
  dns_checked: boolean;
  total: number;
  obvious: ObviousTypoEntry[];
  ambiguous: AmbiguousTypoEntry[];
  /** Empty unless --auto-accept. */
  auto_accepted: AutoAcceptedEntry[];
  /** overrides/typo-decisions.yaml when --auto-accept wrote entries, else null. */
  auto_accept_path: string | null;
}

export interface DomainCheckResult {
  report: DomainCheckReport;
  report_path: string;
  workspace_warnings: string[];
}

export interface CheckDomainsOpts {
  workspace?: string | null;
  repoRoot?: string;
  dns?: boolean;
  /** D35: write accept decisions for suggestions to a popular provider into overrides/typo-decisions.yaml. */
  autoAccept?: boolean;
  /** Injected DNS resolver (used in tests so they never touch the network). */
  resolver?: DnsResolver;
  concurrency?: number;
}

function domainOf(email: string | null): string | null {
  if (!email) return null;
  const idx = email.lastIndexOf('@');
  if (idx < 0) return null;
  return canonicalHost(email.slice(idx + 1));
}

function ambiguousReason(typed: DomainClassification, suggested: DomainClassification): string {
  if (typed.verdict === 'accepts') {
    if (suggested.verdict === 'accepts') return `typed domain accepts mail (${typed.reason})`;
    if (suggested.verdict === 'refuses') {
      return `typed domain accepts mail (${typed.reason}); suggested domain does not accept mail (${suggested.reason})`;
    }
    return `typed domain accepts mail (${typed.reason}); suggested domain unknown: ${suggested.reason}`;
  }
  if (typed.verdict === 'unknown') {
    if (suggested.verdict === 'accepts') return `typed domain unknown: ${typed.reason}`;
    if (suggested.verdict === 'refuses') {
      return `typed domain unknown: ${typed.reason}; suggested domain does not accept mail (${suggested.reason})`;
    }
    return `typed domain unknown: ${typed.reason}; suggested domain unknown: ${suggested.reason}`;
  }
  // typed.verdict === 'refuses' and suggested.verdict !== 'accepts'
  if (suggested.verdict === 'refuses') return `suggested domain does not accept mail (${suggested.reason})`;
  return `suggested domain unknown: ${suggested.reason}`;
}

export async function checkDomains(opts: CheckDomainsOpts = {}): Promise<DomainCheckResult> {
  const root = opts.repoRoot ?? repoRoot();
  const info = requireWorkspace({ workspace: opts.workspace, repoRoot: root });
  return withWorkspaceLock(info.workspace, 'check-domains', () => checkDomainsLocked(info, opts));
}

async function checkDomainsLocked(info: WorkspaceInfo, opts: CheckDomainsOpts): Promise<DomainCheckResult> {
  const { layout } = info;
  const overrides = loadOverrides(layout.overrides);
  const decided = new Set(overrides.typo.map((t) => normalizeOverrideEmail(t.email)));

  const db = openDb(layout.dbPath, { readonly: true });
  let suspects: Array<{ email: string; suggested: string | null; sources: string[] }>;
  try {
    const sourcesOf = db.prepare('SELECT source FROM contact_sources WHERE contact_id = ? ORDER BY source');
    suspects = (
      db
        .prepare("SELECT id, email, suggested_email FROM contacts WHERE email_status = 'typo_suspect' AND orphaned_at IS NULL ORDER BY email")
        .all() as Array<{ id: number; email: string; suggested_email: string | null }>
    )
      .filter((c) => !decided.has(c.email))
      .map((c) => ({
        email: c.email,
        suggested: c.suggested_email,
        sources: (sourcesOf.all(c.id) as Array<{ source: string }>).map((r) => r.source),
      }));
  } finally {
    db.close();
  }

  const dnsChecked = opts.dns === true;
  const obvious: ObviousTypoEntry[] = [];
  const ambiguous: AmbiguousTypoEntry[] = [];

  if (!dnsChecked) {
    for (const s of suspects) {
      ambiguous.push({
        email: s.email,
        suggested: s.suggested,
        action: null,
        reason: DNS_NOT_CHECKED_REASON,
        note: null,
        sources: s.sources,
      });
    }
  } else if (suspects.length > 0) {
    const domainsToCheck = new Set<string>();
    for (const s of suspects) {
      const typedDomain = domainOf(s.email);
      const suggestedDomain = domainOf(s.suggested);
      if (typedDomain !== null) domainsToCheck.add(typedDomain);
      if (suggestedDomain !== null) domainsToCheck.add(suggestedDomain);
    }

    const resolver = opts.resolver ?? createHostResolver();
    const classifications = await classifyDomains(domainsToCheck, resolver, { concurrency: opts.concurrency });

    for (const s of suspects) {
      const typedDomain = domainOf(s.email);
      const suggestedDomain = domainOf(s.suggested);
      if (typedDomain === null) {
        ambiguous.push({
          email: s.email,
          suggested: s.suggested,
          action: null,
          reason: 'typed address has no valid domain',
          note: null,
          sources: s.sources,
        });
        continue;
      }
      if (s.suggested === null || suggestedDomain === null) {
        ambiguous.push({
          email: s.email,
          suggested: s.suggested,
          action: null,
          reason: 'no suggested domain',
          note: null,
          sources: s.sources,
        });
        continue;
      }

      const typedRes = classifications.get(typedDomain) ?? { verdict: 'unknown', reason: 'not classified' };
      const suggestedRes = classifications.get(suggestedDomain) ?? { verdict: 'unknown', reason: 'not classified' };

      if (typedRes.verdict === 'refuses' && suggestedRes.verdict === 'accepts') {
        obvious.push({
          email: s.email,
          suggested: s.suggested,
          action: 'accept',
          note: `typed domain refuses (${typedRes.reason}); suggested domain accepts (${suggestedRes.reason})`,
          sources: s.sources,
        });
      } else {
        ambiguous.push({
          email: s.email,
          suggested: s.suggested,
          action: null,
          reason: ambiguousReason(typedRes, suggestedRes),
          note: null,
          sources: s.sources,
        });
      }
    }
  }

  // D35 (user 2026-11-27): suggestions to a curated popular provider need no further human judgement.
  const autoAccepted: AutoAcceptedEntry[] = [];
  let autoAcceptPath: string | null = null;
  if (opts.autoAccept === true) {
    const isAuto = (suggested: string | null): suggested is string => {
      const d = domainOf(suggested);
      return d !== null && isProviderDomain(d);
    };
    const take = <T extends { email: string; suggested: string | null; sources: string[] }>(list: T[], evidence: (e: T) => string): T[] =>
      list.filter((e) => {
        if (!isAuto(e.suggested)) return true;
        autoAccepted.push({
          email: e.email, suggested: e.suggested, action: 'accept', sources: e.sources,
          note: `auto-accept (D35): suggestion is a popular provider (${domainOf(e.suggested)}); ${evidence(e)}`,
        });
        return false;
      });
    obvious.splice(0, obvious.length, ...take(obvious, (e) => e.note));
    ambiguous.splice(0, ambiguous.length, ...take(ambiguous, (e) => e.reason));
    if (autoAccepted.length > 0) autoAcceptPath = appendTypoDecisions(layout.overrides, autoAccepted, info.workspace);
  }

  const report: DomainCheckReport = {
    generated_at: new Date().toISOString(),
    dns_checked: dnsChecked,
    total: suspects.length,
    obvious,
    ambiguous,
    auto_accepted: autoAccepted,
    auto_accept_path: autoAcceptPath,
  };

  const reportPath = writeFileInWorkspace(layout.reports, DOMAIN_CHECK_FILE, renderDomainCheckYaml(report), {
    workspace: info.workspace,
  });

  return { report, report_path: reportPath, workspace_warnings: info.warnings };
}

const TYPO_DECISIONS_FILE = 'typo-decisions.yaml';

/**
 * Append accept decisions to overrides/typo-decisions.yaml, keeping every existing line (comments
 * included). The existing file must be empty, comments only, or a block-style YAML list.
 */
function appendTypoDecisions(overridesDir: string, entries: AutoAcceptedEntry[], workspace: string): string {
  const file = path.join(overridesDir, TYPO_DECISIONS_FILE);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const parsed = existing.trim() === '' ? null : parseYaml(existing) as unknown;
  const blockList = Array.isArray(parsed) && (parsed.length === 0 ? !/^\s*\[/m.test(existing) : /^-\s/m.test(existing));
  if (parsed !== null && !blockList) {
    throw new Error(`${TYPO_DECISIONS_FILE} is not a block-style YAML list; fix it before using --auto-accept`);
  }
  const items = entries.map(({ email, action, suggested, note }) => ({ email, action, suggested, note }));
  const block = `# check-domains --auto-accept ${new Date().toISOString()} (D35): suggestions to popular providers\n${stringifyYaml(items)}`;
  const text = existing === '' ? block : `${existing.endsWith('\n') ? existing : `${existing}\n`}${block}`;
  return writeFileInWorkspace(overridesDir, TYPO_DECISIONS_FILE, text, { workspace });
}

/** Local review file with full values and copy-ready entries for overrides/typo-decisions.yaml. */
export function renderDomainCheckYaml(r: DomainCheckReport): string {
  const head = [
    `# Domain typo check (generated ${r.generated_at}, dns: ${r.dns_checked ? 'checked' : 'not checked'}).`,
    '# This file holds FULL addresses: keep it in the workspace and do not paste it into a chat or issue.',
    '# Copy the entries you agree with into overrides/typo-decisions.yaml, then re-run clean-and-merge.',
    '#   obvious   → pre-filled `action: accept` with DNS evidence in `note` (typed domain refuses, suggested accepts)',
    '#   ambiguous → fill `action: accept` or `action: reject` (see `reason` for why manual review is needed)',
    '# `sources` and `reason` are informational and ignored by overrides/typo-decisions.yaml.',
    '',
  ];
  return head.join('\n') + stringifyYaml({ auto_accepted: r.auto_accepted, obvious: r.obvious, ambiguous: r.ambiguous }, { nullStr: '' });
}

function formatSuggestionForStdout(suggested: string | null): string {
  if (!suggested) return '?';
  const domain = domainOf(suggested);
  if (domain !== null && isProviderDomain(domain)) return domain;
  return maskEmail(suggested);
}

/** Masked human-readable summary for stdout. Obvious first, then ambiguous. */
export function renderDomainCheckSummary(result: DomainCheckResult): string {
  const r = result.report;
  if (r.total === 0) return 'no undecided typo suspects';

  const lines: string[] = [
    `check-domains (dns: ${r.dns_checked ? 'checked' : 'not checked'}): ${r.total} undecided (${r.auto_accepted.length} auto-accepted, ${r.obvious.length} obvious, ${r.ambiguous.length} ambiguous)`,
  ];

  const section = (title: string, items: string[], hint: string): void => {
    lines.push('', `${title}: ${items.length}${items.length > 0 ? `  → ${hint}` : ''}`);
    for (const item of items.slice(0, SHOW)) lines.push(`  - ${item}`);
    if (items.length > SHOW) lines.push(`  ... and ${items.length - SHOW} more (see ${DOMAIN_CHECK_FILE})`);
  };

  if (r.auto_accepted.length > 0) {
    section(
      'Auto-accepted (popular provider)',
      r.auto_accepted.map((e) => `${maskEmail(e.email)} → ${formatSuggestionForStdout(e.suggested)} (${e.sources.join(', ')})`),
      `written to ${r.auto_accept_path ?? `overrides/${TYPO_DECISIONS_FILE}`}; run clean-and-merge to apply`,
    );
  }

  section(
    'Obvious',
    r.obvious.map(
      (e) => `${maskEmail(e.email)} → ${formatSuggestionForStdout(e.suggested)} (${e.sources.join(', ')}) — ${e.note}`,
    ),
    'copy agreed entries into overrides/typo-decisions.yaml (pre-filled action: accept)',
  );

  section(
    'Ambiguous',
    r.ambiguous.map(
      (e) => `${maskEmail(e.email)} → ${formatSuggestionForStdout(e.suggested)} (${e.sources.join(', ')}) — ${e.reason}`,
    ),
    'review and fill action: accept or reject before copying to overrides/typo-decisions.yaml',
  );

  lines.push('', `Full values and ready-to-edit entries: ${result.report_path}`);
  return sanitizeText(lines.join('\n'));
}

/** Masked, per-value sanitized JSON payload (D32). */
export function buildMaskedJson(result: DomainCheckResult): Record<string, unknown> {
  const r = result.report;
  const providerDomain = (s: string | null): string | null => {
    const d = domainOf(s);
    return d !== null && isProviderDomain(d) ? d : null;
  };
  return sanitizeDeep({
    report_path: result.report_path,
    generated_at: r.generated_at,
    dns_checked: r.dns_checked,
    counts: {
      total: r.total,
      auto_accepted: r.auto_accepted.length,
      obvious: r.obvious.length,
      ambiguous: r.ambiguous.length,
    },
    auto_accept_path: r.auto_accept_path,
    auto_accepted: r.auto_accepted.map((e) => ({
      email: maskEmail(e.email),
      suggested_provider: domainOf(e.suggested),
      sources: e.sources,
    })),
    obvious: r.obvious.map((e) => ({
      email: maskEmail(e.email),
      suggested: maskEmail(e.suggested),
      suggested_provider: providerDomain(e.suggested),
      action: e.action,
      note: e.note,
      sources: e.sources,
    })),
    ambiguous: r.ambiguous.map((e) => ({
      email: maskEmail(e.email),
      suggested: e.suggested ? maskEmail(e.suggested) : null,
      suggested_provider: providerDomain(e.suggested),
      action: e.action,
      reason: e.reason,
      sources: e.sources,
    })),
  });
}

async function main(): Promise<number> {
  const { values } = parseCliArgs(process.argv.slice(2), {
    dns: { type: 'boolean', default: false },
    'auto-accept': { type: 'boolean', default: false },
  });
  let result: DomainCheckResult;
  try {
    result = await checkDomains({
      workspace: values.workspace as string | undefined,
      dns: values.dns === true,
      autoAccept: values['auto-accept'] === true,
    });
  } catch (err) {
    if (err instanceof PreconditionError) {
      throw new PreconditionError(sanitizeText(err.message), err.fix === null ? null : sanitizeText(err.fix));
    }
    throw new Error(sanitizeText(err instanceof Error ? err.message : String(err)));
  }

  if (values.json === true) {
    process.stdout.write(`${JSON.stringify(buildMaskedJson(result), null, 2)}\n`);
  } else {
    printWarnings(result.workspace_warnings.map(sanitizeText));
    process.stdout.write(`${renderDomainCheckSummary(result)}\n`);
  }
  return EXIT.OK;
}

function isEntryPoint(): boolean {
  try {
    return !!process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  await runCli(main);
}
