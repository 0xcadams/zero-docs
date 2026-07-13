# Large-Transaction and Backfill Experiments

## Conclusion

Follow-up work moved semantic update batching before the first stringify and ChangeDB storage. On the representative one-million-row conflict upsert, native 128-row batches plus a 50,000-row coarse-reset threshold improved commit-to-ready time from 28.81 seconds to 8.74 seconds and logical-message throughput from 10.85 MiB/s to 35.76 MiB/s. See [Native Update Batching for Huge Transactions](./replication-native-update-experiment.md) for the 100,000-row, one-million-row, three-million-row, RTT, stage-attribution, mixed-workload, and compatibility results.

Semantic row batching has the largest remaining replication-throughput ceiling. An experimental 50-row insert message reduced logical messages and SQLite write statements by 50x, improving median production-loopback row throughput by 11.0x for narrow rows and 2.29x for wide rows across three alternating repetitions.

Four other approaches also produced actionable results:

- Grouped 50-row backfill UPSERTs improved isolated 100,000-row apply time by about 18% to 26%. Bulk ChangeLog lookup did not help and should not be included.
- Two-deep worker pipelining improved the permanent production-loopback throughput workload by 10.9% without changing bulk event-loop p99, but separate-run one-row latency was noisy and needs an interleaved gate before rollout.
- A coarse pipeline reset crossed incremental advancement at about 20,000 to 25,000 distinct row changes for one and ten broad-query client groups. A conservative first threshold would be 50,000, with compaction forbidden for tables undergoing backfill.
- Restoring a newer local snapshot beat replaying a stale replica above roughly 1.4 to 1.7 MiB of encoded ChangeDB history. This is a local-copy lower bound; real Litestream and object-store costs will move the production crossover higher.

All new behavior remains opt-in or benchmark-only. Production continues to use worker batch 32, worker request depth 1, ordinary row messages, exact backfill progress scans, row-level ChangeLog entries, and stale-replica replay.

## Throughput in MiB/s

For batching experiments, logical payload throughput is the same application row-value bytes divided by end-to-end time. This avoids penalizing batching for removing wire metadata. Absolute rates are comparable within each row, not across fixtures with different payload definitions.

| Experiment                | Workload            |      Before |       After |         Gain | Multiplier |
| ------------------------- | ------------------- | ----------: | ----------: | -----------: | ---------: |
| Semantic insert batches   | Narrow rows         |  0.99 MiB/s | 10.86 MiB/s |  +9.87 MiB/s |      11.0x |
| Semantic insert batches   | Wide rows           | 32.91 MiB/s | 75.33 MiB/s | +42.41 MiB/s |      2.29x |
| Backfill UPSERT batches   | No conflicts        | 67.78 MiB/s | 91.36 MiB/s | +23.59 MiB/s |      1.35x |
| Backfill UPSERT batches   | Mixed conflicts     | 66.28 MiB/s | 81.24 MiB/s | +14.96 MiB/s |      1.23x |
| Worker request pipelining | Production loopback | 34.84 MiB/s | 39.11 MiB/s |  +4.27 MiB/s |      1.12x |

Semantic batching also sends fewer bytes. Actual wire throughput therefore describes transport efficiency but understates the improvement in logical application work completed.

| Workload    | Ordinary Wire Rate | Batched Wire Rate |  Wire Volume Reduction |
| ----------- | -----------------: | ----------------: | ---------------------: |
| Narrow rows |         4.73 MiB/s |        6.91 MiB/s |  20.84 MiB to 2.77 MiB |
| Wide rows   |        37.05 MiB/s |       71.28 MiB/s | 14.69 MiB to 12.35 MiB |

For restore versus replay, the following is an equivalent backlog-clearance rate. Restore skips the encoded ChangeDB backlog rather than processing or transferring it, so its rate is not network throughput.

| Encoded Lag | Replay Existing Replica | Restore Newer Snapshot | Winner  |
| ----------: | ----------------------: | ---------------------: | ------- |
|    1.02 MiB |              8.92 MiB/s |             7.66 MiB/s | Replay  |
|    8.03 MiB |             30.02 MiB/s |            61.94 MiB/s | Restore |
|   64.03 MiB |             49.75 MiB/s |           504.16 MiB/s | Restore |

