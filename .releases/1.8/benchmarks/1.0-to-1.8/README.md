# Zero 1.0 to 1.8 Product Benchmark Methodology

## Refs

- Baseline: `zero/v1.0.0` (`5a5ea6b786d126fb12f34b1b81a846b8b00a754b`)
- Target: `maint/zero/v1.8` (`cdc02598f137ab4e071878f5674fdc716dbbc69d`)
- Note: `zero/v1.8.0` was not available locally, and fetching tags failed with SSH public-key auth. The target branch was approved as the comparison ref.

## Worktrees

- Baseline worktree: `/var/folders/97/c3gvpw6d46g3nm0y2684_cfm0000gn/T/opencode/zero-1.0-1.8-e2e-bench/baseline-1.0`
- Target worktree: `/var/folders/97/c3gvpw6d46g3nm0y2684_cfm0000gn/T/opencode/zero-1.0-1.8-e2e-bench/target-1.8`

Installs:

```sh
npm ci
corepack pnpm install --frozen-lockfile
```

The baseline worktree used `npm ci`. The target worktree used `corepack pnpm install --frozen-lockfile`. The baseline did not use `pnpm` because that ref declares npm as its package manager.

## Environment

- Machine: Apple M5 Pro
- OS: macOS arm64, Darwin `25F84`, macOS `26.5.2`
- Node: `v22.23.1`
- Baseline npm: `10.9.8`
- Target pnpm: `11.5.3`
- Docker server: `29.6.1`
- PostgreSQL benchmark image: `postgres:17-alpine`

## Benchmark-Only Changes

No production code was backported.

The following benchmark-only files were added to both temp worktrees:

- `packages/zql-benchmarks/vitest.config.product.ts`
- `packages/zql-benchmarks/src/product-e2e.bench.ts`
- `packages/zero-cache/vitest.config.product.pg.ts`
- `packages/zero-cache/src/product-e2e.product.bench.pg.ts`

The benchmark definitions were intended to be equivalent across refs. Compatibility handling was limited to benchmark harness code, including object-vs-tuple source-change formatting, change-streamer initialization differences, and the modern `ReplicatorService` status-publisher argument.

## Workload Scope

The comparison is intentionally user-facing and end-to-end-ish rather than microbench-only.

Included workloads:

- Postgres initial sync/backfill payload throughput.
- Live Postgres replication throughput for one large transaction.
- Live Postgres replication throughput for many medium transactions.
- Postgres commit-to-local-replica visibility latency.
- Reconnect/catch-up from stored ChangeStreamer backlog.
- Local client query hydration.
- Server large SQLite-backed query initialization.
- New client initial load from an existing local replica.
- Large result materialization with related rows.
- Large sparse `where()` plus `orderBy()` plus `limit()` maintenance.

Excluded workloads:

- Permissions.
- CRUD/mutator benchmarks.

## Commands

### Validation

Each ref was validated once at full workload size before collecting 10-run batches. ZQL validation used one sample per benchmark to keep it a quick smoke of the full-size data setup.

Baseline ZQL validation:

```sh
ZERO_BENCH_SOURCE_CHANGE_FORMAT=object ZERO_PRODUCT_BENCH_SAMPLES=1 npx vitest run --config vitest.config.product.ts
```

Target ZQL validation:

```sh
ZERO_BENCH_SOURCE_CHANGE_FORMAT=tuple ZERO_PRODUCT_BENCH_SAMPLES=1 corepack pnpm exec vitest run --config vitest.config.product.ts
```

Baseline Postgres validation:

```sh
npx vitest run --config vitest.config.product.pg.ts
```

Target Postgres validation:

```sh
corepack pnpm exec vitest run --config vitest.config.product.pg.ts
```

Validation logs:

- `.releases/1.8/benchmarks/1.0-to-1.8/raw/product-zql/validate-baseline.log`
- `.releases/1.8/benchmarks/1.0-to-1.8/raw/product-zql/validate-target.log`
- `.releases/1.8/benchmarks/1.0-to-1.8/raw/product-pg/validate-baseline.log`
- `.releases/1.8/benchmarks/1.0-to-1.8/raw/product-pg/validate-target.log`

### Final Runs

Run count: 10 separate processes per ref per benchmark command. Benchmark processes were not run in parallel.

ZQL final runs used the harness default of 5 samples per benchmark per process. The Postgres harness records one timing per scenario per process.

Baseline ZQL:

```sh
ZERO_BENCH_SOURCE_CHANGE_FORMAT=object npx vitest run --config vitest.config.product.ts
```

Target ZQL:

```sh
ZERO_BENCH_SOURCE_CHANGE_FORMAT=tuple corepack pnpm exec vitest run --config vitest.config.product.ts
```

Baseline Postgres:

```sh
npx vitest run --config vitest.config.product.pg.ts
```

Target Postgres:

```sh
corepack pnpm exec vitest run --config vitest.config.product.pg.ts
```

Raw outputs:

- `.releases/1.8/benchmarks/1.0-to-1.8/raw/product-zql/baseline-*.log`
- `.releases/1.8/benchmarks/1.0-to-1.8/raw/product-zql/target-*.log`
- `.releases/1.8/benchmarks/1.0-to-1.8/raw/product-pg/baseline-*.log`
- `.releases/1.8/benchmarks/1.0-to-1.8/raw/product-pg/target-*.log`

Raw logs remain local and are ignored by Git. The generated aggregate JSON contains every process-level median used in the comparison.

## Aggregation

Run:

```sh
node .releases/1.8/benchmarks/1.0-to-1.8/aggregate-benchmarks.mjs
```

Outputs:

- `.releases/1.8/benchmarks/1.0-to-1.8/aggregate.json`
- `.releases/1.8/benchmarks/1.0-to-1.8/aggregate.md`

Aggregation method: median of each benchmark's process-level medians. Ratios are raw `baseline / target`, so values above `1.0` are faster in the target. Postgres throughput rows are recorded as `ns/MB` and displayed as decimal `MB/s` using `1,000,000,000 / nsPerMB`.

## Summary Results

| Group | Comparable Rows | Median Ratio | Geomean Ratio |
| --- | ---: | ---: | ---: |
| Postgres sync, replication, and catch-up | 5 | 1.10x | 1.09x |
| Local and server query workloads | 10 | 1.22x | 2.34x |
| Overall | 15 | 1.21x | 1.82x |
| Overall excluding largest improvement | 14 | 1.19x | 1.36x |

The largest improvement is the sparse `orderBy().limit()` maintenance case at the 100,000-row cutoff depth, where target is `107.74x` faster. That outlier is retained in the row-level report and also excluded from the adjusted overall aggregate above.

See `.releases/1.8/benchmarks/1.0-to-1.8/aggregate.md` for row-level results.

## Caveats

- These are local single-machine results and should be treated as directional release evidence, not a cross-machine performance guarantee.
- Postgres throughput is application payload throughput in decimal `MB/s`, not WAL bytes, logical-replication wire bytes, or MiB/s.
- The comparison uses benchmark-only harnesses added to temp worktrees rather than benchmarks committed in both historical refs.
