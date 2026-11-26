// Human decisions in <workspace>/overrides/*.yaml (D14). Read on every run; a missing file = [].
// Emails are only lowercased and trimmed here; full normalization happens during staging.

import fs from 'node:fs';
import path from 'node:path';
import type { ConsentStatus, Overrides, SuppressionReason } from './types.ts';
import { parseYamlSafe, sanitizeError } from './sanitize.ts';

const SUPPRESSION_REASONS: readonly SuppressionReason[] = ['unsubscribed', 'bounced', 'complained', 'manual'];
const CONSENT_STATUSES: readonly ConsentStatus[] = ['granted', 'denied', 'unknown'];

type Entry = Record<string, unknown>;

function readList(file: string): Entry[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const name = path.basename(file);
  // The parser's own messages quote source lines (which may hold addresses): report code and position only.
  const parsed = parseYamlSafe(text);
  if (parsed.errors.length > 0) throw new Error(`${name} is not valid YAML (${parsed.errors.join('; ')}).`);
  // A warning (e.g. an unresolved tag) means a value would be read differently from what was written;
  // these files are human decisions, so stop instead of guessing.
  if (parsed.warnings.length > 0) throw new Error(`${name} has a YAML warning (${parsed.warnings.join('; ')}); fix it and run again.`);
  const doc = parsed.value;
  if (doc === null || doc === undefined) return [];
  if (!Array.isArray(doc)) throw new Error(`${name}: expected a list of entries at the top level.`);
  return doc.map((entry, i) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${name}: entry ${i + 1} must be a mapping.`);
    }
    return entry as Entry;
  });
}

function str(entry: Entry, key: string, file: string, i: number, required: boolean): string | undefined {
  const v = entry[key];
  if (v === undefined || v === null) {
    if (required) throw new Error(`${file}: entry ${i + 1} is missing "${key}".`);
    return undefined;
  }
  if (typeof v !== 'string' || v.trim() === '') {
    throw new Error(`${file}: entry ${i + 1}: "${key}" must be a non-empty string.`);
  }
  return v;
}

function email(entry: Entry, file: string, i: number): string {
  const v = (str(entry, 'email', file, i, true) as string).trim().toLowerCase();
  return v;
}

function oneOf<T extends string>(v: string | undefined, allowed: readonly T[], key: string, file: string, i: number): T {
  if (v === undefined || !(allowed as readonly string[]).includes(v)) {
    throw new Error(`${file}: entry ${i + 1}: "${key}" must be one of ${allowed.join(', ')}.`);
  }
  return v as T;
}

/** Only set optional keys that are present, so results compare cleanly. */
function withNote<T extends object>(base: T, note: string | undefined): T & { note?: string } {
  return note === undefined ? base : { ...base, note };
}

/** Load the four override files. Error messages never contain file content (D28). */
export function loadOverrides(dir: string): Overrides {
  try {
    return loadOverridesUnsafe(dir);
  } catch (err) {
    throw new Error(sanitizeError(err));
  }
}

function loadOverridesUnsafe(dir: string): Overrides {
  const typoFile = 'typo-decisions.yaml';
  const typo = readList(path.join(dir, typoFile)).map((e, i) => {
    const action = oneOf(str(e, 'action', typoFile, i, true), ['accept', 'reject'] as const, 'action', typoFile, i);
    const suggested = str(e, 'suggested', typoFile, i, false);
    const base: Overrides['typo'][number] = { email: email(e, typoFile, i), action };
    if (suggested !== undefined) base.suggested = suggested.trim().toLowerCase();
    return withNote(base, str(e, 'note', typoFile, i, false));
  });

  const supFile = 'suppressions.yaml';
  const suppressions = readList(path.join(dir, supFile)).map((e, i) =>
    withNote(
      {
        email: email(e, supFile, i),
        reason: oneOf(str(e, 'reason', supFile, i, true), SUPPRESSION_REASONS, 'reason', supFile, i),
      },
      str(e, 'note', supFile, i, false),
    ),
  );

  const conFile = 'consents.yaml';
  const consents = readList(path.join(dir, conFile)).map((e, i) =>
    withNote(
      {
        email: email(e, conFile, i),
        source: str(e, 'source', conFile, i, true) as string,
        status: oneOf(str(e, 'status', conFile, i, true), CONSENT_STATUSES, 'status', conFile, i),
      },
      str(e, 'note', conFile, i, false),
    ),
  );

  const exFile = 'exclude.yaml';
  const exclude = readList(path.join(dir, exFile)).map((e, i) => {
    const rawEmail = str(e, 'email', exFile, i, false);
    const pattern = str(e, 'pattern', exFile, i, false);
    if ((rawEmail === undefined) === (pattern === undefined)) {
      throw new Error(`${exFile}: entry ${i + 1} needs exactly one of "email" or "pattern".`);
    }
    const base: Overrides['exclude'][number] = {};
    if (rawEmail !== undefined) base.email = rawEmail.trim().toLowerCase();
    if (pattern !== undefined) base.pattern = pattern.trim().toLowerCase();
    return withNote(base, str(e, 'note', exFile, i, false));
  });

  return { typo, suppressions, consents, exclude };
}
