# Initial Sync Bottleneck Findings

## Conclusion

The shared large-initial-sync throughput drop is caused by SQLite index
construction rescanning wide tables through the small default SQLite pager
cache after COPY completes. It is not caused by PostgreSQL, TOAST reads, COPY
streaming, binary decoding, SQLite row insertion, or table-copy worker count.

At 1.2 GB, setting `PRAGMA mmap_size = 1073741824` reduces Zero 1.8 binary
index time from `1766 ms` to `155 ms` and total initial sync from `3952 ms` to
`2342 ms`. The same control removes the knee in Zero 0.22, 1.0, and both Zero
1.8 COPY formats.

No production source was changed. The mmap and cache settings were applied by
the benchmark callback before invoking production `initialSync()`.

## Valid Runs

The investigation completed 257 successful measured processes:

| Group | Runs |
| --- | ---: |
| Final fixture calibration | 7 |
| Instrumentation validation | 20 |
| Knee and raw COPY localization | 78 |
| Index ablation | 48 |
| SQLite mechanism controls | 24 |
| Cross-version causal confirmation | 80 |

An initial calibration attempt exposed a benchmark-harness COPY stream cleanup
bug. Switching calibration COPY consumption to Node `pipeline()` fixed it; the
failed attempt is excluded from every result below.

## Fixture Calibration

The final deterministic TOAST-heavy profiles are all within 1% of target
binary COPY size:

| Profile | Rows | Binary COPY | Text COPY | Binary Error |
| --- | ---: | ---: | ---: | ---: |
| 200 MB | 47,662 | 199.5 MB | 220.3 MB | -0.24% |
| 300 MB | 71,383 | 298.7 MB | 329.8 MB | -0.44% |
| 400 MB | 94,260 | 397.5 MB | 438.9 MB | -0.62% |
| 500 MB | 117,718 | 495.3 MB | 546.9 MB | -0.95% |
| 600 MB | 140,527 | 596.2 MB | 658.2 MB | -0.64% |
| 800 MB | 186,945 | 796.0 MB | 879.7 MB | -0.50% |
| 1.2 GB | 279,658 | 1,195.1 MB | 1,320.4 MB | -0.41% |

The fixture includes `text`, `jsonb`, `bytea`, `text[]`, and `int4[]`, with
inline, compressed, incompressible, null, 256 KiB, and 1 MiB values. Zero warns
that `bytea` is not client-queryable, but the columns are present in the
initial-sync COPY stream and SQLite replica.

## Knee Localization

Zero 1.8 binary medians over six processes per size:

| Binary COPY | Total | COPY Wall | SQLite Insert Work | Index | Throughput |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 199.5 MB | 609 ms | 393 ms | 206 ms | 34 ms | 328 MB/s |
| 298.7 MB | 844 ms | 579 ms | 333 ms | 56 ms | 354 MB/s |
| 397.5 MB | 1,033 ms | 748 ms | 451 ms | 74 ms | 385 MB/s |
| 495.3 MB | 1,227 ms | 921 ms | 555 ms | 93 ms | 404 MB/s |
| 596.2 MB | 1,598 ms | 1,064 ms | 637 ms | 309 ms | 373 MB/s |
| 796.0 MB | 2,557 ms | 1,326 ms | 784 ms | 975 ms | 311 MB/s |
| 1,195.1 MB | 4,070 ms | 1,966 ms | 1,156 ms | 1,830 ms | 294 MB/s |

COPY and insertion remain close to linear. Index construction develops a cliff
between 500 MB and 600 MB, growing about 20x from 500 MB to 1.2 GB while data
grows 2.4x.

The 200-500 MB slope predicts approximately `2.69 s` at 1.2 GB. The observed
time is `4.07 s`, an excess of `1.38 s`. Linear index scaling predicts roughly
`0.23 s` of indexing at 1.2 GB; observed indexing is `1.83 s`, an excess of
`1.60 s`. Index construction therefore accounts for the complete slowdown,
with other phases becoming slightly more efficient at scale.

## Raw COPY Control

Raw COPY does not exhibit the knee:

| Format | 400 MB | 1.2 GB | Throughput Change |
| --- | ---: | ---: | ---: |
| Binary | 1,152 MB/s | 1,128 MB/s | -2.0% |
| Text | 811 MB/s | 800 MB/s | -1.4% |

This rules out PostgreSQL table reads, TOAST decompression, COPY transport, and
the source fixture as the shared cause.

## Index Ablation

Zero 1.8 binary medians over six processes per treatment:

| Index Profile | 400 MB Total | 1.2 GB Total | 400 MB Index | 1.2 GB Index |
| --- | ---: | ---: | ---: | ---: |
| Standard | 980 ms | 4,023 ms | 72 ms | 1,799 ms |
| Required primary keys | 930 ms | 3,341 ms | 12 ms | 1,200 ms |
| No application indexes | 911 ms | 3,072 ms | 0 ms | 1 ms |
| Standard plus wide-text stress | 1,191 ms | 4,822 ms | 234 ms | 2,583 ms |

