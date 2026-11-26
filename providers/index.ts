import fs from 'node:fs';
import path from 'node:path';
import type { Provider } from '../scripts/lib/types.ts';
import { sanitizeText } from '../scripts/lib/sanitize.ts';

const PROVIDER_NAME = /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/;

export async function loadProvider(name: string): Promise<Provider> {
  const available = fs.readdirSync(import.meta.dirname, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && PROVIDER_NAME.test(entry.name) &&
      fs.existsSync(path.join(import.meta.dirname, entry.name, 'index.ts')))
    .map((entry) => entry.name).sort();
  if (!available.includes(name)) {
    throw new Error(`Unknown provider. Available providers: ${available.join(', ') || '(none)'}.`);
  }
  const { default: provider } = await import(`./${name}/index.ts`) as { default?: Provider };
  if (!provider || provider.name !== name || !Array.isArray(provider.envKeys) ||
      typeof provider.pushContacts !== 'function' || typeof provider.pullSuppressions !== 'function') {
    throw new Error(sanitizeText(`Provider "${name}" has an invalid default export.`));
  }
  return provider;
}