The 504.16 MiB/s result means that restoring the newer local snapshot avoided 64.03 MiB of ChangeDB replay in 127 ms. It does not mean that the snapshot was downloaded at that rate.

Some experiments do not have a meaningful MiB/s interpretation:

| Experiment                  | Better Metric                  | Result                           |
| --------------------------- | ------------------------------ | -------------------------------- |
| Backfill progress estimates | Startup latency                | 14.28 ms to 0.821 ms             |
| Coarse pipeline reset       | Changed rows and client groups | Crossover around 20k-25k changes |
| Worker responsiveness       | Event-loop p99                 | 4.54 ms to 4.57 ms               |

The semantic-batch and worker-pipeline gains were measured independently. They should not be multiplied without a combined benchmark because they remove overlapping portions of the replication pipeline.

## Backfill Apply

The existing backfill protocol already carries relation and column metadata once with multiple rows in `rowValues`. The current apply path nevertheless performs one ChangeLog lookup and one SQLite UPSERT per row.

The experiment separated row conversion, ChangeLog lookup, update-mask grouping, UPSERT execution, and commit. It used 100,000 composite-bigint rows with wide JSON and text values. The mixed workload included post-snapshot deletes and full and partial newer-column writes.

### Results

The final comparison retained per-row ChangeLog lookup, grouped rows by their permitted update-column mask, and used 50-row multi-VALUES UPSERTs.

| Workload           |     Current | Per-Row Lookup + Grouped 50-Row UPSERT | Improvement | UPSERT Statements |
| ------------------ | ----------: | -------------------------------------: | ----------: | ----------------: |
| No conflicts       | 8.87 us/row |                            6.58 us/row |       25.8% |  100,000 to 2,000 |
| Mixed newer writes | 9.07 us/row |                            7.40 us/row |       18.4% |   92,000 to 1,840 |

The preceding confirmation run measured improvements of 22.5% and 19.8%, respectively. The result is stable despite normal benchmark spread.

Bulk lookup through one `json_each` query was not the source of the win:

| Workload           | Per-Row Lookup + 50 Rows | Bulk Lookup + 50 Rows |
| ------------------ | -----------------------: | --------------------: |
| No conflicts       |              6.58 us/row |           6.64 us/row |
| Mixed newer writes |              7.40 us/row |           7.44 us/row |

Bulk lookup alone was neutral or slightly slower. It also creates a transient JSON array containing every key. Production implementation should retain the simple indexed per-row lookup and batch only the application-table UPSERTs.

The tests covered existing-row version preservation, new-row snapshot versions, deletes after the snapshot, partial and full newer-column masks, composite bigint keys, wide JSON/text conversion, statement remainders, and rollback.

## Backfill Pre-Scan

The PostgreSQL backfill source currently computes an exact row count and byte total before beginning COPY. On the 100,000-row wide fixture:

| Operation                            |   Median |
| ------------------------------------ | -------: |
| Exact count and byte pre-scan        | 14.28 ms |
| Estimated PostgreSQL statistics      | 0.821 ms |
| No pre-scan, COPY to first chunk     | 0.647 ms |
| Exact pre-scan then first COPY chunk | 14.97 ms |
| Complete binary COPY                 | 58.48 ms |

The exact progress scan consumed about 24% of complete COPY time and delayed the first chunk by about 14.3 ms. Both costs scale with table size. Estimated progress is the safer product option if exact percentages are not required; omitting progress totals entirely gives the fastest startup.

Estimated byte accuracy was not evaluated, so production behavior was left unchanged.

## Semantic Insert Batches

The experimental message carries relation and ordered columns once:

```ts
{
  tag: 'insert-batch',
  relation,
  columns: ['id', 'title', 'body'],
  rowValues: [
    [1, 'a', '...'],
    [2, 'b', '...'],
  ],
}
```

The transform batches only adjacent inserts with identical relation and column shape. Begin, commit, rollback, schema changes, backfills, updates, deletes, and shape changes are barriers. Batches are capped at 50 rows or 256 KiB.

The ChangeProcessor uses one multi-VALUES application write and one multi-row ChangeLog write per batch. The production protocol schema deliberately rejects this message unless the experiment schema and worker option are explicitly selected.

### End-to-End Results

