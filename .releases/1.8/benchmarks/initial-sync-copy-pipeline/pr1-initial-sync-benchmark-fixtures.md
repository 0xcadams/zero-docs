# PR 1 Initial-Sync Benchmark Fixture Baseline

## Scope

This report freezes the first local baseline produced by the durable binary COPY
parser and initial-sync profiles added on
`0xcadams/initial-sync-benchmark-fixtures`.

- Mono commit: `39d42eff905a73ca8ac4a423c873615a0ba71246`
- Benchmark implementation commit:
  `7e29f61729f743f2f54ae5345f55b2edd09e5d99`
- Original benchmark PR:
  [rocicorp/mono#6235](https://github.com/rocicorp/mono/pull/6235)
- Run date: 2026-07-14
- Host: Apple M5 Pro, arm64, 24 GiB RAM, macOS 26.5.2
- Node: `v22.23.1`
- pnpm: `11.5.3`

These are absolute head-only measurements on an unconstrained local development
machine. They establish a smoke and comparison baseline for the fixtures; they
are not a controlled parent/head comparison and do not support a product
performance claim.

The mono recorder reports nanoseconds per decimal MB. Throughput below converts
that value to MiB/s with:

```text
(1e9 / nsPerDecimalMB) * (1_000_000 / 1_048_576)
```

"Average MiB/s" is derived from the recorder's average ns/MB statistic rather
than averaging per-run throughput values.

## Commands

The parser profiles were run separately:

```sh
NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_PG_COPY_BENCH_PROFILE=default pnpm exec vitest run --config vitest.config.bench.ts src/db/pg-copy.bench.ts
NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_PG_COPY_BENCH_PROFILE=wide-text pnpm exec vitest run --config vitest.config.bench.ts src/db/pg-copy.bench.ts
```

Each initial-sync profile was run sequentially with:

```sh
NO_COLOR=1 BENCH_OUTPUT_FORMAT=json ZERO_INITIAL_SYNC_BENCH_PROFILE=<profile> pnpm exec vitest run --config vitest.config.bench.pg.ts src/db/initial-sync.bench.pg.ts
```

The seven `<profile>` values were `mixed-regression`, `wide-text-scaled`,
`wide-text-full`, `wide-text-narrow`, `large-payload-scaled`,
`large-payload-full`, and `large-payload-narrow`.

## Binary COPY Parser

Each case ran at least 50 samples and at least two measured seconds. The JSON
formatter did not retain the exact sample count.

| Profile                   | Field bytes | COPY chunk bytes | Columns |  Rows | Median MiB/s | Average MiB/s |
| ------------------------- | ----------: | ---------------: | ------: | ----: | -----------: | ------------: |
| `contained-4k-31k`        |       4,096 |           31,744 |       7 | 4,096 |     6,211.28 |      5,817.41 |
| `large-payload-270k-5.5k` |     276,480 |            5,632 |       7 |    64 |     1,312.26 |      1,173.02 |
| `wide-text-683k-31k`      |     699,392 |           31,744 |      25 |    32 |     3,380.78 |      3,146.15 |
| `wide-text-683k-5.5k`     |     699,392 |            5,632 |      25 |    16 |       446.32 |        432.01 |

## Initial Sync

Every profile ran one discarded warmup followed by ten measured repetitions.
All seven invocations passed their fixture validation and completed without a
leftover benchmark database, SQLite file, or test container.

| Profile                |    Rows | Generated payload MB (decimal) | Median MiB/s | Average MiB/s | Median elapsed | Average elapsed |
| ---------------------- | ------: | -----------------------------: | -----------: | ------------: | -------------: | --------------: |
| `mixed-regression`     | 250,000 |                     493.787499 |       281.20 |        181.80 |         1.67 s |          2.59 s |
| `wide-text-scaled`     |   1,000 |                            683 |       345.40 |        303.61 |         1.89 s |          2.15 s |
| `wide-text-full`       |  10,000 |                          6,830 |       108.69 |        101.11 |        59.93 s |         64.42 s |
| `wide-text-narrow`     | 250,000 |                             32 |        13.09 |         12.01 |         2.33 s |          2.54 s |
| `large-payload-scaled` |   2,000 |                            550 |       230.54 |        192.17 |         2.28 s |          2.73 s |
| `large-payload-full`   |  10,000 |                          2,750 |       194.31 |        177.74 |        13.50 s |         14.75 s |
| `large-payload-narrow` | 250,000 |                             32 |        24.32 |         23.10 |         1.25 s |          1.32 s |

### Recorder Output

The following is the unmodified aggregate JSON emitted for the measured
initial-sync samples. Values are nanoseconds per decimal MB.

```json
{"benchmarks":[{"name":"zero-cache/initial-sync mixed-regression generated fixture payload MB","stats":{"min":2667462.561663595,"max":21706030.725172322,"avg":5245827.416137156,"median":3391433.6114045633,"p75":3800854.6263339086,"p99":4336093.7231827285}}]}
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-scaled generated fixture payload MB","stats":{"min":2348606.5153733566,"max":4804310.273792096,"avg":3141163.45783309,"median":2761099.07247437,"p75":3190247.133235726,"p99":4244392.509516837}}]}
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-full generated fixture payload MB","stats":{"min":6036228.453001471,"max":13090557.064421665,"avg":9431646.437906295,"median":8774007.192532938,"p75":10537546.333674964,"p99":12880294.4058565}}]}
{"benchmarks":[{"name":"zero-cache/initial-sync wide-text-narrow generated fixture payload MB","stats":{"min":61521674.500000015,"max":124335679.68750003,"avg":79395373.96562502,"median":72855173.18749999,"p75":81799318.99999997,"p99":102074035.15624997}}]}
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-scaled generated fixture payload MB","stats":{"min":3007149.3927272703,"max":11198688.10545454,"avg":4962535.507454546,"median":4136728.74909092,"p75":5097537.499999995,"p99":5919198.107272731}}]}
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-full generated fixture payload MB","stats":{"min":3443598.1210909085,"max":8802094.712000001,"avg":5365407.351454543,"median":4907997.99999999,"p75":5453490.318181819,"p99":8498124.121090906}}]}
{"benchmarks":[{"name":"zero-cache/initial-sync large-payload-narrow generated fixture payload MB","stats":{"min":34696967.468750015,"max":54046450.53125,"avg":41282419.40312499,"median":39212399.73437494,"p75":43644992.187499955,"p99":47098946.62499994}}]}
```

## Verification

- All four parser cases passed their isolated benchmark invocations.
- All seven initial-sync profiles passed their isolated benchmark invocations.
- Focused no-PostgreSQL tests: two files and four tests passed.
- Focused PostgreSQL 17 tests: one file and two tests passed.
- `pnpm run check-types` passed.
- `pnpm run check-format` passed.
- `pnpm run lint` completed with zero errors and 424 existing warnings.
- `git diff --check` passed.
