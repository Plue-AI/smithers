---
title: "Build cache limits"
description: "Repository storage quotas and expiry for the Smithers build cache."
---

## Storage and expiry

Each repository has a 1 GiB build-cache allowance shared by action records and
artifact bytes. Each record costs at least 1 KiB; larger action records count
both their original JSON and canonical result. Identical uploads do not consume
another allowance. A write exceeding the allowance returns HTTP `413` with
`repository build cache quota exceeded`, before uploading an artifact.

Records expire 30 days after server-side creation. Reading or publishing an
identical result does not extend that age. Client timestamps cannot extend it.
Expired action records, artifacts, and artifact presence probes return misses.
An action record also expires when one of its referenced artifacts expires.

Before admitting a write, the API reclaims at most 64 expired action records
and 16 expired artifacts, purging all object generations before releasing the
allowance. Cleanup has a 30-second budget; failure refuses the write. A worker
sweeps inactive repositories every minute in the same bounded batches. Each
repository commits separately so a later failure preserves prior progress.
A PostgreSQL repository lock serializes cleanup, deletion and quota admission
across replicas. A transactional usage counter avoids summing every cache row
on each publication.

Missing objects return cache misses, including presence probes. Their metadata
remains charged until repaired or expired; retaining it avoids a read deleting
a concurrent repair. This also lets clients repair objects deleted under an
older retention policy after the maximum age is increased.

## Configuration

| Environment variable | Default | Meaning |
| --- | --- | --- |
| `SMITHERS_BLOB_BUILD_CACHE_MAX_AGE_DAYS` | `30` | Maximum server-side age in whole days, from 1 to 36500 |
| `SMITHERS_BLOB_BUILD_CACHE_REPO_QUOTA_BYTES` | `1073741824` | Positive repository allowance in bytes |
| `SMITHERS_BLOB_BUILD_CACHE_ARTIFACT_MAX_BYTES` | `16777216` | Existing per-artifact upload bound |

Set the object store's deletion lifecycle on `build-cache/` to the same maximum
age, covering live and archived generations. This reclaims expired objects in
inactive repositories and uploads orphaned by a failed database commit. Lifecycle
deletion is asynchronous; the API enforces expiry immediately. When changing
retention, coordinate the API and object-store policy so storage does not delete
objects the API still considers live.

## Upgrade

Product migration `0074_build_cache_quota.sql` backfills repository usage,
installs transactional accounting triggers, and adds expiry indexes. Apply
product migrations before rolling out the API and worker. Build-cache artifact
keys use verified server uploads only, so their exact repository/digest keys
are exempt from the legacy signed-upload deletion fence.
