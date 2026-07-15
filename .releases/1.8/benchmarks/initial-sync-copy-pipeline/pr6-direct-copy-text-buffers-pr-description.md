### What

This changes binary PostgreSQL COPY initial sync so eligible text-like values
remain Buffers until SQLite binding instead of being decoded into JavaScript
strings. SQLite receives those parameters through `CAST(? AS TEXT)`, preserving
TEXT storage and query behavior while avoiding a Buffer-to-string-to-UTF-8 round
trip.

The treatment applies only where PostgreSQL's binary representation is already
UTF-8 text: scalar `text`, `varchar`, `bpchar`, JSON, JSONB, and enum columns.
Arrays, PostgreSQL's internal OID 18 `"char"`, unknown text-cast types, bytea,
numeric, temporal, UUID, boolean, and numeric values retain their established
decoders.

### Why

The existing path decodes COPY text fields into JavaScript strings and the
SQLite addon then encodes those strings back to UTF-8 during binding. This is
especially expensive for wide text and JSON fields, increases transient memory
and GC work, and does not add information when the PostgreSQL field is already
UTF-8.

The canonical clean local benchmark was directionally positive in all seven
direct parent/head comparisons:

| Profile                | Direct throughput vs parent |
| ---------------------- | --------------------------: |
| `mixed-regression`     |                      +2.89% |
| `wide-text-scaled`     |                      +3.37% |
| `wide-text-full`       |                      +2.51% |
| `wide-text-narrow`     |                     +13.03% |
| `large-payload-scaled` |                      +2.25% |
| `large-payload-full`   |                      +4.01% |
| `large-payload-narrow` |                      +9.22% |

An isolated constrained-Linux experiment compared the actual parent and head on
the 10,000-row, 6.83 GB Email fixture in ten fresh AB/BA pairs at 1 CPU and 3 GiB
memory. Nine pairs favored this change. Paired callback time fell 25.00% and
paired whole-`initReplica` time fell 24.86%, corresponding to 33.33% and 33.09%
throughput gains. Peak process RSS fell 47.05%, user CPU fell 43.95%, and
observed GC time fell 62.90%. Raw COPY was 1.69% slower, so source transfer did
not account for the improvement.

The Linux result had a variable tail: one retained head run regressed 31.25%
with unusually high SQLite flush, GC, and scoped I/O-pressure time. The effect
was also environment-sensitive on the scaled fixture: paired callback time fell
31.07% on a direct Linux Docker bridge, 1.52% on the macOS host, and 4.32% on a
Linux host-port hairpin. These results support lower allocation and substantial
gains in the tested constrained-Linux topology, not a universal percentage.

The preregistered canonical `wide-text-full` gate required at least 5% with an
interval above parity. Its clean local result was +2.51%, so that formal gate was
not met and this PR should not promise a general initial-sync speedup.

### Changes

- Add `isDirectTextBufferColumn` to identify scalar PostgreSQL types whose
  binary COPY payload can be bound directly as UTF-8 text.
- Add `makeBinaryColumnDecoder` to retain eligible Buffers, strip JSONB's binary
  version byte, and preserve existing decoders for every excluded type.
- Generate `CAST(? AS TEXT)` placeholders only for direct Buffer columns in
  initial-sync INSERT statements.
- Cover decoder selection, JSONB prefix handling, arrays, null and empty values,
  Unicode, enums, unknown types, PostgreSQL 15-18 initial sync, SQLite
  `typeof()`, JSON functions, equality, ordering, collation, and indexed lookup.
- Keep the change entirely in TypeScript with no feature flag, native addon API,
  dependency, or lockfile change.
