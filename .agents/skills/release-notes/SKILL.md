---
name: release-notes
description: Draft Zero release notes from rocicorp/mono commits, using the zero-docs release-notes format with over-inclusive feature/fix capture, protocol compatibility checks, and breaking-change detection.
---

# Zero Release Notes Skill

Use this skill to draft new Zero release notes in `zero-docs` from `rocicorp/mono` commits.

## Goal

Capture release items over-inclusively so a human can trim the list, but write each public item concisely for developers.

## Inputs

- Release version, e.g. `1.2.0`
- Previous release tag, e.g. `zero/v1.1.0`
- Target tag/commit, e.g. `zero/v1.2.0` or `main`

## Repo Discovery

1. Look for a local monorepo as a peer of the current repo first.
2. Preferred path check order:
   - `../mono`
   - other sibling dirs named like `*mono*`
3. Verify it is the right repo by checking that `origin` is `rocicorp/mono`.
4. If no valid local monorepo is found, ask the human for the path.
5. Only use remote GitHub fallback if local repo is unavailable.

## Workflow

1. Determine commit range between release tags:
   - First list every non-merge commit in the raw range:
     - `git log --reverse --oneline --no-merges <prevTag>..<targetTag>`
   - Keep this as the audit source until the human has reviewed categorization.
2. Remove commits already included in the previous release through cherry-picks:
   - Find the common ancestor between previous release and target:
     - `git merge-base <prevTag> <targetTag>`
   - Inspect commits on the previous-release side after that ancestor:
     - `git log --reverse --format='%h%x09%s%n%b%n---END---' <mergeBase>..<prevTag>`
   - Look for `-x` cherry-pick trailers such as `(cherry picked from commit <sha>)`.
   - Also use patch-equivalence to catch cherry-picks whose lockfiles or package-manager files differ:
     - `git log --right-only --no-merges --cherry-mark --format='%m%x09%h%x09%s' <prevTag>...<targetTag>`
   - Treat `=` commits as already present in the previous release and categorize them as `skip`, unless the target commit contains materially different user-facing changes.
   - When a previous-release maintenance commit names a target commit in its cherry-pick trailer, categorize that target commit as `skip`.
3. Run the protocol compatibility check immediately:
   - Find protocol constants in mono before drafting any notes.
   - Check both previous release and target values, for example:
     - `git show <prevTag>:packages/zero-protocol/src/protocol-version.ts`
     - `git show <targetTag>:packages/zero-protocol/src/protocol-version.ts`
   - Ensure the target version's minimum supported sync protocol is `<=` the previous release's `PROTOCOL_VERSION`.
   - If compatibility fails, this is a release-blocking breaking change. Record it loudly in `.releases/<major>.<minor>/commits.md` with `BREAKING`, and mark the responsible commit `BREAKING` if it can be identified.
   - If compatibility passes, still record the result in `.releases/<major>.<minor>/commits.md` so later release reviews do not need to rediscover it.
4. Categorize every commit and flag potential breaking changes before drafting. Use only these categories:
   - `perf`
   - `feature`
   - `fix`
   - `skip`
   - Also identify potential breaking changes in every commit, including skipped/internal-looking commits.
   - Look early for API renames/removals, env var/config changes, default behavior flips, migration requirements, protocol changes, package export/import changes, dependency/peer dependency changes that can affect install/runtime behavior, and commit text containing "breaking".
   - Record breaking-change status separately from category.
   - Use `-` for commits that are not believed breaking.
   - Use `MAYBE` for commits that could be breaking and need human review; explain why in the note.
   - If a commit is believed to be breaking, make it extremely visible with `BREAKING`. This should be rare; Zero release planning aims to avoid breaking changes.
   - Treat breaking-change detection as an early warning system for ongoing release review, not something to defer until the final draft.
