// Minimal .env reader. Values are secrets: this module never logs them.

import fs from 'node:fs';
import path from 'node:path';

/** Parse the text of a .env file: KEY=VALUE lines, `#` comments, optional single/double quotes. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    let value = (m[2] as string).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length >= 2) {
      const end = value.indexOf(quote, 1);
      value = end === -1 ? value.slice(1) : value.slice(1, end);
    } else {
      // Unquoted: a ` #` starts an inline comment.
      const hash = value.search(/\s#/);
      if (hash !== -1) value = value.slice(0, hash).trim();
    }
    out[key] = value;
  }
  return out;
}

/** Read `<repoRoot>/.env`. A missing file gives `{}`. */
export function loadEnv(repoRoot: string): Record<string, string> {
  const file = path.join(repoRoot, '.env');
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  return parseEnv(text);
}

/**
 * Return `text` with KEY set to `value`, editing the assignment the parser reads (the last one for that
 * key) and nothing else. Appends `KEY=value` when the key is absent. `value` is written as given: callers
 * pass values that need no quoting (hex keys).
 */
export function setEnvValue(text: string, key: string, value: string): string {
  const lines = text.split('\n');
  const assignment = new RegExp(`^(\\s*(?:export\\s+)?${key}\\s*=).*?(\\r?)$`);
  let last = -1;
  lines.forEach((line, i) => {
    if (assignment.test(line)) last = i;
  });
  if (last === -1) return `${text}${text === '' || text.endsWith('\n') ? '' : '\n'}${key}=${value}\n`;
  lines[last] = (lines[last] as string).replace(assignment, (_m, head: string, cr: string) => `${head}${value}${cr}`);
  return lines.join('\n');
}
