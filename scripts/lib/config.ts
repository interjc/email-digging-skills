// config.yaml loader (user-owned, git-ignored, at the repository root). Defaults mirror
// config.example.yaml, so a missing config.yaml behaves like the example.

import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { ConsentBasis, PipelineConfig } from './types.ts';
import { repoRoot, resolveWorkspace } from './paths.ts';
import type { ResolveOpts } from './paths.ts';

export interface LoadConfigOpts extends ResolveOpts {
  /** Receives unknown-key warnings. Default: print to stderr. */
  onWarning?: (message: string) => void;
}

const CONSENT_BASES: readonly ConsentBasis[] = ['opt_in', 'transactional', 'unknown'];

const KNOWN_KEYS: Record<string, readonly string[] | null> = {
  workspace: null,
  sources: ['priority'],
  consent: ['opt_in_bases', 'opt_in_sources'],
  masking: ['keep_domain'],
  backups: ['keep'],
};

export const DEFAULTS = {
  sources: { priority: [] as string[] },
  consent: { opt_in_bases: ['opt_in'] as ConsentBasis[], opt_in_sources: [] as string[] },
  masking: { keep_domain: true },
  backups: { keep: 20 },
} as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function section(doc: Record<string, unknown>, name: string): Record<string, unknown> {
  const v = doc[name];
  if (v === undefined || v === null) return {};
  if (!isRecord(v)) throw new Error(`config.yaml: "${name}" must be a mapping.`);
  return v;
}

function stringList(v: unknown, label: string, fallback: readonly string[]): string[] {
  if (v === undefined || v === null) return [...fallback];
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
    throw new Error(`config.yaml: "${label}" must be a list of strings.`);
  }
  return v as string[];
}

/** Parse and validate config text (no file access). Returns the config without the workspace path resolved. */
export function parseConfig(text: string): { config: Omit<PipelineConfig, 'workspace'>; warnings: string[] } {
  let doc: unknown;
  try {
    doc = parseYaml(text);
  } catch (err) {
    throw new Error(`config.yaml is not valid YAML: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (doc === null || doc === undefined) doc = {};
  if (!isRecord(doc)) throw new Error('config.yaml: the top level must be a mapping.');

  const warnings: string[] = [];
  for (const [key, value] of Object.entries(doc)) {
    const known = KNOWN_KEYS[key];
    if (known === undefined) {
      warnings.push(`config.yaml: unknown key "${key}" (ignored).`);
    } else if (known !== null && isRecord(value)) {
      for (const sub of Object.keys(value)) {
        if (!known.includes(sub)) warnings.push(`config.yaml: unknown key "${key}.${sub}" (ignored).`);
      }
    }
  }

  if (doc.workspace !== undefined && doc.workspace !== null && typeof doc.workspace !== 'string') {
    throw new Error('config.yaml: "workspace" must be a string.');
  }

  const sources = section(doc, 'sources');
  const consent = section(doc, 'consent');
  const masking = section(doc, 'masking');
  const backups = section(doc, 'backups');

  const bases = stringList(consent.opt_in_bases, 'consent.opt_in_bases', DEFAULTS.consent.opt_in_bases);
  for (const b of bases) {
    if (!(CONSENT_BASES as readonly string[]).includes(b)) {
      throw new Error(`config.yaml: consent.opt_in_bases has "${b}"; allowed: ${CONSENT_BASES.join(', ')}.`);
    }
  }

  let keepDomain: boolean = DEFAULTS.masking.keep_domain;
  if (masking.keep_domain !== undefined && masking.keep_domain !== null) {
    if (typeof masking.keep_domain !== 'boolean') throw new Error('config.yaml: "masking.keep_domain" must be true or false.');
    keepDomain = masking.keep_domain;
  }

  let keep: number = DEFAULTS.backups.keep;
  if (backups.keep !== undefined && backups.keep !== null) {
    if (typeof backups.keep !== 'number' || !Number.isInteger(backups.keep) || backups.keep < 1) {
      throw new Error('config.yaml: "backups.keep" must be an integer >= 1.');
    }
    keep = backups.keep;
  }

  return {
    config: {
      sources: { priority: stringList(sources.priority, 'sources.priority', DEFAULTS.sources.priority) },
      consent: {
        opt_in_bases: bases as ConsentBasis[],
        opt_in_sources: stringList(consent.opt_in_sources, 'consent.opt_in_sources', DEFAULTS.consent.opt_in_sources),
      },
      masking: { keep_domain: keepDomain },
      backups: { keep },
    },
    warnings,
  };
}

/** Load `<repo>/config.yaml` (defaults when missing) and resolve the workspace path. */
export function loadConfig(opts: LoadConfigOpts = {}): PipelineConfig {
  const root = opts.repoRoot ?? repoRoot();
  let text = '';
  try {
    text = fs.readFileSync(path.join(root, 'config.yaml'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const { config, warnings } = parseConfig(text);
  const report = opts.onWarning ?? ((m: string) => process.stderr.write(`Warning: ${m}\n`));
  for (const w of warnings) report(w);
  return { workspace: resolveWorkspace({ ...opts, repoRoot: root }), ...config };
}
