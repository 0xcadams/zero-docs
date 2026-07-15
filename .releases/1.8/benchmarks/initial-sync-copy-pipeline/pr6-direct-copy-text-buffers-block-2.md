# PR 6 Direct Text Buffer Copy Benchmark, Block 2

## Scope

This archive records the second, reversed-order direct parent/head benchmark
block for PR 6. It preserves the complete aggregate JSON emitted by all 14
processes, their execution order and status, the second-block calculations, and
the two-block descriptive calculation based on process medians.

- Run date: 2026-07-14
- Package directory: `packages/zero-cache`
- Execution: sequential only, with no competing benchmarks and no reruns
- External command timeout: 1,800,000 ms (30 minutes) per invocation
- Warmups: one discarded warmup per process
- Parent worktree:
  `/Users/chase/.worktree/mono/batch-initial-sync-copy-metrics`
- Parent commit: `c4d5519670d50a8bd388f5ce05d5576dc6f97df6`
- Parent tree: `b57cf7119f35353ec737a9e969ba1a8728a58a9d`
- Landed equivalent: `ea459443f` has the same
  `b57cf7119f35353ec737a9e969ba1a8728a58a9d` tree
- Head worktree: `/Users/chase/.worktree/mono/direct-copy-text-buffers`
- Head pushed commit: `99442b64afe8f627b8c7d06862efbb51ac3ce540`
- Head tree: `3e94a54aed13f5d31a8454c721572d288f2c4b3d`

Both worktrees were clean and at the requested commits before the block. They
were clean and at the same commits after the block.

## Profiles And Samples

The benchmark recorder reports nanoseconds per decimal MB of generated text
payload. Every process discarded one warmup before recording the indicated
number of measured samples.

| Profile                |    Rows | Generated payload MB (decimal) | Warmups | Measured samples |
| ---------------------- | ------: | -----------------------------: | ------: | ---------------: |
| `mixed-regression`     | 250,000 |                     493.787499 |       1 |                5 |
| `wide-text-scaled`     |   1,000 |                            683 |       1 |               10 |
| `wide-text-full`       |  10,000 |                          6,830 |       1 |                3 |
| `wide-text-narrow`     | 250,000 |                             32 |       1 |               10 |
| `large-payload-scaled` |   2,000 |                            550 |       1 |               10 |
| `large-payload-full`   |  10,000 |                          2,750 |       1 |                3 |
| `large-payload-narrow` | 250,000 |                             32 |       1 |               10 |

The two full profiles have only three measured samples after one warmup. Their
process median is therefore the middle of three observations, and their average
is particularly sensitive to any one observation. The full-profile results are
descriptive evidence, not a precise estimate of a sampling distribution. No
confidence interval is available for this block or for the two-block summary.

## Ordered Commands

Every invocation used `/usr/bin/time -p` to record command wall time. The
benchmark command itself was otherwise the requested command, with `env`
supplying the three environment variables. Each invocation had an external
1,800,000 ms timeout.

```sh
# 1. cwd: /Users/chase/.worktree/mono/direct-copy-text-buffers/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=mixed-regression pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 2. cwd: /Users/chase/.worktree/mono/batch-initial-sync-copy-metrics/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=mixed-regression pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 3. cwd: /Users/chase/.worktree/mono/batch-initial-sync-copy-metrics/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=wide-text-scaled pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 4. cwd: /Users/chase/.worktree/mono/direct-copy-text-buffers/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=wide-text-scaled pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 5. cwd: /Users/chase/.worktree/mono/direct-copy-text-buffers/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=wide-text-full pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 6. cwd: /Users/chase/.worktree/mono/batch-initial-sync-copy-metrics/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=wide-text-full pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 7. cwd: /Users/chase/.worktree/mono/batch-initial-sync-copy-metrics/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=wide-text-narrow pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 8. cwd: /Users/chase/.worktree/mono/direct-copy-text-buffers/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=wide-text-narrow pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 9. cwd: /Users/chase/.worktree/mono/batch-initial-sync-copy-metrics/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=large-payload-scaled pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 10. cwd: /Users/chase/.worktree/mono/direct-copy-text-buffers/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=large-payload-scaled pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 11. cwd: /Users/chase/.worktree/mono/direct-copy-text-buffers/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=large-payload-full pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 12. cwd: /Users/chase/.worktree/mono/batch-initial-sync-copy-metrics/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=large-payload-full pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 13. cwd: /Users/chase/.worktree/mono/direct-copy-text-buffers/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=large-payload-narrow pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts

# 14. cwd: /Users/chase/.worktree/mono/batch-initial-sync-copy-metrics/packages/zero-cache
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=large-payload-narrow pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts
```

