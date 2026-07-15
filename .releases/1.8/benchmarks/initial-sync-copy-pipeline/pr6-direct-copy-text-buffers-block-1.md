# PR 6 Direct COPY Text Buffers: Block 1

## Scope

This report archives the first benchmark block for PR 6's direct COPY text
buffer work. It compares the original PR 1 benchmark baseline, the direct
parent after PR 2's batched initial-sync COPY metrics, and the PR 6 head.

The matrix ran on 2026-07-14 using these worktrees and refs:

- Original PR #6235 baseline:
  `/Users/chase/.worktree/mono/initial-sync-benchmark-fixtures` at
  `39d42eff905a73ca8ac4a423c873615a0ba71246`. Its tree was verified before the
  run as identical to landed PR #6235 squash `2ca567a2a`.
- Direct parent PR #6237:
  `/Users/chase/.worktree/mono/batch-initial-sync-copy-metrics` at
  `c4d5519670d50a8bd388f5ce05d5576dc6f97df6`. Its tree was verified before the
  run as identical to landed PR #6237 squash `ea459443f`.
- PR 6 head: `/Users/chase/.worktree/mono/direct-copy-text-buffers` at pushed
  commit `99442b64afe8f627b8c7d06862efbb51ac3ce540`.

The original PR #6235 benchmark file was temporarily adjusted before the run
to use the same reduced repetition counts as the parent and head. No production
code was backported or changed. The three arms therefore used identical
profiles, payload sizes, warmup counts, and measured repetition counts.

There was no active OTel benchmark harness. No parser benchmarks were run.

## Method

Every arm was launched from its worktree's `packages/zero-cache` directory as
one isolated process invocation:

```sh
NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=<profile> pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts
```

All 21 invocations ran sequentially in the prescribed rotation, with no
competing benchmark and no rerun of a successful arm. Each invocation included
one discarded warmup followed by the configured measured repetitions. The
full profiles were confirmation runs with three measured samples; their
commands received 30-minute timeouts.

| Profile                | Rows    | Decimal payload MB | Warmups | Measured repetitions |
| ---------------------- | ------- | -----------------: | ------: | -------------------: |
| `mixed-regression`     | 250,000 |         493.787499 |       1 |                    5 |
| `wide-text-scaled`     | 1,000   |                683 |       1 |                   10 |
| `wide-text-full`       | 10,000  |              6,830 |       1 |                    3 |
| `wide-text-narrow`     | 250,000 |                 32 |       1 |                   10 |
| `large-payload-scaled` | 2,000   |                550 |       1 |                   10 |
| `large-payload-full`   | 10,000  |              2,750 |       1 |                    3 |
| `large-payload-narrow` | 250,000 |                 32 |       1 |                   10 |

This is one invocation per arm. The results do not have a confidence interval.

## Actual Order And Status

1. `mixed-regression`, PR #6235: PASS, exit 0, 81.57 s
2. `mixed-regression`, parent: PASS, exit 0, 63.88 s
3. `mixed-regression`, head: PASS, exit 0, 53.74 s
4. `wide-text-scaled`, head: PASS, exit 0, 76.71 s
5. `wide-text-scaled`, parent: PASS, exit 0, 97.76 s
6. `wide-text-scaled`, PR #6235: PASS, exit 0, 103.75 s
7. `wide-text-full` confirmation, parent: PASS, exit 0, 365.64 s
8. `wide-text-full` confirmation, PR #6235: PASS, exit 0, 347.44 s
9. `wide-text-full` confirmation, head: PASS, exit 0, 375.46 s
10. `wide-text-narrow`, PR #6235: PASS, exit 0, 56.39 s
11. `wide-text-narrow`, head: PASS, exit 0, 49.59 s
12. `wide-text-narrow`, parent: PASS, exit 0, 57.60 s
13. `large-payload-scaled`, head: PASS, exit 0, 59.21 s
14. `large-payload-scaled`, PR #6235: PASS, exit 0, 74.31 s
15. `large-payload-scaled`, parent: PASS, exit 0, 63.32 s
16. `large-payload-full` confirmation, parent: PASS, exit 0, 122.93 s
17. `large-payload-full` confirmation, head: PASS, exit 0, 109.70 s
18. `large-payload-full` confirmation, PR #6235: PASS, exit 0, 115.18 s
19. `large-payload-narrow`, PR #6235: PASS, exit 0, 38.33 s
20. `large-payload-narrow`, parent: PASS, exit 0, 32.40 s
21. `large-payload-narrow`, head: PASS, exit 0, 38.11 s

All 21 requested arms passed. There were no failed or not-run arms.

## Calculations

