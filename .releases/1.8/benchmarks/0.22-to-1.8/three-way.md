# Zero 0.22, 1.0, and 1.8 Product Benchmark Comparison

- `Zero 0.22`: `zero/v0.22.2025071101` (`bef41d6de044cd3de5173c56df1329a19933e175`), published `2025-07-11T16:30:57.769Z`
- `Zero 1.0`: `zero/v1.0.0` (`5a5ea6b786d126fb12f34b1b81a846b8b00a754b`)
- `Zero 1.8`: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)
- Values are median of 10 process-level medians per ref. Throughput rows are decimal `MB/s`; duration rows are lower-is-better.
- Ratios above `1.0` mean the newer version is faster.

| Workload | Zero 0.22 | Zero 1.0 | Zero 1.8 | 1.8 vs 0.22 | 1.8 vs 1.0 | 1.0 vs 0.22 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Postgres initial sync/backfill payload | 86.20 MB/s | 82.68 MB/s | 90.76 MB/s | 1.05x | 1.10x | 0.96x |
| Live Postgres replication, one large transaction | 91.61 MB/s | 28.84 MB/s | 40.95 MB/s | 0.45x | 1.42x | 0.31x |
| Live Postgres replication, many medium transactions | 67.23 MB/s | 28.95 MB/s | 41.25 MB/s | 0.61x | 1.42x | 0.43x |
| Postgres commit-to-local-replica visibility latency | 59.64 ms | 57.02 ms | 56.67 ms | 1.05x | 1.01x | 1.05x |
| Reconnect/catch-up from stored ChangeStreamer backlog | 6.39 s | 39.74 ms | 57.05 ms | 111.93x | 0.70x | 160.68x |
| Local client query hydration, creators | 3.33 ms | 2.35 ms | 1.55 ms | 2.14x | 1.51x | 1.42x |
| Local client query hydration, creators and comments | 3.98 ms | 2.80 ms | 2.31 ms | 1.72x | 1.21x | 1.42x |
| Server large SQLite-backed query initialization | 9.20 ms | 7.75 ms | 8.81 ms | 1.04x | 0.88x | 1.19x |
| New client initial load from existing local replica | 10.47 ms | 8.94 ms | 8.56 ms | 1.22x | 1.04x | 1.17x |
| Large result materialization with related rows | 33.00 ms | 25.73 ms | 29.31 ms | 1.13x | 0.88x | 1.28x |
| Sparse where() + orderBy() + limit(), cutoff 50 | 3.39 ms | 3.49 ms | 3.01 ms | 1.13x | 1.16x | 0.97x |
| Sparse where() + orderBy() + limit(), cutoff 10,000 | 3.25 ms | 3.33 ms | 2.73 ms | 1.19x | 1.22x | 0.98x |
| Sparse where() + orderBy() + limit(), cutoff 50,000 | 3.26 ms | 3.35 ms | 1.53 ms | 2.13x | 2.19x | 0.97x |
| Sparse where() + orderBy() + limit(), cutoff 90,000 | 3.32 ms | 3.40 ms | 340.31 us | 9.75x | 9.99x | 0.98x |
| Sparse where() + orderBy() + limit(), cutoff 100,000 | 3.27 ms | 3.41 ms | 31.69 us | 103.31x | 107.74x | 0.96x |

