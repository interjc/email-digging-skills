// Opt-in DNS mail-domain classification (D34, RFC 5321 §5.1, RFC 7505).
// Uses an injected resolver so tests never touch the network. Queries domains only (never local parts).

import { Resolver } from 'node:dns/promises';
import type { MxRecord } from 'node:dns';

export type MailVerdict = 'accepts' | 'refuses' | 'unknown';

export interface DomainClassification {
  verdict: MailVerdict;
  reason: string;
}

export interface DnsResolver {
  resolveMx(hostname: string): Promise<MxRecord[]>;
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
}

/** Host resolver with bounded timeout and retries. Never overrides system nameservers. */
export function createHostResolver(): DnsResolver {
  return new Resolver({ timeout: 3000, tries: 2 });
}

function normalizeDomainArg(domain: string): string {
  const cleaned = domain.trim().toLowerCase().replace(/\.$/, '');
  if (cleaned === '' || cleaned.includes('@') || /\s/.test(cleaned)) {
    throw new Error('DNS check accepts bare domains only, never email addresses or local parts');
  }
  return cleaned;
}

function dnsErrorCode(err: unknown): string {
  if (err && typeof err === 'object' && 'code' in err && typeof (err as { code?: unknown }).code === 'string') {
    return (err as { code: string }).code;
  }
  return 'UNKNOWN';
}

function formatDnsError(code: string): string {
  if (code === 'ETIMEOUT') return 'timeout';
  if (code === 'ESERVFAIL') return 'server failure (ESERVFAIL)';
  if (code === 'ECONNREFUSED') return 'connection refused (ECONNREFUSED)';
  return code;
}

type AddrProbe =
  | { status: 'found'; record: 'A' | 'AAAA' }
  | { status: 'not_found' }
  | { status: 'no_data' }
  | { status: 'temp_error'; code: string };

async function probeAddress(host: string, resolver: DnsResolver): Promise<AddrProbe> {
  let aStatus: 'no_data' | 'not_found' | 'temp_error' = 'no_data';
  let tempCode: string | null = null;

  try {
    const v4 = await resolver.resolve4(host);
    if (v4.length > 0) return { status: 'found', record: 'A' };
  } catch (err) {
    const code = dnsErrorCode(err);
    if (code === 'ENOTFOUND') {
      aStatus = 'not_found';
    } else if (code === 'ENODATA') {
      aStatus = 'no_data';
    } else {
      aStatus = 'temp_error';
      tempCode = code;
    }
  }

  // NXDOMAIN applies to the entire owner name, so skip AAAA when A already returned ENOTFOUND.
  if (aStatus === 'not_found') return { status: 'not_found' };

  try {
    const v6 = await resolver.resolve6(host);
    if (v6.length > 0) return { status: 'found', record: 'AAAA' };
  } catch (err) {
    const code = dnsErrorCode(err);
    if (code === 'ENOTFOUND') {
      return tempCode !== null ? { status: 'temp_error', code: tempCode } : { status: 'not_found' };
    }
    if (code !== 'ENODATA') {
      tempCode ??= code;
    }
  }

  if (tempCode !== null) return { status: 'temp_error', code: tempCode };
  return { status: 'no_data' };
}

/**
 * Classify whether a domain can accept mail per RFC 5321 §5.1 and RFC 7505.
 * Never logs or queries local parts.
 */
export async function classifyDomain(domain: string, resolver: DnsResolver): Promise<DomainClassification> {
  const host = normalizeDomainArg(domain);

  let mxRecords: MxRecord[];
  try {
    mxRecords = await resolver.resolveMx(host);
  } catch (err) {
    const code = dnsErrorCode(err);
    if (code === 'ENOTFOUND') {
      return { verdict: 'refuses', reason: 'domain not found (ENOTFOUND)' };
    }
    if (code === 'ENODATA') {
      return classifyAddressFallback(host, resolver);
    }
    return { verdict: 'unknown', reason: formatDnsError(code) };
  }

  if (mxRecords.length === 0) {
    return classifyAddressFallback(host, resolver);
  }

  // RFC 7505: a single MX record with priority 0 and empty / "." exchange explicitly refuses mail.
  if (mxRecords.length === 1) {
    const only = mxRecords[0] as MxRecord;
    const ex = only.exchange.trim();
    if (only.priority === 0 && (ex === '' || ex === '.')) {
      return { verdict: 'refuses', reason: 'null MX (RFC 7505)' };
    }
  }

  const ordered = [...mxRecords].sort((a, b) => a.priority - b.priority);
  const seen = new Set<string>();
  let tempCode: string | null = null;
  let sawNotFound = false;
  let sawNoData = false;

  for (const record of ordered) {
    const exchange = record.exchange.trim().toLowerCase().replace(/\.$/, '');
    if (exchange === '' || seen.has(exchange)) continue;
    seen.add(exchange);

    const probe = await probeAddress(exchange, resolver);
    if (probe.status === 'found') {
      return { verdict: 'accepts', reason: `MX resolves (${probe.record})` };
    }
    if (probe.status === 'temp_error') {
      tempCode ??= probe.code;
    } else if (probe.status === 'not_found') {
      sawNotFound = true;
    } else {
      sawNoData = true;
    }
  }

  if (tempCode !== null) {
    return { verdict: 'unknown', reason: `MX exchange ${formatDnsError(tempCode)}` };
  }
  if (sawNotFound && !sawNoData) {
    return { verdict: 'refuses', reason: 'MX exchange not found (ENOTFOUND)' };
  }
  return { verdict: 'refuses', reason: 'MX exchange has no A or AAAA records' };
}

async function classifyAddressFallback(host: string, resolver: DnsResolver): Promise<DomainClassification> {
  const probe = await probeAddress(host, resolver);
  if (probe.status === 'found') {
    return { verdict: 'accepts', reason: `${probe.record} record fallback (no MX)` };
  }
  if (probe.status === 'temp_error') {
    return { verdict: 'unknown', reason: formatDnsError(probe.code) };
  }
  if (probe.status === 'not_found') {
    return { verdict: 'refuses', reason: 'domain not found (ENOTFOUND)' };
  }
  return { verdict: 'refuses', reason: 'no MX, A, or AAAA records' };
}

export interface ClassifyDomainsOpts {
  concurrency?: number;
}

/**
 * Classify a batch of domains with deduplication, per-run caching, and bounded concurrency.
 * Returns a Map keyed by lowercased domain name.
 */
export async function classifyDomains(
  domains: Iterable<string>,
  resolver: DnsResolver,
  opts: ClassifyDomainsOpts = {},
): Promise<Map<string, DomainClassification>> {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const raw of domains) {
    const host = normalizeDomainArg(raw);
    if (!seen.has(host)) {
      seen.add(host);
      unique.push(host);
    }
  }

  const results = new Map<string, DomainClassification>();
  if (unique.length === 0) return results;

  const limit = Math.max(1, Math.floor(opts.concurrency ?? 8));
  const workerCount = Math.min(limit, unique.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < unique.length) {
      const idx = nextIndex;
      nextIndex += 1;
      const domain = unique[idx] as string;
      const classification = await classifyDomain(domain, resolver);
      results.set(domain, classification);
    }
  }

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}
