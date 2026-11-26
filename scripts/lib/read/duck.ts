// One shared in-memory DuckDB instance for reading sources and writing staging files.

import { DuckDBInstance } from '@duckdb/node-api';
import type { DuckDBConnection } from '@duckdb/node-api';

let instancePromise: Promise<DuckDBInstance> | null = null;
const loaded = new Set<string>();

function instance(): Promise<DuckDBInstance> {
  instancePromise ??= DuckDBInstance.create(':memory:');
  return instancePromise;
}

export async function connect(): Promise<DuckDBConnection> {
  return (await instance()).connect();
}

/** LOAD an extension, installing it first when needed (INSTALL may need network once). */
export async function ensureExtension(name: 'excel' | 'sqlite' | 'json' | 'parquet'): Promise<void> {
  if (loaded.has(name)) return;
  const conn = await connect();
  try {
    try {
      await conn.run(`LOAD ${name}`);
    } catch {
      try {
        await conn.run(`INSTALL ${name}`);
        await conn.run(`LOAD ${name}`);
      } catch (err) {
        throw new Error(
          `DuckDB extension "${name}" is not available (${(err as Error).message.split('\n')[0]}). ` +
          'Run `pnpm init-workspace` once with network access to install it.',
        );
      }
    }
  } finally {
    conn.closeSync();
  }
  loaded.add(name);
}

/** SQL string literal. */
export function sqlStr(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

/** SQL identifier. */
export function sqlIdent(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}
