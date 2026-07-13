import {statSync} from 'node:fs';
import {Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {
  LogContext,
  type Context,
  type LogLevel,
  type LogSink,
} from '@rocicorp/logger';
import {expect, test} from 'vitest';
import {BigIntJSON} from '../../shared/src/bigint-json.ts';
import {Database} from '../../zqlite/src/db.ts';
import {
  initReplica,
  runInitialSync,
  supportsBinaryCopy,
  ZERO_VERSION,
} from './initial-sync-bottleneck-adapter.ts';
import {getConnectionURI, testDBs} from './test/db.ts';
import {DbFile} from './test/lite.ts';
import type {PostgresDB} from './types/pg.ts';

type Mode = 'validate' | 'copy-only' | 'sync';
type CopyFormat = 'binary' | 'text';
type IndexProfile = 'standard' | 'required' | 'none' | 'stress';

type FixtureCounts = {
  tenants: number;
  accounts: number;
  tags: number;
  documents: number;
  comments: number;
  attachments: number;
  document_tags: number;
  events: number;
};

type PhaseRecord = {
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
};

const TABLES = [
  'tenants',
  'accounts',
  'tags',
  'documents',
  'comments',
  'attachments',
  'document_tags',
  'events',
] as const;

const PUBLICATION = 'zero_initial_sync_bottleneck';
const PHASE_MESSAGE_RE =
  /(Synced|Copied|Created index|initial download state)/i;
const SYNC_SUMMARY_RE =
  /\(flush:\s*([\d.]+)(?:\s*ms)?,\s*index:\s*([\d.]+)(?:\s*ms)?,\s*total:\s*([\d.]+)\s*ms\)/i;
const mode = envChoice<Mode>(
  'ZERO_INITIAL_SYNC_MODE',
  ['validate', 'copy-only', 'sync'],
  'sync',
);
const copyFormat = envChoice<CopyFormat>(
  'ZERO_INITIAL_SYNC_COPY_FORMAT',
  ['binary', 'text'],
  supportsBinaryCopy ? 'binary' : 'text',
);
const indexProfile = envChoice<IndexProfile>(
  'ZERO_INITIAL_SYNC_INDEX_PROFILE',
  ['standard', 'required', 'none', 'stress'],
  'standard',
);
const totalRows = envInteger('ZERO_INITIAL_SYNC_TOTAL_ROWS', 140_400, 1);
const workers = envInteger('ZERO_INITIAL_SYNC_WORKERS', 4, 1);
const instrument = process.env.ZERO_INITIAL_SYNC_INSTRUMENT !== '0';
const profileCopy = process.env.ZERO_INITIAL_SYNC_PROFILE_COPY === '1';
const profileName = process.env.ZERO_INITIAL_SYNC_PROFILE ?? 'toast-400m';
const runLabel =
  process.env.ZERO_INITIAL_SYNC_RUN_LABEL ?? `manual-${process.pid}`;
const configuredBinaryCopyBytes = envOptionalInteger(
  'ZERO_INITIAL_SYNC_BINARY_COPY_BYTES',
);
const configuredTextCopyBytes = envOptionalInteger(
  'ZERO_INITIAL_SYNC_TEXT_COPY_BYTES',
);
const sqliteCacheMB = envOptionalInteger('ZERO_INITIAL_SYNC_SQLITE_CACHE_MB');
const sqliteMmapMB = envOptionalInteger('ZERO_INITIAL_SYNC_SQLITE_MMAP_MB');
const sqliteTempStore = envChoice(
  'ZERO_INITIAL_SYNC_SQLITE_TEMP_STORE',
  ['default', 'memory'],
  'default',
);
const TEST_TIMEOUT_MS = envInteger(
  'ZERO_INITIAL_SYNC_TEST_TIMEOUT_MS',
  3_600_000,
  1_000,
);

if (copyFormat === 'binary' && !supportsBinaryCopy && mode === 'sync') {
  throw new Error(`Zero ${ZERO_VERSION} does not support binary initial sync`);
}

test(
  'initial sync bottleneck investigation',
  {timeout: TEST_TIMEOUT_MS},
  async () => {
    progress('creating source database');
    const upstream = await createTestDB(uniqueName('initial_sync_source'));
    progress('source database created');
    const phaseSink = new PhaseSink(instrument);
    const lc = new LogContext(
      instrument ? 'info' : 'error',
      undefined,
      phaseSink,
    );
    let dbFile: DbFile | undefined;

    try {
      const counts = fixtureCounts(totalRows);
      progress('creating fixture', counts);
      await createFixture(upstream, counts, indexProfile);
      progress('fixture created');
      const fixture = await inspectFixture(upstream, counts);
      progress('fixture inspected');
      expect(
        Object.values(fixture.actualRows).reduce((sum, rows) => sum + rows, 0),
      ).toBe(totalRows);

      if (mode === 'validate') {
        progress('measuring binary COPY');
        const binary = await measureCopy(upstream, 'binary');
        progress('measuring text COPY');
        const text = await measureCopy(upstream, 'text');
        progress('COPY calibration complete');
        emitResult({
          kind: 'fixture-validation',
          version: ZERO_VERSION,
          runLabel,
          profileName,
          totalRows,
          indexProfile,
          fixture,
          copy: {binary, text},
        });
        return;
      }

      if (mode === 'copy-only') {
        await measureCopy(upstream, copyFormat);
        const measured = await measureCopy(upstream, copyFormat);
        emitResult({
          kind: 'copy-only',
          version: ZERO_VERSION,
          runLabel,
          profileName,
          totalRows,
          copyFormat,
          indexProfile,
          fixture,
          copy: measured,
        });
        return;
      }

      dbFile = new DbFile(uniqueName('initial-sync-bottleneck'));
      const shard = {
        appID: uniqueName('initial_sync_bench'),
        shardNum: 0,
        publications: [PUBLICATION],
      };
      const pgBefore = await pgDatabaseStats(upstream);
      const resourcesBefore = process.resourceUsage();
      let peakRssBytes = process.memoryUsage().rss;
      let callbackMs = 0;
      const rssTimer = instrument
        ? setInterval(() => {
            peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
          }, 50)
        : undefined;

      const outerStart = performance.now();
      try {
        await initReplica(
          lc,
          'initial-sync-bottleneck',
          dbFile.path,
          async (log, tx) => {
            if (sqliteCacheMB !== undefined) {
              tx.pragma(`cache_size = -${sqliteCacheMB * 1024}`);
            }
            if (sqliteMmapMB !== undefined) {
              tx.pragma(`mmap_size = ${sqliteMmapMB * 1024 * 1024}`);
            }
            if (sqliteTempStore === 'memory') {
              tx.pragma('temp_store = MEMORY');
            }
            const callbackStart = performance.now();
            await runInitialSync(
              log,
              shard,
              tx,
              getConnectionURI(upstream),
              {workers, copyFormat, profileCopy},
              {bench: 'initial-sync-bottleneck', runLabel},
            );
            callbackMs = performance.now() - callbackStart;
          },
        );
      } finally {
        if (rssTimer) {
          clearInterval(rssTimer);
        }
      }
      const outerMs = performance.now() - outerStart;
      peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);

      const pgAfter = await pgDatabaseStats(upstream);
      const resourcesAfter = process.resourceUsage();
      const sqlite = inspectReplica(lc, dbFile.path);
      emitResult({
        kind: 'initial-sync',
        version: ZERO_VERSION,
        runLabel,
        profileName,
        totalRows,
        copyFormat,
        indexProfile,
        workers,
        instrument,
        profileCopy,
        sqliteTuning: {
          cacheMB: sqliteCacheMB,
          mmapMB: sqliteMmapMB,
          tempStore: sqliteTempStore,
        },
        fixture,
        calibratedCopyBytes: {
          binary: configuredBinaryCopyBytes,
          text: configuredTextCopyBytes,
        },
        timing: {
          outerMs,
          callbackMs,
          wrapperMs: Math.max(0, outerMs - callbackMs),
        },
        phases: phaseSink.summary(),
        peakRssBytes,
        resourceUsage: subtractNumericRecords(resourcesAfter, resourcesBefore),
        postgres: subtractNumericRecords(pgAfter, pgBefore),
        sqlite,
      });
    } finally {
      dbFile?.delete();
      await testDBs.drop(upstream);
    }
  },
);

