import {createHash} from 'node:crypto';
import {readFileSync, statSync} from 'node:fs';
import {PerformanceObserver, performance} from 'node:perf_hooks';
import {Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {
  type Context,
  LogContext,
  type LogLevel,
  type LogSink,
} from '@rocicorp/logger';
import {expect} from 'vitest';
import {BigIntJSON} from '../../shared/src/bigint-json.ts';
import {Database} from '../../zqlite/src/db.ts';
import {initReplica} from './services/change-source/common/replica-schema.ts';
import {initialSync} from './services/change-source/pg/initial-sync.ts';
import {getConnectionURI, type PgTest, test} from './test/db.ts';
import {DbFile} from './test/lite.ts';
import type {PostgresDB} from './types/pg.ts';

type Fixture = 'email' | 'imports';
type Mode = 'copy-only' | 'sync';
type PhaseRecord = {
  level: LogLevel;
  message: string;
  data?: Record<string, unknown>;
};

const MIB = 1024 * 1024;
const GIB = 1024 * MIB;
const PUBLICATION = 'zero_copy_pipeline';
const profile = process.env.ZERO_COPY_PIPELINE_PROFILE ?? 'email-smoke-100m';
const runLabel =
  process.env.ZERO_COPY_PIPELINE_RUN_LABEL ?? `manual-${process.pid}`;
const fixture = envChoice<Fixture>(
  'ZERO_COPY_PIPELINE_FIXTURE',
  ['email', 'imports'],
  'email',
);
const mode = envChoice<Mode>(
  'ZERO_COPY_PIPELINE_MODE',
  ['copy-only', 'sync'],
  'sync',
);
const rows = envInteger('ZERO_COPY_PIPELINE_ROWS', 400, 1);
const payloadBytes = envInteger('ZERO_COPY_PIPELINE_PAYLOAD_BYTES', 250_000, 1);
const copyChunkBytes = envInteger(
  'ZERO_COPY_PIPELINE_COPY_CHUNK_BYTES',
  31_744,
  1,
);
const workers = envInteger('ZERO_COPY_PIPELINE_WORKERS', 5, 1);
const partialInsertBatches =
  process.env.ZERO_COPY_PIPELINE_PARTIAL_BATCHES === '1';
const directTextBuffers =
  process.env.ZERO_COPY_PIPELINE_DIRECT_TEXT_BUFFERS === '1';
const eagerIndexes = process.env.ZERO_COPY_PIPELINE_EAGER_INDEXES === '1';
const eagerSecondaryIndexes =
  process.env.ZERO_COPY_PIPELINE_EAGER_SECONDARY_INDEXES === '1';
const adaptiveSecondaryIndexes =
  process.env.ZERO_COPY_PIPELINE_ADAPTIVE_SECONDARY_INDEXES === '1';
const instrumentCopyPhases =
  process.env.ZERO_COPY_PIPELINE_INSTRUMENT_COPY_PHASES === '1';
const reuseFragmentedFieldBuffers =
  process.env.ZERO_COPY_PIPELINE_REUSE_FIELD_BUFFERS === '1';
const nativeTextBuffers =
  process.env.ZERO_COPY_PIPELINE_NATIVE_TEXT_BUFFERS === '1';
const nativeTextBufferStatic =
  process.env.ZERO_COPY_PIPELINE_NATIVE_TEXT_STATIC === '1';
if (instrumentCopyPhases) {
  throw new Error(
    'ZERO_COPY_PIPELINE_INSTRUMENT_COPY_PHASES was replaced by always-on production phase timing',
  );
}
if (nativeTextBufferStatic) {
  throw new Error(
    'ZERO_COPY_PIPELINE_NATIVE_TEXT_STATIC was removed because its Buffer lifetime was unsafe',
  );
}
if (reuseFragmentedFieldBuffers) {
  throw new Error(
    'ZERO_COPY_PIPELINE_REUSE_FIELD_BUFFERS was removed after the final A/B showed no paired improvement',
  );
}
const bufferMB = envInteger('ZERO_COPY_PIPELINE_BUFFER_MB', 8, 1);
const sqliteMmapGiB = envInteger('ZERO_COPY_PIPELINE_MMAP_GIB', 1, 0);
const sqliteCacheMB = envOptionalInteger('ZERO_COPY_PIPELINE_SQLITE_CACHE_MB');
const expectedCopyBytes = envOptionalInteger(
  'ZERO_COPY_PIPELINE_EXPECTED_COPY_BYTES',
);
const instrument = process.env.ZERO_COPY_PIPELINE_INSTRUMENT !== '0';
const TEST_TIMEOUT_MS = envInteger(
  'ZERO_COPY_PIPELINE_TIMEOUT_MS',
  3_600_000,
  1_000,
);

test(
  'initial sync copy pipeline investigation',
  {timeout: TEST_TIMEOUT_MS},
  async ({testDBs}: PgTest) => {
    const upstream = await testDBs.create(uniqueName('copy_pipeline_source'));
    let dbFile: DbFile | undefined;
    try {
      progress('creating fixture', {fixture, rows, payloadBytes});
      await createFixture(upstream, fixture, rows, payloadBytes);
      const source = await inspectSource(upstream, fixture);
      expect(source.rows).toBe(rows);
      progress('fixture ready', source);

      const rawCopy = await measureCopy(upstream, fixture);
      if (expectedCopyBytes !== undefined) {
        const relativeError =
          Math.abs(rawCopy.bytes - expectedCopyBytes) / expectedCopyBytes;
        if (relativeError > 0.02) {
          throw new Error(
            `COPY bytes ${rawCopy.bytes} differ from expected ${expectedCopyBytes} by ${(relativeError * 100).toFixed(2)}%`,
          );
        }
      }
      if (mode === 'copy-only') {
        emitResult({
          kind: 'copy-only',
          profile,
          runLabel,
          fixture,
          rows,
          payloadBytes,
          source,
          rawCopy,
        });
        return;
      }

      dbFile = new DbFile(uniqueName('copy-pipeline'));
      const phaseSink = new PhaseSink(instrument);
      const lc = new LogContext(
        instrument ? 'info' : 'error',
        undefined,
        phaseSink,
      );
      const shard = {
        appID: uniqueName('copy_pipeline_app'),
        shardNum: 0,
        publications: [PUBLICATION],
      };
      const resourcesBefore = process.resourceUsage();
      const eventLoopBefore = performance.eventLoopUtilization();
      let gcCount = 0;
      let gcMs = 0;
      const gcObserver = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) {
          gcCount++;
          gcMs += entry.duration;
        }
      });
      gcObserver.observe({entryTypes: ['gc']});
      const initialMemory = process.memoryUsage();
      let peakRssBytes = initialMemory.rss;
      let peakHeapUsedBytes = initialMemory.heapUsed;
      let peakExternalBytes = initialMemory.external;
      let peakArrayBuffersBytes = initialMemory.arrayBuffers;
      let callbackMs = 0;
      let effectiveMmapBytes = 0;
      let diagnosticsBefore: LinuxDiagnostics | undefined;
      let diagnosticsAfter: LinuxDiagnostics | undefined;
      const rssTimer = setInterval(() => {
        const memory = process.memoryUsage();
        peakRssBytes = Math.max(peakRssBytes, memory.rss);
        peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
        peakExternalBytes = Math.max(peakExternalBytes, memory.external);
        peakArrayBuffersBytes = Math.max(
          peakArrayBuffersBytes,
          memory.arrayBuffers,
        );
      }, 25);

      const outerStart = performance.now();
      try {
        await initReplica(
          lc,
          'initial-sync-copy-pipeline',
          dbFile.path,
          async (log, tx) => {
            const requestedMmapBytes = sqliteMmapGiB * GIB;
            tx.pragma(`mmap_size = ${requestedMmapBytes}`);
            if (sqliteCacheMB !== undefined) {
              tx.pragma(`cache_size = -${sqliteCacheMB * 1024}`);
            }
            const [mmap] = tx.pragma<{mmap_size: number}>('mmap_size');
            effectiveMmapBytes = mmap?.mmap_size ?? 0;
            if (requestedMmapBytes === 0) {
              expect(effectiveMmapBytes).toBe(0);
            } else {
              expect(effectiveMmapBytes).toBeGreaterThan(0);
            }
            expect(effectiveMmapBytes).toBeLessThanOrEqual(requestedMmapBytes);
            const options = {
              tableCopyWorkers: workers,
              experimental: {
                partialInsertBatches,
                directTextBuffers,
                eagerIndexes,
                eagerSecondaryIndexes,
                adaptiveSecondaryIndexes,
                nativeTextBuffers,
                bufferedSizeThresholdBytes: bufferMB * MIB,
                copyChunkBytes,
              },
            } as Parameters<typeof initialSync>[4];
            diagnosticsBefore = readLinuxDiagnostics();
            const callbackStart = performance.now();
            await initialSync(
              log,
              shard,
              tx,
              getConnectionURI(upstream),
              options,
              {
                bench: 'initial-sync-copy-pipeline',
                runLabel,
              },
            );
            callbackMs = performance.now() - callbackStart;
            diagnosticsAfter = readLinuxDiagnostics();
          },
        );
      } finally {
        clearInterval(rssTimer);
      }
      const outerMs = performance.now() - outerStart;
      await new Promise(resolve => setImmediate(resolve));
      gcObserver.disconnect();
      const finalMemory = process.memoryUsage();
      peakRssBytes = Math.max(peakRssBytes, finalMemory.rss);
      peakHeapUsedBytes = Math.max(peakHeapUsedBytes, finalMemory.heapUsed);
      peakExternalBytes = Math.max(peakExternalBytes, finalMemory.external);
      peakArrayBuffersBytes = Math.max(
        peakArrayBuffersBytes,
        finalMemory.arrayBuffers,
      );
      const resourceUsage = subtractNumericRecords(
        process.resourceUsage(),
        resourcesBefore,
      );
      const sqlite = inspectReplica(lc, dbFile.path, fixture, rows);
      expect(sqlite.rows).toBe(rows);
      const expectedPayloadHash = createHash('sha256')
        .update(fixturePayload(payloadBytes))
        .digest('hex');
      for (const sample of sqlite.payloadSamples) {
        expect(sample.bytes).toBe(payloadBytes);
        expect(sample.sha256).toBe(expectedPayloadHash);
      }

      emitResult({
        kind: 'initial-sync',
        profile,
        runLabel,
        fixture,
        rows,
        payloadBytes,
        workers,
        treatment: {
          partialInsertBatches,
          directTextBuffers,
          eagerIndexes,
          eagerSecondaryIndexes,
          adaptiveSecondaryIndexes,
          instrumentCopyPhases,
          reuseFragmentedFieldBuffers,
          nativeTextBuffers,
          nativeTextBindingLifetime: nativeTextBuffers ? 'transient' : 'cast',
          copyChunkBytes,
          bufferMB,
        },
        sqliteTuning: {
          mmapGiB: sqliteMmapGiB,
          mmapBytes: sqliteMmapGiB * GIB,
          effectiveMmapBytes,
          cacheMB: sqliteCacheMB,
        },
        source,
        rawCopy,
        timing: {
          outerMs,
          callbackMs,
          wrapperMs: Math.max(0, outerMs - callbackMs),
        },
        phases: phaseSink.summary(),
        peakRssBytes,
        peakHeapUsedBytes,
        peakExternalBytes,
        peakArrayBuffersBytes,
        gc: {count: gcCount, ms: gcMs},
        eventLoopUtilization: performance.eventLoopUtilization(eventLoopBefore),
        resourceUsage,
        linuxDiagnostics: {
          before: diagnosticsBefore,
          after: diagnosticsAfter,
        },
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
    if (
      !/(Finished copying|Created index|Created indexes|Synced)/i.test(message)
    ) {
      return;
    }
    let data: Record<string, unknown> | undefined;
    for (let index = args.length - 1; index >= 0; index--) {
      const arg = args[index];
      if (arg !== null && typeof arg === 'object' && !(arg instanceof Error)) {
        data = arg as Record<string, unknown>;
        break;
      }
    }
    this.#records.push({level, message, ...(data ? {data} : {})});
  }

  flush() {
    return Promise.resolve();
  }

  summary() {
    const tableCopies = this.#records.filter(record =>
      record.message.includes('Finished copying'),
    );
    const summary = [...this.#records]
      .reverse()
      .find(record => record.data && typeof record.data.totalMs === 'number');
    return {summary: summary?.data, tableCopies, records: this.#records};
  }
}

async function createFixture(
  upstream: PostgresDB,
  fixtureName: Fixture,
  rowCount: number,
  valueBytes: number,
) {
  await upstream.unsafe(/* sql */ `
    CREATE TABLE bench_payload(payload text NOT NULL);
    INSERT INTO bench_payload
    SELECT left(
      repeat('production-shaped-copy-payload-0123456789abcdef',
        ceil(${valueBytes} / 47.0)::integer),
      ${valueBytes}
    );
  `);
  if (fixtureName === 'email') {
    await createEmailFixture(upstream, rowCount);
  } else {
    await createImportsFixture(upstream, rowCount);
  }
  await upstream.unsafe(
    `CREATE PUBLICATION ${PUBLICATION} FOR TABLE ${qualifiedTable(fixtureName)}; ANALYZE;`,
  );
}

async function createEmailFixture(upstream: PostgresDB, rowCount: number) {
  await upstream.unsafe(/* sql */ `
    CREATE TABLE "Email"(
      "attachments" jsonb,
      "bcc" jsonb,
      "cc" jsonb,
      "createdAt" timestamptz NOT NULL,
      "date" timestamptz NOT NULL,
      "from" jsonb,
      "htmlContent" text,
      "id" text PRIMARY KEY,
      "isDeleted" boolean NOT NULL,
      "messageId" text,
      "originalRecipient" text,
      "postmarkMessageId" text,
      "preview" text,
      "raw" text,
      "source" text,
      "subject" text,
      "textContent" text,
      "threadId" text NOT NULL,
      "to" jsonb,
      "type" text,
      "uniqueId" text,
      "updatedAt" timestamptz NOT NULL,
      "userId" text NOT NULL,
      "version" bigint NOT NULL,
      "workspaceId" text NOT NULL
    );
    ALTER TABLE "Email" ALTER COLUMN "raw" SET STORAGE EXTENDED;
    ALTER TABLE "Email" ALTER COLUMN "raw" SET COMPRESSION pglz;
    INSERT INTO "Email"
    SELECT
      jsonb_build_array(jsonb_build_object('name', 'attachment-' || g)),
      jsonb_build_array('bcc-' || g || '@example.test'),
      jsonb_build_array('cc-' || g || '@example.test'),
      timestamptz '2025-01-01' + g * interval '1 second',
      timestamptz '2025-01-01' + g * interval '1 second',
      jsonb_build_object('address', 'sender-' || g || '@example.test'),
      '<p>Email ' || g || '</p>',
      'email-' || g,
      false,
      'message-' || g,
      'recipient-' || g || '@example.test',
      'postmark-' || g,
      'preview-' || g,
      p.payload,
      'inbound',
      'Subject ' || g,
      'Text content ' || g,
      'thread-' || (g % 100),
      jsonb_build_array('to-' || g || '@example.test'),
      'received',
      'unique-' || g,
      timestamptz '2025-01-01' + g * interval '1 second',
      'user-' || (g % 100),
      g,
      'workspace-' || (g % 10)
    FROM generate_series(1, ${rowCount}) g
    CROSS JOIN bench_payload p;

    CREATE INDEX "Email_threadId_createdAt_id_idx" ON "Email"("threadId", "createdAt", "id");
    CREATE INDEX "Email_threadId_id_idx" ON "Email"("threadId", "id");
    CREATE INDEX "Email_workspaceId_id_idx" ON "Email"("workspaceId", "id");
  `);
}

async function createImportsFixture(upstream: PostgresDB, rowCount: number) {
  await upstream.unsafe(/* sql */ `
    CREATE SCHEMA userspace;
    CREATE TABLE userspace.imports(
      created_at timestamptz NOT NULL,
      import_id text PRIMARY KEY,
      payload jsonb NOT NULL,
      schema text NOT NULL,
      source text NOT NULL,
      updated_at timestamptz NOT NULL,
      user_id text NOT NULL
    );
    ALTER TABLE userspace.imports ALTER COLUMN payload SET STORAGE EXTENDED;
    ALTER TABLE userspace.imports ALTER COLUMN payload SET COMPRESSION pglz;
    INSERT INTO userspace.imports
    SELECT
      timestamptz '2025-01-01' + g * interval '1 second',
      'import-' || g,
      jsonb_build_object('payload', p.payload),
      'v1',
      (ARRAY['email', 'archive', 'upload'])[1 + (g % 3)],
      timestamptz '2025-01-01' + g * interval '1 second',
      'user-' || (g % 100)
    FROM generate_series(1, ${rowCount}) g
    CROSS JOIN bench_payload p;

    CREATE INDEX idx_imports_schema ON userspace.imports(schema);
    CREATE INDEX idx_imports_user_id ON userspace.imports(user_id);
    CREATE INDEX idx_imports_user_id_import_id ON userspace.imports(user_id, import_id);
    CREATE INDEX idx_imports_user_source ON userspace.imports(user_id, source);
    CREATE INDEX idx_imports_user_source_created_at ON userspace.imports(user_id, source, created_at DESC);
  `);
}

async function inspectSource(upstream: PostgresDB, fixtureName: Fixture) {
  const table = qualifiedTable(fixtureName);
  const [result] = (await upstream.unsafe(/* sql */ `
    SELECT
      count(*)::bigint AS rows,
      pg_table_size('${table}'::regclass)::bigint AS "tableBytes",
      pg_indexes_size('${table}'::regclass)::bigint AS "indexBytes",
      pg_total_relation_size('${table}'::regclass)::bigint AS "totalBytes"
    FROM ${table}
  `)) as unknown as {
    rows: number;
    tableBytes: number;
    indexBytes: number;
    totalBytes: number;
  }[];
  if (!result) {
    throw new Error(`Missing source inspection for ${table}`);
  }
  return Object.fromEntries(
    Object.entries(result).map(([key, value]) => [key, Number(value)]),
  ) as {
    rows: number;
    tableBytes: number;
    indexBytes: number;
    totalBytes: number;
  };
}

async function measureCopy(upstream: PostgresDB, fixtureName: Fixture) {
  let bytes = 0;
  let chunks = 0;
  const start = performance.now();
  await pipeline(
    await upstream
      .unsafe(
        `COPY ${qualifiedTable(fixtureName)} TO STDOUT WITH (FORMAT binary)`,
      )
      .readable(),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        chunks++;
        callback();
      },
    }),
  );
  const ms = performance.now() - start;
  return {
    bytes,
    chunks,
    averageChunkBytes: bytes / chunks,
    ms,
    throughputMBps: bytes / 1_000_000 / (ms / 1_000),
  };
}

