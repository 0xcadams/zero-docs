# Initial Sync Performance PR Plan

## Purpose

This document is the handoff plan for turning the initial-sync COPY pipeline
investigation into small, independently reviewable PRs. It records the
production context, benchmark findings, code and result locations, reliability
problems discovered in the exploratory harness, completed verification, and the
recommended merge order.

The central decision is:

> `mono` is the canonical home for executable benchmarks, fixtures, validation,
> and statistics. `zero-docs` stores sanitized production calibration, frozen
> reports, decisions, and release context.

`zmail` is a separate deployment-level canary, not a second benchmark home. Its
normal seeded dataset will carry a synthetic, production-calibrated varied email
shape so candidate Zero builds can be exercised through a real staging stack at
different seed counts. Performance attribution and PR acceptance remain with
the controlled `mono` benchmarks.

Do not land the current research worktree as one PR. It intentionally combines
several treatments, benchmark controls, native-package experimentation, and
rejected ideas.

## Executive Summary

The frozen candidate combined:

- Linear assembly of fragmented binary COPY fields.
- Batched OpenTelemetry COPY byte and chunk counters.
- Direct Buffer decoding for eligible text-like PostgreSQL fields.
- Native UTF-8 Buffer binding through `SQLITE_TRANSIENT`.
- Adaptive eager creation of secondary indexes for wide tables.
- `mmap_size=0` in the benchmark configuration.

Against the pinned `origin/main` baseline at
`d87c1c813b2e57abdf814eadda98b8d5e5885979`, the bundled candidate measured:

| Median                | Email origin | Email candidate | Change | imports origin | imports candidate | Change |
| --------------------- | -----------: | --------------: | -----: | -------------: | ----------------: | -----: |
| Initial-sync callback |     23.981 s |         7.673 s | -68.0% |        7.757 s |           4.832 s | -37.7% |
| Dominant table COPY   |     11.965 s |         7.062 s | -41.0% |        5.961 s |           4.459 s | -25.2% |
| Index phase           |     12.008 s |         0.096 s | -99.2% |        1.639 s |           0.011 s | -99.4% |
| Peak Node RSS         |    414.0 MiB |       215.3 MiB | -48.0% |      355.2 MiB |         205.5 MiB | -42.2% |

These are integrated bundle results, not the sum of independently proven PR
benefits. The current harness is adequate for exploration but not yet reliable
enough for per-PR causal claims. Durable fixtures and disciplined manual
parent/head execution therefore come first.

Recommended merge order:

1. Durable benchmark fixtures and correctness.
2. Representative zmail seed shape and staging canary procedure.
3. Batched COPY metrics.
4. Initial-sync source/processing telemetry.
5. Linear fragmented-field parser.
6. Direct Buffer binding through `CAST(? AS TEXT)`.
7. Adaptive secondary-index scheduling.
8. Native transient UTF-8 binding as a three-PR package stack.

Producer/parser workers are not part of this sequence. Current telemetry does
not show a material recoverable parser gap.

## Repository And Worktree State

Historical investigation locations:

- Main mono repository: `/Users/chase/git/roci/mono`
- Candidate research worktree:
  `/Users/chase/.worktree/mono/initial-sync-copy-pipeline`
- Baseline research worktree:
  `/Users/chase/.worktree/mono/initial-sync-copy-pipeline-baseline`
- Benchmark evidence:
  `/Users/chase/git/roci/zero-docs/.releases/1.8/benchmarks/initial-sync-copy-pipeline`
- zmail staging-canary repository: `/Users/chase/git/roci/zmail`

The research worktrees started at
`d87c1c813b2e57abdf814eadda98b8d5e5885979`. The candidate branch is
`0xcadams/initial-sync-copy-pipeline`, but its changes are uncommitted. The
current `origin/main` advanced after the investigation. Resolve and record the
current full SHA before starting each PR.

The candidate worktree contains changes to:

- `packages/zero-cache/src/db/pg-copy-binary.ts`
- `packages/zero-cache/src/db/pg-copy-binary.test.ts`
- `packages/zero-cache/src/services/change-source/pg/initial-sync.ts`
- `packages/zero-cache/src/services/change-source/pg/initial-sync.pg.test.ts`
- `packages/zqlite/src/db.ts`
- `packages/zqlite/src/db.test.ts`
- `pnpm-workspace.yaml`
- `pnpm-lock.yaml`
- `patches/@rocicorp__zero-sqlite3@1.1.2.patch`

It also contains benchmark-only files copied from this zero-docs directory.
Use this worktree as a research reference only. Reimplement each accepted
change in a fresh worktree from current `origin/main`; do not create commits by
splitting or mass-staging the omnibus diff.

All new branches must use the `0xcadams/<name>` form. From the mono repository,
the local `wt <name>` helper creates the matching worktree and branch.

zmail was inspected on clean `main` at
`b7337e3fb8e8d2a7235d8c13814da97f3c7bb0d6` (`chore: 1.8 (#8)`). It has no
`AGENTS.md`, `CLAUDE.md`, or other repository-local agent instructions. Its
current checked-in deployment surface is intentionally small:

- `docker-compose.yml` starts PostgreSQL 18 with logical WAL; it does not define
  zero-cache or resource limits.
- `.env.sample` configures local PostgreSQL, zero-cache URLs, and zero-cache dev
  settings.
- `apps/web/vercel.json` configures the web cron and immutable image headers; it
  does not deploy zero-cache.
- There is no current Dockerfile, Kubernetes, Terraform, Fly, or staging
  manifest in the repository. The historical email-add GitHub workflow was
  removed and is not a staging deployment path.

Consequently, the zmail PR can make fixture generation and verification
durable, but pinning baseline/candidate images and enforcing the 1 CPU/3 GiB
zero-cache limit must be done in the external staging system unless a deployment
manifest is added by that system's owner.

## Production Background

The investigation started from two large production initial-sync shapes. The
production dashboard rate was originally suspected to reflect a network cap.
Read-only AWS, NAT, CPU, and historical same-pod COPY evidence disproved that.
The rate is an end-to-end application pipeline rate that includes parser and
synchronous SQLite backpressure.

### PL Email

- 1 CPU, 3 GiB memory, and local NVMe-backed ephemeral storage.
- Production shadow publication had 108 tables and 345 SQLite indexes.
- The dominant `Email` table has 25 columns and four indexes.
- Recent 10,000-row samples ranged from 0.252 GB to 6.830 GB.
- Large samples completed at 49-56 MB/s end-to-end.
- A 6.830 GB sample took 133.14 seconds, including 45.82 seconds in SQLite
  flush calls.
- The container averaged 0.964 CPU against a one-core limit.
- Observed aggregate COPY chunks were approximately 4-31 KiB.

### Margins Imports

- 2 CPUs, 6 GiB memory, and local NVMe-backed ephemeral storage.
- Production shadow publication had 91 tables and 311 SQLite indexes.
- `userspace.imports` has seven columns and six indexes.
- Recent 10,000-row samples ranged from 2.674 GB to 2.793 GB.
- Table copies completed at 61-65.5 MB/s end-to-end.
- A representative table copy spent approximately 20 seconds in SQLite flush
  calls during a 41-45 second copy.
- The workload used approximately one saturated CPU core out of its two-core
  limit.
- Observed aggregate COPY chunks averaged approximately 5.5 KiB.

The two stacks were in different AWS regions, VPCs, and NAT gateways. NAT
packet drops and port-allocation errors were zero during measured windows.
Historical same-pod COPY-to-null measurements reached approximately 307-363
MiB/s. Do not reintroduce an artificial 50-52 MB/s network target as the main
optimization criterion.

Production context and supporting evidence:

- `production-baseline.md`
- `/Users/chase/git/roci/zero-docs/.releases/1.8/benchmarks/initial-sync-bottleneck/ec2.md`
- `/Users/chase/git/roci/cloudzero/initial-sync-dashboard.tryout.import.json`

Production shadow sync hardcodes one copy worker and differs from serving
initial sync in transaction and PRAGMA behavior. Production row shapes, bytes,
chunks, CPU, memory, and source backpressure are useful calibration. Absolute
shadow flush and index durations are not direct serving-initial-sync results.

## Workload Profiles

The exploratory Docker profiles used:

The labels in this historical table preserve zero-docs calibration provenance.
They are not names to copy into canonical mono benchmark schemas or profile
identifiers.

| Profile                    |    Rows | Payload per row | Approximate COPY payload | Rechunk size | CPU | Memory |
| -------------------------- | ------: | --------------: | -----------------------: | -----------: | --: | -----: |
| `email-683m`               |   1,000 |         683,000 |                   683 MB |       31,744 |   1 |  3 GiB |
| `email-high-6.83g`         |  10,000 |         683,000 |                  6.83 GB |       31,744 |   1 |  3 GiB |
| `imports-550m`             |   2,000 |         275,000 |                   550 MB |        5,632 |   2 |  6 GiB |
| `imports-production-2.75g` |  10,000 |         275,000 |                  2.75 GB |        5,632 |   2 |  6 GiB |
| `email-narrow-250k`        | 250,000 |             128 |                    32 MB |       31,744 |   1 |  3 GiB |
| `imports-narrow-250k`      | 250,000 |             128 |                    32 MB |        5,632 |   2 |  6 GiB |

The future canonical mono benchmark must retain the existing mixed 250,000-row
fixture as its default durable regression lane in:

- `packages/zero-cache/src/db/initial-sync.bench.pg.ts`
- `packages/zero-cache/src/test/pg-bench.ts`
- `packages/shared/src/bench.ts`

That fixture supplies ordinary-table regression coverage and remains the normal
default invocation. It does not replace the production-shaped large-field
profiles selected as `wide-text-scaled`, `wide-text-full`,
`large-payload-scaled`, `large-payload-full`, `wide-text-narrow`, and
`large-payload-narrow`.

### Proposed zmail Seed Scaling

zmail already has a seeded mail model and deterministic PRNG:

- `email_metadata` has 19 metadata columns and the application indexes.
- Its one-to-one `email_content` table has five columns, including varied large
  HTML, plain text, image URL JSON, and header JSON.
- `packages/shared/src/seed/index.ts` uses the fixed `zmail-v1` seed and
  generates HTML in weighted 8 KiB to 1.5 MiB buckets.
- `scripts/seed/index.ts` currently defaults to 10,000 rows in batches of 500,
  accepts existing `EMAIL_COUNT` and `BATCH_SIZE` configuration, uses the current
  time for batch metadata, and has no whole-fixture verifier.

Do not denormalize or rename the application tables merely to imitate a
customer schema. Add one synthetic, app-independent `initial_sync_email` table
that is populated one-for-one by every normal seed and is included in the
generated Zero schema. This puts the relevant width, large fields, and indexes
on one dominant COPY table without changing inbox query behavior or introducing
a staging-only generator.

