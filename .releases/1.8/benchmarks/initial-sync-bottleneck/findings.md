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

Read-only telemetry from all six production regions strongly corroborates this
mechanism. Within one EU stack, COPY bytes grew 3.7x at essentially constant
row count while index time grew 8.1x on the same Zero version and node type.
COPY time per GB improved over the same observations, isolating the
superlinear growth to index construction. Production was not modified, so the
controlled mmap treatment below remains the causal proof.

An ARM64 Linux validation under the tighter observed production limits (3 GiB
memory, 1 CPU, and no swap) selects a 1 GiB mmap cap for the next shadow-sync
test. It improved index and total time in every paired 1.2 GB run without any
cgroup pressure or OOM event. Smaller caps were partial or inconsistent.

No production source was changed. The mmap and cache settings were applied by
the benchmark callback before invoking production `initialSync()`.

## Valid Runs

The investigation completed 309 successful measured processes:

| Group                             | Runs |
| --------------------------------- | ---: |
| Final fixture calibration         |    7 |
| Instrumentation validation        |   20 |
| Knee and raw COPY localization    |   78 |
| Index ablation                    |   48 |
| SQLite mechanism controls         |   24 |
| Cross-version causal confirmation |   80 |
| Linux mmap cap sweep              |   20 |
| Linux cross-size confirmation     |   32 |

An initial calibration attempt exposed a benchmark-harness COPY stream cleanup
bug. Switching calibration COPY consumption to Node `pipeline()` fixed it; the
failed attempt is excluded from every result below.

## Fixture Calibration

The final deterministic TOAST-heavy profiles are all within 1% of target
binary COPY size:

| Profile |    Rows | Binary COPY |  Text COPY | Binary Error |
| ------- | ------: | ----------: | ---------: | -----------: |
| 200 MB  |  47,662 |    199.5 MB |   220.3 MB |       -0.24% |
| 300 MB  |  71,383 |    298.7 MB |   329.8 MB |       -0.44% |
| 400 MB  |  94,260 |    397.5 MB |   438.9 MB |       -0.62% |
| 500 MB  | 117,718 |    495.3 MB |   546.9 MB |       -0.95% |
| 600 MB  | 140,527 |    596.2 MB |   658.2 MB |       -0.64% |
| 800 MB  | 186,945 |    796.0 MB |   879.7 MB |       -0.50% |
| 1.2 GB  | 279,658 |  1,195.1 MB | 1,320.4 MB |       -0.41% |

The fixture includes `text`, `jsonb`, `bytea`, `text[]`, and `int4[]`, with
inline, compressed, incompressible, null, 256 KiB, and 1 MiB values. Zero warns
that `bytea` is not client-queryable, but the columns are present in the
initial-sync COPY stream and SQLite replica.

## Knee Localization

Zero 1.8 binary medians over six processes per size:

| Binary COPY |    Total | COPY Wall | SQLite Insert Work |    Index | Throughput |
| ----------: | -------: | --------: | -----------------: | -------: | ---------: |
|    199.5 MB |   609 ms |    393 ms |             206 ms |    34 ms |   328 MB/s |
|    298.7 MB |   844 ms |    579 ms |             333 ms |    56 ms |   354 MB/s |
|    397.5 MB | 1,033 ms |    748 ms |             451 ms |    74 ms |   385 MB/s |
|    495.3 MB | 1,227 ms |    921 ms |             555 ms |    93 ms |   404 MB/s |
|    596.2 MB | 1,598 ms |  1,064 ms |             637 ms |   309 ms |   373 MB/s |
|    796.0 MB | 2,557 ms |  1,326 ms |             784 ms |   975 ms |   311 MB/s |
|  1,195.1 MB | 4,070 ms |  1,966 ms |           1,156 ms | 1,830 ms |   294 MB/s |

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

| Format |     400 MB |     1.2 GB | Throughput Change |
| ------ | ---------: | ---------: | ----------------: |
| Binary | 1,152 MB/s | 1,128 MB/s |             -2.0% |
| Text   |   811 MB/s |   800 MB/s |             -1.4% |

This rules out PostgreSQL table reads, TOAST decompression, COPY transport, and
the source fixture as the shared cause.

## Index Ablation

Zero 1.8 binary medians over six processes per treatment:

