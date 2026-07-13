# Native Update Batching for Huge Transactions

## Status

| Field               | Value                                                               |
| ------------------- | ------------------------------------------------------------------- |
| Date                | 2026-07-13                                                          |
| Target              | `maint/zero/v1.8` at `cdc02598f137ab4e071878f5674fdc716dbbc69d`     |
| Product status      | Experimental and disabled by default                                |
| Production protocol | Version 6, unchanged                                                |
| Benchmark host      | Apple M5 Pro, macOS arm64                                           |
| Database            | Local PostgreSQL test container and file-backed WAL2 SQLite replica |
| Primary metric      | PostgreSQL commit to SQLite `version-ready`                         |

The large-transaction measurements in this note are diagnostic one-sample scale screens, not medians. Large differences were confirmed at multiple row counts, but small differences should be rerun with alternating repetitions before making a production claim.

Benchmark stdout was not redirected to durable raw log files during this exploratory round. The exact important sample fields were transcribed into the tables below from the emitted JSON. Future confirmation runs should save the complete JSON output alongside this note.

## Conclusion

Native update batching before the first stringify, set-based SQLite application, and a 50,000-row coarse-reset threshold reduced the representative one-million-row conflict-upsert drain from 28.81 seconds to 8.74 seconds. This is a 69.7% latency reduction and a logical-message throughput increase from 10.85 MiB/s to 35.76 MiB/s.

Including PostgreSQL's upsert and commit, total SQL-start-to-replica-ready time fell from 35.79 seconds to 15.85 seconds, a 55.7% reduction.

An optimized three-million-row conflict upsert completed PostgreSQL work in 23.99 seconds and reached SQLite ready 26.82 seconds later. The drain was 3.07 times the one-million-row drain, so this screen did not show a nonlinear collapse. Event-loop p99 was 6.38 ms and SQLite commit was 284 ms.

The largest gain came from reducing logical messages before ChangeDB storage. SQLite set-based application and coarse reset were useful additional improvements, but neither explains the result by itself.

The optimized path is not ready to ship. Persisted `update-batch` messages are incompatible with old ChangeDB readers, full ViewSyncer/CVR/client-patch cost is not measured, and arbitrarily interleaved inserts and updates currently receive no batching benefit.

## Customer Workloads

The experiment targets two reports of huge transactions:

| Workload                 | PostgreSQL operation                   | Representative source                   |
| ------------------------ | -------------------------------------- | --------------------------------------- |
| External synchronization | One `INSERT ... ON CONFLICT DO UPDATE` | District or third-party data import     |
| Application backfill     | One large `UPDATE`                     | Production data correction or migration |

The conflict-upsert fixture has a bigint primary key and a secondary unique business key `(district_id, external_id)`. Existing rows are seeded before timing. The timed statement performs one transaction over 100,000, one million, or three million rows.

The migration fixture seeds rows before timing, then changes a narrow `migrated` column in one `UPDATE`. An optional payload column can make the table wide while leaving the payload unchanged.

## Replication Pipeline

After PostgreSQL commits, every logical row change passes through:

| Stage                          | Work                                                     |
| ------------------------------ | -------------------------------------------------------- |
| PostgreSQL logical replication | Decode each insert or update                             |
| ChangeStreamer                 | Construct protocol messages and stringify them           |
| ChangeDB                       | Durably store the transaction for replay                 |
| WebSocket                      | Forward and validate downstream messages                 |
| Write-worker boundary          | Structured-clone messages into the SQLite worker         |
| SQLite application tables      | Apply each row change                                    |
| SQLite ChangeLog               | Record row identifiers needed for ViewSyncer advancement |
| Replica notifier               | Publish `version-ready` after SQLite commit              |

Before native batching, one million updated rows produced approximately one million logical messages, one million ChangeDB rows, one million application operations, and one million ChangeLog operations.

PostgreSQL protocol version 1 exposes a large transaction only after commit. For that reason, the primary Zero metric begins when PostgreSQL commit returns and ends at SQLite `version-ready`. PostgreSQL statement and commit time is recorded separately.

## Logical MiB/s

Logical-message throughput uses a fixed numerator:

```text
source logical-message bytes before batching / commit-to-ready seconds
```

This avoids penalizing batching for removing relation names, column names, JSON structure, and other protocol metadata. Canonical ChangeDB or WebSocket bytes are reported separately.

