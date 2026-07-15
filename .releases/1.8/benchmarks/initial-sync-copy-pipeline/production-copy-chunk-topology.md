# Production COPY Chunk Topology

## Scope

Thirty-day terminal counters were compared for production shadow initial syncs.
The comparison covered six PL replication-manager pods, five Margins pods, Zero
1.8.0 and 1.8.0-canary.6, and counters representing one and two successful runs.

## Evidence

Every observed terminal point satisfied this invariant exactly:

```text
chunks = rows + published_tables * successful_runs
```

Representative points are:

| Stack and pod point                         | Successful runs |      Rows |    Chunks | Extra chunks | Published tables |
| ------------------------------------------- | --------------: | --------: | --------: | -----------: | ---------------: |
| PL current pod                              |               1 |   228,791 |   228,899 |          108 |              108 |
| PL prior pod                                |               2 |   448,677 |   448,893 |          216 |              108 |
| Margins prior pod, one-run cumulative point |               1 |   514,864 |   514,955 |           91 |               91 |
| Margins prior pod, two-run cumulative point |               2 | 1,029,036 | 1,029,218 |          182 |               91 |

The extra chunks are `chunks - rows`. There were no exceptions to the invariant
across the sampled pods, versions, or cumulative run counts.

The invariant is also the exact expected PostgreSQL binary COPY protocol shape.
PostgreSQL sends each row as one `CopyData` message, includes the 19-byte binary
header with the first row, and sends the two-byte trailer as one final message.
For a nonempty table this is one message per row plus one trailer message.

Read-only generated probes through PlanetScale PostgreSQL 18.4 and Supabase
PostgreSQL 17.6 reproduced that shape through Zero's exact `postgres.js` and
`pipeline(..., Writable)` path. Fields up to 1.5 MiB remained contained, and the
current parser performed no concatenation. See
`managed-pg-copy-fragmentation.md`.

## Interpretation

The counters show one COPY data chunk per sampled row plus one framing chunk per
published table per successful run. They do not show dominant large fields split
into 4-31 KiB or 5.5 KiB transport chunks.

This is not merely an average-case observation. PostgreSQL 17/18 accumulates a
row and emits it as one logical protocol message, and `postgres.js` reassembles
network and TLS fragments before passing that message to Zero. A field would
span parser chunks only if a PostgreSQL-aware intermediary rewrote protocol
messages or Zero introduced a rechunking driver or transform. Neither tested
managed provider did so.

The previous 4-31 KiB PL and 5.5 KiB Margins calculations divided
publication-wide COPY bytes by chunk count. Given the invariant above, those
values are average row sizes diluted by the publications' many small rows, not
transport chunk sizes fragmenting the dominant large fields.

## Parser Implication

The 270 KiB/5.5 KiB and 683 KiB/{31 KiB, 5.5 KiB} amplification estimates are
synthetic fragmentation scenarios. They are not supported by the current PL or
Margins production topology.

The parser microbenchmark remains valid conditionally: linear field assembly is
2.7-5.8x faster when fields are fragmented according to those synthetic inputs.
Current PL and Margins evidence provides no production performance motivation
for shipping that parser change, so PR 5 is deferred.

Reopen the treatment if production counters exceed the row-plus-framing
invariant, direct instrumentation observes split fields, the data path starts
rewriting COPY messages, or processing telemetry identifies a material parser
gap attributable to fragmentation.

## PromQL

The 30-day terminal values were collected with these queries, substituting the
stack name for `<stack>`:

```promql
max by (pod, node, sync_mode, copy_format, service_version) (max_over_time(zero_replication_initial_sync_copy_chunks_total{stack="<stack>"}[30d]))
```

```promql
max by (pod, node, sync_mode, copy_format, result, service_version) (max_over_time(zero_replication_initial_sync_rows_total{stack="<stack>"}[30d]))
```

```promql
max by (pod, node, result, service_version) (max_over_time(zero_replication_shadow_sync_runs_total{stack="<stack>"}[30d]))
```
