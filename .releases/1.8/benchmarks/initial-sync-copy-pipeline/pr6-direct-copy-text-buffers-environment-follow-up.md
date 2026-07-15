# PR 6 Direct COPY Text Buffers: Environment Follow-Up

## Decision

The large constrained-Docker result is reproducible with the actual PR 6 parent
and head, but it is not a portable estimate of end-to-end initial-sync speedup.
The same commits and fixture show a small result on the macOS host, and slowing
COPY delivery on the same Linux images reduces the large callback improvement to
the low single digits.

The clean durable benchmark remains the primary product timing evidence. Its
`wide-text-full` result is +2.51% throughput versus the direct parent and does
not satisfy the planned 5% acceptance gate. A subsequent ten-pair, full-volume
Linux experiment measured a 25.00% paired callback-time reduction and 24.86%
paired whole-operation reduction. Together, the results show that PR 6 removes
JavaScript UTF-8 decoding and allocation, can materially reduce destination work
under a constrained Linux topology, and has strongly environment-dependent
elapsed impact.

## Provenance

The old same-image controls used the dirty omnibus research worktree at base
commit `d87c1c813b2e57abdf814eadda98b8d5e5885979`. They isolate its runtime
string-versus-Buffer toggle, but they are not an independently reviewable PR
diff.

- Six-pair reproduction image:
  `sha256:f4a0e7cbe486e6073f944adcf21f3b4eb47815932376abfd5fcb5d3a3781fb9b`.
- Native-message factorial image:
  `sha256:08c4a7b296357f142bad92fc3cfb32cca2897fea8f77a928f2474618278ba5c2`.
  Its production source was unchanged; only the benchmark harness gained a
  native-message mode.

The current-PR comparisons used:

| Arm                    | Commit                                     | Linux image                                                               |
| ---------------------- | ------------------------------------------ | ------------------------------------------------------------------------- |
| Direct parent PR #6237 | `c4d5519670d50a8bd388f5ce05d5576dc6f97df6` | `sha256:b4b3f29d5af0f11bbdaf9ccffd842439c95d6661f10f7b221720628b75feb776` |
| PR 6 head              | `99442b64afe8f627b8c7d06862efbb51ac3ce540` | `sha256:40904929541f570c1833fa7184d0e74ea8640f6b231229c803df99774109e699` |

`Dockerfile.current-pr6.linux` injects only the benchmark harness through a
named build context. It rebuilds the same `@rocicorp/zero-sqlite3` 1.1.2 addon
from source in both images. No benchmark file was committed to either mono
worktree, and both worktrees were clean at their recorded commits after the
runs.

## Method

Every comparison used the synthetic `email-683m` fixture: 1,000 rows with a
683,000-byte dominant text field. Linux application containers used ARM64, one
CPU, 3 GiB memory, a 2,304 MiB Node heap, an 8 MiB initial-sync buffer, and
`mmap_size=0` unless a factorial explicitly varied mmap. Each treatment ran in a
fresh process and application container. PostgreSQL 17 ran separately with two
CPUs and 2 GiB memory.

Current-PR results use natural PostgreSQL messages. The measured average raw
chunk was 682,755.6 bytes, consistent with one complete `CopyData` message per
large row plus COPY framing.

The tables report two related values:

```text
median elapsed reduction = 1 - head median / parent median
paired elapsed reduction = 1 - median(head repetition / parent repetition)
```

Throughput gain uses the reciprocal ratio and is stated separately where useful.
No confidence interval or statistical significance is claimed.

The host controls matched the clean rerun: Time Machine was stopped, backup
volumes were unmounted, sustained Spotlight indexing was paused, repositories
were marked non-indexable, and unrelated Docker workloads were stopped. Only
`oc` remained as a persistent low-activity container between runs.

## Historical Reproduction

The exact historical-shape rerun first reproduced the old contrast:

| Workload       | String callback | Buffer plus CAST callback | Median reduction |
| -------------- | --------------: | ------------------------: | ---------------: |
| Email 683 MB   |      889.295 ms |                568.433 ms |           36.08% |
| imports 550 MB |     1002.368 ms |                975.253 ms |            2.71% |

A stricter six-pair AB/BA Email block then measured:

| Metric              |     String | Buffer plus CAST | Median reduction | Paired reduction |
| ------------------- | ---------: | ---------------: | ---------------: | ---------------: |
| Callback            | 882.098 ms |       582.927 ms |           33.92% |           34.22% |
| Dominant table COPY | 730.035 ms |       423.370 ms |           42.01% |           41.55% |
| SQLite flush        | 348.328 ms |       222.795 ms |           36.04% |           39.26% |
| Raw COPY control    | 231.874 ms |       230.668 ms |            0.52% |            0.46% |

The callback reduction is equivalent to a 51.5% throughput gain by the median
ratio. The improvement is after the raw source control and is concentrated in
destination processing and SQLite binding/flush work.

## Factorial Controls

### mmap

Four forward/reverse repetitions at each setting showed that mmap changes
absolute callback time but does not create the direct-text effect:

| mmap  | String callback | Buffer callback | Median reduction | Paired reduction |
| ----- | --------------: | --------------: | ---------------: | ---------------: |
| Off   |     1033.825 ms |      692.565 ms |           33.01% |           32.37% |
| 1 GiB |      892.449 ms |      588.346 ms |           34.08% |           34.71% |
| 2 GiB |      887.902 ms |      617.671 ms |           30.43% |           31.10% |

One GiB mmap reduced the string callback by 13.68% versus mmap off, largely by
reducing deferred index time, but raised string-path peak RSS from 337.8 MB to
960.2 MB. Buffer-path RSS rose from 197.8 MB to 859.9 MB. Two GiB provided no
clear callback advantage over 1 GiB. No cgroup memory-max event occurred.

### CPU quota

The gain also survived higher application CPU quotas:

| CPU quota | String callback | Buffer callback | Median reduction | Paired reduction |
| --------- | --------------: | --------------: | ---------------: | ---------------: |
| 2 CPUs    |      788.606 ms |      539.385 ms |           31.60% |           31.56% |
| 4 CPUs    |      767.424 ms |      528.654 ms |           31.11% |           30.96% |

The path is substantially serial, so increasing the quota does not explain the
macOS/Linux difference.

### COPY rechunking

Four forward/reverse repetitions compared the historical synthetic 31,744-byte
rechunker with native row-aligned PostgreSQL messages:

| Input messages         | String callback | Buffer callback | Median reduction | Paired reduction |
| ---------------------- | --------------: | --------------: | ---------------: | ---------------: |
| Native row-aligned     |      820.046 ms |      537.014 ms |           34.51% |           33.87% |
| Synthetic 31,744 bytes |      907.783 ms |      577.621 ms |           36.37% |           36.79% |

Synthetic rechunking slowed the string path 10.70% by medians and the Buffer
path 7.56%. It inflated absolute work but did not cause the direct-text result.

## Current PR Across Environments

Ten fresh AB/BA process pairs used the actual parent and head commits:

| Application environment and source route     | Parent callback | Head callback | Median reduction | Paired reduction |   Parent/head raw COPY |
| -------------------------------------------- | --------------: | ------------: | ---------------: | ---------------: | ---------------------: |
| Linux container, direct Docker bridge        |      934.880 ms |    636.936 ms |           31.87% |           31.07% |   233.144 / 231.063 ms |
| macOS host, PostgreSQL published port        |     2733.031 ms |   2675.337 ms |            2.11% |            1.52% | 1949.895 / 1901.736 ms |
| Linux container, published-host-port hairpin |     6104.671 ms |   5709.557 ms |            6.47% |            4.32% | 4486.099 / 4364.982 ms |

The direct Linux bridge result is a 46.8% throughput gain by median callbacks
and 45.1% by paired callback ratios. The macOS result is 2.2% and 1.5%,
respectively. The Linux host-port sensitivity run is 6.9% and 4.5%.

Raw source throughput changed from about 2,931 MB/s on the direct bridge to
350 MB/s on the macOS host and 155 MB/s through the Linux host-port hairpin.
Changing only the Linux source route reduced the paired callback improvement
from 31.07% to 4.32%. The hairpin path was highly variable and slower than the
production-like source controls, so it demonstrates dilution rather than a
production estimate.