| Index Profile                  | 400 MB Total | 1.2 GB Total | 400 MB Index | 1.2 GB Index |
| ------------------------------ | -----------: | -----------: | -----------: | -----------: |
| Standard                       |       980 ms |     4,023 ms |        72 ms |     1,799 ms |
| Required primary keys          |       930 ms |     3,341 ms |        12 ms |     1,200 ms |
| No application indexes         |       911 ms |     3,072 ms |         0 ms |         1 ms |
| Standard plus wide-text stress |     1,191 ms |     4,822 ms |       234 ms |     2,583 ms |

Removing secondary indexes saves about `599 ms` of 1.2 GB index time. Required
primary keys still show a `1.2 s` cliff. Removing application indexes moves
roughly `1.06 s` into wrapper `ANALYZE`, because SQLite must scan unindexed
tables; this no-index profile is supporting rather than standalone evidence.

Per-index timing shows the expensive scan moving to whichever index first
touches each large table:

| Profile       | Index                                 | Median at 1.2 GB |
| ------------- | ------------------------------------- | ---------------: |
| Standard      | `comments_account_idx`                |           600 ms |
| Standard      | `documents_tenant_status_updated_idx` |           381 ms |
| Standard      | `documents_account_idx`               |           323 ms |
| Required-only | `comments_pkey`                       |           651 ms |
| Required-only | `documents_pkey`                      |           349 ms |
| Required-only | `events_pkey`                         |           125 ms |

This movement rules out a specific index definition. SQLite creates indexes
after all tables have been copied, and each `CREATE INDEX` scans the table's
row B-tree. Wide values make those scans hundreds of megabytes even when the
index key itself is a small integer.

## Mechanism Controls

Zero 1.8 binary at 1.2 GB, four balanced processes per treatment:

| SQLite Setting                |    Total |    Index | Peak RSS | Index Reduction |
| ----------------------------- | -------: | -------: | -------: | --------------: |
| Default                       | 3,952 ms | 1,766 ms |   447 MB |         control |
| `cache_size=256 MiB`          | 3,475 ms | 1,439 ms |   735 MB |             19% |
| `cache_size=1 GiB`            | 2,729 ms |   139 ms | 1,670 MB |             92% |
| `mmap_size=1 GiB`             | 2,342 ms |   155 ms | 1,329 MB |             91% |
| `temp_store=MEMORY`           | 3,391 ms | 1,378 ms |   458 MB |             22% |
| 256 MiB cache plus 1 GiB mmap | 2,435 ms |   140 ms | 1,531 MB |             92% |

The 1 GiB page cache and 1 GiB mmap controls independently remove the index
cliff. In-memory temporary sorting does not. This identifies SQLite pager churn
and repeated table-page reads, rather than sorter spill, as the mechanism.

There are no major page faults in the process measurements, so “cold” here is
primarily from SQLite's pager perspective. Pages may remain in the OS cache,
but the default non-mmap SQLite path repeatedly reads and copies them through a
small pager cache.

## Linux Container Validation

The bounded mmap validation ran in ARM64 Linux containers matching the tighter
large-stack production resource shape observed in EU Central:

- 3 GiB cgroup memory limit with no swap.
- 1 CPU.
- `--max-old-space-size=2304`, matching the production 75% Node heap ratio.
- PostgreSQL in a separate container, outside the measured cgroup.
- Four balanced fresh-process repetitions per treatment.

Every requested mmap value was reported as the effective SQLite mmap size. The
1.2 GB cap sweep produced these medians:

| mmap Cap |  Index | Index Change | Process Peak RSS | Cgroup Peak | OOM Kills |
| -------: | -----: | -----------: | ---------------: | ----------: | --------: |
|  default | 229 ms |      control |           415 MB |    1,700 MB |         0 |
|  256 MiB | 255 ms |   11% slower |           602 MB |    1,746 MB |         0 |
|  512 MiB | 182 ms |   21% faster |           858 MB |    1,749 MB |         0 |
|  768 MiB | 177 ms |   23% faster |         1,114 MB |    1,760 MB |         0 |
| 1024 MiB | 156 ms |   32% faster |         1,392 MB |    1,743 MB |         0 |

