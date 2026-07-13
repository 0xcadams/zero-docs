# Live Replication Throughput Investigation

## Conclusion

The original table overstated the apparent Zero 0.22 to 1.8 live-replication regression because the compatibility harness did not measure equivalent transport paths.

After normalizing the omitted 0.22 JSON transport work, the 0.22 and 1.8 in-thread processors are close. The remaining shipped-path slowdown is primarily the serial per-message worker-thread boundary introduced before Zero 1.0.

## Isolation Results

Each value is the median of five fresh process runs. Throughput includes the upstream PostgreSQL insert and waiting for rows to become visible in the local SQLite replica.

| Mode | One Large Transaction | Many Medium Transactions |
| --- | ---: | ---: |
| Zero 0.22 direct temp harness | 70.05 MB/s | 58.87 MB/s |
| Zero 0.22 with JSON transport normalized | 55.21 MB/s | 49.35 MB/s |
| Zero 1.8 processor in-thread | 53.32 MB/s | 45.52 MB/s |
| Zero 1.8 shipped thread worker | 37.70 MB/s | 39.31 MB/s |

The paired results show:

- Adding the transport work omitted by the original 0.22 harness reduces measured throughput by 21% for the large transaction and 16% for medium transactions.
- With worker IPC removed from 1.8, its throughput is within 3% of transport-normalized 0.22 for the large transaction and 8% for medium transactions.
- Adding the shipped 1.8 worker boundary reduces end-to-end throughput by 29% for the large transaction and 14% for medium transactions in this co-located harness.
- Compared with transport-normalized 0.22, the shipped 1.8 path is 32% slower for the large transaction and 20% slower for medium transactions. This is materially smaller than the original raw table's 55% and 39% differences.

## Root Cause

Commit `8eecaaab4` (`fix(replicator): async writes (#5652)`) moved synchronous SQLite writes into a worker thread shortly before Zero 1.0. The change prevents large writes from blocking the replicator's main event loop, WebSocket heartbeats, and IPC.

The current hot path processes one replication message at a time:

1. `IncrementalSyncer` awaits `worker.processMessage()` for each begin, row change, and commit.
2. `ThreadWriteWorkerClient` structured-clones the message with `postMessage()` and permits only one pending request.
3. The worker processes the message synchronously and posts a response.
4. The next message is not sent until that response resolves.

For a 20,000-row transaction, this creates roughly 20,002 serial worker request/response round trips. The worker solves an event-loop responsiveness problem, but its per-message protocol limits peak bulk throughput.

## Original Harness Bias

The temp benchmark connected `ChangeStreamerService` directly to `ReplicatorService`, bypassing the production WebSocket client/server.

- Zero 0.22 direct subscriptions emitted parsed objects, so the harness skipped the `BigIntJSON.stringify`, WebSocket, `BigIntJSON.parse`, and validation work its production path performed.
- Zero 1.8 direct subscriptions emitted strings, so the harness still parsed every message and then structured-cloned it through the write worker.

The isolation's transport-normalized 0.22 mode adds a `BigIntJSON.stringify`/`parse` round trip. It does not model WebSocket framing or validation, but it removes the largest asymmetric bias.

## Other Caveats

- The benchmark includes source PostgreSQL insertion time, so it is request-to-local-visibility throughput rather than isolated replication throughput.
- The test co-locates services that production normally connects over HTTP/WebSocket.
- Completion is based on cumulative SQLite row counts rather than exact payload and watermark verification.
- The reconnect/catch-up benchmark in the original matrix counts ChangeStreamer replay messages; it does not restart a stale SQLite replicator.

## Likely Optimization

Batching a transaction or chunk of replication messages across the worker boundary would preserve event-loop isolation while avoiding one request/response and structured clone per row. A production-quality benchmark should use the real ChangeStreamer HTTP client/server path, verify the exact final watermark and payload, and report PostgreSQL insertion and downstream replica time separately.