Removing secondary indexes saves about `599 ms` of 1.2 GB index time. Required
primary keys still show a `1.2 s` cliff. Removing application indexes moves
roughly `1.06 s` into wrapper `ANALYZE`, because SQLite must scan unindexed
tables; this no-index profile is supporting rather than standalone evidence.

Per-index timing shows the expensive scan moving to whichever index first
touches each large table:

| Profile | Index | Median at 1.2 GB |
| --- | --- | ---: |
| Standard | `comments_account_idx` | 600 ms |
| Standard | `documents_tenant_status_updated_idx` | 381 ms |
| Standard | `documents_account_idx` | 323 ms |
| Required-only | `comments_pkey` | 651 ms |
| Required-only | `documents_pkey` | 349 ms |
| Required-only | `events_pkey` | 125 ms |

This movement rules out a specific index definition. SQLite creates indexes
after all tables have been copied, and each `CREATE INDEX` scans the table's
row B-tree. Wide values make those scans hundreds of megabytes even when the
index key itself is a small integer.

## Mechanism Controls

Zero 1.8 binary at 1.2 GB, four balanced processes per treatment:

| SQLite Setting | Total | Index | Peak RSS | Index Reduction |
| --- | ---: | ---: | ---: | ---: |
| Default | 3,952 ms | 1,766 ms | 447 MB | control |
| `cache_size=256 MiB` | 3,475 ms | 1,439 ms | 735 MB | 19% |
| `cache_size=1 GiB` | 2,729 ms | 139 ms | 1,670 MB | 92% |
| `mmap_size=1 GiB` | 2,342 ms | 155 ms | 1,329 MB | 91% |
| `temp_store=MEMORY` | 3,391 ms | 1,378 ms | 458 MB | 22% |
| 256 MiB cache plus 1 GiB mmap | 2,435 ms | 140 ms | 1,531 MB | 92% |

The 1 GiB page cache and 1 GiB mmap controls independently remove the index
cliff. In-memory temporary sorting does not. This identifies SQLite pager churn
and repeated table-page reads, rather than sorter spill, as the mechanism.

There are no major page faults in the process measurements, so “cold” here is
primarily from SQLite's pager perspective. Pages may remain in the OS cache,
but the default non-mmap SQLite path repeatedly reads and copies them through a
small pager cache.

## Cross-Version Confirmation

Five balanced default/mmap pairs per configuration:

| Configuration | 400 MB Default | 400 MB mmap | 1.2 GB Default | 1.2 GB mmap | 1.2 GB Speedup |
| --- | ---: | ---: | ---: | ---: | ---: |
| Zero 0.22 text | 1.76 s | 1.67 s | 6.17 s | 4.87 s | 1.27x |
| Zero 1.0 text | 1.79 s | 1.74 s | 6.47 s | 5.04 s | 1.24x |
| Zero 1.8 binary | 0.99 s | 0.81 s | 3.63 s | 2.41 s | 1.51x |
| Zero 1.8 text | 1.79 s | 1.71 s | 6.37 s | 5.00 s | 1.26x |

Every 1.2 GB paired speedup is positive:

| Configuration | Median Paired Speedup | Pair Range |
| --- | ---: | ---: |
| Zero 0.22 text | 1.266x | 1.220-1.322x |
| Zero 1.0 text | 1.238x | 1.153-1.319x |
| Zero 1.8 binary | 1.507x | 1.343-1.607x |
| Zero 1.8 text | 1.263x | 1.246-1.325x |

With mmap, 400 MB-to-1.2 GB marginal throughput becomes approximately linear:

| Configuration | Default Marginal | mmap Marginal | Gain |
| --- | ---: | ---: | ---: |
| Zero 0.22 text | 181 MB/s | 249 MB/s | 38% |
| Zero 1.0 text | 170 MB/s | 242 MB/s | 42% |
| Zero 1.8 binary | 302 MB/s | 498 MB/s | 65% |
| Zero 1.8 text | 174 MB/s | 242 MB/s | 39% |

This confirms that the mechanism is shared across versions and independent of
text versus binary COPY.

## Recommendation

Prototype a production change that temporarily enables bounded SQLite mmap
during initial replica construction and index creation, then restores the
serving-mode pragma before opening the completed replica.

Before shipping:

1. Measure 256, 512, 768, and 1024 MiB mmap caps to find the smallest cap that
   removes the knee.
2. Repeat on Linux with realistic container memory limits. mmap RSS is
   reclaimable file-backed memory, but it still affects cgroup accounting and
   resident-memory alerts.
3. Test substantially larger replicas where a fixed mmap cap covers only part
   of the database.
4. Retain index-phase telemetry and include replica file size in the metric so
   future cliffs are visible.

Worker-count experiments are not required for root-cause attribution: COPY
wall time remains linear, index ablation accounts for the excess, and mmap
removes the knee across all versions. Worker scaling remains useful only as a
separate optimization exercise.
