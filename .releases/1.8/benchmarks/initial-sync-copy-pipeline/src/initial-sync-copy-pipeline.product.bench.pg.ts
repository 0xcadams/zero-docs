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
type ValidationMode = 'canonical' | 'calibration' | 'exploratory';
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
const validationMode = envChoice<ValidationMode>(
  'ZERO_COPY_PIPELINE_VALIDATION_MODE',
  ['canonical', 'calibration', 'exploratory'],
  'calibration',
);
const rows = envInteger('ZERO_COPY_PIPELINE_ROWS', 400, 0);
const payloadBytes = envInteger('ZERO_COPY_PIPELINE_PAYLOAD_BYTES', 250_000, 1);
const copyChunkBytes =
  process.env.ZERO_COPY_PIPELINE_COPY_CHUNK_BYTES === 'native'
    ? undefined
    : envInteger('ZERO_COPY_PIPELINE_COPY_CHUNK_BYTES', 31_744, 1);
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
const secondaryIndexMinAverageRowBytes = envInteger(
  'ZERO_COPY_PIPELINE_SECONDARY_INDEX_MIN_AVERAGE_ROW_BYTES',
  0,
  0,
);
const sqliteMmapGiB = envInteger('ZERO_COPY_PIPELINE_MMAP_GIB', 1, 0);
const sqliteCacheMB = envOptionalInteger('ZERO_COPY_PIPELINE_SQLITE_CACHE_MB');
const expectedCopyBytes = envOptionalInteger(
  'ZERO_COPY_PIPELINE_EXPECTED_COPY_BYTES',
);
const expectedRows = envOptionalInteger('ZERO_COPY_PIPELINE_EXPECTED_ROWS');
const expectedCopyDigest = envOptionalDigest(
  'ZERO_COPY_PIPELINE_EXPECTED_COPY_DIGEST',
);
const expectedContentDigest = envOptionalDigest(
  'ZERO_COPY_PIPELINE_EXPECTED_CONTENT_DIGEST',
);
const configuredFixtureVersion = envOptionalString(
  'ZERO_COPY_PIPELINE_FIXTURE_VERSION',
);
const fixtureVersion =
  configuredFixtureVersion ?? `legacy-${fixture}-fixture-v1`;
const configuredFixtureSeed = envOptionalInteger(
  'ZERO_COPY_PIPELINE_FIXTURE_SEED',
);
const fixtureSeed = configuredFixtureSeed ?? 20_250_714;
const cachePolicy = envOptionalString('ZERO_COPY_PIPELINE_CACHE_POLICY');
const sourceStrategy = envOptionalString('ZERO_COPY_PIPELINE_SOURCE_STRATEGY');
const instrument = process.env.ZERO_COPY_PIPELINE_INSTRUMENT !== '0';
const TEST_TIMEOUT_MS = envInteger(
  'ZERO_COPY_PIPELINE_TIMEOUT_MS',
  3_600_000,
  1_000,
);

validateValidationConfiguration();

