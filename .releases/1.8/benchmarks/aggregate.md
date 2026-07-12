# Zero 1.8 Benchmark Results

- Baseline: `zero/v1.7.0` (`6863de5f00a3c1e7dc09c83ea3263dec4a94ebee`)
- Target: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)
- Run count: 10 separate processes per ref per benchmark command
- Aggregation: median of process-level medians
- Ratio: `baseline / target`; values above `1.0` are faster in target

## In-Memory ZQL Fetch

- Comparable rows: 5
- Median ratio: 2.35x
- Geometric mean ratio: 2.05x

| Benchmark                                        |  Zero 1.7 |  Zero 1.8 | Ratio |
| ------------------------------------------------ | --------: | --------: | ----: |
| MemorySource fetch > scan 1000 rows, sort 1 key  | 100.00 us |  42.29 us | 2.36x |
| MemorySource fetch > scan 1000 rows, sort 2 keys | 100.21 us |  42.63 us | 2.35x |
| MemorySource fetch > scan 1000 rows, sort 4 keys |  99.92 us |  42.44 us | 2.35x |
| Filter > fetch open issues (1000 total)          | 149.63 us |  85.75 us | 1.74x |
| Join > fetch 1000 issues → 20 users              | 760.59 us | 485.02 us | 1.57x |

## Running Local ZQL Queries

- Comparable rows: 5
- Median ratio: 1.29x
- Geometric mean ratio: 1.04x

| Benchmark                                           |  Zero 1.7 |  Zero 1.8 | Ratio |
| --------------------------------------------------- | --------: | --------: | ----: |
| hydration > hydrate: issues only                    | 208.25 us | 373.50 us | 0.56x |
| hydration > hydrate: issues with creator            |   1.11 ms | 839.30 us | 1.33x |
| hydration > hydrate: issues with creator + comments |   2.54 ms |   1.97 ms | 1.29x |
| hydration > hydrate: issues filtered open           | 225.36 us | 252.62 us | 0.89x |
| hydration > hydrate: issues limit 50                |  77.99 us |  53.69 us | 1.45x |

## Maintaining orderBy() + limit() Queries

- Comparable rows: 5
- Median ratio: 2.10x
- Geometric mean ratio: 4.36x

| Benchmark                                                        | Zero 1.7 |  Zero 1.8 |  Ratio |
| ---------------------------------------------------------------- | -------: | --------: | -----: |
| maintaining orderBy() + limit() query > cutoff 50 rows deep      |  4.39 ms |   3.92 ms |  1.12x |
| maintaining orderBy() + limit() query > cutoff 10,000 rows deep  |  4.04 ms |   3.40 ms |  1.19x |
| maintaining orderBy() + limit() query > cutoff 50,000 rows deep  |  4.04 ms |   1.92 ms |  2.10x |
| maintaining orderBy() + limit() query > cutoff 90,000 rows deep  |  4.03 ms | 431.77 us |  9.33x |
| maintaining orderBy() + limit() query > cutoff 100,000 rows deep |  4.00 ms |  66.77 us | 59.89x |

## Replicating Large Transactions

- Comparable rows: 2
- Median ratio: 1.57x
- Geometric mean ratio: 1.57x

| Benchmark                                  |   Zero 1.7 |   Zero 1.8 | Ratio |
| ------------------------------------------ | ---------: | ---------: | ----: |
| replication one 50,000-change transaction  | 20.8 MiB/s | 32.9 MiB/s | 1.58x |
| replication 50 x 1,000-change transactions | 20.3 MiB/s | 31.6 MiB/s | 1.56x |

## CDC Storer Throughput

- Comparable rows: 2
- Median ratio: 2.37x
- Geometric mean ratio: 2.36x

| Benchmark                                            |   Zero 1.7 |   Zero 1.8 | Ratio |
| ---------------------------------------------------- | ---------: | ---------: | ----: |
| change-streamer/storer single transaction payload MB | 36.06 MB/s | 89.45 MB/s | 2.48x |
| change-streamer/storer sustained stream payload MB   | 38.66 MB/s | 87.00 MB/s | 2.25x |
