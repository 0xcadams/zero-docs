# EC2 And CloudZero Initial Sync Benchmarks

## Executive Summary

The original EC2-vs-CloudZero gap had two separate causes:

- A tiny `fck-nat` path caused pathological COPY throughput of only about
  `3-4 MiB/s`.
- `m6gd.xlarge` local NVMe was much slower than `m7gd.2xlarge` for SQLite-heavy
  flush and index work.

After moving CloudZero to `m7gd.2xlarge` and AWS NAT gateway, the zmail initial
sync became close to the original EC2 benchmark branch. A later exact
`zero/v1.7.0` EC2 run was faster still. Execing the same benchmark inside the
live CloudZero replication-manager pod validated the RM shape, while a
view-syncer exec on stronger resources showed that the production Zero image and
Kubernetes path can be fast:

| Run                                                 |       Overall |    Copy/other |         Flush |         Index |
| --------------------------------------------------- | ------------: | ------------: | ------------: | ------------: |
| EC2 `m7gd.2xlarge`, Zero `1.7.0`                    | `167.2 MiB/s` | `382.2 MiB/s` | `816.3 MiB/s` | `467.2 MiB/s` |
| EC2 `m7gd.2xlarge`, branch `42b760898`              | `134.9 MiB/s` | `260.2 MiB/s` | `704.0 MiB/s` | `464.7 MiB/s` |
| CloudZero `m7gd.2xlarge`, AWS NAT, Zero `1.7.0`     | `115.0 MiB/s` | `255.6 MiB/s` | `402.5 MiB/s` | `434.7 MiB/s` |
| CloudZero RM exec, same pod, Zero `1.7.0`           | `120.8 MiB/s` | `281.7 MiB/s` | `425.6 MiB/s` | `419.9 MiB/s` |
| CloudZero view-syncer exec, `m8gd.4xlarge`, `3 CPU` | `194.0 MiB/s` | `434.1 MiB/s` | `601.1 MiB/s` | `842.5 MiB/s` |

The pathological COPY/network issue is fixed, but exact code parity shows the
CloudZero RM path is still slower than EC2 for Zero `1.7.0`. The remaining RM
gap is mostly split between COPY/other and SQLite flush; indexing is close. The
view-syncer result is not apples-to-apples because it used `m8gd.4xlarge` and
`3 CPU`, but it rules out a broad "Kubernetes or production image is always
slow" explanation.

A longer EC2-only follow-up on a fresh `m7gd.2xlarge` boot showed more EC2
variance than the initial single-run comparison captured. Fresh EC2 full-sync
runs ranged from `176.813s` to `217.059s`, and EC2 raw COPY-to-null ranged from
`52.289s` to `82.949s`. That weakens precise copy/other attribution, but the RM
flush gap remains durable: EC2 fresh flush samples were `35.011-43.266s` while
RM exec flush was `67.700s`.

## Throughput Denominator

All zmail throughput numbers below use logical/materialized payload bytes, not
Postgres physical table-size estimates.

Measured binary COPY payload:

| Metric                     |            Value |
| -------------------------- | ---------------: |
| Logical payload bytes      | `30,205,237,393` |
| Binary COPY bytes observed | `30,211,144,726` |
| Logical payload            | `28,811.593 MiB` |

The `totalBytes` field in initial-sync logs is based on Postgres storage metadata
such as `pg_table_size(oid)`. It is useful for rough ordering, but it is not a
logical COPY byte count and is unsafe for MiB/s comparisons on TOAST-heavy or
compressed tables.

For zmail `email_content`:

| Metric                        |                            Value |
| ----------------------------- | -------------------------------: |
| Initial-sync log `totalBytes` | `886,792,192 bytes` (`~846 MiB`) |
| Logical/materialized payload  |                `~28,811.593 MiB` |

Using the log estimate for throughput would imply fake single-digit MiB/s rates.
Using logical bytes gives the meaningful comparison.

Phase-normalized throughputs such as `copy/other` are derived from initial-sync
log timers as `total - flush - index`. They are useful for comparing runs, but
they are not independent raw COPY-to-null measurements.

## Source Database

PlanetScale Postgres direct port `5432` was required for logical replication.

Connection findings:

- Direct port `5432` worked for logical replication.
- Port `6432` hung during logical replication slot creation.
- `sslrootcert=system` failed with postgres.js but worked with `psql`.
- API user lacked replication permissions.
- `postgres` user had `rolreplication=true`.

Stable zmail source row counts:

| Table            |      Rows |
| ---------------- | --------: |
| `email_address`  |   `3,091` |
| `email_content`  | `246,138` |
| `email_metadata` | `246,138` |
| Total app rows   | `495,367` |

The zmail schema included this expensive index:

```sql
email_content_text_hash_idx USING hash (text)
```

Zero currently does not preserve the Postgres access method in index metadata, so
that hash index becomes a normal SQLite B-tree index:

```sql
CREATE INDEX "email_content_text_hash_idx" ON "email_content" ("text" ASC);
```

That index is intentionally included in product-realistic all-index runs.

## EC2 Baseline

Environment:

| Field          | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| Instance       | `m7gd.2xlarge`                                                |
| Architecture   | ARM64                                                         |
| Storage        | local NVMe mounted at `/data` inside the container            |
| Container      | `node:22-bookworm`                                            |
| Node           | `v22.23.1`                                                    |
| Repo path      | `/data/mono`                                                  |
| Branch         | `0xcadams/zero-initial-sync-ctid-chunking`                    |
| Commit         | `42b760898`                                                   |
| Limits         | `--cpus=1 --cpuset-cpus=0 --memory=3072m --memory-swap=3072m` |
| Temp placement | `TMPDIR=/data/tmp`, `SQLITE_TMPDIR=/data/tmp`                 |

Original branch results:

