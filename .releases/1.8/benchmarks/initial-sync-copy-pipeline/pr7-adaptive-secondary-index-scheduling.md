# PR 7 Adaptive Secondary-Index Scheduling

## Worktree

- Repository: `/Users/chase/.worktree/mono/adaptive-secondary-index-scheduling`
- Branch: `0xcadams/adaptive-secondary-index-scheduling`
- Parent: `ea459443f18e7a6f94a32e28333f8af01df1b02b`
- Parent source: clean `origin/main` after PR #6237.

The implementation is uncommitted. No Docker image or benchmark has been run
because another benchmark is active on the host.

## Production Implementation

`initialSync` now supports a hidden configuration value:

```text
--initial-sync-secondary-index-min-average-row-bytes
ZERO_INITIAL_SYNC_SECONDARY_INDEX_MIN_AVERAGE_ROW_BYTES
```

The default is `0`, which disables eager secondary-index creation and preserves
the current production behavior. A canary value of `2048` enables the candidate
policy.

For each published table with secondary indexes, the policy computes:

```text
estimated physical bytes per row = pg_table_size(table) / pg_class.reltuples
```

If rows are positive and the estimate is at least the configured cutoff, all
non-primary indexes for that table are created before COPY. Primary indexes and
all indexes for narrow, empty, never-analyzed, or otherwise unknown-estimate
tables remain deferred until COPY completes.

`pg_table_size` includes the table's TOAST relation, free-space and visibility
maps, tuple overhead, dead tuples, and bloat; it excludes indexes. This measures
physical PostgreSQL width rather than binary COPY width. Compression can reduce
the estimate, while bloat and stale `reltuples` can inflate or distort it. The
source comment and structured decision log record this limitation explicitly.

When enabled, one structured info log records:

- The configured cutoff.
- Per-table estimate source, rows, bytes, average width, and selected strategy.
- Pre-copy secondary, post-copy secondary, and post-copy primary index counts.

Shadow sync has no estimates by design and keeps all indexes deferred. There is
no force-eager production option.

When the cutoff is `0`, the strategy computation and decision log are skipped,
so the default path retains current behavior and logging.

## Tests

The unit policy matrix covers:

- Disabled cutoff.
- Zero rows and missing/zero bytes.
- 2,047, 2,048, and 2,049 bytes per row at a 2 KiB cutoff.
- A large finite estimate.
- Stale high and low row-estimate outcomes.
- A custom 4 KiB cutoff.

The PostgreSQL integration case is implemented but intentionally not run yet. It
covers:

- Wide, narrow, and empty tables in separate schemas.
- Same table names across schemas.
- Regular, unique replica-identity, and primary indexes.
- Wide secondary indexes before COPY.
- Primary and nonqualifying indexes after COPY.
- Structured policy telemetry.
- Exact final index definitions.
- Indexed lookup and `PRAGMA integrity_check`.

Completed non-Docker verification:

- Focused no-PostgreSQL tests: 36 passed.
- Complete no-PostgreSQL zero-cache suite: 1,482 passed.
- zero-cache typecheck passed.
- zero-cache lint passed with 0 errors and existing warnings.
- zero-cache formatting and `git diff --check` passed.

Pending until Docker is available:

- Focused PostgreSQL 17 integration test.
- PostgreSQL 15 and 18 confirmation.
- Isolated Docker image builds and performance stages.

## Docker Images

Preview the three image builds without invoking Docker:

```sh
node scripts/build-pr7-images.mjs
```

Build them later with:

```sh
node scripts/build-pr7-images.mjs --execute
```

The builder records source commit, dirty status, source-diff SHA-256, image
policy, and immutable image ID in `manifests/pr7-images.json`.

The image roles are:

| Image                                         | Source                   | Policy                                |
| --------------------------------------------- | ------------------------ | ------------------------------------- |
| `zero-copy-pipeline-current-pr7-parent:local` | clean `ea459443f` parent | all indexes deferred                  |
| `zero-copy-pipeline-current-pr7-head:local`   | PR 7 worktree            | adaptive cutoff from treatment        |
| `zero-copy-pipeline-current-pr7-eager:local`  | PR 7 worktree            | benchmark-only forced eager secondary |

The forced-eager image rewrites the internal policy helper during the image
build. It does not add a production flag or modify the worktree.

## Prepared Stages

No stage below has been executed.

Direct parent/head attribution:

- `pr7-current-parent-head-scaled`
- `pr7-current-parent-head-full`
- `pr7-current-parent-head-narrow`

Three-strategy oracle blocks:

- `pr7-current-strategy-scaled`
- `pr7-current-strategy-full`
- `pr7-current-strategy-narrow`

The scaled and full groups include production-calibrated Email and imports
profiles. Narrow groups verify that adaptive selection remains deferred while
the forced-eager oracle exercises the known regression risk. Every stage uses
natural PostgreSQL row messages, `mmap_size=0`, fresh constrained ARM64
application containers, ten independent repetitions per profile, and balanced
ordering. Parent/head stages use AB/BA pairs; three-strategy stages rotate and
reverse all arms.

After image creation, preview and execute a stage with:

```sh
node scripts/run-docker.mjs pr7-current-parent-head-scaled --reuse-images
node scripts/run-docker.mjs pr7-current-parent-head-scaled --execute --reuse-images
node scripts/aggregate.mjs pr7-current-parent-head-scaled-docker
node scripts/summarize-integration.mjs \
  pr7-current-parent-head-scaled-docker pr7-deferred-parent
```

## Acceptance

- Adaptive stays within 3% of the better forced strategy per profile.
- At least 5% gain over deferred behavior on wide production profiles.
- No more than 3% regression on narrow profiles.
- No new OOM, memory-pressure, or I/O-pressure failures.
- Every run retains exact rows, payload hashes, index definitions, and SQLite
  integrity.

The hidden setting should remain default-off until the isolated matrix passes
and a canary confirms selected policies and phase timings on real estimates.