test(
  'initial sync copy pipeline investigation',
  {timeout: TEST_TIMEOUT_MS},
  async ({testDBs}: PgTest) => {
    const upstream = await testDBs.create(uniqueName('copy_pipeline_source'));
    let dbFile: DbFile | undefined;
    try {
      progress('creating fixture', {
        fixture,
        fixtureVersion,
        fixtureSeed,
        rows,
        payloadBytes,
        validationMode,
      });
      await createFixture(upstream, fixture, rows, payloadBytes);
      const source = await inspectSource(upstream, fixture);
      expect(source.rows).toBe(rows);
      validateExact('source row count', source.rows, expectedRows);
      progress('fixture ready', source);

      const rawCopy = await measureCopy(upstream, fixture);
      validateExact('measured COPY bytes', rawCopy.bytes, expectedCopyBytes);
      const sourceCopy = await validateBinaryCopy(upstream, fixture);
      expect(sourceCopy.bytes).toBe(rawCopy.bytes);
      expect(sourceCopy.rows).toBe(source.rows);
      validateExact(
        'validated COPY bytes',
        sourceCopy.bytes,
        expectedCopyBytes,
      );
      validateExact(
        'binary COPY stream digest',
        sourceCopy.digest,
        expectedCopyDigest,
      );
      if (mode === 'copy-only') {
        emitCalibration({source, sourceCopy});
        emitResult({
          kind: 'copy-only',
          profile,
          runLabel,
          fixture,
          fixtureVersion,
          fixtureSeed,
          validationMode,
          rows,
          payloadBytes,
          source,
          rawCopy,
          sourceCopy,
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
              secondaryIndexMinAverageRowBytes,
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
      const sqlite = inspectReplica(lc, dbFile.path, fixture);
      expect(sqlite.rows).toBe(rows);
      validateExact('replica row count', sqlite.rows, expectedRows);
      validateExact(
        'replica whole-table content digest',
        sqlite.content.digest,
        expectedContentDigest,
      );
      expect(sqlite.indexes).toEqual(expectedReplicaIndexes(fixture));
      expect(sqlite.integrityCheck).toEqual([{integrity_check: 'ok'}]);
      emitCalibration({source, sourceCopy, sqlite});

      emitResult({
        kind: 'initial-sync',
        profile,
        runLabel,
        fixture,
        fixtureVersion,
        fixtureSeed,
        validationMode,
        cachePolicy,
        sourceStrategy,
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
          secondaryIndexMinAverageRowBytes,
        },
        sqliteTuning: {
          mmapGiB: sqliteMmapGiB,
          mmapBytes: sqliteMmapGiB * GIB,
          effectiveMmapBytes,
          cacheMB: sqliteCacheMB,
        },
        source,
        rawCopy,
        sourceCopy,
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

type BinaryCopyState =
  | 'header'
  | 'extension'
  | 'tuple-header'
  | 'field-length'
  | 'field-data'
  | 'done';

const PGCOPY_SIGNATURE = Buffer.from([
  0x50, 0x47, 0x43, 0x4f, 0x50, 0x59, 0x0a, 0xff, 0x0d, 0x0a, 0x00,
]);
const DIGEST_ROW_MARKER = Buffer.from([0x52]);
const DIGEST_END_MARKER = Buffer.from([0x45]);
const DIGEST_NULL = Buffer.from([0x00]);
const DIGEST_STRING = Buffer.from([0x01]);
const DIGEST_NUMBER = Buffer.from([0x02]);
const DIGEST_BIGINT = Buffer.from([0x03]);
const DIGEST_BYTES = Buffer.from([0x04]);

class BinaryCopyVerifier {
  readonly #expectedFields: number;
  #state: BinaryCopyState = 'header';
  #pending = Buffer.alloc(0);
  #extensionBytesRemaining = 0;
  #fieldsRemaining = 0;
  #fieldBytesRemaining = 0;
  #rows = 0;

  constructor(expectedFields: number) {
    this.#expectedFields = expectedFields;
  }

  parse(chunk: Buffer) {
    let data =
      this.#pending.length === 0
        ? chunk
        : Buffer.concat([this.#pending, chunk]);
    this.#pending = Buffer.alloc(0);
    let offset = 0;

    while (offset < data.length) {
      if (this.#state === 'done') {
        throw new Error('Binary COPY stream has bytes after its trailer');
      }
      if (this.#state === 'extension') {
        const consumed = Math.min(
          this.#extensionBytesRemaining,
          data.length - offset,
        );
        offset += consumed;
        this.#extensionBytesRemaining -= consumed;
        if (this.#extensionBytesRemaining === 0) {
          this.#state = 'tuple-header';
        }
        continue;
      }
      if (this.#state === 'field-data') {
        const consumed = Math.min(
          this.#fieldBytesRemaining,
          data.length - offset,
        );
        offset += consumed;
        this.#fieldBytesRemaining -= consumed;
        if (this.#fieldBytesRemaining === 0) {
          this.#finishField();
        }
        continue;
      }

      const requiredBytes =
        this.#state === 'header' ? 19 : this.#state === 'tuple-header' ? 2 : 4;
      if (data.length - offset < requiredBytes) {
        this.#pending = data.subarray(offset);
        return;
      }
      if (this.#state === 'header') {
        const header = data.subarray(offset, offset + requiredBytes);
        offset += requiredBytes;
        if (
          !header.subarray(0, PGCOPY_SIGNATURE.length).equals(PGCOPY_SIGNATURE)
        ) {
          throw new Error('Invalid binary COPY signature');
        }
        const flags = header.readInt32BE(11);
        if (flags !== 0) {
          throw new Error(`Unsupported binary COPY flags: ${flags}`);
        }
        this.#extensionBytesRemaining = header.readInt32BE(15);
        if (this.#extensionBytesRemaining < 0) {
          throw new Error('Invalid negative binary COPY extension length');
        }
        this.#state =
          this.#extensionBytesRemaining === 0 ? 'tuple-header' : 'extension';
        continue;
      }
      if (this.#state === 'tuple-header') {
        const fields = data.readInt16BE(offset);
        offset += requiredBytes;
        if (fields === -1) {
          this.#state = 'done';
          continue;
        }
        if (fields !== this.#expectedFields) {
          throw new Error(
            `Binary COPY row has ${fields} fields; expected ${this.#expectedFields}`,
          );
        }
        this.#fieldsRemaining = fields;
        this.#rows++;
        this.#state = 'field-length';
        continue;
      }

      const fieldLength = data.readInt32BE(offset);
      offset += requiredBytes;
      if (fieldLength < -1) {
        throw new Error(`Invalid binary COPY field length ${fieldLength}`);
      }
      if (fieldLength <= 0) {
        this.#finishField();
      } else {
        this.#fieldBytesRemaining = fieldLength;
        this.#state = 'field-data';
      }
    }
  }

  finish() {
    if (this.#state !== 'done' || this.#pending.length !== 0) {
      throw new Error(`Truncated binary COPY stream in ${this.#state} state`);
    }
    return {
      format: 'postgres-binary-copy-v1',
      columns: this.#expectedFields,
      rows: this.#rows,
      protocolValid: true,
    } as const;
  }

  #finishField() {
    this.#fieldsRemaining--;
    if (this.#fieldsRemaining < 0) {
      throw new Error('Binary COPY row contains too many fields');
    }
    this.#state = this.#fieldsRemaining === 0 ? 'tuple-header' : 'field-length';
  }
}

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
  const supportedVersion = `legacy-${fixtureName}-fixture-v1`;
  if (fixtureVersion !== supportedVersion || fixtureSeed !== 20_250_714) {
    throw new Error(
      `Unsupported ${fixtureName} fixture identity ${fixtureVersion}/${fixtureSeed}; ` +
        `expected ${supportedVersion}/20250714`,
    );
  }
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

async function validateBinaryCopy(upstream: PostgresDB, fixtureName: Fixture) {
  const verifier = new BinaryCopyVerifier(expectedColumnCount(fixtureName));
  const hash = createHash('sha256');
  let bytes = 0;
  let chunks = 0;
  await pipeline(
    await upstream
      .unsafe(
        `COPY ${qualifiedTable(fixtureName)} TO STDOUT WITH (FORMAT binary)`,
      )
      .readable(),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        try {
          bytes += chunk.length;
          chunks++;
          hash.update(chunk);
          verifier.parse(chunk);
          callback();
        } catch (error) {
          callback(error as Error);
        }
      },
    }),
  );
  const protocol = verifier.finish();
  return {
    bytes,
    chunks,
    digest: `sha256:${hash.digest('hex')}`,
    ...protocol,
  };
}

function inspectReplica(lc: LogContext, path: string, fixtureName: Fixture) {
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
    const content = digestReplicaTable(db, table, fixtureName);
    expect(content.rows).toBe(rows);
    const indexes = db
      .prepare(
        `SELECT name, "unique" AS isUnique
           FROM pragma_index_list(?) ORDER BY name`,
      )
      .all<{name: string; isUnique: number}>(table)
      .map(index => ({
        ...index,
        columns: db
          .prepare(
            `SELECT name, "desc" AS descending
               FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno`,
          )
          .all<{name: string; descending: number}>(index.name),
      }));
    const integrityCheck = db
      .prepare('PRAGMA integrity_check')
      .all<{integrity_check: string}>();
    return {
      rows,
      fileBytes: statSync(path).size,
      pageCount,
      pageSize,
      content,
      indexes,
      integrityCheck,
    };
  } finally {
    db.close();
  }
}

function digestReplicaTable(db: Database, table: string, fixtureName: Fixture) {
  const columns = db
    .prepare(`SELECT name FROM pragma_table_info(?) ORDER BY cid`)
    .all<{name: string}>(table)
    .map(({name}) => name);
  if (columns.length === 0) {
    throw new Error(`Replica table ${table} has no columns`);
  }
  const primaryKey = fixtureName === 'email' ? 'id' : 'import_id';
  const hash = createHash('sha256');
  hash.update('zero-copy-pipeline-content-v1\0');
  hashFramed(hash, Buffer.from(table));
  for (const column of columns) {
    hashFramed(hash, Buffer.from(column));
  }

  let rows = 0;
  const statement = db.prepare(
    `SELECT * FROM ${quoteSQLiteIdentifier(table)} ` +
      `ORDER BY ${quoteSQLiteIdentifier(primaryKey)} COLLATE BINARY`,
  );
  for (const row of statement.iterate<Record<string, unknown>>()) {
    hash.update(DIGEST_ROW_MARKER);
    for (const column of columns) {
      hashSQLiteValue(hash, row[column]);
    }
    rows++;
  }
  hash.update(DIGEST_END_MARKER);
  hashLength(hash, rows);
  return {
    algorithm: 'sha256',
    framing: 'zero-copy-pipeline-content-v1',
    orderBy: primaryKey,
    columns,
    rows,
    digest: `sha256:${hash.digest('hex')}`,
  };
}

function hashSQLiteValue(hash: ReturnType<typeof createHash>, value: unknown) {
  if (value === null) {
    hash.update(DIGEST_NULL);
    return;
  }
  if (typeof value === 'string') {
    hash.update(DIGEST_STRING);
    hashFramed(hash, Buffer.from(value));
    return;
  }
  if (typeof value === 'number') {
    const encoded = Buffer.allocUnsafe(8);
    encoded.writeDoubleBE(value);
    hash.update(DIGEST_NUMBER);
    hashFramed(hash, encoded);
    return;
  }
  if (typeof value === 'bigint') {
    hash.update(DIGEST_BIGINT);
    hashFramed(hash, Buffer.from(value.toString()));
    return;
  }
  if (value instanceof Uint8Array) {
    hash.update(DIGEST_BYTES);
    hashFramed(hash, value);
    return;
  }
  throw new Error(`Unsupported SQLite digest value: ${typeof value}`);
}

function hashFramed(hash: ReturnType<typeof createHash>, value: Uint8Array) {
  hashLength(hash, value.byteLength);
  hash.update(value);
}

function hashLength(hash: ReturnType<typeof createHash>, value: number) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid digest frame length ${value}`);
  }
  const encoded = Buffer.allocUnsafe(8);
  encoded.writeBigUInt64BE(BigInt(value));
  hash.update(encoded);
}

function quoteSQLiteIdentifier(identifier: string) {
  return `"${identifier.replaceAll('"', '""')}"`;
}

function expectedReplicaIndexes(fixtureName: Fixture) {
  return fixtureName === 'email'
    ? [
        {
          name: 'Email_pkey',
          isUnique: 1,
          columns: [{name: 'id', descending: 0}],
        },
        {
          name: 'Email_threadId_createdAt_id_idx',
          isUnique: 0,
          columns: [
            {name: 'threadId', descending: 0},
            {name: 'createdAt', descending: 0},
            {name: 'id', descending: 0},
          ],
        },
        {
          name: 'Email_threadId_id_idx',
          isUnique: 0,
          columns: [
            {name: 'threadId', descending: 0},
            {name: 'id', descending: 0},
          ],
        },
        {
          name: 'Email_workspaceId_id_idx',
          isUnique: 0,
          columns: [
            {name: 'workspaceId', descending: 0},
            {name: 'id', descending: 0},
          ],
        },
      ]
    : [
        {
          name: 'userspace.idx_imports_schema',
          isUnique: 0,
          columns: [{name: 'schema', descending: 0}],
        },
        {
          name: 'userspace.idx_imports_user_id',
          isUnique: 0,
          columns: [{name: 'user_id', descending: 0}],
        },
        {
          name: 'userspace.idx_imports_user_id_import_id',
          isUnique: 0,
          columns: [
            {name: 'user_id', descending: 0},
            {name: 'import_id', descending: 0},
          ],
        },
        {
          name: 'userspace.idx_imports_user_source',
          isUnique: 0,
          columns: [
            {name: 'user_id', descending: 0},
            {name: 'source', descending: 0},
          ],
        },
        {
          name: 'userspace.idx_imports_user_source_created_at',
          isUnique: 0,
          columns: [
            {name: 'user_id', descending: 0},
            {name: 'source', descending: 0},
            {name: 'created_at', descending: 1},
          ],
        },
        {
          name: 'userspace.imports_pkey',
          isUnique: 1,
          columns: [{name: 'import_id', descending: 0}],
        },
      ];
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

function expectedColumnCount(fixtureName: Fixture) {
  return fixtureName === 'email' ? 25 : 7;
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

function envOptionalString(name: string) {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

function envOptionalDigest(name: string) {
  const value = envOptionalString(name);
  if (value !== undefined && !/^sha256:[0-9a-f]{64}$/.test(value)) {
    throw new Error(`${name} must have the form sha256:<64 lowercase hex>`);
  }
  return value;
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

function validateValidationConfiguration() {
  if (expectedRows !== undefined && expectedRows !== rows) {
    throw new Error(
      `Configured rows ${rows} do not match exact expected rows ${expectedRows}`,
    );
  }
  if (validationMode !== 'canonical') {
    return;
  }
  if (mode === 'copy-only') {
    throw new Error(
      'Canonical validation requires sync mode so the replica content digest is checked',
    );
  }
  const required: [string, unknown][] = [
    ['ZERO_COPY_PIPELINE_FIXTURE_VERSION', configuredFixtureVersion],
    ['ZERO_COPY_PIPELINE_FIXTURE_SEED', configuredFixtureSeed],
    ['ZERO_COPY_PIPELINE_WORKERS', process.env.ZERO_COPY_PIPELINE_WORKERS],
    ['ZERO_COPY_PIPELINE_CACHE_POLICY', cachePolicy],
    ['ZERO_COPY_PIPELINE_SOURCE_STRATEGY', sourceStrategy],
    ['ZERO_COPY_PIPELINE_EXPECTED_ROWS', expectedRows],
    ['ZERO_COPY_PIPELINE_EXPECTED_COPY_BYTES', expectedCopyBytes],
    ['ZERO_COPY_PIPELINE_EXPECTED_COPY_DIGEST', expectedCopyDigest],
    ['ZERO_COPY_PIPELINE_EXPECTED_CONTENT_DIGEST', expectedContentDigest],
  ];
  const missing = required
    .filter(([, value]) => value === undefined)
    .map(([name]) => name);
  if (missing.length > 0) {
    throw new Error(
      `Canonical validation fails closed; missing ${missing.join(', ')}`,
    );
  }
}

function validateExact(
  label: string,
  actual: number | string,
  expected: number | string | undefined,
) {
  if (expected !== undefined && actual !== expected) {
    throw new Error(`${label} ${actual} does not exactly equal ${expected}`);
  }
}

function emitCalibration(values: {
  source: {rows: number};
  sourceCopy: {bytes: number; digest: string};
  sqlite?: {content: {digest: string; rows: number}};
}) {
  if (validationMode !== 'calibration') {
    return;
  }
  console.log(
    `ZERO_COPY_PIPELINE_CALIBRATION ${BigIntJSON.stringify({
      canonical: false,
      autoApproved: false,
      profile,
      fixture,
      fixtureVersion,
      fixtureSeed,
      candidateExpected: {
        rowCount: values.source.rows,
        copyBytes: values.sourceCopy.bytes,
        copyDigest: values.sourceCopy.digest,
        contentDigest: values.sqlite?.content.digest ?? null,
      },
    })}`,
  );
}

function progress(message: string, data?: unknown) {
  console.log(`ZERO_COPY_PIPELINE_PROGRESS ${message}`, data ?? '');
}

function emitResult(result: Record<string, unknown>) {
  console.log(`ZERO_COPY_PIPELINE_RESULT ${BigIntJSON.stringify(result)}`);
}
