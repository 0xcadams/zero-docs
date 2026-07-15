# Managed PostgreSQL Binary COPY Framing

## Decision

Keep PR 5, the linear fragmented-field parser, deferred for the current Zero
binary COPY path.

PostgreSQL 17 and 18 construct each binary COPY row in one buffer and send that
row as one PostgreSQL protocol `CopyData` message. `postgres.js` 3.4.7
reassembles TCP and TLS fragments into a complete protocol message before
exposing its payload to Zero. Direct probes through PlanetScale and Supabase
confirmed that neither provider rewrites those row messages.

Across both providers and all five generated profiles:

- Every row and field was contained in one stream chunk delivered to Zero's
  initial-sync `Writable`.
- Zero's current `BinaryCopyParser` made zero `Buffer.concat` calls.
- Each N-row run delivered N row chunks plus one two-byte binary trailer chunk.
- Network packet size, TLS record size, and PostgreSQL's physical socket writes
  did not become parser chunk boundaries.

The synthetic 5.5 KiB and 31 KiB rechunking benchmarks remain useful stress
tests for parser robustness. They do not model the current direct managed
PostgreSQL path.

## Safety

The probe used only read-only generated queries of this form:

```sql
COPY (
  SELECT repeat(...), ...
  FROM generate_series(...)
) TO STDOUT WITH (FORMAT binary)
```

It did not enumerate, read, create, alter, or delete application objects. No
credentials are retained in this report.

PlanetScale used certificate-verifying TLS. Supabase used encrypted,
non-verifying TLS equivalent to `sslmode=require` because its direct endpoint's
certificate chain was not trusted by Node on this host. The Supabase hostname
was retained for TLS SNI while its newly enabled IPv4 address was supplied
directly because the host initially had no route to the endpoint's IPv6 address.
TLS verification does not affect PostgreSQL protocol message framing.

## Environment

| Provider    | Server                       | Client path                                        |
| ----------- | ---------------------------- | -------------------------------------------------- |
| PlanetScale | PostgreSQL 18.4, Linux ARM64 | `postgres.js` 3.4.7 and current `BinaryCopyParser` |
| Supabase    | PostgreSQL 17.6, Linux x64   | `postgres.js` 3.4.7 and current `BinaryCopyParser` |

The probe consumed `.readable()` with `pipeline(..., new Writable(...))`, matching
serving initial sync in
`packages/zero-cache/src/services/change-source/pg/initial-sync.ts`. It passed
each `Writable.write()` Buffer directly to the current `BinaryCopyParser`.

For each incoming chunk, the probe recorded its byte range in the complete
binary stream. It then parsed every tuple and field frame, counted how many
incoming chunks intersected each row and field, and scoped an interception of
`Buffer.concat` to each `BinaryCopyParser.parse()` call. This measures the exact
allocation path that PR 5 would replace.

## Results

PlanetScale and Supabase produced identical framing and byte counts:

| Profile                      | Rows | Large-field shape        | Stream bytes | Incoming chunks | Parsed fields | Split rows | Split fields | Parser concat calls | Parser concat bytes |
| ---------------------------- | ---: | ------------------------ | -----------: | --------------: | ------------: | ---------: | -----------: | ------------------: | ------------------: |
| `contained-4k`               |  256 | 4,096 bytes              |    1,080,853 |             257 |         1,792 |          0 |            0 |                   0 |                   0 |
| `large-payload-270k`         |   64 | 276,480 bytes            |   17,702,805 |              65 |           448 |          0 |            0 |                   0 |                   0 |
| `wide-text-683k`             |   32 | 699,392 bytes            |   22,396,117 |              33 |           800 |          0 |            0 |                   0 |                   0 |
| `wide-text-683k-distributed` |   32 | four 174,848-byte fields |   22,394,581 |              33 |           800 |          0 |            0 |                   0 |                   0 |
| `wide-text-1.5m`             |   16 | 1,572,864 bytes          |   25,173,621 |              17 |           400 |          0 |            0 |                   0 |                   0 |