| Run                        |    Throughput |    Elapsed |
| -------------------------- | ------------: | ---------: |
| COPY-to-null floor         | `276.1 MiB/s` | `104.336s` |
| Zero no-index import       | `253.0 MiB/s` | `113.890s` |
| Zero required-index import | `218.7 MiB/s` | `131.765s` |
| Zero skip-hash diagnostic  | `215.3 MiB/s` | `133.841s` |
| Zero all-index import      | `134.9 MiB/s` | `213.656s` |

EC2 phase costs:

| Run                  |     Flush |     Index |
| -------------------- | --------: | --------: |
| No-index             | `35.384s` |  `0.000s` |
| Required-index       | `39.086s` | `13.040s` |
| Skip-hash diagnostic | `39.312s` | `14.741s` |
| All-index            | `40.930s` | `62.000s` |

Interpretation:

- The EC2 COPY floor was `276.1 MiB/s`.
- No-index import reached `253.0 MiB/s`, close to raw source COPY speed.
- All-index import dropped to `134.9 MiB/s` because SQLite index creation added
  `62.000s`.
- The hash-derived content index was the main product-realistic extra index cost.

## EC2 Zero 1.7.0 Code-Parity Run

The tag `zero/v1.7.0` did not contain the zmail benchmark harness, so a minimal
test-only harness was added on branch `0xcadams/zero-v1.7-zmail-bench`. The
harness calls the tag's existing `initialSync()` implementation with only the
options available in Zero `1.7.0`.

Environment:

| Field          | Value                                                         |
| -------------- | ------------------------------------------------------------- |
| Host           | `ec2-54-89-120-142.compute-1.amazonaws.com`                   |
| Instance ID    | `i-0a63bbe9c60720852`                                         |
| Instance       | `m7gd.2xlarge`                                                |
| Container      | `node:22-bookworm`                                            |
| Node           | `v22.23.1`                                                    |
| Branch         | `0xcadams/zero-v1.7-zmail-bench`                              |
| Commit         | `90e3aac6d`                                                   |
| Base           | `zero/v1.7.0`                                                 |
| Limits         | `--cpus=1 --cpuset-cpus=0 --memory=3072m --memory-swap=3072m` |
| `/data`        | `/dev/nvme1n1` xfs, `442G`                                    |
| Temp placement | `TMPDIR=/data/tmp`, `SQLITE_TMPDIR=/data/tmp`                 |

Log summary:

```text
Finished copying 246138 rows into email_content
(flush: 34437.254 ms) (total: 110329.557 ms)

Synced 495,368 rows of 6 tables ...
(flush: 35297.662, index: 61665.093, total: 172353.318 ms)

zmail initial sync rep 0 copied 495367 rows in 173661.235 ms
zmail initial sync rep 0 throughput 165.9 MiB/s
```

Derived from the initial-sync summary:

| Phase                                |    Seconds |    Throughput |
| ------------------------------------ | ---------: | ------------: |
| Overall                              | `172.353s` | `167.2 MiB/s` |
| Copy/other excluding flush and index |  `75.391s` | `382.2 MiB/s` |
| Flush                                |  `35.298s` | `816.3 MiB/s` |
| Index                                |  `61.665s` | `467.2 MiB/s` |

`email_content` excluding flush was `75.892s`, or `379.6 MiB/s` using the zmail
logical payload denominator.

## CloudZero Results

CloudZero was tested against the same zmail database with the same logical
payload denominator.

### Original CloudZero Runs

These runs were on the original `m6gd.xlarge` placement unless noted otherwise.

| Phase                                | CZ staging high-mem | CZ prod 1 vCPU | CZ staging 1 vCPU |
| ------------------------------------ | ------------------: | -------------: | ----------------: |
| Overall initial sync                 |        `72.0 MiB/s` |   `69.9 MiB/s` |      `73.7 MiB/s` |
| Copy/other excluding flush and index |       `142.3 MiB/s` |  `145.3 MiB/s` |     `162.6 MiB/s` |
| `email_content` excluding flush      |       `141.6 MiB/s` |  `144.4 MiB/s` |     `161.6 MiB/s` |
| Flush-normalized                     |       `379.0 MiB/s` |  `323.0 MiB/s` |     `325.3 MiB/s` |
| Index-normalized                     |       `236.4 MiB/s` |  `230.5 MiB/s` |     `229.9 MiB/s` |

Production and staging were close at 1 vCPU on the same database. That weakens
the theory that production CloudZero was uniquely slow for this workload.

### Temp Directory Test

Setting `TMPDIR=/data` and `SQLITE_TMPDIR=/data` did not materially improve the
same `m6gd.xlarge` placement.

| Run                              |      Overall |    Copy/other |         Flush |         Index |
| -------------------------------- | -----------: | ------------: | ------------: | ------------: |
| CZ staging 1 vCPU baseline       | `73.7 MiB/s` | `162.6 MiB/s` | `325.3 MiB/s` | `229.9 MiB/s` |
| CZ staging 1 vCPU `TMPDIR=/data` | `73.3 MiB/s` | `162.0 MiB/s` | `321.7 MiB/s` | `229.2 MiB/s` |

Temp placement was not the fix.

### Good CloudZero Run

Good run conditions:

| Field            | Value                                            |
| ---------------- | ------------------------------------------------ |
| Pod              | `replication-manager-deployment-8fc477755-52xwk` |
| Node             | `i-0bac49b66e98c514f`                            |
| Instance         | `m7gd.2xlarge`                                   |
| Local NVMe label | `474`                                            |
| `/data`          | `/dev/nvme2n1` xfs, `441.2G`                     |
| NAT              | AWS NAT gateway                                  |
| Zero             | `1.7.0`                                          |
| CPU quota        | `cpu.max = 100000 100000` (`1 CPU`)              |

Log summary:

```text
Synced 495,383 rows of 6 tables ...
(flush: 71587.468, index: 66284.795, total: 250611.309 ms)
```

