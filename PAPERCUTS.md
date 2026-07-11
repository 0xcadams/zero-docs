## 2026-07-10

- The production build timed out generating `/docs/solidjs` after 60 seconds and succeeded on its automatic retry. Static generation for that page may be intermittently slow.
- The two `drizzle-zero` integration suites both bind fixed host port `5732`, so running them concurrently causes a port collision and setup timeout. Run the configured and no-config suites serially.
- The `zero-virtual` E2E command does not install its pinned Playwright browser, so a clean checkout fails every test at browser launch until `pnpm --filter demo-react exec playwright install chromium` is run.
