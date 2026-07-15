import {readFile, writeFile} from 'node:fs/promises';

const path =
  process.env.ADAPTIVE_INDEX_INITIAL_SYNC_PATH ??
  '/workspace/packages/zero-cache/src/services/change-source/pg/initial-sync.ts';
const source = await readFile(path, 'utf8');
const original = `function shouldCreateSecondaryIndexesBeforeCopy(
  totalRows: number,
  totalBytes: number | undefined,
  minAverageRowBytes: number,
): boolean {
  // totalBytes comes from pg_table_size, which includes TOAST and table
  // overhead but excludes indexes. The estimate therefore measures physical
  // PostgreSQL width, not binary COPY bytes: compression can lower it, while
  // dead tuples and bloat can raise it. reltuples can also be stale. Keep the
  // cutoff configurable for canary tuning, and defer zero or unknown estimates.
  // A zero cutoff disables eager secondary-index creation.
  return (
    minAverageRowBytes > 0 &&
    totalRows > 0 &&
    (totalBytes ?? 0) / totalRows >= minAverageRowBytes
  );
}`;
const replacement = `function shouldCreateSecondaryIndexesBeforeCopy(
  _totalRows: number,
  _totalBytes: number | undefined,
  _minAverageRowBytes: number,
): boolean {
  return true;
}`;

if (!source.includes(original)) {
  throw new Error('Eager-secondary benchmark patch target not found');
}
if (source.indexOf(original) !== source.lastIndexOf(original)) {
  throw new Error('Eager-secondary benchmark patch target is ambiguous');
}
if (!process.argv.includes('--check')) {
  await writeFile(path, source.replace(original, replacement));
}