Use the existing seed command and cardinality controls for every environment.
Calibrate against actual PostgreSQL binary COPY bytes rather than JavaScript
string-length estimates:

| Seed use       | `EMAIL_COUNT` | Target dominant-table COPY payload | Purpose                                        |
| -------------- | ------------: | ---------------------------------: | ---------------------------------------------- |
| Local default  |           100 |                      about 68.3 MB | Practical development and correctness smoke    |
| Staging scaled |         1,000 |                       about 683 MB | Routine constrained initial-sync canary        |
| Staging full   |        10,000 |                      about 6.83 GB | Full-volume initial-sync deployment validation |

All counts use the same generator, field-size distribution, and row sequence;
only cardinality changes. The first 100 rows of a 1,000- or 10,000-row seed must
be byte-identical to a 100-row seed. The large target is decimal GB, matching the
production calibration. A checked-in calibration manifest records exact emitted
binary COPY bytes for the canonical counts after calibration; acceptance uses
those exact values with no tolerance.

## Investigation Findings By Treatment

### Linear Fragmented-Field Parser

The original `BinaryCopyParser` repeatedly concatenated an incomplete field
with each subsequent chunk. For a large value split across many chunks, bytes
already assembled were copied repeatedly. Estimated copy amplification was
12.5x to 63.4x for the observed production shapes.

The candidate allocates one exact-size Buffer for a fragmented field, copies
each fragment once, and continues using zero-copy subarrays for fields already
contained in a chunk.

Isolated parser results:

| Parser profile                 |  Baseline |   Linear | Change |
| ------------------------------ | --------: | -------: | -----: |
| imports, 270 KiB field/5.5 KiB | 11.178 ms | 3.278 ms | -70.7% |
| Email, 683 KiB field/31 KiB    |  5.673 ms | 2.116 ms | -62.7% |
| Email, 683 KiB field/5.5 KiB   | 17.484 ms | 3.001 ms | -82.8% |
| Contained 4 KiB field/31 KiB   |  3.238 ms | 3.090 ms |  -4.6% |

The cleaner five-run host integration comparison was much smaller:

- Email: 2.721 seconds to 2.624 seconds, 3.6% faster.
- imports: 2.392 seconds to 2.322 seconds, 2.9% faster.

The parser microbenchmark strongly proves removal of pathological assembly
work. It does not prove an equivalent end-to-end initial-sync percentage.

Primary evidence:

- `results/parser-core.json`
- `results/integration-core-summary.json`
- `results/docker-core-docker-summary.json`

### Direct Text Buffers Through SQLite CAST

The original path converted text-like COPY fields to JavaScript strings. The
candidate keeps eligible text, varchar, bpchar, JSON, JSONB, enum, and
PostgreSQL text-cast values as Buffers. SQLite receives them through
`CAST(? AS TEXT)`, and JSONB drops its one-byte binary version prefix.

Three-repetition constrained Docker A/B:

| Workload       | String decoding | Buffer plus CAST | Change |
| -------------- | --------------: | ---------------: | -----: |
| Email 683 MB   |         1.262 s |          0.670 s | -47.0% |
| imports 550 MB |         1.091 s |          1.058 s |  -3.0% |

The effect is strongly workload- and environment-dependent. A non-Docker run
showed only approximately 2-5% gains. The large Email result should not be
generalized without a clean parent/head rerun.

Primary evidence:

- `results/docker-direct-text-core-docker-summary.json`
- `results/direct-text-core-summary.json`
- `results/direct-text-production-smoke-docker-summary.json`

### Native Transient UTF-8 Binding

The candidate patch adds `Statement.utf8BufferParameters(indexes)` and binds
selected Buffer parameters with:

```cpp
sqlite3_bind_text64(..., SQLITE_TRANSIENT, SQLITE_UTF8)
```

This removes the SQLite CAST while keeping Buffer input. `SQLITE_TRANSIENT`
makes SQLite copy the data before returning, which protects against later
Buffer mutation or collection. The rejected `SQLITE_STATIC` surface was
removed after identifying unsafe lifetime behavior.

Production-volume, five-repetition A/B over the direct Buffer path:

| Workload        | Buffer plus CAST | Native transient | Change |
| --------------- | ---------------: | ---------------: | -----: |
| Email 6.83 GB   |          8.163 s |          7.003 s | -14.2% |
| imports 2.75 GB |          4.761 s |          4.673 s |  -1.8% |

The method currently exists only as a local pnpm patch. It cannot ship until a
new `@rocicorp/zero-sqlite3` version and matching platform prebuilds are
published.

Primary evidence:

- `results/native-binding-production-factorial-docker-summary.json`
- `results/native-text-imports-production-docker-summary.json`
- `patches/@rocicorp__zero-sqlite3@1.1.2.patch` in the research worktree

### Adaptive Eager Secondary Indexes

Building indexes after writing a multi-gigabyte SQLite table can dominate total
initial-sync time. Creating an index while the table is empty is cheap, but
maintaining it during insertion can regress narrow/high-row-count tables.

The candidate uses estimated average row width from
`pg_table_size / reltuples`. Tables estimated at 2 KiB or wider get secondary
indexes before COPY. Primary indexes remain deferred. Narrow or unknown tables
defer all indexes.

Wide-table strategy evidence:

| Workload       | Deferred | All eager | Change |
| -------------- | -------: | --------: | -----: |
| Email 683 MB   |  0.732 s |   0.602 s | -17.8% |
| imports 550 MB |  1.032 s |   0.969 s |  -6.1% |

Leaving primary indexes deferred improved over making every index eager:

| Workload       | All eager | Secondary eager | Change |
| -------------- | --------: | --------------: | -----: |
| Email 683 MB   |   0.789 s |         0.674 s | -14.5% |
| imports 550 MB |   1.047 s |         1.019 s |  -2.7% |

Narrow-table evidence shows why the policy must be adaptive:

| Workload       | Deferred | Secondary eager | Change |
| -------------- | -------: | --------------: | -----: |
| Email narrow   |  1.645 s |         1.715 s |  +4.2% |
| imports narrow |  0.655 s |         0.903 s | +37.9% |

There is no clean same-stage adaptive-versus-parent A/B. The strategy evidence
is compelling, but the 2 KiB selector remains an operational heuristic that
must be validated around stale and threshold-adjacent PostgreSQL estimates.

Primary evidence:

- `results/eager-index-scaled-docker-summary.json`
- `results/secondary-index-scaled-docker-summary.json`
- `results/adaptive-index-narrow-docker-summary.json`
- `results/adaptive-index-validation-docker-summary.json`

### Batched COPY Metrics

The candidate accumulates COPY bytes and chunk count and updates OTel counters
once per 8 MiB rather than once per destination chunk.

The closest five-repetition comparison reported:

| Workload       | Per-chunk metrics | Batched metrics | Change |
| -------------- | ----------------: | --------------: | -----: |
| Email 683 MB   |           0.674 s |         0.584 s | -13.4% |
| imports 550 MB |           1.019 s |         0.975 s |  -4.3% |

This was a cross-stage comparison without a same-image control, and the
benchmark did not initialize a production-like active OTel provider. Treat the
numbers as exploratory only. The change still has a strong low-risk rationale:
preserve metric totals while reducing API calls.

Primary evidence:

- `results/secondary-index-scaled-docker-summary.json`
- `results/batched-metrics-scaled-docker-summary.json`
- `results/batched-metrics-production-smoke-docker-summary.json`

### Source And Processing Telemetry

After the frozen candidate, the research branch added unconditional table-level
`sourceWaitMs` and `processingMs` fields for binary and text COPY. The fields
are emitted once in the existing table-completion log.

- `processingMs` includes parser, decoding, bookkeeping, SQLite statements,
  metric work, and final flush.
- `sourceWaitMs` is residual stream wall time outside synchronous destination
  callbacks.
- `sourceWaitMs` is not a pure PostgreSQL or network measurement and can include
  event-loop contention from concurrent table copies.

Three production-volume repetitions on the telemetry-enabled image reported:

| Workload | Source wait | Processing | SQLite flush | Non-flush processing |
| -------- | ----------: | ---------: | -----------: | -------------------: |
| Email    |     2.229 s |    5.507 s |      5.077 s |              0.430 s |
| imports  |     2.567 s |    2.318 s |      2.103 s |              0.215 s |

The telemetry-enabled image was 7-8% slower than the frozen image, but it was a
separate build with materially different SQLite flush time. That is not an
overhead A/B. A clean parent/head telemetry benchmark remains mandatory.

Primary evidence:

- `results/final-native-telemetry-smoke-docker.json`
- `results/final-native-telemetry-smoke-docker-summary.json`

## Correctness And Verification Completed

Frozen and post-telemetry candidate runs retained exact row counts, COPY byte
counts, SQLite file sizes, and sampled payload hashes.

Expected sample payloads:

- Email: 683,000 bytes and SHA-256
  `fd5b0b65dcb6b2a54f610ca274905198d96dcbbc1c1ad59bbb18e42f8cf43afd`
- imports: 275,000 bytes and SHA-256
  `67a34865811c799e84a608593dd6270bfd659fdec0746aa58ff3b4245c0888fd`

Final local verification on the research worktree:

- `zero-cache` no-PostgreSQL suite: 96 files and 1,482 tests passed.
- Focused parser suite: 83 tests passed.
- zqlite suite: 12 files and 192 tests passed.
- PostgreSQL 17 initial-sync suite: 47 passed and 1 skipped.
- `zero-cache` and zqlite TypeScript checks passed.
- Mono `oxfmt`, zero-docs Prettier, and `git diff --check` passed.
- Six post-telemetry full-volume runs retained expected rows and payload hashes.

Important limitations:

- Payload verification samples three rows, and the exploratory fixture repeats
  the same payload. It is not whole-table verification.
- The origin baseline predates payload sample hashes.
- The native package was rebuilt from patched source locally and in the Docker
  benchmark. Published prebuilt-package behavior has not been validated.
- PostgreSQL 15, 16, and 18 were not rerun after the final telemetry changes.

## Why Controlled Per-PR Execution Is Required

### Mutable Provenance

- The installer checked only worktree `HEAD`, not dirty tracked files, untracked
  patches, or exact source tree hashes.
- Candidate image IDs changed between stages while retaining the same worktree
  label.
- Early manifests omitted image IDs.
- The Docker build used mutable package and base-image inputs.
- The exploratory evidence directory in zero-docs is currently untracked and
  its raw data/results are ignored.

### Treatment Isolation

- The final candidate comparison bundles parser, metrics, text binding, native
  binding, and index policy.
- Batched metrics never had a contemporaneous unbatched arm.
- Final telemetry never had a contemporaneous timing-off arm.
- Native binding had a good same-image factorial, but it ran on top of the
  already modified stack.
- Adaptive validation proved policy selection but did not compare adaptive,
  deferred, and eager strategies in one block.

