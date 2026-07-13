# Replication Worker Batching Experiment

## Conclusion

Bounded worker request batching preserves the write worker's event-loop isolation while removing most per-row request/response round trips. A 32-message, transaction-bounded batch improved production-loopback bulk throughput by 22% and also improved one-row and 100-row commit latency.

The permanent candidate uses a count limit of 32, keeps one request in flight, and flushes at commit or rollback. Exact byte caps were rejected because calculating parsed-message sizes required another serialization pass and made the tested workload slower.

## Worker And Serialization Isolation

These are median costs for precomputed replication data messages. The worker result uses a no-op worker thread with a null response.

| Payload | Stringify | Parse | Validate | Parse + Validate | Structured Clone | Worker Round Trip |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Narrow | 0.89 us | 1.53 us | 0.46 us | 2.05 us | 1.40 us | 9.42 us |
| Wide | 3.36 us | 3.20 us | 0.44 us | 3.76 us | 1.61 us | 10.31 us |
| Nested JSON | 2.23 us | 2.66 us | 1.32 us | 4.15 us | 2.83 us | 11.00 us |
| Bigint-heavy | 1.84 us | 7.66 us | 1.14 us | 9.00 us | 2.07 us | 10.90 us |

For ordinary messages, serial worker scheduling was substantially more expensive than validation or one structured clone. Bigint-heavy parsing was the notable serialization exception.

## Batch Sweep

The temporary direct-string benchmark used ten independent samples per variant. Lower time per generated-text payload MB is better.

| Worker Batch | Time / MB | Approx. Throughput | Event-Loop p99 |
| ---: | ---: | ---: | ---: |
| 1 | 29.01 ms | 34.5 MB/s | 4.42 ms |
| 8 | 26.01 ms | 38.4 MB/s | 4.85 ms |
| 32 | 22.80 ms | 43.9 MB/s | 5.34 ms |
| 128 | 21.26 ms | 47.0 MB/s | 6.92 ms |

Batch 32 was the best initial throughput/responsiveness tradeoff. Batch 128 provided another 7% throughput over 32 but increased event-loop p99 by about 30%.

## Production Loopback

This comparison used the real `ChangeStreamerHttpServer` and `ChangeStreamerHttpClient` over localhost, including WebSocket framing, ACKs, `BigIntJSON` parsing, and Valita validation.

| Worker Batch | Time / MB | Approx. Throughput | Event-Loop p99 |
| ---: | ---: | ---: | ---: |
| 1 | 39.70 ms | 25.2 MB/s | 4.69 ms |
| 32 | 32.62 ms | 30.7 MB/s | 4.98 ms |

Batch 32 improved production-loopback throughput by 22% while increasing event-loop p99 by 0.29 ms.

Exact byte-limited variants used a count cap of 128 and re-stringified parsed messages to measure bytes:

| Byte Limit | Time / MB | Event-Loop p99 |
| ---: | ---: | ---: |
| 64 KiB | 35.02 ms | 4.79 ms |
| 256 KiB | 34.99 ms | 4.90 ms |

Both were slower than count-bounded batch 32. The final candidate therefore bounds memory by message count without adding a second serialization pass.

## Commit Latency

The temporary baseline comparison inserted new rows serially and waited for SQLite after every transaction.

| Workload | Metric | Batch 1 | Batch 32 | Change |
| --- | --- | ---: | ---: | ---: |
| One row | Median drain | 0.64 ms | 0.35 ms | -46% |
| One row | Total p99 | 3.85 ms | 2.98 ms | -23% |
| 100 rows | Median drain | 7.65 ms | 5.83 ms | -24% |
| 100 rows | Total p99 | 21.91 ms | 16.94 ms | -23% |

Batching improved latency because a one-row transaction crosses the worker boundary once instead of once each for begin, data, and commit.

## SQLite Decomposition

A synthetic 20,000-row SQLite transaction used 1 KiB payloads and worker batches of 32.

| Apply Mode | SQLite Configuration | Time / MB |
| --- | --- | ---: |
| Inline | Row-key index, no change log | 5.89 ms |
| Worker | Row-key index, no change log | 7.45 ms |
| Inline | Row-key index and change log | 7.92 ms |
| Worker | Row-key index and change log | 11.01 ms |
| Inline | Three secondary indexes and change log | 10.79 ms |
| Worker | Three secondary indexes and change log | 11.38 ms |

The no-change-log variant retained the SQLite primary key but supplied an empty protocol row key, which is a benchmark-only lower bound. It showed that `_zero.changeLog2` is material. The secondary-index comparison was noisier and needs alternated samples before using its exact percentages.

## Permanent Benchmark Results

The repaired benchmark uses the current batch-32 implementation, 20 fresh samples per transport, exact upstream XID-to-replica-watermark correlation, separate write and drain timing, aggregate payload/key validation, and post-timing ChangeDB durability checks.

| Metric | In Process | Production Loopback |
| --- | ---: | ---: |
| Upstream write time / MB | 8.75 ms | 9.16 ms |
| Final commit to SQLite ready | 2.51 s | 4.65 s |
| Total ingest time / MB | 21.63 ms | 32.69 ms |
| Total ingest throughput | 46.2 MB/s | 30.6 MB/s |
| Event-loop p99 | 5.08 ms | 4.91 ms |

The final-commit drain metric is the remaining backlog after the final commit returns, not per-transaction latency.

The permanent low-rate benchmark updates a fixed-size 25,000-row database and verifies ChangeDB durability outside the SQLite timing endpoint:

| Workload | Upstream Median | SQLite Drain Median | Total Median | Total p99 |
| --- | ---: | ---: | ---: | ---: |
| One-row update | 1.22 ms | 0.94 ms | 2.21 ms | 5.87 ms |
| 100-row update | 1.24 ms | 5.44 ms | 6.74 ms | 11.85 ms |

## Correctness Finding

The new mid-batch failure test found a stale-response race in the existing worker protocol. `ChangeProcessor` can emit an asynchronous `writeError` and then the worker can send the request's normal response. If the client immediately aborts and starts another request, the stale response could resolve the new pending request because responses had no request IDs.

Worker requests and responses now carry monotonically increasing IDs. Stale responses are ignored, and the failure/abort/recovery test verifies that a subsequent transaction commits normally.

## Permanent Benchmark Fixes

The repaired benchmark now:

- Separates the direct-string ingestion path from production HTTP/WebSocket loopback.
- Uses fresh upstream, ChangeDB, SQLite, streamer, replicator, and worker state for every throughput sample.
- Correlates the final upstream XID to its exact commit watermark.
- Waits for `version-ready` instead of polling SQLite every 50 ms.
- Records upstream write, final-commit drain, total ingest, and event-loop delay separately.
- Uses fixed-size updates for low-rate latency instead of growing the database.
- Validates per-table counts, identity sums, and payload byte sums after timing.
- Verifies that ChangeDB reaches the same target watermark after timing.
- Labels throughput as generated-text payload MB rather than total wire, WAL, or storage bytes.

## Remaining Opportunities

- Production transport adds roughly 11 ms per generated-text MB over the in-process path after batching and is the next major attribution target.
- `_zero.changeLog2` maintenance is a material part of SQLite apply cost.
- Bigint-heavy messages remain sensitive to JSON parsing cost.
- Flow-control thresholds and slow-subscriber queue growth have not yet been optimized.