5. Present the categorization to the human for review before writing release notes:
   - Use a Markdown table with `Commit`, `Category`, `Breaking?`, and `Note`.
   - The note should be a few sentences when useful: summarize what changed, why the category was chosen, whether it was skipped due to cherry-pick, revert, internal-only scope, or lack of user-facing impact, and why it is or is not a potential breaking change.
   - Prefer `skip` for CI, release tooling, benchmark-only, sample-only, dependency hygiene with no identified user-facing effect, reverted changes, and commits already in the previous release.
   - Use `fix` for customer-observable behavior even when the commit is labeled `chore`, e.g. packaging changes that prevent duplicate runtime dependencies from breaking checks like `Pool instanceof`.
   - Use `perf` for fixes whose primary user-facing value is measured speed/CPU/allocation improvement.
   - Use `feature` for new user/operator/debugging capability.
   - Reclassify suspicious commits while building the table:
     - Include `chore` commits that look user-facing, behavior-changing, protocol-affecting, package/export-affecting, or crash/fix related.
     - Check dependency update commits when they affect runtime, install, protocol, query correctness, or performance-critical packages. Look at upstream changelogs when needed.
   - Treat the `Breaking?` column as the breaking-change pass:
     - Look for API renames/removals, env var/config changes, behavior flips, migration requirements, protocol changes, package export/import changes, dependency/peer dependency changes, and semantically breaking behavior even if unlabeled.
     - Also scan commit text for "breaking".
   - Flag performance follow-ups early for commits that change query compilation, index use, dependency implementations, hot loops, or runtime semantics. Put the performance concern in the note or open questions even if the commit category is `fix`.
6. Save the reviewed categorization in the docs worktree before drafting:
   - Use a stable release working-state directory under `.releases/<major>.<minor>/`, for example `.releases/1.7/commits.md`.
   - Include release version, previous tag, target, merge base, the exact commands used, the reviewed table, potential breaking changes, and any unresolved questions.
   - On later sessions, read this file first and evolve it instead of redoing the whole commit audit.
7. After human review of the categorization, classify the non-skipped commits using conventional commit prefixes as a starting point:
   - `feat` -> Features
   - `fix` -> Fixes
   - `perf` -> Performance (if meaningful)
   - `chore` -> ignored by default
8. Before drafting, revisit the reviewed table:
   - Confirm all non-skipped commits are represented or intentionally omitted.
   - Re-check any `MAYBE` or `BREAKING` rows and summarize the decision in the draft or in the saved release state.
   - Re-check any performance follow-ups recorded in `.releases/<major>.<minor>/commits.md`.
   - Before including a performance item in public release notes, run the benchmark comparison process below. If no release-quality comparison is available, omit the item and record why in `.releases/<major>.<minor>/commits.md`.
9. Build draft release notes in the latest format used in this repo:
   - Before drafting, read `contents/docs/release-notes/0.26.mdx` as the canonical long-form style reference to avoid format drift.
   - Include `## Performance` only when at least one item has release-quality comparison results. Follow `contents/docs/release-notes/1.7.mdx`: ground each improvement in a concrete developer workload, explain the practical benefit, then present scoped benchmark results and `<BenchmarkComparisonChart>` data when enough rows are comparable.
   - Frontmatter with `title` and `description`
   - `## Installation`
   - optional `## Overview`
   - `## Features`
   - optional `## Performance`
   - `## Fixes`
   - `## Breaking Changes`

## Formatting Rules

