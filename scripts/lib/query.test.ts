import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { migrate, openDb } from './db.ts';
import { executeQuery, prepareReadOnly, presetQuery } from './query.ts';
import type { ProviderList } from './types.ts';

const migrations = path.resolve(import.meta.dirname, '../../schema/migrations');

test('one read-only statement, respecting SQLite quotes, comments and CTE boundaries', () => {
  const db = openDb(':memory:');
  try {
    db.exec('CREATE TABLE contacts (id INTEGER)');
    for (const sql of [
      'UPDATE contacts SET id = 2',
      'DELETE FROM contacts',
      "ATTACH DATABASE ':memory:' AS other",
      'SELECT 1; SELECT 2',
      'SELECT 1; /* comment */ DELETE FROM contacts',
      'SELECT 1;\0SELECT 2',
      'WITH "select" AS (SELECT 1) DELETE FROM contacts RETURNING id',
      'WITH a(x) AS (VALUES(5)) UPDATE contacts SET id = (SELECT x FROM a) RETURNING id',
    ]) assert.throws(() => prepareReadOnly(db, sql), /query is read-only/);
    assert.equal(prepareReadOnly(db, "/* ; */ SELECT ';select' AS v; -- SELECT 2").get()?.v, ';select');
    assert.equal(prepareReadOnly(db, `
      -- Leading comment
      WITH RECURSIVE "weird; ()"(v) AS NOT MATERIALIZED (VALUES('a);')),
        other AS (SELECT v FROM "weird; ()") SELECT v FROM other;
    `).get()?.v, 'a);');
    assert.deepEqual(executeQuery(db, { sql: 'SELECT query_only FROM pragma_query_only' }, 50), { rows: [{ query_only: 1 }] });
  } finally {
    db.close();
  }
});

test('presets report known source membership, overlap, list, domain, status and consent counts', () => {
  const db = openDb(':memory:');
  try {
    migrate(db, migrations);
    db.exec(`
      INSERT INTO sources (name, kind, priority, updated_at) VALUES
        ('a', 'product', 1, '2026'), ('b', 'event', 2, '2026'), ('c', 'other', 3, '2026');
      INSERT INTO contacts (id, email, email_domain, email_status, flags, orphaned_at, created_at, updated_at) VALUES
        (1, 'shared@example.jp', 'example.jp', 'valid', '[]', NULL, '2026', '2026'),
        (2, 'alone@example.com', 'example.com', 'role', '["role_address"]', NULL, '2026', '2026'),
        (3, 'opted-out@example.jp', 'example.jp', 'valid', '[]', NULL, '2026', '2026'),
        (4, 'orphan@example.net', 'example.net', 'valid', '[]', '2026', '2026', '2026');
      INSERT INTO contact_sources (contact_id, source, raw_email, occurrences) VALUES
        (1, 'a', 'shared@example.jp', 2), (1, 'b', 'shared@example.jp', 1),
        (2, 'a', 'alone@example.com', 1), (3, 'b', 'opted-out@example.jp', 1);
      INSERT INTO consents (contact_id, source, status) VALUES
        (1, 'a', 'granted'), (1, 'b', 'unknown'), (3, 'b', 'denied');
    `);
    const run = (name: string, opts: { source?: string; notIn?: string; list?: ProviderList } = {}) => {
      const result = executeQuery(db, presetQuery(name, { ...opts, list: opts.list ?? 'strict' }), 50);
      assert.ok('rows' in result);
      return result;
    };
    assert.deepEqual(run('sources').rows, [
      { source: 'a', contacts: 2, rows: 3, granted: 1, denied: 0, unknown: 1 },
      { source: 'b', contacts: 2, rows: 2, granted: 0, denied: 1, unknown: 1 },
      { source: 'c', contacts: 0, rows: 0, granted: 0, denied: 0, unknown: 0 },
    ]);
    assert.deepEqual(run('overlap').rows, [
      { source_a: 'a', source_b: 'b', contacts: 1 },
      { source_a: 'a', source_b: 'c', contacts: 0 },
      { source_a: 'b', source_b: 'c', contacts: 0 },
    ]);
    assert.deepEqual(run('only-in', { source: 'a', notIn: 'b' }).rows, [{ id: 2, email: 'a***@e***e.com', name: null }]);
    assert.deepEqual(run('only-in', { source: "a' OR 1=1 --", notIn: 'b' }).rows, []);
    assert.equal(run('sendable').count, 1);
    assert.equal(run('sendable', { list: 'not_blocked' }).count, 2);
    assert.deepEqual(run('domains').rows.map((row) => row.contacts), [2, 1, 1]);
    assert.deepEqual(run('status').rows, [
      { kind: 'status', value: 'role', contacts: 1 },
      { kind: 'status', value: 'valid', contacts: 3 },
      { kind: 'flag', value: 'role_address', contacts: 1 },
    ]);
    assert.deepEqual(run('consent').rows, [
      { source: 'a', status: 'denied', contacts: 0 }, { source: 'a', status: 'granted', contacts: 1 },
      { source: 'a', status: 'unknown', contacts: 1 }, { source: 'b', status: 'denied', contacts: 1 },
      { source: 'b', status: 'granted', contacts: 0 }, { source: 'b', status: 'unknown', contacts: 1 },
      { source: 'c', status: 'denied', contacts: 0 }, { source: 'c', status: 'granted', contacts: 0 },
      { source: 'c', status: 'unknown', contacts: 0 },
    ]);
    assert.deepEqual(run('orphaned').rows, [{ id: 4, email: 'o***@e***e.net', orphaned_at: '2026' }]);
  } finally {
    db.close();
  }
});

