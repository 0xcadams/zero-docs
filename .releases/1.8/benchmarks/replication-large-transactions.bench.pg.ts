// Benchmarks end-to-end logical replication throughput from upstream Postgres
// writes through the change-streamer and into the SQLite replica.

import {afterEach, describe, expect} from 'vitest';
import {createManualBenchmarkRecorder} from '../../../../shared/src/bench.ts';
import {BigIntJSON} from '../../../../shared/src/bigint-json.ts';
import {createSilentLogContext} from '../../../../shared/src/logging-test-utils.ts';
import {sleep} from '../../../../shared/src/sleep.ts';
import {getConnectionURI, type PgTest, test} from '../../test/db.ts';
import {DbFile} from '../../test/lite.ts';
import {
  BENCHMARK_FIXTURE_PUBLICATION,
  benchmarkFixtureReplicaRowCount,
  insertBenchmarkFixtureRowBatches,
  insertBenchmarkFixtureRows,
  makeBenchmarkFixtureRowBatches,
  setupBenchmarkFixture,
} from '../../test/pg-bench.ts';
import type {Source} from '../../types/streams.ts';
import {getPragmaConfig, setupReplica} from '../../workers/replicator.ts';
import {initializePostgresChangeSource} from '../change-source/pg/change-source.ts';
import {initializeStreamer} from '../change-streamer/change-streamer-service.ts';
import {
  type ChangeStreamer,
  type ChangeStreamerService,
  type Downstream,
} from '../change-streamer/change-streamer.ts';
import {ReplicationStatusPublisher} from './replication-status.ts';
import {ReplicatorService} from './replicator.ts';
import {ThreadWriteWorkerClient} from './write-worker-client.ts';

const WARMUP_ROWS = 10_000;
const LARGE_TRANSACTION_CHANGES = 50_000;
const SUSTAINED_TRANSACTIONS = 50;
const SUSTAINED_CHANGES_PER_TRANSACTION = 1_000;
const CHANGE_LOG_BATCH_SIZE = 2000;

const APP_ID = 'logical_replication_bench_app';
const SHARD_NUM = 0;
const TASK_ID = 'logical-replication-throughput-bench';
const TEST_TIMEOUT_MS = 900_000;

const lc = createSilentLogContext();
const shard = {
  appID: APP_ID,
  shardNum: SHARD_NUM,
  publications: [BENCHMARK_FIXTURE_PUBLICATION],
};
const benchmarkRecorder = createManualBenchmarkRecorder();
const streamerOptions = {
  backPressureLimitHeapProportion: 0.04,
  flowControlConsensusPaddingSeconds: 1,
  statementTimeoutMs: 60_000,
  changeLogBatchSize: CHANGE_LOG_BATCH_SIZE,
};

let cleanup: (() => Promise<void>)[] = [];

async function runCleanup() {
  for (const fn of cleanup.reverse()) {
    await fn();
  }
  cleanup = [];
}

afterEach(async () => {
  await runCleanup();
});

function parseStringifiedSource(source: Source<string>): Source<Downstream> {
  return {
    cancel: err => source.cancel(err),
    async *[Symbol.asyncIterator]() {
      for await (const msg of source) {
        yield BigIntJSON.parse(msg) as Downstream;
      }
    },
  };
}

function parseStringifiedChangeStreamer(
  streamer: ChangeStreamerService,
): ChangeStreamer {
  return {
    async subscribe(ctx) {
      return parseStringifiedSource(await streamer.subscribe(ctx));
    },
  };
}

function replicaRowCount(replicaPath: string): number {
  return benchmarkFixtureReplicaRowCount(lc, replicaPath);
}

async function waitForReplicaRows(replicaPath: string, expected: number) {
  const deadline = performance.now() + TEST_TIMEOUT_MS;
  let actual = 0;
  while (performance.now() < deadline) {
    actual = replicaRowCount(replicaPath);
    if (actual >= expected) {
      return actual;
    }
    await sleep(50);
  }
  throw new Error(
    `timed out waiting for replica rows: expected ${expected}, got ${actual}`,
  );
}