- Prefer covering too many relevant items in the draft over missing one; do not make individual items verbose.
- Do not list chores unless they appear miscategorized and user-relevant.
- Feature bullets must link to docs; if unknown, use `TODO` links as placeholders.
- Fix bullets must be one line each and link to PRs.
- Use the benchmark requirements below for all performance claims. Follow the `contents/docs/release-notes/1.7.mdx` chart format when enough rows are comparable; reserve bullets for isolated targeted results.
- If a perf PR has mixed results, emphasize meaningful wins and avoid dismissive phrasing.
- If several PRs comprise one logical fix, include one bullet with artful multi-link phrasing.
- If no breaking changes, write `None.`
- **Performance descriptions must explain the developer impact**, not just repeat a commit title, internal optimization, or benchmark result:
  - Identify the exact lifecycle phase that improved before drafting: initial execution or hydration, incremental maintenance or updates, replication, or another specific operation. Name that phase in the heading and claim; do not imply the whole feature is faster when only one phase changed.
  - Order performance sections by expected user impact, with broad production improvements before narrower optimizations. Do not order them by commit chronology or the largest multiplier.
  - Start with a recognizable workload: a ZQL query, mutation flow, sync pattern, or operator task. Use a short public API example when it makes an abstract optimization concrete, but do not repeat API syntax throughout the explanation.
  - Format API names consistently, for example `related()`, `orderBy()`, and `limit()`. Do not add a leading dot to one API name when the others do not have one.
  - Make sure the example can produce the measured slow path. For example, add a realistic sparse filter if the improvement depends on finding 50 matches far into an index.
  - Explain the old behavior and what Zero does differently before giving the results. A developer should be able to understand why the optimization helps.
  - Explain counterintuitive benchmark dimensions. If a chart suggests that a row farther into an index is faster, state what operation is measured and why that trend occurs.
  - Use established docs terms. For initial local query execution, say `hydrate` or `hydration`, not the internal term `fetch`. For ongoing query work, use `incremental updates` when that is what was measured.
  - Do not expose internal terms such as `fetch`, `Take`, `MemorySource`, `storer`, `query path`, or `changeLog` in public headings, prose, chart titles, or chart labels. Replace them with the public API or product operation.
  - Avoid invented or vague phrases such as `result window`, `refill`, `related data`, or `the version with creators`. State the rows or relationships involved directly.
  - Inspect the commit, tests, PR context, and nearby product docs when the user-facing workload or wording is unclear. Reuse the docs' terminology and rewrite from scratch rather than forcing an awkward explanation.
  - Match the measurement to the claim. Claims about replication, query execution, or query maintenance require end-to-end coverage of that operation. An internal stage may explain a result, but its throughput must not be presented as the user-facing operation's throughput.
  - Prefer absolute, user-meaningful values on chart axes, such as changes/sec, updates/sec, or milliseconds. Show both release values and keep the faster/slower multiple in the tooltip. A multiple alone is too abstract for readers to judge practical impact.
  - Put the machine name only in chart subtext, not in body prose, chart titles, or row labels. Keep it short, for example `Measured on M5 Pro. Higher is better.` Keep detailed hardware, process counts, aggregation, and other methodology in `.releases/<major>.<minor>/`.
  - Do not narrate "a benchmark," "a focused benchmark," or setup details in public prose. State the measured before/after values directly.
  - Use user-facing chart titles and plain row labels. Labels should name the variable being changed, for example `Last result at row 50,000`, rather than an internal concept such as `Boundary 50,000 rows deep`.
  - Keep chart subtext plain and factual: machine plus whether higher or lower is better. Put units on the axis instead of repeating the workload in the subtext.
  - Keep tooltips compact: previous value, current value, and faster/slower ratio. Do not repeat the chart row title in the tooltip.
  - Do not invent product concepts from workload descriptions. For example, say "replicating large transactions," not "bulk writes," unless the product has a public bulk-write API.
  - Remove unmeasured or promotional conclusions such as "helping changes reach clients sooner." Explain only the behavior and impact demonstrated by the measurement.
  - If the complete user-facing operation does not improve meaningfully, omit the public performance item rather than substituting a faster internal stage.
  - Omit a performance item if you cannot explain who benefits, under what conditions, and what improves.
  - Bad: "`Take` maintenance adds a sargable leading-column bound, improving the query-builder/SQLite proxy by 5416x."
  - Good: "Previously, that read could start at the beginning of the index. In 1.8, Zero starts SQLite at the last returned row's sort key, so SQLite can seek into the index and scan from there."
  - Bad: "Change-log persistence is 2.48x faster, helping large transactions reach clients sooner."
  - Good: "Zero 1.8 replicated one 50,000-change transaction at 17,456 changes/sec, up from 11,045 changes/sec in Zero 1.7."
  - Bad: "The version with creators only fell from 1.11 ms to 0.84 ms."
  - Good: "Hydrating 500 issues with creators fell from 1.11 ms to 0.84 ms."
  - Bad chart title: "Ordered Limit Boundary Fetch"
  - Good chart title: "Maintaining `orderBy()` + `limit()` Queries"
  - Bad chart description: "Normalized query-path throughput when refilling an ordered limited view. Higher is better."
  - Good chart description: "Measured on M5 Pro. Higher is better."
  - Before publishing, review performance headings, prose, chart titles, row labels, subtext, and tooltips independently. Confirm that a developer can tell what was measured, what Zero does differently, what each chart row varies, and why the results behave as shown.
- **Fix descriptions must be user-facing**, not implementation details:
  - Describe the problem, not "Fix [problem]" - the section heading already says "Fixes"
  - Phrase fixes as the old broken behavior or user-visible problem, not as a new capability
  - Prefer wording like "X could...", "X were not...", "X failed to...", or "X incorrectly..."
  - Avoid feature-style wording in fixes such as "X can now...", "Added support for...", or "Expose..."
  - When a fix has a user-visible error message and the exact text is available in commit messages, PR discussion, tests, issues, or code comments, prefer quoting that error text because users are more likely to recognize it
  - If you cannot verify the exact error text from source material, do not invent or paraphrase it as a fake quote
  - Good: "Hang during initial sync when no upstream changes occurred after backfill"
  - Good: "Query and mutator validation errors were not exposing raw schema issues in error `details`"
  - Good: "Error 'cannot extract elements from a scalar' when nullable array values were passed to custom mutators"
  - Bad: "Ensure backfill-completed tx version is >= the backfill watermark"
  - Bad: "Query and mutator validation errors can expose raw schema issues in error `details`"
  - Bad: "Error 'some guessed message' when..." if that string was not verified from source
  - If there's an error message, include it: "Error 'could not frob confabulator' when..."
  - Omit purely internal fixes that users would never notice
