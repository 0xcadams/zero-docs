# Initial Sync Phase Measurement

## Summary

Initial sync does not have one universal bottleneck. The limiting resource
depends on row shape, source throughput, and whether the SQLite working set fits
within the application cgroup.

This experiment found three distinct regimes:

1. **Wide data under memory pressure is storage-bound.** The production-shaped
   Email fixture creates a 6.85 GB SQLite file inside a 3 GiB cgroup. SQLite
   insert/flush work and deferred index creation account for a median 81.7% of
   migration time. The same runs record memory-limit pressure, reclaim, 19.47 GB
   of block reads, and 5.64 seconds of full I/O pressure.
2. **The imports fixture is source-paced while its working set fits.** With 6
   GiB available, its pipeline COPY throughput is within 4-6% of the raw COPY
   route ceiling. Reducing the application from two CPUs to one changes the
   full-volume migration by only 5.0%.
3. **Reducing memory moves imports into the storage-pressure regime.** At one
   CPU and 3 GiB, the 2.76 GB SQLite file plus process memory reaches the cgroup
   limit. Full-volume migration rises 27.7%, SQLite flush time more than
   doubles, and median full I/O pressure rises from 2.7 ms to 1.487 seconds.

The 250,000-row controls show a fourth, smaller-data regime: both workloads run
near one CPU core without memory pressure or block reads. In that case, row and
field processing costs are more visible than storage capacity.

This report measures the existing initial-sync path. It does not apply or
benchmark mmap, cache, index scheduling, binding, batching, or other
optimization treatments.

## Experiment Design

The experiment separates four possible constraints:

- **Destination work:** parsing, decoding, bookkeeping, SQLite statements, and
  deferred index construction.
- **Source pacing:** PostgreSQL delivery, Docker transport, stream machinery,
  and event-loop scheduling.
- **CPU capacity:** one-CPU and two-CPU application limits.
- **Memory capacity:** 3 GiB and 6 GiB application limits.

Two synthetic fixtures provide different row shapes:

| Fixture | Shape | Full COPY payload | Full SQLite file | Application limits |
| ------- | ----- | ----------------: | ---------------: | ------------------ |
| Email | 25-column wide rows, three substantial secondary indexes | 6.835 GB | 6.847 GB | 1 CPU, 3 GiB |
| imports | 7-column rows, more but smaller application indexes | 2.751 GB | 2.756 GB | 2 CPU/6 GiB, 1 CPU/6 GiB, and 1 CPU/3 GiB |

Scaled wide fixtures and 250,000-row narrow fixtures distinguish fixed per-row
work from effects that appear only when files approach the cgroup limit. A raw
COPY-to-null control measures the source route without destination parsing or
SQLite insertion.

All reported values are descriptive medians unless stated otherwise. Full
profiles use five runs. Original narrow profiles use three runs, and each
aligned imports control uses five. The instrumentation overhead block contains
ten AB/BA pairs per scaled fixture. In total, 86 application containers ran, 66
with phase measurement enabled.

Every run copied stable byte counts, passed correctness checks, exited
successfully, and recorded no cgroup OOM or OOM-kill event.

## Full-Volume Overview

The full-volume phase medians show how the bottleneck moves as fixture shape and
memory capacity change:

| Exclusive stage | Email, 1 CPU/3 GiB | imports, 2 CPU/6 GiB | imports, 1 CPU/6 GiB | imports, 1 CPU/3 GiB |
| --------------- | -----------------: | -------------------: | -------------------: | -------------------: |
| Migration wall | 22.094 s | 5.941 s | 6.237 s | 7.967 s |
| Setup | 0.076 s | 0.076 s | 0.076 s | 0.077 s |
| COPY SQLite flush | 8.024 s | 1.593 s | 1.500 s | 3.145 s |
| COPY non-flush processing | 1.547 s | 0.683 s | 0.564 s | 0.599 s |
| COPY source/event-loop residual | 2.016 s | 2.043 s | 2.159 s | 2.204 s |
| Deferred indexes | 9.858 s | 1.517 s | 1.624 s | 1.484 s |
| Replica registration | 0.022 s | 0.002 s | 0.013 s | 0.122 s |
| Transaction commit | 0.023 s | 0.009 s | 0.009 s | 0.014 s |
| `ANALYZE` | 0.240 s | 0.027 s | 0.027 s | 0.038 s |
| Migration other | 0.068 s | 0.011 s | 0.012 s | 0.013 s |

