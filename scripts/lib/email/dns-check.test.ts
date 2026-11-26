import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { MxRecord } from 'node:dns';
import { canonicalHost, classifyDomain, classifyDomains } from './dns-check.ts';
import type { DnsResolver } from './dns-check.ts';

function dnsErr(code: string): NodeJS.ErrnoException {
  const err = new Error(`DNS ${code}`) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

interface FakeRecord {
  mx?: MxRecord[] | string;
  a?: string[] | string;
  aaaa?: string[] | string;
}

function makeFakeResolver(
  records: Record<string, FakeRecord>,
  hooks?: { onCall?: (method: string, host: string) => void | Promise<void> },
): DnsResolver {
  const lookup = async <T>(
    method: 'resolveMx' | 'resolve4' | 'resolve6',
    field: 'mx' | 'a' | 'aaaa',
    host: string,
  ): Promise<T> => {
    await hooks?.onCall?.(method, host);
    const entry = records[host];
    const value = entry?.[field];
    if (value === undefined) throw dnsErr('ENOTFOUND');
    if (typeof value === 'string') throw dnsErr(value);
    return value as T;
  };
  return {
    resolveMx: (host) => lookup<MxRecord[]>('resolveMx', 'mx', host),
    resolve4: (host) => lookup<string[]>('resolve4', 'a', host),
    resolve6: (host) => lookup<string[]>('resolve6', 'aaaa', host),
  };
}

test('classifyDomain accepts valid MX resolving to A or AAAA', async () => {
  const resolver = makeFakeResolver({
    'v4.example.com': { mx: [{ priority: 10, exchange: 'mx1.example.com' }] },
    'mx1.example.com': { a: ['192.0.2.1'] },
    'v6.example.com': { mx: [{ priority: 10, exchange: 'mx6.example.com' }] },
    'mx6.example.com': { a: 'ENODATA', aaaa: ['2001:db8::1'] },
  });

  const v4 = await classifyDomain('v4.example.com', resolver);
  assert.equal(v4.verdict, 'accepts');
  assert.match(v4.reason, /MX resolves \(A\)/);

  const v6 = await classifyDomain('v6.example.com', resolver);
  assert.equal(v6.verdict, 'accepts');
  assert.match(v6.reason, /MX resolves \(AAAA\)/);
});

test('classifyDomain refuses null MX (RFC 7505) with empty or dot exchange', async () => {
  const resolver = makeFakeResolver({
    'dot.example.com': { mx: [{ priority: 0, exchange: '.' }] },
    'empty.example.com': { mx: [{ priority: 0, exchange: '' }] },
  });

  const dot = await classifyDomain('dot.example.com', resolver);
  assert.equal(dot.verdict, 'refuses');
  assert.match(dot.reason, /null MX/);

  const empty = await classifyDomain('empty.example.com', resolver);
  assert.equal(empty.verdict, 'refuses');
  assert.match(empty.reason, /null MX/);
});

test('classifyDomain handles multi-MX fallback, ENOTFOUND exchanges, and temporary exchange errors', async () => {
  const resolver = makeFakeResolver({
    'fallback.example.com': {
      mx: [
        { priority: 10, exchange: 'bad.example.com' },
        { priority: 20, exchange: 'good.example.com' },
      ],
    },
    'bad.example.com': { a: 'ETIMEOUT', aaaa: 'ETIMEOUT' },
    'good.example.com': { a: ['192.0.2.2'] },

    'deadmx.example.com': {
      mx: [
        { priority: 10, exchange: 'gone1.example.com' },
        { priority: 20, exchange: 'gone2.example.com' },
      ],
    },
    'gone1.example.com': { a: 'ENOTFOUND' },
    'gone2.example.com': { a: 'ENOTFOUND' },

    'tempmx.example.com': {
      mx: [
        { priority: 10, exchange: 'gone1.example.com' },
        { priority: 20, exchange: 'slow.example.com' },
      ],
    },
    'slow.example.com': { a: 'ESERVFAIL', aaaa: 'ESERVFAIL' },
  });

  assert.equal((await classifyDomain('fallback.example.com', resolver)).verdict, 'accepts');

  const dead = await classifyDomain('deadmx.example.com', resolver);
  assert.equal(dead.verdict, 'refuses');
  assert.match(dead.reason, /ENOTFOUND/);

  const temp = await classifyDomain('tempmx.example.com', resolver);
  assert.equal(temp.verdict, 'unknown');
  assert.match(temp.reason, /ESERVFAIL/);
});

test('classifyDomain falls back to A then AAAA on ENODATA from MX (RFC 5321 §5.1)', async () => {
  const resolver = makeFakeResolver({
    'only-a.example.com': { mx: 'ENODATA', a: ['192.0.2.10'] },
    'only-aaaa.example.com': { mx: 'ENODATA', a: 'ENODATA', aaaa: ['2001:db8::10'] },
    'no-addr.example.com': { mx: 'ENODATA', a: 'ENODATA', aaaa: 'ENODATA' },
    'timeout-a.example.com': { mx: 'ENODATA', a: 'ETIMEOUT', aaaa: 'ENODATA' },
  });

  assert.equal((await classifyDomain('only-a.example.com', resolver)).verdict, 'accepts');
  assert.equal((await classifyDomain('only-aaaa.example.com', resolver)).verdict, 'accepts');
  assert.equal((await classifyDomain('no-addr.example.com', resolver)).verdict, 'refuses');
  assert.equal((await classifyDomain('timeout-a.example.com', resolver)).verdict, 'unknown');
});

test('classifyDomain maps ENOTFOUND to refuses and transient errors to unknown', async () => {
  const resolver = makeFakeResolver({
    'missing.example.con': { mx: 'ENOTFOUND' },
    'timeout.example.net': { mx: 'ETIMEOUT' },
    'servfail.example.net': { mx: 'ESERVFAIL' },
    'refused.example.net': { mx: 'ECONNREFUSED' },
    'other.example.net': { mx: 'ECANCELLED' },
  });

  assert.equal((await classifyDomain('missing.example.con', resolver)).verdict, 'refuses');
  const t = await classifyDomain('timeout.example.net', resolver);
  assert.equal(t.verdict, 'unknown');
  assert.equal(t.reason, 'timeout');
  assert.equal((await classifyDomain('servfail.example.net', resolver)).verdict, 'unknown');
  assert.equal((await classifyDomain('refused.example.net', resolver)).verdict, 'unknown');
  assert.equal((await classifyDomain('other.example.net', resolver)).verdict, 'unknown');
});

test('classifyDomain rejects email addresses and never sends local parts to the resolver', async () => {
  const queried: string[] = [];
  const resolver = makeFakeResolver({}, { onCall: (_m, host) => { queried.push(host); } });
  await assert.rejects(classifyDomain('user@example.com', resolver), /bare domains only/);
  await assert.rejects(classifyDomain('   ', resolver), /bare domains only/);
  assert.deepEqual(queried, []);
});

test('classifyDomains deduplicates, caches within the run, and caps concurrency', async () => {
  let active = 0;
  let maxActive = 0;
  const mxCalls: string[] = [];

  const records: Record<string, FakeRecord> = {};
  const input: string[] = [];
  for (let i = 0; i < 10; i++) {
    const d = `d${i}.example.org`;
    records[d] = { mx: 'ENOTFOUND' };
    input.push(d, d.toUpperCase());
  }

  const resolver = makeFakeResolver(records, {
    onCall: async (method, host) => {
      if (method === 'resolveMx') mxCalls.push(host);
      active += 1;
      if (active > maxActive) maxActive = active;
      await new Promise((resolve) => setTimeout(resolve, 10));
      active -= 1;
    },
  });

  const result = await classifyDomains(input, resolver, { concurrency: 3 });
  assert.equal(result.size, 10);
  assert.equal(mxCalls.length, 10, 'duplicate and mixed-case domains are queried only once');
  assert.ok(maxActive <= 3, `expected max concurrency <= 3, got ${maxActive}`);
  assert.ok(maxActive >= 2, `expected concurrent execution, got max ${maxActive}`);
});

test('R6-3/4: canonicalHost blocks address-like names at both resolver boundaries and canonicalizes keys', async () => {
  assert.equal(canonicalHost('Example.COM.'), 'example.com');
  assert.equal(canonicalHost('bücher.example'), 'xn--bcher-kva.example');
  for (const bad of ['a@example.com', 'a＠example.com', 'a﹫example.com', 'a b.example', '-a.example', '', '.']) {
    assert.equal(canonicalHost(bad), null, bad);
  }
  const queried: string[] = [];
  const resolver = {
    async resolveMx(h: string) { queried.push(`mx:${h}`); return [{ priority: 10, exchange: 'local@mx.example.com' }]; },
    async resolve4(h: string) { queried.push(`a:${h}`); return ['192.0.2.1']; },
    async resolve6(h: string) { queried.push(`aaaa:${h}`); return []; },
  };
  const r = await classifyDomain('example.org', resolver);
  assert.notEqual(r.verdict, 'accepts');
  assert.ok(queried.every((q) => !q.includes('@')), queried.join(','));
  await assert.rejects(() => classifyDomain('a＠example.org', resolver));
  const map = await classifyDomains(['Example.org.', 'example.org'], resolver);
  assert.deepEqual([...map.keys()], ['example.org']);
});