### Run Ordering And Warming

- The current two-arm scheduler can repeatedly run control before treatment.
- The field-pool experiment demonstrated the bias: unpaired medians suggested a
  5.1% win while repetition-paired callback ratios showed a 0.94% regression.
- Every application run executes raw COPY before initial sync, implicitly
  warming PostgreSQL.
- All arms share one long-lived Postgres container, so source cache and
  checkpoint state evolve during a stage.

### Statistical Problems

- Parser aggregation treats in-process iterations as independent experiments.
- Three- and five-run p95 values are interpolation near the maximum, not tail
  estimates.
- Existing summaries lack confidence intervals and robust paired dispersion.
- Email had a severe valid outlier: 15.696 seconds versus 6.164 and 7.673
  seconds, with substantially more GC work.

### Fixture And Correctness Problems

- The large fixture repeats one highly compressible ASCII payload.
- Three sampled rows therefore have identical hashes.
- COPY byte validation allowed a 2% tolerance.
- Aggregation did not reconcile logs against the full manifest or reject stale
  files.
- The fixture has one dominant table rather than production-like table and
  index counts.
- Raw COPY does not pass through the same shaping transform as initial sync.

## Common Benchmark Contract For Product PRs

Every product PR in this plan must use the same protocol. There is no standalone
orchestration-tooling PR. When preparing each product PR description, the author
will manually orchestrate the parent/head builds and paired runs with the
canonical mono benchmark commands, capture provenance, alternate `AB`/`BA`, and
generate the report from manually retained artifacts. Benchmark source owns only
profile selection, fixture setup, lightweight correctness checks, and normal mono
benchmark output through `BENCH_OUTPUT_FORMAT=json`. "Manual" means refs, SHAs,
images, resource constraints, pairing, and analysis are recorded outside the
benchmark source and output; it does not relax the review rules below.

### Canonical Fixture Baseline