Derived throughput:

| Phase                                |    Seconds |    Throughput |
| ------------------------------------ | ---------: | ------------: |
| Overall                              | `250.611s` | `115.0 MiB/s` |
| Copy/other excluding flush and index | `112.739s` | `255.6 MiB/s` |
| Flush                                |  `71.587s` | `402.5 MiB/s` |
| Index                                |  `66.285s` | `434.7 MiB/s` |

`email_content` result:

```text
Finished copying 246138 rows into email_content
(flush: 70501.379 ms) (total: 183957.283 ms)
```

`email_content` excluding flush was `113.456s`, or `254.0 MiB/s` using the zmail
logical payload denominator. That confirms the pathological `fck-nat` COPY path
was fixed, but it is still slower than the exact EC2 Zero `1.7.0` run.

### RM Exec Benchmark

The same benchmark was execed into the live replication-manager pod on the same
`m7gd.2xlarge` placement. This is the closest CloudZero apples-to-apples result
so far, with one caveat: it competed with the live RM process in the same pod.

Environment:

| Field          | Value                                                               |
| -------------- | ------------------------------------------------------------------- |
| Pod            | `replication-manager-deployment-8fc477755-52xwk`                    |
| Instance       | `m7gd.2xlarge`                                                      |
| CPU quota      | `1 CPU`                                                             |
| Temp placement | `TMPDIR=/data/zmail-exec-tmp`, `SQLITE_TMPDIR=/data/zmail-exec-tmp` |
| App ID         | `zmail_exec_1782978636892`                                          |
| DB path        | `/data/zmail_exec_1782978636892.db`                                 |

Log summary:

```text
Finished copying 246138 rows into email_content
(flush: 66567.385 ms) (total: 169633.425 ms)

Created indexes (68608.692 ms)

Synced 495,368 rows of 6 tables ...
(flush: 67699.548, index: 68608.692, total: 238572.411 ms)
```

Derived from the initial-sync summary:

| Phase                                |    Seconds |    Throughput |
| ------------------------------------ | ---------: | ------------: |
| Overall                              | `238.572s` | `120.8 MiB/s` |
| Copy/other excluding flush and index | `102.264s` | `281.7 MiB/s` |
| Flush                                |  `67.700s` | `425.6 MiB/s` |
| Index                                |  `68.609s` | `419.9 MiB/s` |

`email_content` excluding flush was `103.066s`, or `279.5 MiB/s` using the
zmail logical payload denominator.

Compared with the prior good RM startup run:

| Phase      | Prior RM startup |    RM exec | Difference |
| ---------- | ---------------: | ---------: | ---------: |
| Overall    |       `250.611s` | `238.572s` | `-12.039s` |
| Copy/other |       `112.739s` | `102.264s` | `-10.475s` |
| Flush      |        `71.587s` |  `67.700s` |  `-3.888s` |
| Index      |        `66.285s` |  `68.609s` |  `+2.324s` |

This validates the prior CloudZero RM result. Execing the benchmark inside the
same RM pod produced the same performance shape and only modestly faster total
time.

### View-Syncer Exec Benchmark

The benchmark was also execed into a view-syncer pod using the production Zero
image. This run is not apples-to-apples with the RM or EC2 1-vCPU runs because
it used a stronger node and a larger CPU quota.

Environment:

| Field            | Value                               |
| ---------------- | ----------------------------------- |
| Instance         | `m8gd.4xlarge`                      |
| Local NVMe label | `950`                               |
| `/data`          | `/dev/nvme2n1` xfs, `884.3G`        |
| CPU quota        | `cpu.max = 300000 100000` (`3 CPU`) |
| Node             | `v22.22.3`                          |
| App ID           | `zmail_exec_1782977868697`          |
| DB path          | `/data/zmail_exec_1782977868697.db` |

Log summary:

```text
Finished copying 246138 rows into email_content
(flush: 47256.078 ms) (total: 114115.885 ms)

Created indexes (34197.328 ms)

Synced 495,368 rows of 6 tables ...
(flush: 47933.798, index: 34197.328, total: 148504.850 ms)
```

Derived from the initial-sync summary:

| Phase                                |    Seconds |    Throughput |
| ------------------------------------ | ---------: | ------------: |
| Overall                              | `148.505s` | `194.0 MiB/s` |
| Copy/other excluding flush and index |  `66.374s` | `434.1 MiB/s` |
| Flush                                |  `47.934s` | `601.1 MiB/s` |
| Index                                |  `34.197s` | `842.5 MiB/s` |

`email_content` excluding flush was `66.860s`, or `430.9 MiB/s` using the zmail
logical payload denominator.

Same-pod raw COPY-to-null result:

| Metric     |            Value |
| ---------- | ---------------: |
| Bytes      | `30,211,144,726` |
| MiB        |     `28,811.593` |
| Chunks     |        `246,139` |
| Seconds    |        `76.532s` |
| Throughput |    `376.5 MiB/s` |

Interpretation:

- The production Zero image and K8s execution path can be fast.
- The view-syncer result does not explain the RM-vs-EC2 gap because it used
  `m8gd.4xlarge` and `3 CPU`.
- Same-pod COPY-to-null was slower than the view-syncer initial-sync copy/other
  bucket, so it should be treated as evidence of COPY/network variance rather
  than a clean residual-overhead measurement.

### Remaining Gap Against Original Branch EC2

| Phase      | EC2 `m7gd.2xlarge` | CZ `m7gd.2xlarge` + AWS NAT | Difference |
| ---------- | -----------------: | --------------------------: | ---------: |
| Overall    |         `213.656s` |                  `250.611s` | `+36.955s` |
| Copy/other |         `110.726s` |                  `112.739s` |  `+2.013s` |
| Flush      |          `40.930s` |                   `71.587s` | `+30.657s` |
| Index      |          `62.000s` |                   `66.285s` |  `+4.285s` |

