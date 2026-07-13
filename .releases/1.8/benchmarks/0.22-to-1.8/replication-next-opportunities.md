# Replication Next-Opportunity Experiments

## Conclusion

This document records the experiments that preceded native semantic batching. Its recommendation to retain the per-message protocol is superseded by the measured native update-batch experiment, subject to protocol negotiation and reader-first rollout. See [Native Update Batching for Huge Transactions](./replication-native-update-experiment.md).

Neither investigated track produced another production optimization that passed end-to-end gates after worker batching.

- WebSocket frame and ACK costs are material, but naive coalescing made replication slower by disrupting existing ChangeStreamer flow-control and worker-consumption cadence.
- `_zero.changeLog2` row-operation buffering improved isolated SQLite work by 15% to 23%, but did not improve the real replication pipeline, where that work overlaps with larger upstream and transport costs.
- `WITHOUT ROWID` reduced ChangeLog pages and WAL by roughly 5% to 10%, but improved CPU by less than 4% and would require migration work.

The recommended production configuration remains a static worker batch of 32 with the existing per-message transport and ChangeLog schema.

## Transport Attribution

The instrumented production-loopback bulk benchmark processed 2,008,000 logical messages across 20 samples. The current protocol produced exactly one WebSocket data frame and one ACK frame per logical message.

| Stage                    | Aggregate Time | Approx. Time / Message |
| ------------------------ | -------------: | ---------------------: |
| Server WebSocket send    |        12.30 s |                6.12 us |
| Client ACK send          |         8.85 s |                4.41 us |
| `BigIntJSON.parse`       |         6.87 s |                3.42 us |
| Valita validation        |         2.46 s |                1.22 us |
| Server ACK parse         |         1.24 s |                0.62 us |
| Envelope construction    |         0.30 s |                0.15 us |
| Client subscription push |         0.29 s |                0.14 us |

These measured stages account for about 1.6 seconds per 100,000-row sample, which explains most of the direct-versus-loopback gap. Validation is measurable but not the primary target.

### Cumulative ACKs

The prototype retained per-message data frames but ACKed the highest contiguous consumed ID every N messages, with immediate commit, rollback, status, and error barriers.

For 100-row transactions:

| Variant            | Data Frames |  ACK Frames | Median Total Latency |
| ------------------ | ----------: | ----------: | -------------------: |
| Current            |      20,400 |      20,400 |              6.40 ms |
| Cumulative ACK, 8  |      20,400 |       2,928 |             11.09 ms |
| Cumulative ACK, 32 |      20,400 | about 1,050 |             15.74 ms |

Reducing ACK frames delayed release of `Subscriber` consumption promises. ChangeStreamer flow control can wait on one of those promises before enough additional messages arrive to reach the next ACK threshold, so timer-based ACK flushing repeatedly enters the critical path.

### Batched Frames

The prototype concatenated already-stringified messages into bounded JSON frames while preserving logical IDs and per-message consumption.

For 100-row transactions:

| Variant                                  | Data Frames |  ACK Frames | Median Total Latency |
| ---------------------------------------- | ----------: | ----------: | -------------------: |
| Current                                  |      20,400 |      20,400 |              6.40 ms |
| Eight-message frames                     |       2,790 |      20,400 |              7.11 ms |
| Eight-message frames and cumulative ACKs |       2,793 |       2,933 |             11.80 ms |
| 32-message frames                        |   about 975 |      20,400 |             11.60 ms |
| 32-message frames and cumulative ACKs    |   about 975 | about 1,065 |             18.03 ms |

The eight-message bulk throughput run also regressed:

| Variant                       | Time / Generated-Text MB | Final Drain |
| ----------------------------- | -----------------------: | ----------: |
| Current instrumented loopback |                 30.74 ms |      4.39 s |
| Eight-message frames          |                 37.29 ms |      5.92 s |

Frame batching reduced physical frame count by 86%, but burstier delivery and batching delays interacted poorly with upstream flow control. This approach should not be shipped without redesigning transport ACK and ChangeStreamer flow control together.

## ChangeLog Row-Key Canonicalization

Directly binding `BigIntJSON.stringify(normalizedKeyOrder(row))` matched SQLite `JSON(?)` for the tested corpus:

- Safe integers.
- Positive and negative unsafe bigint values.
- Negative integers and JSON's normalization of `-0` to `0`.
- Escaped and Unicode strings.
- Boolean and null keys.
- Composite keys.
- Different property insertion orders.

Removing the redundant SQLite `JSON()` calls improved isolated apply cost by roughly 3% to 5%.

| Workload                 | SQLite `JSON()` | Direct Binding | Improvement |
| ------------------------ | --------------: | -------------: | ----------: |
| Unique inserts           |     3.552 us/op |    3.454 us/op |        2.8% |
| Repeated updates         |     3.534 us/op |    3.395 us/op |        3.9% |
| Deletes                  |     2.680 us/op |    2.551 us/op |        4.8% |
| Composite bigint inserts |     4.480 us/op |    4.306 us/op |        3.9% |

This did not meet the 10% isolated gate on its own.

## ChangeLog Buffered Writes

The buffer used real multi-row SQLite statements and flushed before backfill reads, special backfill writes, schema operations, truncate/reset, commit, rollback, and errors.

Compared with direct binding and immediate writes, buffer 32 improved isolated total transaction time:

| Workload                        | Immediate | Buffer 32 | Improvement |
| ------------------------------- | --------: | --------: | ----------: |
| 10,000 unique inserts           |  34.58 ms |  28.46 ms |       17.7% |
| 10,000 repeated updates         |  35.79 ms |  30.56 ms |       14.6% |
| 10,000 deletes                  |  26.45 ms |  20.44 ms |       22.7% |
| 10,000 composite bigint inserts |  44.58 ms |  37.51 ms |       15.9% |

Buffer 128 was only marginally faster than 32 and increased pending state and statement parameter count.

The isolated gain did not survive the full pipeline:

| Path                          |  Current | ChangeLog Buffer 32 |
| ----------------------------- | -------: | ------------------: |
| Production loopback time / MB | 30.74 ms |            32.27 ms |
| Direct in-process time / MB   | 21.63 ms |            23.34 ms |

The candidate runs had some upstream and transport variance, but neither final drain nor total throughput showed evidence of a production gain. ChangeLog statement execution is no longer the active end-to-end bottleneck after worker batch 32.

## `WITHOUT ROWID`

The disposable schema retained the same columns, `PRIMARY KEY(stateVersion,pos)`, and `UNIQUE(table,rowKey)` semantics.

CPU results with direct row keys and buffer 32:

| Workload                 | Total Improvement | Ordered Scan | Page Reduction |
| ------------------------ | ----------------: | -----------: | -------------: |
| Unique inserts           |              0.3% |  3.3% faster |           7.7% |
| Repeated updates         |              3.8% |  3.9% faster |           9.5% |
| Deletes                  |       0.3% slower |  3.1% faster |           8.7% |
| Composite bigint inserts |              1.0% |  2.8% faster |           2.5% |

A file-backed 2,000-row run was 1.9% faster, used 7.7% fewer pages, and wrote 5.6% fewer WAL bytes.

The storage reduction is real, but the CPU gain is below the gate and does not justify an existing-replica table rebuild by itself. It may be reconsidered as a new-replica-only format if replica size or WAL volume becomes a product priority.

## Correctness Coverage

Temporary experiment tests covered:

- Default transport compatibility.
- Batched bigint frames.
- Sparse timer, message-count, byte, and transaction-boundary flushes.
- Cumulative ACK ordering, malformed ACKs, cancellation, and commit durability.
- Direct row-key canonicalization and lookups.
- Full and partial ChangeLog batches.
- Duplicate keys and set-delete-set ordering.
- Key-changing updates.
- Composite bigint keys.
- Backfill metadata and barriers.
- Schema, truncate, reset, rollback, and processing errors.
- `WITHOUT ROWID` uniqueness and ordered `changesSince` scans.

## Recommendation

Keep:

- Static worker batch 32.
- Current per-message WebSocket protocol.
- Current production ChangeLog write path and rowid schema.

Do not pursue frame or ACK coalescing independently. A future attempt must redesign ChangeStreamer flow-control release and transport acknowledgment as one system, preferably with explicit byte-window credit rather than timer-based cumulative ACKs.

Do not ship ChangeLog buffering solely from the isolated result. Revisit it only if profiling shows SQLite ChangeLog statements becoming critical after another bottleneck is removed.