## Order, Status, And Durations

`Command real` is the wall time emitted by `/usr/bin/time -p`. `Vitest duration`
is Vitest's reported process duration. All commands completed before their
30-minute external timeout.

| Order | Profile                | Arm    | Exit status | Command real | Vitest duration |
| ----: | ---------------------- | ------ | ----------: | -----------: | --------------: |
|     1 | `mixed-regression`     | head   |           0 |      38.23 s |         37.31 s |
|     2 | `mixed-regression`     | parent |           0 |      44.83 s |         43.42 s |
|     3 | `wide-text-scaled`     | parent |           0 |      60.80 s |         60.06 s |
|     4 | `wide-text-scaled`     | head   |           0 |      65.95 s |         65.06 s |
|     5 | `wide-text-full`       | head   |           0 |     336.16 s |        335.28 s |
|     6 | `wide-text-full`       | parent |           0 |     386.16 s |        385.23 s |
|     7 | `wide-text-narrow`     | parent |           0 |      58.27 s |         57.33 s |
|     8 | `wide-text-narrow`     | head   |           0 |      64.61 s |         63.43 s |
|     9 | `large-payload-scaled` | parent |           0 |      98.26 s |         94.59 s |
|    10 | `large-payload-scaled` | head   |           0 |      70.94 s |         69.14 s |
|    11 | `large-payload-full`   | head   |           0 |     126.39 s |        125.21 s |
|    12 | `large-payload-full`   | parent |           0 |     115.98 s |        115.02 s |
|    13 | `large-payload-narrow` | head   |           0 |      39.48 s |         38.61 s |
|    14 | `large-payload-narrow` | parent |           0 |      39.11 s |         38.18 s |

## Exact Recorder JSON

The following lines are the exact aggregate JSON objects emitted by the 14
processes, in execution order. Values are nanoseconds per decimal MB.

### 1. Head, `mixed-regression`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync mixed-regression generated fixture payload MB","stats":{"min":2748478.4340399047,"max":3508205.7980572716,"avg":3040758.7677710704,"median":2876627.7738432568,"p75":3289406.972208496,"p99":3289406.972208496}}]}
```

### 2. Parent, `mixed-regression`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync mixed-regression generated fixture payload MB","stats":{"min":3010885.6765529425,"max":5984894.492033307,"avg":4294382.916324093,"median":4563392.916109447,"p75":4794020.210706063,"p99":4794020.210706063}}]}
```

### 3. Parent, `wide-text-scaled`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-scaled generated fixture payload MB","stats":{"min":2280554.1727672014,"max":2885197.3528550495,"avg":2591003.154026353,"median":2597194.4853587113,"p75":2667506.40556368,"p99":2844173.437774527}}]}
```

### 4. Head, `wide-text-scaled`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-scaled generated fixture payload MB","stats":{"min":2380098.5226939972,"max":3363872.9868228384,"avg":2730967.7827232806,"median":2631138.1771595897,"p75":2718667.093704244,"p99":3297659.3455344113}}]}
```

### 5. Head, `wide-text-full`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-full generated fixture payload MB","stats":{"min":5470364.427672035,"max":8365098.273499268,"avg":6862158.904734016,"median":6751014.013030747,"p75":6751014.013030747,"p99":6751014.013030747}}]}
```

### 6. Parent, `wide-text-full`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-full generated fixture payload MB","stats":{"min":7542381.47262079,"max":8177515.78828697,"avg":7947744.440361152,"median":8123336.060175697,"p75":8123336.060175697,"p99":8123336.060175697}}]}
```