Source-byte accounting was disabled in the final hot-path runs because exact recursive byte measurement materially distorted batch construction. The exact source byte count from an earlier identical tracked run is reused for the same 100,000-row and one-million-row fixture. The three-million-row source byte count was not captured, so no logical MiB/s is claimed for that row.

## Optimized Configuration

| Area                          | Configuration                                              |
| ----------------------------- | ---------------------------------------------------------- |
| Native update batch           | Enabled before `Storer.store()` and first stringify        |
| Maximum rows                  | 128                                                        |
| Maximum encoded batch         | 256 KiB                                                    |
| Worker request depth          | 1                                                          |
| Existing worker message batch | 32                                                         |
| SQLite application            | `UPDATE ... FROM ... RETURNING`                            |
| ChangeLog                     | Multi-row `SET` writes                                     |
| Secondary unique index        | Try set-based; retry rowwise on `SQLITE_CONSTRAINT_UNIQUE` |
| Missing replica row           | Existing resumptive `INSERT OR REPLACE` fallback           |
| Coarse reset                  | Switch at 50,000 logical row changes                       |
| Active Zero backfill          | Rowwise application and no coarse reset                    |
| Singleton update run          | Emit the original update, not a one-row batch              |

Eligible updates have `key === null`, do not use `REPLICA IDENTITY FULL`, supply every row-key column, and have the same relation and supplied-column shape. Key changes, duplicate row keys, relation changes, shape changes, schema changes, inserts, deletes, backfills, commits, rollbacks, status messages, and control messages are barriers.

## Main Results

### Logical Throughput

| Workload         | Rows | Configuration       | Source Logical Data | Commit to Ready | Logical MiB/s | Relative Throughput |
| ---------------- | ---: | ------------------- | ------------------: | --------------: | ------------: | ------------------: |
| Conflict upsert  | 100k | Ordinary            |           30.97 MiB |         2.740 s |   11.30 MiB/s |               1.00x |
| Conflict upsert  | 100k | Native 128 + coarse |           30.97 MiB |         0.943 s |   32.85 MiB/s |               2.91x |
| Conflict upsert  |   1m | Ordinary            |          312.50 MiB |        28.807 s |   10.85 MiB/s |               1.00x |
| Conflict upsert  |   1m | Native 128 + coarse |          312.50 MiB |         8.738 s |   35.76 MiB/s |               3.30x |
| Migration update | 100k | Ordinary            |           26.50 MiB |         2.617 s |   10.13 MiB/s |               1.00x |
| Migration update | 100k | Native 32           |           26.50 MiB |         0.867 s |   30.56 MiB/s |               3.02x |
| Migration update |   1m | Ordinary            |          265.97 MiB |        26.790 s |    9.93 MiB/s |               1.00x |
| Migration update |   1m | Native 32           |          265.97 MiB |         8.750 s |   30.40 MiB/s |               3.06x |
| Migration update |   1m | Native 128          |          265.97 MiB |         7.919 s |   33.58 MiB/s |               3.38x |
| Migration update |   1m | Native 128 + coarse |          265.97 MiB |         6.216 s |   42.79 MiB/s |               4.31x |

### Latency and Scale

| Workload         | Rows | Configuration       | PostgreSQL Statement + Commit | Commit to Ready | SQL Start to Ready |  Rows/s | Event-Loop p99 |
| ---------------- | ---: | ------------------- | ----------------------------: | --------------: | -----------------: | ------: | -------------: |
| Conflict upsert  | 100k | Ordinary            |                     703.97 ms |         2.740 s |            3.444 s |  36,498 |        4.65 ms |
| Conflict upsert  | 100k | Native 128 + coarse |                     727.42 ms |         0.943 s |            1.670 s | 106,069 |        6.64 ms |
| Conflict upsert  |   1m | Ordinary            |                       6.985 s |        28.807 s |           35.792 s |  34,713 |        4.65 ms |
| Conflict upsert  |   1m | Native 128 + coarse |                       7.115 s |         8.738 s |           15.853 s | 114,440 |        6.69 ms |
| Conflict upsert  |   3m | Native 128 + coarse |                      23.995 s |        26.822 s |           50.817 s | 111,847 |        6.38 ms |
| Migration update |   1m | Ordinary            |                       1.555 s |        26.790 s |           28.345 s |  37,328 |        4.83 ms |
| Migration update |   1m | Native 128 + coarse |                       1.514 s |         6.216 s |            7.729 s | 160,881 |       11.49 ms |

