import { openDb } from '../../scripts/lib/db.ts';
import { PreconditionError } from '../../scripts/lib/errors.ts';
import { workspaceLayout } from '../../scripts/lib/paths.ts';
import { LIST_VIEWS, parseList, requireOutputDir, writeCsv } from '../../scripts/lib/query.ts';
import type { Provider } from '../../scripts/lib/types.ts';

function jsonList(value: unknown): string[] {
  try {
    const values: unknown = JSON.parse(String(value));
    if (Array.isArray(values) && values.every((item) => typeof item === 'string')) return values as string[];
  } catch {
    // Skip the parser's error because it may include the unmasked data.
  }
  throw new Error('Cannot generate the Listmonk CSV: source labels or flags are invalid.');
}

const listmonk: Provider = {
  name: 'listmonk',
  envKeys: ['LISTMONK_URL', 'LISTMONK_USERNAME', 'LISTMONK_API_TOKEN', 'LISTMONK_LIST_ID'],
  async pushContacts(ctx, { list }) {
    if (!ctx.dryRun) throw new PreconditionError('applying to a provider is not available in phase 1; it will require explicit human confirmation');
    const db = openDb(ctx.dbPath, { readonly: true });
    try {
      const view = LIST_VIEWS[parseList(list)];
      const rows = db.prepare(`
        SELECT c.email, c.name, c.locale, c.flags, c.email_status,
          (SELECT json_group_array(cs.source ORDER BY cs.source)
           FROM contact_sources cs WHERE cs.contact_id = c.id) AS sources
        FROM ${view} c ORDER BY c.id`);
      let to_add = 0;
      const exportsDir = requireOutputDir(ctx.workspace, workspaceLayout(ctx.workspace).exports);
      const export_file = writeCsv(exportsDir, `listmonk-${list}`,
        ['email', 'name', 'attributes'], (emit) => {
          for (const row of rows.iterate()) {
            const attributes = {
              sources: jsonList(row.sources),
              flags: jsonList(row.flags),
              locale: row.locale,
              email_status: row.email_status,
            };
            emit([row.email ?? null, row.name ?? null, JSON.stringify(attributes)]);
            to_add++;
          }
        });
      return {
        provider: 'listmonk', list, to_add, to_update: 0, to_remove: 0, export_file,
        notes: ['Dry run only. Determining updates and removals requires the Listmonk API.'],
      };
    } finally {
      db.close();
    }
  },
  async pullSuppressions() {
    throw new Error('not implemented in phase 1');
  },
};

export default listmonk;