class PhaseSink implements LogSink {
  readonly #enabled: boolean;
  readonly #records: PhaseRecord[] = [];

  constructor(enabled: boolean) {
    this.#enabled = enabled;
  }

  log(level: LogLevel, _context: Context | undefined, ...args: unknown[]) {
    if (!this.#enabled) {
      return;
    }
    const message = args.filter(arg => typeof arg === 'string').join(' ');
    if (!PHASE_MESSAGE_RE.test(message)) {
      return;
    }
    let data: unknown;
    for (let index = args.length - 1; index >= 0; index--) {
      const arg = args[index];
      if (arg !== null && typeof arg === 'object' && !(arg instanceof Error)) {
        data = arg;
        break;
      }
    }
    this.#records.push({
      level,
      message,
      ...(data ? {data: data as Record<string, unknown>} : {}),
    });
  }

  flush() {
    return Promise.resolve();
  }

  summary() {
    let sqliteInsertWorkMs: number | undefined;
    let indexMs: number | undefined;
    let internalTotalMs: number | undefined;
    let copyWallMs: number | undefined;
    let copyBytes: number | undefined;
    for (const record of this.#records) {
      if (record.data && numberField(record.data, 'indexMs') !== undefined) {
        sqliteInsertWorkMs = numberField(record.data, 'flushMs');
        indexMs = numberField(record.data, 'indexMs');
        internalTotalMs = numberField(record.data, 'totalMs');
        copyWallMs = numberField(record.data, 'copyMs');
        copyBytes = numberField(record.data, 'copyBytes');
      }
      const match = record.message.match(SYNC_SUMMARY_RE);
      if (match) {
        sqliteInsertWorkMs ??= Number(match[1]);
        indexMs ??= Number(match[2]);
        internalTotalMs ??= Number(match[3]);
      }
    }
    return {
      sqliteInsertWorkMs,
      indexMs,
      internalTotalMs,
      copyWallMs,
      copyBytes,
      records: this.#records,
    };
  }
}