PostgreSQL execution did not improve because the optimization begins in the logical replication consumer. On the one-million-row customer fixture, Zero drain improved 69.7% and total SQL-start-to-ready improved 55.7%.

## Contribution by Change

### Conflict Upsert, 100k Rows

| Step                        | Commit to Ready | Change From Previous | Application Statements |           ChangeLog Statements | Interpretation                                                 |
| --------------------------- | --------------: | -------------------: | ---------------------: | -----------------------------: | -------------------------------------------------------------- |
| Ordinary                    |         2.740 s |             Baseline |                100,000 |                        100,000 | Per-row pipeline                                               |
| Native 32, rowwise SQLite   |         1.165 s |         57.5% faster |                100,000 |                        100,000 | Message and ChangeDB reduction provided most of the first gain |
| Native 32, set-based SQLite |         1.125 s |          3.4% faster |                  3,125 |                          3,125 | Statement reduction helped modestly end to end                 |
| Native 128                  |         1.061 s |          5.7% faster |                    782 |                            782 | Fewer canonical and worker messages helped further             |
| Native 128 + coarse reset   |         0.943 s |         11.1% faster |                    782 | 392 including reset accounting | ChangeLog cardinality and commit cost fell                     |

These arms ran as separate processes and were not alternated. The larger changes are meaningful; the small differences need repeated confirmation.

### Migration Update, 1m Rows

| Step                | Commit to Ready | Logical MiB/s | ChangeDB Messages |   SQLite Writes | Interpretation                                     |
| ------------------- | --------------: | ------------: | ----------------: | --------------: | -------------------------------------------------- |
| Ordinary            |        26.790 s |    9.93 MiB/s |         1,000,002 |       2,000,003 | Baseline                                           |
| Native 32           |         8.750 s |   30.40 MiB/s |            31,252 |          62,503 | Primary batching gain                              |
| Native 128          |         7.919 s |   33.58 MiB/s |             7,815 |          15,629 | 9.5% better than native 32                         |
| Native 128 + coarse |         6.216 s |   42.79 MiB/s |             7,815 | 8,208 effective | Coarse reset removed most row-level ChangeLog work |

The emitted SQLite metric for the coarse run was 8,206 before reset statement accounting was corrected. The effective count is 8,208: 7,813 application statements, 390 pre-threshold ChangeLog statements, two coarse-reset statements, one transaction-begin count, and two watermark/commit counts.

## One-Million-Row Stage Attribution

### Conflict Upsert

| Stage                       |   Ordinary | Native 128 + Coarse |              Change |
| --------------------------- | ---------: | ------------------: | ------------------: |
| Source logical messages     |  1,000,002 |           1,000,002 |    Same source work |
| Canonical ChangeDB messages |  1,000,002 |               7,815 |         99.2% fewer |
| Canonical downstream bytes  | 327.678 MB |           36.999 MB |         88.7% fewer |
| ChangeStreamer stringify    |    1.689 s |            194.5 ms |         88.5% lower |
| ChangeDB flush time sum     |    5.790 s |            519.8 ms |         91.0% lower |
| Worker requests             |     31,251 |                 245 |         99.2% fewer |
| Worker post-message time    |   683.8 ms |             77.9 ms |         88.6% lower |
| Worker round-trip time sum  |   10.410 s |             4.630 s |         55.5% lower |
| SQLite row conversion       |   614.5 ms |            668.5 ms |     Slightly higher |
| SQLite ChangeLog            |    2.389 s |             79.7 ms |         96.7% lower |
| SQLite application DML      |    4.681 s |             3.267 s |         30.2% lower |
| SQLite commit               |   190.7 ms |             54.2 ms |         71.6% lower |
| Final `changeLog2` rows     |  1,000,000 |                   1 | Coarse reset marker |
| Event-loop p99              |    4.65 ms |             6.69 ms |      2.04 ms higher |

Stage sums overlap because ChangeDB storage, forwarding, and SQLite application are pipelined. They are attribution signals, not additive wall-clock decomposition. ChangeDB flush and worker round-trip fields are sums of individual asynchronous durations.

### Exact Optimized 1m Sample

