# Zero 1.8 Smoke Test

## Release Metadata

| Field                  | Value                                      |
| ---------------------- | ------------------------------------------ |
| Previous stable        | `1.7.0`                                    |
| Target canary          | `1.8.0-canary.7`                           |
| Intended final         | `1.8.0`                                    |
| Mono target            | `cdc02598f137ab4e071878f5674fdc716dbbc69d` |
| Release notes          | `contents/docs/release-notes/1.8.mdx`      |
| Workspace parent       | `/Users/chase/git/roci`                    |
| Native manual platform | iOS                                        |

## Artifact Preflight

| Artifact                         | Status         | Evidence                                                                                                         |
| -------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------- |
| `@rocicorp/zero@1.8.0-canary.7`  | Pass           | npm integrity `sha512-2oEHaCHtr4xww+nokP8GeaXia6kDkJCypCH6JodLCNCQmQ/IYJ+QGo9Nb5asuw+6Xk0mT6cWXt9+1WtXqPI7gg==`. |
| `@rocicorp/zero-virtual@0.6.0-0` | Pass with risk | Published package resolves; peer `@rocicorp/zero: ^1.7.0` does not explicitly include the target prerelease.     |
| `drizzle-zero@0.19.0`            | Pass           | Published package resolves; its Zero peer is unconstrained.                                                      |
| `prisma-zero@0.2.0`              | Pass           | Published package metadata resolves from npm.                                                                    |
| Docker Hub canary image          | Pass           | Multi-architecture digest `sha256:b0202b6abf68e321f8bc96e2666c33067698e71497bead637a2cd63990e90388`.             |
| GHCR canary image                | Pass           | Same multi-architecture digest as Docker Hub.                                                                    |

## Scope

### Included

| Repository         | Classification                               | Base        | Previous Zero | Target           | Branch         | PR      |
| ------------------ | -------------------------------------------- | ----------- | ------------- | ---------------- | -------------- | ------- |
| `zero-virtual`     | Companion package with React and Solid demos | `main`      | `1.7.0`       | `1.8.0-canary.7` | `0xcadams/1.8` | Pending |
| `drizzle-zero`     | Companion package and integration fixtures   | `main`      | `1.7.0`       | `1.8.0-canary.7` | `0xcadams/1.8` | Pending |
| `prisma-zero`      | Companion package and integration fixtures   | `main`      | `1.7.0`       | `1.8.0-canary.7` | `0xcadams/1.8` | Pending |
| `zero-music`       | Onboarding example                           | `1-install` | `1.7.0`       | `1.8.0-canary.7` | Deferred       | Pending |
| `zero-music`       | Deployable onboarding example                | `2-deploy`  | `1.7.0`       | `1.8.0-canary.7` | Deferred       | Pending |
| `hello-zero`       | React quickstart                             | `main`      | `1.7.0`       | `1.8.0-canary.7` | `0xcadams/1.8` | Pending |
| `hello-zero-solid` | Solid quickstart                             | `main`      | `1.7.0`       | `1.8.0-canary.7` | `0xcadams/1.8` | Pending |
| `hello-zero-cf`    | Cloudflare demo                              | `main`      | `1.7.0`       | `1.8.0-canary.7` | `0xcadams/1.8` | Pending |
| `zmail`            | Rich TanStack and Drizzle demo               | `main`      | `1.7.0`       | `1.8.0-canary.7` | `0xcadams/1.8` | Pending |
| `ztunes`           | Rich TanStack and Drizzle demo               | `main`      | `1.6.0`       | `1.8.0-canary.7` | `0xcadams/1.8` | Pending |
| `zslack`           | Expo and React Native demo                   | `main`      | `1.7.0`       | `1.8.0-canary.7` | `0xcadams/1.8` | Pending |

### Excluded

