import { GitScanError, scanRepository } from './lib/scan/scanner.ts';

function printUsage(): void {
  process.stdout.write(
    'Usage: node scripts/check-staged-emails.ts [--all] [--json]\n' +
      '  --all   Scan all git-tracked files (git ls-files) instead of staged files\n' +
      '  --json  Print machine-readable JSON output (masked addresses only)\n',
  );
}

function main(argv: string[]): number {
  let all = false;
  let json = false;

  for (const arg of argv) {
    if (arg === '--all') {
      all = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      printUsage();
      return 0;
    } else {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      return 2;
    }
  }

  try {
    const result = scanRepository({ all });

    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      for (const finding of result.findings) {
        process.stdout.write(`${finding.file}:${finding.line}: ${finding.masked}\n`);
      }
    }

    return result.ok ? 0 : 1;
  } catch (err) {
    if (err instanceof GitScanError) {
      process.stderr.write(`${err.message}\n`);
      return 2;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Email scan failed: ${message}\n`);
    return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
