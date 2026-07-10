# Zero 1.8 Release Commit Audit

- Release version: `1.8.0`
- Previous tag/ref: `zero/v1.7.0` (`6863de5f0`), equivalent to `origin/maint/zero/v1.7`
- Target ref: `maint/zero/v1.8` (`6c8b5e5a7`)
- Merge base: `20d8df7d7679aaebb6a53e8c40f24731d67b7889`
- Mono repo: `../mono`, origin `git@github.com:rocicorp/mono.git`
- Human review: hidden Litestream v5 work should not be included in public release notes.

## Commands Used

```sh
git -C ../mono log --reverse --oneline --no-merges zero/v1.7.0..maint/zero/v1.8
git -C ../mono merge-base zero/v1.7.0 maint/zero/v1.8
git -C ../mono log --reverse --format='%h%x09%s%n%b%n---END---' 20d8df7d7679aaebb6a53e8c40f24731d67b7889..zero/v1.7.0
git -C ../mono log --right-only --no-merges --cherry-mark --format='%m%x09%h%x09%s' zero/v1.7.0...maint/zero/v1.8
git -C ../mono show zero/v1.7.0:packages/zero-protocol/src/protocol-version.ts
git -C ../mono show maint/zero/v1.8:packages/zero-protocol/src/protocol-version.ts
git -C ../mono log --reverse --no-merges --format='COMMIT %h %H%nAUTHOR %an <%ae>%nSUBJECT %s%nBODY%n%b%nFILES' --name-only zero/v1.7.0..maint/zero/v1.8
```

## Protocol Compatibility

Compatibility passes.

- Previous `zero/v1.7.0`: `PROTOCOL_VERSION = 51`, `MIN_SERVER_SUPPORTED_SYNC_PROTOCOL = 30`
- Target `maint/zero/v1.8`: `PROTOCOL_VERSION = 51`, `MIN_SERVER_SUPPORTED_SYNC_PROTOCOL = 30`
- Check: target minimum supported sync protocol `30` is `<=` previous release protocol `51`.
- No protocol-version bump or compatibility break was found in this range.

## Raw Non-Merge Commit Range

```text
69c83bb59 chore(zero-cache): watermark reader for litestream 5 (#6139)
d1e92234a chore(zero-cache): interface for the backup monitor (#6140)
c8ab96e34 chore(zero-cache): add the ability to change backup monitors (#6143)
fe0330fcd fix(zero-cache): reconnect if no response from PG (#6047)
b3ec0a1e1 perf(zero-cache): batch changeLog inserts into multi-row INSERTs (#6142)
120dbe77e fix(zero-cache): fix logging of catchup wait time (#6149)
a392cbede chore: update @rocicorp/logger to version 6.1.0 (#6150)
3572e51ee chore: Fix API snapshot test (#6151)
2adca291b chore(zero-cache): backupWithv5 flag and supporting infra (#6146)
8bc133411 feat(zero-cache): forward incoming request headers to API (#6144)
ae379e13a fix(zero-server): support drizzle rc prepareQuery (#6154)
a85e0eee4 chore(devcontainer): upgrade agents feature to v3 (#6156)
5ca6e5639 perf(zql): collapse MemorySource fetch generator stack (#6127)
f2aa68d89 feat(release): also publish Docker image to GHCR (#6161)
3deac3a0f refactor(release): split build and Docker Hub publish into separate jobs (#6162)
77913f551 chore: Test canary release (#6163)
8429abd34 chore: extra safety before swapping to litestreamv5 (#6152)
261e68765 bench: add planner hydration predicate indexes (#6164)
287d595bf bench: added pg benchmarks for replication (#6160)
c384e01d4 feat(zero-cache): calculate how far behind a view syncer is on serving clients (#6157)
6cb25e69d chore(zero): Bump version to 1.8 (#6166)
d1e354925 bench: report pg throughput in payload MB (#6167)
cec9cbb46 bench: add flipped join merge benchmark (#6169)
5f0366794 bench: add flipped join batching benchmark (#6168)
a0344b968 bench: add LogContext construction benchmark (#6171)
7c527e265 bench: add `Debug.rowVended` benchmark (#6170)
e8cc6889f fix: Handle stale got on connection (#6172)
deb8f682e ci(zero): harden release workflow (#6173)
0eeabd495 ci(zero): use pinned skopeo container (#6176)
16e6d901c chore: detect malformed sqlite sooner (#6174)
9774d0d4a chore: require all commits to be signed by the team (#6158)
962587a71 ci(zero): make npm promotion manual (#6177)
14c323e33 chore: swap to `.github` centric workflow (#6178)
261c7e643 fix(react native): support op-sqlite v17 (#6180)
818125ac0 fix(zero-cache): don't self-terminate the view-syncer while the initial backup is still uploading (#6134)
a19e608ad fix(zero-cache): gate snapshot reservation on a restorable backup; move give-up deadline to the producer (#6135)
2342db11d chore(zero-cache): log query xformation hashes so we can understand d… (#6181)
2279e783e fix(zqlite): make take start fetches seekable (#6184)
6c8b5e5a7 feat(zero-cache): add initial sync metrics (#6191)
```