| Repository                        | Reason                                                                                             |
| --------------------------------- | -------------------------------------------------------------------------------------------------- |
| `hello-zero-do`                   | Maintained-scope decision excludes legacy examples; current Zero is pre-1.0.                       |
| `zero-vue`                        | Maintained-scope decision excludes legacy examples; current Zero is pre-1.0.                       |
| `zchat`                           | Maintained-scope decision excludes legacy examples; current Zero is pre-1.0.                       |
| `syncban`                         | Maintained-scope decision excludes legacy examples; current Zero is pre-1.0.                       |
| `zotion`                          | Archived fork with a local Zero tarball dependency.                                                |
| `synctunes`                       | Does not consume Zero.                                                                             |
| `productlane`                     | Production SaaS product, not a sample app.                                                         |
| `mono/apps/zbugs` package upgrade | Links workspace source rather than the published canary; retained only for internal stack rollout. |
| CloudZero repositories as samples | Infrastructure and internal test fixtures, not public examples.                                    |

## Automated Results

| Repository and ref      | Install                                 | Generate                                                 | Format/Lint                                                                            | Types              | Unit/Integration                                                              | Build                            | Runtime  | Notes                                                                                                                              |
| ----------------------- | --------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------ | ----------------------------------------------------------------------------- | -------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `zero-virtual/main`     | Pass                                    | N/A                                                      | Pass                                                                                   | Pass               | Pass: 51 unit tests and 36 browser E2E tests                                  | Pass                             | Pass     | Peer check passes after widening the package's Zero peer and raising its React test matrix to `^19.2.6`.                           |
| `drizzle-zero/main`     | Pass                                    | Pass                                                     | Pass                                                                                   | Pass               | Pass: 667 unit/type tests plus 9 configured and 9 no-config integration tests | Pass                             | N/A      | `tsconfck` reports its pre-existing TypeScript 6 peer warning. Integration suites must run serially because both bind port `5732`. |
| `prisma-zero/main`      | Pass                                    | Pass                                                     | Pass                                                                                   | Pass               | Pass: 260 unit/type tests and Prisma generation integration build             | Pass                             | N/A      | `tsconfck` reports its pre-existing TypeScript 6 peer warning.                                                                     |
| `zero-music/1-install`  | Deferred                                | Deferred                                                 | Deferred                                                                               | Deferred           | N/A                                                                           | Deferred                         | Deferred | Deferred by release manager because its staged branch model needs separate handling.                                               |
| `zero-music/2-deploy`   | Deferred                                | Deferred                                                 | Deferred                                                                               | Deferred           | N/A                                                                           | Deferred                         | Deferred | Deferred by release manager because its staged branch model needs separate handling.                                               |
| `hello-zero/main`       | Pass                                    | N/A                                                      | Pass                                                                                   | Pass through build | N/A                                                                           | Pass                             | Pending  | React 18 peer mismatch is unchanged from Zero 1.7.                                                                                 |
| `hello-zero-solid/main` | Pass                                    | N/A                                                      | Blocked: existing ESLint config imports undeclared `eslint-plugin-react-hooks`         | Pass through build | N/A                                                                           | Pass                             | Pending  | Zero peer check passes.                                                                                                            |
| `hello-zero-cf/main`    | Pass                                    | N/A                                                      | Pass with 3 warnings                                                                   | Pass through check | N/A                                                                           | Pass, including Wrangler dry run | Pending  | React 19.0 peer mismatch is unchanged from Zero 1.7.                                                                               |
| `zmail/main`            | Pass                                    | Pass, unchanged                                          | Targeted changed files pass; repository check is blocked by an unrelated existing file | Pass               | N/A                                                                           | Pass                             | Pending  | Migrated from zero-virtual's removed `.virtualizer` API to flow-rendered `items` and padding.                                      |
| `ztunes/main`           | Pass                                    | Pass, generated schema updated for `drizzle-zero@0.19.0` | Targeted changed files pass; repository check has existing warnings                    | Baseline-blocked   | N/A                                                                           | Pass                             | Pending  | Three TanStack/Vite errors reproduce unchanged in a clean `origin/main` worktree. Existing Vite peer warning remains.              |
| `zslack/main`           | Pass with scoped release-age exclusions | Blocked on patched `drizzle-zero`                        | Pass                                                                                   | Pass               | N/A                                                                           | Pass: iOS Metro export           | Pending  | Bun resolves op-sqlite 17.1.2. CocoaPods is unavailable, so `ios/Podfile.lock` still records op-sqlite 15.1.6.                     |