function createTestDB(name: string) {
  // oxlint-disable-next-line typescript/unbound-method -- historical testDBs APIs differ
  const create = testDBs.create as unknown as Function;
  if (create.length >= 2) {
    return create.call(testDBs, name, undefined, {}) as Promise<PostgresDB>;
  }
  return create.call(testDBs, name, {typeOpts: {}}) as Promise<PostgresDB>;
}

function fixtureCounts(total: number): FixtureCounts {
  const lookupRows = Math.max(2, Math.min(2_128, Math.floor(total * 0.02)));
  const tenants = Math.min(128, lookupRows - 1);
  const tags = lookupRows - tenants;
  const applicationRows = total - lookupRows;
  const accounts = Math.max(1, Math.floor(applicationRows * 0.05));
  const documents = Math.max(1, Math.floor(applicationRows * 0.2));
  const comments = Math.max(1, Math.floor(applicationRows * 0.3));
  const attachments = Math.max(1, Math.floor(applicationRows * 0.005));
  const documentTags = Math.max(1, Math.floor(applicationRows * 0.2));
  const events =
    applicationRows -
    accounts -
    documents -
    comments -
    attachments -
    documentTags;
  return {
    tenants,
    accounts,
    tags,
    documents,
    comments,
    attachments,
    document_tags: documentTags,
    events,
  };
}

