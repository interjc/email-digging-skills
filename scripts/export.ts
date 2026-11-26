// Phase 1: generate a local provider preview; never write to a provider or send mail.
import { loadProvider } from '../providers/index.ts';
import { parseCliArgs, printWarnings, runCli } from './lib/cli.ts';
import { openDb } from './lib/db.ts';
import { loadEnv } from './lib/env.ts';
import { PreconditionError } from './lib/errors.ts';
import { withWorkspaceLock } from './lib/lock.ts';
import { repoRoot, requireWorkspace } from './lib/paths.ts';
import { parseList, printJson, printText } from './lib/query.ts';
import type { PushPlan } from './lib/types.ts';

export async function main(argv: string[] = process.argv.slice(2), root: string = repoRoot()): Promise<void> {
  const { values, positionals } = parseCliArgs(argv, {
    provider: { type: 'string' }, list: { type: 'string' }, apply: { type: 'boolean' },
  });
  const { workspace, layout, warnings } = requireWorkspace({ workspace: values.workspace as string | undefined, repoRoot: root });
  printWarnings(warnings);
  if (values.apply === true) {
    throw new PreconditionError('applying to a provider is not available in phase 1; it will require explicit human confirmation');
  }
  if (positionals.length > 0 || typeof values.provider !== 'string' || !values.provider) {
    throw new Error('--provider <name> is required');
  }
  const list = parseList(values.list);

  const plan = await withWorkspaceLock(workspace, 'export', async () => {
    const provider = await loadProvider(values.provider as string);
    if (list === 'not_blocked') {
      printText('Warning: not_blocked includes contacts without positive consent and may include unresolved typo suspects.', process.stderr);
    }
    const fileEnv = loadEnv(root);
    const env = Object.fromEntries(provider.envKeys.map((key) => [key, Object.hasOwn(fileEnv, key) ? fileEnv[key] : undefined]));
    const db = openDb(layout.dbPath);
    try {
      const insert = db.prepare(`
        INSERT INTO sync_log (provider, direction, dry_run, started_at, finished_at, counts, status)
        VALUES (?, 'push', 1, ?, ?, ?, ?)`);
      const started = new Date().toISOString();
      let result: PushPlan;
      try {
        result = await provider.pushContacts({
          workspace, dbPath: layout.dbPath, env, dryRun: true,
          log: (line) => printText(line, process.stderr),
        }, { list });
      } catch (err) {
        insert.run(provider.name, started, new Date().toISOString(), '{}', 'failed');
        throw err;
      }
      const { to_add, to_update, to_remove } = result;
      insert.run(provider.name, started, new Date().toISOString(), JSON.stringify({ to_add, to_update, to_remove }), 'ok');
      return result;
    } finally {
      db.close();
    }
  });

  if (values.json === true) printJson(plan);
  else {
    printText(`${plan.provider} ${plan.list} dry run: ${plan.to_add} to add, ${plan.to_update} to update, ${plan.to_remove} to remove.`);
    if (plan.export_file) printText(plan.export_file);
    for (const note of plan.notes) printText(note);
  }
}

if (import.meta.main) await runCli(main);
