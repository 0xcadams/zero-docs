# Focused Initial Sync Scaling Benchmark

## Question

The original 39.5 MB product benchmark showed initial sync falling from `86.20 MB/s` in Zero 0.22 to `82.68 MB/s` in Zero 1.0, then rising to `90.76 MB/s` in Zero 1.8. This focused run tests whether the 1.0 dip represents lower sustained initial-sync throughput or additional fixed startup work.

## Refs

- Zero 0.22: `zero/v0.22.2025071101` (`bef41d6de044cd3de5173c56df1329a19933e175`)
- Zero 1.0: `zero/v1.0.0` (`5a5ea6b786d126fb12f34b1b81a846b8b00a754b`)
- Zero 1.8: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)

## Environment

- Machine: Apple M5 Pro
- OS: macOS arm64, Darwin `25F84`, macOS `26.5.2`
- Node: `v22.23.1`
- Docker server: `29.6.1`
- PostgreSQL image: `postgres:17-alpine`
- Table-copy workers: 4

## Matrix

| Size Label | Rows | Fixture Payload |
| --- | ---: | ---: |
| 40 MB | 20,000 | 39.507 MB |
| 400 MB | 200,000 | 395.019 MB |
| 1.2 GB | 600,000 | 1,185.104 MB |

Each size used 10 sequential rounds. Every round ran configurations in this order:

1. Zero 0.22 text COPY
2. Zero 1.0 text COPY
3. Zero 1.8 binary COPY
4. Zero 1.8 text COPY control

No benchmark processes ran concurrently.

## Workload

The fixture has four published Postgres tables covering ordinary text rows, lookup rows, wide rows, and composite primary keys. It also creates three secondary indexes. Payload composition is deterministic and identical across refs.

Timing starts immediately before `initialSync()` and ends after it completes. It includes replication-slot and schema work, progress metadata, Postgres COPY, SQLite writes, index creation, and replica registration. It excludes container startup, schema creation, and loading fixture rows into upstream Postgres.

Throughput is deterministic application fixture payload in decimal `MB/s`. It is not Postgres table size, COPY wire bytes, SQLite replica size, or MiB/s.

## Benchmark-Only Changes

No production code was changed.

- All refs use the same product initial-sync harness and four copy workers.
- The temporary Zero 1.8 harness accepts `ZERO_PRODUCT_BENCH_TEXT_COPY=1`, passing `textCopy: true` to the existing initial-sync implementation. This isolates binary COPY from other 1.8 changes.
- A fresh detached 1.8 worktree with an isolated pnpm store was used after the earlier shared pnpm global virtual store became corrupt.

## Commands

Each process ran only the initial-sync test. The row count varied by size.

Zero 0.22 and Zero 1.0:

```sh
ZERO_PRODUCT_BENCH_INITIAL_SYNC_ROWS=<rows> vitest run --config vitest.config.product.pg.ts -t "postgres initial sync/backfill payload MB/s"
```

Zero 1.8 binary:

```sh
ZERO_PRODUCT_BENCH_INITIAL_SYNC_ROWS=<rows> vitest run --config vitest.config.product.pg.ts -t "postgres initial sync/backfill payload MB/s"
```

Zero 1.8 text control:

```sh
ZERO_PRODUCT_BENCH_INITIAL_SYNC_ROWS=<rows> ZERO_PRODUCT_BENCH_TEXT_COPY=1 vitest run --config vitest.config.product.pg.ts -t "postgres initial sync/backfill payload MB/s"
```

Raw logs are under `.releases/1.8/benchmarks/initial-sync-scaling/raw/<size>/` and remain local.

## Aggregation

Run:

```sh
node .releases/1.8/benchmarks/initial-sync-scaling/aggregate-benchmarks.mjs
```

Outputs:

- `.releases/1.8/benchmarks/initial-sync-scaling/aggregate.json`
- `.releases/1.8/benchmarks/initial-sync-scaling/results.md`

Results are medians of 10 separate processes. Speedup intervals use paired rounds and a deterministic 50,000-sample bootstrap of the median ratio.

## Results

| Payload | Zero 0.22 Text | Zero 1.0 Text | Zero 1.8 Binary | Zero 1.8 Text |
| --- | ---: | ---: | ---: | ---: |
| 40 MB | 82.3 MB/s (0.48 s) | 75.9 MB/s (0.52 s) | 83.1 MB/s (0.48 s) | 74.5 MB/s (0.53 s) |
| 400 MB | 108.5 MB/s (3.64 s) | 106.4 MB/s (3.71 s) | 125.4 MB/s (3.15 s) | 106.1 MB/s (3.72 s) |
| 1.2 GB | 70.5 MB/s (16.81 s) | 67.9 MB/s (17.46 s) | 79.8 MB/s (14.85 s) | 69.5 MB/s (17.06 s) |

## Conclusion

The Zero 1.0 dip is fixed startup overhead, not a meaningful sustained-throughput regression:

- At 40 MB, Zero 1.0 is 8% slower than 0.22 and takes about 40 ms longer.
- From 40 to 400 MB, estimated marginal throughput is effectively identical: `112.5 MB/s` for 0.22 and `111.4 MB/s` for 1.0.
- At 400 MB and 1.2 GB, paired intervals for 1.0 versus 0.22 cross parity.
- The estimated fixed cost rises from `129 ms` in 0.22 to `166 ms` in 1.0, consistent with the progress reporting, metadata, and validation work added before 1.0.

Zero 1.8 improves sustained initial sync:

- Binary 1.8 is 16% faster than 0.22 at 400 MB and 13% faster at 1.2 GB.
- Binary 1.8 is 19% faster than 1.0 at 400 MB and 18% faster at 1.2 GB.
- At 1.2 GB, 1.8 saves `2.61 seconds` versus 1.0 and `1.97 seconds` versus 0.22.
- The 1.8 text control is close to 1.0 and 0.22 at larger sizes. Binary COPY accounts for most of the measured 1.8 gain.

This fixture does not reproduce the approximately 2x gain reported by the binary-COPY change. It measures complete initial sync with multiple tables and secondary indexes rather than COPY alone, and all configurations enter a slower local scaling regime above 400 MB. On this end-to-end workload, the reproducible binary-COPY improvement is approximately 15-19%.

See `results.md` for paired confidence intervals, dispersion, and piecewise scaling estimates.