| Field                              |            Value |
| ---------------------------------- | ---------------: |
| PostgreSQL statement + commit      |  7,115.067916 ms |
| Commit to ready                    |  8,738.206625 ms |
| Total ready                        | 15,853.274541 ms |
| Event-loop p99                     |      6.688767 ms |
| Batch construction                 |  1,253.049390 ms |
| Canonical messages                 |            7,815 |
| Canonical ChangeDB payload bytes   |       36,928,157 |
| Canonical downstream bytes         |       36,998,549 |
| ChangeDB flushes                   |                4 |
| ChangeDB flush duration sum        |    519.780000 ms |
| Worker requests                    |              245 |
| Worker messages                    |            7,815 |
| Worker round-trip duration sum     |  4,629.648667 ms |
| Application statements             |            7,813 |
| Pre-threshold ChangeLog statements |              390 |
| Set-based rows                     |        1,000,000 |
| Rowwise fallback rows              |                0 |
| Discarded ChangeLog entries        |           49,920 |
| Row conversion                     |    668.461013 ms |
| ChangeLog work                     |     79.652117 ms |
| Application DML                    |  3,267.123845 ms |
| SQLite commit                      |     54.221334 ms |

### Exact Ordinary 1m Sample

| Field                            |            Value |
| -------------------------------- | ---------------: |
| PostgreSQL statement + commit    |  6,984.632458 ms |
| Commit to ready                  | 28,807.447042 ms |
| Total ready                      | 35,792.079500 ms |
| Event-loop p99                   |      4.648959 ms |
| Canonical messages               |        1,000,002 |
| Canonical ChangeDB payload bytes |      318,678,013 |
| Canonical downstream bytes       |      327,678,088 |
| ChangeDB flushes                 |              501 |
| ChangeDB flush duration sum      |  5,790.354749 ms |
| Worker requests                  |           31,251 |
| Worker messages                  |        1,000,002 |
| Worker round-trip duration sum   | 10,410.412437 ms |
| Application statements           |        1,000,000 |
| ChangeLog statements             |        1,000,000 |
| Row conversion                   |    614.459424 ms |
| ChangeLog work                   |  2,388.656509 ms |
| Application DML                  |  4,680.756557 ms |
| SQLite commit                    |    190.745209 ms |

## Three-Million-Row Scale Screen

| Field                            |  Optimized Value |
| -------------------------------- | ---------------: |
| PostgreSQL statement + commit    | 23,994.700917 ms |
| Commit to ready                  | 26,822.375500 ms |
| Total ready                      | 50,817.076417 ms |
| Rows/s                           |          111,847 |
| Event-loop p99                   |      6.377471 ms |
| Canonical ChangeDB messages      |           23,440 |
| Canonical ChangeDB payload bytes |      117,428,157 |
| Canonical downstream bytes       |      117,639,176 |
| Batch construction               |  3,697.350726 ms |
| ChangeDB flushes                 |               12 |
| ChangeDB flush duration sum      |  1,606.370414 ms |
| Worker requests                  |              733 |
| Worker round-trip duration sum   | 14,534.762839 ms |
| Application statements           |           23,438 |
| Effective SQLite writes          |           23,833 |
| Row conversion                   |  2,103.730446 ms |
| ChangeLog work                   |     93.157785 ms |
| Application DML                  | 10,368.323022 ms |
| SQLite commit                    |    284.228000 ms |
| Discarded ChangeLog entries      |           49,920 |

The source logical byte count was not captured for this run after byte accounting was disabled, so the 112.19 MiB canonical downstream payload must not be presented as source logical throughput.

## Batch-Size Sweep

The 100,000-row all-conflict fixture used the same source logical volume in each arm.

| Batch Size | Commit to Ready | Canonical Messages | Canonical Downstream Bytes | Worker Requests | Application DML | Event-Loop p99 |
| ---------: | --------------: | -----------------: | -------------------------: | --------------: | --------------: | -------------: |
|         32 |    1,124.785 ms |              3,127 |                  4,106,211 |              98 |      240.265 ms |        6.80 ms |
|        128 |    1,061.149 ms |                784 |                  3,410,340 |              25 |      294.580 ms |        6.57 ms |
|        256 |    1,072.542 ms |                393 |                  3,294,213 |              13 |      368.340 ms |        6.46 ms |