[Mono PR #6235](https://github.com/rocicorp/mono/pull/6235) is the original
benchmark and fixture baseline for every later PR in this plan. Its exact
benchmark head is `39d42eff905a73ca8ac4a423c873615a0ba71246`, and its first
absolute local results are frozen in
`pr1-initial-sync-benchmark-fixtures.md`.

Every later mono performance PR description must:

- Include an explicit `Original benchmark` link to
  [PR #6235](https://github.com/rocicorp/mono/pull/6235).
- Preserve the same Binary COPY and initial-sync table columns shown below, with
  one additional cumulative-speedup column linked to PR #6235.
- Rerun the exact #6235 benchmark commit in the same measured environment as the
  PR head. Do not calculate cumulative speedup by dividing a current result by
  the historical M5 Pro values in the PR or frozen report.
- Calculate cumulative speedup from median throughput as
  `(head median MiB/s / #6235 median MiB/s - 1) * 100%` for the identical
  profile. Use `n/a` when the profile did not exist in #6235 or was not run.
- Continue reporting the direct parent/head paired comparison required by the
  common contract. The cumulative #6235 comparison shows stack progress; it
  does not establish the marginal effect of the current PR.
- State in prose that Binary COPY cases use at least 50 samples and two measured
  seconds and initial-sync cases use ten measured repetitions plus one warmup.
  Do not add `Measurement` or `Samples` columns to the tables.

Binary COPY table format for later PR descriptions:

| Profile     | Field bytes | COPY chunk bytes |   Columns |      Rows | Median MiB/s | Average MiB/s | Cumulative speedup vs [#6235](https://github.com/rocicorp/mono/pull/6235) |
| ----------- | ----------: | ---------------: | --------: | --------: | -----------: | ------------: | ------------------------------------------------------------------------: |
| `<profile>` |   `<bytes>` |        `<bytes>` | `<count>` | `<count>` |    `<value>` |     `<value>` |                                                               `<percent>` |

Initial-sync table format for later PR descriptions:

| Profile     |      Rows | Payload MB (decimal) | Median MiB/s | Average MiB/s | Median elapsed | Average elapsed | Cumulative speedup vs [#6235](https://github.com/rocicorp/mono/pull/6235) |
| ----------- | --------: | -------------------: | -----------: | ------------: | -------------: | --------------: | ------------------------------------------------------------------------: |
| `<profile>` | `<count>` |            `<value>` |    `<value>` |     `<value>` |   `<duration>` |    `<duration>` |                                                               `<percent>` |

PR 2 uses #6235 for workload shape and volume calibration but does not report a
cumulative Zero speedup because it changes zmail's seed and canary surface, not
Zero's initial-sync implementation.

### Manual Preparation And Acceptance

- Write down the exact parent SHA, head SHA, profiles, primary metric, practical
  significance threshold, source-cache policy, warmup count, measured pair
  count, order seed, and invalid-run rules before measured execution.
- Build each clean ref once, save immutable image digests and source/config
  hashes, and execute one discarded warmup block followed by at least 10
  measured pairs per profile.
- Schedule balanced deterministic `AB`/`BA` order manually. Do not choose order,
  rerun policy, or exclusions after looking at performance results.
- Save raw `BENCH_OUTPUT_FORMAT=json` output, logs, manually captured
  cgroup/host diagnostics, and relevant test output in a unique immutable
  artifact directory. A spreadsheet or one-off analysis command is acceptable
  only when its formulas or command, inputs, and output are retained with the
  report.
- Put the exact commands, provenance, every valid run and pair ratio, robust
  summary, bootstrap interval, raw-control result, correctness result, and
  artifact checksum/link in the PR description.
- The comparison is accepted only when another reviewer can reconcile every
  reported run to the preregistration and artifacts, and all correctness and
  performance gates below pass. Missing provenance, unbalanced ordering,
  unexplained exclusions, or stale/mismatched artifacts invalidate the report.

### Manual Provenance

- Compare exact clean parent and PR-head SHAs.
- Build both images once and identify them by immutable digest.
- Record Git tree hashes, benchmark/config hashes, lockfile hash, native patch or
  package version, Node and pnpm versions, architecture, kernel, Docker version,
  base-image digest, and Postgres image digest.
- Reject dirty or untracked product files.
- Store each invocation's standard benchmark JSON and externally captured
  diagnostics in a distinct manual artifact directory. These paths and
  provenance notes are PR-preparation conventions, not benchmark inputs.

### Scheduling

- Run one discarded warmup block.
- Run at least 10 independent measured parent/head pairs per profile.
- Alternate deterministic `AB` and `BA` order with a recorded seed.
- Use a fresh application container and SQLite file for every arm.
- Give paired arms independent clones of the same post-fixture PostgreSQL state;
  never point parent and head at one live source database.
- Declare warm-source or cold-source behavior explicitly and apply it equally.

### Metrics

- Primary metric: paired initial-sync callback time or generated-payload MB/s.
- Attribution metrics: dominant-table elapsed, source wait, processing, flush,
  index, user/system CPU, event-loop utilization, GC, peak RSS, cgroup memory
  events, PSI, and I/O.
- Measure unshaped raw COPY and raw COPY through the same shaping transform.
- Treat raw COPY as a covariate and validity signal, not a correction oracle.
- If parent/head raw controls differ materially, run a preregistered second
  block and report the result as inconclusive if imbalance remains.

### Statistics

- Treat process/container pairs as the experimental unit.
- Report every valid run and pair ratio.
- Report median, MAD or range, geometric mean ratio, and a bootstrap 95%
  interval over paired log ratios.
- Do not report p95/p99 from normal 10-pair PR runs.
- A tail claim needs approximately 50 or more independent process runs and its
  own confidence interval.
- Never remove a valid slow run merely because GC, I/O, or memory pressure was
  high.

### Correctness

- Benchmark-owned checks are limited to exact per-table row counts,
  deterministic first/middle/last samples, and expected final index names/counts
  for the selected profile.
- Exhaustive data, schema, parser, type-affinity, and malformed-input correctness
  belongs in ordinary tests or in the product PR that changes those semantics,
  not in every timed benchmark repetition.
- A benchmark invocation fails on a nonzero exit or failed lightweight fixture
  check. The manually prepared comparison is invalid on OOM, missing required
  externally captured resource data, stale/mixed artifacts, or failed relevant
  ordinary tests.

### Default Gates

- Correctness has zero tolerance.
- A no-regression lane should have median slowdown no greater than 2% and an
  upper 95% confidence bound below 3%.
- A performance claim should have a preregistered practically meaningful gain,
  normally at least 5%, with the interval above parity.
- If the data cannot distinguish a small gain from environmental variation,
  report reduced work or improved complexity without claiming faster initial
  sync.

## PR Sequence

### PR 1: Durable Benchmark Fixtures And Correctness

**Repository:** mono
**Risk:** benchmark-only

Build on the existing durable benchmark rather than copying executable files
from zero-docs.

Scope:

- Extend `packages/zero-cache/src/db/initial-sync.bench.pg.ts`.
- Extend `packages/zero-cache/src/test/pg-bench.ts`.
- Retain the current 250,000-row mixed fixture and make it the default durable
  regression lane; do not replace it with a production-shaped selector.
- Add neutral `wide-text-scaled`, `wide-text-full`, `large-payload-scaled`,
  `large-payload-full`, `wide-text-narrow`, and `large-payload-narrow` profiles.
- Add a durable binary COPY parser benchmark under `packages/zero-cache/src/db`
  with contained 4 KiB/31 KiB and fragmented 270 KiB/5.5 KiB, 683 KiB/31 KiB,
  and 683 KiB/5.5 KiB cases.
- Use neutral executable table, column, index, and profile names in mono, such as
  `wide_text_rows`, `large_payload_rows`, `group_id`, and `scope_id`. Do not copy
  customer table names, tenant terminology, or identifiers into executable
  fixtures. zero-docs retains the mapping from these neutral shapes to the PL
  Email and Margins imports production calibration.
- Keep scaled/full and narrow profiles manual/on-demand so the mixed 250,000-row
  default remains appropriate for the ordinary mono benchmark suite.
- Make benchmark rechunking benchmark-local and unset by default.
- Add lightweight benchmark validation: exact per-table row counts,
  deterministic first/middle/last sample checks, and expected final index
  name/count checks.
- Use normal mono `BENCH_OUTPUT_FORMAT=json`; do not add a custom result or
  provenance schema.

Explicit PR 1 deferrals:

- Defer threshold-boundary and production-topology table/index matrices to PR 7,
  where adaptive index policy needs them.
- Defer Unicode, JSON/JSONB, null, empty, and SQLite text-affinity fixture
  expansion to PR 6, where direct Buffer plus CAST needs those semantics.
- Do not add an explicit incompressible source-storage I/O profile until a
  product PR preregisters a claim that depends on source compression/storage
  behavior.

#### Benchmark Inputs And Output

- `ZERO_INITIAL_SYNC_BENCH_PROFILE` selects the initial-sync fixture. Unset or
  `mixed` uses the existing 250,000-row default. Other accepted values are
  `wide-text-scaled`, `wide-text-full`, `large-payload-scaled`,
  `large-payload-full`, `wide-text-narrow`, and `large-payload-narrow`.
- `ZERO_PG_COPY_BENCH_PROFILE` selects the durable parser case. Accepted values
  are `contained-4k-31k`, `fragmented-270k-5.5k`,
  `fragmented-683k-31k`, and `fragmented-683k-5.5k`.
- When `ZERO_PG_COPY_BENCH_PROFILE` is unset, use `contained-4k-31k` as the
  parser benchmark default.
- Reject unknown profile values and print the selected profile in ordinary
  benchmark output. Keep both variables benchmark-only and unset by default; do
  not expose them through production options.
- Use the existing mono recorder with `BENCH_OUTPUT_FORMAT=json`; add no custom
  orchestration metadata, result/provenance format, artifact writer, resource
  capture, or container support to benchmark source.
- Refs, clean SHAs, image digests, cgroup limits and diagnostics, source clone
  setup, warmups, `AB`/`BA` order, pairing, raw artifact capture, statistics, and
  report generation remain higher-level manual work performed while preparing
  each PR description. Do not add a standalone paired runner PR.

#### Benchmark Correctness Boundary

- Before accepting a timed result, verify exact row counts for every fixture
  table, deterministic expected values for first/middle/last rows, and the final
  expected index names/counts.
- Do not stream and hash the whole fixture, duplicate exhaustive schema/index
  contracts in the benchmark, run `PRAGMA integrity_check` per repetition, add
  custom result-schema versions, or add benchmark-validator corruption tests.
- Keep exhaustive fixture data/schema correctness and parser malformed-input,
  truncation, ownership, and partition tests in ordinary test files. PR 6 owns
  expanded Unicode/JSON/null/text-affinity correctness, and PR 7 owns
  threshold/topology correctness.

Do not introduce production feature flags or exported `experimental` options.

Acceptance:

- Current unoptimized initial sync passes the lightweight checks for the mixed
  default and all six neutral production-shaped selectors; all durable parser
  cases execute and the ordinary parser tests pass.
- The unchanged mixed 250,000-row lane is still the default and its ordinary
  runtime remains appropriate for the existing mono suite.
- `wide-text-full` and `large-payload-full` can be selected explicitly and
  reproduce expected table counts, deterministic samples, and final index
  names/counts.
- Both environment variables reject unknown values, and
  `BENCH_OUTPUT_FORMAT=json` emits normal mono JSON for every accepted profile.
- PR 1 adds no custom orchestration metadata/output or parent/head tooling.

Suggested branch: `0xcadams/initial-sync-benchmark-fixtures`

The first absolute local baseline for the implemented PR 1 fixture shapes is frozen
in `pr1-initial-sync-benchmark-fixtures.md`. It records the exact mono commit,
host/toolchain, benchmark commands, raw initial-sync recorder output, MiB/s
conversions, verification status, and the one-warmup/ten-measurement run count
used by every initial-sync profile. Treat it as a fixture smoke/comparison
anchor, not a controlled parent/head performance claim.

Original benchmark PR:
[rocicorp/mono#6235](https://github.com/rocicorp/mono/pull/6235).

### PR 2: Make Normal zmail Seeds Initial-Sync Representative

**Repository:** zmail
**Risk:** medium operational risk; schema and multi-gigabyte fixture, no runtime
inbox code change intended
**Calibration baseline:**
[mono PR #6235](https://github.com/rocicorp/mono/pull/6235)
**Depends on:** no code dependency; use #6235's shape and volume calibration and
merge before staging validation of PR 3 or later

This PR makes zmail a realistic deployment canary without turning it into a
second benchmark harness. Keep the existing normalized application model and
add a synthetic table that exists solely to exercise initial sync. Normal inbox
queries do not select it, but every normal seed populates it from the same
generated emails and in the same transaction path as the application tables.
Do not add the wide-row work to the shared runtime generator used by the web
cron.

#### Data Shape

- Add a Drizzle table named `initialSyncEmail` backed by
  `initial_sync_email`. Give it exactly 25 email-shaped columns: the 19 fields
  already used by `email_metadata`, plus `attachments`, `html_content`, `raw`,
  `text_content`, `image_urls`, and `headers`.
- Make `attachments`, `html_content`, `raw`, and `text_content` the dominant
  variable-width text fields. Reuse zmail's existing generated HTML and plain
  text, and generate deterministic varied MIME-like raw text and synthetic
  attachment JSON text. Keep `image_urls` and `headers` as smaller JSONB fields.
- Put all large fields and indexes on this one table. This is deliberate: the
  existing application's one-to-one `email_metadata`/`email_content` split is a
  good product model but does not reproduce a wide indexed table during COPY.
- Production PL calibration has four indexes total. The zmail canary
  intentionally has five physical indexes: a Zero/drizzle-zero compatibility
  primary key on `id`, plus four production-analog secondary indexes. The
  compatibility primary key is a known canary-shape deviation and is not counted
  among the four production analogs.
- Define the four secondary shapes as unique `(message_id)`,
  `(thread_id, received_at, id)`, `(thread_id, id)`, and `(mailbox, id)`.
  `message_id` is zmail's nonredundant unique-identifier analog; do not add a
  redundant unique secondary index on primary-key column `id`. `received_at` is
  zmail's chronology equivalent of PL's `createdAt`, and `mailbox` is the
  existing zmail scope equivalent of `workspaceId`; do not add fake workspace
  semantics to the app.
- Use one fixed generator version, seed, timestamp, and size distribution for
  every seed count. Vary field sizes and content by row, distribute bytes across
  all four large fields, include deterministic null/empty and Unicode cases
  where the schema permits them, and avoid a single repeated compressible
  payload.
- Calibrate generated rows so PostgreSQL's actual binary COPY stream for the
  dominant table is about 68.3 MB, 683 MB, and 6.83 GB for the smoke, scaled,
  and 10,000-row seed counts. Freeze exact row counts, COPY byte counts,
  per-field byte totals, and whole-fixture digests in a small calibration
  manifest; do not check generated payloads or database dumps into Git.

#### Likely zmail Changes

- `packages/db/src/schema.ts`: define the synthetic table, primary key, and four
  secondary indexes. Do not declare the completion marker in this Drizzle schema.
- `packages/db/drizzle/<next-migration>.sql` and
  `packages/db/drizzle/meta/*`: generate the public fixture migration/snapshot,
  then add hand-written SQL in that migration to create private schema
  `zmail_seed` and `zmail_seed.seed_completion`. Access the marker only through
  raw `pg` SQL; keep it outside drizzle-zero's input and generated client schema.
- `packages/zero/src/schema.ts`: regenerate client/query schema metadata for the
  table. This does not add the table to a PostgreSQL publication.
- `packages/shared/src/seed/index.ts`: keep `generateSeedEmailBatch`, its current
  `sizeBuckets`, append behavior, and return type unchanged. The
  `/api/add-emails` route uses this shared runtime path and must never allocate
  the representative wide fields.
- `scripts/seed/initial-sync.ts`: add the seed-command-only deterministic
  wide-row builder. It consumes each normal seed batch's metadata/content,
  derives raw/attachment fields with a versioned per-row PRNG keyed by email ID,
  and preserves the existing app rows while calibrating the synthetic table to
  the target distribution independently of `BATCH_SIZE`.
- `packages/db/src/seed.ts`: keep `insertSeedEmailBatch` as the app/cron-only
  insert contract. Add a normal-seed composition function that inserts contacts,
  metadata, content, and matching synthetic rows in one per-batch transaction.
- `packages/db/src/index.ts`: let the seed command own and close its PostgreSQL
  pool/client instead of returning only an unclosable Drizzle handle.
- `scripts/seed/index.ts`: keep `pnpm seed` as the only seed path, change the
  default `EMAIL_COUNT` from 10,000 to 100, validate `EMAIL_COUNT` in the range
  1-10,000, use a conservative default `BATCH_SIZE` such as 16, cap configured
  batches at a measured safe maximum, pass one fixed timestamp to the existing
  app generator, invoke the seed-only wide-row builder unconditionally, and emit
  a machine-readable manifest.
- `apps/web/src/routes/api/add-emails.ts` and a focused route test:
  preserve the current 22-row append behavior and prove the cron neither invokes
  the seed-only builder nor inserts `initial_sync_email`, including when the
  currently commented app-email insert is restored.
- `scripts/seed/verify.ts` and `scripts/seed/package.json`: stream and verify
  exact upstream/replica row content, schema, indexes, and seed provenance. Add
  direct pinned dependencies on `pg`, `pg-copy-streams`,
  `@rocicorp/zero-sqlite3`, and an RFC 8785 JSON canonicalizer rather than
  relying on packages transitively installed by Zero or Drizzle; declare the
  corresponding TypeScript type packages where the libraries do not ship types.
- `package.json`: add only the verification entry point needed by staging; do
  not add alternate seed commands. Add
  `"test": "pnpm --filter @zmail/web test && pnpm --filter @zmail/db test && pnpm --filter @zmail/seed test"`.
- `apps/web/package.json`, `packages/db/package.json`, and
  `scripts/seed/package.json`: use the minimal existing toolchain by adding
  `node --import tsx --test <explicit-test-files>` scripts. Add `tsx` and
  `@types/node` to package dev dependencies where they are not already declared;
  do not introduce Vitest.
- `apps/web/src/routes/api/add-emails.test.ts`: inject/spies the route's app-email
  generator and insert dependencies, assert exactly 22 append rows, and assert
  the insert receives only the unchanged app batch. Also assert `@zmail/web` has
  no dependency/import path to the private `@zmail/seed` package that owns the
  wide-row builder.
- `packages/db/src/seed.test.ts`: against a fresh migrated PostgreSQL test DB,
  prove `insertSeedEmailBatch` inserts only contacts/metadata/content and never
  `initial_sync_email`, while the normal-seed composition explicitly inserts the
  matching wide rows in its per-batch transaction.
- `scripts/seed/initial-sync.test.ts` and `scripts/seed/session.test.ts`: cover
  deterministic prefix/batch-size behavior, lock/cleanup/marker ordering, and
  injected partial failures using the same local PostgreSQL 18 setup as
  migrations.
- `README.md`: document commands, sizes, disk/time expectations, destructive
  operations, the existing `EMAIL_COUNT`/`BATCH_SIZE` controls, and the
  no-customer-data rule.
- `pnpm-lock.yaml`: record the verifier's declared PostgreSQL/COPY, SQLite, and
  JSON canonicalization dependencies, native package version, and package-local
  `tsx`/Node test dependencies.
- External zmail staging deployment configuration: pin zero-cache image digest,
  give its container 1 CPU and 3 GiB memory, provide sufficient local storage,
  and expose logs/metrics. No such configuration is currently checked into
  zmail; do not pretend `apps/web/vercel.json` or the Postgres-only
  `docker-compose.yml` controls it.

Do not change inbox query definitions, the web UI, or the current application
tables merely to make the fixture look more like PL Email.

#### Schema And Publication Sequencing

Generated Zero schema and PostgreSQL publication membership are separate
controls. The plan must validate both:

- When the external deployment leaves `ZERO_APP_PUBLICATIONS` unspecified or
  empty, Zero creates an internal publication equivalent to
  `CREATE PUBLICATION _{app-id}_public_0 FOR TABLES IN SCHEMA public`; a fixture
  table already present in `public` is included by that all-public-schema
  behavior, while private `zmail_seed.seed_completion` is excluded.
- With custom `ZERO_APP_PUBLICATIONS`, prefer a dedicated publication such as
  `zmail_initial_sync_fixture` containing only
  `public.initial_sync_email`, and include it in the configured publication list.
  Every other configured publication must exclude the fixture.
- Resolve the effective publication names from configured
  `ZERO_APP_PUBLICATIONS` or the created internal app publication, then preflight
  the shape by joining those names to `pg_publication_tables`. Require exactly
  one membership row for
  `public.initial_sync_email`, `rowfilter IS NULL`, and `attnames` equal to all 25
  physical columns with no missing, duplicate, or extra name: `id`, `mailbox`,
  `category`, `thread_id`, `message_id`, `from_email`, `to_email`, `subject`,
  `preview`, `received_at`, `sent_at`, `is_read`, `read_at`, `is_starred`,
  `starred_at`, `body_size_bytes`, `content_sha256`, `created_at`, `updated_at`,
  `attachments`, `html_content`, `raw`, `text_content`, `image_urls`, and
  `headers`.
- Fail if the fixture appears in more than one configured publication, even when
  both memberships are full and unfiltered. In particular, fail if any other
  membership has a row filter or column subset rather than assuming the full
  membership overrides it.
- Inspect `pg_publication.puballtables` and `pg_publication_namespace` before any
  DDL. `FOR ALL TABLES` and `FOR TABLES IN SCHEMA` memberships update
  automatically and must never receive `ALTER PUBLICATION ... ADD TABLE`.
  A custom `FOR ALL TABLES` publication also includes tables in private
  `zmail_seed`; reject it for this design and replace/reconfigure it before
  rollout. For an owned explicit-table publication only, add the fixture with an
  explicitly quoted `ALTER PUBLICATION ... ADD TABLE` when absent, then rerun the
  entire shape/duplicate preflight.
- Require the generated Zero schema to contain `initialSyncEmail` but no
  `seedCompletion`, `zmail_seed`, or equivalent marker table. Also query all
  configured publications to prove `zmail_seed.seed_completion` is not
  effectively published.
- Changing publication membership or the configured publication set requires a
  replica resync. Do not apply the DDL or seed while an existing Zero is running:
  it could observe the new table empty or partially seeded and backfill an
  invalid fixture.
- For a fresh staging dataset, stop/decommission Zero first, apply the additive
  database migration, configure/verify custom publication membership if used,
  run the complete normal seed job, verify it, write the completion marker, and
  only then snapshot the pre-Zero source for arm clones. Start each arm with a
  fresh app/replica after the clone exists.
- For rollout to an existing zmail stack, use a maintenance window or a new app
  ID: stop the old Zero and seed job, apply migration/publication changes, finish
  and verify seeding, then deliberately wipe/resync before restarting. The
  previous web app remains compatible because it does not query the additive
  table; verify that compatibility before advancing the app deployment.

#### Seed Session And Failure Handling

- The seed command owns one dedicated PostgreSQL session for its entire
  lifecycle. Acquire a fixed `pg_advisory_lock` on that session before inspecting
  or writing seed state; never acquire a session-scoped lock through arbitrary
  pooled queries.
- Immediately after acquiring the lock, delete/invalidate any prior
  `zmail_seed.seed_completion` row in its own committed transaction. Do not begin
  generation until that commit succeeds, so a failed rerun cannot leave a stale
  successful marker claiming the partially overwritten database is valid.
- Use one bounded transaction per batch on that same session. Commit completed
  batches so the process does not retain a multi-gigabyte transaction, but keep
  the advisory lock until all batches and upstream verification finish.
- After the final batch, stream the entire upstream fixture, verify exact count,
  bytes, schema, indexes, and digest, and only then commit the completion marker.
  A row-count-only or "last batch inserted" marker is insufficient.
- Put unlock, client release, and pool close in `finally`. Replace the current
  immediate `process.exit()` calls with exit-code/error propagation so cleanup
  always runs. Verify `pg_advisory_unlock` succeeds before releasing the client.
- On any generation, insert, verification, lock, or marker failure, leave no
  completion marker and classify the database as unusable. Do not resume from
  committed batches or truncate selected rows; fully recreate the local/staging
  database from migrations and seed it again.
- Add a regression test that completes one successful seed, starts a rerun,
  injects failure after at least one committed batch, and proves the previous
  marker was already removed and no valid marker remains.

#### Safety Constraints

- Every `pnpm seed` invocation uses the representative distribution and creates
  one `initial_sync_email` row per app email. The same generator and command are
  used for local development and staging.
- Keep local development practical through the existing `EMAIL_COUNT` control:
  default to 100 rows, use 1,000 for routine staging, and permit at most 10,000
  without a reviewed code change. Scaling changes cardinality, never row shape.
- Generate in bounded batches using the existing `BATCH_SIZE` control. Reject
  zero, negative, non-integer, or unsafe values and cap batches well below the
  current 500-row default. Never hold a 6.83 GB dataset or hundreds of megabytes
  of row objects in memory.
- Acquire an advisory lock, print the target database host/name and projected
  bytes before writing, and refuse destructive reset/truncate operations unless
  separately confirmed. Measured staging runs start from a fresh database so a
  prior larger seed cannot leave extra rows when cardinality is reduced.
- Preflight free database, WAL, replica, and temporary storage. Use an isolated
  staging database with enough headroom for PostgreSQL data and WAL plus the
  fresh Zero replica; the production fingerprint used 200 GiB ephemeral
  storage, not a 6.83 GB volume.
- Use generated `.example` senders and synthetic content. The existing fixed
  Rocicorp demo recipient `zero@rocicorp.dev` is permitted and need not be
  changed; no other real address is allowed. Do not accept a dump path,
  production database URL, sampled customer value, or customer identifier as
  seed input.
- Freeze application writes before snapshotting so baseline and candidate clones
  contain the same upstream state. Keep the clones independent and keep staging
  credentials out of manifests and logs.
- If the staging platform cannot enforce 1 CPU/3 GiB, record the actual limits
  and classify the run as functional only, not PL-resource-calibrated.

#### Canonical Verifier

- Use declared `pg`/`pg-copy-streams` dependencies to stream PostgreSQL rows and
  count the exact bytes from a fixed-column, primary-key-ordered
  `COPY (SELECT ...) TO STDOUT (FORMAT binary)`. Use the directly declared,
  Zero-matched `@rocicorp/zero-sqlite3` package to stream the stopped replica in
  the same primary-key order; do not download rows through a browser or depend
  on a transitive native module.
- Define a versioned cross-database row encoding. Prefix the schema/version and
  ordered column list; encode each value as a one-byte semantic type tag, an
  unsigned big-endian byte length, and payload, with explicit row boundaries.
  Encode null with its own tag and zero payload, text as UTF-8, integers as
  canonical base-10, booleans as `0`/`1`, enums as tagged UTF-8 enum values,
  timestamps as UTC Unix microseconds, and JSON as UTF-8 RFC 8785 canonical JSON.
  Hash every relevant column and row with SHA-256; do not compare driver-native
  stringification.
- Normalize PostgreSQL `timestamp without time zone` explicitly as UTC in SQL so
  PostgreSQL dates and Zero's numeric SQLite timestamps encode identically.
  Parse JSON on both sides before canonicalization and preserve array order.
- Pin the PostgreSQL 18 image by digest and create the template database with a
  fixed `C.UTF-8` locale and UTF-8 encoding. Run seed/COPY sessions with `TZ=UTC`,
  `TimeZone=UTC`, `client_encoding=UTF8`, `DateStyle=ISO,YMD`,
  `IntervalStyle=iso_8601`, `extra_float_digits=3`, and
  `standard_conforming_strings=on`. Record server version, encoding, collation,
  and SQLite/native package versions in the manifest.
- After initial sync completes, stop Zero cleanly, list the replica base file and
  any existing `-wal`, `-wal2`, and `-shm` sidecars, and record each path, size,
  and SHA-256. Capture the stopped replica atomically as a filesystem/volume
  snapshot or by moving its containing directory; never copy sidecars one at a
  time while state can change. Re-list and checksum the captured artifact before
  opening it. Reject the run if the base file is absent or any sidecar observed
  after shutdown is missing or changed in the artifact. Verification must be
  streaming and bounded-memory at 6.83 GB.

#### zmail Test Mechanism

Use Node's built-in `node:test` and `node:assert/strict` through the repository's
existing `tsx`; do not add Vitest for this PR.

- Add `"test": "node --import tsx --test src/routes/api/add-emails.test.ts"`
  to `apps/web/package.json`,
  `"test": "node --import tsx --test src/seed.test.ts"` to
  `packages/db/package.json`, and an explicit
  `node --import tsx --test initial-sync.test.ts session.test.ts` command to
  `scripts/seed/package.json`.
- Use the root `pnpm --filter @zmail/web test && pnpm --filter @zmail/db test && pnpm --filter @zmail/seed test`
  command to invoke those package scripts in a fixed order. Declare `tsx` and
  Node types in each package that directly runs tests; update the lockfile.
- Extract the cron handler's small operation into an injectable function used by
  the TanStack route. The web test supplies spies for the existing append
  generator and app-only insert function, verifies count 22 and append timing,
  and verifies only the unchanged app batch reaches insertion. Keep the
  seed-only builder private to `@zmail/seed`; a package-boundary assertion fails
  if web dependencies/source imports introduce a path to it.
- The DB contract test creates a unique database from migrations using `PG_URL`,
  calls `insertSeedEmailBatch`, verifies application rows changed while
  `initial_sync_email` did not, then calls the normal-seed composition and
  verifies matching app/wide rows in one transaction. Always drop the test
  database in cleanup.
- Seed-package tests run against the same PostgreSQL 18 test setup and cover
  deterministic wide rows, batch-size invariance, lock/session cleanup, marker
  invalidation, and successful-seed/failed-rerun behavior. No test may use a
  production or shared staging database.

#### Correctness Checks

- Generated-schema check: regenerate `packages/zero/src/schema.ts` and require
  `initialSyncEmail` with all 25 expected mapped columns/server names and primary
  key `id`. Require no generated table or type for `zmail_seed.seed_completion`.
- PostgreSQL check: inspect `pg_index`/`pg_class`/`pg_attribute` and require the
  compatibility primary key `(id)` plus exactly the four intended
  production-analog secondary definitions: unique `(message_id)`,
  `(thread_id, received_at, id)`, `(thread_id, id)`, and `(mailbox, id)`, with
  expected order, uniqueness, access method, and no predicate/expression. Require
  five physical indexes total and no redundant unique `(id)` secondary index.
- SQLite check: inspect the stopped replica with `sqlite_master`,
  `PRAGMA index_list`, and `PRAGMA index_xinfo`; require the mapped primary key
  plus the unique `message_id` and three composite secondary shapes, for five
  physical indexes total. Then run indexed lookups and verify query
  plans/results. Do not assume PostgreSQL and SQLite index names are identical.
- Publication check: run the effective-shape preflight over all configured
  publications. Require exactly one unfiltered membership with the exact 25
  `attnames`, no duplicate/subset membership, and no effective publication of
  `zmail_seed.seed_completion`; test dedicated, default public-schema, duplicate,
  filtered, column-subset, schema, and `FOR ALL TABLES` cases.
- Generate the canonical 100-, 1,000-, and 10,000-row datasets twice, including
  once with a different allowed `BATCH_SIZE`, and require identical row IDs,
  field lengths, per-row content hashes, aggregate digest, and exact binary COPY
  bytes. Require the shorter datasets to be exact prefixes of the longer ones,
  and require the completion marker to match only after full upstream
  verification.
- Stream all relevant columns in primary-key order from PostgreSQL and the
  completed Zero replica. Recompute the length-prefixed whole-row digest rather
  than trusting a copied digest column; require exact equality over every row.
- Verify exact row counts, null/empty distribution, Unicode sentinels, first and
  last IDs, per-large-field bytes, schema types, and replica
  `PRAGMA integrity_check`.
- Run default `pnpm seed`, load and scroll the inbox, open representative HTML
  messages, and prove the 100 synthetic rows have the expected representative
  distribution without changing app behavior.
- Run the specified web and DB `node:test` contracts: `/api/add-emails` generates
  only the established 22 append emails and the app-only insert creates no
  `initial_sync_email` rows, both with insertion disabled as today and with that
  insert path enabled.
- Run the previous released zmail web app against the additive migrated/seeded
  database and confirm its list, detail, and mutation paths remain compatible.
- Run zmail formatting, type checks, migrations from empty, schema regeneration,
  and fixture smoke validation.

#### External Staging Manifest Contract

The baseline and candidate image selections are fields in the external staging
deployment manifest, not zmail environment variables. The owner and location of
that manifest remain unresolved, but it must expose and record these controls per
arm:

- Exact Zero image digest, package/protocol/native versions, app ID, publication
  mode/list, upstream PostgreSQL clone identity/URL, and expected replication
  slot/internal publication identity.
- Dedicated CVR and Change database endpoints/schemas, SQLite replica path and
  volume, Litestream backup URL/prefix/generation, and all restore/backup flags.
- zmail web/query/mutate/public URL configuration, deployed zmail SHA, migration
  and seed job SHA, CPU/memory/ephemeral-storage limits, placement/storage class,
  log/OTel destinations, and run/arm labels.
- Separate values or physically isolated resources for every baseline,
  candidate, and rollback arm. The only intended differences between measured
  arms are Zero image/version and arm identity.

#### Staging Canary Procedure

1. Record zmail SHA, generator version, `EMAIL_COUNT`, `BATCH_SIZE`, PostgreSQL
   image/session settings, host/storage shape, and telemetry configuration. Use
   the default 100 rows first, 1,000 rows for routine canaries, and 10,000 rows
   before merging high-risk initial-sync behavior.
2. With every Zero service stopped, create one fresh PostgreSQL template
   database/instance, apply migrations, configure any custom publication, and
   run the normal seed path exactly once: default `pnpm seed`,
   `EMAIL_COUNT=1000 pnpm seed`, or `EMAIL_COUNT=10000 pnpm seed`. Verify the
   whole upstream dataset and completion marker. No Zero process, slot, internal
   publication, CVR/Change schema, or Litestream backup may exist yet.
3. Freeze the post-seed, pre-Zero template and record its immutable
   snapshot/backup ID and digest. Create independent baseline and candidate
   clones from that state, preferably as separate PostgreSQL instances. Also
   reserve the ability to create a third clean rollback clone. Verify every
   clone has the same seed marker/digest and no inherited Zero slots or metadata.
   Never let both arms connect to one writable PostgreSQL database.
4. Fill the external baseline and candidate manifests with exact image digests
   and isolated state. Each arm gets its own upstream clone, app/publication
   configuration, replication slot/internal publication, CVR database, Change
   database, SQLite replica/volume, Litestream prefix/generation, web deployment
   configuration, and telemetry namespace. Prefer the same app ID on separate
   PostgreSQL instances so logical configuration remains equal without sharing
   state.
5. In the manually preregistered `AB`/`BA` order, provision one arm at 1 CPU/3
   GiB where supported and start it from empty SQLite/CVR/Change/Litestream
   state. Record initial-sync start immediately. For custom publications, run the
   full shape/row-filter/duplicate preflight before start; for default mode, run
   it as soon as Zero creates the internal publication. No timing result is valid
   if that check fails. Record completion, image, source clone, slots, and replica
   identity. Repeat with a newly isolated arm; every repeated run receives fresh
   clones and state rather than a reset shared database.
6. Stop each completed Zero cleanly, run the exact upstream-versus-replica
   verifier, exercise inbox list/detail queries, and retain checksummed Zero
   logs, OTel output, cgroup data, and storage metrics. A completed process
   without exact content validation is a failure.
7. Collect total initial-sync wall time, dominant-table COPY time and bytes,
   source wait, processing, SQLite flush, index phase, chunk count/size, CPU,
   peak RSS, cgroup memory events, PSI, I/O, disk use, WAL growth, Litestream
   backup/restore state, restarts, and OOM events. Mark fields unavailable on the
   baseline rather than synthesizing them. zmail remains deployment validation;
   the manual mono protocol remains the source of performance attribution.
8. After artifact capture, tear down each arm: stop zmail/Zero and seed jobs;
   drop/decommission replication slots, internal/custom test publications, Zero
   upstream metadata schemas, CVR/Change databases or schemas, app deployment
   records, SQLite files/volumes, and Litestream backup prefixes/generations;
   delete temporary backups and PostgreSQL clones; and reclaim WAL/disk. Query
   `pg_replication_slots` and storage/backup listings to prove no arm metadata,
   WAL retention, volumes, or backups remain.
9. On candidate failure, never repoint baseline at the candidate's mutated
   PostgreSQL, CVR/Change stores, replica, or Litestream state. Stop and quarantine
   candidate artifacts, create a clean PostgreSQL clone from the immutable
   post-seed template, deploy the pinned baseline image with wholly new isolated
   state, run initial sync and exact verification, confirm the inbox serves, and
   then perform the teardown above. Never run this procedure against a customer
   stack.

#### zmail PR Rollout And Rollback

- Treat the table/marker migration, generated Zero schema, normal seed job, and
  staging deployment manifest update as one coordinated rollout. Preflight disk
  for source rows, WAL, both arm clones, SQLite replicas, CVR/Change stores, and
  Litestream backups before applying DDL.
- First prove the previous released web app works against the additive migrated
  schema. Stop Zero and scheduled seed/cron writes, apply migration and custom
  publication changes, run the normal seed job to a verified completion marker,
  then start a deliberately fresh Zero app/replica. Do not allow a running Zero
  to process fixture DDL or partial seed batches.
- A failed or interrupted seed job rolls back by recreating the entire database,
  not by continuing from committed batches. A DDL/publication change requires a
  new app or full replica/CVR/Change/Litestream resync before service resumes.
- Application rollback is backward-compatible: redeploy the previous web app
  while leaving the additive table in place, disable the new seed job, and use a
  clean baseline Zero clone/state. This is the first rollback choice because it
  avoids destructive DDL while recovering service.
- Reclaim fixture disk only in a separate stopped/decommissioned operation:
  remove the table from custom publications when applicable, drop the fixture
  and completion-marker DDL, remove slots/Zero metadata/CVR/Change/SQLite and
  Litestream state, reclaim WAL/backups/volumes, and then resync from a clean
  database if the stack is retained. Verify no old app or Zero process references
  the schema before dropping it.

#### Acceptance

- The default local workflow uses the representative generator, creates 100 app
  rows and 100 matching synthetic wide rows, remains practical, and retains
  normal zmail behavior; `/api/add-emails` creates neither wide rows nor wide-row
  allocations.
- The 100-, 1,000-, and 10,000-row datasets use the same deterministic
  distribution, are prefix-consistent, and match their frozen exact calibration
  manifests. The 10,000-row dataset has approximately 6.83 GB of measured
  binary COPY payload in the dominant table.
- Seed locking uses one dedicated session, all pool/lock resources close on
  success and failure, and no completion marker appears before full upstream
  verification. A successful-seed/failed-rerun test proves the old marker is
  committed deleted before batches and remains absent after failure. Injected
  failure requires a full database recreate; resume-in-place is rejected.
- Generated schema has the 25-column table/PK and excludes the marker;
  PostgreSQL and SQLite each have five physical indexes: the known compatibility
  primary-key deviation plus four production-analog secondary shapes. Effective
  publication preflight proves exactly one full unfiltered fixture membership
  and no marker membership. The rollout sequence never exposes an empty/partial
  fixture to a running Zero, and the previous released app passes against the
  additive migrated/seeded database.
- Baseline Zero completes a fresh scaled and full sync under an enforced 1
  CPU/3 GiB limit without OOM, restart, corruption, or missing telemetry. If the
  limit cannot be enforced, staging setup remains incomplete for calibrated
  acceptance.
- Baseline and candidate replicas match PostgreSQL exactly over every fixture
  row and relevant column, all four production-analog secondary index shapes
  exist and answer correctly, integrity checks pass, atomic replica artifacts
  retain/checksum every observed `-wal`, `-wal2`, and `-shm` sidecar, and the
  normal zmail UI/query smoke passes.
- Every arm proves independent post-seed PostgreSQL clone, app/publication/slot,
  CVR/Change, SQLite, Litestream, and deployment state with no cross-arm endpoint
  or volume reuse. Teardown leaves no slot, retained WAL, Zero metadata, clone,
  volume, or backup prefix.
- Candidate staging results are consistent with the product PR's mono result
  and have no unexplained material timing or resource regression. zmail alone
  does not establish a component performance claim; a difference above 5%, an
  OOM/memory event, or a phase inversion blocks rollout pending a controlled
  mono rerun and explanation.
- The rollback procedure returns the staging app to the pinned baseline image
  using a fresh clone of the immutable post-seed template and wholly new Zero
  state; no candidate-mutated database is reused.

#### Unresolved Before Implementation

- Identify the owner and source repository for the actual zmail zero-cache
  staging deployment manifest. That determines how image digests, app IDs,
  publication lists, upstream/CVR/Change endpoints, ephemeral replica volumes,
  Litestream namespaces, 1 CPU/3 GiB limits, and telemetry are configured.
- Determine whether staging uses default all-public behavior or custom
  `ZERO_APP_PUBLICATIONS`, record the actual configured publication names, and
  identify where publication DDL is owned. If custom, confirm the owner can
  provision the preferred dedicated fixture publication or remove overlapping
  schema-wide memberships; `FOR ALL TABLES` is not compatible with the private
  marker design.
- Choose the PostgreSQL template/clone mechanism. Separate instances are
  preferred; if database-level clones on one cluster are unavoidable, prove
  slots, app metadata, WAL retention, credentials, and arm connections cannot
  cross.
- Confirm whether the verifier can read the stopped replica file/volume
  directly. If the platform does not expose it, define a bounded streaming
  verification path that recomputes all content without materializing 6.83 GB
  in the browser or a single Node heap.
- Calibrate the single default distribution and split of the 683 KB average row
  across the four large fields against actual binary COPY output. The 6.83 GB
  10,000-row target is fixed, but the exact per-field distribution should be
  frozen only after measuring the generated shape.
- Determine whether Litestream is enabled in zmail staging and how disposable
  per-arm backup prefixes/generations can be provisioned, listed, and deleted.
  If it is disabled, record that explicitly rather than claiming backup/restore
  coverage. Do not add a fake UI query solely to force table inclusion.
- Confirm the measured safe upper bound for the existing `BATCH_SIZE` setting;
  the plan proposes a default near 16 but should freeze the cap only after
  measuring generator and insert peak memory.

Suggested branch: `0xcadams/representative-email-seed-shape`

Once PR 2 is deployed, every later Zero PR uses zmail after its controlled mono
comparison. PR 3 and PR 4 require smoke and scaled canaries. PR 5 through PR 7
require smoke, scaled, and one full-volume baseline/candidate validation before
rollout. Each of the three native-stack PRs runs the lanes it can affect; PR 8c
must run the 10,000-row seed with the actual published native prebuilds. These
are staging deployment checks, not substitutes for the manual paired mono
report.

### PR 3: Batch COPY Metric Updates

**Repository:** mono
**Risk:** low
**Original benchmark:**
[mono PR #6235](https://github.com/rocicorp/mono/pull/6235)
**Depends on:** #6235; PR 2 before staging validation

Scope:

- Accumulate COPY bytes and chunk count.
- Update OTel counters once per 8 MiB.
- Flush at normal completion and stream destruction.
- Preserve labels and eventual totals.
- Keep this PR separate from source/processing timers.

Tests:

- Below, exactly at, and above the threshold.
- Successful finalization.
- Partial stream failure and destruction.
- No duplicate final/destroy flush.
- Exact byte and chunk totals.
- Active and no-op OTel providers.

Benchmark:

- Parent versus PR with no-op OTel.
- Parent versus PR with active SDK and an in-memory exporter.
- Default mixed fixture plus `wide-text-scaled`, `wide-text-full`,
  `large-payload-scaled`, and `large-payload-full` confirmation.
- High chunk-count profiles are required.

Acceptance:

- Exported metric totals are identical.
- Active OTel gains at least 5% before claiming faster initial sync.
- No-op OTel satisfies the common no-regression gate.
- If elapsed improvement remains inconclusive, claim reduced metric calls only.

Suggested branch: `0xcadams/batch-initial-sync-copy-metrics`

### PR 4: Initial-Sync Source And Processing Telemetry

**Repository:** mono
**Risk:** low-medium
**Original benchmark:**
[mono PR #6235](https://github.com/rocicorp/mono/pull/6235)
**Depends on:** PR 3

Scope:

- Add unconditional `sourceWaitMs` and `processingMs` to the existing per-table
  completion record for binary and text COPY.
- Time destination `write()` and `final()` callbacks.
- Derive source wait from stream wall time minus destination processing.
- Do not aggregate table timings into run wall time when tables copy in
  parallel.
- Do not add per-chunk logs.
- Do not include detailed statement clocks, flush arrays, or small-sample p95.
- Keep insert-shape statistics benchmark-local unless a production use is
  demonstrated.

Tests:

- Binary and text COPY.
- Populated and empty tables.
- Final flush and stream errors.
- Concurrent table copies.
- Finite, nonnegative values.
- Phase reconciliation with stream wall time.
- Structured completion log shape.

Benchmark:

- Exact parent without timing versus PR with timing.
- Default mixed, `wide-text-scaled`, `wide-text-full`,
  `large-payload-scaled`, `large-payload-full`, and source-shaped profiles.
- Include both 31 KiB and 5.5 KiB callback frequencies.

Acceptance:

- Median overhead no greater than 2%.
- Upper 95% bound below 3% in every core profile.
- If this gate fails, redesign or sample the timing rather than calling it
  negligible.

Rollout:

- Deploy before the behavioral optimization PRs.
- Collect representative initial-sync events across wide and narrow tables.
- Use the phase split to validate whether parser work and source waiting match
  benchmark predictions.

Suggested branch: `0xcadams/initial-sync-copy-phase-telemetry`

### PR 5: Linear Fragmented-Field Parser

**Repository:** mono
**Risk:** medium
**Original benchmark:**
[mono PR #6235](https://github.com/rocicorp/mono/pull/6235)
**Depends on:** #6235 and PR 4; PR 2 before staging validation

Scope:

- Allocate one exact-size destination for fragmented fields.
- Copy each fragment once.
- Preserve zero-copy views for contained fields.
- Reject invalid field lengths and header extension lengths.
- Reject invalid tuple field counts.
- Add explicit end-of-stream validation for truncated headers, tuples, and
  fields.
- Do not ship assembly-statistics counters or an exported parser statistics
  API.

Tests:

- Boundaries around header, tuple count, field length, and field body.
- Deterministic random chunk partitions.
- Null, empty, adjacent, and large values.
- Malformed negative fields and extensions.
- Truncated streams.
- Buffer ownership and exact content hashes.

Benchmark:

- Contained 4 KiB/31 KiB control.
- 270 KiB/5.5 KiB fragmentation.
- 683 KiB/31 KiB fragmentation.
- 683 KiB/5.5 KiB fragmentation.
- Mixed ordinary fixture.
- `wide-text-scaled`, `wide-text-full`, `large-payload-scaled`, and
  `large-payload-full` binary COPY.

Acceptance:

- At least 1.5x parser throughput on fragmented profiles.
- Contained and ordinary paths satisfy the common no-regression gate.
- Claim end-to-end improvement only where paired integration results establish
  it; otherwise describe the PR as removing pathological parser complexity.

Suggested branch: `0xcadams/linear-pg-copy-field-assembly`

### PR 6: Direct Buffer Binding Through SQLite CAST

**Repository:** mono
**Risk:** medium-high
**Original benchmark:**
[mono PR #6235](https://github.com/rocicorp/mono/pull/6235)
**Depends on:** parser only for intended rollout order

Scope:

- Keep eligible text-like binary COPY values as Buffers.
- Use `CAST(? AS TEXT)` in SQLite statements.
- Strip JSONB's binary version byte.
- Keep arrays and unsupported types on established decoders.
- Keep native addon changes entirely out of this PR.
- Add the deferred Unicode, JSON/JSONB, null, empty, and SQLite text-affinity
  fixture matrix in this PR because these semantics are part of the treatment.

Tests:

- Text, varchar, bpchar, PostgreSQL `"char"`, JSON, JSONB, enum, unknown
  text-cast types, arrays, nulls, empty values, and Unicode.
- SQLite `typeof()` remains `text`.
- JSON functions, equality, indexed lookup, ordering, and collation behavior.
- Whole-fixture equality against the existing string-decoding path.

Benchmark:

- Parent string decoding versus Buffer plus CAST.
- Mixed and non-text controls.
- `wide-text-scaled`, `wide-text-full`, `large-payload-scaled`, and
  `large-payload-full`.
- Report CPU, external memory, RSS, GC, source/processing, and flush time.

Acceptance:

- At least 5% gain with interval above parity on `wide-text-full`.
- `large-payload-scaled`, `large-payload-full`, mixed, and non-text controls
  satisfy the common no-regression gate.
- Do not require a 5% large-payload gain; existing production-calibrated evidence
  suggests a much smaller benefit there.

Suggested branch: `0xcadams/direct-copy-text-buffers`

### PR 7: Adaptive Secondary-Index Scheduling

**Repository:** mono
**Risk:** high operational/performance risk
**Original benchmark:**
[mono PR #6235](https://github.com/rocicorp/mono/pull/6235)
**Depends on:** production telemetry observations

Scope:

- Compute estimated average row width from existing PostgreSQL estimates.
- Eagerly create secondary indexes only for qualifying wide tables.
- Keep primary indexes deferred.
- Keep narrow, empty, and unknown-estimate tables deferred.
- Do not expose force-eager benchmark controls through production options.
- Make the threshold and rollout decision explicit in the PR rationale.
- Add the deferred threshold-boundary and production-topology table/index
  matrices in this PR; keep them benchmark-local with neutral names.

Before implementation, use production telemetry to simulate the proposed 2 KiB
policy over observed tables. Reconsider the heuristic if estimates are commonly
stale, zero, or close to the threshold.

Tests:

- Wide, narrow, empty, and mixed-width tables.
- Widths immediately below and above the threshold.
- Primary versus secondary indexes.
- Missing, zero, stale, and schema-qualified estimates.
- Status behavior with zero or some deferred indexes.
- Exact final schema, index definitions, integrity, and query plans.

Benchmark:

- Randomized blocks containing current deferred, adaptive, forced deferred, and
  forced eager-secondary strategies.
- Keep forced strategies benchmark-local as the oracle.
- Include `wide-text-narrow`, `large-payload-narrow`, `wide-text-scaled`,
  `wide-text-full`, `large-payload-scaled`, and `large-payload-full`.
- Include the PR-owned threshold-boundary matrix and neutral
  production-calibrated table/index topology matrix.

Acceptance:

- Adaptive stays within 3% of the better forced strategy per profile.
- At least 5% gain over current behavior on wide production profiles.
- No more than 3% regression on narrow profiles.
- No new OOM, memory-pressure, or I/O-pressure failures.

Rollout:

- Canary before broad enablement.
- Compare observed selected policies and phase timings with benchmark results.

Suggested branch: `0xcadams/adaptive-initial-sync-secondary-indexes`

### PR 8: Native Transient UTF-8 Binding

**Risk:** highest
**Original benchmark:**
[mono PR #6235](https://github.com/rocicorp/mono/pull/6235)
**Depends on:** PR 6
**Decision gate:** proceed only if the clean A/B still justifies native release
complexity

This requires three coordinated PRs rather than a mono pnpm patch.

#### PR 8a: Native Addon

- Add `utf8BufferParameters(indexes)` in the source repository for
  `@rocicorp/zero-sqlite3`.
- Support `SQLITE_TRANSIENT` only.
- Validate positive, in-range parameter indexes.
- Test arrays, named bindings, non-Buffer fallbacks, locked/already-bound
  statements, mutation, GC pressure, and delayed iterators.
- Publish Linux x64 and ARM64 prebuilds.

#### PR 8b: zqlite Wrapper And Dependency

- Bump mono to the published addon version.
- Expose the method through zqlite `Statement`.
- Add zqlite behavior and lifetime tests.
- Test installation from the actual published prebuild, not patched source.

#### PR 8c: Initial-Sync Integration

- Mark only eligible Buffer parameter positions.
- Preserve Buffer plus CAST as the parent comparison.
- Keep PostgreSQL `"char"` and unsupported types on the established path.
- Verify parameter indexing for single- and multi-row statements.

Benchmark:

- Native binding microbenchmarks from empty values through 683 KiB.
- Buffer plus CAST parent versus native transient.
- Default mixed, `wide-text-scaled`, `wide-text-full`,
  `large-payload-scaled`, `large-payload-full`, and source-bound controls.
- Linux x64 and ARM64 release prebuilds.

Acceptance:

- At least 5% `wide-text-full` gain with interval above parity.
- `large-payload-scaled`, `large-payload-full`, and mixed profiles satisfy the
  common no-regression gate.
- No package, prebuild, affinity, ordering, or lifetime differences.
- Stop at Buffer plus CAST if the clean rerun does not retain enough incremental
  value to justify the native release surface.

Suggested branch names:

- `0xcadams/sqlite-utf8-buffer-parameters` in the addon repository.
- `0xcadams/zqlite-utf8-buffer-parameters` in mono.
- `0xcadams/native-initial-sync-text-buffers` in mono.

## Final Stack Validation

After accepted component PRs merge:

- Link [mono PR #6235](https://github.com/rocicorp/mono/pull/6235) as the
  original benchmark, rerun its exact benchmark commit alongside stack head, and
  report cumulative speedup with the common table format.
- Compare current clean `origin/main` with the complete stack using the manual
  paired full-volume mono protocol.
- Confirm exact replica correctness, schema, indexes, and image provenance.
- Report bundle performance as deployment validation, not component
  attribution.
- Run baseline and stack-head from independent clones of the same immutable
  10,000-row post-seed PostgreSQL template at 1 CPU/3 GiB, isolate all
  replica/CVR/Change/slot/Litestream state, verify all content and indexes,
  collect deployment telemetry, tear down state, and prove rollback through a
  third clean baseline clone.
- Only after zmail passes, canary the stack in the intended rollout environment
  and compare production telemetry with benchmark predictions.
- Revisit producer/parser workers only if production shows a repeatable
  non-SQLite processing gap on a workload with spare CPU.

Current evidence argues against workers:

- Email has one CPU and therefore gains no compute capacity from another worker.
- Median non-flush destination work was approximately 430 ms for Email.
- Median non-flush destination work was approximately 215 ms for imports.
- PostgreSQL already acts as an independent producer.

## Explicitly Rejected Or Out Of Scope

Do not spin these out from the research worktree:

- Partial INSERT batches. Results were small and mixed, including an imports
  regression.
- Fragmented-field buffer pooling. Paired callback time regressed 0.94% despite
  fewer GCs, and I/O/memory pressure increased.
- `SQLITE_STATIC`. It was slower than transient in the main production A/B and
  exposed an unsafe Buffer lifetime.
- No-result statement execution. Email improved 2.5%, while imports regressed
  6.8%.
- Always-eager secondary indexes. Narrow imports regressed approximately 38%.
- Eager primary indexes. Secondary-only was faster.
- mmap changes. Both final origin and candidate used mmap off; production-scale
  alternatives were mixed and increased memory risk.
- Artificial source-rate limiting as an optimization target.
- Producer/parser workers without new production evidence.
- Generic exported `experimental` initial-sync options.
- The omnibus pnpm patch.

Historical rejected-treatment evidence:

- `results/native-no-result-scaled-docker-summary.json`
- `results/final-field-pool-core-docker-summary.json`
- `results/native-binding-production-factorial-docker-summary.json`
- `results/adaptive-index-narrow-docker-summary.json`
- `results/final-mmap-scaled-docker-summary.json`
- `results/final-mmap-production-smoke-docker-summary.json`

## Handoff Checklist

1. Preserve the current research worktree until all accepted changes have been
   reimplemented or deliberately discarded.
2. Resolve current `origin/main` and create a fresh worktree for PR 1.
3. Port benchmark capabilities into existing mono benchmark conventions rather
   than copying zero-docs scripts wholesale.
4. Merge [mono PR #6235](https://github.com/rocicorp/mono/pull/6235) and deploy
   the representative zmail seed PR before staging product optimization PRs.
5. Build each product PR from the previously merged state so manual parent/head
   measurements report marginal value in rollout order.
6. Run smoke/correctness before expensive paired performance stages.
7. Put the complete benchmark command, exact refs, result artifact, paired
   summary, confidence interval, and correctness status in every PR description.
8. Keep immutable raw artifacts outside the Git repository with checksums.
9. Run the required zmail staging seed count with independent PostgreSQL clones
   and isolated baseline/candidate Zero state; attach correctness, resource,
   timing, telemetry, teardown, and clean-clone rollback status.
10. Add concise frozen reports and artifact pointers to zero-docs.
11. Do not claim p95 or component causality from the historical three-run bundle.

## Key Source Pointers

Current mono benchmark foundation:

- `/Users/chase/git/roci/mono/packages/zero-cache/src/db/initial-sync.bench.pg.ts`
- `/Users/chase/git/roci/mono/packages/zero-cache/src/test/pg-bench.ts`
- `/Users/chase/git/roci/mono/packages/shared/src/bench.ts`
- `/Users/chase/git/roci/mono/packages/zero-cache/src/db/pg-copy.bench.ts`
- `/Users/chase/git/roci/mono/packages/zero-cache/src/config/zero-config.ts`

Current zmail foundation inspected for PR 2:

- `/Users/chase/git/roci/zmail/package.json`
- `/Users/chase/git/roci/zmail/README.md`
- `/Users/chase/git/roci/zmail/.env.sample`
- `/Users/chase/git/roci/zmail/docker-compose.yml`
- `/Users/chase/git/roci/zmail/apps/web/vercel.json`
- `/Users/chase/git/roci/zmail/apps/web/src/routes/api/add-emails.ts`
- `/Users/chase/git/roci/zmail/packages/db/src/index.ts`
- `/Users/chase/git/roci/zmail/packages/db/src/schema.ts`
- `/Users/chase/git/roci/zmail/packages/db/src/seed.ts`
- `/Users/chase/git/roci/zmail/packages/db/drizzle/0000_little_marvel_zombies.sql`
- `/Users/chase/git/roci/zmail/packages/db/drizzle/0001_useful_the_twelve.sql`
- `/Users/chase/git/roci/zmail/packages/db/drizzle/0002_tiny_lockjaw.sql`
- `/Users/chase/git/roci/zmail/packages/db/drizzle/0003_empty_morg.sql`
- `/Users/chase/git/roci/zmail/packages/shared/src/prng.ts`
- `/Users/chase/git/roci/zmail/packages/shared/src/seed/index.ts`
- `/Users/chase/git/roci/zmail/packages/shared/src/seed/templates.ts`
- `/Users/chase/git/roci/zmail/scripts/seed/index.ts`
- `/Users/chase/git/roci/zmail/packages/zero/src/schema.ts`
- `/Users/chase/git/roci/zmail/packages/zero/src/queries.ts`

There is no current checked-in zmail zero-cache staging manifest. The only
Compose service is PostgreSQL, and Vercel config covers the web app cron/static
headers. Resource and image controls therefore point to an external staging
system that still needs to be identified.

Research implementation:

- `/Users/chase/.worktree/mono/initial-sync-copy-pipeline/packages/zero-cache/src/db/pg-copy-binary.ts`
- `/Users/chase/.worktree/mono/initial-sync-copy-pipeline/packages/zero-cache/src/db/pg-copy-binary.test.ts`
- `/Users/chase/.worktree/mono/initial-sync-copy-pipeline/packages/zero-cache/src/services/change-source/pg/initial-sync.ts`
- `/Users/chase/.worktree/mono/initial-sync-copy-pipeline/packages/zero-cache/src/services/change-source/pg/initial-sync.pg.test.ts`
- `/Users/chase/.worktree/mono/initial-sync-copy-pipeline/packages/zqlite/src/db.ts`
- `/Users/chase/.worktree/mono/initial-sync-copy-pipeline/packages/zqlite/src/db.test.ts`
- `/Users/chase/.worktree/mono/initial-sync-copy-pipeline/patches/@rocicorp__zero-sqlite3@1.1.2.patch`

Exploratory benchmark implementation:

- `src/initial-sync-copy-pipeline.product.bench.pg.ts`
- `src/pg-copy-parser.product.bench.ts`
- `scripts/run-docker.mjs`
- `scripts/aggregate.mjs`
- `scripts/summarize-integration.mjs`
- `config/integration-profiles.json`
- `config/integration-stages.json`

Primary reports and results:

- `production-baseline.md`
- `final-candidate.md`
- `results/origin-main-baseline-docker.json`
- `results/origin-main-baseline-docker-summary.json`
- `results/final-native-candidate-core-docker.json`
- `results/final-native-candidate-core-docker-summary.json`
- `results/parser-core.json`
- `results/docker-direct-text-core-docker-summary.json`
- `results/native-binding-production-factorial-docker-summary.json`
- `results/native-text-imports-production-docker-summary.json`
- `results/eager-index-scaled-docker-summary.json`
- `results/secondary-index-scaled-docker-summary.json`
- `results/adaptive-index-narrow-docker-summary.json`
- `results/batched-metrics-scaled-docker-summary.json`
- `results/final-field-pool-core-docker-summary.json`
- `results/final-native-telemetry-smoke-docker.json`
- `results/final-native-telemetry-smoke-docker-summary.json`

## Status At Handoff

- No product commits were created from the research worktree.
- No production deployment was performed.
- No worker-thread implementation was started.
- The native binding remains a local package patch and release blocker.
- The durable mono fixture and representative zmail seed PRs are the next
  actions; paired orchestration/reporting will be performed manually for each
  product PR.
- `mono` is confirmed as the canonical executable benchmark home.
- zmail's normal seed remains entirely synthetic and doubles as a staging
  canary, with no customer data and no benchmark-attribution role.