## Feature Coverage

| Release area                               | Test surface                                        | Automated status                                  | Manual status | Notes                                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------- | ------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Allowed request-header forwarding          | `ztunes` cookie-authenticated queries and mutations | Pass: config and build                            | Pending       | Replaced broad cookie-forwarding flags with allowed `cookie` headers; runtime auth remains to test.                                                 |
| GHCR images                                | `zslack` full Docker Compose stack                  | Pass: image exists and Compose pins the exact tag | Pending       | GHCR and Docker Hub expose identical multi-architecture digests.                                                                                    |
| `MutatorResult` export                     | Disposable compile check in `zmail`                 | Pass                                              | N/A           | A temporary TypeScript file imported `MutatorResult` from `@rocicorp/zero` and accessed `.client` and `.server`; no contrived sample code retained. |
| Operational metrics                        | Internal zbugs and CloudZero stack                  | Pending                                           | Pending       | Requires privileged rollout.                                                                                                                        |
| Stability and flow-control metrics         | Internal zbugs and CloudZero stack                  | Pending                                           | Pending       | Requires privileged rollout and a load event.                                                                                                       |
| Ordered `limit()` maintenance              | `zero-virtual` deep paging and boundary navigation  | Pass: browser E2E                                 | Pending       | E2E covers page-boundary and final-row navigation, sorting, scroll restoration, and continuous scroll.                                              |
| Bulk-write replication persistence         | `zero-virtual` or internal zbugs                    | Pending                                           | Pending       | Apply a large upstream transaction and observe catch-up.                                                                                            |
| Local query execution                      | `zmail` inbox load and relationship queries         | Pending                                           | Pending       | Compare behavior and responsiveness, not release-note benchmark numbers.                                                                            |
| Silent logical replication reconnect       | `zmail` or internal zbugs                           | Pending                                           | Pending       | Pause or interrupt upstream replication without terminating the app if feasible.                                                                    |
| No writes after Postgres disconnect        | Rich sample custom mutation                         | Pending                                           | Pending       | Interrupt Postgres around a mutation and inspect recovery.                                                                                          |
| Drizzle 1.0 RC array-mode adapter          | `drizzle-zero` and `zmail` Drizzle adapter          | Pass: package suites and app compile/build        | Pending       | The current fixtures use Drizzle 0.45; explicit 1.0 RC runtime coverage remains.                                                                    |
| `start` query compilation and null cursors | `zero-virtual` deep navigation and companion tests  | Pass: browser E2E                                 | Pending       | Boundary, final-row, reload, and history-navigation tests pass.                                                                                     |
| Reconnect completeness                     | `zmail` and `ztunes`                                | Pending                                           | Pending       | Restart Zero and verify views do not remain stale or empty.                                                                                         |
| React Native reads with op-sqlite v17      | `zslack` on iOS                                     | Pass: typecheck and iOS bundle                    | Pending       | Bun resolves 17.1.2; CocoaPods lock regeneration and runtime persistence test remain.                                                               |
| Initial backup startup behavior            | Internal stack                                      | Pending                                           | Pending       | Requires deployment environment.                                                                                                                    |
| Default sync-worker count                  | Exact Docker canary                                 | Pending                                           | Pending       | Inspect startup logs and runtime configuration.                                                                                                     |
| Change-stream flow control                 | Internal stack bulk transaction                     | Pending                                           | Pending       | Watch memory and flow-control metrics.                                                                                                              |

## Manual Sessions

| Session                                                | Owner | Status   | Result or evidence                      |
| ------------------------------------------------------ | ----- | -------- | --------------------------------------- |
| `zero-music` clean onboarding                          | Chase | Deferred | Staged branches will be handled later.  |
| `zero-virtual` React and Solid deep-list behavior      | Chase | Pending  |                                         |
| React, Solid, and Cloudflare quickstarts               | Chase | Pending  |                                         |
| `zmail` rich browser and reconnect behavior            | Chase | Pending  |                                         |
| `ztunes` auth, query, mutation, and reconnect behavior | Chase | Pending  |                                         |
| `zslack` iOS native persistence and reconnect behavior | Chase | Pending  |                                         |
| Internal zbugs and CloudZero rollout or rollback       | Chase | Pending  | Requires explicit operational approval. |