async function createFixture(
  upstream: PostgresDB,
  counts: FixtureCounts,
  indexes: IndexProfile,
) {
  const withKeys = indexes !== 'none';
  await upstream.unsafe(/* sql */ `
    CREATE FUNCTION bench_noise(label text, bytes integer)
    RETURNS text
    LANGUAGE sql IMMUTABLE PARALLEL SAFE
    AS $$
      SELECT left(string_agg(md5(label || ':' || i::text), ''), bytes)
      FROM generate_series(0, ceil(bytes / 32.0)::integer) AS i
    $$;

    CREATE TABLE bench_payloads(name text PRIMARY KEY, payload text NOT NULL);
    INSERT INTO bench_payloads(name, payload) VALUES
      ('c8k', left(repeat('compressible-8k-', 520), 8192)),
      ('n8k', bench_noise('n8k', 8192)),
      ('c32k', left(repeat('compressible-32k-', 2100), 32768)),
      ('n32k', bench_noise('n32k', 32768)),
      ('c256k', left(repeat('compressible-256k-', 14000), 262144)),
      ('n256k', bench_noise('n256k', 262144)),
      ('c1m', left(repeat('compressible-1m-', 70000), 1048576)),
      ('n1m', bench_noise('n1m', 1048576));

    CREATE FUNCTION bench_document_body(i bigint)
    RETURNS text
    LANGUAGE sql STABLE PARALLEL SAFE
    AS $$
      SELECT CASE
        WHEN i % 400 < 80 THEN NULL
        WHEN i % 400 < 200 THEN 'inline document ' || i::text || ':' || repeat('x', (i % 700)::integer)
        WHEN i % 400 < 276 THEN (SELECT payload FROM bench_payloads WHERE name = 'c8k')
        WHEN i % 400 < 352 THEN (SELECT payload FROM bench_payloads WHERE name = 'n8k')
        WHEN i % 400 < 372 THEN (SELECT payload FROM bench_payloads WHERE name = 'c32k')
        WHEN i % 400 < 392 THEN (SELECT payload FROM bench_payloads WHERE name = 'n32k')
        WHEN i % 400 < 399 THEN (SELECT payload FROM bench_payloads WHERE name = CASE WHEN i % 2 = 0 THEN 'c256k' ELSE 'n256k' END)
        ELSE (SELECT payload FROM bench_payloads WHERE name = CASE WHEN i % 2 = 0 THEN 'c1m' ELSE 'n1m' END)
      END
    $$;

    CREATE TABLE tenants(
      id bigint ${withKeys ? 'PRIMARY KEY' : 'NOT NULL'},
      slug text NOT NULL,
      plan text NOT NULL
    );
    CREATE TABLE accounts(
      id bigint ${withKeys ? 'PRIMARY KEY' : 'NOT NULL'},
      tenant_id bigint NOT NULL,
      email text NOT NULL,
      profile jsonb,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE tags(
      id bigint ${withKeys ? 'PRIMARY KEY' : 'NOT NULL'},
      tenant_id bigint NOT NULL,
      name text NOT NULL
    );
    CREATE TABLE documents(
      id bigint ${withKeys ? 'PRIMARY KEY' : 'NOT NULL'},
      tenant_id bigint NOT NULL,
      account_id bigint NOT NULL,
      status text NOT NULL,
      title text NOT NULL,
      body text,
      metadata jsonb,
      preview bytea,
      labels text[],
      collaborator_ids integer[],
      created_at timestamptz NOT NULL,
      updated_at timestamptz NOT NULL
    );
    CREATE TABLE comments(
      id bigint ${withKeys ? 'PRIMARY KEY' : 'NOT NULL'},
      document_id bigint NOT NULL,
      account_id bigint NOT NULL,
      body text,
      attributes jsonb,
      created_at timestamptz NOT NULL
    );
    CREATE TABLE attachments(
      id bigint ${withKeys ? 'PRIMARY KEY' : 'NOT NULL'},
      document_id bigint NOT NULL,
      content_type text NOT NULL,
      filename text NOT NULL,
      data bytea NOT NULL,
      metadata jsonb
    );
    CREATE TABLE document_tags(
      document_id bigint NOT NULL,
      tag_id bigint NOT NULL
      ${withKeys ? ', PRIMARY KEY(document_id, tag_id)' : ''}
    );
    CREATE TABLE events(
      id bigint ${withKeys ? 'PRIMARY KEY' : 'NOT NULL'},
      tenant_id bigint NOT NULL,
      account_id bigint,
      kind text NOT NULL,
      payload jsonb,
      created_at timestamptz NOT NULL
    );

    ALTER TABLE documents ALTER COLUMN body SET STORAGE EXTENDED;
    ALTER TABLE documents ALTER COLUMN body SET COMPRESSION pglz;
    ALTER TABLE documents ALTER COLUMN metadata SET STORAGE EXTENDED;
    ALTER TABLE documents ALTER COLUMN preview SET STORAGE EXTENDED;
    ALTER TABLE comments ALTER COLUMN body SET STORAGE EXTENDED;
    ALTER TABLE comments ALTER COLUMN body SET COMPRESSION pglz;
    ALTER TABLE attachments ALTER COLUMN data SET STORAGE EXTENDED;
    ALTER TABLE attachments ALTER COLUMN data SET COMPRESSION pglz;
    ALTER TABLE events ALTER COLUMN payload SET STORAGE EXTENDED;

    INSERT INTO tenants
    SELECT i, 'tenant-' || i, CASE i % 4 WHEN 0 THEN 'enterprise' WHEN 1 THEN 'team' ELSE 'free' END
    FROM generate_series(1, ${counts.tenants}) AS i;

    INSERT INTO accounts
    SELECT
      i,
      1 + ((i * 37) % ${counts.tenants}),
      'user-' || i || '@example.test',
      CASE WHEN i % 5 = 0 THEN NULL ELSE jsonb_build_object(
        'name', 'Account ' || i,
        'preferences', jsonb_build_object('theme', CASE WHEN i % 2 = 0 THEN 'dark' ELSE 'light' END, 'density', i % 3),
        'bio', CASE WHEN i % 20 = 0 THEN (SELECT payload FROM bench_payloads WHERE name = 'c8k') ELSE 'short bio ' || i END
      ) END,
      timestamptz '2024-01-01' + (i % 525600) * interval '1 minute'
    FROM generate_series(1, ${counts.accounts}) AS i;

    INSERT INTO tags
    SELECT i, 1 + ((i * 17) % ${counts.tenants}), 'tag-' || i
    FROM generate_series(1, ${counts.tags}) AS i;

    INSERT INTO documents
    SELECT
      i,
      1 + ((i * 37) % ${counts.tenants}),
      1 + ((i * 97) % ${counts.accounts}),
      (ARRAY['draft', 'active', 'archived', 'deleted'])[1 + (i % 4)],
      'Document ' || i || ': deterministic production-shaped content',
      bench_document_body(i),
      CASE WHEN i % 7 = 0 THEN NULL ELSE jsonb_build_object(
        'source', CASE WHEN i % 3 = 0 THEN 'import' ELSE 'editor' END,
        'revision', i % 1000,
        'flags', jsonb_build_array(i % 2 = 0, i % 5 = 0),
        'summary', CASE WHEN i % 25 = 0 THEN (SELECT payload FROM bench_payloads WHERE name = 'n8k') ELSE 'summary-' || i END
      ) END,
      CASE WHEN i % 10 = 0 THEN convert_to((SELECT payload FROM bench_payloads WHERE name = CASE WHEN i % 20 = 0 THEN 'n8k' ELSE 'c8k' END), 'UTF8') ELSE NULL END,
      CASE WHEN i % 9 = 0 THEN NULL WHEN i % 9 = 1 THEN ARRAY[]::text[] ELSE ARRAY['project-' || (i % 100), 'status-' || (i % 4), NULL] END,
      CASE WHEN i % 11 = 0 THEN NULL WHEN i % 11 = 1 THEN ARRAY[]::integer[] ELSE ARRAY[(i % 1000)::integer, ((i * 7) % 1000)::integer] END,
      timestamptz '2024-01-01' + (i % 525600) * interval '1 minute',
      timestamptz '2025-01-01' + (i % 525600) * interval '1 minute'
    FROM generate_series(1, ${counts.documents}) AS i;

    INSERT INTO comments
    SELECT
      i,
      1 + ((i * 101) % ${counts.documents}),
      1 + ((i * 43) % ${counts.accounts}),
      CASE
        WHEN i % 500 = 0 THEN (SELECT payload FROM bench_payloads WHERE name = 'n256k')
        WHEN i % 50 = 0 THEN (SELECT payload FROM bench_payloads WHERE name = 'n32k')
        WHEN i % 5 = 0 THEN (SELECT payload FROM bench_payloads WHERE name = CASE WHEN i % 10 = 0 THEN 'c8k' ELSE 'n8k' END)
        ELSE 'Comment ' || i || ':' || repeat('c', (i % 400)::integer)
      END,
      CASE WHEN i % 6 = 0 THEN NULL ELSE jsonb_build_object('edited', i % 7 = 0, 'mentions', ARRAY[i % 100, (i * 3) % 100]) END,
      timestamptz '2025-01-01' + (i % 525600) * interval '1 minute'
    FROM generate_series(1, ${counts.comments}) AS i;

    INSERT INTO attachments
    SELECT
      i,
      1 + ((i * 131) % ${counts.documents}),
      CASE WHEN i % 3 = 0 THEN 'application/pdf' ELSE 'application/octet-stream' END,
      'attachment-' || i || '.bin',
      convert_to((SELECT payload FROM bench_payloads WHERE name = CASE
        WHEN i % 100 = 0 THEN 'n1m'
        WHEN i % 10 = 0 THEN 'n256k'
        WHEN i % 2 = 0 THEN 'c32k'
        ELSE 'n32k'
      END), 'UTF8'),
      jsonb_build_object('checksum', md5(i::text), 'source', 'fixture')
    FROM generate_series(1, ${counts.attachments}) AS i;

    INSERT INTO document_tags
    SELECT 1 + ((i - 1) % ${counts.documents}), 1 + (((i - 1) / ${counts.documents}) % ${counts.tags})
    FROM generate_series(1, ${counts.document_tags}) AS i;

    INSERT INTO events
    SELECT
      i,
      1 + ((i * 37) % ${counts.tenants}),
      CASE WHEN i % 10 = 0 THEN NULL ELSE 1 + ((i * 97) % ${counts.accounts}) END,
      (ARRAY['document.created', 'document.updated', 'comment.created', 'account.updated'])[1 + (i % 4)],
      CASE
        WHEN i % 20 = 0 THEN jsonb_build_object('snapshot', (SELECT payload FROM bench_payloads WHERE name = CASE WHEN i % 40 = 0 THEN 'c8k' ELSE 'n8k' END), 'sequence', i)
        WHEN i % 7 = 0 THEN NULL
        ELSE jsonb_build_object('documentID', 1 + ((i * 53) % ${counts.documents}), 'changes', jsonb_build_array('title', 'status'), 'sequence', i)
      END,
      timestamptz '2025-01-01' + (i % 525600) * interval '1 minute'
    FROM generate_series(1, ${counts.events}) AS i;
  `);

  if (indexes === 'standard' || indexes === 'stress') {
    await upstream.unsafe(/* sql */ `
      CREATE INDEX accounts_tenant_created_idx ON accounts(tenant_id, created_at DESC);
      CREATE INDEX documents_tenant_status_updated_idx ON documents(tenant_id, status, updated_at DESC);
      CREATE INDEX documents_account_idx ON documents(account_id);
      CREATE INDEX comments_document_created_idx ON comments(document_id, created_at);
      CREATE INDEX comments_account_idx ON comments(account_id);
      CREATE INDEX attachments_document_idx ON attachments(document_id);
      CREATE INDEX events_tenant_created_idx ON events(tenant_id, created_at DESC);
    `);
  }
  if (indexes === 'stress') {
    await upstream.unsafe(
      'CREATE INDEX comments_body_hash_idx ON comments USING hash(body)',
    );
  }
  if (indexes === 'none') {
    await upstream.unsafe(/* sql */ `
      ALTER TABLE tenants REPLICA IDENTITY FULL;
      ALTER TABLE accounts REPLICA IDENTITY FULL;
      ALTER TABLE tags REPLICA IDENTITY FULL;
      ALTER TABLE documents REPLICA IDENTITY FULL;
      ALTER TABLE comments REPLICA IDENTITY FULL;
      ALTER TABLE attachments REPLICA IDENTITY FULL;
      ALTER TABLE document_tags REPLICA IDENTITY FULL;
      ALTER TABLE events REPLICA IDENTITY FULL;
    `);
  }
  await upstream.unsafe(/* sql */ `
    CREATE PUBLICATION ${PUBLICATION} FOR TABLE
      tenants, accounts, tags, documents, comments, attachments, document_tags, events;
    ANALYZE;
  `);
}