- Thank external contributors (non-Rocicorp) at the end of their bullet:
  - Format: `(thanks [@username](https://github.com/username)!)`
  - Check commit author emails - rocicorp employees use `@roci.dev` emails. `tantaman` is a rocicorp contributor.
  - Also check for Co-authored-by lines in commit messages

## Benchmark Comparison For Release Notes

Use a repeatable benchmark comparison process for release-note performance numbers, not a single local run.

### Process

1. Create one clean worktree per ref/version.
2. Apply the exact same benchmark file/change to both worktrees if the benchmark is new.
3. Install using each ref's intended package manager/lockfile.
4. Run the targeted benchmark in isolation, not as part of the whole suite.
5. Run it multiple times as separate processes, usually 10 completed runs.
6. Compare median-of-medians by benchmark name.
7. Treat deltas inside roughly `±5%` as flat unless the absolute delta is release-relevant.
8. For suspicious results, rerun focused subsets rather than trusting one matrix row.
9. Document whether the result is original-suite coverage or targeted post-matrix coverage.

### Commands Shape

For in-memory ZQL benchmarks:

```sh
pnpm --filter zql-benchmarks exec vitest run --config vitest.config.bench-mem.ts debug-row-vended
```

For shared package benchmarks:

```sh
pnpm --filter shared exec vitest run --config vitest.config.bench.node.ts logger
```

For release-quality numbers, run the command in 10 separate processes with JSON output:

```sh
BENCH_OUTPUT_FORMAT=json pnpm --filter zql-benchmarks exec vitest run --config vitest.config.bench-mem.ts debug-row-vended
```

Aggregate each benchmark's 10 process-level medians.

### Reliability Rules

- Prefer targeted benchmarks when validating a specific perf commit.
- Use separate processes: mitata handles in-process sampling, but not process startup, JIT, GC, or environment noise.
- Avoid concurrent benchmark runs on the same machine.
- Keep benchmark inputs deterministic and prebuilt where possible.
- Make both refs run the same benchmark source.
- Don't claim a perf win if the comparison is really "fixed implementation vs temporary bad implementation"; call that out separately.
- For PostgreSQL benchmarks, keep database setup identical and use benchmark-internal warmups plus multiple complete runs.
- If target-only benchmark coverage exists, temp-backport only the benchmark/harness changes needed to run the same benchmark definition on the baseline. Do not backport production code when measuring a performance commit.
- Save or link raw outputs and aggregate scripts/results in `.releases/<major>.<minor>/` so future release review can audit the numbers.

## File Updates

1. Add new note at `contents/docs/release-notes/<major>.<minor>.mdx`.
2. Add index entry at the top of `contents/docs/release-notes/index.mdx`:
   - Format: `- [Zero X.Y: Short Description](/docs/release-notes/X.Y)`
   - Insert as the first list item (after the frontmatter)
   - The description should match the `description` field in the release note's frontmatter
3. Keep title style aligned with latest release notes.

## Updating Non-Release-Note Docs

When a new feature lands, the release-notes feature bullet should link to a real docs anchor — not a PR. That often means updating `contents/docs/**` to document the feature alongside the release.

When updating those docs, do not mention version numbers. The main docs describe Zero's current state only; version numbers belong in release notes. Exception: a `<Note>` callout describing historical behavior or a legacy workaround may say "originally" or "previously" but should still avoid precise version numbers like `>=v1.5`.

## Smoke-Test Handoff

After the human has reviewed the release contents and a canary is available, load the `release-smoke-test` skill. Pass it the reviewed release notes, previous stable version, target canary, mono ref, selected companion packages, and unresolved feature or compatibility risks from `.releases/<major>.<minor>/commits.md`.

Use smoke testing to validate the release notes as an upgrade contract. Any required migration or operational step that cannot be inferred from the target release notes should be recorded as a release-note or documentation gap.

## Output Checklist

- Commit range used
- Features included
- Performance items included/excluded rationale
- Performance benchmark comparison refs, commands, run count, aggregation method, and raw/aggregate result location
- Whether each performance result is original-suite coverage or targeted post-matrix coverage
- Potential breaking changes list (or explicit none found)
- Protocol compatibility result
- Any TODO docs links left for human follow-up
