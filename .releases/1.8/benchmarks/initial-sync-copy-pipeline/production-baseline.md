# Production Baseline

Production observations are workload fingerprints, not benchmark inputs copied
from customer data. All rates are decimal MB/s unless otherwise noted.

## PL Email Shape

- Stack resource shape: 1 CPU, 3 GiB memory, 200 GiB ephemeral storage.
- Node shape: on-demand `m6gd.2xlarge`, local 474 GB NVMe.
- Shadow publication: 108 tables, approximately 225,000 sampled rows, 345
  SQLite indexes.
- `Email`: 25 columns and four indexes.
- Eight recent 10,000-row `Email` samples ranged from 0.252 GB to 6.830 GB.
- Per-row COPY payload ranged from 25.2 KB to 683.0 KB.
- Large samples completed the table-copy pipeline at 49-56 MB/s. This is not a
  raw network or PostgreSQL COPY-to-null rate: it includes synchronous parsing,
  SQLite insertion, and flush work that backpressures the source stream.
- Latest 6.830 GB table sample took 133.14 seconds, including 45.82 seconds in
  SQLite flush calls.
- The full latest shadow run copied 6.972 GB in 152.22 seconds and created
  indexes in 36.26 seconds.
- During that COPY window the container averaged 0.964 CPU out of its 1-core
  limit and received approximately 52.2 MB/s. The receive rate reflects
  application backpressure and must not be treated as a network-path limit.

The dominant variable-width fields are represented by `attachments`,
`htmlContent`, `raw`, and `textContent`. The production index shape is a unique
ID index plus indexes on `(threadId, createdAt, id)`, `(threadId, id)`, and
`(workspaceId, id)`.

## Margins Imports Shape

- Stack resource shape: 2 CPU, 6 GiB memory, 300 GiB ephemeral storage.
- Node shape: on-demand `m6gd.2xlarge`, local 474 GB NVMe.
- Shadow publication: 91 tables, approximately 515,000 sampled rows, 311
  SQLite indexes.
- `userspace.imports`: seven columns and six indexes.
- Eight recent 10,000-row samples ranged from 2.674 GB to 2.793 GB.
- Per-row COPY payload ranged from 267.4 KB to 279.3 KB.
- The table completed the copy pipeline at 61-65.5 MB/s and spent 19.6-21.0
  seconds in SQLite flush calls during 40.8-44.7 second table copies. These are
  end-to-end pipeline rates, not raw network or COPY-to-null rates.
- Latest full shadow run copied 2.851 GB in 58.26 seconds and created indexes in
  6.08 seconds.

The dominant value is represented by `payload`. The production index shape is
the primary key plus indexes on `schema`, `user_id`, `(user_id, import_id)`,
`(user_id, source)`, and `(user_id, source, created_at DESC)`.

## Chunking And Parser Implication

Observed aggregate COPY chunks average approximately 5.5 KiB for Margins and
4-31 KiB for PL. The original `BinaryCopyParser` repeatedly concatenates an
incomplete field with each following chunk. Estimated assembly amplification
for a single fragmented field is:

|   Field |   Chunk | Approximate copied bytes | Amplification |
| ------: | ------: | -----------------------: | ------------: |
| 270 KiB | 5.5 KiB |                 6.84 MiB |         25.9x |
| 683 KiB |  31 KiB |                  8.3 MiB |         12.5x |
| 683 KiB | 5.5 KiB |                 42.3 MiB |         63.4x |

## Shadow Caveat

Production shadow sync hardcodes one table-copy worker and does not use the
serving initial-sync bulk transaction and PRAGMAs. Shadow row shape, COPY bytes,
chunks, CPU, memory, and network telemetry are useful. Absolute shadow flush
and index timings are not direct serving-initial-sync measurements.