The remaining gap is mostly SQLite flush. Copy/other is essentially matched, and
indexing is close.

This comparison is no longer the best code-parity comparison because the EC2 run
used a branch newer than Zero `1.7.0`:

- EC2 used branch `0xcadams/zero-initial-sync-ctid-chunking` at `42b760898`.
- CloudZero used released Zero `1.7.0`.

### Remaining Gap Against EC2 Zero 1.7.0

Exact Zero `1.7.0` code parity shows a larger remaining CloudZero-vs-EC2 RM
gap. The RM exec run was modestly faster than the prior RM startup run, but it
has the same shape:

| Phase      | EC2 `m7gd.2xlarge`, Zero `1.7.0` | CZ RM startup | CZ RM exec | RM exec difference |
| ---------- | -------------------------------: | ------------: | ---------: | -----------------: |
| Overall    |                       `172.353s` |    `250.611s` | `238.572s` |         `+66.219s` |
| Copy/other |                        `75.391s` |    `112.739s` | `102.264s` |         `+26.874s` |
| Flush      |                        `35.298s` |     `71.587s` |  `67.700s` |         `+32.402s` |
| Index      |                        `61.665s` |     `66.285s` |  `68.609s` |          `+6.944s` |

This rules out Zero code version as the explanation for the remaining gap.
Indexing is close. The remaining RM difference is split between COPY/other and
SQLite flush, with flush now the largest single stable gap.

## Storage Microbenchmarks

These tests wrote and read a 4 GiB file on `/data` with `bs=64M`. The write used
`conv=fsync` except where noted.

| Environment                | Instance       | `/data`                      | Limit                           |             Write+fsync |                    Read |
| -------------------------- | -------------- | ---------------------------- | ------------------------------- | ----------------------: | ----------------------: |
| CloudZero original         | `m6gd.xlarge`  | `/dev/nvme2n1` xfs, `220.6G` | `1 CPU`                         | `31.03s` (`132.0 MB/s`) | `14.16s` (`289.2 MB/s`) |
| EC2 same-class host        | `m6gd.xlarge`  | `/dev/nvme1n1` xfs, `221G`   | `1 CPU`, `3G` via `systemd-run` |   `32.15s` (`134 MB/s`) |   `13.41s` (`320 MB/s`) |
| EC2 benchmark host         | `m7gd.2xlarge` | `/dev/nvme1n1` xfs, `442G`   | `1 CPU`, `3G` Docker            |   `13.67s` (`314 MB/s`) |    `5.67s` (`759 MB/s`) |
| CloudZero forced placement | `m7gd.2xlarge` | `/dev/nvme2n1` xfs, `441.2G` | `1 CPU`                         | `13.23s` (`309.7 MB/s`) |  `5.81s` (`704.8 MB/s`) |

Conclusions:

- CloudZero `m6gd.xlarge` matched EC2 `m6gd.xlarge`.
- CloudZero `m7gd.2xlarge` matched EC2 `m7gd.2xlarge`.
- The storage gap was instance class / local NVMe performance, not Kubernetes
  overhead by itself.

## NAT Bottleneck

One abandoned CloudZero run was extremely slow even before indexing. It landed on
`m6gd.xlarge` and used the old tiny `fck-nat` path.

DB evidence during that run:

| Metric                 |           Value |
| ---------------------- | --------------: |
| Active COPY            | `email_content` |
| COPY age at sample     |        `18m16s` |
| Bytes processed        | `4,177,581,588` |
| Rows processed         |        `29,746` |
| Wait event             |   `ClientWrite` |
| Approximate drain rate |     `~3.8 MB/s` |

Pod-side evidence:

- CPU was only about `104m`.
- Memory was about `216Mi`.
- CPU throttling was negligible.
- Disk was not saturated.
- Process read/write deltas were only about `3.65-4.17 MiB/s`.

That shape means Postgres had data ready but could not push it to the client
fast enough. The bottleneck was the network path, not Postgres scan speed,
SQLite storage, CPU, or Kubernetes scheduling.

After switching to AWS NAT gateway, the same DB-side check showed healthy COPY
progress:

| Sample      |            Bytes |     Rows |
| ----------- | ---------------: | -------: |
| `06:21:38Z` |  `6,433,175,574` | `45,933` |
| `06:21:59Z` | `10,016,124,566` | `71,891` |

That is about `163 MiB/s`, not `3-4 MiB/s`.

## Production Incident Evidence

The incident logs prove that cold recovery was dominated by full initial sync and
SQLite index creation.

| Stack              | Slow table          | Table copy total | Table flush |     Indexing | Initial sync |
| ------------------ | ------------------- | ---------------: | ----------: | -----------: | -----------: |
| `aeuuxvuox8o4ecw3` | `Email`             |     `1,489.713s` |  `418.353s` | `1,003.121s` | `2,502.877s` |
| `xvav0bi8hbwv988s` | `userspace.imports` |     `2,270.133s` |  `226.989s` | `2,378.355s` | `5,374.755s` |

Representative raw lines:

```text
Finished copying 383471 rows into Email (flush: 418352.542 ms) (total: 1489713.294 ms)
Created indexes (1003121.333 ms)
Synced 4,361,138 rows of 104 tables ... (flush: 444773.697, index: 1003121.333, total: 2502876.992 ms)
```

```text
Finished copying 174658 rows into userspace.imports (flush: 226989.441 ms) (total: 2270132.859 ms)
Created indexes (2378355.111 ms)
Synced 259,541,985 rows of 84 tables ... (flush: 1252386.323, index: 2378355.111, total: 5374754.538 ms)
```

However, incident table-level MiB/s estimates based on log `totalBytes` are
provisional. Those byte values are physical estimates, not measured logical COPY
bytes. The timings are valid; the comparable MiB/s denominators are not.

## Invalid Or Abandoned Runs

