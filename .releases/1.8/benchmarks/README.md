# Zero 1.8 Benchmark Methodology

## Refs

- Baseline: `zero/v1.7.0` (`6863de5f00a3c1e7dc09c83ea3263dec4a94ebee`)
- Target: `maint/zero/v1.8` (`4ef9e4ef04fbc9fa838c930887d5d6b97241b789`)

## Worktrees

- Baseline worktree: `/var/folders/97/c3gvpw6d46g3nm0y2684_cfm0000gn/T/opencode/zero-1.8-bench/zero-v1.7.0`
- Target worktree: `/var/folders/97/c3gvpw6d46g3nm0y2684_cfm0000gn/T/opencode/zero-1.8-bench/zero-v1.8-e91`, advanced to `4ef9e4ef0`

Both worktrees were installed with:

```sh
corepack pnpm install --frozen-lockfile
```

The install completed on both refs with warnings about package bin links pointing at not-yet-built workspace outputs. The benchmark commands below succeeded despite those warnings.

## Environment

- OS: macOS arm64, Darwin `25.5.0`
- Node: `v22.23.1`
- Package manager: `corepack pnpm` resolved to `11.5.3` in both mono worktrees
- Docker server: `29.6.1`
- Relevant benchmark env: `BENCH_OUTPUT_FORMAT=json`, `NO_COLOR=1`

## Temp Backports And Benchmark-Only Changes

No production code was backported.

- Baseline-only benchmark harness/config backports:
  - Added `packages/zql-benchmarks/vitest.config.bench-mem.ts` from target so in-memory benchmarks can run without PG global setup.
  - Patched `packages/shared/src/bench.ts` and `packages/shared/src/bench-format.ts` to emit `median` in JSON and support manual throughput rows. This is benchmark harness behavior used by target.
  - Restored target benchmark-only files `packages/zero-cache/vitest.config.bench.pg.ts`, `packages/zero-cache/src/test/pg-bench.ts`, and `packages/zero-cache/src/services/change-streamer/storer.bench.pg.ts`.
- Both refs:
  - Added `packages/zql-benchmarks/src/take-start-seek.bench.ts` as targeted post-matrix coverage for `#6184`.
  - Added `src/take-start-seek.bench.ts` to `packages/zql-benchmarks/vitest.config.bench-mem.ts`.
  - Adjusted `packages/zero-cache/src/services/change-streamer/storer.bench.pg.ts` for process-level release benchmarking: `SINGLE_TRANSACTION_CHANGES = 50_000`, `SUSTAINED_TRANSACTIONS = 50`, `REPS = 1`, with 10 separate process runs per ref.

## Commands

### In-Memory ZQL Fetch

Coverage type: original-suite coverage. The benchmark file existed on both refs; the Docker-free bench config was temp-backported to baseline.

```sh
BENCH_OUTPUT_FORMAT=json NO_COLOR=1 corepack pnpm --filter zql-benchmarks exec vitest run --config vitest.config.bench-mem.ts src/memory-ivm-deopt.bench.ts -t "fetch"
```

Raw outputs:

- `.releases/1.8/benchmarks/raw/memory-fetch/baseline-*.log`
- `.releases/1.8/benchmarks/raw/memory-fetch/target-*.log`

### Seekable Ordered Take Maintenance

Coverage type: targeted post-matrix coverage. The benchmark was added to both temp worktrees to measure the `#6184` planner path directly.

```sh
BENCH_OUTPUT_FORMAT=json NO_COLOR=1 corepack pnpm --filter zql-benchmarks exec vitest run --config vitest.config.bench-mem.ts src/take-start-seek.bench.ts
```

Raw outputs:

- `.releases/1.8/benchmarks/raw/take-start-seek/baseline-*.log`
- `.releases/1.8/benchmarks/raw/take-start-seek/target-*.log`

### CDC Storer Throughput

Coverage type: targeted post-matrix coverage. Target benchmark files were temp-backported to baseline, then the workload was scaled to one measured sample per process so the release process could collect 10 process-level runs.

```sh
BENCH_OUTPUT_FORMAT=json NO_COLOR=1 corepack pnpm --filter zero-cache exec vitest run --config vitest.config.bench.pg.ts src/services/change-streamer/storer.bench.pg.ts
```

Raw outputs:

- `.releases/1.8/benchmarks/raw/storer-pg/baseline-*.log`
- `.releases/1.8/benchmarks/raw/storer-pg/target-*.log`

## Aggregation

Run:

```sh
node .releases/1.8/benchmarks/aggregate-benchmarks.mjs
```

Outputs:

- `.releases/1.8/benchmarks/aggregate.json`
- `.releases/1.8/benchmarks/aggregate.md`

Aggregation method: median of each benchmark's process-level medians. Ratios are `baseline / target`; values above `1.0` are faster in the target.

## Summary Results

| Group                             | Comparable Rows | Median Ratio | Geomean Ratio |
| --------------------------------- | --------------: | -----------: | ------------: |
| In-memory ZQL fetch               |               5 |        2.33x |         2.05x |
| Seekable ordered take maintenance |               1 |     5259.68x |      5259.68x |
| CDC storer throughput             |               2 |        1.71x |         1.71x |

See `.releases/1.8/benchmarks/aggregate.md` for row-level results.
