# Shadow-Sync mmap Canary Runbook

This canary tests the 1 GiB SQLite mmap treatment only on the throwaway shadow
replica. It does not change serving-replica initial sync, replication, backup,
or query behavior.

## Implementation

The runtime branch `0xcadams/shadow-sync-mmap-canary` is based on mono commit
`ef892a123a11461e74a59a4b59ad310ba23180b3`. It adds the hidden, default-off
environment option:

```text
ZERO_SHADOW_SYNC_SQLITE_MMAP_SIZE_BYTES=1073741824
```

The option is read only by the shadow-sync worker and passed into the shared
`initialSync()` implementation, which applies it to the throwaway SQLite file.
Existing shadow and initial-sync metrics expose the configured cap as
`mmap_size_mib=0|1024`. The validated SQLite build accepts the 1 GiB cap, so
the configured value is treated as effective.

The companion CloudZero branch selects stack `aeuuxvuox8o4ecw3` only when its
image version matches `1.9.0-canary.N`. The env var is added only to the
replication-manager. A non-target stack, a stable image, or an image rollback
gets no mmap env var.

No Grafana dashboard changes are part of this canary. Use the PromQL below for
the treatment comparison; full cgroup utilization is the primary memory guard.

## Preconditions

1. Publish a `1.9.0-canary.N` image containing the runtime change.
2. Keep the CloudZero mmap selector undeployed while collecting the same-image
   control. The current 1.8 image does not recognize the new env var.
3. Refresh production SSO and confirm the six regional AMP workspaces are
   queryable. Do not proceed on missing memory or restart telemetry.
4. Record the target stack's current image, resource limits, restart count,
   replication lag, and backup lag for rollback and comparison.
5. Confirm the target remains at 3 GiB memory and 1 CPU. Re-evaluate the 75%
   memory gate if its limit changes.

## Same-Image Control

1. Use the CloudZero `Update Stack Zero Version` workflow with target
   `stack-ids` and only `aeuuxvuox8o4ecw3` to pin the supporting canary image.
2. Wait for the stack apply to complete and verify the workload's public
   `cloudzero.dev/zero-version` annotation is the intended canary version.
3. Confirm the generated replication-manager manifest does not contain the
   mmap env var.
4. Collect at least three successful control runs from this exact image. Confirm
   `mmap_size_mib="0"`.

## Enable Treatment

1. Deploy the CloudZero mmap selector after the same-image control is complete.
2. Rerun `Update Stack Zero Version` for the same stack and same canary image.
   The workflow requests a stack apply even when the image is unchanged.
3. Inspect the generated replication-manager manifest through the controller
   apply evidence and confirm it contains the mmap env var. Confirm the
   view-syncer manifest does not contain it. Do not read Secrets or use
   `kubectl exec`.
4. Wait for the normal jittered shadow run. The first run starts in the final
   third before the configured 12-hour interval, so allow up to 12 hours.
5. Confirm the log reports `mmapSizeMiB: 1024` and the run emits
   `mmap_size_mib="1024"`.

## Performance Queries

Set the dashboard stack variable to `aeuuxvuox8o4ecw3`. Compare treatment runs
with the same-image controls collected above and keep COPY size in the same
range.

Index seconds per GiB:

```promql
sum by (mmap_size_mib) (
  max_over_time(zero_replication_initial_sync_index_duration_seconds_sum{
    stack="aeuuxvuox8o4ecw3",sync_mode="shadow",result="success"
  }[$__range])
)
/
(
  sum by (mmap_size_mib) (
    max_over_time(zero_replication_initial_sync_completed_copy_stream_bytes_total{
      stack="aeuuxvuox8o4ecw3",sync_mode="shadow",result="success"
    }[$__range])
  ) / 1073741824
)
```

Total seconds per GiB uses the same denominator:

```promql
sum by (mmap_size_mib) (
  max_over_time(zero_replication_initial_sync_duration_seconds_sum{
    stack="aeuuxvuox8o4ecw3",sync_mode="shadow",result="success"
  }[$__range])
)
/
(
  sum by (mmap_size_mib) (
    max_over_time(zero_replication_initial_sync_completed_copy_stream_bytes_total{
      stack="aeuuxvuox8o4ecw3",sync_mode="shadow",result="success"
    }[$__range])
  ) / 1073741824
)
```

Successful and failed runs:

```promql
sum by (result, mmap_size_mib) (
  max_over_time(zero_replication_shadow_sync_runs_total{
    stack="aeuuxvuox8o4ecw3"
  }[$__range])
)
```

## Safety Queries

Shadow initial-sync activity marker:

```promql
zero_replication_initial_sync_active{
  stack="aeuuxvuox8o4ecw3",sync_mode="shadow",mmap_size_mib="1024"
}
```

Peak full-cgroup utilization across the treatment pod's complete lifetime,
including SQLite teardown immediately after `initialSync()` returns:

```promql
max_over_time(k8s_container_memory_limit_utilization_ratio{
  stack="aeuuxvuox8o4ecw3",container="replication-manager"
}[$__range])
```

Restarts and OOM termination state:

```promql
sum(max_over_time(kube_pod_container_status_restarts_total{
  stack="aeuuxvuox8o4ecw3",container="replication-manager"
}[$__range]))
```

```promql
max_over_time(kube_pod_container_status_last_terminated_reason{
  stack="aeuuxvuox8o4ecw3",container="replication-manager",reason="OOMKilled"
}[$__range])
```

Also inspect `zero_replication_total_lag_millisecond` and
`zero_replica_backup_lag_millisecond` over the same treatment window. RSS is a
secondary diagnostic because file-backed mmap pages can be resident without
representing additional cgroup memory beyond the page cache they replace.
Check replication-manager logs for `Error closing shadow replica db` and
`Error cleaning up shadow replica dir`; cleanup warnings are not counted as
failed shadow runs.

## Acceptance Gates

Set the query range to begin when the same-image control pod was deployed; the
`max_over_time` expressions recover the first terminal counter value for each
pod, which `increase` would miss when a series is created by its first run.
Collect at least three successful control and three successful treatment runs
from the same image with comparable 3-4 GiB COPY sizes. Proceed only when all
gates pass:

1. Index seconds per GiB is at least 30% lower than matched controls.
2. Total seconds per GiB is at least 10% lower than matched controls.
3. Peak full-cgroup utilization for the treatment pod stays below 75% of the 3
   GiB limit.
4. Every treatment run reports `mmap_size_mib="1024"`.
5. There are no OOM kills, container restarts, readiness regressions, shadow
   errors, or shadow replica cleanup warnings.
6. Replication and backup lag remain within the target stack's control range.

Do not infer serving-replica safety from a treatment that fails any gate. A
passing canary supports a separately reviewed serving-sync design; it does not
enable serving mmap automatically.

## Rollback

Pin `aeuuxvuox8o4ecw3` back to its recorded previous image with the same
stack-ID-targeted workflow. The CloudZero image guard then removes
`ZERO_SHADOW_SYNC_SQLITE_MMAP_SIZE_BYTES` from the next generated
replication-manager manifest. Confirm the applied zero-version annotation, the
absence of the env var in controller apply evidence, workload readiness, and
normal replication/backup lag.

Rollback immediately on any OOM kill, restart, readiness failure, persistent
replication or backup lag increase, shadow-sync error, shadow replica cleanup
warning, or full-cgroup memory at or above 75%.