Invalid EC2 run:

- `DbFile` uses `os.tmpdir()`.
- Without overriding temp paths, the SQLite DB landed under `/tmp` on the small
  Docker overlay filesystem.
- The run failed with `SqliteError: database or disk is full` and was discarded.

Abandoned CloudZero run:

- Pod landed on `m6gd.xlarge` instead of the intended `m7gd.2xlarge`.
- It used the old tiny `fck-nat` path.
- DB showed `ClientWrite` with only `~3-4 MiB/s` COPY progress.
- Pod CPU, memory, throttling, and disk were not saturated.
- The run was abandoned and should not be used for performance comparison.

## What We Proved

- Logical/materialized bytes are the right denominator for zmail throughput.
- Initial-sync log `totalBytes` is not safe for MiB/s comparisons on TOAST-heavy
  tables.
- The pathological `~3-4 MiB/s` COPY behavior was a network/NAT bottleneck.
- AWS NAT gateway fixed the pathological COPY drain.
- `m6gd.xlarge` local NVMe is much slower than `m7gd.2xlarge` for this workload.
- CloudZero and EC2 match at the storage-microbench level when instance class is
  matched.
- `TMPDIR=/data` and `SQLITE_TMPDIR=/data` did not materially improve CloudZero.
- The Postgres `USING hash (text)` index is expensive because Zero maps it to a
  SQLite B-tree over `text`.
- CloudZero `m7gd.2xlarge` + AWS NAT + Zero `1.7.0` gets close to the original
  branch EC2 baseline.
- The first exact Zero `1.7.0` EC2 run was faster than both the original branch
  EC2 run and the CloudZero Zero `1.7.0` run, but later EC2 repetitions showed
  substantial variance.
- Execing the benchmark inside the live RM pod reproduces the same CloudZero RM
  performance shape, so the prior RM startup result was not a one-off artifact.
- The production Zero image and K8s path can be fast on stronger resources, as
  shown by the `m8gd.4xlarge` view-syncer exec run.
- CloudZero RM raw COPY-to-null is usually slower than EC2, but EC2 also has a
  slow tail that overlaps CloudZero samples.
- EC2 full initial-sync copy/other can overlap the RM exec result; RM flush does
  not overlap EC2 fresh samples and remains the most durable gap.
- CPU quota without cpuset produced measurable throttling in Docker, making K8s
  CPU quota/scheduling a plausible contributor, but not a complete explanation.

## Remaining Questions

The main remaining performance question is the exact Zero `1.7.0` EC2-vs-RM gap.
The RM exec run is the best current CloudZero RM datapoint, but fresh EC2
repetitions show that a single EC2 run is not enough for precise attribution:

```text
EC2 Zero 1.7.0 total range: 176.813-217.059s fresh runs
RM exec total:                 238.572s

EC2 Zero 1.7.0 copy/other range: 70.210-102.511s fresh runs
RM exec copy/other:                 102.264s

EC2 Zero 1.7.0 flush range: 35.011-43.266s fresh runs
RM exec flush:                 67.700s
```

Code version has now been isolated and does not explain the gap.

Current hypotheses based on the RM exec, view-syncer exec, and fresh EC2
follow-up results:

1. The most durable RM-specific gap is SQLite flush. Fresh EC2 flush samples were
   `35.011-43.266s`; RM exec flush was `67.700s`.
2. Copy/other is no longer a durable RM-specific gap. Fresh EC2 copy/other ranged
   from `70.210s` to `102.511s`; RM exec copy/other was `102.264s`.
3. Raw COPY/network variance is larger than initially measured. Fresh EC2
   COPY-to-null ranged from `52.289s` to `82.949s`, while RM samples ranged from
   `79.332s` to `93.676s` and view-syncer was `76.532s`.
4. CloudZero RM still appears to have a slower COPY path in the common case, but
   the slow EC2 tail overlaps CloudZero. Same-window COPY-to-null samples are
   required before subtracting raw COPY time from copy/other.
5. A large separate CloudZero decoding/binding/runtime overhead is not proven.
   EC2 full-run copy/other can reach the RM exec copy/other number.
6. The SQLite flush gap is not explained by simple sequential local-NVMe speed.
   `dd`-style storage microbenchmarks matched between EC2 and CloudZero when
   instance class was matched, but RM flush remains `24-33s` slower than fresh EC2
   flush samples.
7. CPU quota, cgroup scheduling, and live-process contention remain plausible for
   the flush gap. A Docker run with `--cpus=1` and no cpuset reported `14.311s`
   of cgroup throttling and slower total time.
8. CPU throttling is not the complete explanation. A pinned Docker run had zero
   cgroup throttling but was still slow due copy/other and index variance.
9. A broad "Kubernetes is slow" or "the production Zero image is slow" hypothesis
   is unlikely. The view-syncer exec completed in `148.505s` on stronger
   resources.

## Extended EC2 Follow-Up Plan

The goal of the next EC2-only pass is to make the EC2 side as repeatable and
well-characterized as possible, then compare those stable EC2 baselines against
the CloudZero RM and view-syncer datapoints already collected.

The current EC2 target is:

| Field       | Value                                             |
| ----------- | ------------------------------------------------- |
| Instance ID | `i-0a63bbe9c60720852`                             |
| Public DNS  | `ec2-54-175-216-25.compute-1.amazonaws.com`       |
| Public IP   | `54.175.216.25`                                   |
| Private IP  | `172.31.44.89`                                    |
| Instance    | `m7gd.2xlarge`                                    |
| vCPUs       | `8`                                               |
| AMI         | `al2023-ami-2023.12.20260629.0-kernel-6.18-arm64` |

Planned EC2 tests:

1. Re-inventory the host because the public DNS changed and local NVMe is
   ephemeral across stop/start cycles.
2. Confirm `/data` exists, is backed by local NVMe, and is mounted as XFS before
   trusting any storage or SQLite results.