Stage medians are calculated independently, so the displayed values do not
necessarily add to the displayed migration median. Every individual run does
reconcile.

For Email, SQLite flush and deferred indexes consume median per-run shares of
36.7% and 45.1%. Their combined share is 81.7%, with a 79.2-82.5% range across
the five runs. Setup, registration, commit, and `ANALYZE` are secondary.

With 6 GiB, imports is more balanced. Source/event-loop residual is the largest
individual share at 34-36%, while flush and index work each account for roughly
a quarter. At 3 GiB, imports flush time more than doubles and becomes the
largest median phase. Individual 3-GiB runs also move storage wait into index or
commit time, so the median phase table understates tail variability.

## Isolating CPU And Memory

The imports controls vary one application resource at a time while keeping the
fixture, image, PostgreSQL container, and source topology fixed.

### CPU Is Not The Main Constraint

This comparison changes only the application CPU quota. Both configurations use
6 GiB memory and a 4,608 MiB Node heap.

| imports profile | Migration, 2 to 1 CPU | Change | Dominant COPY, 2 to 1 CPU | Change | Indexes, 2 to 1 CPU | Change | Average cores, 2 to 1 CPU |
| --------------- | ---------------------: | -----: | ------------------------: | -----: | -------------------: | -----: | ------------------------: |
| 550 MB | 1.239 to 1.305 s | +5.3% | 0.806 to 0.821 s | +1.8% | 0.305 to 0.348 s | +14.0% | 0.806 to 0.805 |
| 2.75 GB | 5.941 to 6.237 s | +5.0% | 4.174 to 4.269 s | +2.3% | 1.517 to 1.624 s | +7.1% | 0.801 to 0.784 |
| 250k narrow rows | 0.759 to 0.804 s | +5.9% | 0.377 to 0.397 s | +5.1% | 0.238 to 0.245 s | +2.9% | 0.986 to 0.943 |

No profile averages more than one CPU core across initial sync in the two-CPU
configuration. Individual subphases can briefly use more, but the second
allocated core does not materially accelerate the measured workloads.

Raw COPY changes by +3.3%, -0.3%, and +3.6% for the scaled, full, and narrow
profiles. Because these are independent balanced sessions rather than matched
pairs, differences of that size cannot be attributed entirely to the CPU
quota.

### Memory Capacity Changes The Full-Volume Result

This comparison holds the application at one CPU and changes the cgroup limit
from 6 GiB to 3 GiB. The Node heap cap changes from 4,608 MiB to 2,304 MiB, but
median full-volume heap use is only 163 MB, so neither heap cap is approached.

| Full imports metric | 1 CPU/6 GiB | 1 CPU/3 GiB | Change |
| ------------------- | ----------: | ----------: | -----: |
| Migration wall | 6.237 s | 7.967 s | +27.7% |
| Migration range | 5.659-6.273 s | 6.103-9.717 s | - |
| Dominant-table COPY | 4.269 s | 5.934 s | +39.0% |
| SQLite flush | 1.500 s | 3.145 s | +109.6% |
| Non-flush processing | 0.564 s | 0.599 s | +6.2% |
| Source/event-loop residual | 2.159 s | 2.204 s | +2.1% |
| Deferred indexes | 1.624 s | 1.484 s | -8.6% |
| Raw COPY | 4.014 s | 4.016 s | +0.0% |
| Pipeline throughput | 644 MB/s | 463 MB/s | -28.0% |
| Initial-sync CPU | 4.847 s | 4.843 s | -0.1% |
| Average cores during initial sync | 0.784 | 0.623 | - |
| Cgroup peak | 3.237 GB | 3.221 GB | - |
| Full I/O pressure | 2.7 ms | 1.487 s | - |
| Median block reads | 0 | 0 | - |
| Maximum block reads | 40.5 MB | 847.3 MB | - |
| Memory-limit events | 0-0 | 0-974 | - |
| OOM events | 0 | 0 | - |