The incoming chunk lengths also matched PostgreSQL row framing exactly:

| Profile                      | Normal row chunk | First row chunk | Trailer chunk |
| ---------------------------- | ---------------: | --------------: | ------------: |
| `contained-4k`               |            4,222 |           4,241 |             2 |
| `large-payload-270k`         |          276,606 |         276,625 |             2 |
| `wide-text-683k`             |          699,878 |         699,897 |             2 |
| `wide-text-683k-distributed` |          699,830 |         699,849 |             2 |
| `wide-text-1.5m`             |        1,573,350 |       1,573,369 |             2 |

The first row chunk is 19 bytes larger because it contains the binary COPY
header. The final two-byte chunk is the binary trailer. This explains the
production invariant for nonempty tables:

```text
chunks = rows + published_tables * successful_runs
```

## Why Transport Fragmentation Does Not Reach The Parser

PostgreSQL's protocol documentation states that COPY OUT `CopyData` messages
correspond to individual rows:

- [PostgreSQL 17 `CopyData`](https://www.postgresql.org/docs/17/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-COPYDATA)
- [PostgreSQL 18 `CopyData`](https://www.postgresql.org/docs/18/protocol-message-formats.html#PROTOCOL-MESSAGE-FORMATS-COPYDATA)

The server implementation makes that boundary explicit:

- PostgreSQL 17 builds a binary tuple in `CopyOneRowTo()` and
  `CopySendEndOfRow()` sends the accumulated row in one `CopyData` message:
  [row construction](https://github.com/postgres/postgres/blob/REL_17_10/src/backend/commands/copyto.c#L906-L974),
  [message send](https://github.com/postgres/postgres/blob/REL_17_10/src/backend/commands/copyto.c#L186-L255).
- PostgreSQL 18 does the same in the refactored
  [`CopyToBinaryOneRow()`](https://github.com/postgres/postgres/blob/REL_18_4/src/backend/commands/copyto.c#L343-L374)
  and
  [`CopySendEndOfRow()`](https://github.com/postgres/postgres/blob/REL_18_4/src/backend/commands/copyto.c#L444-L499).

PostgreSQL can physically flush a large message through multiple socket writes,
TCP packets, or TLS records. Those are fragments of one logical message. In
`postgres.js` 3.4.7, `data()` buffers socket input until the complete protocol
length is available, then `CopyData()` strips the five-byte envelope and pushes
the complete payload once:

- [`data()` protocol reassembly](https://github.com/porsager/postgres/blob/9b92b65da6a5121545581a6dd5de859c2a70177f/src/connection.js#L292-L324)
- [`CopyData()` stream push](https://github.com/porsager/postgres/blob/9b92b65da6a5121545581a6dd5de859c2a70177f/src/connection.js#L857-L892)

Node's normal `pipe()`/`pipeline()` flow may preserve or coalesce pushed
Buffers; it does not split a pushed Buffer into configured 5.5 KiB or 31 KiB
pieces. Zero adds no rechunking transform between `.readable()` and
`BinaryCopyParser.parse()`.

## Caveats And Reopen Conditions

A field can still span parser chunks if the data path changes. Reopen PR 5 if
one of these is observed:

- A PostgreSQL-aware intermediary terminates the protocol and rewrites one row
  into multiple `CopyData` messages.
- Zero adopts a driver or transform that exposes transport fragments or
  explicitly rechunks COPY payloads.
- Production terminal counters materially exceed rows plus one framing chunk
  per table and run, after failed or partial runs are excluded.
- Direct parser instrumentation observes fields spanning incoming chunks.
- Source/processing telemetry identifies a material parser gap and a trace
  attributes it to fragmented fields.

A transparent TCP or TLS proxy is insufficient because `postgres.js` performs
protocol reassembly. Very large rows are also not split by stock PostgreSQL;
the server's per-row `StringInfo` eventually reaches its allocation limit and
the query fails instead.

This conclusion is specific to production motivation. Keeping arbitrary-chunk
correctness coverage is still necessary, and the linear parser remains a valid
implementation if a future path creates real fragmentation.