On the direct Linux bridge, the paired reductions were 43.30% for COPY time,
39.75% for flush time, 37.48% for peak RSS, and 64.13% for observed GC time. On
the macOS host, COPY and flush were source-dominated and changed by -1.29% and
+0.60%, while peak RSS and observed GC time still fell 33.82% and 64.10%.

The Linux bridge's post-callback migration and `ANALYZE` wrapper was highly
variable and sometimes larger for the head. Its outer `initReplica` paired
median improved only 2.42% despite the stable 31.07% callback reduction. This is
another reason not to substitute the callback result for the durable benchmark's
whole-operation timing.

## Full-Volume Linux Follow-Up

Two additional five-pair AB/BA blocks used the actual parent and head on the
10,000-row, 6.83 GB Email fixture with the same 1 CPU, 3 GiB, `mmap_size=0`
Linux limits. Starting order was balanced five times in each direction.

| Metric                         | Parent median | Head median | Median change | Paired change |
| ------------------------------ | ------------: | ----------: | ------------: | ------------: |
| Initial-sync callback          |      21.358 s |    16.540 s |       -22.56% |       -25.00% |
| Whole `initReplica` outer time |      21.599 s |    16.758 s |       -22.41% |       -24.86% |
| COPY phase                     |      12.024 s |     7.746 s |       -35.58% |       -42.37% |
| SQLite flush calls             |       8.477 s |     6.172 s |       -27.19% |       -39.40% |
| Deferred index phase           |       8.756 s |     8.994 s |        +2.72% |        +3.75% |
| Raw COPY control               |       5.736 s |     5.798 s |        +1.08% |        +1.69% |
| Peak process RSS               |      399.7 MB |    211.7 MB |       -47.05% |       -47.05% |

Nine of ten pairs favored the head. One retained head outlier regressed 31.25%
while recording unusually high flush, GC, and scoped I/O-pressure time. All 20
containers completed with correct rows, bytes, payload hashes, and zero OOMs.
The paired callback and whole-operation ratios correspond to 33.33% and 33.09%
throughput gains, respectively.

The full result shows that the Linux gain survives pager, flush, and index work;
it is not limited to the 683 MB scaled callback. It remains a synthetic local
Docker result with a variable tail and no confidence interval. See
`pr6-direct-copy-text-buffers-full-linux.md` for every pair and pressure
diagnostics.

## Interpretation

- The large Linux result is present in the actual PR 6 diff. It is not an
  artifact of the old omnibus implementation.
- Synthetic rechunking, mmap, and a one-CPU quota do not create the result.
- Source delivery can hide most destination decoder/binding savings. The
  same-image Linux route change reduced the paired callback effect by more than
  26 percentage points.
- The macOS versus Linux comparison still combines OS, V8/platform behavior,
  and addon prebuild-versus-source-build differences. This follow-up does not
  assign the remaining difference to one of them.
- The subsequent 6.83 GB Linux experiment demonstrates a large full-volume gain
  in this constrained environment, but one of ten pairs regressed and the local
  Docker storage/source topology is not production.
- The canonical clean `wide-text-full` result remains authoritative for the
  preregistered gate. The supported performance statement must name the
  constrained Linux experiment rather than present 25% as a general product
  expectation.

## Evidence

- `results/rerun-docker-direct-text-core-clean-host-docker.json`
- `results/rerun-docker-direct-text-email-balanced-mmap-1g-docker-summary.json`
- `results/rerun-docker-direct-text-email-mmap-factorial-docker-summary.json`
- `results/rerun-docker-direct-text-email-cpu-sweep-docker-summary.json`
- `results/rerun-docker-direct-text-email-chunking-factorial-docker-summary.json`
- `results/rerun-docker-current-pr6-email-native-docker-summary.json`
- `results/rerun-host-current-pr6-email-native-summary.json`
- `results/rerun-docker-current-pr6-email-host-port-docker-summary.json`
- `pr6-direct-copy-text-buffers-full-linux.md`
- `results/rerun-docker-current-pr6-email-full-native-docker-summary.json`
- `results/rerun-docker-current-pr6-email-full-native-confirmation-docker-summary.json`
- Matching aggregate JSON, raw logs, and manifests under `results/`, `raw/`, and
  `manifests/`.
