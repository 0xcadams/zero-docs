# Prod Incidents for PL and Margins

Two Zero stacks had slow cold recovery because `replication-manager` had to rebuild a SQLite replica via initial sync, then Litestream/S3 had to make a restorable backup before `view-syncer` could serve.

The common path was:

```text
replication-manager full initial sync
-> SQLite index creation
-> Litestream backup upload
-> view-syncer restore/download
-> zero-cache ready
```

The dominant delay in both incidents was initial sync, especially one large table plus SQLite indexing.

**Logical Byte Caveat**

The original incident logs do not contain exact logical COPY byte counts.

The logged per-table `totalBytes` values came from `pg_table_size(oid)` on `origin/main`. That is a PostgreSQL physical table-size estimate, not the bytes sent by `COPY`, and not decoded logical payload bytes. It can be especially misleading for TOAST-heavy tables.

All MiB/s rates below are explicitly labeled by denominator:

| Label                  |                     Denominator | Meaning                                                               |
| ---------------------- | ------------------------------: | --------------------------------------------------------------------- |
| SQLite-size-normalized |       Final SQLite DB file size | Useful end-to-end recovery normalization, not COPY throughput.        |
| Physical-estimate      | PostgreSQL `pg_table_size(oid)` | Useful old-log table-copy normalization, not logical COPY throughput. |

To measure logical bytes accurately in future incidents, use new initial-sync logs with `copyStreamBytes` for exact PostgreSQL COPY stream bytes and `decodedFieldBytes` for unframed non-null field payload bytes. For these historical incidents, exact logical bytes would require rerunning the exact COPY path against the same database/snapshot or backup.

**Incident Summary**

| Stack              | Scope                                | Main Failure                                                                  | Main Bottleneck                                       | Recovery Outcome                              |
| ------------------ | ------------------------------------ | ----------------------------------------------------------------------------- | ----------------------------------------------------- | --------------------------------------------- |
| `xvav0bi8hbwv988s` | Margins, `us-west-1`, public cluster | Postgres logical replication slot invalidated, forcing full replica rebuild   | `userspace.imports` copy plus `39.6m` SQLite indexing | Both view-syncers ready after roughly `1h57m` |
| `aeuuxvuox8o4ecw3` | PL, `eu-central-1`, public cluster   | View-syncers had no matching backup until RM rebuilt/uploaded a fresh replica | `Email` copy tail plus `16m43s` SQLite indexing       | End-to-end recovery roughly `56m`             |

**Overall Initial Sync**

These rates divide the final SQLite DB size by elapsed time. They are not logical COPY throughput. The runtime log labels this value `MB`, but the code divides bytes by `1024 * 1024`, so the table reports it as MiB.

| Stack              |          Rows | Tables | Final SQLite Size | Initial Sync |     Indexing |   Copy/Other | SQLite-Size MiB/s Total | SQLite-Size MiB/s Copy/Other |
| ------------------ | ------------: | -----: | ----------------: | -----------: | -----------: | -----------: | ----------------------: | ---------------------------: |
| `xvav0bi8hbwv988s` | `259,541,985` |   `84` |  `152,026.29 MiB` | `89m34.755s` | `39m38.355s` | `49m56.399s` |            `28.3 MiB/s` |                 `50.7 MiB/s` |
| `aeuuxvuox8o4ecw3` |   `4,361,138` |  `104` |   `87,104.81 MiB` | `41m42.877s` | `16m43.121s` | `24m59.756s` |            `34.8 MiB/s` |                 `58.1 MiB/s` |

`Copy/Other` is `initial sync total - index time`. It includes table copy, SQLite flushing, initial-state computation, scheduling overhead, and any other non-index initial-sync work.

**Slow Table Copy Stats**

These rates divide old-log `pg_table_size(oid)` estimates by per-table copy timings. They are physical-estimate rates, not logical COPY throughput.

| Stack              | Slow Table          | Rows Copied | `pg_table_size` Est. |       Est. MiB |    Copy Time |  Flush Time | Non-Flush Time | Physical-Est MiB/s Total | Physical-Est MiB/s Non-Flush |
| ------------------ | ------------------- | ----------: | -------------------: | -------------: | -----------: | ----------: | -------------: | -----------------------: | ---------------------------: |
| `xvav0bi8hbwv988s` | `userspace.imports` |   `174,658` |      `9,685,008,384` |  `9,236.3 MiB` | `37m50.133s` | `3m46.989s` |   `34m03.143s` |              `4.1 MiB/s` |                  `4.5 MiB/s` |
| `aeuuxvuox8o4ecw3` | `Email`             |   `383,471` |     `14,628,429,824` | `13,950.8 MiB` | `24m49.713s` | `6m58.353s` |   `17m51.361s` |              `9.4 MiB/s` |                 `13.0 MiB/s` |

**Row Rates**

| Stack              | Slow Table          |  Rows/s Total | Rows/s Non-Flush | Physical-Est KiB/Copied Row |
| ------------------ | ------------------- | ------------: | ---------------: | --------------------------: |
| `xvav0bi8hbwv988s` | `userspace.imports` |  `~77 rows/s` |     `~85 rows/s` |             `~54.2 KiB/row` |
| `aeuuxvuox8o4ecw3` | `Email`             | `~257 rows/s` |    `~358 rows/s` |             `~37.3 KiB/row` |

The KiB/row column is also physical-estimate based. It is not an exact average logical row payload.

**`xvav0bi8hbwv988s` Timeline**

