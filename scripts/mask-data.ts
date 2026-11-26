// Produce a shareable, pseudonymized database copy, never change the main database.
import path from 'node:path';
import { parseCliArgs, printWarnings, runCli } from './lib/cli.ts';
import { loadConfig } from './lib/config.ts';
import { loadEnv } from './lib/env.ts';
import { PreconditionError } from './lib/errors.ts';
import { withWorkspaceLock } from './lib/lock.ts';
import { writeMaskedCopy } from './lib/masked-copy.ts';
import { repoRoot, requireWorkspace } from './lib/paths.ts';
import { printJson, printText } from './lib/query.ts';

const SHARE_NOTE = 'Only output/masked/ may leave this machine. Review masked files before sharing.';

export async function main(argv: string[] = process.argv.slice(2), root: string = repoRoot()): Promise<void> {
  const { values, positionals } = parseCliArgs(argv, { 'hash-domain': { type: 'boolean' }, shape: { type: 'boolean' } });
  const { workspace, layout, warnings } = requireWorkspace({ workspace: values.workspace as string | undefined, repoRoot: root });
  printWarnings(warnings);
  if (positionals.length) throw new Error('Usage: mask-data [--hash-domain] [--shape] [--workspace <path>] [--json]');

  const result = await withWorkspaceLock(workspace, 'mask-data', () => {
    const key = loadEnv(root).MASK_HMAC_KEY;
    if (!key?.trim()) throw new PreconditionError('MASK_HMAC_KEY is missing; run init-workspace.');
    const config = loadConfig({
      workspace, repoRoot: root, onWarning: (warning) => printWarnings([warning]),
    });
    return writeMaskedCopy(layout, path.join(root, 'schema', 'migrations'), {
      key, keepDomain: config.masking.keep_domain && values['hash-domain'] !== true, shape: values.shape === true,
    });
  });
  if (values.json === true) printJson({ ...result, note: SHARE_NOTE });
  else {
    printText(`${result.masked_db} (${result.rows.contacts} contacts; domains ${result.keep_domain ? 'kept' : 'hashed'})`);
    if (result.shape_file) printText(result.shape_file);
    printText(SHARE_NOTE);
  }
}

if (import.meta.main) await runCli(main);
