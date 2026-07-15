# Initial-Sync Performance Experiment Plan

Updated 2026-07-15.

## Status

Every item in this document is an **unvetted experiment**. None is approved for
landing based on existing benchmark evidence. Passing correctness tests, having
a clean branch, or showing a favorable exploratory median does not make an
experiment vetted.

An experiment becomes a PR candidate only after it passes its preregistered
correctness, performance, resource, provenance, and reproducibility gates.

The frozen generation-one source baseline is:

```text
origin/main
bc1db665f30ee341011697128a5414d2bbc7ea7c
```

The baseline must move only through an explicit new experiment generation. Do
not silently update parent commits during a benchmark campaign.

## Landed Foundation

These changes are context, not active experiments:

- Durable benchmark fixtures landed in mono PR #6235 at `2ca567a2a`.
- Batched COPY metrics landed in mono PR #6237 at `ea459443f`.
- Per-table phase telemetry landed in mono PR #6236 at `6e34c95a7`.
- The representative zmail seed landed in zmail PR #9 at `ef914eb5d`.
- The fragmented-field parser remains deferred. Current production evidence
  does not motivate it as a standalone JS-path optimization.

## Experimental Dependency Tree

Dependencies exist only when an experiment genuinely needs another treatment.
Independent treatments branch directly from the frozen baseline.