The recorder values are nanoseconds per decimal MB. Median and average-stat
MiB/s use:

```text
(1e9 / stat) * (1_000_000 / 1_048_576)
```

"Average-stat MiB/s" converts the recorder's average ns/MB statistic; it is not
an arithmetic mean of per-sample throughput. Median and average elapsed seconds
use the corresponding recorder statistic and the profile's known decimal
payload:

```text
elapsedSeconds = stat * decimalPayloadMB / 1e9
```

The speedups use median MiB/s:

```text
direct speedup = (head / parent - 1) * 100%
cumulative speedup = (head / PR #6235 - 1) * 100%
```

## Results

Computed values below use the exact recorder statistics and are displayed to
six decimal places.

| Profile                           | Reps | Head median MiB/s | Head avg-stat MiB/s | Head median elapsed | Head avg elapsed | Direct speedup | Cumulative speedup |
| --------------------------------- | ---: | ----------------: | ------------------: | ------------------: | ---------------: | -------------: | -----------------: |
| `mixed-regression`                |    5 |        181.789683 |          170.507665 |          2.590425 s |       2.761826 s |     +1.572260% |        -10.636784% |
| `wide-text-scaled`                |   10 |        302.173746 |          268.798102 |          2.155580 s |       2.423230 s |     +5.933142% |        +13.265573% |
| `wide-text-full` confirmation     |    3 |        111.082501 |          107.418942 |         58.637459 s |      60.637309 s |    -16.987532% |        -17.976315% |
| `wide-text-narrow`                |   10 |         14.732543 |           14.227542 |          2.071440 s |       2.144965 s |    +23.862171% |         +5.348865% |
| `large-payload-scaled`            |   10 |        281.924131 |          253.872651 |          1.860504 s |       2.066079 s |    +15.230132% |        +42.609921% |
| `large-payload-full` confirmation |    3 |        224.773232 |          221.898120 |         11.667779 s |      11.818957 s |    +23.861811% |         -6.749946% |
| `large-payload-narrow`            |   10 |         26.540448 |           24.934109 |          1.149852 s |       1.223929 s |    -10.449607% |         +9.209380% |

The two full profiles are confirmation runs, not high-confidence estimates.
Each has one invocation per arm and only three measured samples. No confidence
interval is claimed for any profile.

## Exact Recorder JSON

The following are the unmodified JSON objects emitted by the 21 benchmark
invocations, in actual execution order. Recorder statistics are nanoseconds per
decimal MB.