async function inspectFixture(upstream: PostgresDB, expected: FixtureCounts) {
  const relations = (await upstream.unsafe(/* sql */ `
    SELECT
      c.relname AS "table",
      c.reltuples::bigint AS "estimatedRows",
      c.reltoastrelid::regclass::text AS "toastRelation",
      pg_relation_size(c.oid)::bigint AS "mainBytes",
      pg_indexes_size(c.oid)::bigint AS "indexBytes",
      CASE WHEN c.reltoastrelid = 0 THEN 0 ELSE pg_total_relation_size(c.reltoastrelid) END::bigint AS "toastBytes",
      pg_total_relation_size(c.oid)::bigint AS "totalBytes"
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname IN (${TABLES.map(t => `'${t}'`).join(', ')})
    ORDER BY c.relname
  `)) as unknown as Record<string, unknown>[];
  const documentStorage = (await upstream.unsafe(/* sql */ `
    SELECT
      count(*)::bigint AS rows,
      count(*) FILTER (WHERE body IS NULL)::bigint AS "nullBodies",
      count(*) FILTER (WHERE body IS NOT NULL AND pg_column_size(body) < 2000)::bigint AS "inlineBodies",
      count(*) FILTER (WHERE body IS NOT NULL AND octet_length(body) >= 8192)::bigint AS "wideBodies",
      coalesce(sum(octet_length(body)), 0)::bigint AS "logicalBodyBytes",
      coalesce(sum(pg_column_size(body)), 0)::bigint AS "storedBodyDatumBytes"
    FROM documents
  `)) as unknown as Record<string, unknown>[];
  const actualRows: Record<string, number> = {};
  for (const table of TABLES) {
    const rows = (await upstream.unsafe(
      `SELECT count(*)::bigint AS rows FROM public."${table}"`,
    )) as unknown as {rows: number}[];
    const row = rows[0];
    if (!row) {
      throw new Error(`Missing row count for ${table}`);
    }
    actualRows[table] = Number(row.rows);
  }
  for (const table of TABLES) {
    if (actualRows[table] !== expected[table]) {
      throw new Error(
        `Fixture row mismatch for ${table}: ${actualRows[table]} != ${expected[table]}`,
      );
    }
  }
  return {
    expectedRows: expected,
    actualRows,
    relations,
    documentStorage: documentStorage[0],
  };
}