The production-loopback path includes WebSocket framing, ACK flow control, `BigIntJSON.parse`, validation, structured clone, the real worker, serving SQLite, and ChangeLog writes.

| Workload    | Variant        | Messages | Wire JSON | SQLite Writes |  Elapsed |  Rows/s | Event-Loop p99 |
| ----------- | -------------- | -------: | --------: | ------------: | -------: | ------: | -------------: |
| Narrow 100k | Ordinary       |  100,002 |  21.86 MB |       200,003 | 4,404 ms |  22,707 |        5.48 ms |
| Narrow 100k | Semantic batch |    2,002 |   2.90 MB |         4,003 |   401 ms | 249,363 |        6.39 ms |
| Wide 10k    | Ordinary       |   10,002 |  15.40 MB |        20,003 |   397 ms |  25,218 |       11.97 ms |
| Wide 10k    | Semantic batch |      202 |  12.95 MB |           403 |   173 ms |  57,714 |        6.92 ms |

Median narrow-row throughput improved 11.0x and median wide-row throughput improved 2.29x. Variants alternated order across three repetitions. Earlier independent runs measured between 11.0x and 12.9x for narrow rows and between 1.93x and 2.28x for wide rows, confirming the direction and scale.

The narrow batch p99 result shows the remaining tradeoff: much larger logical messages create longer individual processing bursts even though total completion time is dramatically lower. Productionization should test smaller row and byte caps, especially 16/32 rows and 64/128 KiB, to find the event-loop-versus-throughput frontier.

This succeeds where raw WebSocket frame batching failed because it removes logical messages, parser calls, validation calls, ACKs, worker messages, and SQLite statements. Raw frame batching removed only physical frames and retained all downstream per-row work.

Correctness tests covered ordering barriers, oversized rows, rollback, duplicate keys, composite and bigint keys, JSON values, constraints, row versions, ChangeLog positions, and explicit production-schema rejection.

## Worker Request Pipelining

The depth-two experiment permits the main thread to clone and enqueue batch N+1 while the worker applies batch N. Commit and rollback remain hard barriers, requests and responses are correlated by ID, and any write failure rejects all affected pending requests.

### Isolated Serving Path

The dedicated benchmark uses `IncrementalSyncer`, the real worker, serving `ChangeProcessor`, WAL2 SQLite, and batch size 32.

| Workload |      Depth 1 |      Depth 2 | Improvement |
| -------- | -----------: | -----------: | ----------: |
| Narrow   |  5.52 us/row |  4.55 us/row |       21.3% |
| Wide     | 15.22 us/row | 14.20 us/row |        7.2% |

An earlier run measured 16.5% and 20.1%. Both runs cleared the 5% gate for both workloads.

### Production Loopback

Five measured 100,000-row samples through PostgreSQL, ChangeDB, ChangeStreamer, WebSocket, ACKs, worker, and serving SQLite produced:

| Metric                       |     Depth 1 |     Depth 2 |                Change |
| ---------------------------- | ----------: | ----------: | --------------------: |
| Total generated-text payload | 28.70 ms/MB | 25.57 ms/MB |          10.9% faster |
| Final commit to SQLite ready |      4.06 s |      3.17 s |          21.9% faster |
| Event-loop p99               |     4.54 ms |     4.57 ms | effectively unchanged |

The 100-row latency run improved from 6.08 to 5.76 ms median. The separately executed one-row run moved from 2.38 to 3.16 ms, but upstream write time and event-loop delay also moved materially between processes. A one-row transaction is sent as one barrier-terminated worker request and cannot use request pipelining, so the difference is not attributable to queued work. Run an interleaved same-process latency comparison before changing the default.

Tests cover FIFO ordering, commit and rollback barriers, mid-queue failure, abort, stop, stale responses, and write-error correlation.

## Coarse Pipeline Reset

The coarse experiment applies identical application-table contents in every arm, then replaces one committed transaction's row ChangeLog entries with a single backward-safe reset marker. Snapshotter performs a marker preflight so lagging client groups do not count or traverse older row entries before resetting.

### Broad Query Crossover

The fixture contains 100,000 rows, and each independent client group maintains a full-table query.

