# Initial Sync Copy Pipeline

This benchmark investigates PostgreSQL COPY, binary parsing, decoding, and
SQLite insertion work under production-shaped CPU and memory constraints.
It is intentionally separate from `../initial-sync-bottleneck`, which isolated
the SQLite index pager-cache knee.

All fixtures are synthetic. Production metrics are used only to calibrate row
width, stream chunking, table count, index count, CPU, and memory profiles.
No benchmark connects to a production or customer database.

## Worktrees

- `baseline`: clean Zero source at `d87c1c813`.
- `linear-parser`: the same source plus the fragmented-field parser candidate.

The installer copies benchmark-only Vitest files into both worktrees. Runtime
source changes remain in the candidate worktree and are recorded in manifests.

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

The parser cases cover production-observed field and stream-fragment sizes,
plus a contained-field control. Results report wall time, CPU time, throughput,
peak RSS, checksums, and candidate parser assembly statistics.

## Safety

- Processes run sequentially.
- Generated SQLite files are deleted after inspection.
- Docker runs use explicit CPU, memory, swap, and PID limits.
- High-volume stages begin with one smoke case.
- A run is rejected if its exit status, result protocol, checksum, effective
  mmap, row count, or cgroup memory state is invalid.
