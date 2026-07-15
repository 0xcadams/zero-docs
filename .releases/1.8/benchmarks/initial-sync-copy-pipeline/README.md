# Initial Sync Copy Pipeline

This directory contains the preregistration, fixture definitions, runner, and
analysis tools for unvetted initial-sync performance experiments. No experiment
is considered accepted merely because it has a branch or exploratory result.

The active experiment graph and decision gates are in `pr-plan.md`. Historical
reports retain their original PR-numbered labels as immutable provenance; active
configuration and scripts use experiment names instead.

## Source Worktrees

Mono worktrees are pinned in `config/worktrees.json`:

- `origin-main`: frozen experiment baseline at `bc1db665f`.
- `direct-buffer-cast`: E1 treatment at `27683b82b`.
- `adaptive-index`: E2 treatment at `11622fdf4`.
- `adaptive-index-eager`: E2 source plus a benchmark-only forced-eager overlay.
- `enhanced-adaptive-index`: E3 branch, currently identical to E2.
- `schedule-large-tables`: E4 branch, currently identical to the baseline.

Local zero-sqlite3 worktrees are also pinned:

- `native-utf8-binding`: E5 addon branch.
- `native-initial-sync-ingestor`: E12 addon branch.

The addon experiments build directly from these local worktrees. They do not
publish, download, or require an npm canary.

## Resource Policy

Every application profile uses the same limits:

```text
CPU: 1
memory: 3 GiB
Node heap: 2304 MiB
```

PostgreSQL runs in a fresh isolated container for each measured operation and is
pinned to a disjoint CPU set in canonical mode.

## Canonical Safety

Canonical execution fails closed unless all of these are true:

- Product and addon sources match full configured commit and tree IDs.
- Sources are clean, including untracked files.
- Base images are digest-pinned.
- Product and PostgreSQL CPU sets are present and disjoint.
- The stage is complete and has a fixed analysis plan.
- The profile is canonical and has exact rows, COPY bytes, COPY digest, and
  replica content digest.
- The source isolation and cache policies are explicitly declared.
- Every expected artifact exists exactly once and matches its SHA-256.

Current profiles are calibration-only because their COPY and content digests
have not yet been pinned. The E1 screening and confirmatory stages and the E2
stage are runnable with `--noncanonical`; E3-E12 remain definition-only until
their treatments are implemented.

## Files

- `Dockerfile.linux`: generic mono experiment image.
- `Dockerfile.adaptive-index.linux`: adaptive and forced-eager oracle images.
- `Dockerfile.addon-experiment.linux`: mono image linked to a local
  zero-sqlite3 worktree.
- `scripts/build-adaptive-index-images.mjs`: builds the E2 three-arm image set.
- `scripts/run-docker.mjs`: isolated immutable Docker runner.
- `scripts/aggregate.mjs`: exact artifact reconciliation and process-level
  aggregation.
- `scripts/summarize-integration.mjs`: paired effect estimates, confidence
  intervals, order effects, and decision gates.
- `config/experiment-families.json`: deterministic generated fixture families.
- `config/integration-stages.json`: runnable E1/E2 stages and definition-only
  E3-E12 experiment designs.

## Validation Commands

These commands validate preparation without running a performance benchmark:

```sh
node scripts/run-docker.mjs --self-test
node --test scripts/analysis.test.mjs scripts/artifacts.test.mjs
pnpm exec vitest run tests/initial-sync-copy-pipeline-config.test.ts
node scripts/build-adaptive-index-images.mjs
```

The image builder defaults to a dry run. `run-docker.mjs` also defaults to a
write-free dry run. Pass `--noncanonical` for the current E1/E2 profiles;
definition-only stages are rejected even in dry-run mode.

## Evidence

Each execution writes an immutable nested run directory with a manifest and an
exact expected-artifact list. Aggregation requires an explicit run token when
more than one run exists. Noncanonical nested runs retain the same artifact hash
checks but remain exploratory. Legacy flat artifacts can be read only with
`--legacy` and are also always exploratory.