```text
origin/main
|
|-- E1  Direct Buffer binding through SQLite CAST
|   `-- E5  Native transient UTF-8 binding
|
|-- E2  Adaptive secondary-index scheduling
|   `-- E3  Sampled record_send estimator
|
|-- E4a Batch table-estimate query
|   `-- E4b Schedule large tables first
|
|-- E6R Behavior-neutral shared InsertBatchWriter
|   |-- E6  Fix batching, parameter limits, and multi-row tails
|   |-- E7  Bound active-table buffering
|   `-- E9  Offset-based COPY parsing and decoding
|
|-- E8a zqlite runValues
|-- E8b Lazy slow-query logging context
|
|-- E10a Batch column-metadata inserts
|-- E10b Lazy metadata statements and cache-first lookup
|-- E10c Reduce status recomputation
|-- E10d Reduce routine initial-sync logging
|
|-- E11a Deterministic deferred-index grouping and ordering
|-- E11b Initial-sync page-cache policy
|-- E11c SQLite sorter-thread feasibility
|-- E11d Deferred-index interleaving
|
`-- E12 Native binary-COPY ingestion in zero-sqlite3
```

Additional dependency:

```text
E11d requires proven bounded backpressure from E7.
```

E12 is an alternative architecture. It subsumes several JS-path treatments for
initial sync and must not initially stack on E1, E5, E6, E7, E8, or E9.

## Current Branch State

| Experiment               | Branch                                                  | Worktree                                                                   | Current head | Parent                                      |
| ------------------------ | ------------------------------------------------------- | -------------------------------------------------------------------------- | ------------ | ------------------------------------------- |
| E1 Direct Buffer         | `0xcadams/direct-copy-text-buffers`                     | `/Users/chase/.worktree/mono/direct-copy-text-buffers`                     | `27683b82b`  | `bc1db665f`                                 |
| E2 Adaptive indexes      | `0xcadams/adaptive-secondary-index-scheduling`          | `/Users/chase/.worktree/mono/adaptive-secondary-index-scheduling`          | `11622fdf4`  | `bc1db665f`                                 |
| E3 Enhanced adaptive     | `0xcadams/enhanced-adaptive-secondary-index-scheduling` | `/Users/chase/.worktree/mono/enhanced-adaptive-secondary-index-scheduling` | `11622fdf4`  | E2; no E3 treatment yet                     |
| E4 Schedule large tables | `0xcadams/schedule-large-tables-first`                  | `/Users/chase/.worktree/mono/schedule-large-tables-first`                  | `bc1db665f`  | baseline; no E4 treatment yet               |
| E5 Native UTF-8 addon    | `0xcadams/sqlite-utf8-buffer-parameters`                | `/Users/chase/.worktree/zero-sqlite3/sqlite-utf8-buffer-parameters`        | `8559637c1`  | zero-sqlite3 baseline; no E5 treatment yet  |
| E12 Native ingest addon  | `0xcadams/native-initial-sync-ingestor`                 | `/Users/chase/.worktree/zero-sqlite3/native-initial-sync-ingestor`         | `8559637c1`  | zero-sqlite3 baseline; no E12 treatment yet |

Do not create implementation branches for later experiments until their
fixture, primary metric, minimum useful effect, sample count, invalid-run rules,
and expected artifact set are preregistered.

## Why The Old Stack Was Rejected

The previous `Direct Buffer -> Adaptive -> all later candidates` stack was not a
sound causal experiment:

- Direct Buffer and adaptive indexing are independent treatments.
- A parent/head adaptive comparison inherited an unaccepted Buffer treatment.
- Later descendants inherited two unaccepted treatments.
- An inherited gain could mask a new regression.
- An inherited regression could mask a real gain.
- Rejecting one treatment forced unrelated descendants to be rebuilt.

The first experiment generation therefore measures independent treatments
against the same frozen baseline. Accepted treatments receive explicit
interaction tests before they are combined.

## Canonical Benchmark Contract

### Environment

- Use a dedicated Linux host matching the intended architecture. Docker Desktop
  on macOS is development and screening evidence unless explicitly accepted as
  the only available canonical environment.
- Pin application and PostgreSQL containers to disjoint CPU sets, not only CFS
  CPU quotas.
- Record CPU model, governor, frequency, throttling, temperature, steal time,
  host load, kernel, Docker, filesystem, and free space.
- Reject runs during indexing, backup, updates, CI, unrelated containers, or
  activity outside the preregistered host-idle limits.
- Pin CPU, memory, swap, Node heap, PID, PostgreSQL, SQLite, and filesystem
  settings.
- Use exactly 1 application CPU, 3 GiB application memory, and a 2304 MiB Node
  heap for every profile. Worker count may vary only when it is an explicit
  experimental axis.
- Build clean immutable parent and candidate images once per experiment block.
- Pin Docker base images and native prebuilds by digest.

### Isolation

- Use a fresh SQLite file and isolated Zero state for every arm.
- Use an independent PostgreSQL clone from one immutable fixture snapshot for
  every measured arm.
- Never let baseline and candidate mutate the same source database, slot,
  replica, CVR, Change DB, or backup namespace.
- Run one measured initial sync per process and product container.
- Record the source clone identity and PostgreSQL system identity for every run.

### Cache Policy

- Preregister warm or cold source behavior for every profile.
- Destination-pipeline experiments use identically prepared warm-source primary
  blocks to reduce source noise.
- Scheduling and index experiments include controlled warm and cold sensitivity
  blocks.
- Raw COPY controls use separate identically prepared clones and must not
  prewarm measured initial sync.
- Never divide initial-sync timing by raw COPY timing.
- If raw COPY differs by more than 3% with an interval excluding parity, mark
  the block source-imbalanced and run the preregistered replacement block.

### Ordering And Samples

- Discard one warmup pair per profile and machine condition.
- Use 12 independent measured pairs by default.
- Use 20 pairs for expected effects between 2% and 5% or visibly noisy lanes.
- Balance two-arm blocks between AB and BA order using a recorded seed.
- Use a balanced Williams or Latin-square order for three or more arms.
- Keep paired runs close together in time.
- Do not count repeated operations in one Node or Vitest process as independent
  observations.
- Six independent scaled pairs may reject an idea during screening but cannot
  vet it for landing.
- Use 10 to 12 full-volume pairs when the full-volume percentage is itself a
  shipping claim.

### Statistics

For each independent pair:

```text
ratio = candidate whole-readiness wall time / control whole-readiness wall time
```

Whole `initReplica` readiness is the default primary metric. Callback, COPY,
processing, flush, index, and source-wait times are attribution metrics.

Every confirmatory report includes:

- Every run and pair ratio.
- Median paired ratio and MAD.
- Geometric mean paired ratio.
- A deterministic paired-bootstrap 95% interval on log ratios using at least
  10,000 whole-pair resamples.
- Order effects.
- CPU, memory, GC, I/O, pressure, throttling, and correctness outcomes.

Default performance gate:

```text
point improvement >= 5%
upper 95% bound below parity
```

Default no-regression gate:

```text
median slowdown <= 2%
upper 95% bound below 3% slowdown
```

Do not repeatedly inspect ordinary fixed-sample confidence intervals and stop
when one passes. Use a fixed sample count unless an always-valid sequential
procedure is preregistered.

Treatment-caused OOM, corruption, timeout, restart, cancellation failure, or
resource pressure is a valid adverse result and must not be discarded as an
outlier.

## Experiment Summary

| ID  | Experiment                                | Parent   | Primary target                       | Minimum useful effect                    |
| --- | ----------------------------------------- | -------- | ------------------------------------ | ---------------------------------------- |
| E1  | Direct Buffer through CAST                | baseline | Wide-text readiness                  | 5% total gain                            |
| E2  | Adaptive index scheduling                 | baseline | Wide/index-heavy readiness           | 5% gain and within 3% of oracle          |
| E3  | Sampled `record_send` estimator           | E2       | Policy regret and estimator overhead | Better classification; overhead under 2% |
| E4  | Bulk estimates and large-first scheduling | baseline | Many-table makespan                  | 5% total gain                            |
| E5  | Native transient binding                  | E1       | Incremental gain over CAST           | 5% total gain                            |
| E6  | Insert batching fixes                     | E6R      | Narrow/high-row readiness            | 5% total gain                            |
| E7  | Bounded buffering                         | E6R      | Peak memory                          | 20% reduction with timing non-regression |
| E8  | `runValues` and lazy logging              | baseline | Wrapper cost and narrow sync         | 5% call gain; 3% total gain              |
| E9  | Offset parser and decoders                | E6R      | Binary processing CPU                | 10% phase and 5% total gain              |
| E10 | Schema/progress overhead                  | baseline | Many-table schema/status time        | 10% phase and 3% total gain              |
| E11 | Deferred-index construction               | baseline | Index-heavy readiness                | 10% index and 5% total gain              |
| E12 | Native zero-sqlite3 COPY ingestion        | baseline | Destination-limited readiness        | 15% gain on two representative profiles  |

## E1: Direct Buffer Binding Through SQLite CAST

Compare the current string-decoding path against Buffer parameters with
`CAST(? AS TEXT)`.

Required profiles include mixed, wide text scaled/full, large payload
scaled/full, narrow high-row-count, non-text-heavy, and varied Unicode/text-size
controls.

Correctness covers text, varchar, bpchar, PostgreSQL `"char"`, enum, JSON,
JSONB, null, empty, Unicode, arrays, unsupported text-cast types, SQLite
`typeof()`, collation, equality, ordering, JSON functions, indexed lookup, and
whole-table digests.

Existing `wide-text-full` evidence of approximately 2.51% does not satisfy the
5% gate. Environment-sensitive Linux evidence remains exploratory.

## E2: Adaptive Secondary-Index Scheduling

Compare deferred indexes, forced eager secondary indexes, and the catalog-based
adaptive policy. Primary indexes remain deferred.

Fixtures include wide, narrow, compressed, incompressible, stale-statistics,
bloated, empty, filtered-publication, threshold-boundary, and varied index-count
and key-width cases.

Acceptance requires:

- At least 5% over deferred on declared wide targets.
- Adaptive within 3% of the better forced strategy.
- No more than 3% regression on narrow targets.
- Exact final index definitions, query plans, and SQLite integrity.
- No new memory or I/O pressure.

Existing adaptive evidence is not accepted because narrow and oracle results
disagree and some blocks show source imbalance.

## E3: Sampled record_send Estimator

First benchmark estimator accuracy and overhead with production policy disabled.

Compare:

- `pg_table_size / reltuples`.
- Prefix samples of 8, 32, and 128 qualifying rows.
- Deterministic SYSTEM samples of 8, 32, and 128 qualifying rows.
- Exact binary COPY as ground truth.

SYSTEM sample percentage:

```text
min(100, 400 * requestedRows / reltuples)
```

Corrected binary row bytes for `N` output columns:

```text
octet_length(record_send(projected_row)) - 2 - 4 * N
```

Complete binary stream bytes:

```text
21 + SUM(corrected binary row bytes)
```

The projection and publication predicate must exactly match production binary
COPY, including `::text` fallbacks. A type-rich protocol fixture must establish
exact equality between full corrected `record_send` output and streamed COPY.

Use five rotated repetitions for estimator discovery. Production integration
then requires the common paired protocol against E2. Reject E3 if estimator
query cost removes the scheduling benefit.

## E4: Batch Estimates And Schedule Large Tables First

Use a 2x2 factorial to separate query consolidation from task ordering:

| Estimate retrieval | COPY ordering     |
| ------------------ | ----------------- |
| Per-table queries  | Publication order |
| One OID query      | Publication order |
| Per-table queries  | Largest first     |
| One OID query      | Largest first     |

Implementation hypothesis:

- Fetch all `pg_class` row and size estimates in one query using known table
  OIDs.
- Map query results by OID and reconstruct the original publication order.
- Stable-sort COPY tasks by estimated bytes descending.
- Preserve result identity by table name/OID rather than array position.
- Remove the O(table-count) estimate-query startup barrier.
- Keep index construction out of active COPY streams.

Fixtures include 32, 108, and stress 500-table publications with Pareto-skewed
sizes and large tables first, last, and seeded-random. Run 1, 2, and 5 COPY
workers. Existing one-dominant-table fixtures are insufficient.

## E5: Native Transient UTF-8 Binding

This is a coordinated addon, wrapper, and integration experiment. The
integration parent is E1, but both arms must use the same new addon package so
package/compiler changes are controlled.

During development and causal evaluation, build directly from the pinned local
zero-sqlite3 worktree. Do not publish or consume an npm canary. A later release
gate must still validate actual Linux x64 and ARM64 release prebuilds. Compare
Buffer plus CAST against transient native text binding. Do not use
`SQLITE_STATIC`.

Require at least 5% incremental readiness gain over E1, exact binding lifetime
and affinity behavior, and no package/prebuild regressions.

## E6: Shared InsertBatchWriter And Batching Fixes

Begin with E6R, a behavior-neutral extraction shared by binary and text COPY.
Do not attribute performance to the extraction itself.

Then test:

- Execute full batches with `>= INSERT_BATCH_SIZE`.
- Query the actual SQLite variable limit.
- Cap rows per statement from the runtime parameter limit and values per row.
- Lazily prepare one multi-row statement for each observed tail size.
- Execute a tail in one statement instead of up to 49 single-row statements.
- Remove the comparison that subtracts column count from a row count.
- Preserve binary `CAST(? AS TEXT)` placeholder positions.

Correctness covers 0, 1, 49, 50, 51, 99, 100, and 101 rows, parameter-boundary
column counts, wide tables, byte-triggered tails, binary/text parity, exact
binding order, and statement counts.

A reachable parameter-limit bug may justify a correctness-only fix. A
performance claim still requires the common gate.

## E7: Bound Active-Table Buffering

Compare current `10,000 * columnCount` value arrays against at most one effective
statement batch per active table.

Requirements:

- Retain no more than 50 completed rows.
- Append directly into one reusable binding array.
- Flush at the effective statement limit.
- Flush an exact smaller batch at the byte limit.
- Permit one oversized row and flush it immediately.
- Clear Buffer/object references immediately after synchronous execution.
- Use `values.length = 0` or equivalent ownership-safe native behavior rather
  than slicing and clearing thousands of slots.

Use 5 to 108 active tables, narrow and wide rows, oversized rows, and 1/2/5
workers under constrained memory. Success is at least 20% lower peak memory or
conversion of an OOM into success, with the timing upper bound below 3%
regression.

## E8: zqlite runValues And Lazy Slow Logging

Use a 2x2 factorial:

| Binding API     | Logging context |
| --------------- | --------------- |
| Rest parameters | Eager context   |
| `runValues`     | Eager context   |
| Rest parameters | Lazy context    |
| `runValues`     | Lazy context    |

Preserve `RunResult`, SQL errors, slow-query thresholds, context attributes,
warning logs, spans, and iterator behavior.

Benchmark statement-call microperformance, narrow initial sync, ordinary
zqlite workloads, and forced slow-query paths. Require a 5% call-level gain and
3% end-to-end gain without ordinary-workload regression.

## E9: Offset-Based COPY Parsing And Decoding

Change binary decoders to receive `(buffer, start, length)` and decode primitive
values without creating a Buffer view. The parser writes decoded values into
E6R's writer.

Direct text and BYTEA binding may still require Buffer views. Do not claim all
subarrays disappear.

Correctness includes every chunk partition, nonzero offsets, malformed lengths,
truncation, header extensions, tuple counts, null/empty values, arrays, JSONB's
version byte, Buffer lifetime, and full replica digests.

Require at least 10% lower parser/decoder processing time and 5% lower whole
readiness on a production-relevant high-row-count target.

## E10: Schema And Progress Overhead

Test these as independent treatments before combining them:

- Add `ColumnMetadataStore.insertMany()` with parameter-limit chunking.
- Lazily prepare update/delete/read statements.
- Check the instance cache before querying `sqlite_master`, with explicit
  invalidation semantics.
- Cache immutable portions of progress/status events.
- Build events from known initial-sync state instead of rescanning all SQLite
  schema and size state every five seconds.
- Move full per-table COPY and index SQL detail from info to debug while
  preserving phase summaries and slow-operation logs.

Use realistic 108-table/345-index and stress 500-table/1500-index fixtures with
thousands of columns, mostly empty/tiny tables, and long-running copies that
trigger periodic status events.

## E11: Deferred-Index Construction

Test separately, in increasing risk:

- Group indexes by table to improve locality.
- Use deterministic unique-first ordering to fail earlier on invalid data.
- Compare recently copied and largest-table-first ordering.
- Sweep a memory-bounded initial-sync page-cache policy.
- Test native `PRAGMA threads=N` sorter workers.
- Consider indexing a completed table during a source-bound copy only after E7
  proves bounded global backpressure.

Do not run multiple JS SQLite index builders. SQLite remains a single writer.
Synchronous `CREATE INDEX` blocks COPY callbacks, so interleaving is rejected
unless the total critical path improves without stream stalls or timeout risk.

## E12: Native Binary-COPY Ingestion In zero-sqlite3

This is the highest-risk alternative architecture. It does not mean adding a
second PostgreSQL client to the addon.

Keep in Zero/JavaScript:

- PostgreSQL connections, TLS/authentication, replication slots, snapshots, and
  COPY SQL.
- Publication/schema validation, table/index planning, worker-pool ownership,
  status publication, telemetry, and cleanup.

Move into `@rocicorp/zero-sqlite3`:

- Binary COPY framing and fragmented-field assembly.
- Primitive, array, text, JSON/JSONB, numeric, timestamp, and fallback decoding.
- UTF-8/blob binding with safe transient lifetime.
- Native bind/step/reset loops using one persistent statement initially.
- Bounded native-owned partial-field storage.
- Aggregated row, byte, write-time, and error statistics.
- Strict trailer, tuple-column-count, malformed-length, and truncation
  validation.

Suggested additive API:

```ts
interface PgCopyBinaryIngestor {
  write(chunk: Buffer): number;
  finish(): PgCopyBinaryIngestStats;
  abort(): PgCopyBinaryIngestStats;
}