### 7. Parent, `wide-text-narrow`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-narrow generated fixture payload MB","stats":{"min":70649178.40624997,"max":89843637.99999994,"avg":80411114.58437502,"median":79660944.65625003,"p75":81554165.37500013,"p99":89409641.93750006}}]}
```

### 8. Head, `wide-text-narrow`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-narrow generated fixture payload MB","stats":{"min":69927658.87499991,"max":102497414.06249996,"avg":80708988.678125,"median":79784094.42187493,"p75":81061329.40625003,"p99":83660626.31249997}}]}
```

### 9. Parent, `large-payload-scaled`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-scaled generated fixture payload MB","stats":{"min":4869974.392727268,"max":8643670.756363638,"avg":6725105.477272725,"median":6899035.5299999975,"p75":7264010.834545453,"p99":8501631.590909092}}]}
```

### 10. Head, `large-payload-scaled`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-scaled generated fixture payload MB","stats":{"min":3224130.98545454,"max":5175257.5,"avg":3996393.0681818193,"median":4045502.3490909133,"p75":4230016.438181814,"p99":4689830.0763636315}}]}
```

### 11. Head, `large-payload-full`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-full generated fixture payload MB","stats":{"min":3442039.060363636,"max":7022406.1363636395,"avg":4918257.661454546,"median":4290327.787636364,"p75":4290327.787636364,"p99":4290327.787636364}}]}
```

### 12. Parent, `large-payload-full`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-full generated fixture payload MB","stats":{"min":3636890.7578181825,"max":4564613.772727274,"avg":3971787.949575759,"median":3713859.3181818197,"p75":3713859.3181818197,"p99":3713859.3181818197}}]}
```

### 13. Head, `large-payload-narrow`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-narrow generated fixture payload MB","stats":{"min":33359634.093750004,"max":55182826.81249997,"avg":37294506.634375,"median":35400703.12499995,"p75":36136407.53125003,"p99":39358554.68750003}}]}
```

### 14. Parent, `large-payload-narrow`

```text
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-narrow generated fixture payload MB","stats":{"min":37222558.59374996,"max":47684095.06249998,"avg":40528008.07187501,"median":39368561.84375,"p75":41332681.0000001,"p99":45439891.906250015}}]}
```

## Formulas

The recorder's operation count is decimal MB of generated text payload, so each
JSON statistic is normalized nanoseconds per decimal MB.

```text
MiB/s = 10^15 / (nsPerDecimalMB * 1_048_576)

elapsedSeconds =
  nsPerDecimalMB * generatedPayloadDecimalMB / 10^9

headMedianThroughput / parentMedianThroughput =
  parentMedianNsPerDecimalMB / headMedianNsPerDecimalMB

twoBlockProcessMedian =
  (block1ProcessMedian + block2ProcessMedian) / 2