Raw COPY, non-flush processing, source residual, and total process CPU remain
nearly flat. Those controls make source throughput and additional compute work
unlikely explanations for the median slowdown. The changed signal is storage:
the 3-GiB cgroup reaches its limit, full I/O pressure rises, and synchronous
SQLite flush time increases by 1.65 seconds.

The exact phase absorbing that wait varies by run. Three 3-GiB runs spend
3.15-3.59 seconds in COPY flushes, one spends 2.57 seconds indexing, and one
spends 1.89 seconds committing. The supported conclusion is therefore that
lower memory capacity causes I/O-associated wait. These whole-operation
counters do not isolate the exact file-cache or writeback mechanism or assign
every stall to one phase.

The 550 MB and narrow controls do not show this effect. Moving from 6 GiB to 3
GiB changes their migrations by +5.4% and +1.5%, with no memory-limit events,
reclaim, block reads, or I/O pressure. The capacity effect appears only at the
2.75 GB file size in this matrix; these endpoints do not locate a precise
threshold.

## Why Full Email Is Storage-Bound

The scaled and full Email profiles keep row width, schema, CPU, memory, source
topology, and SQLite settings fixed. The full profile has ten times as many rows
and almost exactly ten times as many COPY bytes.

| Metric | Email 683 MB | Email 6.83 GB | Scale factor |
| ------ | -----------: | ------------: | -----------: |
| COPY bytes | 0.683 GB | 6.835 GB | 10.00x |
| SQLite file | 0.685 GB | 6.847 GB | 10.00x |
| Initial-sync wall | 0.981 s | 21.775 s | 22.21x |
| SQLite flush wall | 0.356 s | 8.024 s | 22.55x |
| Non-flush processing wall | 0.140 s | 1.547 s | 11.03x |
| Source/event-loop residual | 0.183 s | 2.016 s | 11.02x |
| Index wall | 0.227 s | 9.858 s | 43.39x |
| Index CPU | 0.217 s | 5.347 s | 24.66x |
| Cgroup peak | 1.172 GB | 3.222 GB | - |
| Memory-limit events | 0 | 29,645 | - |
| Reclaim page scans | 0 | 5,765,951 | - |
| Block reads | 0 | 19.47 GB | - |
| Full I/O pressure | 0 | 5.642 s | - |
| Full memory pressure | 0 | 0.482 s | - |

The 683 MB file fits comfortably and shows no reclaim, block reads, or pressure.
At full volume, the SQLite file is larger than the cgroup, and every run reaches
the limit. Non-flush processing and source residual remain close to linear,
while flush and index wall time grow much faster than bytes. This demonstrates
a cgroup/page-cache capacity regime change, but not a precise threshold or a
specific SQLite pager transition.

Process memory is not the main capacity consumer. At full volume, median process
RSS is 408 MB, heap use is 223 MB, and external memory is 85 MB while the cgroup
reaches 3.22 GB. The pressure is primarily associated with the file-backed
SQLite working set rather than a multi-gigabyte JavaScript heap.

### Index Signature

Three secondary indexes account for nearly all full Email index time:

| Index | Median wall | Median CPU | CPU/wall |
| ----- | ----------: | ---------: | -------: |
| `Email_threadId_createdAt_id_idx` | 3.165 s | 1.824 s | 0.570 |
| `Email_threadId_id_idx` | 3.155 s | 1.763 s | 0.559 |
| `Email_workspaceId_id_idx` | 2.697 s | 1.626 s | 0.593 |
| `Email_pkey` | 0.090 s | 0.008 s | 0.089 |

