# PR 6 Direct COPY Text Buffers: Clean Rerun

## Scope

This report archives a complete clean rerun of the original PR #6235 baseline,
the direct PR #6237 parent, and the PR 6 direct-text-buffer head. The rerun was
requested because unrelated local processes may have contaminated the two prior
blocks.

The prior blocks remain archived, but this contemporaneous three-arm block is
the primary PR 6 timing evidence.

## Provenance

| Arm | Worktree | Commit | Tree |
| --- | --- | --- | --- |
| Original PR #6235 | `/Users/chase/.worktree/mono/initial-sync-benchmark-fixtures` | `39d42eff905a73ca8ac4a423c873615a0ba71246` | `2a31011dd141d6e92ecbc59a4653227359b52546` |
| Direct parent PR #6237 | `/Users/chase/.worktree/mono/batch-initial-sync-copy-metrics` | `c4d5519670d50a8bd388f5ce05d5576dc6f97df6` | `b57cf7119f35353ec737a9e969ba1a8728a58a9d` |
| PR 6 head | `/Users/chase/.worktree/mono/direct-copy-text-buffers` | `99442b64afe8f627b8c7d06862efbb51ac3ce540` | `3e94a54aed13f5d31a8454c721572d288f2c4b3d` |

The #6235 and #6237 commits are tree-identical to landed squashes `2ca567a2a`
and `ea459443f`, respectively. All three worktrees were clean before the
benchmark, except for a temporary benchmark-only #6235 repetition adjustment
described below. All three worktrees were clean at their original commits after
the run.

## Host Controls

The run occurred on 2026-07-14 on the same Apple M5 Pro, 24 GiB local
development host used for the earlier blocks. Before any measured process:

- An automatically restarted Time Machine backup was stopped.
- `/Volumes/Backups` and its remaining read-only Time Machine snapshot were
  unmounted.
- The sustained `spotlightknowledged` indexing process was paused for the
  benchmark and retained for later resumption.
- All unrelated Docker containers were stopped; only the low-activity `oc`
  container remained.
- No benchmark, vitest, zero-cache, or zero-virtual process was running.
- The accepted preflight sample showed 89-92% idle CPU and approximately
  1.7-4.2 MB/s local disk activity. Time Machine reported `Running = 0`.

This is still an unconstrained local development host, not an isolated CI or
production machine. One benchmark process ran at a time.

## Method

Every process used:

```sh
/usr/bin/time -p env NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=<profile> pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts
```

The #6235 benchmark file was temporarily adjusted to use the same reduced
repetition counts already present in the parent and head: five measurements for
`mixed-regression`, three for each full profile, and ten for every other
profile. Every process also performed one discarded warmup. No production code
was backported or changed. The temporary adjustment was restored after the
matrix.

| Profile | Rows | Payload MB (decimal) | Warmups | Measurements |
| --- | ---: | ---: | ---: | ---: |
| `mixed-regression` | 250,000 | 493.787499 | 1 | 5 |
| `wide-text-scaled` | 1,000 | 683 | 1 | 10 |
| `wide-text-full` | 10,000 | 6,830 | 1 | 3 |
| `wide-text-narrow` | 250,000 | 32 | 1 | 10 |
| `large-payload-scaled` | 2,000 | 550 | 1 | 10 |
| `large-payload-full` | 10,000 | 2,750 | 1 | 3 |
| `large-payload-narrow` | 250,000 | 32 | 1 | 10 |

Recorder statistics are nanoseconds per decimal MB. MiB/s, elapsed time, and
speedup use:

```text
MiB/s = (1e9 / nsPerDecimalMB) * (1_000_000 / 1_048_576)
elapsedSeconds = nsPerDecimalMB * decimalPayloadMB / 1e9
direct speedup = parent median ns/MB / head median ns/MB - 1
cumulative speedup = #6235 median ns/MB / head median ns/MB - 1
```

## Order And Status

| Order | Profile | Arm | Status | Command real |
| ---: | --- | --- | --- | ---: |
| 1 | `mixed-regression` | #6235 | PASS | 41.48 s |
| 2 | `mixed-regression` | parent | PASS | 32.93 s |
| 3 | `mixed-regression` | head | PASS | 31.78 s |
| 4 | `wide-text-scaled` | head | PASS | 47.87 s |
| 5 | `wide-text-scaled` | parent | PASS | 47.89 s |
| 6 | `wide-text-scaled` | #6235 | PASS | 47.75 s |
| 7 | `wide-text-full` | parent | PASS | 243.90 s |
| 8 | `wide-text-full` | #6235 | PASS | 260.55 s |
| 9 | `wide-text-full` | head | PASS | 242.67 s |
| 10 | `wide-text-narrow` | #6235 | PASS | 37.00 s |
| 11 | `wide-text-narrow` | head | PASS | 34.33 s |
| 12 | `wide-text-narrow` | parent | PASS | 36.29 s |
| 13 | `large-payload-scaled` | head | PASS | 42.83 s |
| 14 | `large-payload-scaled` | #6235 | PASS | 42.13 s |
| 15 | `large-payload-scaled` | parent | PASS | 43.17 s |
| 16 | `large-payload-full` | parent | PASS | 111.18 s |
| 17 | `large-payload-full` | head | PASS | 77.87 s |
| 18 | `large-payload-full` | #6235 | PASS | 76.33 s |
| 19 | `large-payload-narrow` | #6235 | PASS | 25.07 s |
| 20 | `large-payload-narrow` | parent | PASS | 24.85 s |
| 21 | `large-payload-narrow` | head | PASS | 24.11 s |