### Test Card: zero-virtual

Branch: `zero-virtual/0xcadams/1.8`

Setup from `../zero-virtual`:

```sh
docker compose --env-file demo/shared/.env -f demo/shared/docker/docker-compose.yml up -d
pnpm --filter demo-shared seed
pnpm --filter demo-shared dev:zero-cache
pnpm --filter demo-react dev:ui
```

Actions and expected results:

1. Open `http://localhost:5173`; the list should render and become settled after two seconds without visual jumps.
2. Scroll slowly for at least five seconds, stop, and confirm it settles approximately two seconds later.
3. Scroll to the final rows, switch sort field and direction, and confirm rows remain responsive and correctly ordered.
4. Open a row near the end, reload, and confirm that row remains selected and positioned without loading every earlier page.
5. Navigate away and back, then reload mid-list; scroll position should restore without a blank viewport.
6. Repeat the basic scroll, sort, and reload checks with `pnpm --filter demo-solid dev:ui` after stopping the React UI.

Failure evidence: browser console, zero-cache output, URL, visible row before and after the action, and whether the failure affects React, Solid, or both.

Response: `zero-virtual: pass`, `zero-virtual: fail - <observation>`, or `zero-virtual: blocked - <reason>`.

### Test Card: Quickstarts

Branches: `hello-zero/0xcadams/1.8`, `hello-zero-solid/0xcadams/1.8`, and `hello-zero-cf/0xcadams/1.8`.

For each repository, start Postgres, zero-cache, and the UI using its `dev:db-up`, `dev:zero-cache`, and `dev:ui` scripts.

Actions and expected results:

1. Load the initial view and confirm synced data appears.
2. Create or edit a row and confirm the optimistic result persists after server acknowledgment and reload.
3. Open a second tab and confirm the mutation appears there.
4. Stop zero-cache, make or observe an upstream change, restart zero-cache, and confirm the view recovers without remaining stale or empty.
5. For `hello-zero-cf`, initialize `/api/do/init`; Durable Object output should update after UI mutations.

Failure evidence: repository, browser console, zero-cache output, UI/API output, and action that stopped updating.

Response: `quickstarts: pass`, `quickstarts: fail - <repository and observation>`, or `quickstarts: blocked - <reason>`.

### Test Card: zmail

Branch: `zmail/0xcadams/1.8`

Setup from `../zmail`:

```sh
docker compose up -d
pnpm db:migrate
pnpm seed
pnpm dev:zero
pnpm dev
```

Actions and expected results:

1. Open `http://localhost:3077`; load and deeply scroll each inbox category without blank gaps or jumps.
2. Use arrow keys near loaded-page boundaries; selection should remain visible after the zero-virtual migration.
3. Star and unstar messages, open messages, and confirm read state persists after reload.
4. Reload while deep in the inbox; position should restore near the same message.
5. Stop zero-cache, change upstream data if practical, restart it, and confirm the inbox catches up rather than remaining stale or empty.

Failure evidence: selected email and index, category, scroll position, browser console, and zero-cache output.

Response: `zmail: pass`, `zmail: fail - <observation>`, or `zmail: blocked - <reason>`.

### Test Card: ztunes

Branch: `ztunes/0xcadams/1.8`

Prepare `.env` from `.env.sample`, fill its required values, and run `pnpm dev`.

Actions and expected results:

1. Sign in and load authenticated cart data; query and mutate endpoints must receive the allowed `cookie` header.
2. Search for common and obscure artists, scroll deeply, and switch queries without blank gaps or incorrect ordering.
3. Add and remove albums from the cart; optimistic state should persist after server acknowledgment and reload.
4. Stop and restart zero-cache, then confirm search and cart views recover without remaining stale or empty.
5. Inspect API requests or server logs and confirm cookie authentication succeeds with `ZERO_QUERY_ALLOWED_REQUEST_HEADERS` and `ZERO_MUTATE_ALLOWED_REQUEST_HEADERS`.