```text
01 mixed-regression PR #6235
{"benchmarks":[{"name":"zero-cache/initial-sync mixed-regression generated fixture payload MB","stats":{"min":4122899.1117087845,"max":5938580.879302504,"avg":4866105.976490105,"median":4688022.016936477,"p75":5153700.742027085,"p99":5153700.742027085}}]}

02 mixed-regression parent
{"benchmarks":[{"name":"zero-cache/initial-sync mixed-regression generated fixture payload MB","stats":{"min":3776542.7168094465,"max":12096009.862736518,"avg":6525090.259119742,"median":5328512.2756823795,"p75":7256402.060109657,"p99":7256402.060109657}}]}

03 mixed-regression head
{"benchmarks":[{"name":"zero-cache/initial-sync mixed-regression generated fixture payload MB","stats":{"min":2993874.2272614716,"max":9102753.227051623,"avg":5593146.30360863,"median":5246031.028015151,"p75":5402529.522117372,"p99":5402529.522117372}}]}

04 wide-text-scaled head
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-scaled generated fixture payload MB","stats":{"min":2721220.28989751,"max":5271398.670571002,"avg":3547920.571156662,"median":3156046.242313333,"p75":3687205.6500732056,"p99":4807497.193265007}}]}

05 wide-text-scaled parent
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-scaled generated fixture payload MB","stats":{"min":2279043.0087847714,"max":24272712.78623718,"avg":6247931.497071745,"median":3343298.956808204,"p75":3449927.2196193314,"p99":13154052.95314788}}]}

06 wide-text-scaled PR #6235
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-scaled generated fixture payload MB","stats":{"min":3024916.240117139,"max":10666523.426061507,"avg":4486412.286530018,"median":3574713.8543191804,"p75":3967598.645680815,"p99":6142549.17130308}}]}

07 wide-text-full parent
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-full generated fixture payload MB","stats":{"min":6620621.236017573,"max":7271597.877013178,"avg":7006357.16408004,"median":7126852.379209369,"p75":7126852.379209369,"p99":7126852.379209369}}]}

08 wide-text-full PR #6235
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-full generated fixture payload MB","stats":{"min":6053277.781844802,"max":7823510.224450946,"avg":6972916.855783307,"median":7041962.561054173,"p75":7041962.561054173,"p99":7041962.561054173}}]}

09 wide-text-full head
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-full generated fixture payload MB","stats":{"min":6958822.187701322,"max":11090148.237042457,"avg":8878083.292728161,"median":8585279.453440703,"p75":8585279.453440703,"p99":8585279.453440703}}]}

10 wide-text-narrow PR #6235
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-narrow generated fixture payload MB","stats":{"min":62470822.90625002,"max":76757227.8749999,"avg":68777291.39999996,"median":68194951.17187494,"p75":70054231.78124988,"p99":74262398.4375}}]}

11 wide-text-narrow head
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-narrow generated fixture payload MB","stats":{"min":54359513.03125,"max":86657906.25,"avg":67030151.559375,"median":64732497.390624985,"p75":68952123.68750003,"p99":82508921.87499994}}]}

12 wide-text-narrow parent
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-narrow generated fixture payload MB","stats":{"min":61175601.56249988,"max":95161735.6562499,"avg":80709609.115625,"median":80179076.82812503,"p75":84082820.31250007,"p99":92171237.00000001}}]}

13 large-payload-scaled head
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-scaled generated fixture payload MB","stats":{"min":2745179.6963636363,"max":6802569.69818182,"avg":3756506.71218182,"median":3382733.9009090993,"p75":3562342.9545454565,"p99":4542255.22727273}}]}

14 large-payload-scaled PR #6235
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-scaled generated fixture payload MB","stats":{"min":3260624.241818183,"max":5572228.710909098,"avg":4708475.826,"median":4824114.129090909,"p75":5331669.772727261,"p99":5424439.772727267}}]}

15 large-payload-scaled parent
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-scaled generated fixture payload MB","stats":{"min":3158589.545454544,"max":5440935.909090906,"avg":4026899.924181816,"median":3897928.7509090863,"p75":4065379.167272728,"p99":4749071.741818182}}]}

16 large-payload-full parent
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-full generated fixture payload MB","stats":{"min":3694934.227272725,"max":6349977.59090909,"avg":5100052.080727273,"median":5255244.4240000015,"p75":5255244.4240000015,"p99":5255244.4240000015}}]}

17 large-payload-full head
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-full generated fixture payload MB","stats":{"min":3566780.878909091,"max":5083798.242545454,"avg":4297802.601090907,"median":4242828.681818178,"p75":4242828.681818178,"p99":4242828.681818178}}]}

18 large-payload-full PR #6235
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-full generated fixture payload MB","stats":{"min":3921217.7421818166,"max":4831711.439272727,"avg":4236456.403999998,"median":3956440.030545451,"p75":3956440.030545451,"p99":3956440.030545451}}]}

19 large-payload-narrow PR #6235
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-narrow generated fixture payload MB","stats":{"min":36600158.84375002,"max":47689325.53125001,"avg":40482192.059374996,"median":39242057.95312497,"p75":41965251.28125001,"p99":42514600.281250015}}]}

20 large-payload-narrow parent
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-narrow generated fixture payload MB","stats":{"min":27932993.46875,"max":47577227.84374994,"avg":34042876.16562499,"median":32178020.828125,"p75":35126083.34375,"p99":39487957.03125001}}]}

21 large-payload-narrow head
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-narrow generated fixture payload MB","stats":{"min":32445182.312499925,"max":47095049.46875001,"avg":38247780.596874975,"median":35932863.9375,"p75":40736694,"p99":46771190.09374996}}]}
```

## Cleanup And Final Status

- The original PR #6235 benchmark file's temporary `mixed-regression`,
  `wide-text-full`, and `large-payload-full` repetition counts were restored to
  10 with `apply_patch`; all warmups remained 1.
- The PR #6235 worktree was clean at
  `39d42eff905a73ca8ac4a423c873615a0ba71246`, with its upstream reported as
  gone.
- The parent worktree was clean at
  `c4d5519670d50a8bd388f5ce05d5576dc6f97df6`, with its upstream also reported
  as gone.
- The head worktree was clean at
  `99442b64afe8f627b8c7d06862efbb51ac3ce540`, and its upstream matched the same
  pushed SHA.
- The post-run check found one leftover benchmark PostgreSQL database,
  `initial_sync_bench_mixed_regression_4`, in the pre-existing test container.
  It was removed.
- The final check found no benchmark PostgreSQL database, SQLite file, or
  benchmark process.
- The container list was unchanged from preflight, and no benchmark container
  was left behind. Existing zmail containers were not modified.
- No code, commit, staging area, or branch was changed by the benchmark run.
