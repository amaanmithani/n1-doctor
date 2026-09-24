export type Kind = 'select' | 'insert' | 'update' | 'delete' | 'other';

/** A short, specific fix for a repeated statement. */
export function suggest(kind: Kind, orm: string | null, fp: string): string {
  const col = /where\s+(?:"?\w+"?\.)?"?(\w+)"?\s*=\s*\?/.exec(fp)?.[1];
  if (orm === 'prisma') {
    if (kind === 'select')
      return (
        'Load the related rows in one query: use `include`/`select` on the parent query, or collect the keys and ' +
        `call \`findMany({ where: { ${col ?? 'id'}: { in: keys } } })\` once, then join in memory.`
      );
    if (kind === 'insert') return 'Use `createMany({ data: rows })` instead of one `create` per row.';
    if (kind === 'update')
      return 'Use `updateMany` with a shared `where`, or batch the writes in one `$transaction([...])`.';
    if (kind === 'delete') return 'Use `deleteMany({ where: { id: { in: ids } } })`.';
  }
  switch (kind) {
    case 'select':
      return (
        `Fetch all keys at once: \`WHERE ${col ?? 'id'} = ANY($1)\` (or \`IN (...)\`), or put a DataLoader in front ` +
        'of this query so calls within one request are batched.'
      );
    case 'insert':
      return 'Insert all rows in one statement (multi-row VALUES, or COPY for large batches).';
    case 'update':
      return 'Batch the updates: one UPDATE ... FROM (VALUES ...) join, or a single statement with a shared WHERE.';
    case 'delete':
      return 'Delete in one statement: `WHERE id = ANY($1)`.';
    default:
      return 'Batch these calls into one statement or cache the result for the duration of the request.';
  }
}
