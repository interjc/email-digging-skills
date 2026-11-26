// Tiny shared helpers for the CLI entry points (scripts/*.ts).

import { parseArgs } from 'node:util';
import { EXIT } from './types.ts';
import { PreconditionError } from './errors.ts';
import { sanitizeText } from './sanitize.ts';

/** Flags every command accepts. */
export const COMMON_OPTIONS = {
  workspace: { type: 'string' },
  json: { type: 'boolean', default: false },
} as const;

type OptionSpec = NonNullable<Parameters<typeof parseArgs>[0]>['options'];

export interface ParsedCli {
  values: Record<string, string | boolean | undefined>;
  positionals: string[];
}

/** `parseArgs` with the common flags (--workspace, --json) merged into `options`. */
export function parseCliArgs(argv: string[], options: OptionSpec = {}): ParsedCli {
  const { values, positionals } = parseArgs({
    args: argv,
    options: { ...COMMON_OPTIONS, ...options },
    allowPositionals: true,
  });
  return { values: values as ParsedCli['values'], positionals };
}

/**
 * Run a CLI main function and turn failures into exit codes:
 * PreconditionError → 2 (message and fix on stderr), any other error → 1.
 */
export async function runCli(main: () => Promise<number | void>): Promise<void> {
  try {
    const code = await main();
    process.exitCode = code ?? EXIT.OK;
  } catch (err) {
    if (err instanceof PreconditionError) {
      process.stderr.write(`${sanitizeText(err.message)}\n`);
      if (err.fix) process.stderr.write(`Fix: ${sanitizeText(err.fix)}\n`);
      process.exitCode = EXIT.PRECONDITION;
    } else {
      process.stderr.write(`Error: ${sanitizeText(err instanceof Error ? err.message : String(err))}\n`);
      process.exitCode = EXIT.ERROR;
    }
  }
}

/** Print warnings to stderr (stdout stays clean for --json). */
export function printWarnings(warnings: string[]): void {
  for (const w of warnings) process.stderr.write(`Warning: ${w}\n`);
}
