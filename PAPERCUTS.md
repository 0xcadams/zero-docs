## 2026-07-13

- Switching drizzle-zero from a pnpm 11 branch to its pnpm 10 beta branch made `pnpm install` abort while replacing `node_modules` without a TTY; `CI=true pnpm install --no-frozen-lockfile` was required.
- Running `pnpm exec` in the detached Zero benchmark worktree tried to purge its existing `node_modules` and aborted without a TTY. Use the already-installed `node_modules/.bin` tools for read-only validation instead.
