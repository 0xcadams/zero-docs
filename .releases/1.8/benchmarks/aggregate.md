# Zero 1.8 Benchmark Results

- Baseline: `zero/v1.7.0` (`6863de5f00a3c1e7dc09c83ea3263dec4a94ebee`)
- Target: `maint/zero/v1.8` (`6c8b5e5a76f2b4b253b1b9c9c4a8598299d8c975`)
- Run count: 10 separate processes per ref per benchmark command
- Aggregation: median of process-level medians
- Ratio: `baseline / target`; values above `1.0` are faster in target

## In-Memory ZQL Fetch

- Comparable rows: 5
- Median ratio: 2.36x
- Geometric mean ratio: 2.07x

| Benchmark                                        |  Zero 1.7 |  Zero 1.8 | Ratio |
| ------------------------------------------------ | --------: | --------: | ----: |
| MemorySource fetch > scan 1000 rows, sort 1 key  | 100.85 us |  41.83 us | 2.41x |
| MemorySource fetch > scan 1000 rows, sort 2 keys |  99.19 us |  41.85 us | 2.37x |
| MemorySource fetch > scan 1000 rows, sort 4 keys |  99.17 us |  42.00 us | 2.36x |
| Filter > fetch open issues (1000 total)          | 148.62 us |  84.67 us | 1.76x |
| Join > fetch 1000 issues → 20 users              | 759.03 us | 476.60 us | 1.59x |

## Seekable Ordered Take Maintenance

- Comparable rows: 1
- Median ratio: 3741.54x
- Geometric mean ratio: 3741.54x

| Benchmark                                                    | Zero 1.7 | Zero 1.8 |    Ratio |
| ------------------------------------------------------------ | -------: | -------: | -------: |
| take start seek > fetch after boundary near end of partition |  3.09 ms |   826 ns | 3741.54x |

## CDC Storer Throughput

- Comparable rows: 2
- Median ratio: 1.23x
- Geometric mean ratio: 1.23x

| Benchmark                                            |   Zero 1.7 |    Zero 1.8 | Ratio |
| ---------------------------------------------------- | ---------: | ----------: | ----: |
| change-streamer/storer single transaction payload MB | 87.50 MB/s | 102.07 MB/s | 1.17x |
| change-streamer/storer sustained stream payload MB   | 75.05 MB/s |  97.58 MB/s | 1.30x |