function inspectReplica(
  lc: LogContext,
  path: string,
  fixtureName: Fixture,
  rowCount: number,
) {
  const db = new Database(lc, path, {readonly: true});
  try {
    const table = fixtureName === 'email' ? 'Email' : 'userspace.imports';
    const rows = db
      .prepare(`SELECT count(*) AS n FROM "${table}"`)
      .get<{n: number}>().n;
    const pageCount = db
      .prepare('PRAGMA page_count')
      .get<{page_count: number}>().page_count;
    const pageSize = db
      .prepare('PRAGMA page_size')
      .get<{page_size: number}>().page_size;
    const payloadColumn =
      fixtureName === 'email' ? 'raw' : `json_extract(payload, '$.payload')`;
    const idColumn = fixtureName === 'email' ? 'id' : 'import_id';
    const idPrefix = fixtureName === 'email' ? 'email-' : 'import-';
    const payloadStatement = db.prepare(
      `SELECT ${payloadColumn} AS payload FROM "${table}" WHERE ${idColumn} = ?`,
    );
    const payloadSamples = [
      ...new Set([1, Math.ceil(rowCount / 2), rowCount]),
    ].map(row => {
      const id = `${idPrefix}${row}`;
      const payload = payloadStatement.get<{payload: string}>(id)?.payload;
      if (typeof payload !== 'string') {
        throw new Error(`Missing payload sample ${table}.${id}`);
      }
      return {
        id,
        bytes: Buffer.byteLength(payload),
        sha256: createHash('sha256').update(payload).digest('hex'),
      };
    });
    return {
      rows,
      fileBytes: statSync(path).size,
      pageCount,
      pageSize,
      payloadSamples,
    };
  } finally {
    db.close();
  }
}