All 21 requested processes passed on their first attempt. No successful arm was
rerun.

## Results

| Profile | Head median MiB/s | Head average-stat MiB/s | Head median elapsed | Head average elapsed | Direct vs #6237 | Cumulative vs #6235 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `mixed-regression` | 399.49 | 386.02 | 1.18 s | 1.22 s | +2.89% | +8.17% |
| `wide-text-scaled` | 506.63 | 473.83 | 1.29 s | 1.37 s | +3.37% | +4.74% |
| `wide-text-full` | 197.45 | 198.06 | 32.99 s | 32.89 s | +2.51% | +14.00% |
| `wide-text-narrow` | 22.01 | 21.96 | 1.39 s | 1.39 s | +13.03% | +14.11% |
| `large-payload-scaled` | 423.25 | 419.78 | 1.24 s | 1.25 s | +2.25% | +1.55% |
| `large-payload-full` | 407.33 | 406.20 | 6.44 s | 6.46 s | +4.01% | -4.64% |
| `large-payload-narrow` | 41.09 | 40.84 | 0.74 s | 0.75 s | +9.22% | +9.50% |

Across the seven direct parent/head comparisons:

- Median ratio: +3.37%.
- Geometric mean ratio: +5.26%.
- Improvements of at least 5%: 2 of 7, both narrow/high-row-count profiles.
- Regressions of at least 5%: 0 of 7.

The geometric mean is lifted by the two narrow profiles. It should not be read
as a generalized expected initial-sync gain.

## Comparison With Prior Midpoints

| Profile | Prior direct midpoint | Clean direct | Prior cumulative | Clean cumulative |
| --- | ---: | ---: | ---: | ---: |
| `mixed-regression` | +21.78% | +2.89% | +15.43% | +8.17% |
| `wide-text-scaled` | +2.65% | +3.37% | +23.54% | +4.74% |
| `wide-text-full` | -0.56% | +2.51% | -8.17% | +14.00% |
| `wide-text-narrow` | +10.60% | +13.03% | -5.62% | +14.11% |
| `large-payload-scaled` | +45.35% | +2.25% | +29.89% | +1.55% |
| `large-payload-full` | +5.11% | +4.01% | -7.27% | -4.64% |
| `large-payload-narrow` | +0.30% | +9.22% | +10.02% | +9.50% |

The prior +21.78% mixed and +45.35% large-payload-scaled direct results did not
reproduce. The clean direct results are tighter: 2.25-4.01% for mixed and the
four scaled/full large-field lanes, with larger gains only on the two
narrow/high-row-count lanes.

## Interpretation

- The clean block shows a positive direct median result in all seven profiles,
  with no measured direct regression.
- The planned at-least-5% `wide-text-full` gate still fails: the clean direct
  result is +2.51%.
- The full wide lane is +14.00% cumulative versus #6235, but cumulative stack
  progress does not establish PR 6's marginal effect.
- The `large-payload-full` head is +4.01% versus its direct parent but remains
  -4.64% cumulative versus #6235 because the intermediate stack is slower on
  that lane.
- The two narrow profiles suggest that avoiding per-field JavaScript decoding
  is more valuable when processing many rows, but this is one process per arm
  and does not support a broad claim without independent process pairs.
- The supported PR claim remains removal of JavaScript UTF-8 decoding and
  allocation for eligible known text-like fields while preserving tested
  SQLite behavior. The clean timing is directionally favorable but below the
  preregistered full-wide performance threshold.

Internal recorder measurements are repeated operations in one process, not
independent process experiments. This block has no confidence interval or
statistical-significance claim.

## Exact Recorder JSON

The following are the unmodified aggregate JSON objects from all 21 processes,
in execution order:

```text
01 mixed-regression #6235
{"benchmarks":[{"name":"zero-cache/initial-sync mixed-regression generated fixture payload MB","stats":{"min":2312998.9323605807,"max":3014469.7932095677,"avg":2631586.8717446006,"median":2582175.1129426598,"p75":2842670.014616956,"p99":2842670.014616956}}]}

02 mixed-regression parent
{"benchmarks":[{"name":"zero-cache/initial-sync mixed-regression generated fixture payload MB","stats":{"min":2393135.5479697958,"max":3237603.0584767824,"avg":2590460.645501277,"median":2456200.4616483883,"p75":2458683.0599370836,"p99":2458683.0599370836}}]}

03 mixed-regression head
{"benchmarks":[{"name":"zero-cache/initial-sync mixed-regression generated fixture payload MB","stats":{"min":2152250.551405717,"max":2831533.645204737,"avg":2470525.281969521,"median":2387222.241120363,"p75":2828481.5549775586,"p99":2828481.5549775586}}]}

04 wide-text-scaled head
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-scaled generated fixture payload MB","stats":{"min":1787533.857979506,"max":2460880.5519765825,"avg":2012710.4197657413,"median":1882393.240117129,"p75":2077876.0380673534,"p99":2421767.8140556454}}]}

05 wide-text-scaled parent
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-scaled generated fixture payload MB","stats":{"min":1908696.3762811124,"max":2275368.1669106926,"avg":1994390.6967789151,"median":1945859.9619326484,"p75":1952676.1844802317,"p99":2159346.1449487526}}]}

06 wide-text-scaled #6235
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-scaled generated fixture payload MB","stats":{"min":1940979.5021961937,"max":2003090.1669106882,"avg":1970303.9165446572,"median":1971629.2701317742,"p75":1978320.9487554913,"p99":1985888.4216691118}}]}

07 wide-text-full parent
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-full generated fixture payload MB","stats":{"min":4860309.09590044,"max":5137000.195168377,"avg":4982772.704148366,"median":4951008.821376281,"p75":4951008.821376281,"p99":4951008.821376281}}]}

08 wide-text-full #6235
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-full generated fixture payload MB","stats":{"min":5109377.586676429,"max":5880874.078770133,"avg":5498738.394729137,"median":5505963.5187408505,"p75":5505963.5187408505,"p99":5505963.5187408505}}]}

09 wide-text-full head
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-full generated fixture payload MB","stats":{"min":4745837.048462666,"max":4869468.222401171,"avg":4815085.846754515,"median":4829952.269399706,"p75":4829952.269399706,"p99":4829952.269399706}}]}

10 wide-text-narrow #6235
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-narrow generated fixture payload MB","stats":{"min":48811151.03125001,"max":50618682.3125,"avg":49515841.278125,"median":49444503.265625,"p75":49584756.53125004,"p99":50116376.31249999}}]}

11 wide-text-narrow head
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-narrow generated fixture payload MB","stats":{"min":42504147.156250045,"max":44884927.09374998,"avg":43421499.35312499,"median":43331595.046874985,"p75":43558276.031249985,"p99":43750736.999999955}}]}

12 wide-text-narrow parent
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-narrow generated fixture payload MB","stats":{"min":48457005.21875005,"max":49749333.34375004,"avg":49056323.181250006,"median":48979654.95312502,"p75":49209272.124999985,"p99":49690648.43749993}}]}

13 large-payload-scaled head
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-scaled generated fixture payload MB","stats":{"min":2219496.212727271,"max":2345175.227272729,"avg":2271834.2121818187,"median":2253225.984545458,"p75":2278436.9690909013,"p99":2342691.516363636}}]}

14 large-payload-scaled #6235
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-scaled generated fixture payload MB","stats":{"min":2239986.8181818137,"max":2317489.9999999995,"avg":2283100.886363638,"median":2288193.7872727313,"p75":2299084.8490909147,"p99":2304048.3345454545}}]}

15 large-payload-scaled parent
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-scaled generated fixture payload MB","stats":{"min":2241923.332727274,"max":2474974.99999999,"avg":2311631.560727272,"median":2303892.462727272,"p75":2314479.6218181793,"p99":2338861.5145454505}}]}

16 large-payload-full parent
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-full generated fixture payload MB","stats":{"min":2413647.3636363624,"max":2877430.485090913,"avg":2575379.227272728,"median":2435059.8330909084,"p75":2435059.8330909084,"p99":2435059.8330909084}}]}

17 large-payload-full head
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-full generated fixture payload MB","stats":{"min":2187450.485090905,"max":2514655.318181819,"avg":2347791.631393938,"median":2341269.0909090904,"p75":2341269.0909090904,"p99":2341269.0909090904}}]}

18 large-payload-full #6235
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-full generated fixture payload MB","stats":{"min":2101433.833454545,"max":2323241.9847272723,"avg":2219089.5706666666,"median":2232592.893818182,"p75":2232592.893818182,"p99":2232592.893818182}}]}

19 large-payload-narrow #6235
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-narrow generated fixture payload MB","stats":{"min":25069109.37499998,"max":27137337.25,"avg":25658619.52812502,"median":25411080.06250002,"p75":25579510.406250052,"p99":26447666.656250022}}]}

20 large-payload-narrow parent
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-narrow generated fixture payload MB","stats":{"min":25047667.968749978,"max":26061945.31250003,"avg":25422570.57500001,"median":25346621.750000022,"p75":25410847.656249985,"p99":25732473.968750015}}]}

21 large-payload-narrow head
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-narrow generated fixture payload MB","stats":{"min":22825225.28125,"max":24241268.249999963,"avg":23349360.287500016,"median":23206937.484375034,"p75":23314183.593750015,"p99":24024010.43750001}}]}
```

## Cleanup

- The temporary #6235 benchmark repetition adjustment was restored.
- All three worktrees were clean and remained at the recorded commits.
- No benchmark process, test container, or benchmark SQLite file remained.
- `oc` remained the only running Docker container.
