import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadProvider } from '../index.ts';
import { PreconditionError } from '../../scripts/lib/errors.ts';
import type { ProviderContext } from '../../scripts/lib/types.ts';

test('Listmonk adapter discovery and phase 1 operation boundaries', async () => {
  const provider = await loadProvider('listmonk');
  const ctx: ProviderContext = { workspace: '', dbPath: '', env: {}, dryRun: false, log: () => {} };
  assert.deepEqual(provider.envKeys, ['LISTMONK_URL', 'LISTMONK_USERNAME', 'LISTMONK_API_TOKEN', 'LISTMONK_LIST_ID']);
  await assert.rejects(provider.pushContacts(ctx, { list: 'strict' }), PreconditionError);
  await assert.rejects(provider.pullSuppressions(ctx), /not implemented in phase 1/);
  await assert.rejects(loadProvider('../listmonk'), /Available providers: listmonk/);
});
