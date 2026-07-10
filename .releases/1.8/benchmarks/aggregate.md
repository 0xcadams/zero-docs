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

## Ordered Limit Boundary Fetch

- Comparable rows: 5
- Median ratio: 135.25x
- Geometric mean ratio: 49.51x

| Benchmark                                        |  Zero 1.7 | Zero 1.8 |   Ratio |
| ------------------------------------------------ | --------: | -------: | ------: |
| ordered limit boundary fetch > after 50 rows     |  12.93 us | 11.89 us |   1.09x |
| ordered limit boundary fetch > after 10,000 rows | 327.00 us | 12.03 us |  27.17x |
| ordered limit boundary fetch > after 50,000 rows |   1.61 ms | 11.89 us | 135.25x |
| ordered limit boundary fetch > after 90,000 rows |   2.96 ms | 11.93 us | 247.95x |
| ordered limit boundary fetch > after final row   |   3.27 ms | 10.90 us | 300.09x |

## CDC Storer Throughput

- Comparable rows: 2
- Median ratio: 2.37x
- Geometric mean ratio: 2.36x

| Benchmark                                            |   Zero 1.7 |   Zero 1.8 | Ratio |
| ---------------------------------------------------- | ---------: | ---------: | ----: |
| change-streamer/storer single transaction payload MB | 36.06 MB/s | 89.45 MB/s | 2.48x |
| change-streamer/storer sustained stream payload MB   | 38.66 MB/s | 87.00 MB/s | 2.25x |
