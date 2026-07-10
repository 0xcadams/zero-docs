# Zero 1.8 Benchmark Results

- Baseline: `zero/v1.7.0` (`6863de5f00a3c1e7dc09c83ea3263dec4a94ebee`)
- Target: `maint/zero/v1.8` (`4ef9e4ef04fbc9fa838c930887d5d6b97241b789`)
- Run count: 10 separate processes per ref per benchmark command
- Aggregation: median of process-level medians
- Ratio: `baseline / target`; values above `1.0` are faster in target

## In-Memory ZQL Fetch

- Comparable rows: 5
- Median ratio: 2.33x
- Geometric mean ratio: 2.05x

| Benchmark                                        |  Zero 1.7 |  Zero 1.8 | Ratio |
| ------------------------------------------------ | --------: | --------: | ----: |
| MemorySource fetch > scan 1000 rows, sort 1 key  |  98.83 us |  41.65 us | 2.37x |
| MemorySource fetch > scan 1000 rows, sort 2 keys |  98.50 us |  41.69 us | 2.36x |
| MemorySource fetch > scan 1000 rows, sort 4 keys |  98.10 us |  42.02 us | 2.33x |
| Filter > fetch open issues (1000 total)          | 147.60 us |  83.98 us | 1.76x |
| Join > fetch 1000 issues → 20 users              | 745.09 us | 473.86 us | 1.57x |

## Seekable Ordered Take Maintenance

- Comparable rows: 1
- Median ratio: 5259.68x
- Geometric mean ratio: 5259.68x

| Benchmark                                                    | Zero 1.7 | Zero 1.8 |    Ratio |
| ------------------------------------------------------------ | -------: | -------: | -------: |
| take start seek > fetch after boundary near end of partition |  2.64 ms |   501 ns | 5259.68x |

## CDC Storer Throughput

- Comparable rows: 2
- Median ratio: 1.71x
- Geometric mean ratio: 1.71x

| Benchmark                                            |   Zero 1.7 |    Zero 1.8 | Ratio |
| ---------------------------------------------------- | ---------: | ----------: | ----: |
| change-streamer/storer single transaction payload MB | 56.89 MB/s | 100.02 MB/s | 1.76x |
| change-streamer/storer sustained stream payload MB   | 58.46 MB/s |  97.41 MB/s | 1.67x |