test('R5-1 (D33): masking is fail-closed: computed columns and consent evidence never return a full name', () => {
  const db = openDb(':memory:');
  try {
    migrate(db, migrations);
    db.exec(`
      INSERT INTO sources (name, kind, priority, updated_at) VALUES ('a', 'product', 1, '2026');
      INSERT INTO contacts (id, email, email_domain, name, email_status, created_at, updated_at) VALUES
        (1, 'taro@example.jp', 'example.jp', 'Taro Yamada', 'valid', '2026-01-02', '2026-01-02');
      INSERT INTO contact_sources (contact_id, source, raw_email, raw_fields) VALUES
        (1, 'a', 'taro@example.jp', '{"Newsletter":"Taro Yamada","Memo":"call Hanako Sato"}');
      INSERT INTO consents (contact_id, source, status, evidence) VALUES
        (1, 'a', 'granted', '{"column":"Newsletter","value":"Taro Yamada","file":"a.csv","row_number":3}');
    `);
    const rows = (sql: string) => {
      const r = executeQuery(db, { sql }, 50);
      assert.ok('rows' in r);
      return r.rows;
    };
    const leaks = (value: unknown) => /Taro Yamada|Yamada|Hanako|taro@/.test(JSON.stringify(value));
    for (const sql of [
      'SELECT max(name) AS m FROM contacts',
      'SELECT group_concat(name) AS g FROM contacts',
      "SELECT coalesce(name, '') AS n FROM contacts",
      'SELECT upper(name) AS who FROM contacts',
      "SELECT name || '' AS x FROM contacts",
      'SELECT (SELECT name FROM contacts) AS sub',
      'SELECT evidence FROM consents',
      "SELECT json_extract(evidence, '$.value') AS v FROM consents",
      'SELECT raw_fields FROM contact_sources',
      "SELECT json_extract(raw_fields, '$.Memo') AS memo FROM contact_sources",
      'SELECT email, name, suggested_email FROM contacts',
    ]) assert.equal(leaks(rows(sql)), false, sql);
    // Known non-personal columns still read normally.
    assert.deepEqual(rows('SELECT id, email_status, created_at, flags FROM contacts'),
      [{ id: 1, email_status: 'valid', created_at: '2026-01-02', flags: [] }]);
    assert.deepEqual(rows('SELECT source, status FROM consents'), [{ source: 'a', status: 'granted' }]);
    const ev = rows('SELECT evidence FROM consents')[0]?.evidence as Record<string, unknown>;
    assert.deepEqual({ column: ev.column, file: ev.file, row_number: ev.row_number }, { column: 'Newsletter', file: 'a.csv', row_number: 3 });
  } finally {
    db.close();
  }
});
