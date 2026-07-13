# Initial Sync Bottleneck Investigation

This workspace isolates the shared initial-sync throughput drop above roughly
400 MB in Zero 0.22, 1.0, and 1.8. It uses deterministic, TOAST-heavy data,
the production `initReplica()` wrapper, exact COPY stream byte counts, and
balanced treatment ordering.

The investigation is complete. See [`findings.md`](findings.md) for the root
cause, ablations, cross-version confirmation, and production recommendation.

No production source is changed. `scripts/install-harness.mjs` installs a
benchmark-only test and a small version adapter into the detached comparison
worktrees.

## Safety

The runner is dry-run by default. It prints the commands and output paths but
does not run them. A benchmark starts only when `--execute` is supplied.

```sh
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/run.mjs stage0
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/run.mjs stage0 --execute
```

Do not use `--execute` until fixture calibration has completed and
`config/profiles.json` has been updated with measured COPY bytes.

## Layout

- `config/worktrees.json`: immutable refs and detached worktree paths.
- `config/profiles.json`: fixture-size seeds and measured calibration fields.
- `config/stages.json`: staged treatment matrix.
- `src/`: canonical benchmark harness and per-version adapters.
- `sql/toast-validation.sql`: independent TOAST/storage verification queries.
- `scripts/install-harness.mjs`: installs benchmark-only files in each worktree.
- `scripts/run.mjs`: balanced sequential runner; dry-run unless `--execute`.
- `scripts/aggregate.mjs`: parses completed raw logs into process-level JSON.
- `raw/<stage>/`: ignored stdout/stderr and `/usr/bin/time -lp` output.
- `profiles/`: ignored calibration output.
- `manifests/`: ignored expanded run manifests.
- `results/`: ignored aggregate output.

## Prepared Worktrees

| Label | Ref | Worktree |
| --- | --- | --- |
| `0.22-text` | `zero/v0.22.2025071101` | `baseline-0.22` |
| `1.0-text` | `zero/v1.0.0` | `baseline-1.0` |
| `1.8-binary` | `maint/zero/v1.8` | `target-1.8-initial-sync` |
| `1.8-text` | `maint/zero/v1.8` | `target-1.8-initial-sync` |

## Preparation

Install or refresh the benchmark-only files:

```sh
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/install-harness.mjs
```

Validate configuration and inspect every command without executing it:

```sh
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/run.mjs calibration
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/run.mjs stage0
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/run.mjs stage1
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/run.mjs stage2
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/run.mjs stage3
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/run.mjs confirm
```

## Calibration Gate

Run `calibration` first when execution is approved. It creates each fixture,
streams every published table in binary and text format, records relation and
TOAST sizes, and exits without running initial sync.

The row counts in `config/profiles.json` are starting estimates. Copy the
measured values into `binaryCopyBytes` and `textCopyBytes`, then adjust
`totalRows` until the two headline profiles are within these bounds:

| Profile | Binary COPY target |
| --- | ---: |
| `toast-400m` | 395-405 MB |
| `toast-1200m` | 1,185-1,215 MB |

Import calibration output and print row-count corrections with:

```sh
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/aggregate.mjs calibration
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/apply-calibration.mjs
```

The runner refuses non-calibration execution while a required binary field is
missing or more than 1.25% from its target unless `--allow-uncalibrated` is
explicitly supplied.

## Measurements

Every benchmark process emits one `ZERO_INITIAL_SYNC_RESULT` JSON object with:

- Outer production-wrapper and inner initial-sync callback duration.
- Existing per-version initial-sync phase logs and structured 1.8 phase data.
- Binary and text COPY stream bytes by table.
- Row counts, logical bytes, relation sizes, and TOAST relation sizes.
- Peak sampled RSS, process resource usage, and Postgres database I/O deltas.
- SQLite row count, file size, page count, and page size.

The existing “flush” metric is retained as `sqliteInsertWorkMs`; it is
synchronous SQLite insertion work summed across table workers, not durable
filesystem flush wall time.

## Stages

| Stage | Purpose |
| --- | --- |
| `calibration` | Calibrate exact COPY bytes; no initial sync |
| `stage0` | Verify instrumentation overhead at 400 MB and 1.2 GB |
| `stage1` | Locate the scaling knee and compare raw COPY controls |
| `stage2` | Standard, required-only, no-index, and stress-index ablation |
| `stage3` | 1, 2, and 4 table-copy workers |
| `stage4-index` | SQLite cache, mmap, and temp-sort mechanism controls |
| `confirm` | Confirm the implicated signature across all three refs |
| `confirm-cause` | Paired default/mmap causal confirmation across all refs |

Stage 4 is intentionally evidence-directed. Add only the branch implicated by
stages 1-3: SQLite tuning, insertion batching, TOAST shape, or source COPY.

The completed evidence-directed matrix contains 257 successful processes.
Stage 3 worker scaling and the original confirmation matrix were superseded by
the index mechanism controls and paired default/mmap cross-version matrix.

The `none` index profile removes source indexes and uses `REPLICA IDENTITY
FULL`; it is a complete no-index diagnostic rather than a perfectly isolated
SQLite-only switch. The `standard` versus `required` comparison is the cleaner
secondary-index ablation.

## Aggregation

After an executed stage:

```sh
node .releases/1.8/benchmarks/initial-sync-bottleneck/scripts/aggregate.mjs stage1
```

This writes `results/<stage>.json`. It does not infer a cause; it preserves
process-level observations for paired bootstrap and segmented-regression
analysis after the core stages complete.