Batch 128 was the measured knee. Batch 256 reduced message count further but increased SQLite application time enough to erase the gain. The 256 KiB cap also limits effective rows for wide updates.

## Secondary Unique Indexes

The initial implementation fell back rowwise whenever a table had any secondary unique index. That excluded the representative conflict-upsert table even when its business key values did not change.

The final experiment:

1. Writes the ChangeLog entries once.
2. Attempts the set-based application statement.
3. On `SQLITE_CONSTRAINT_UNIQUE`, relies on SQLite statement atomicity.
4. Retries only application writes rowwise in source order.

| 100k Conflict-Upsert Variant            | Commit to Ready | Application Statements | Rowwise Fallback Rows |
| --------------------------------------- | --------------: | ---------------------: | --------------------: |
| Native 32, conservative index fallback  |    1,164.786 ms |                100,000 |               100,000 |
| Native 32, optimistic set-based attempt |    1,124.785 ms |                  3,125 |                     0 |

The end-to-end difference was modest because message reduction was already dominant, but this avoided excluding customer tables from the SQLite fast path. Tests cover unchanged unique values, order-sensitive unique-key transitions, and permanent unique violations that must roll back the transaction.

## Coarse Reset

The normal ChangeLog records the latest operation for each changed row so ViewSyncer can advance incrementally. Separate crossover benchmarks found broad-query reset becoming competitive around 20,000 to 25,000 distinct row changes for one and ten groups. The integrated experiment uses 50,000 as a conservative threshold.

When the threshold is reached, the writer:

1. Deletes current-transaction row ChangeLog entries.
2. Writes one existing `RESET_OP` marker under the reserved `_zero.coarseReset` table name.
3. Continues applying every application-table row.
4. Stops logging ordinary row diffs for that transaction.

| Metric, 1m Migration |   Native 128 | Native 128 + Coarse |
| -------------------- | -----------: | ------------------: |
| Commit to ready      |      7.919 s |             6.216 s |
| Logical throughput   |  33.58 MiB/s |         42.79 MiB/s |
| ChangeLog statements |        7,813 |      390 plus reset |
| ChangeLog time       | 1,438.226 ms |           65.742 ms |
| SQLite commit        |   139.385 ms |           20.373 ms |
| Final ChangeLog rows |    1,000,000 |                   1 |

The reset does not discard application data. It changes how ViewSyncer advances from row replay to query rehydration.

Any active Zero column backfill disables coarse reset. Backfills require row-level conflict versions so snapshot data cannot overwrite newer replicated values. If a backfill begins after a transaction has switched to coarse mode, subsequent conflict metadata must still be retained.

Full ViewSyncer, CVR, and client-patch cost is not included in the migration benchmark. The separate crossover benchmark covers synthetic pipeline work, but production enablement requires an end-to-end serving test.

## RTT Sensitivity

The optimized 100,000-row conflict-upsert fixture generated 30.9735 MiB of source logical messages in every arm.

|    RTT | Commit to Ready | Logical MiB/s | Throughput Loss vs Direct | Canonical Messages |
| -----: | --------------: | ------------: | ------------------------: | -----------------: |
| Direct |      942.780 ms |   32.85 MiB/s |                  Baseline |                784 |
|   5 ms |    1,212.277 ms |   25.55 MiB/s |                     22.2% |                784 |
|  20 ms |    2,070.276 ms |   14.96 MiB/s |                     54.5% |                784 |

| Shaper Metric               |         5 ms |        20 ms |
| --------------------------- | -----------: | -----------: |
| Client-to-server bytes      |       13,676 |       13,676 |
| Client-to-server chunks     |          115 |          120 |
| Client-to-server peak queue |    439 bytes |    439 bytes |
| Server-to-client bytes      |    3,426,871 |    3,426,871 |
| Server-to-client chunks     |          105 |          105 |
| Server-to-client peak queue | 68,605 bytes | 68,605 bytes |

The exact ordinary RTT matrix for this conflict-upsert fixture was not run. A historical unoptimized 20,000-row full-path screen used a different fixture and showed:

|    RTT | Historical Ordinary Logical MiB/s | Throughput Loss vs Direct |
| -----: | --------------------------------: | ------------------------: |
| Direct |                       37.24 MiB/s |                  Baseline |
|   5 ms |                        5.91 MiB/s |                     84.1% |
|  20 ms |                        2.23 MiB/s |                     94.0% |
|  50 ms |                        1.01 MiB/s |                     97.3% |