function fixturePayload(bytes: number) {
  const pattern = 'production-shaped-copy-payload-0123456789abcdef';
  return pattern.repeat(Math.ceil(bytes / pattern.length)).slice(0, bytes);
}

type LinuxDiagnostics = ReturnType<typeof readLinuxDiagnosticsData>;

function readLinuxDiagnostics(): LinuxDiagnostics | undefined {
  if (process.platform !== 'linux') {
    return undefined;
  }
  try {
    return readLinuxDiagnosticsData();
  } catch {
    return undefined;
  }
}

function readLinuxDiagnosticsData() {
  return {
    memoryEvents: parseKeyValues(
      readFileSync('/sys/fs/cgroup/memory.events', 'utf8'),
    ),
    memoryStat: parseKeyValues(
      readFileSync('/sys/fs/cgroup/memory.stat', 'utf8'),
    ),
    memoryPressure: parsePressure(
      readFileSync('/sys/fs/cgroup/memory.pressure', 'utf8'),
    ),
    ioPressure: parsePressure(
      readFileSync('/sys/fs/cgroup/io.pressure', 'utf8'),
    ),
    ioStat: parseIOStat(readFileSync('/sys/fs/cgroup/io.stat', 'utf8')),
  };
}

function parseKeyValues(value: string) {
  return Object.fromEntries(
    value
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [key, raw] = line.split(/\s+/);
        return [key, Number(raw)];
      }),
  );
}