async function measureCopy(upstream: PostgresDB, format: CopyFormat) {
  const byTable: Record<string, {bytes: number; ms: number}> = {};
  let bytes = 0;
  const start = performance.now();
  for (const table of TABLES) {
    const tableStart = performance.now();
    let tableBytes = 0;
    await pipeline(
      await upstream
        .unsafe(`COPY public."${table}" TO STDOUT WITH (FORMAT ${format})`)
        .readable(),
      new Writable({
        write(chunk: Uint8Array, _encoding, callback) {
          tableBytes += chunk.byteLength;
          callback();
        },
      }),
    );
    byTable[table] = {bytes: tableBytes, ms: performance.now() - tableStart};
    progress(`${format} COPY complete for ${table}`, byTable[table]);
    bytes += tableBytes;
  }
  return {format, bytes, ms: performance.now() - start, byTable};
}

async function pgDatabaseStats(upstream: PostgresDB) {
  const rows = (await upstream.unsafe(/* sql */ `
    SELECT
      blks_read::bigint AS "blocksRead",
      blks_hit::bigint AS "blocksHit",
      temp_files::bigint AS "tempFiles",
      temp_bytes::bigint AS "tempBytes",
      blk_read_time::double precision AS "blockReadMs",
      blk_write_time::double precision AS "blockWriteMs"
    FROM pg_stat_database
    WHERE datname = current_database()
  `)) as unknown as Record<string, number>[];
  return Object.fromEntries(
    Object.entries(rows[0] ?? {}).map(([key, value]) => [key, Number(value)]),
  );
}