## Cherry-Pick / Patch-Equivalence Skips

- `120dbe77e fix(zero-cache): fix logging of catchup wait time (#6149)` is patch-equivalent to `4be047a3d` on the previous-release side.
- `a392cbede chore: update @rocicorp/logger to version 6.1.0 (#6150)` is patch-equivalent to `2698272ca` on the previous-release side.

## Reviewed Categorization

| Commit      | Category | Breaking? | Note                                                                                                                                                                                                                                                                        |
| ----------- | -------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `69c83bb59` | skip     | -         | Litestream v5 watermark-reader infrastructure for staged HA/backup work. Hidden/internal and explicitly excluded from public notes.                                                                                                                                         |
| `d1e92234a` | skip     | -         | Backup monitor interface refactor for the hidden Litestream v5 migration. No standalone user-facing behavior.                                                                                                                                                               |
| `c8ab96e34` | skip     | -         | Backup monitor switching factory for hidden Litestream v5 support. No public release-note item.                                                                                                                                                                             |
| `fe0330fcd` | fix      | -         | Logical replication could stop receiving data without reconnecting when the inbound PG replication stream went silent. User-facing reliability fix for stalled replication.                                                                                                 |
| `b3ec0a1e1` | perf     | -         | Batches CDC `changeLog` inserts into multi-row INSERTs to reduce upstream replication lag for large transactions. Commit message has local benchmark data, but release note should remain qualitative unless release-quality benchmark comparison is run.                   |
| `120dbe77e` | skip     | -         | Already present in the previous release via patch-equivalent cherry-pick.                                                                                                                                                                                                   |
| `a392cbede` | skip     | -         | Already present in the previous release via patch-equivalent cherry-pick.                                                                                                                                                                                                   |
| `3572e51ee` | skip     | -         | API snapshot test configuration fix only.                                                                                                                                                                                                                                   |
| `2adca291b` | skip     | -         | Hidden Litestream v5 backup cleanup flag and supporting infra. Explicitly excluded from public notes.                                                                                                                                                                       |
| `8bc133411` | feature  | -         | Adds `mutate-allowed-request-headers` and `query-allowed-request-headers` so operators can forward selected proxy/load-balancer request headers to custom mutate/query APIs. Public feature; docs need config anchors.                                                      |
| `ae379e13a` | fix      | -         | Zero's Drizzle adapter could call the old `prepareQuery` signature against Drizzle 1.0 RC, causing raw query results to come back in array mode instead of object mode. Credit original external contributor if this appears in final notes.                                |
| `a85e0eee4` | skip     | MAYBE     | Devcontainer feature v3 removes bundled `gh` and `op`. This can affect contributor devcontainer workflows but not Zero runtime/API behavior. Skip public release notes.                                                                                                     |
| `5ca6e5639` | perf     | -         | Collapses a common `MemorySource` fetch path to reduce generator overhead. Commit has local benchmark data, but release note should remain qualitative unless release-quality benchmark comparison is run.                                                                  |
| `f2aa68d89` | feature  | -         | Publishes Zero Docker images to GHCR in addition to Docker Hub. Public operator feature; docs should mention the GHCR image.                                                                                                                                                |
| `3deac3a0f` | skip     | MAYBE     | Release workflow build/publish split. Could affect branch protection status-check names but only for maintainers. Skip public release notes.                                                                                                                                |
| `77913f551` | skip     | -         | Canary release test README change.                                                                                                                                                                                                                                          |
| `8429abd34` | skip     | -         | Extra safety before using hidden Litestream v5 monitor. Excluded with hidden Litestream v5 work.                                                                                                                                                                            |
| `261e68765` | skip     | -         | Benchmark fixture/index correction only. Useful for benchmark history, not a user-facing runtime change.                                                                                                                                                                    |
| `287d595bf` | skip     | -         | Adds PG benchmark suite only. Not a release-note item by itself.                                                                                                                                                                                                            |
| `c384e01d4` | feature  | -         | Adds serving-lag metrics for active ViewSyncers so operators can see replica data that is ready locally but not yet fully served to clients. Public observability feature; docs need OTel metric entries.                                                                   |
| `6cb25e69d` | skip     | -         | Version bump.                                                                                                                                                                                                                                                               |
| `d1e354925` | skip     | -         | Benchmark reporting unit change only.                                                                                                                                                                                                                                       |
| `cec9cbb46` | skip     | -         | Adds benchmark coverage for prior flipped-join merge performance work. Not a runtime change in this release range.                                                                                                                                                          |
| `5f0366794` | skip     | -         | Adds benchmark coverage for prior flipped-join batching performance work. Not a runtime change in this release range.                                                                                                                                                       |
| `a0344b968` | skip     | -         | Adds logger construction benchmark only.                                                                                                                                                                                                                                    |
| `7c527e265` | skip     | -         | Adds `Debug.rowVended` benchmark only.                                                                                                                                                                                                                                      |
| `e8cc6889f` | fix      | -         | Reconnected clients could trust stale persisted `got` state and report a query as `complete` with stale/empty results before server confirmation.                                                                                                                           |
| `deb8f682e` | skip     | MAYBE     | Zero release workflow hardening. Same PR appears on previous side but is not patch-equivalent due branch differences. Release-process only, not public runtime behavior.                                                                                                    |
| `0eeabd495` | skip     | -         | Release CI pins the Skopeo container.                                                                                                                                                                                                                                       |
| `16e6d901c` | fix      | -         | Malformed SQLite replicas are detected earlier with `PRAGMA quick_check` and routed through existing restore/autoreset recovery paths. This is operationally user-facing and not breaking because the previous behavior was accepting corrupt replicas until later failure. |
| `9774d0d4a` | skip     | MAYBE     | Signed-commit policy for team workflow only. Skip public release notes.                                                                                                                                                                                                     |
| `962587a71` | skip     | MAYBE     | Manual npm promotion release-process change only. Skip public release notes.                                                                                                                                                                                                |
| `14c323e33` | skip     | -         | Moves signed-commit workflow to `.github`-centric setup. Skip public release notes.                                                                                                                                                                                         |
| `261c7e643` | fix      | -         | `op-sqlite` v17 changed `executeRaw`/`executeRawSync` result shape, which could crash React Native reads with `iterator method is not callable`.                                                                                                                            |
| `818125ac0` | fix      | -         | View-syncers could exit with `max attempts exceeded restoring replica` while the first Litestream backup was still uploading.                                                                                                                                               |
| `a19e608ad` | fix      | -         | Cold-start view-syncers could be told to restore before a restorable backup existed, causing wasted restore attempts and startup churn.                                                                                                                                     |
| `2342db11d` | skip     | -         | Query transformation hash logging for internal de-dupe investigation. Operationally useful, but not a public feature unless product wants to expose it.                                                                                                                     |
| `2279e783e` | perf     | -         | Ordered `take` maintenance fetches can become seekable for non-nullable leading sort columns, reducing planner-hostile scans around large ordered partitions. Commit is performance/correctness-adjacent; avoid quantified claims without benchmark comparison.             |
| `6c8b5e5a7` | feature  | -         | Adds initial-sync metrics and logs for COPY, SQLite flush, index creation, rows, bytes, chunks, and run outcomes. Public observability feature; docs need OTel metric entries.                                                                                              |