Failure evidence: API status, request path, auth result, browser console, and zero-cache output. Do not include cookie values.

Response: `ztunes: pass`, `ztunes: fail - <observation>`, or `ztunes: blocked - <reason>`.

### Test Card: zslack iOS

Branch: `zslack/0xcadams/1.8`.

Prerequisites before testing: publish and consume the patched `drizzle-zero`, regenerate `shared/src/zero-schema.gen.ts`, install CocoaPods, and regenerate `ios/Podfile.lock` so it records op-sqlite 17.

Start Postgres, zero-cache, the API, and iOS using the repository's `dev:db-up`, `dev:zero-cache`, `dev:api`, and `ios` scripts.

Actions and expected results:

1. Sign in, open several channels, and load older and newer messages.
2. Send messages and confirm they remain after server acknowledgment.
3. Disable networking, navigate among already loaded channels, and confirm local reads continue.
4. Re-enable networking and confirm missed changes arrive without duplicate messages.
5. Force quit and relaunch; persisted channels and messages should read successfully from op-sqlite v17.
6. Run the exact GHCR Compose stack and confirm zero-cache starts from `ghcr.io/rocicorp/zero`.

Failure evidence: simulator/device and iOS version, native logs, channel/message action, network state, and zero-cache/API output.

Response: `zslack iOS: pass`, `zslack iOS: fail - <observation>`, or `zslack iOS: blocked - <reason>`.

## Internal Rollout And Rollback

| Step                                                         | Status  | Evidence |
| ------------------------------------------------------------ | ------- | -------- |
| Capture current internal version and health baseline         | Pending |          |
| Upgrade Rocicorp stack to canary                             | Pending |          |
| Validate queries, mutations, reconnect, startup, and metrics | Pending |          |
| Roll back to previous version                                | Pending |          |
| Validate recovery after rollback                             | Pending |          |
| Upgrade to canary again                                      | Pending |          |
| Validate reduced health suite                                | Pending |          |

## Release Blockers And Documentation Gaps

| Status  | Kind                | Description                                                                                                                                                                 | Reproduction or follow-up                                                                                                                                                                                                     |
| ------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Open    | Sample maintenance  | `hello-zero-solid` cannot run its existing lint script because `eslint.config.js` imports undeclared `eslint-plugin-react-hooks`.                                           | Reproduces after a clean `pnpm install`; unrelated to the Zero canary.                                                                                                                                                        |
| Open    | Sample maintenance  | `ztunes` has three existing TanStack Start and Vite type errors, plus an existing Vite peer warning.                                                                        | Reproduced with `pnpm install --frozen-lockfile` and `pnpm exec tsc --noEmit` in a clean `origin/main` worktree.                                                                                                              |
| Blocker | Companion packaging | Published `drizzle-zero@0.19.0` imports `tsx/esm/api` at runtime but declares `tsx` only as a dev dependency, so consumers without their own `tsx` cannot generate schemas. | `zslack`: `bun --filter="@zslack/shared" run generate`. Fixed on `drizzle-zero` branch `0xcadams/1.8`; packed CLI smoke passes without a consumer-owned `tsx`. Publish a patched adapter before completing zslack generation. |
| Blocked | Native tooling      | `zslack/ios/Podfile.lock` remains on op-sqlite 15.1.6 because CocoaPods is unavailable in the automation environment.                                                       | Install CocoaPods, run pod installation from `zslack/ios`, and commit the regenerated lock before the iOS manual test.                                                                                                        |
| Observe | Startup logs        | `zero-virtual` E2E startup logged `error restoring backup. resyncing the replica: Error: Missing --litestream-executable`, then completed startup and all tests.            | Determine whether this is expected for `zero-cache-dev`; watch internal canary startup and backup metrics.                                                                                                                    |

## Canary History

| Canary           | Reason                    | Result      |
| ---------------- | ------------------------- | ----------- |
| `1.8.0-canary.7` | Initial smoke-test target | In progress |

## Final-Version Replacement

Canary pins must be replaced with exact `1.8.0` after the final package and images exist. Lockfiles, generated artifacts, automated checks, and the reduced manual suite must be refreshed before sample PRs merge.
