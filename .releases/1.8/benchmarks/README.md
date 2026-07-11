# Zero 1.8 Benchmark Methodology

## Refs

- Baseline: `zero/v1.7.0` (`6863de5f00a3c1e7dc09c83ea3263dec4a94ebee`)
- Target: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)

## Worktrees

- Baseline worktree: `/var/folders/97/c3gvpw6d46g3nm0y2684_cfm0000gn/T/opencode/zero-1.8-final/baseline`
- Target worktree: `/var/folders/97/c3gvpw6d46g3nm0y2684_cfm0000gn/T/opencode/zero-1.8-final/target`

Both worktrees were installed with:

```sh
corepack pnpm install --frozen-lockfile
```

Both installs warned about package bin links targeting workspace outputs that had not yet been built; the benchmark commands still succeeded.

## Environment

- Machine: Apple M5 Pro
- OS: macOS arm64, Darwin `25.5.0`
- Node: `v22.23.1`
- Package manager: `corepack pnpm` resolved to `11.5.3` in both mono worktrees
- Docker server: `29.6.1`
- PostgreSQL benchmark image: `postgres:17-alpine`
- Relevant benchmark env: `BENCH_OUTPUT_FORMAT=json`, `NO_COLOR=1`
- Final in-memory runs alternated baseline and target process pairs because an earlier sequential target batch was bimodal. Only the paired runs are retained in the raw-output paths below.

## Temp Backports And Benchmark-Only Changes

No production code was backported.

- Baseline-only benchmark harness/config backports:
  - Added `packages/zql-benchmarks/vitest.config.bench-mem.ts` from target so in-memory benchmarks can run without PG global setup.
  - Patched `packages/shared/src/bench.ts` and `packages/shared/src/bench-format.ts` to emit `median` in JSON and support manual throughput rows. This is benchmark harness behavior used by target.
  - Restored target benchmark-only files `packages/zero-cache/vitest.config.bench.pg.ts`, `packages/zero-cache/src/test/pg-bench.ts`, `packages/zero-cache/src/services/change-streamer/storer.bench.pg.ts`, and `packages/zero-cache/src/services/replicator/replication-throughput.bench.pg.ts`.
- Both refs:
  - Added `packages/zql-benchmarks/src/take-start-seek.bench.ts` as targeted post-matrix coverage for `#6184`.
  - Archived the exact targeted benchmark source at `.releases/1.8/benchmarks/take-start-seek.bench.ts`.
  - Added `src/take-start-seek.bench.ts` to `packages/zql-benchmarks/vitest.config.bench-mem.ts`.
  - Adjusted `packages/zero-cache/src/services/replicator/replication-throughput.bench.pg.ts` to measure one 50,000-change transaction and fifty 1,000-change transactions once per process. The exact source is archived at `.releases/1.8/benchmarks/replication-large-transactions.bench.pg.ts`.
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

### Local ZQL Query Execution

Coverage type: original-suite coverage. `ivm-memory.bench.ts` and its hydration cases are identical on both refs. The public chart uses complete query execution for relationship and `limit(50)` queries, rather than the lower-level source-read results above.

```sh
BENCH_OUTPUT_FORMAT=json NO_COLOR=1 corepack pnpm --filter zql-benchmarks exec vitest run --config vitest.config.bench-mem.ts src/ivm-memory.bench.ts -t hydration
```

Raw outputs:

- `.releases/1.8/benchmarks/raw/local-hydration/baseline-*.log`
- `.releases/1.8/benchmarks/raw/local-hydration/target-*.log`

### Maintaining `orderBy()` + `limit()` Queries

Coverage type: targeted post-matrix coverage. The benchmark materializes a filtered query using `orderBy()` and `limit(50)`, then measures complete maintenance updates that move its cutoff row into and out of the result. Cutoffs are placed 50, 10,000, 50,000, 90,000, and 100,000 rows into an indexed workspace. Each cutoff runs in a separate process to prevent SQLite fixture memory from affecting later cases.

```sh
BENCH_DEPTH=50000 BENCH_OUTPUT_FORMAT=json NO_COLOR=1 corepack pnpm --filter zql-benchmarks exec vitest run --config vitest.config.bench-mem.ts src/take-start-seek.bench.ts
```

Raw outputs:

- `.releases/1.8/benchmarks/raw/take-start-seek/baseline-*.log`
- `.releases/1.8/benchmarks/raw/take-start-seek/target-*.log`

### Replicating Large Transactions

Coverage type: targeted post-matrix coverage using the target's end-to-end replication benchmark on both refs. It measures from writes committed to upstream Postgres until all changes reach the SQLite replica. Each process measures one 50,000-change transaction and fifty 1,000-change transactions.

```sh
BENCH_OUTPUT_FORMAT=json NO_COLOR=1 corepack pnpm --filter zero-cache exec vitest run --config vitest.config.bench.pg.ts src/services/replicator/replication-throughput.bench.pg.ts
```

Raw outputs:

- `.releases/1.8/benchmarks/raw/replication-e2e/baseline-*.log`
- `.releases/1.8/benchmarks/raw/replication-e2e/target-*.log`

### CDC Storer Throughput

Coverage type: targeted post-matrix coverage. Target benchmark files were temp-backported to baseline, then the workload was scaled to one measured sample per process so the release process could collect 10 process-level runs.

This synthetic storer-only benchmark measures persistence into the ChangeDB. It does not include logical decoding, network transfer, or end-to-end replication.

```sh
BENCH_OUTPUT_FORMAT=json NO_COLOR=1 corepack pnpm --filter zero-cache exec vitest run --config vitest.config.bench.pg.ts src/services/change-streamer/storer.bench.pg.ts
```

Raw outputs:

- `.releases/1.8/benchmarks/raw/storer-pg/baseline-*.log`
- `.releases/1.8/benchmarks/raw/storer-pg/target-*.log`

Raw logs remain local and are ignored by Git. The committed aggregate JSON contains every process-level median used in the release-note calculations.

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

| Group                                       | Comparable Rows | Median Ratio | Geomean Ratio |
| ------------------------------------------- | --------------: | -----------: | ------------: |
| In-memory ZQL fetch                         |               5 |        2.35x |         2.05x |
| Running local ZQL queries                   |               5 |        1.29x |         1.04x |
| Maintaining `orderBy()` + `limit()` queries |               5 |        2.10x |         4.36x |
| Replicating large transactions              |               2 |        1.57x |         1.57x |
| CDC storer throughput                       |               2 |        2.37x |         2.36x |

See `.releases/1.8/benchmarks/aggregate.md` for row-level results.
