# Zero 0.22 to 1.8 Product Benchmark Results

- Baseline: `zero/v0.22.2025071101` (`bef41d6de044cd3de5173c56df1329a19933e175`), published `2025-07-11T16:30:57.769Z`
- Target: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)
- Target runs reused from `.releases/1.8/benchmarks/1.0-to-1.8/aggregate.json`
- Run count: 10 separate processes per ref per benchmark command
- Aggregation: median of process-level medians
- Ratio: raw `baseline / target`; values above `1.0` are faster in target
- Throughput display: `ns/MB` metrics are converted to decimal `MB/s`

> **Important:** The 0.22 live-replication rows bypass production transport serialization, while 1.8 retains parsing and worker-thread costs. Do not interpret those raw rows as an apples-to-apples production throughput regression. See `investigation.md`.
>
> The reconnect/catch-up row measures ChangeStreamer backlog replay into a JavaScript counter, not a restarted stale SQLite replica.

## Overall

- Comparable rows: 15
- Median ratio: 1.19x
- Geometric mean ratio: 2.41x
- Improved by >5%: 12
- Regressed by >5%: 2
- Excluding largest improvement (reconnect catch-up from stored change stream backlog): median 1.16x, geometric mean 1.83x

## Postgres Sync, Replication, And Catch-up

- Comparable rows: 5
- Median ratio: 1.05x
- Geometric mean ratio: 2.02x
- Improved by >5%: 3
- Regressed by >5%: 2

| Benchmark | Zero 0.22 | Zero 1.8 | Ratio |
| --- | ---: | ---: | ---: |
| Postgres initial sync/backfill payload | 86.20 MB/s | 90.76 MB/s | 1.05x |
| Live Postgres replication, one large transaction | 91.61 MB/s | 40.95 MB/s | 0.45x |
| Live Postgres replication, many medium transactions | 67.23 MB/s | 41.25 MB/s | 0.61x |
| Postgres commit-to-local-replica visibility latency | 59.64 ms | 56.67 ms | 1.05x |
| Reconnect/catch-up from stored ChangeStreamer backlog | 6.39 s | 57.05 ms | 111.93x |

## Local And Server Query Workloads

- Comparable rows: 10
- Median ratio: 1.47x
- Geometric mean ratio: 2.62x
- Improved by >5%: 9
- Regressed by >5%: 0

| Benchmark | Zero 0.22 | Zero 1.8 | Ratio |
| --- | ---: | ---: | ---: |
| Local client query hydration, creators | 3.33 ms | 1.55 ms | 2.14x |
| Local client query hydration, creators and comments | 3.98 ms | 2.31 ms | 1.72x |
| Server large SQLite-backed query initialization | 9.20 ms | 8.81 ms | 1.04x |
| New client initial load from existing local replica | 10.47 ms | 8.56 ms | 1.22x |
| Large result materialization with related rows | 33.00 ms | 29.31 ms | 1.13x |
| Sparse where() + orderBy() + limit(), cutoff 50 | 3.39 ms | 3.01 ms | 1.13x |
| Sparse where() + orderBy() + limit(), cutoff 10,000 | 3.25 ms | 2.73 ms | 1.19x |
| Sparse where() + orderBy() + limit(), cutoff 50,000 | 3.26 ms | 1.53 ms | 2.13x |
| Sparse where() + orderBy() + limit(), cutoff 90,000 | 3.32 ms | 340.31 us | 9.75x |
| Sparse where() + orderBy() + limit(), cutoff 100,000 | 3.27 ms | 31.69 us | 103.31x |

