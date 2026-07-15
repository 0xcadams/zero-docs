# Initial Sync Copy Pipeline

This benchmark investigates PostgreSQL COPY, binary parsing, decoding, and
SQLite insertion work under production-shaped CPU and memory constraints.
It is intentionally separate from `../initial-sync-bottleneck`, which isolated
the SQLite index pager-cache knee.

All fixtures are synthetic. Production metrics are used only to calibrate row
width, table count, index count, CPU, and memory profiles. Parser fragmentation
profiles are synthetic stress inputs. The executable performance harness does
not connect to a production or customer database.

`managed-pg-copy-fragmentation.md` separately records a read-only protocol
framing probe through user-provided PlanetScale and Supabase endpoints. It used
only generated `COPY (SELECT ... FROM generate_series(...))` data and did not
enumerate or read application objects.

## Worktrees

- `baseline`: clean Zero source at `d87c1c813`.
- `linear-parser`: the same source plus the fragmented-field parser candidate.
- `current-pr6-parent`: direct PR parent `c4d551967`.
- `current-pr6-head`: direct-text-buffer head `99442b64`.
- `current-pr7-parent`: clean deferred-index parent `ea459443f`.
- `current-pr7-head`: adaptive-index worktree based on `ea459443f`.
- `current-pr7-eager`: the same PR 7 worktree with a benchmark-only forced
  eager-secondary image patch.

By default, the installer copies benchmark-only Vitest files into the two
historical research worktrees. Runners pass explicit worktree labels when a
stage needs the current PR parent or head, and those generated files are removed
after host comparisons. Runtime source changes remain in the candidate worktree
and are recorded in manifests.

`Dockerfile.current-pr6.linux` injects the integration harness through a named
build context so current PR images can be built without modifying their clean
worktrees. Current-PR Docker stages use those prebuilt images with
`--reuse-images`.

`Dockerfile.current-pr7.linux` and `scripts/build-pr7-images.mjs` similarly
prepare isolated deferred-parent, adaptive, and forced-eager-secondary images.
The builder defaults to a dry run; pass `--execute` only when no other benchmark
is using Docker.

## SQLite Setting

Every full initial-sync performance case requests and verifies the `mmapGiB`
value in its stage configuration. The final candidate uses:

```sql
PRAGMA mmap_size = 0;
```

Historical stages include mmap sweeps; their manifests are the source of truth
for the setting used by each recorded result.

## Parser Benchmark

Install the benchmark-only files:

```sh
node scripts/install-harness.mjs
```

Preview or execute a balanced parser stage:

```sh
node scripts/run-parser.mjs parser-core
node scripts/run-parser.mjs parser-core --execute
node scripts/aggregate.mjs parser-core
```

The parser cases combine production-calibrated field widths with synthetic
stream-fragment sizes, plus a contained-field control. Results report wall time,
CPU time, throughput, peak RSS, checksums, and candidate parser assembly
statistics.

## Safety

- Processes run sequentially.
- Generated SQLite files are deleted after inspection.
- Docker runs use explicit CPU, memory, swap, and PID limits.
- High-volume stages begin with one smoke case.
- A run is rejected if its exit status, result protocol, checksum, effective
  mmap, row count, or cgroup memory state is invalid.
