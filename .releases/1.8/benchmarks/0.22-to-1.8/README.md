# Zero 0.22 to 1.8 Product Benchmark Methodology

## Refs

- Baseline: `zero/v0.22.2025071101` (`bef41d6de044cd3de5173c56df1329a19933e175`), published `2025-07-11T16:30:57.769Z`
- Target: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)
- Target runs were reused from `.releases/1.8/benchmarks/1.0-to-1.8/aggregate.json` because the same target ref, benchmark definitions, machine, and run protocol were already measured.

## Worktrees

- Baseline worktree: `/var/folders/97/c3gvpw6d46g3nm0y2684_cfm0000gn/T/opencode/zero-1.0-1.8-e2e-bench/baseline-0.22`
- Target worktree: `/var/folders/97/c3gvpw6d46g3nm0y2684_cfm0000gn/T/opencode/zero-1.0-1.8-e2e-bench/target-1.8`

The 0.22 worktree was installed with:

```sh
npm ci
```

## Environment

- Machine: Apple M5 Pro
- OS: macOS arm64, Darwin `25F84`, macOS `26.5.2`
- Node: `v22.23.1`
- Baseline npm: `10.9.8`
- Docker server: `29.6.1`
- PostgreSQL benchmark image: `postgres:17-alpine`

## Benchmark-Only Changes

No production code was backported.

The same product benchmark harnesses from the 1.0-to-1.8 comparison were added to the 0.22 temp worktree. The 0.22 harness also needed benchmark-only compatibility edits for APIs that changed before 1.0:

- Added `packages/zql-benchmarks/src/schema.ts`, since 0.22 did not have the shared benchmark schema file.
- Used `newQuery()` plus query-level `delegate().run()` and `delegate().materialize()` instead of newer delegate-level helpers.
- Handled 0.22 `MemorySource.push()` returning `void` instead of a lazy stream.
- Used the older `initializeStreamer()` signature without a replication status publisher.
- Used the 0.22 `ReplicatorService` constructor with a direct SQLite `Database` replica.
- Read catch-up subscription state directly from the replica via `StatementRunner`.

## Commands

### Validation

Reduced validations were run first, then full-size validations before final batches.

Full-size 0.22 ZQL validation:

```sh
ZERO_BENCH_SOURCE_CHANGE_FORMAT=object ZERO_PRODUCT_BENCH_SAMPLES=1 npx vitest run --config vitest.config.product.ts
```

Full-size 0.22 Postgres validation:

```sh
npx vitest run --config vitest.config.product.pg.ts
```

### Final Runs

Run count: 10 separate processes per ref per benchmark command. Benchmark processes were not run in parallel.

0.22 ZQL:

```sh
ZERO_BENCH_SOURCE_CHANGE_FORMAT=object npx vitest run --config vitest.config.product.ts
```

0.22 Postgres:

```sh
npx vitest run --config vitest.config.product.pg.ts
```

Raw outputs:

- `.releases/1.8/benchmarks/0.22-to-1.8/raw/product-zql/baseline-*.log`
- `.releases/1.8/benchmarks/0.22-to-1.8/raw/product-pg/baseline-*.log`

Raw logs remain local and are ignored by Git. The generated aggregate JSON contains every process-level median used in the comparison.

## Aggregation

Run:

```sh
node .releases/1.8/benchmarks/0.22-to-1.8/aggregate-benchmarks.mjs
```

Outputs:

- `.releases/1.8/benchmarks/0.22-to-1.8/aggregate.json`
- `.releases/1.8/benchmarks/0.22-to-1.8/aggregate.md`
- `.releases/1.8/benchmarks/0.22-to-1.8/three-way.json`
- `.releases/1.8/benchmarks/0.22-to-1.8/three-way.md`

Aggregation method: median of each benchmark's process-level medians. Ratios are raw older/newer ratios, so values above `1.0` mean the newer version is faster. Postgres throughput rows are recorded as `ns/MB` and displayed as decimal `MB/s` using `1,000,000,000 / nsPerMB`.

## Summary Results

| Group | Comparable Rows | Median Ratio | Geomean Ratio |
| --- | ---: | ---: | ---: |
| Postgres sync, replication, and catch-up | 5 | 1.05x | 2.02x |
| Local and server query workloads | 10 | 1.47x | 2.62x |
| Overall | 15 | 1.19x | 2.41x |
| Overall excluding largest improvement | 14 | 1.16x | 1.83x |

The largest improvement is reconnect/catch-up from stored ChangeStreamer backlog, where target is `111.93x` faster than 0.22 in this harness. The row is retained in the row-level report and also excluded from the adjusted overall aggregate above.

See `.releases/1.8/benchmarks/0.22-to-1.8/three-way.md` for the 0.22, 1.0, and 1.8 table.
