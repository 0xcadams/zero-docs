# Zero 1.0 to 1.8 Product Benchmark Results

- Baseline: `zero/v1.0.0` (`5a5ea6b786d126fb12f34b1b81a846b8b00a754b`)
- Target: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)
- Run count: 10 separate processes per ref per benchmark command
- Aggregation: median of process-level medians
- Ratio: raw `baseline / target`; values above `1.0` are faster in target
- Throughput display: `ns/MB` metrics are converted to decimal `MB/s`

## Overall

- Comparable rows: 15
- Median ratio: 1.21x
- Geometric mean ratio: 1.82x
- Improved by >5%: 10
- Regressed by >5%: 3
- Excluding largest improvement (maintain sparse orderBy limit query cutoff 100000 rows deep): median 1.19x, geometric mean 1.36x

### Top Improvements

| Group | Benchmark | Zero 1.0 | Zero 1.8 | Ratio |
| --- | --- | ---: | ---: | ---: |
| Local And Server Query Workloads | maintain sparse orderBy limit query cutoff 100000 rows deep | 3.41 ms | 31.69 us | 107.74x |
| Local And Server Query Workloads | maintain sparse orderBy limit query cutoff 90000 rows deep | 3.40 ms | 340.31 us | 9.99x |
| Local And Server Query Workloads | maintain sparse orderBy limit query cutoff 50000 rows deep | 3.35 ms | 1.53 ms | 2.19x |
| Local And Server Query Workloads | local client hydrate 5k issues with creators | 2.35 ms | 1.55 ms | 1.51x |
| Postgres Sync, Replication, And Catch-up | postgres replication many medium transactions payload MB | 28.95 MB/s | 41.25 MB/s | 1.42x |

### Top Regressions

| Group | Benchmark | Zero 1.0 | Zero 1.8 | Ratio |
| --- | --- | ---: | ---: | ---: |
| Postgres Sync, Replication, And Catch-up | reconnect catch-up from stored change stream backlog | 39.74 ms | 57.05 ms | 0.70x |
| Local And Server Query Workloads | large result materialization with related rows | 25.73 ms | 29.31 ms | 0.88x |
| Local And Server Query Workloads | server initialize large SQLite-backed query with related rows | 7.75 ms | 8.81 ms | 0.88x |

## Postgres Sync, Replication, And Catch-up

- Comparable rows: 5
- Median ratio: 1.10x
- Geometric mean ratio: 1.09x
- Improved by >5%: 3
- Regressed by >5%: 1

| Benchmark | Zero 1.0 | Zero 1.8 | Ratio |
| --- | ---: | ---: | ---: |
| postgres initial sync copy into replica | 82.68 MB/s | 90.76 MB/s | 1.10x |
| postgres replication one large transaction payload MB | 28.84 MB/s | 40.95 MB/s | 1.42x |
| postgres replication many medium transactions payload MB | 28.95 MB/s | 41.25 MB/s | 1.42x |
| postgres commit to local replica visibility latency | 57.02 ms | 56.67 ms | 1.01x |
| reconnect catch-up from stored change stream backlog | 39.74 ms | 57.05 ms | 0.70x |

## Local And Server Query Workloads

- Comparable rows: 10
- Median ratio: 1.22x
- Geometric mean ratio: 2.34x
- Improved by >5%: 7
- Regressed by >5%: 2

| Benchmark | Zero 1.0 | Zero 1.8 | Ratio |
| --- | ---: | ---: | ---: |
| local client hydrate 5k issues with creators | 2.35 ms | 1.55 ms | 1.51x |
| local client hydrate 5k issues with creators and comments | 2.80 ms | 2.31 ms | 1.21x |
| server initialize large SQLite-backed query with related rows | 7.75 ms | 8.81 ms | 0.88x |
| new client initial load from existing local replica | 8.94 ms | 8.56 ms | 1.04x |
| large result materialization with related rows | 25.73 ms | 29.31 ms | 0.88x |
| maintain sparse orderBy limit query cutoff 50 rows deep | 3.49 ms | 3.01 ms | 1.16x |
| maintain sparse orderBy limit query cutoff 10000 rows deep | 3.33 ms | 2.73 ms | 1.22x |
| maintain sparse orderBy limit query cutoff 50000 rows deep | 3.35 ms | 1.53 ms | 2.19x |
| maintain sparse orderBy limit query cutoff 90000 rows deep | 3.40 ms | 340.31 us | 9.99x |
| maintain sparse orderBy limit query cutoff 100000 rows deep | 3.41 ms | 31.69 us | 107.74x |

