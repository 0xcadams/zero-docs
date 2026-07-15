# PR 6 Direct COPY Text Buffers

## Scope And Provenance

This report summarizes the clean local rerun for direct Buffer binding of
eligible COPY text-like fields through SQLite `CAST(? AS TEXT)`. Two earlier
blocks are retained as historical evidence but are superseded for the PR timing
table because unrelated host activity may have contaminated them. A subsequent
environment follow-up explains why the old constrained-Docker result was much
larger without replacing the clean full-operation benchmark as the primary PR
evidence.

- Original baseline: PR #6235 landed as `2ca567a2a`, measured through the
  tree-identical `39d42eff` worktree.
- Direct parent: PR #6237 landed as `ea459443f`, measured through the
  tree-identical `c4d551967` worktree.
- Head: pushed commit `99442b64afe8f627b8c7d06862efbb51ac3ce540`.
- Environment: Apple M5 Pro local development machine without resource
  constraints. This is a local comparison only.

## Correctness And Diff

- Decoder unit tests passed: 76 tests.
- Focused zqlite tests passed: 5 tests.
- The focused direct-binding initial-sync test passed on PostgreSQL 15, 16, 17,
  and 18.
- The binary decoder PostgreSQL integration suite passed on PostgreSQL 15 and
  18, with 25 tests on each version.
- zero-cache and zqlite typechecks passed.
- Changed-file lint completed with 0 errors and 33 existing warnings. Formatting
  and `git diff --check` passed.
- The production diff contains only `pg-copy-binary.ts` and `initial-sync.ts`.
  The test diff covers decoder, initial-sync PostgreSQL, and zqlite tests. There
  is no dependency, lockfile, or native API change.

## Clean Rerun Results

All 21 baseline, parent, and head processes ran sequentially after stopping
Time Machine, unmounting its backup volume and snapshot, and pausing sustained
Spotlight indexing. Each arm is still one benchmark process; internal recorder
samples are not independent process experiments.

| Profile                | Measurements + warmup | Head median MiB/s | Head average-stat MiB/s | Head median elapsed | Head average elapsed | Direct vs #6237 | Cumulative vs #6235 |
| ---------------------- | --------------------- | ----------------: | ----------------------: | ------------------: | -------------------: | --------------: | ------------------: |
| `mixed-regression`     | 5 + 1                 |            399.49 |                  386.02 |              1.18 s |               1.22 s |          +2.89% |              +8.17% |
| `wide-text-scaled`     | 10 + 1                |            506.63 |                  473.83 |              1.29 s |               1.37 s |          +3.37% |              +4.74% |
| `wide-text-full`       | 3 + 1                 |            197.45 |                  198.06 |             32.99 s |              32.89 s |          +2.51% |             +14.00% |
| `wide-text-narrow`     | 10 + 1                |             22.01 |                   21.96 |              1.39 s |               1.39 s |         +13.03% |             +14.11% |
| `large-payload-scaled` | 10 + 1                |            423.25 |                  419.78 |              1.24 s |               1.25 s |          +2.25% |              +1.55% |
| `large-payload-full`   | 3 + 1                 |            407.33 |                  406.20 |              6.44 s |               6.46 s |          +4.01% |              -4.64% |
| `large-payload-narrow` | 10 + 1                |             41.09 |                   40.84 |              0.74 s |               0.75 s |          +9.22% |              +9.50% |

No confidence interval or statistical significance is claimed.

## Environment Follow-Up

Ten fresh AB/BA process pairs compared the actual direct parent and PR 6 head on
the 683 MB Email fixture. Callback timing begins and ends around `initialSync`;
it excludes the post-callback migration and `ANALYZE` wrapper included in the
durable benchmark's whole `initReplica` timing.

| Environment and source route                 | Parent callback | Head callback | Median reduction | Paired reduction |   Parent/head raw COPY |
| -------------------------------------------- | --------------: | ------------: | ---------------: | ---------------: | ---------------------: |
| Linux container, direct Docker bridge        |      934.880 ms |    636.936 ms |           31.87% |           31.07% |   233.144 / 231.063 ms |
| macOS host, PostgreSQL published port        |     2733.031 ms |   2675.337 ms |            2.11% |            1.52% | 1949.895 / 1901.736 ms |
| Linux container, published-host-port hairpin |     6104.671 ms |   5709.557 ms |            6.47% |            4.32% | 4486.099 / 4364.982 ms |

Changing only the Linux source route reduced the paired callback effect from
31.07% to 4.32%. Separate mmap, 2/4-CPU, and native-versus-synthetic-chunk
factorials did not collapse the direct Linux bridge result. The large callback
gain is real for that fast-source Linux topology, but source delivery and the
whole-operation timing boundary strongly dilute it elsewhere. The host-port
hairpin was slower and more variable than the production-like source controls,
so it is a sensitivity test rather than a product estimate.

## Full-Volume Linux Follow-Up

Two five-pair AB/BA blocks then compared the actual parent and head on the
10,000-row, 6.83 GB Email fixture under the same 1 CPU, 3 GiB,
`mmap_size=0` Linux limits. Five pairs began with each arm.

| Metric                         | Parent median | Head median | Median change | Paired change |
| ------------------------------ | ------------: | ----------: | ------------: | ------------: |
| Initial-sync callback          |      21.358 s |    16.540 s |       -22.56% |       -25.00% |
| Whole `initReplica` outer time |      21.599 s |    16.758 s |       -22.41% |       -24.86% |
| COPY phase                     |      12.024 s |     7.746 s |       -35.58% |       -42.37% |
| SQLite flush calls             |       8.477 s |     6.172 s |       -27.19% |       -39.40% |
| Deferred index phase           |       8.756 s |     8.994 s |        +2.72% |        +3.75% |
| Raw COPY control               |       5.736 s |     5.798 s |        +1.08% |        +1.69% |
| Peak process RSS               |      399.7 MB |    211.7 MB |       -47.05% |       -47.05% |

Nine of ten pairs favored the head. The paired callback and whole-operation
ratios correspond to 33.33% and 33.09% throughput gains. One retained head
outlier regressed 31.25% with unusually high flush, GC, and I/O-pressure time;
all runs completed correctly with zero OOMs.

## Interpretation

- The clean block is directionally positive in all seven direct comparisons.
  Mixed and the four scaled/full large-field lanes improve by 2.25-4.01%, while
  the two narrow/high-row-count lanes improve by 9.22-13.03%.
- The results still do not satisfy the planned at-least-5% `wide-text-full`
  acceptance gate; that direct result is +2.51%.
- The fresh-process host comparison independently agrees that the effect is
  small in the unconstrained local environment, while the constrained Linux
  comparison now demonstrates a large full-volume whole-operation gain.
- The supported performance statement must identify the synthetic 1 CPU/3 GiB
  Linux experiment, its 9-of-10 pair result, and its variable tail. It cannot
  present 25% as a general product expectation or a substitute for the canonical
  gate.
- The semantic claim remains removal of JavaScript UTF-8 decoding and allocation
  for eligible known text-like fields while preserving tested SQLite behavior.
  No confidence interval is claimed.
- At user direction, zmail smoke, scaled, and full validation is deferred until
  after merge. No zmail result is part of this PR evidence.

## Raw Reports

- `pr6-direct-copy-text-buffers-clean-rerun.md`
- `pr6-direct-copy-text-buffers-environment-follow-up.md`
- `pr6-direct-copy-text-buffers-full-linux.md`
- `pr6-direct-copy-text-buffers-block-1.md`
- `pr6-direct-copy-text-buffers-block-2.md`