```

"Average-stat MiB/s" is the inverse of the recorder's average normalized-time
statistic. It is not an average of unavailable per-sample throughput values.
The two-block process median is the median of two process medians; with two
values, that is their arithmetic midpoint.

## Second-Block Results

The MiB/s and elapsed columns show `median / average-stat`. A speedup above
`1.0x` means head had higher median throughput than parent.

| Profile                | Payload decimal MB |      Parent MiB/s |        Head MiB/s |      Parent elapsed s |        Head elapsed s | Direct median speedup |
| ---------------------- | -----------------: | ----------------: | ----------------: | --------------------: | --------------------: | --------------------: |
| `mixed-regression`     |         493.787499 | 208.984 / 222.075 | 331.525 / 313.630 |   2.253346 / 2.120513 |   1.420443 / 1.501489 |  1.586369x (+58.637%) |
| `wide-text-scaled`     |                683 | 367.194 / 368.071 | 362.457 / 349.207 |   1.773884 / 1.769655 |   1.797067 / 1.865251 |   0.987099x (-1.290%) |
| `wide-text-full`       |              6,830 | 117.399 / 119.993 | 141.264 / 138.976 | 55.482385 / 54.283095 | 46.109426 / 46.868545 |  1.203276x (+20.328%) |
| `wide-text-narrow`     |                 32 |   11.972 / 11.860 |   11.953 / 11.816 |   2.549150 / 2.573156 |   2.553091 / 2.582688 |   0.998456x (-0.154%) |
| `large-payload-scaled` |                550 | 138.233 / 141.808 | 235.737 / 238.634 |   3.794470 / 3.698808 |   2.225026 / 2.198016 |  1.705359x (+70.536%) |
| `large-payload-full`   |              2,750 | 256.788 / 240.112 | 222.285 / 193.905 | 10.213113 / 10.922417 | 11.798401 / 13.525209 |  0.865635x (-13.436%) |
| `large-payload-narrow` |                 32 |   24.224 / 23.531 |   26.939 / 25.571 |   1.259794 / 1.296896 |   1.132822 / 1.193424 |  1.112084x (+11.208%) |

## Two-Block Process-Median Summary

Block 1 retained only the following process medians, in nanoseconds per decimal
MB. The table preserves every block-1 and block-2 process median rather than
replacing either block. `Midpoint` is the arithmetic midpoint of the two
process medians for that arm, and speedup is parent midpoint divided by head
midpoint.

No raw samples from block 1 were available. No raw samples were pooled or
discarded, and no block was discarded. This is a descriptive process-median
summary; no confidence interval is available.

| Profile                |          Parent B1 |          Parent B2 |    Parent midpoint |            Head B1 |            Head B2 |      Head midpoint |  Head/parent speedup |
| ---------------------- | -----------------: | -----------------: | -----------------: | -----------------: | -----------------: | -----------------: | -------------------: |
| `mixed-regression`     | 5328512.2756823795 |  4563392.916109447 |  4945952.595895913 |  5246031.028015151 | 2876627.7738432568 | 4061329.4009292037 | 1.217816x (+21.782%) |
| `wide-text-scaled`     |  3343298.956808204 | 2597194.4853587113 | 2970246.7210834576 |  3156046.242313333 | 2631138.1771595897 | 2893592.2097364613 |  1.026491x (+2.649%) |
| `wide-text-full`       |  7126852.379209369 |  8123336.060175697 |  7625094.219692534 |  8585279.453440703 |  6751014.013030747 |  7668146.733235725 |  0.994386x (-0.561%) |
| `wide-text-narrow`     |  80179076.82812503 |  79660944.65625003 |  79920010.74218753 | 64732497.390624985 |  79784094.42187493 |  72258295.90624996 | 1.106032x (+10.603%) |
| `large-payload-scaled` | 3897928.7509090863 | 6899035.5299999975 |  5398482.140454542 | 3382733.9009090993 | 4045502.3490909133 | 3714118.1250000065 | 1.453503x (+45.350%) |
| `large-payload-full`   | 5255244.4240000015 | 3713859.3181818197 |   4484551.87109091 |  4242828.681818178 |  4290327.787636364 |  4266578.234727271 |  1.051089x (+5.109%) |
| `large-payload-narrow` |    32178020.828125 |     39368561.84375 |   35773291.3359375 |      35932863.9375 |  35400703.12499995 |  35666783.53124997 |  1.002986x (+0.299%) |

## Cleanup Verification

- Parent remained clean at
  `c4d5519670d50a8bd388f5ce05d5576dc6f97df6`.
- Head remained clean at `99442b64afe8f627b8c7d06862efbb51ac3ce540`.
- No Vitest, initial-sync benchmark, or matching Node process remained.
- No `initial-sync-bench-*.db*` SQLite file remained under the system temporary
  directory.
- No `initial_sync_bench_%` PostgreSQL database remained.
- No PostgreSQL 17 container created by this block remained. One older
  testcontainers PostgreSQL 17 container predated the block and had no matching
  benchmark database.
- No mono, zmail, or existing zero-docs file was modified by the benchmark
  block. No commit, push, staging change, or branch change was made.