The operation reads 2.84 final-file equivalents from the block layer. That is
consistent with repeated wide-table scans for the three secondary indexes, but
it does not prove exactly three complete physical scans. The index CPU deficits
and whole-operation I/O pressure show substantial off-CPU time; the counters
cannot prove that every stall occurred during index construction.

This matches the signature previously isolated in
`../initial-sync-bottleneck/findings.md`: post-COPY scans become expensive when
the wide-table working set cannot be retained. This experiment adds
production-shaped phase, CPU, and cgroup measurements without repeating the
prior causal treatment.

## Source Pacing

The raw COPY control and full pipeline copy the same deterministic payload
through the same PostgreSQL container. The raw control discards the stream
instead of parsing and inserting it into SQLite.

| Profile | Raw COPY | Pipeline COPY | Median per-run pipeline/raw |
| ------- | -------: | ------------: | --------------------------: |
| Email 6.83 GB, 1 CPU/3 GiB | 1,178 MB/s | 586 MB/s | 45.5% |
| imports 2.75 GB, 2 CPU/6 GiB | 683 MB/s | 658 MB/s | 96.4% |
| imports 2.75 GB, 1 CPU/6 GiB | 685 MB/s | 644 MB/s | 93.9% |
| imports 2.75 GB, 1 CPU/3 GiB | 685 MB/s | 463 MB/s | 68.6% |

Email remains well below the raw route ceiling in every full run, so the local
source route does not set its throughput. With 6 GiB, imports remains close to
the route ceiling, which is consistent with source pacing. At 3 GiB, raw
throughput is unchanged while pipeline throughput falls, making destination
storage material.

The imports ceiling is a property of this synthetic Docker benchmark, not a
production conclusion. Historical same-pod production COPY-to-null measurements
reached approximately 307-363 MiB/s, or 322-381 decimal MB/s, while
production-shaped pipelines completed at 49-65.5 decimal MB/s. That gap rules
out a broad production source ceiling at 50-65 MB/s.

## Narrow Row Controls

The narrow comparison is fully resource-aligned: both fixtures use one CPU, 3
GiB memory, and a 2,304 MiB Node heap. Neither approaches its memory limit or
records block reads, reclaim, or pressure.

| Metric | Email, 250k rows | imports, 250k rows |
| ------ | ---------------: | -----------------: |
| COPY bytes | 150.9 MB | 54.4 MB |
| SQLite file | 176.5 MB | 86.8 MB |
| Migration wall | 1.692 s | 0.816 s |
| COPY SQLite flush | 0.561 s | 0.144 s |
| COPY non-flush processing | 0.650 s | 0.174 s |
| COPY source/event-loop residual | 0.120 s | 0.074 s |
| Deferred indexes | 0.211 s | 0.250 s |
| Initial-sync CPU/wall | 0.985 | 0.952 |

Median dominant-table destination processing is approximately 4.88
microseconds per Email row and 1.29 microseconds per imports row, a 3.8x ratio.
Email has 25 columns and imports has seven, a 3.6x ratio. This is consistent
with per-field and per-row work contributing, but column count is not an
isolated cause: types, encoded bytes, flush behavior, and statement batching
also differ.

This row-processing difference is not the full-volume Email bottleneck.
Non-flush processing is only 6.6% of its full migration. imports narrow indexing
is slightly slower despite its smaller file because it creates more application
indexes; all substantial narrow index operations have CPU/wall ratios near 1.0.

## Measurement Method

The instrumentation is gated by `ZERO_INITIAL_SYNC_PHASE_MEASUREMENT=1`. An
`AsyncLocalStorage` session follows one schema migration and records setup,
table COPY, indexes, transaction commit, and `ANALYZE`.

Every run validates these accounting identities:

```text
copy wall = destination processing + source/event-loop residual
destination processing = SQLite flush + non-flush processing
migration wall = initial sync + transaction commit + ANALYZE + migration other
```

