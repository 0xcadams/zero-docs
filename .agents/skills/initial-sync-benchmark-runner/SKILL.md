---
name: initial-sync-benchmark-runner
description: Runs and monitors initial-sync-copy-pipeline benchmarks on ssh macbook. Use when executing E1-E12 benchmark stages, checking Mac benchmark resources, aggregating immutable runs, or syncing benchmark artifacts.
---

# Initial Sync Benchmark Runner

## Locations

- Local harness: `/Users/chase/git/roci/zero-docs/.releases/1.8/benchmarks/initial-sync-copy-pipeline`
- Mac harness: `/Users/chase/.worktree/zero-docs/benchmarking/.releases/1.8/benchmarks/initial-sync-copy-pipeline`
- Remote host: `ssh macbook`
- Tmux session: `initial-sync-bench`

## Hard Rules

- Never run Git commands. The user will commit after testing.
- Code edits happen locally by the parent agent, then sync to the Mac with `rsync`.
- Do not patch source directly on the Mac. Report code failures to the parent agent.
- Preserve every immutable run directory, including failed runs.
- Keep monitoring output concise. Query manifests in one line; do not dump tmux panes or full aggregate JSON.
- Do not start a benchmark unless the requested stage is runnable and the preflight is clean.

## Preflight

Run these through SSH immediately before every benchmark stage or diagnostic block:

1. Confirm the tmux pane is idle and no Docker containers are running.
2. Take a two-sample `top` reading. Require at least 90% CPU idle on the second sample.
3. Check `memory_pressure -Q`; require ample available memory and no swap pressure.
4. Take three one-second `iostat` samples. Require no sustained disk throughput in the final two samples.
5. Check AC power and `pmset -g therm`; require no thermal or performance warning.
6. If CPU or disk is busy, identify the competing process, wait, and repeat. Do not run alongside Spotlight, backups, builds, other containers, or user workloads.
7. Confirm these Spotlight exclusion markers remain present:
   - `/Users/chase/git/.metadata_never_index`
   - `/Users/chase/.worktree/.metadata_never_index`

## Execution

- Run inside `initial-sync-bench` under `caffeinate`.
- Standard isolation flags are `--cpuset-cpus=0 --postgres-cpuset-cpus=2-3`.
- Current profiles are exploratory, so use `--noncanonical`.
- Rebuild images after harness or source changes. Do not pass `--reuse-images`; the runner rejects stale labels.
- Use the exact stage and limit requested by the parent agent.

Example:

```sh
caffeinate -dimsu node scripts/run-docker.mjs <stage> --execute --noncanonical --cpuset-cpus=0 --postgres-cpuset-cpus=2-3
```

## Monitoring And Results

- Poll the newest stage manifest every 2-5 minutes and report only token, status, and `operations/runs`.
- On failure, extract only the relevant error from the failed operation log.
- After completion, run `aggregate.mjs` and `summarize-integration.mjs` with stdout redirected to `/dev/null` because they print large JSON documents.
- Those scripts write fixed `results/<stage>.json` paths. A partial diagnostic run will replace the shared full-stage summary. After validating a partial run, restore the selected full run's aggregate and summary before syncing shared result files. The immutable partial raw run remains sufficient to regenerate its diagnostic summary.
- Sync the exact raw run directory and result JSON files back to the local harness with `rsync`, then use an `rsync -rcn` dry run to verify equality.
- Report run tokens, operation counts, failures, resource anomalies, and concise paired results. Do not make a landing decision from noncanonical evidence.

## Mac Storage Limitation

SQLite files created under `/tmp` in Docker Desktop's writable overlay layer showed highly variable post-sync I/O stalls. An E1 diagnostic found stable callback improvements but unstable whole-readiness results on overlay and Docker volume storage; tmpfs removed the stalls. Treat Mac disk-backed whole-readiness timings as diagnostic only. Use non-Docker-Desktop controlled storage only when a disk-backed whole-readiness claim is required.

The runnable E1 stages therefore declare a 1536 MiB tmpfs mount for `/tmp`.
Confirm that `manifest.sqliteStorage.mode` is `tmpfs` for every E1 run. Do not
apply tmpfs implicitly to storage-sensitive experiments such as E2.
