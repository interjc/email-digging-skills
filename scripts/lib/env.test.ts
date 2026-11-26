import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadEnv, parseEnv } from './env.ts';

test('parseEnv: KEY=VALUE, comments, quotes, export prefix, CRLF, BOM', () => {
  const text = '﻿# comment\r\nA=1\r\n  B = two words  \nC="quoted # not a comment"\nD=\'single\'\nE=plain # inline\nexport F=exported\nEMPTY=\nnot a line\n=novalue\n';
  assert.deepEqual(parseEnv(text), {
    A: '1',
    B: 'two words',
    C: 'quoted # not a comment',
    D: 'single',
    E: 'plain',
    F: 'exported',
    EMPTY: '',
  });
});

test('parseEnv: the last duplicate wins; = inside values is kept', () => {
  assert.deepEqual(parseEnv('K=a\nK=b=c\n'), { K: 'b=c' });
});

test('loadEnv: missing .env gives {}; present .env is parsed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  assert.deepEqual(loadEnv(dir), {});
  fs.writeFileSync(path.join(dir, '.env'), 'MASK_HMAC_KEY=abc\n');
  assert.deepEqual(loadEnv(dir), { MASK_HMAC_KEY: 'abc' });
});

test('loadEnv never writes values to stdout/stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'env-test-'));
  fs.writeFileSync(path.join(dir, '.env'), 'SECRET=hunter2-secret\n');
  const chunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const capture = ((c: unknown) => { chunks.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stdout.write = capture;
  process.stderr.write = capture;
  try {
    loadEnv(dir);
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
  assert.ok(!chunks.join('').includes('hunter2'));
});
