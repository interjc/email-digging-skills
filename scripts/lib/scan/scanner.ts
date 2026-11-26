import { execFileSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { maskEmail } from '../mask.ts';
import { isZipBuffer, readZipEntries } from './zip.ts';

export interface EmailFinding {
  file: string;
  line: number;
  masked: string;
}

export interface ScanResult {
  ok: boolean;
  mode: 'staged' | 'all';
  filesScanned: number;
  findings: EmailFinding[];
}

export class GitScanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitScanError';
  }
}

const MAX_GIT_BUFFER = 64 * 1024 * 1024;
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'ascii');
const ALLOW_DIRECTIVE = 'email-scan:allow';
const STANDARD_EXAMPLE_TLDS = new Set(['com', 'jp', 'net', 'org']);
const EXAMPLE_SECOND_LEVEL = new Set(['co', 'ne', 'or', 'ac', 'go', 'gr', 'ed', 'ad', 'lg']);

/**
 * Match email-like `local@domain` tokens including masked forms (`*`) and legacy mobile
 * local dots, while avoiding false matches on semver (`pkg@1.2.3`) and allowing
 * sentence-ending periods (`addr@example.com.`).
 */
const EMAIL_PATTERN =
  /(?<![A-Za-z0-9._%+*-])([A-Za-z0-9*][A-Za-z0-9._%+*-]{0,63})@([A-Za-z0-9*](?:[A-Za-z0-9*-]{0,61}[A-Za-z0-9*])?(?:\.[A-Za-z0-9*](?:[A-Za-z0-9*-]{0,61}[A-Za-z0-9*])?)*\.[A-Za-z]{2,}|localhost)(?![A-Za-z0-9-]|\.[A-Za-z0-9])/g;

/**
 * Determine whether a matched email token is allowed under rule R7:
 * - masked forms containing `*`
 * - `localhost`
 * - `*.example`, `*.test`, `*.invalid`
 * - `example.com|jp|net|org`, subdomains thereof, and `example.<suffix>` typo test variants
 *   (e.g. `example.con`, `example.co.jo`, `example.ne.jo`)
 */
export function isAllowedEmail(candidate: string): boolean {
  if (candidate.includes('*')) {
    return true;
  }

  const atIndex = candidate.lastIndexOf('@');
  if (atIndex <= 0) {
    return false;
  }
  const domain = candidate.slice(atIndex + 1).toLowerCase();

  if (domain === 'localhost') {
    return true;
  }
  if (
    domain.endsWith('.example') ||
    domain.endsWith('.test') ||
    domain.endsWith('.invalid')
  ) {
    return true;
  }

  const labels = domain.split('.');
  if (labels.length === 2 && labels[0] === 'example') {
    // Covers example.com/jp/net/org and typo test variants like example.con, example.cmo
    return true;
  }
  if (labels.length === 3 && labels[0] === 'example') {
    // Covers example.co.jp, example.co.jo, example.ne.jp, example.ne.jo, example.or.jo, etc.
    const sld = labels[1] ?? '';
    if (EXAMPLE_SECOND_LEVEL.has(sld)) {
      return true;
    }
  }
  if (labels.length >= 3) {
    const secondLast = labels[labels.length - 2] ?? '';
    const last = labels[labels.length - 1] ?? '';
    if (secondLast === 'example' && STANDARD_EXAMPLE_TLDS.has(last)) {
      return true;
    }
  }
  if (labels.length >= 4) {
    const thirdLast = labels[labels.length - 3] ?? '';
    const secondLast = labels[labels.length - 2] ?? '';
    const last = labels[labels.length - 1] ?? '';
    if (
      thirdLast === 'example' &&
      EXAMPLE_SECOND_LEVEL.has(secondLast) &&
      (last === 'jp' || last === 'jo')
    ) {
      return true;
    }
  }

  return false;
}

interface InternalFinding extends EmailFinding {
  dedupeKey: string;
}

