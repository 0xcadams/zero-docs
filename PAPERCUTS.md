## 2026-07-13

- Switching drizzle-zero from a pnpm 11 branch to its pnpm 10 beta branch made `pnpm install` abort while replacing `node_modules` without a TTY; `CI=true pnpm install --no-frozen-lockfile` was required.
- Running `pnpm exec` in the detached Zero benchmark worktree tried to purge its existing `node_modules` and aborted without a TTY. Use the already-installed `node_modules/.bin` tools for read-only validation instead.
- The initial-sync copy-pipeline harness lives in `zero-docs` but its formatter and typechecker run from a mono worktree; chaining relative `scripts/...` commands from the mono working directory repeatedly targeted nonexistent paths. Run harness scripts with the benchmark directory as `workdir` or use absolute paths.
- `zero-cache` has versioned PostgreSQL Vitest projects (`vitest.config.pg-15.ts`, etc.), not a generic `vitest.config.pg.ts`; use the package's `test:pg15` script for focused initial-sync tests.
- Rebuilding the published `@rocicorp/zero-sqlite3` package from source requires regenerating its omitted `src/util/unicode_case_data.h`; its default node-gyp build also compiles the optional SQLite shell and therefore needs readline/ncurses development headers on Debian slim.

## 2026-07-14

- Fetching `mono` over SSH failed when the 1Password SSH agent stopped responding. Verify the remote ref with the public HTTPS URL rather than changing signing or SSH configuration.
- The COPY-pipeline Docker runner accepts an unsuffixed stage name but writes raw output under `<stage>-docker`; passing the original name to `aggregate.mjs` fails with `ENOENT`. Surface the generated aggregate stage name in runner output or normalize it in the aggregator.