3. Confirm the repo, Node, pnpm, Docker, and any existing benchmark harness are
   still present after the instance restart.
4. If `/data` is missing or empty, recreate only the minimal local setup needed
   for measurements and document the setup gap.
5. Repeat raw binary COPY-to-null on EC2 several times in the same runtime used
   for the Zero `1.7.0` benchmark.
6. Run COPY-to-null samples close together to estimate short-window variance.
7. Run COPY-to-null samples separated by other work to estimate wider time-window
   variance.
8. Compare EC2 COPY-to-null variance against the CloudZero RM range of
   `79.332-93.676s` and the view-syncer sample of `76.532s`.
9. If EC2 COPY-to-null has low variance around `64s`, treat CloudZero's slower
   COPY path as a real environment/network delta.
10. If EC2 COPY-to-null has large variance, downgrade the certainty of any
    network-path conclusion and require same-window paired tests.
11. Repeat the full Zero `1.7.0` all-index initial sync on EC2 if the harness is
    still available.
12. Run at least two EC2 full initial-sync repetitions to determine whether the
    prior `172.353s` result was stable or a fast outlier.
13. Track full initial-sync phase timing: copy/other, flush, index, and
    `email_content` excluding flush.
14. Compare repeated EC2 full-run flush timings against the RM exec flush of
    `67.700s`.
15. Run sequential storage microbenchmarks on `/data` again to verify the new
    boot has the expected local-NVMe behavior.
16. Run a SQLite-specific flush microbenchmark on `/data`, not only `dd`, because
    the remaining RM gap is in SQLite flush rather than simple sequential write.
17. Make the SQLite flush microbenchmark approximate the workload shape: large
    inserted blobs/text, transaction commit, WAL or journal files, and forced
    flush/sync.
18. Run the SQLite flush microbenchmark under no CPU limit to establish host
    ceiling.
19. Run the same SQLite flush microbenchmark under a `1 CPU` container or cgroup
    limit to match RM and prior EC2 benchmark conditions.
20. If Docker is available, compare bare-metal Node vs Docker Node on the same
    host and same `/data` path.
21. If Docker is available, compare Docker with `--cpus=1` only vs
    `--cpus=1 --cpuset-cpus=0` to separate quota effects from CPU pinning.
22. If Docker is available, compare `node:22-bookworm` against the production Zero
    image only if the image is already available or can be pulled without special
    credentials.
23. Capture CPU throttling counters before and after each cgroup-limited run.
24. Capture filesystem free space and database/WAL sizes before and after each
    SQLite-focused run.
25. Capture kernel, instance, mount, block-device, and CPU governor details in the
    document if they differ from earlier EC2 assumptions.
26. Test whether `TMPDIR` and `SQLITE_TMPDIR` placement still matter on EC2 by
    comparing `/data/tmp` to the default temp path only if safe free space exists.
27. Avoid reusing failed `/tmp` overlay conditions as valid results; document them
    only as invalid runs.
28. If the full harness is unavailable, still collect raw COPY, storage, and
    SQLite microbenchmark results because those isolate the most likely remaining
    causes.
29. Do not run destructive commands against user data; create unique temp files
    and remove only files created by this pass.
30. Update this document after each completed block with exact commands, timing,
    and interpretation.

Expected decision points:

1. If EC2 full sync remains near `172s` while RM exec remains `239s`, the RM gap
   is stable and not a prior EC2 outlier.
2. If EC2 COPY-to-null remains near `64s`, CloudZero's `76-94s` COPY-to-null range
   is a real network/runtime-path delta.
3. If EC2 SQLite flush microbenchmarks are much faster than RM-like numbers under
   equivalent `1 CPU` limits, focus next on K8s cgroup scheduling, live RM
   contention, or SQLite fsync behavior inside the pod.
4. If EC2 SQLite flush becomes RM-like under `1 CPU` quota but not under no quota,
   CPU scheduling/quota is likely part of the flush gap.
5. If EC2 SQLite flush stays fast under `1 CPU`, the RM flush gap likely depends
   on Kubernetes pod/node/runtime details rather than CPU quota alone.
6. If EC2 Docker is slower than bare-metal by a large amount, container runtime
   overhead must be controlled in all comparisons.
7. If EC2 Docker matches bare-metal, CloudZero-specific runtime or cgroup behavior
   remains more likely than generic container overhead.

## Extended EC2 Follow-Up Results

These tests were run on the fresh EC2 host after the instance-store disk had been
recreated and mounted.

Environment inventory:

| Field             | Value                                         |
| ----------------- | --------------------------------------------- |
| Hostname          | `ip-172-31-44-89.ec2.internal`                |
| Public DNS        | `ec2-54-175-216-25.compute-1.amazonaws.com`   |
| Instance          | `m7gd.2xlarge`                                |
| Kernel            | `6.18.35-68.129.amzn2023.aarch64`             |
| Architecture      | `aarch64`                                     |
| vCPUs             | `8`                                           |
| `/data`           | `/dev/nvme1n1` xfs, `441.4G` instance storage |
| Host Node         | `v18.20.8`                                    |
| Docker Node image | `node:22-bookworm`, Node `v22.23.1`           |
| Repo              | `/data/mono`                                  |
| Branch            | `0xcadams/zero-v1.7-zmail-bench`              |
| Commit            | `90e3aac`                                     |

The new boot did not have `/data` mounted initially. The instance-store device
had no filesystem, so it was initialized as XFS and mounted at `/data` before
running benchmarks.

Storage sanity check on the fresh boot:

| Test                                |   Result |
| ----------------------------------- | -------: |
| 4 GiB write with `conv=fsync`       | `13.03s` |
| 4 GiB cold read after `drop_caches` |  `5.08s` |

This matches the earlier `m7gd.2xlarge` storage class result and confirms the
fresh boot still had healthy local NVMe.