| Distinct Changes | Groups | Incremental | Timeout Fallback | Coarse Reset | Compaction |
| ---------------: | -----: | ----------: | ---------------: | -----------: | ---------: |
|              20k |      1 |      235 ms |           224 ms |       231 ms |     8.4 ms |
|              20k |     10 |    2,127 ms |         2,140 ms |     2,361 ms |     7.7 ms |
|              25k |      1 |      281 ms |           338 ms |       226 ms |    10.3 ms |
|              25k |     10 |    2,655 ms |         3,450 ms |     2,321 ms |     9.7 ms |
|              30k |      1 |      314 ms |           347 ms |       234 ms |    12.7 ms |
|              30k |     10 |    3,170 ms |         3,483 ms |     2,362 ms |    11.7 ms |

The crossover is between 20,000 and 25,000 distinct row entries for one and ten groups. At 25,000 changes and 100 groups, an exploratory run still found coarse reset 17% slower than forced incremental advancement. Current timeout fallback was even slower because many groups performed partial traversal before resetting.

A conservative first experimental threshold is therefore 50,000 distinct ChangeLog rows, not raw replication messages. A permanent policy should additionally consider estimated hydration work and active client-group count.

Selective and unrelated queries often make reset computationally faster because hydration is small, but reset re-emits unchanged rows. The synthetic selective workload emitted zero incremental changes and 100 rows per group after reset. Real CVR and client-patch costs can amplify that output difference.

Coarse compaction cannot delete conflict entries for a table with an active column backfill. The experiment rejects compaction if any affected table is backfilling. Schema changes, truncations, and backfill messages should also remain ineligible if automatic production compaction is added.

At 100,000 changes, compaction reduced `changeLog2` from 100,000 rows and 2,688,895 key bytes to one 24-byte marker.

## Replay Versus Restore

The recovery benchmark uses the real `restoreReplica` API, snapshot-status WebSocket path, production ChangeDB and ChangeStreamer, serving worker catchup, and final-watermark checks. A fake Litestream executable copies a local `VACUUM INTO` snapshot, so restore time is an intentionally optimistic lower bound.

| Encoded Stale Lag | Reuse and Replay | Restore Newer Snapshot | Winner           |
| ----------------: | ---------------: | ---------------------: | ---------------- |
|           1.07 MB |           115 ms |                 134 ms | replay by 14%    |
|           8.42 MB |           267 ms |                 130 ms | restore by 2.1x  |
|          67.14 MB |         1,287 ms |                 127 ms | restore by 10.1x |

The fitted crossover was 1.36 MiB in the confirmation run and 1.69 MiB in the first run. Production must measure the real destination because object-store request time, transfer, decompression, manifest processing, and cold filesystem writes all move the crossover upward.

Every measured restore verified final watermark, replica digest equality, `PRAGMA integrity_check`, restored backup watermark, and exact replay-byte/message/transaction accounting.

An automatic decision cannot be implemented with the current snapshot status, which includes only `backupURL`, `replicaVersion`, and `minWatermark`. At minimum it needs:

- Exact `backupWatermark`.
- Expected uncompressed restored database bytes.
- Expected compressed transfer bytes.
- Encoded replay bytes from the local watermark to head.
- Encoded tail bytes from backup watermark to head.
- Backup generation, format version, and verification time.

Repeated `restoreReplica` benchmark calls also exposed unreleased `SIGINT` and `SIGTERM` listeners after ten restores.

## Recommendations

1. Add protocol capability negotiation, then productionize bounded native update batches behind the negotiated version.
2. Build a heterogeneous insert/update batch for interleaved conflict-upsert jobs while preserving source order and constraint semantics.
3. Run native batches plus the 50,000-row coarse threshold through full ViewSyncer, CVR, and client-patch workloads before enabling automatic reset.
4. Productionize grouped 50-row backfill UPSERTs with per-row ChangeLog lookup and a SQLite parameter-limit cap.
5. Run an interleaved one-row/100-row latency gate, then make worker request depth 2 the default if latency remains neutral after native batching.
6. Replace exact backfill progress scans with estimates only after validating progress accuracy on representative production schemas.
7. Extend snapshot status and measure real Litestream destinations before implementing replay-versus-restore selection.

PostgreSQL protocol-v2 streaming was not implemented in this round. The completed work indicates that semantic batching and final SQLite application should be improved first; streaming mainly moves decode and transfer before commit and requires durable per-XID spooling, abort handling, interleaved transactions, and restart recovery.