The historical table demonstrates severe flow-control sensitivity but is not directly comparable to the current conflict-upsert fixture. The missing apples-to-apples ordinary 0/5/20 ms matrix remains required.

## Mixed Inserts and Updates

The mixed fixture sends one 100,000-row conflict-upsert transaction containing 50,000 existing and 50,000 new external records, ordered so inserts and updates alternate. The final replica contains 150,000 rows.

| Implementation                   | Commit to Ready | Logical MiB/s | Batch Construction | Canonical Messages | Result           |
| -------------------------------- | --------------: | ------------: | -----------------: | -----------------: | ---------------- |
| Ordinary                         |    2,800.728 ms |   10.74 MiB/s |               None |            100,002 | Baseline         |
| Emit singleton `update-batch`    |    3,884.274 ms |    7.74 MiB/s |         717.569 ms |            100,002 | 38.7% regression |
| Defer until two adjacent updates |    2,832.434 ms |   10.62 MiB/s |          11.307 ms |            100,002 | Neutral          |

Update-only batching cannot optimize this shape because every insert is a barrier. Deferring all expensive batch construction until a second adjacent update removes the regression. A heterogeneous insert/update batch is needed to optimize arbitrarily interleaved external sync jobs.

## Approaches That Did Not Work

| Approach                                               | Result                                             | Decision                                                                   |
| ------------------------------------------------------ | -------------------------------------------------- | -------------------------------------------------------------------------- |
| Post-stringify semantic batching                       | About 1% to 6% on matched full-path RTT screens    | Too late in the pipeline; does not reduce first stringify or ChangeDB rows |
| Raw WebSocket frame batching                           | Reduced frames but regressed full-pipeline latency | Do not pursue without redesigning flow control                             |
| Cumulative ACKs                                        | Fewer ACKs but delayed consumption-promise release | Do not ship independently                                                  |
| Batch size 256                                         | Slightly slower than 128                           | Keep 128 as the measured row cap                                           |
| Conservative fallback for every secondary unique index | Correct but excluded the customer table            | Replace with optimistic set-based attempt and safe retry                   |
| Singleton update batches                               | 38.7% regression on mixed upserts                  | Defer batching until a pair exists                                         |
| Exact source byte accounting in the hot path           | Added hundreds of milliseconds at 100k rows        | Disable in performance runs; derive source volume outside timing           |

Worker request depth two improved earlier independent benchmarks but was not part of the final optimized configuration. It must be remeasured after native batching because the one-million-row request count has already fallen from 31,251 to 245.

## Correctness Coverage

| Area             | Coverage                                                                           |
| ---------------- | ---------------------------------------------------------------------------------- |
| Protocol schemas | Production schemas reject batches; experimental schemas accept them                |
| Ordering         | Begin, commit, rollback, status, control, relation, shape, and DML barriers        |
| Keys             | Composite bigint keys, duplicate keys, key-changing updates, full replica identity |
| Values           | Undefined omission, JSON values, wide values, 256 KiB limit                        |
| SQLite           | Partial updates, missing-row fallback, row versions, statement parameter limits    |
| Constraints      | `CHECK`, `NOT NULL`, secondary unique order, permanent unique failure              |
| Atomicity        | Explicit rollback and constraint failure restore application rows and ChangeLog    |
| Backfills        | Rowwise fallback and preservation of `backfillingColumnVersions`                   |
| Coarse reset     | One reset marker, preflight behavior, active-backfill rejection                    |
| Worker           | Structured clone, abort, stop, request IDs, write-error propagation                |

Verification after the final changes:

| Check                                   | Result                                 |
| --------------------------------------- | -------------------------------------- |
| No-Postgres tests                       | 99 files, 1,496 tests passed           |
| Focused PostgreSQL ChangeStreamer tests | 27 passed                              |
| TypeScript                              | Passed                                 |
| Lint                                    | Zero errors, 446 pre-existing warnings |
| Focused code formatting                 | Passed                                 |
| Markdown formatting                     | Passed                                 |

## Minimal Backward-Compatible Options

The experiment currently combines protocol-neutral SQLite changes with a new persisted message format. Those should not ship as one patch.

### Option A: Protocol-Neutral SQLite Optimization