function parsePressure(value: string) {
  return Object.fromEntries(
    value
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => {
        const [kind, ...fields] = line.split(/\s+/);
        return [
          kind,
          Object.fromEntries(
            fields.map(field => {
              const [key, raw] = field.split('=');
              return [key, Number(raw)];
            }),
          ),
        ];
      }),
  );
}

function parseIOStat(value: string) {
  const totals: Record<string, number> = {};
  for (const line of value.trim().split('\n').filter(Boolean)) {
    const [, ...fields] = line.split(/\s+/);
    for (const field of fields) {
      const [key, raw] = field.split('=');
      totals[key] = (totals[key] ?? 0) + Number(raw);
    }
  }
  return totals;
}

function qualifiedTable(fixtureName: Fixture) {
  return fixtureName === 'email' ? 'public."Email"' : 'userspace.imports';
}

function uniqueName(prefix: string) {
  return `${prefix}_${process.pid}_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
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

function envInteger(name: string, fallback: number, minimum: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(
      `${name} must be an integer >= ${minimum}; got ${process.env[name]}`,
    );
  }
  return value;
}

function envOptionalInteger(name: string) {
  const value = process.env[name];
  return value === undefined || value === ''
    ? undefined
    : envInteger(name, 0, 0);
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

function progress(message: string, data?: unknown) {
  console.log(`ZERO_COPY_PIPELINE_PROGRESS ${message}`, data ?? '');
}

function emitResult(result: Record<string, unknown>) {
  console.log(`ZERO_COPY_PIPELINE_RESULT ${BigIntJSON.stringify(result)}`);
}