## Potential Breaking Changes

- No release-blocking breaking changes found.
- `a85e0eee4`, `3deac3a0f`, `deb8f682e`, `9774d0d4a`, and `962587a71` can affect internal contributor or release workflows, but they do not change public Zero runtime behavior.
- `16e6d901c` changes recovery timing for corrupt SQLite replicas. This is treated as a fix, not a breaking change, because the new behavior routes detected corruption through existing restore/autoreset recovery paths instead of allowing later undefined failures.

## Performance Follow-Ups

- `b3ec0a1e1` (`#6142`) has release-quality targeted post-matrix benchmark coverage saved under `.releases/1.8/benchmarks/`.
- `5ca6e5639` (`#6127`) has release-quality original-suite benchmark coverage saved under `.releases/1.8/benchmarks/`.
- `2279e783e` (`#6184`) has release-quality targeted post-matrix benchmark coverage saved under `.releases/1.8/benchmarks/`.
- Benchmark-only commits `261e68765`, `287d595bf`, `d1e354925`, `cec9cbb46`, `5f0366794`, `a0344b968`, and `7c527e265` should not produce public performance claims for this release by themselves.

Benchmark results:

- Raw outputs: `.releases/1.8/benchmarks/raw/**`.
- Methodology: `.releases/1.8/benchmarks/README.md`.
- Aggregation script: `.releases/1.8/benchmarks/aggregate-benchmarks.mjs`.
- Aggregate JSON: `.releases/1.8/benchmarks/aggregate.json`.
- Aggregate Markdown: `.releases/1.8/benchmarks/aggregate.md`.
- Run count: 10 separate processes per ref per benchmark command.
- Aggregation method: median of process-level medians.
- Baseline: `zero/v1.7.0` (`6863de5f00a3c1e7dc09c83ea3263dec4a94ebee`).
- Target: `maint/zero/v1.8` (`6c8b5e5a76f2b4b253b1b9c9c4a8598299d8c975`).