Keep protocol version 6 and ordinary ChangeDB rows. Group adjacent compatible ordinary updates only after they reach the write worker.

| Change                                 | Include           |
| -------------------------------------- | ----------------- |
| Internal worker-side set-based updates | Yes               |
| Multi-row ChangeLog writes             | Yes               |
| Coarse reset behind a default-off flag | Yes               |
| Active-backfill exclusion              | Yes               |
| Unique-conflict rowwise retry          | Yes               |
| Persisted `update-batch`               | No                |
| Heterogeneous insert/update batch      | No                |
| Worker depth two                       | Separate decision |

| Compatibility Surface   | Result       |
| ----------------------- | ------------ |
| Protocol-v6 subscribers | Compatible   |
| Existing ChangeDB       | Compatible   |
| Rolling deployment      | Compatible   |
| Rollback                | Compatible   |
| SQLite schema           | No migration |

This captures SQLite and coarse-reset gains but not the largest ChangeStreamer, ChangeDB, WebSocket, and worker-message gains. The exact ordinary-wire plus internal-SQLite plus coarse combination has not been benchmarked and must be measured before estimating its value.

### Option B: Full Gain with Reader-First Rollout

The main gain requires batches before ChangeDB storage. Backward compatibility therefore needs an expand-and-contract rollout.

#### Release A: Readers Only

| Component               | Behavior                                   |
| ----------------------- | ------------------------------------------ |
| ChangeDB catchup reader | Accept ordinary updates and `update-batch` |
| New protocol subscriber | Accept `update-batch`                      |
| Protocol-v6 subscriber  | Receive down-converted ordinary updates    |
| ChangeStreamer writer   | Continue writing ordinary updates          |
| Write feature flag      | Forced off                                 |

An eligible batch can be down-converted exactly because it contains `relation`, ordered `columns`, and `rowValues`, and only represents updates with `key: null`.

#### Release B: Writer Disabled by Default

| Component              | Behavior                                            |
| ---------------------- | --------------------------------------------------- |
| ChangeStreamer         | Can persist native batches                          |
| Subscriber negotiation | Batch for capable readers, expansion for protocol 6 |
| ChangeProcessor        | Set-based batch application                         |
| Feature flag           | Off by default and scoped by shard                  |

Rollback from Release B must target Release A or newer. A pre-reader binary cannot safely replay ChangeDB history containing the new tag. Disabling new writes does not remove already-persisted batches.

#### Release C: Controlled Enablement

| Gate                   | Requirement                                                |
| ---------------------- | ---------------------------------------------------------- |
| Minimum reader version | Release A everywhere                                       |
| Batch bounds           | 128 rows and 256 KiB                                       |
| Singleton handling     | Emit original update                                       |
| Protocol-v6 client     | Down-convert                                               |
| Active Zero backfill   | No coarse reset; rowwise conflict handling                 |
| Metrics                | Batch ratio, singleton ratio, fallback rows, reset count   |
| Rollback               | Disable writes; reader-compatible binaries continue replay |

Ordinary update support should remain indefinitely because old writers and old ChangeDB history can still produce row messages.

### Coarse-Reset Compatibility

Coarse reset uses the existing ChangeLog columns and `RESET_OP`; it requires no SQLite schema migration. The reserved `_zero.coarseReset` table name lets the new Snapshotter detect it before row traversal. Older Snapshotters are expected to treat the existing reset operation as destructive and rehydrate, but the exact previous 1.8 implementation must be tested against a replica containing the marker before calling this a release guarantee.

## Recommended Patch Split

| Patch | Scope                                                              | Behavior Change                                        |
| ----: | ------------------------------------------------------------------ | ------------------------------------------------------ |
|     1 | Benchmark fixtures and bounded instrumentation                     | None                                                   |
|     2 | Worker-internal set-based updates and ChangeLog writes             | Protocol-neutral                                       |
|     3 | Coarse reset behind a default-off flag                             | Protocol-neutral                                       |
|     4 | Batch reader, down-converter, and compatibility tests              | Reads only                                             |
|     5 | Native batch writer behind a default-off shard flag                | New persisted format                                   |
|     6 | Full ViewSyncer/CVR/client-patch benchmarks and controlled rollout | Operational enablement                                 |
|     7 | Heterogeneous insert/update design                                 | Later, if production run-length telemetry justifies it |

