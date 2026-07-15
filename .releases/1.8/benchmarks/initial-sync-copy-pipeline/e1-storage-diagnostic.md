# E1 Docker Desktop Storage Diagnostic

This noncanonical diagnostic tested whether Docker Desktop storage caused the
unstable E1 `email-683m` whole-readiness result. Each storage mode ran six
paired baseline and Buffer-through-CAST blocks with identical CPU and memory
constraints.

| Storage          | Baseline finalization | Buffer finalization | Baseline finalization I/O pressure | Buffer finalization I/O pressure |            Paired outer change |
| ---------------- | --------------------: | ------------------: | ---------------------------------: | -------------------------------: | -----------------------------: |
| Writable overlay |              1,381 ms |            1,538 ms |                           1,314 ms |                         1,466 ms | -18.9%, range -63.9% to +96.7% |
| Docker volume    |              1,200 ms |            1,772 ms |                           1,136 ms |                         1,697 ms | -7.0%, range -71.1% to +203.5% |
| tmpfs            |                 14 ms |               13 ms |                               0 ms |                             0 ms | -32.1%, range -36.0% to -29.6% |

The callback improvement was stable in every mode: 30.3% on overlay, 30.2% on
Docker volume, and 32.7% on tmpfs. Only the disk-backed finalization interval
was unstable. Docker volume storage did not help because it still used Docker
Desktop's virtual disk. Tmpfs eliminated finalization I/O pressure and reduced
finalization to about 13 ms.

The unstable E1 outer result on the Mac was therefore caused by Docker-backed
storage, not CPU contention or a repeatable Buffer-through-CAST regression.
The diagnostic supports E1's sync-path improvement. A specific claim about
disk-backed whole-readiness would need a host without Docker Desktop's virtual
disk, using controlled, representative storage.

Run tokens:

- Overlay: `2026-07-15T23-03-31-838Z-97202-2adac4f4-f247-4518-9538-38aebad11899`
- Docker volume: `2026-07-15T23-09-48-900Z-1143-bf544216-23c4-45c6-b8cf-6c9b34738ee2`
- tmpfs: `2026-07-15T23-18-51-250Z-5177-a36da5b8-c775-48ef-a294-85fd387ab1b3`

The immutable raw runs and their aggregate summaries remain under `raw/` and
`results/`. The temporary multi-mode diagnostic stages and phase
instrumentation were removed after the conclusion was recorded. The normal E1
stages retain a stage-scoped tmpfs mount to avoid the identified Docker Desktop
storage noise.
