# PR 6 Direct COPY Text Buffers: Full Linux Experiment

## Scope

This report compares the actual PR 6 parent and head on the 10,000-row, 6.83 GB
Email fixture under the production-shaped Linux application limits. It follows
the environment investigation that found the 683 MB direct-text result was much
larger on constrained Linux than on the macOS host.

The experiment answers the remaining question: whether the direct-text gain
survives full-volume SQLite pager, flush, and index work rather than only the
scaled 683 MB fixture.

## Provenance

| Arm                    | Commit                                     | Linux image                                                               |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Direct parent PR #6237 | `c4d5519670d50a8bd388f5ce05d5576dc6f97df6` | `sha256:b4b3f29d5af0f11bbdaf9ccffd842439c95d6661f10f7b221720628b75feb776` |
| PR 6 head              | `99442b64afe8f627b8c7d06862efbb51ac3ce540` | `sha256:40904929541f570c1833fa7184d0e74ea8640f6b231229c803df99774109e699` |

Both mono worktrees were clean at their recorded commits before and after the
experiment. `Dockerfile.current-pr6.linux` injected only the benchmark harness
through a named build context and rebuilt `@rocicorp/zero-sqlite3` 1.1.2 from
source in both images.

## Method

Each treatment ran in a fresh ARM64 Linux application container with:

- 1 CPU.
- 3 GiB memory and the same memory-swap limit.
- 2,304 MiB Node heap.
- 8 MiB initial-sync buffer.
- `mmap_size=0` requested and verified.
- Natural row-aligned PostgreSQL `CopyData` messages.

PostgreSQL 17 ran in a separate container on the direct Docker bridge with 2
CPUs and 2 GiB memory. The fixture contained 10,000 rows with a 683,000-byte
dominant text field. Every run first measured a separate raw binary COPY control
and then performed the complete initial sync.

Two five-pair AB/BA blocks ran sequentially. The second block reversed the
starting treatment order, producing five parent-first and five head-first pairs
overall. Before both blocks, Time Machine was stopped, unrelated Docker
workloads were absent, and the host was allowed to cool down.

The report uses:

```text
median elapsed reduction = 1 - head median / parent median
paired elapsed reduction = 1 - median(head repetition / parent repetition)
throughput gain = reciprocal timing ratio - 1
```

No outlier was removed. No confidence interval or statistical significance is
claimed.

## Pair Results

| Pair | Starting arm | Parent callback | Head callback | Callback reduction | Parent outer | Head outer | Outer reduction |
| ---- | ------------ | --------------: | ------------: | -----------------: | -----------: | ---------: | --------------: |
| A1   | Parent       |        22.992 s |      15.685 s |             31.78% |     23.141 s |   15.890 s |          31.33% |
| A2   | Head         |        22.002 s |      17.390 s |             20.96% |     22.165 s |   17.566 s |          20.75% |
| A3   | Parent       |        21.423 s |      15.690 s |             26.76% |     21.667 s |   15.949 s |          26.39% |
| A4   | Head         |        19.472 s |      18.707 s |              3.93% |     19.691 s |   18.908 s |           3.97% |
| A5   | Parent       |        19.923 s |      13.796 s |             30.75% |     20.190 s |   14.526 s |          28.05% |
| B1   | Head         |        25.391 s |      19.493 s |             23.23% |     25.731 s |   19.727 s |          23.33% |
| B2   | Parent       |        22.078 s |      15.290 s |             30.75% |     22.329 s |   15.572 s |          30.26% |
| B3   | Head         |        19.861 s |      18.476 s |              6.97% |     20.071 s |   18.717 s |           6.75% |
| B4   | Parent       |        21.294 s |      27.948 s |            -31.25% |     21.531 s |   28.149 s |         -30.73% |
| B5   | Head         |        20.918 s |      14.704 s |             29.70% |     21.251 s |   14.868 s |          30.04% |

Nine of ten pairs favored the head. B4 is retained as measured. Its head run
spent 13.612 seconds in flush calls, 864 ms in observed GC, and 9.557 seconds in
scoped full I/O pressure. It completed correctly without an OOM or process
failure.

## Aggregate Results