### Fresh EC2 COPY-To-Null Samples

Raw COPY-to-null was run ten times in a `node:22-bookworm` container with
`--cpus=1 --cpuset-cpus=0 --memory=3072m --memory-swap=3072m`.

| Sample |   Seconds |    Throughput |
| ------ | --------: | ------------: |
| 1      | `54.251s` | `531.1 MiB/s` |
| 2      | `52.289s` | `551.0 MiB/s` |
| 3      | `63.917s` | `450.8 MiB/s` |
| 4      | `56.260s` | `512.1 MiB/s` |
| 5      | `53.757s` | `536.0 MiB/s` |
| 6      | `54.614s` | `527.5 MiB/s` |
| 7      | `67.996s` | `423.7 MiB/s` |
| 8      | `58.508s` | `492.4 MiB/s` |
| 9      | `53.399s` | `539.6 MiB/s` |
| 10     | `82.949s` | `347.3 MiB/s` |

Summary:

| Metric  |                     Value |
| ------- | ------------------------: |
| Fastest | `52.289s` (`551.0 MiB/s`) |
| Slowest | `82.949s` (`347.3 MiB/s`) |
| Average | `59.794s` (`481.8 MiB/s`) |

Interpretation:

- EC2 raw COPY-to-null is usually much faster than CloudZero RM samples, but it
  has a slow tail.
- The slowest EC2 sample, `82.949s`, overlaps the CloudZero RM range and is
  slower than the view-syncer same-pod sample of `76.532s`.
- Therefore a single COPY-to-null sample is not enough to precisely subtract
  network time from initial-sync copy/other. Same-window paired COPY-to-null and
  full-sync runs are required.

### Fresh EC2 Full Initial-Sync Repetitions

The exact Zero `1.7.0` harness was rerun several times on the fresh EC2 host. All
timings below use the initial-sync summary line, not the outer Vitest elapsed
time.

| Run                                      | CPU shape                  |      Total | Copy/other |     Flush |     Index |
| ---------------------------------------- | -------------------------- | ---------: | ---------: | --------: | --------: |
| Prior EC2 code-parity run                | `--cpus=1 --cpuset-cpus=0` | `172.353s` |  `75.391s` | `35.298s` | `61.665s` |
| Fresh run 1                              | `--cpus=1 --cpuset-cpus=0` | `179.356s` |  `76.527s` | `35.011s` | `67.818s` |
| Fresh run 2                              | `--cpus=1 --cpuset-cpus=0` | `193.363s` |  `80.159s` | `41.900s` | `71.304s` |
| Fresh run 3 after `sync` + `drop_caches` | `--cpus=1 --cpuset-cpus=0` | `192.263s` |  `79.888s` | `43.266s` | `69.109s` |
| No CPU limit                             | no CPU quota/pinning       | `176.813s` |  `70.210s` | `38.030s` | `68.574s` |
| Quota, no cpuset                         | `--cpus=1` only            | `198.487s` |  `87.642s` | `41.962s` | `68.883s` |
| Quota plus cpuset, stats captured        | `--cpus=1 --cpuset-cpus=0` | `217.059s` | `102.511s` | `37.452s` | `77.096s` |

The same table as throughputs:

| Run                                      |       Overall |    Copy/other |         Flush |         Index |
| ---------------------------------------- | ------------: | ------------: | ------------: | ------------: |
| Prior EC2 code-parity run                | `167.2 MiB/s` | `382.2 MiB/s` | `816.3 MiB/s` | `467.2 MiB/s` |
| Fresh run 1                              | `160.6 MiB/s` | `376.5 MiB/s` | `822.9 MiB/s` | `424.8 MiB/s` |
| Fresh run 2                              | `149.0 MiB/s` | `359.4 MiB/s` | `687.6 MiB/s` | `404.1 MiB/s` |
| Fresh run 3 after `sync` + `drop_caches` | `149.9 MiB/s` | `360.7 MiB/s` | `665.9 MiB/s` | `416.9 MiB/s` |
| No CPU limit                             | `162.9 MiB/s` | `410.4 MiB/s` | `757.6 MiB/s` | `420.2 MiB/s` |
| Quota, no cpuset                         | `145.2 MiB/s` | `328.7 MiB/s` | `686.6 MiB/s` | `418.3 MiB/s` |
| Quota plus cpuset, stats captured        | `132.7 MiB/s` | `281.1 MiB/s` | `769.3 MiB/s` | `373.7 MiB/s` |

CPU quota stats from the quota-only run:

| Metric           |           Value |
| ---------------- | --------------: |
| `cpu.max`        | `100000 100000` |
| `usage_usec`     |   `138,705,040` |
| `nr_periods`     |         `1,993` |
| `nr_throttled`   |           `894` |
| `throttled_usec` |    `14,311,337` |

CPU quota stats from the quota-plus-cpuset run:

| Metric           |           Value |
| ---------------- | --------------: |
| `cpu.max`        | `100000 100000` |
| `usage_usec`     |   `139,943,763` |
| `nr_periods`     |         `2,217` |
| `nr_throttled`   |             `0` |
| `throttled_usec` |             `0` |

Interpretation:

- The original `172.353s` EC2 code-parity run was not impossible, but it was on
  the fast end of observed EC2 behavior.
- Fresh EC2 total time varied from `176.813s` to `217.059s` across repeated full
  runs. That is much wider than the first comparison assumed.
- EC2 copy/other varied from `70.210s` to `102.511s`. RM exec copy/other was
  `102.264s`, which overlaps the slow EC2 tail. Copy/other is therefore no
  longer a durable RM-specific gap.
- EC2 flush varied from `35.011s` to `43.266s`. RM exec flush was `67.700s`, so
  flush remains the most durable RM-vs-EC2 gap.
- EC2 index varied from `67.818s` to `77.096s` in fresh runs. RM exec index was
  `68.609s`, so index is not a durable RM-specific gap.