|       Time UTC | Event                                                                                         |
| -------------: | --------------------------------------------------------------------------------------------- |
|    `14:05:06Z` | Replication slot `z_xvav0bi8hbwv988s_0_b` invalidated for exceeding `max_slot_wal_keep_size`. |
|       `14:05Z` | `replication-manager` reset `/data/replica.db` and created a new slot.                        |
|    `15:34:41Z` | Full sync completed: `259,541,985` rows, `84` tables, `5,374,754.538 ms`.                     |
| `15:40-15:57Z` | View-syncers repeatedly restored stale Litestream generation `b412ee8c7bd61194`.              |
|    `15:55:35Z` | Compatible S3-backed watermark became available.                                              |
|    `15:59:15Z` | First view-syncer became ready after restoring generation `c2695ba57d4fdb0a`.                 |
|    `16:02:36Z` | Both view-syncers became ready.                                                               |

Raw evidence:

```text
replication slot z_xvav0bi8hbwv988s_0_b has been invalidated for exceeding the max_slot_wal_keep_size
Started 5 workers to copy 84 tables
Computed initial download state for userspace.imports ... totalRows=164983 totalBytes=9685008384
Finished copying 174658 rows into userspace.imports (flush: 226989.441 ms) (total: 2270132.859 ms)
Created indexes (2378355.111 ms)
Synced 259,541,985 rows of 84 tables ... (flush: 1252386.323, index: 2378355.111, total: 5374754.538 ms)
Size of db /data/replica.db: 152026.29 MB (0.00 MB freeable)
starting litestream backup to s3://backup.858688938004.us-west-1.public.xvav0bi8hbwv988s/2026-06-17T23:33:27.726Z/
```

View-syncer restore evidence:

```text
2026-06-19T15:40:55.467452337Z restoring snapshot ... generation=b412ee8c7bd61194
Local replica version 89aleibzow does not match expected replicaVersion 89ap3d8pig
Deleting local replica and retrying restore
2026-06-19T15:56:18.982011842Z restoring snapshot ... generation=c2695ba57d4fdb0a
2026-06-19T15:59:15.98906894Z applied wal ... generation=c2695ba57d4fdb0a
zero-cache ready (1119846.341286 ms)
2026-06-19T16:02:36.531846184Z applied wal ... generation=c2695ba57d4fdb0a
zero-cache ready (1320621.9992 ms)
```

**`aeuuxvuox8o4ecw3` Timeline**

|    Time UTC | Event                                                                    |
| ----------: | ------------------------------------------------------------------------ |
| `13:02:19Z` | RM opened replication session.                                           |
| `13:02:20Z` | Copy workers started: `5` workers for `104` tables.                      |
| `13:02:29Z` | `Email` copy started.                                                    |
| `13:03:39Z` | Last non-`Email` table finished.                                         |
| `13:27:19Z` | `Email` copy finished after `24m49.713s`.                                |
| `13:44:02Z` | Index creation finished after `16m43.121s`; initial-sync summary logged. |
| `13:44:14Z` | RM started Litestream backup.                                            |
| `13:44:17Z` | RM became ready after `42m11.339s`.                                      |
| `13:50:59Z` | View-syncer began downloading snapshot.                                  |
| `13:58:01Z` | View-syncers became ready after roughly `10m12s` from restore start.     |

Raw evidence:

```text
2026-06-22T13:02:20.173322047Z Started 5 workers to copy 104 tables
2026-06-22T13:02:20.304895411Z Computed initial download state for Email ... totalRows=382931 totalBytes=14628429824
2026-06-22T13:02:29.401330883Z Starting binary copy stream of Email ...
2026-06-22T13:27:19.085246062Z Finished copying 383471 rows into Email (flush: 418352.542 ms) (total: 1489713.294 ms)
2026-06-22T13:44:02.268082843Z Created indexes (1003121.333 ms)
2026-06-22T13:44:02.727681833Z Synced 4,361,138 rows of 104 tables ... (flush: 444773.697, index: 1003121.333, total: 2502876.992 ms)
2026-06-22T13:44:14.768553657Z starting litestream backup to s3://backup.858688938004.eu-central-1.public.aeuuxvuox8o4ecw3/2026-06-22T13:01:00.063Z/
2026-06-22T13:44:17.508394377Z zero-cache ready (2531339.211773 ms)
2026-06-22T13:50:59.670331811Z downloading snapshot in 48 parallel parts of size 16777216
2026-06-22T13:58:01.390175141Z zero-cache ready (611912.50513 ms)
2026-06-22T13:58:01.537479322Z zero-cache ready (612271.144664 ms)
```

**Conclusions**

The old logs prove both incidents spent most of recovery in RM initial sync and SQLite index creation. They do not prove exact logical COPY MiB/s because the old byte field was `pg_table_size(oid)`.

`xvav0bi8hbwv988s` had two distinct delays: RM full rebuild after logical-slot invalidation, then view-syncers losing time on a stale Litestream generation before accepting generation `c2695ba57d4fdb0a`.

`aeuuxvuox8o4ecw3` was dominated by the long `Email` copy tail, `16m43s` of SQLite index creation, then waiting for Litestream backup and view-syncer snapshot download/restore.

For future incidents, compare actual `copyStreamBytes` MiB/s and `decodedFieldBytes` MiB/s from the new logs. Treat any `pg_table_size` or final SQLite-size rate only as a rough physical-size normalization.

**Sources**

Recovered from `/Users/chase/.local/share/opencode/opencode.db`, especially parts `prt_ef6e98028001aJQ45Mumpmi3FH`, `prt_ef6cb42df0012Z99U2VPk2sfp3`, `prt_ef6c61f95001ToGufPHi45yxPQ`, `prt_ee0a40bab001tIN7mmg99rgfaT`, `prt_ee0a40e970014OklT36HOUN6Tg`, and `prt_ee0a40ed2001gqLwL7V4t2Oejx`.