The following table pools the ten independent processes per arm and separately
reports the median of the ten matched ratios:

| Metric                         | Parent median | Head median | Median change | Paired change |
| ------------------------------ | ------------: | ----------: | ------------: | ------------: |
| Initial-sync callback          |      21.358 s |    16.540 s |       -22.56% |       -25.00% |
| Whole `initReplica` outer time |      21.599 s |    16.758 s |       -22.41% |       -24.86% |
| COPY phase                     |      12.024 s |     7.746 s |       -35.58% |       -42.37% |
| SQLite flush calls             |       8.477 s |     6.172 s |       -27.19% |       -39.40% |
| Deferred index phase           |       8.756 s |     8.994 s |        +2.72% |        +3.75% |
| Raw COPY control               |       5.736 s |     5.798 s |        +1.08% |        +1.69% |
| Peak process RSS               |      399.7 MB |    211.7 MB |       -47.05% |       -47.05% |
| Observed GC time               |      440.0 ms |    155.5 ms |       -64.65% |       -62.90% |
| User CPU time                  |       5.128 s |     2.673 s |       -47.88% |       -43.95% |
| System CPU time                |       7.853 s |     6.889 s |       -12.27% |       -12.04% |

The callback medians correspond to 320.0 MB/s for the parent and 413.2 MB/s
for the head, a 29.13% throughput gain. The paired callback ratio corresponds
to a 33.33% throughput gain. Whole-operation throughput improves 28.89% by
medians and 33.09% by paired ratios.

Raw COPY was approximately 1.18-1.19 GB/s and slightly slower for the head, so
source transfer does not explain the improvement. Almost all elapsed savings
occur in the COPY phase. Index time is approximately flat to slightly worse.

## Correctness And Pressure

All 20 application containers exited successfully. Every run verified:

- 10,000 destination rows.
- 6,834,522,537 dominant-table COPY bytes.
- 683,383.9-byte average raw COPY chunks, consistent with one large row per
  message plus framing.
- 6,846,730,240-byte SQLite files.
- Expected payload lengths and SHA-256 samples.
- Effective `mmap_size=0`.
- Zero cgroup OOM and OOM-kill events.

Both arms repeatedly reached the 3 GiB cgroup memory limit while the 6.85 GB
SQLite file competed for page cache. The head had 13.43% more memory-max events
by paired medians, while full memory-pressure time was effectively flat at
+0.29%. Full I/O-pressure time was 31.92% lower by paired medians but had a large
regression in B4. These counters describe reclaim and I/O contention, not
process failure.

The robust resource differences are lower process RSS, user CPU, and GC time.
The direct path avoids the Buffer-to-JavaScript-string decode and the subsequent
SQLite UTF-8 binding conversion. In this harness, `flushMs` includes statement
binding and execution, so its improvement is not solely physical disk flush.

## Interpretation

- The direct-text gain survives full-volume pager, flush, and index work in the
  actual PR 6 diff under the production-shaped Linux CPU and memory limits.
- The naive projection from the 683 MB callback understated the full result.
  At 6.83 GB, string allocation and binding interact with cgroup reclaim, page
  cache, GC, and synchronous SQLite statement work.
- The result is not attributable to source transfer: raw COPY is flat to
  slightly slower for the head.
- The result is variable. Nine pairs improve, one regresses substantially, and
  ten pairs are insufficient for a narrow tail estimate.
- This remains a synthetic local Docker experiment. PostgreSQL is in the same
  Linux VM, Docker storage is not production NVMe, and the fixture does not
  include the entire 108-table production publication.
- The experiment supplies strong constrained-Linux evidence but does not
  replace the canonical mono `wide-text-full` gate or justify promising a 25%
  product-wide speedup.

## Evidence

- `results/rerun-docker-current-pr6-email-full-native-docker.json`
- `results/rerun-docker-current-pr6-email-full-native-docker-summary.json`
- `results/rerun-docker-current-pr6-email-full-native-confirmation-docker.json`
- `results/rerun-docker-current-pr6-email-full-native-confirmation-docker-summary.json`
- Matching raw logs and manifests under `raw/` and `manifests/`.