## Reproduction

Run from `packages/zero-cache` in the mono repository.

### Command Template

```sh
ZERO_REPLICATION_BENCH_CONFLICT_UPSERT=1 \
ZERO_REPLICATION_BENCH_UPDATE_MIGRATION_SEED_ROWS=1000000 \
ZERO_REPLICATION_BENCH_UPDATE_MIGRATION_ROWS=1000000 \
ZERO_REPLICATION_BENCH_NATIVE_UPDATE_BATCH_ROWS=128 \
ZERO_REPLICATION_BENCH_COARSE_RESET_ROWS=50000 \
ZERO_REPLICATION_BENCH_WARMUP_REPS=0 \
ZERO_REPLICATION_BENCH_REPS=1 \
ZERO_REPLICATION_BENCH_SKIP_THROUGHPUT=1 \
ZERO_REPLICATION_BENCH_SKIP_LATENCY=1 \
pnpm exec vitest run --config vitest.config.bench.pg.ts \
  src/services/replicator/replication-throughput.bench.pg.ts
```

### Workload Matrix

| Workload                  | Environment Differences                                                                            |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| Ordinary migration        | `ZERO_REPLICATION_BENCH_UPDATE_MIGRATION=1`, omit native and coarse variables                      |
| Optimized migration       | `ZERO_REPLICATION_BENCH_UPDATE_MIGRATION=1`, native `128`, coarse `50000`                          |
| Ordinary conflict upsert  | `ZERO_REPLICATION_BENCH_CONFLICT_UPSERT=1`, omit native and coarse variables                       |
| Optimized conflict upsert | Template above                                                                                     |
| Three million             | Set seed and migration rows to `3000000`                                                           |
| 5 ms RTT                  | Add `ZERO_REPLICATION_BENCH_RTT_MS=5`                                                              |
| 20 ms RTT                 | Add `ZERO_REPLICATION_BENCH_RTT_MS=20`                                                             |
| Mixed 50/50               | Add new rows `50000` and `ZERO_REPLICATION_BENCH_INTERLEAVE_CONFLICT_UPSERT=1` to the 100k fixture |
| Batch 32/256              | Set `ZERO_REPLICATION_BENCH_NATIVE_UPDATE_BATCH_ROWS` accordingly                                  |

### Missing Confirmations

| Confirmation                                              | Reason                                                   |
| --------------------------------------------------------- | -------------------------------------------------------- |
| Ordinary conflict upsert at 5 and 20 ms RTT               | Required for apples-to-apples network sensitivity        |
| Repeated alternating 100k and 1m arms                     | Current large-transaction results are one-sample screens |
| Protocol-neutral internal SQLite batching                 | Quantifies the minimal backward-compatible option        |
| Full ViewSyncer, CVR, and client patch                    | Required before enabling coarse reset                    |
| Active backfill plus later coarse eligibility transitions | Required for rollout confidence                          |
| Real customer table shapes and operation run lengths      | Determines benefit for mixed external sync jobs          |

## Files

| File                                                           | Role                                                             |
| -------------------------------------------------------------- | ---------------------------------------------------------------- |
| `services/change-streamer/semantic-update-batch.ts`            | Native eligibility, bounds, singleton deferral, and metrics      |
| `services/change-streamer/change-streamer-service.ts`          | Pre-stringify canonical batching point                           |
| `services/change-streamer/storer.ts`                           | Canonical ChangeDB storage and benchmark timing                  |
| `services/change-source/protocol/current/data.ts`              | Experimental update-batch message schema                         |
| `services/change-source/protocol/current/downstream.ts`        | Production and experimental downstream unions                    |
| `services/replicator/change-processor.ts`                      | Set-based apply, unique retry, missing rows, coarse reset        |
| `services/replicator/schema/change-log.ts`                     | Multi-row writes and coarse reset marker                         |
| `services/replicator/incremental-sync.ts`                      | Worker request batching and transaction barriers                 |
| `services/replicator/replication-throughput.bench.pg.ts`       | Real PostgreSQL, ChangeDB, WebSocket, worker, and SQLite fixture |
| `services/replicator/semantic-update-batch-experiment.test.ts` | Semantic and atomicity coverage                                  |
| `test/network-shaper.ts`                                       | Deterministic RTT, jitter, bandwidth, and queue metrics          |