db.preparePgCopyBinaryIngest(
  insertSQL: string,
  codecs: readonly PgCopyCodec[],
): PgCopyBinaryIngestor;
```

The initial experiment remains synchronous on the database-owning JS thread.
The SQLite handle is mutex-free and already participates in an exclusive
migration transaction; moving it to an addon worker thread would be a separate
transaction-model experiment.

Do not move index orchestration native initially. `CREATE INDEX` already spends
its expensive work inside SQLite, and the JavaScript loop provides useful logs
and cancellation points.

Proposed coordinated branches:

- `zero-sqlite3:0xcadams/native-initial-sync-ingestor`, based on `8559637c1`,
  built directly from the local worktree without npm publication.
- `mono:0xcadams/native-initial-sync-ingestor`, based directly on the frozen
  mono baseline with the native path hidden and default-off.

E12 subsumes E1/E5 text binding, E6/E7 JS statement batching and pending-value
arrays, and E9's JS parser for initial sync. It remains orthogonal to E2/E3
index policy and E4 scheduling. Hold those policies constant during the first
E12 attribution block.

Correctness includes every supported binary type, numeric rounding, timestamp
infinities and BC dates, multidimensional arrays, large integers in arrays,
JSONB's version byte, enums, unsupported `::text` fallbacks, fragmented chunks,
partial tails, cancellation, idempotent abort/finish, transaction rollback,
serving and shadow modes, and error context containing table/column/stream
offset.

Use local source builds during implementation and attribution. Do not publish an
npm package. Before release, separately validate Darwin, Linux glibc/musl,
Windows, x64, and ARM64 prebuilds, with production emphasis on Node 22 Linux
musl x64/ARM64. Introduce no libpq or new system-library dependency.

Compare baseline JavaScript ingestion with native ingestion using the same new
addon package and native mode disabled/enabled. Also retain E1 as a separate
comparison arm, not as E12's parent.

Because this adds a cross-repository C++ API and a large prebuild surface,
advance only if it provides at least 15% median whole-readiness improvement on
two destination-limited representative profiles with an interval above parity,
no more than 3% regression elsewhere, exact correctness, and either a clear
additional advantage over E1 or a compelling RSS/GC reduction.

## Interaction Experiments

Only isolated survivors proceed to interactions:

- E1 x E6 for CAST placeholder and statement-shape behavior.
- E1/E5 x E6 for native parameter positions in full and tail statements.
- E6 x E7 for batching frequency versus memory bounds.
- E6/E9 x E1 for direct-text Buffer ownership.
- E7 x E9 for parser ownership and retained-buffer limits.
- E2 x E4 for estimate plumbing, task order, and worker utilization.
- E2/E3 x E11 for eager/deferred policy and remaining index construction.
- E11 ordering x page-cache policy.
- E12 x E2 and E12 x E4 only after standalone E12 acceptance.

Do not combine all treatments and infer component effects from a bundle.

## Stage Gates

1. Preregister hypothesis, exact parent, fixture, primary metric, minimum useful
   effect, pair count, order seed, cache policy, invalid-run rules, and expected
   artifacts.
2. Complete unit, property, malformed-input, lifetime, transaction, and
   PostgreSQL-version correctness tests.
3. Run focused component microbenchmarks to show the treatment reduces its
   targeted work.
4. Run tiny functional smoke tests with exact whole-table digests.
5. Run six independent scaled screening pairs on one target and one control.
6. Reject effects clearly below 3%, correctness failures, or adverse resource
   outcomes. Do not accept a treatment at this stage.
7. Run 12 to 20 confirmatory scaled pairs under the canonical protocol.
8. Run preregistered factorial interaction blocks for surviving treatments.
9. Run 10 to 12 full-volume pairs for a full-volume performance claim.
10. Compare the selected stack against the frozen baseline and each newly added
    treatment against the previous selected stack.
11. Rebase accepted implementation branches into rollout order only after
    causal experiments finish.

## Harness Readiness

Before collecting canonical evidence, the harness must:

- Reject dirty product source and record exact commit, tree, diff, image, and
  config hashes.
- Pin Docker base images and native prebuilds by digest.
- Use independent immutable PostgreSQL identities per arm.
- Keep raw COPY controls separate from measured source clones.
- Enforce disjoint CPU sets and record throttling, memory events/peak/PSI, and
  scoped I/O.
- Make COPY worker count and cache policy explicit profile dimensions.
- Run one measured operation per process/container.
- Support generated many-table, schema-heavy, estimator, index, buffering, and
  parameter-boundary fixture families.
- Require exact row count, COPY bytes, COPY digest, and whole-replica content
  digest for canonical profiles.
- Reconcile every raw artifact exactly against a manifest-declared run list.
- Reject stale, missing, duplicate, extra, partial, and unbalanced runs.
- Report pair ratios, robust dispersion, paired confidence intervals, and order
  effects instead of tiny-sample p95 values.
- Mark legacy results and calibration runs exploratory and ineligible as
  confirmatory evidence.

Existing profiles remain noncanonical until their exact COPY and content
digests are calibrated, reviewed, and pinned. Preparing the harness and fixture
definitions does not itself vet any treatment.

## Provenance

Every experiment manifest records:

- Experiment ID, hypothesis, and dependency DAG.
- Exact parent/head commits, trees, and diff hashes.
- Image IDs/digests and Dockerfile/base-image provenance.
- Harness, config, fixture-generator, and analysis hashes.
- Fixture version/seed, source snapshot identity, schema/publications, rows,
  exact COPY bytes, COPY digest, and content digest.
- CPU sets/quotas, memory/swap/heap, filesystem, SQLite pragmas, worker count,
  and cache policy.
- Pair/block/order identity, planned sample count, stopping rule, and invalid-run
  rules.
- Per-run host state, CPU/GC/memory/I/O/pressure, correctness, exit, restart,
  timeout, and OOM outcomes.

Raw evidence belongs in immutable content-addressed storage. Git retains concise
reports, manifests, artifact URIs, and SHA-256 checksums.

## Next Actions

- Finish non-benchmark harness validation and exact artifact reconciliation.
- Update worktree/image configuration to the corrected branch heads above.
- Calibrate exact fixture digests in explicitly noncanonical runs before any
  canonical benchmark block.
- Write one preregistration per experiment before implementation or measurement.
- Do not run performance benchmarks until the host, source-clone strategy,
  profile digests, fixed sample plan, and artifact expectations all validate.
