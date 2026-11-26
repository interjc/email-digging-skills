// Read-only inspection. Full results are written only to output/exports/ when requested.
import { parseCliArgs, printWarnings, runCli } from './lib/cli.ts';
import { openDb } from './lib/db.ts';
import { requireWorkspace } from './lib/paths.ts';
import { executeQuery, parseList, presetQuery, printJson, printText, requireOutputDir } from './lib/query.ts';

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseCliArgs(argv, {
    sql: { type: 'string' }, preset: { type: 'string' }, limit: { type: 'string' },
    source: { type: 'string' }, 'not-in': { type: 'string' }, list: { type: 'string' }, out: { type: 'boolean' },
  });
  const { workspace, layout, warnings } = requireWorkspace({ workspace: values.workspace as string | undefined });
  printWarnings(warnings);

  if (positionals.length > 0 || (values.sql === undefined) === (values.preset === undefined)) {
    throw new Error('Choose one of --sql "<SELECT …>" or --preset <name>.');
  }
  const limit = Number(values.limit ?? 50);
  if (!/^\d+$/.test(String(values.limit ?? 50)) || !Number.isSafeInteger(limit) || limit < 1) {
    throw new Error('--limit must be a positive integer');
  }
  const query = values.sql !== undefined ? { sql: String(values.sql) } : presetQuery(String(values.preset), {
    source: values.source as string | undefined, notIn: values['not-in'] as string | undefined, list: parseList(values.list),
  });
  const db = openDb(layout.dbPath, { readonly: true });
  try {
    db.exec('BEGIN');
    const exportsDir = values.out === true ? requireOutputDir(workspace, layout.exports) : undefined;
    const result = executeQuery(db, query, limit, exportsDir);
    db.exec('COMMIT');
    if ('export_file' in result && values.json !== true) printText(`${result.export_file} (${result.row_count} rows)`);
    else printJson(result);
  } finally {
    db.close();
  }
}

if (import.meta.main) await runCli(main);