function scanTextInternal(text: string, file: string): InternalFinding[] {
  const findings: InternalFinding[] = [];
  const lines = text.split(/\r\n|\r|\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.includes(ALLOW_DIRECTIVE)) {
      continue;
    }
    const normalizedLine = line.normalize('NFKC');
    if (!normalizedLine.includes('@')) {
      continue;
    }

    const lineNo = i + 1;
    for (const match of normalizedLine.matchAll(EMAIL_PATTERN)) {
      const candidate = match[0];
      if (isAllowedEmail(candidate)) {
        continue;
      }
      findings.push({
        file,
        line: lineNo,
        masked: maskEmail(candidate),
        dedupeKey: `${lineNo}:${candidate.toLowerCase()}`,
      });
    }
  }

  return findings;
}

export function scanText(text: string, file: string): EmailFinding[] {
  return dedupeFindings(scanTextInternal(text, file));
}

function dedupeFindings(items: InternalFinding[]): EmailFinding[] {
  const seen = new Set<string>();
  const out: EmailFinding[] = [];
  for (const item of items) {
    if (seen.has(item.dedupeKey)) {
      continue;
    }
    seen.add(item.dedupeKey);
    out.push({ file: item.file, line: item.line, masked: item.masked });
  }
  return out;
}

function decodeXmlEntities(xml: string): string {
  return xml.replace(
    /&(#x[0-9a-fA-F]+|#\d+|lt|gt|amp|quot|apos);/g,
    (full, entity: string) => {
      switch (entity) {
        case 'lt':
          return '<';
        case 'gt':
          return '>';
        case 'amp':
          return '&';
        case 'quot':
          return '"';
        case 'apos':
          return "'";
        default: {
          if (entity.startsWith('#x') || entity.startsWith('#X')) {
            const code = Number.parseInt(entity.slice(2), 16);
            return Number.isFinite(code) ? String.fromCodePoint(code) : full;
          }
          if (entity.startsWith('#')) {
            const code = Number.parseInt(entity.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : full;
          }
          return full;
        }
      }
    },
  );
}

function scanBinaryAsciiInternal(buf: Buffer, file: string): InternalFinding[] {
  const findings: InternalFinding[] = [];
  let lineNo = 1;
  let runStart = -1;
  let runLine = 1;

  const flushRun = (end: number): void => {
    if (runStart < 0) {
      return;
    }
    if (end - runStart >= 6) {
      const run = buf.subarray(runStart, end).toString('ascii');
      if (run.includes('@') && !run.includes(ALLOW_DIRECTIVE)) {
        for (const match of run.matchAll(EMAIL_PATTERN)) {
          const candidate = match[0];
          if (isAllowedEmail(candidate)) {
            continue;
          }
          findings.push({
            file,
            line: runLine,
            masked: maskEmail(candidate),
            dedupeKey: `${runLine}:${candidate.toLowerCase()}`,
          });
        }
      }
    }
    runStart = -1;
  };

  for (let i = 0; i < buf.length; i += 1) {
    const byte = buf[i] ?? 0;
    const isPrintable = (byte >= 0x20 && byte <= 0x7e) || byte === 0x09;
    if (isPrintable) {
      if (runStart < 0) {
        runStart = i;
        runLine = lineNo;
      }
    } else {
      flushRun(i);
      if (byte === 0x0a) {
        lineNo += 1;
      }
    }
  }
  flushRun(buf.length);

  return findings;
}

function tryDecode(buf: Buffer, encoding: string): string | null {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

interface SqliteModule {
  DatabaseSync: new (
    location: string,
    options?: { readOnly?: boolean },
  ) => {
    prepare(sql: string): { all(): Array<Record<string, unknown>> };
    close(): void;
  };
}

function scanSqliteBufferInternal(buf: Buffer, file: string): InternalFinding[] | null {
  const getBuiltin = (
    process as unknown as { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;
  const sqliteMod = getBuiltin?.('node:sqlite') as SqliteModule | undefined;
  if (!sqliteMod?.DatabaseSync) {
    return null;
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'email-scan-sqlite-'));
  const tempPath = join(tempDir, 'staged.sqlite');
  let db: InstanceType<SqliteModule['DatabaseSync']> | null = null;

  try {
    writeFileSync(tempPath, buf);
    db = new sqliteMod.DatabaseSync(tempPath, { readOnly: true });
    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
      )
      .all();

    const findings: InternalFinding[] = [];
    for (const tableRow of tables) {
      const tableName = tableRow['name'];
      if (typeof tableName !== 'string') {
        continue;
      }
      const quoted = `"${tableName.replaceAll('"', '""')}"`;
      const rows = db.prepare(`SELECT * FROM ${quoted}`).all();
      for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        if (!row) {
          continue;
        }
        const rowLine = rowIndex + 1;
        for (const value of Object.values(row)) {
          if (typeof value !== 'string' || value.length === 0) {
            continue;
          }
          const normalized = value.normalize('NFKC');
          if (!normalized.includes('@')) {
            continue;
          }
          for (const match of normalized.matchAll(EMAIL_PATTERN)) {
            const candidate = match[0];
            if (isAllowedEmail(candidate)) {
              continue;
            }
            findings.push({
              file,
              line: rowLine,
              masked: maskEmail(candidate),
              dedupeKey: `${rowLine}:${candidate.toLowerCase()}`,
            });
          }
        }
      }
    }
    return findings;
  } catch {
    return null;
  } finally {
    try {
      db?.close();
    } catch {
      // ignore close errors on cleanup
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function detectBomlessUtf16(buf: Buffer): 'utf-16le' | 'utf-16be' | null {
  if (buf.length < 4 || buf.length % 2 !== 0) {
    return null;
  }
  const samplePairs = Math.min(buf.length / 2, 512);
  let evenZero = 0;
  let oddZero = 0;
  for (let i = 0; i < samplePairs; i += 1) {
    if (buf[i * 2] === 0) {
      evenZero += 1;
    }
    if (buf[i * 2 + 1] === 0) {
      oddZero += 1;
    }
  }
  if (oddZero / samplePairs > 0.3 && evenZero / samplePairs < 0.05) {
    return 'utf-16le';
  }
  if (evenZero / samplePairs > 0.3 && oddZero / samplePairs < 0.05) {
    return 'utf-16be';
  }
  return null;
}

/**
 * Scan raw file bytes for disallowed email addresses according to rule R7:
 * - `.xlsx`: unzipped in memory and XML entries scanned
 * - SQLite: table cells scanned cleanly via node:sqlite (falling back to ASCII runs)
 * - Text with BOM: UTF-8, UTF-16LE, UTF-16BE
 * - Text without BOM: UTF-8, then cp932 (`shift_jis`) and `gb18030`
 * - Other binaries: ASCII runs (plus BOM-less UTF-16 detection)
 */
export function scanBuffer(buf: Buffer, file: string): EmailFinding[] {
  if (buf.length === 0) {
    return [];
  }

  // 1. XLSX (ZIP container with XML sheets/sharedStrings)
  if (file.toLowerCase().endsWith('.xlsx') && isZipBuffer(buf)) {
    try {
      const entries = readZipEntries(buf);
      const findings: InternalFinding[] = [];
      for (const entry of entries) {
        const lower = entry.name.toLowerCase();
        if (!lower.endsWith('.xml') && !lower.endsWith('.rels')) {
          continue;
        }
        const xmlText = decodeXmlEntities(
          new TextDecoder('utf-8', { fatal: false }).decode(entry.data),
        );
        findings.push(...scanTextInternal(xmlText, file));
      }
      return dedupeFindings(findings);
    } catch {
      return dedupeFindings(scanBinaryAsciiInternal(buf, file));
    }
  }

  // 2. SQLite database header
  if (buf.length >= SQLITE_MAGIC.length && buf.subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC)) {
    const sqliteFindings = scanSqliteBufferInternal(buf, file);
    if (sqliteFindings !== null) {
      return dedupeFindings(sqliteFindings);
    }
    return dedupeFindings(scanBinaryAsciiInternal(buf, file));
  }

  // 3. Explicit Unicode BOMs
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    const decoded = tryDecode(buf.subarray(3), 'utf-8');
    if (decoded !== null) {
      return dedupeFindings(scanTextInternal(decoded, file));
    }
  } else if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    const decoded = tryDecode(buf.subarray(2), 'utf-16le');
    if (decoded !== null) {
      return dedupeFindings(scanTextInternal(decoded, file));
    }
  } else if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const decoded = tryDecode(buf.subarray(2), 'utf-16be');
    if (decoded !== null) {
      return dedupeFindings(scanTextInternal(decoded, file));
    }
  }

  // 4. NUL bytes present without a BOM: BOM-less UTF-16 or binary
  if (buf.includes(0)) {
    const findings: InternalFinding[] = [];
    const utf16 = detectBomlessUtf16(buf);
    if (utf16 !== null) {
      const decoded = tryDecode(buf, utf16);
      if (decoded !== null) {
        findings.push(...scanTextInternal(decoded, file));
      }
    }
    findings.push(...scanBinaryAsciiInternal(buf, file));
    return dedupeFindings(findings);
  }

  // 5. Text without BOM or NUL: try UTF-8, then cp932 (shift_jis) and gb18030
  const utf8 = tryDecode(buf, 'utf-8');
  if (utf8 !== null) {
    return dedupeFindings(scanTextInternal(utf8, file));
  }

  const legacyFindings: InternalFinding[] = [];
  let decodedAny = false;

  const cp932 = tryDecode(buf, 'shift_jis');
  if (cp932 !== null) {
    decodedAny = true;
    legacyFindings.push(...scanTextInternal(cp932, file));
  }

  const gb18030 = tryDecode(buf, 'gb18030');
  if (gb18030 !== null) {
    decodedAny = true;
    legacyFindings.push(...scanTextInternal(gb18030, file));
  }

  if (decodedAny) {
    return dedupeFindings(legacyFindings);
  }

  // 6. Fallback: ASCII runs
  return dedupeFindings(scanBinaryAsciiInternal(buf, file));
}

function runGitBuffer(args: string[], cwd: string): Buffer {
  try {
    return execFileSync('git', args, {
      cwd,
      maxBuffer: MAX_GIT_BUFFER,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const detail =
      err instanceof Error && 'stderr' in err && Buffer.isBuffer(err.stderr)
        ? err.stderr.toString('utf8').trim()
        : err instanceof Error
          ? err.message
          : String(err);
    throw new GitScanError(`git ${args.join(' ')} failed: ${detail}`);
  }
}

function splitNullDelimited(buf: Buffer): string[] {
  if (buf.length === 0) {
    return [];
  }
  return buf
    .toString('utf8')
    .split('\0')
    .filter((entry) => entry.length > 0);
}

/**
 * Scan either staged files in the git index (default) or all git-tracked files (`all: true`).
 * Staged mode reads blobs directly from the index via `git show :<path>` so unstaged edits
 * do not affect the result.
 */
export function scanRepository(opts?: { all?: boolean; cwd?: string }): ScanResult {
  const cwd = opts?.cwd ?? process.cwd();
  const mode = opts?.all ? 'all' : 'staged';

  const repoRoot = runGitBuffer(['rev-parse', '--show-toplevel'], cwd)
    .toString('utf8')
    .trim();

  const files =
    mode === 'all'
      ? splitNullDelimited(runGitBuffer(['ls-files', '-z'], repoRoot))
      : splitNullDelimited(
          runGitBuffer(
            ['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'],
            repoRoot,
          ),
        );

  const findings: EmailFinding[] = [];
  let filesScanned = 0;

  for (const relPath of files) {
    let content: Buffer;
    if (mode === 'staged') {
      content = runGitBuffer(['show', `:${relPath}`], repoRoot);
    } else {
      const fullPath = join(repoRoot, relPath);
      let stat;
      try {
        stat = lstatSync(fullPath);
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        // Skip symlinks (e.g. .claude/skills -> ../skills) and gitlinks/directories
        continue;
      }
      content = readFileSync(fullPath);
    }

    filesScanned += 1;
    findings.push(...scanBuffer(content, relPath));
  }

  return {
    ok: findings.length === 0,
    mode,
    filesScanned,
    findings,
  };
}