## Draft Inclusion Checklist

Features to include:

- Request-header forwarding to custom mutate/query APIs (`#6144`), with docs anchors for `mutate-allowed-request-headers` and `query-allowed-request-headers`.
- Zero Docker image published to GHCR (`#6161`), with a self-hosting docs anchor.
- Serving-lag metrics (`#6157`), with OTel metrics reference entries.
- Initial-sync metrics and logs (`#6191`), with OTel metrics reference entries.

Fixes to include:

- Replication reconnects when the inbound PG logical-replication stream goes silent (`#6047`).
- Drizzle 1.0 RC `prepareQuery` compatibility (`#6154`).
- Stale persisted `got` state could make queries appear complete with stale/empty results after reconnect (`#6172`).
- Malformed SQLite replicas are detected earlier and recovered through restore/autoreset paths (`#6174`).
- React Native `op-sqlite` v17 raw result shape compatibility (`#6180`).
- View-syncers no longer self-terminate while the first backup is still uploading (`#6134`).
- Snapshot reservations wait for a restorable backup before telling view-syncers to restore (`#6135`).

Benchmark-backed performance items to include:

- Batched CDC `changeLog` inserts for large upstream transactions (`#6142`).
- Faster common in-memory ZQL `MemorySource` fetches (`#6127`).
- Seekable ordered `take` maintenance fetches (`#6184`).

Items explicitly excluded:

- Hidden Litestream v5 implementation/flag/safety commits: `69c83bb59`, `d1e92234a`, `c8ab96e34`, `2adca291b`, `8429abd34`.
- Release/CI/devcontainer/benchmark-only/internal logging commits unless a human later asks to include them.

## Open Questions

- None.

## Draft State

- Drafted release note: `contents/docs/release-notes/1.8.mdx`.
- Updated release-note index: `contents/docs/release-notes/index.mdx`.
- Updated public docs anchors:
  - `contents/docs/zero-cache-config.mdx`: `#mutate-allowed-request-headers`, `#query-allowed-request-headers`.
  - `contents/docs/self-host.mdx`: `#docker-images`.
  - `contents/docs/otel.mdx`: initial-sync metrics under `#zeroreplication`, serving-lag metrics under `#zerosync`.
- Updated generated search index: `assets/search-index.json`.
- External contributor thanks checked from PR metadata and included for `@tjenkinson`, `@typedrat`, and `@tantaman`.
- TODO docs links left in the draft: none.
- Performance section uses release-quality benchmark comparisons from `.releases/1.8/benchmarks/`.
- Validation run:
  - `node .releases/1.8/benchmarks/aggregate-benchmarks.mjs`
  - `pnpm exec prettier --check .releases/1.8/commits.md assets/search-index.json contents/docs/release-notes/1.8.mdx contents/docs/release-notes/index.mdx contents/docs/zero-cache-config.mdx contents/docs/otel.mdx contents/docs/self-host.mdx`
  - `pnpm run build:search`
  - `pnpm run check-types`
  - `git diff --check`