The mmap pages increase process RSS as expected, but they do not add the same
amount to cgroup peak memory. The mapped SQLite pages largely replace pages
that would otherwise be charged as filesystem cache. Across the cap sweep,
cgroup peak changes by only `43-59 MB` and remains below 1.8 GB of the 3 GiB
limit. No run recorded a cgroup `high`, `max`, `oom`, or `oom_kill` event.

The follow-up cross-size matrix compared the useful caps at 400 MB and 1.2 GB:

| mmap Cap | 400 MB Index | 1.2 GB Index | 1.2 GB Total | Marginal Total | Paired 1.2 GB Index Speedup |
| -------: | -----------: | -----------: | -----------: | -------------: | --------------------------: |
|  default |        96 ms |       314 ms |     3,707 ms |       321 MB/s |                     control |
|  512 MiB |        50 ms |       232 ms |     3,483 ms |       353 MB/s |          1.23x (0.68-1.90x) |
|  768 MiB |        56 ms |       243 ms |     3,399 ms |       368 MB/s |          1.37x (1.02-1.54x) |
| 1024 MiB |        48 ms |       154 ms |     2,988 ms |       423 MB/s |          1.91x (1.78-2.33x) |

Only the 1 GiB cap improves both index time and total time in every paired 1.2
GB run. Its paired total-time speedup is `1.18x` with a `1.05-1.34x` range. In
the cross-size matrix, it cuts 1.2 GB index time by 51%, total time by 19%, and
adds only 16 MB to median cgroup peak despite adding 984 MB to process RSS.

Docker Desktop's Linux filesystem exhibits a shallower default knee than the
native macOS runs, so these measurements validate cap selection and cgroup
behavior rather than reproducing the original cliff's exact magnitude. The
consistent 1 GiB paired result and flat cgroup peak support advancing that cap
to a controlled shadow-sync test.

## Cross-Version Confirmation

Five balanced default/mmap pairs per configuration:

| Configuration   | 400 MB Default | 400 MB mmap | 1.2 GB Default | 1.2 GB mmap | 1.2 GB Speedup |
| --------------- | -------------: | ----------: | -------------: | ----------: | -------------: |
| Zero 0.22 text  |         1.76 s |      1.67 s |         6.17 s |      4.87 s |          1.27x |
| Zero 1.0 text   |         1.79 s |      1.74 s |         6.47 s |      5.04 s |          1.24x |
| Zero 1.8 binary |         0.99 s |      0.81 s |         3.63 s |      2.41 s |          1.51x |
| Zero 1.8 text   |         1.79 s |      1.71 s |         6.37 s |      5.00 s |          1.26x |

Every 1.2 GB paired speedup is positive:

| Configuration   | Median Paired Speedup |   Pair Range |
| --------------- | --------------------: | -----------: |
| Zero 0.22 text  |                1.266x | 1.220-1.322x |
| Zero 1.0 text   |                1.238x | 1.153-1.319x |
| Zero 1.8 binary |                1.507x | 1.343-1.607x |
| Zero 1.8 text   |                1.263x | 1.246-1.325x |

With mmap, 400 MB-to-1.2 GB marginal throughput becomes approximately linear:

| Configuration   | Default Marginal | mmap Marginal | Gain |
| --------------- | ---------------: | ------------: | ---: |
| Zero 0.22 text  |         181 MB/s |      249 MB/s |  38% |
| Zero 1.0 text   |         170 MB/s |      242 MB/s |  42% |
| Zero 1.8 binary |         302 MB/s |      498 MB/s |  65% |
| Zero 1.8 text   |         174 MB/s |      242 MB/s |  39% |

This confirms that the mechanism is shared across versions and independent of
text versus binary COPY.

## Production Corroboration

Read-only Amazon Managed Service for Prometheus telemetry was inspected across
all six production regions on July 13, 2026. No deployment, replica,
configuration, or data was modified. Initial-sync phase metrics were available
only for the current 30-day window and were predominantly from successful
binary shadow syncs.

Current replica size provides deployment context but is not the amount copied
by a shadow sync, so it should not be compared directly with COPY stream bytes:

| Region           | Largest Current Replica | Largest Shadow COPY Average | Evidence                             |
| ---------------- | ----------------------: | --------------------------: | ------------------------------------ |
| `us-east-1`      |                 2.25 GB |                    153.6 MB | Below the local knee                 |
| `us-west-1`      |                168.7 GB |                     2.88 GB | Repeated large-sync observations     |
| `sa-east-1`      |                150.3 MB |                     8.86 MB | Below the local knee                 |
| `eu-central-1`   |                 93.8 GB |                     3.67 GB | Large within-stack size comparison   |
| `eu-west-1`      |                 63.9 MB |                        none | No phase series in the metric window |
| `ap-southeast-2` |                 50.5 MB |                     1.69 MB | Below the local knee                 |

### EU Central Within-Stack Comparison

The useful size variation comes from seven successful shadow syncs for one
stack, represented by four short-lived replication-manager pod series. Every
observation used Zero `1.8.0-canary.6` on an on-demand `m6gd.2xlarge` node:

| COPY Stream |    Rows |    Total |    COPY |   Index | Index per GB | Index / Non-COPY |
| ----------: | ------: | -------: | ------: | ------: | -----------: | ---------------: |
|    0.983 GB | 223,760 |  41.84 s | 37.65 s |  2.30 s |       2.34 s |              55% |
|    3.340 GB | 225,476 | 101.89 s | 83.58 s | 16.43 s |       4.92 s |              90% |
|    3.661 GB | 224,339 | 103.23 s | 83.43 s | 18.06 s |       4.93 s |              91% |
|    3.670 GB | 223,020 | 110.25 s | 89.62 s | 18.69 s |       5.09 s |              91% |

Row count stays within 1.1%, while bytes per row rise from approximately 4.4
KB to 16.5 KB. From the smallest to largest observation, COPY bytes grow 3.73x
but index time grows 8.12x. Index cost per GB more than doubles, while COPY
cost falls from `38.3 s/GB` to `22.8-25.0 s/GB`. At the larger sizes, indexing
accounts for about 90% of all time outside the COPY phase.

This is the production shape predicted by the local mechanism: wider SQLite
rows make post-COPY table scans increasingly expensive even though row count
remains stable. It is inconsistent with PostgreSQL COPY being the source of
the superlinear growth.

### US West Repetition

One US West stack supplied seven successful shadow syncs across four pod
series, also all on Zero `1.8.0-canary.6` and on-demand `m6gd.2xlarge` nodes.
The observations were stable at `2.78-2.88 GB`, `514,430-514,864` rows,
`63.1-66.5 s` total, and `5.48-6.14 s` indexing. The weighted average was
`64.71 s` total, `57.64 s` COPY, and `5.62 s` indexing; indexing accounts for
80% of time outside COPY.

These runs confirm that multi-gigabyte production shadow syncs repeatedly pay
material index cost. They do not independently demonstrate the scaling curve
because their sizes are nearly identical.

### Production Limitations

The production observations strongly corroborate but do not independently
prove the pager-cache mechanism:

1. No SQLite pragma was changed in production, so there is no production mmap
   treatment to compare with the default.
2. The useful observations are shadow syncs, not serving-replica initial syncs.
3. The smallest EU observation is already above the local 500-600 MB knee, so
   production telemetry cannot locate the threshold precisely.
4. Production data is observational. The same stack, Zero version, node type,
   and stable row count reduce important confounders, but do not freeze schema
   or data distribution as a benchmark does.
5. Historical windows checked did not provide usable older phase data, and
   four regions had no samples large enough to exercise the local knee.

## Recommendation

Start with a configurable, default-off production canary that enables a 1 GiB
SQLite mmap cap only on the throwaway shadow-sync replica. Do not change the
serving replica until matched production shadow runs pass the performance and
memory gates in [`canary-runbook.md`](canary-runbook.md).

Before shipping:

1. Use matched shadow syncs to compare the 1 GiB cap with the default before
   enabling it for serving-replica initial syncs.
2. Monitor cgroup peak/current memory, OOM counters, process RSS, index time,
   and total time during the shadow treatment.
3. Test substantially larger replicas where a fixed 1 GiB cap covers only part
   of the database.
4. Retain index-phase telemetry and include replica file size and the configured
   mmap cap in the metric so future cliffs are visible.

Worker-count experiments are not required for root-cause attribution: COPY
wall time remains linear, index ablation accounts for the excess, and mmap
removes the knee across all versions. Worker scaling remains useful only as a
separate optimization exercise.