- Quota without cpuset produced measurable throttling (`14.311s`) and a slower
  full run. This makes K8s CPU quota/scheduling a plausible contributor.
- The cpuset run with stats had zero throttling but was still slow due to
  copy/other and index variance. CPU throttling is therefore a contributor, not a
  complete explanation.
- The RM exec total was `238.572s`, which is still slower than the slowest fresh
  EC2 run by `21.513s`. Against the quota-only EC2 shape, the RM difference is
  `40.085s`, split mostly into `+14.622s` copy/other and `+25.738s` flush.

### SQLite Microbenchmark Caveat

A synthetic SQLite import-only stress test used `@rocicorp/zero-sqlite3@1.1.2`
with the same initial-sync migration pragmas:

```text
unsafeMode(true)
locking_mode = EXCLUSIVE
foreign_keys = OFF
journal_mode = OFF
synchronous = OFF
```

The full-size insert-only run inserted `246,138` rows with `120,000` text bytes
per row in a `1 CPU` container:

| Metric            |            Value |
| ----------------- | ---------------: |
| Approx payload    | `28,168.259 MiB` |
| Insert time       |        `98.116s` |
| Insert throughput |    `287.1 MiB/s` |
| DB size           | `28,364.770 MiB` |
| Commit time       |         `0.049s` |

This was much slower than real Zero flush on EC2 (`35-43s`). It should be treated
as a synthetic dirty-page/writeback stress test, not as a faithful model of
initial-sync flush. The real initial sync is network-paced and interleaves COPY,
decoding, batching, and SQLite writes in a way this isolated writer does not.

## Raw COPY-To-Null Comparison

Raw binary COPY-to-null was measured with the same Node `postgres` package path
used by Zero, reading `email_content` and discarding chunks without parsing into
SQLite.

| Environment                                    |   Seconds |    Throughput |
| ---------------------------------------------- | --------: | ------------: |
| EC2 original single sample                     | `64.308s` | `448.0 MiB/s` |
| EC2 fresh samples, fastest                     | `52.289s` | `551.0 MiB/s` |
| EC2 fresh samples, slowest                     | `82.949s` | `347.3 MiB/s` |
| EC2 fresh samples, average                     | `59.794s` | `481.8 MiB/s` |
| CloudZero RM `m7gd.2xlarge`, AWS NAT, sample 1 | `79.332s` | `363.2 MiB/s` |
| CloudZero RM `m7gd.2xlarge`, AWS NAT, sample 2 | `92.442s` | `311.7 MiB/s` |
| CloudZero RM `m7gd.2xlarge`, AWS NAT, sample 3 | `93.676s` | `307.6 MiB/s` |
| CloudZero view-syncer `m8gd.4xlarge`, AWS NAT  | `76.532s` | `376.5 MiB/s` |

All listed runs read exactly `30,211,144,726` bytes (`28,811.593 MiB`) in `246,139`
chunks.

The RM raw COPY-to-null samples range from `79.332s` to `93.676s`. Fresh EC2
samples range from `52.289s` to `82.949s`. CloudZero RM is slower in the common
case, but the slow EC2 tail overlaps the fast CloudZero RM sample.

The residual copy/other overhead is now too sensitive to sample pairing for a
single precise number:

| Environment                                        | Initial-sync copy/other | Raw COPY-to-null | Residual overhead |
| -------------------------------------------------- | ----------------------: | ---------------: | ----------------: |
| EC2 original code-parity run                       |               `75.391s` |        `64.308s` |         `11.083s` |
| EC2 fresh fastest full run vs fresh average COPY   |               `70.210s` |        `59.794s` |         `10.416s` |
| EC2 fresh slowest copy/other vs fresh slowest COPY |              `102.511s` |        `82.949s` |         `19.562s` |
| CloudZero RM exec, fastest RM raw sample           |              `102.264s` |        `79.332s` |         `22.932s` |
| CloudZero RM exec, slowest RM raw sample           |              `102.264s` |        `93.676s` |          `8.588s` |

This weakens the earlier conclusion that CloudZero definitely had a large
separate non-raw-COPY overhead inside the copy/other bucket. Depending on sample
pairing, EC2 residuals and RM residuals overlap. The safer conclusion is that
raw COPY/network variability can explain most, and possibly all, of the RM
copy/other gap.

The view-syncer result reinforces the variance point. Its same-pod COPY-to-null
was `76.532s`, but its initial-sync copy/other bucket was `66.374s`. That means a
single COPY-to-null measurement should not be treated as a strict lower bound for
nearby initial-sync COPY/other timing.

Recommended next tests:

1. Repeat RM COPY-to-null immediately before and after a full RM exec benchmark
   to bind raw COPY variance to the same pod, node, and time window.
2. Run RM with cgroup CPU throttling and PSI captured for the whole run.
3. Run a same-window EC2 pair: COPY-to-null, full sync, COPY-to-null, with cgroup
   stats captured, to quantify residual overhead without cross-window variance.
4. Run a SQLite-focused flush microbenchmark in the RM pod and view-syncer pod,
   recognizing that the synthetic EC2 writer did not model real Zero flush well.
5. Run the full benchmark in an approved isolated CloudZero pod on
   `m7gd.2xlarge` with `1 CPU`, if admission policy allows it, to remove live RM
   contention.
6. Compare NAT gateway, route, ENI, AZ, and node-network path for EC2, RM, and
   view-syncer COPY-to-null runs.
7. Clean up stale inactive replication slots after testing.

Operational recommendations:

- Do not use tiny `fck-nat` for initial-sync-heavy staging benchmarks.
- Avoid `m6gd.xlarge` for cold-recovery-sensitive replication managers with
  large materialized payloads.
- For this workload class, prefer `m7gd.2xlarge` or equivalent local NVMe
  performance for replication-manager placement.
