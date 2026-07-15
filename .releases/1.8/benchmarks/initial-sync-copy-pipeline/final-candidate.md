# Initial Sync COPY Final Candidate

## Scope

This compares `final-native-candidate-core-docker` with the pinned
`origin-main-baseline-docker` at `d87c1c813b2e57abdf814eadda98b8d5e5885979`.
Both use `mmap_size=0`, production-shaped CPU, memory, heap, and payload
constraints, and synthetic COPY fragmentation constraints. The comparison is a
bundled, cross-image candidate comparison; same-image component experiments are
noted separately.

The candidate combines the linear fragmented-field parser, batched COPY
metrics, direct native transient UTF-8 Buffer binding, and adaptive eager
secondary indexes. Partial batches, field-buffer reuse, static bindings, and
detailed benchmark-only phase instrumentation are off.

## Results

| Median                | Email, candidate | Email, origin | Change | imports, candidate | imports, origin | Change |
| --------------------- | ---------------: | ------------: | -----: | -----------------: | --------------: | -----: |
| Initial-sync callback |          7.673 s |      23.981 s | -68.0% |            4.832 s |         7.757 s | -37.7% |
| Dominant table COPY   |          7.062 s |      11.965 s | -41.0% |            4.459 s |         5.961 s | -25.2% |
| SQLite flush          |          4.820 s |       4.754 s |  +1.4% |            1.492 s |         1.803 s | -17.2% |
| Deferred index phase  |          0.096 s |      12.008 s | -99.2% |            0.011 s |         1.639 s | -99.4% |
| Peak Node RSS         |        215.3 MiB |     414.0 MiB | -48.0% |          205.5 MiB |       355.2 MiB | -42.2% |

Every candidate callback run was faster than every origin callback run. The
candidate copied exactly 6,834,522,537 Email bytes and 2,750,877,916 imports
bytes in every run.

## Raw Controls

Each measured run first performs a same-image raw `COPY ... TO STDOUT` control.
The median paired raw/callback ratios improved from 20.1% to 74.0% for Email
and from 52.4% to 82.7% for imports. Against the dominant table COPY rather
than the whole callback, candidate ratios were 80.4% and 89.6% respectively.

The cross-image Email raw control was 23.8% slower for the candidate, while
imports differed by 0.27%. Raw Email COPY was itself highly variable, so these
ratios describe observed wall time rather than CPU efficiency.

## Correctness

All six candidate runs exited successfully and retained 10,000 rows. Three
sampled payloads per run had the expected byte length and SHA-256:

- Email: 683,000 bytes,
  `fd5b0b65dcb6b2a54f610ca274905198d96dcbbc1c1ad59bbb18e42f8cf43afd`
- imports: 275,000 bytes,
  `67a34865811c799e84a608593dd6270bfd659fdec0746aa58ff3b4245c0888fd`

The parser corpus also retained field counts, payload-byte counts, and
checksums across baseline and linear implementations. This is sampled payload
evidence, not a whole-database hash; the origin stage predates payload samples.

## Variability

Email candidate callbacks were 6.164 s, 7.673 s, and 15.696 s. The slow run
spent 1.692 s in 1,158 garbage collections, compared with 0.209 s and 772
collections in a fast run. With three repetitions, the reported p95 is not a
credible tail estimate. imports was stable at 4.726-5.153 s.

The final field-buffer-pool A/B does not justify keeping the pool. Its
unpaired medians suggest a 5.1% callback gain, but repetition-paired callback
time is 0.94% slower. It reduces GC count by 37.9% while increasing scoped I/O
pressure by 115% and memory-limit events by 17.6%, without improving p95 or
maximum time. Field-buffer reuse was removed from the runtime candidate.

## Worker Decision

Do not add producer/parser workers yet. The current benchmark does not isolate
a material serial parser gap in the final image, PostgreSQL already acts as an
independent producer, and the one-CPU Email workload cannot gain compute
capacity from another worker. The imports dominant-table path is already at
89.6% of its paired raw control.

Production table-completion logs now report `sourceWaitMs` and `processingMs`
for binary and text COPY without per-chunk logging. `processingMs` includes
parsing, decoding, bookkeeping, SQLite statements, and final flushes;
`sourceWaitMs` is residual stream wall time outside destination callbacks and
can include event-loop contention from concurrent table copies. Consider a
bounded producer/parser-worker experiment only if production observations
show a repeatable processing component outside SQLite work on a workload with
spare CPU.

### Telemetry Validation

`final-native-telemetry-smoke-docker` reran three production-volume repetitions
after making the phase timing unconditional. Median callback/raw control times
were 8.279/5.907 s for Email and 5.168/4.151 s for imports. These are 7.9% and
7.0% slower than the frozen candidate callbacks, but the separate image also
showed higher SQLite flush time, especially for imports, so this is not a
controlled instrumentation-overhead measurement.

The median dominant-table split was:

| Workload | Source wait | Destination processing | SQLite flush | Non-flush processing |
| -------- | ----------: | ---------------------: | -----------: | -------------------: |
| Email    |     2.229 s |                5.507 s |      5.077 s |              0.430 s |
| imports  |     2.567 s |                2.318 s |      2.103 s |              0.215 s |

The recoverable parser/decoder/bookkeeping portion is therefore small in both
profiles. Email has one CPU, while imports has only about 215 ms of median
non-flush destination work. The fresh telemetry strengthens the decision not
to add workers.

## Release Boundary

Native transient binding is safe against Buffer lifetime changes because it
uses `SQLITE_TRANSIENT`; the rejected `SQLITE_STATIC` API was removed. The
native method currently exists in a workspace patch, so production enablement
still requires a published `@rocicorp/zero-sqlite3` version and matching
platform prebuilds. Until then, this remains a benchmark candidate rather than
a deployable package change.

## Sources

- `results/final-native-candidate-core-docker.json`
- `results/final-native-candidate-core-docker-summary.json`
- `results/origin-main-baseline-docker.json`
- `results/origin-main-baseline-docker-summary.json`
- `results/native-binding-production-factorial-docker-summary.json`
- `results/native-text-imports-production-docker-summary.json`
- `results/final-field-pool-core-docker-summary.json`
- `results/final-native-telemetry-smoke-docker.json`
- `results/final-native-telemetry-smoke-docker-summary.json`
- `manifests/final-native-candidate-core-docker.json`
- `manifests/final-native-telemetry-smoke-docker.json`