async function startReplicationPipeline(testDBs: PgTest['testDBs']) {
  const upstream = await testDBs.create('logical_replication_bench_upstream');
  const changeDB = await testDBs.create('logical_replication_bench_change', {
    typeOpts: {sendStringAsJson: true},
  });
  const replicaDbFile = new DbFile('logical-replication-throughput-bench');

  // oxlint-disable require-await
  cleanup.push(async () => replicaDbFile.delete());
  cleanup.push(async () => {
    await testDBs.drop(upstream, changeDB);
  });

  await setupBenchmarkFixture(upstream, {
    publication: BENCHMARK_FIXTURE_PUBLICATION,
  });
  const upstreamURI = getConnectionURI(upstream);
  const {subscriptionState, changeSource} =
    await initializePostgresChangeSource(
      lc,
      upstreamURI,
      shard,
      replicaDbFile.path,
      {tableCopyWorkers: 5},
      {bench: 'logical-replication-throughput'},
    );

  await setupReplica(lc, 'serving', {file: replicaDbFile.path});

  const changeStreamer = await initializeStreamer(
    lc,
    shard,
    TASK_ID,
    'change-streamer:12345',
    'ws',
    changeDB,
    changeSource,
    ReplicationStatusPublisher.forReplicaFile(replicaDbFile.path, () =>
      Promise.resolve(),
    ),
    subscriptionState,
    null,
    true,
    streamerOptions,
  );
  const streamerDone = changeStreamer.run();
  cleanup.push(async () => {
    await changeStreamer.stop();
    await streamerDone;
  });

  const worker = new ThreadWriteWorkerClient();
  await worker.init(replicaDbFile.path, 'serving', getPragmaConfig('serving'), {
    level: 'error',
    format: 'text',
  });

  const replicator = new ReplicatorService(
    lc,
    TASK_ID,
    'logical-replication-throughput-replicator',
    'serving',
    parseStringifiedChangeStreamer(changeStreamer),
    worker,
    null,
  );
  const replicatorDone = replicator.run();
  cleanup.push(async () => {
    await replicator.stop();
    await replicatorDone;
  });

  return {upstream, replicaPath: replicaDbFile.path};
}

describe('replicator/logical replication throughput', () => {
  test(
    'large transactions end-to-end changes/sec',
    {timeout: TEST_TIMEOUT_MS},
    async ({testDBs}: PgTest) => {
      const {upstream, replicaPath} = await startReplicationPipeline(testDBs);

      expect(replicaRowCount(replicaPath)).toBe(0);

      await insertBenchmarkFixtureRows(
        upstream,
        1,
        WARMUP_ROWS,
        SUSTAINED_CHANGES_PER_TRANSACTION,
      );
      expect(await waitForReplicaRows(replicaPath, WARMUP_ROWS)).toBe(
        WARMUP_ROWS,
      );

      let nextID = WARMUP_ROWS + 1;
      let expectedRows = WARMUP_ROWS;
      const measure = async (
        name: string,
        changes: number,
        changesPerTransaction: number,
      ) => {
        const batches = makeBenchmarkFixtureRowBatches(
          nextID,
          changes,
          changesPerTransaction,
        );
        const start = performance.now();
        await insertBenchmarkFixtureRowBatches(upstream, batches);
        expectedRows += changes;
        expect(await waitForReplicaRows(replicaPath, expectedRows)).toBe(
          expectedRows,
        );
        benchmarkRecorder.recordThroughput(
          name,
          [performance.now() - start],
          changes,
        );
        nextID += changes;
      };

      await measure(
        'replication one 50,000-change transaction',
        LARGE_TRANSACTION_CHANGES,
        LARGE_TRANSACTION_CHANGES,
      );
      await measure(
        'replication 50 x 1,000-change transactions',
        SUSTAINED_TRANSACTIONS * SUSTAINED_CHANGES_PER_TRANSACTION,
        SUSTAINED_CHANGES_PER_TRANSACTION,
      );
    },
  );
});