The measured terms have specific boundaries:

- `SQLite flush` is the synchronous destination `flush()` callback. It includes
  statement binding, execution, and SQLite page work. It is not a durable
  filesystem `fsync` measurement.
- `non-flush processing` is destination callback time outside `flush()`. It
  includes parsing, decoding, allocation, bookkeeping, and other callback work.
- `source/event-loop residual` is stream wall time outside synchronous
  destination callbacks. It can include PostgreSQL delivery, Docker transport,
  stream machinery, scheduling, and GC. It is not pure network or PostgreSQL
  time.
- CPU measurements use `process.cpuUsage()`. A CPU/wall ratio of 0.8 means the
  process consumed approximately 0.8 CPU cores, not 80% of a multi-CPU cgroup.
- Cgroup memory, reclaim, block I/O, and pressure counters cover the complete
  benchmark operation. They are not phase-local.

### Instrumentation Overhead

The same image ran ten AB/BA pairs with measurement disabled and enabled for
each scaled wide fixture:

| Profile | Paired callback change | Paired COPY change | Paired index change |
| ------- | ---------------------: | -----------------: | ------------------: |
| Email 683 MB | -0.85% | -0.92% | -2.70% |
| imports 550 MB | +0.50% | +0.33% | +1.11% |

The scaled profiles show no detectable measurement slowdown beyond ordinary run
variation. This validates the timer path at those sizes, not at full volume.
Wrapper wall time is unsuitable for the overhead decision because scaled Email
commit time ranges from 9 ms to 1.85 seconds.

## Interpretation Limits

- Full results use five repetitions, while narrow results use three or five.
  These are descriptive medians and ranges, not significance claims.
- Resource-control sessions are independent rather than matched pairs.
- The fixtures are synthetic and contain one dominant application table. They
  do not reproduce a complete 91- or 108-table production publication.
- PostgreSQL runs outside the measured application cgroup, so application
  resource counters exclude its CPU and memory.
- Docker block I/O is not equivalent to production local NVMe behavior.
- Zero block reads means no measured block-layer reads, not that SQLite
  performed no logical reads.
- Cgroup pressure and I/O counters cover the whole process. Their association
  with index and flush wall time is strong, but they do not locate every read or
  stall.
- Raw COPY runs before initial sync, and one PostgreSQL container is reused for
  a measurement block. Source cache state can vary.
- Production shadow sync differs from serving initial sync in worker count,
  transaction behavior, and PRAGMAs. Local absolute times are not production
  forecasts.

## Provenance And Evidence

- Source commit: `ea459443f18e7a6f94a32e28333f8af01df1b02b`, matching the cached
  `origin/main` at worktree creation.
- Source worktree: `/Users/chase/.worktree/mono/initial-sync-phase-measurement`.
- Linux image: `zero-initial-sync-phase-measurement:local`, image ID
  `sha256:e7b3a36920e57ff0bca68a63cace7f8735de325852ac79989a42108a25dc8c82`.
- Platform: ARM64 Linux containers on Docker Desktop.
- PostgreSQL: 17 Alpine in a separate container with 2 CPUs and 2 GiB memory.
- Source topology: direct Docker bridge.
- SQLite: `mmap_size=0`, migration `journal_mode=OFF`, and migration
  `synchronous=OFF`, matching the current initial-setup path.
- Initial sync: binary COPY, five table workers, native row-aligned COPY
  messages, and an 8 MiB destination buffer.
- Consolidated analysis:
  `/var/folders/97/c3gvpw6d46g3nm0y2684_cfm0000gn/T/opencode/initial-sync-phase-measurement/analysis.json`.
- Raw result files: `results-overhead.json`, `results-full.json`,
  `results-narrow.json`, `results-imports1cpu.json`, and
  `results-imports1cpu3g.json` in the same temporary directory.
- Measurement runner and aggregator: `run-measurements.mjs` and `analyze.mjs` in
  the same temporary directory.