function inspectReplica(lc: LogContext, path: string) {
  const db = new Database(lc, path, {readonly: true});
  try {
    let rows = 0;
    for (const table of TABLES) {
      rows += db
        .prepare(`SELECT count(*) AS n FROM "${table}"`)
        .get<{n: number}>().n;
    }
    const pageCount = db
      .prepare('PRAGMA page_count')
      .get<{page_count: number}>().page_count;
    const pageSize = db
      .prepare('PRAGMA page_size')
      .get<{page_size: number}>().page_size;
    return {rows, fileBytes: statSync(path).size, pageCount, pageSize};
  } finally {
    db.close();
  }
}

function subtractNumericRecords(afterValue: object, beforeValue: object) {
  const after = afterValue as Record<string, number>;
  const before = beforeValue as Record<string, number>;
  return Object.fromEntries(
    Object.entries(after).map(([key, value]) => [
      key,
      value - (before[key] ?? 0),
    ]),
  );
}

function numberField(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function uniqueName(prefix: string) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
}

function envInteger(name: string, fallback: number, minimum = 0) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be an integer >= ${minimum}; got ${process.env[name]}`,
    );
  }
  return value;
}

function envOptionalInteger(name: string) {
  if (process.env[name] === undefined || process.env[name] === '') {
    return undefined;
  }
  return envInteger(name, 0, 0);
}

function envChoice<T extends string>(
  name: string,
  choices: readonly T[],
  fallback: T,
): T {
  const value = (process.env[name] ?? fallback) as T;
  if (!choices.includes(value)) {
    throw new Error(
      `${name} must be one of ${choices.join(', ')}; got ${value}`,
    );
  }
  return value;
}

function emitResult(result: Record<string, unknown>) {
  // eslint-disable-next-line no-console -- machine-readable benchmark protocol
  console.log(`ZERO_INITIAL_SYNC_RESULT ${BigIntJSON.stringify(result)}`);
}

function progress(message: string, data?: unknown) {
  // eslint-disable-next-line no-console -- fixture setup is outside measured work
  console.log(`ZERO_INITIAL_SYNC_PROGRESS ${message}`, data ?? '');
}
