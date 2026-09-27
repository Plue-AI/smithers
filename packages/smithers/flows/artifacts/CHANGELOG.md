# @smthrs/artifacts

## [Unreleased]

### Fixed

- The filesystem store syncs the real ancestors of a Windows drive directory.
  Breaking: `makeFileSystem(fs, path, options)` takes the host `Path`, and
  `layerFileSystem` requires `Path.Path` (`NodePath.layer` on Node) (#2302).

## [1.0.0-rc.0] - 2026-08-31

### Added

- New package. The content-addressed artifact store extracted out of
  `@smthrs/engine-store`'s `StepBoundary`: `ArtifactStore` (contract,
  filesystem, memory, and no-op implementations), `RemoteArtifacts` (the
  dumb-HTTP CAS client), and `CombinedArtifacts` (local-first, remote-second
  read-through with local write-back).
- Two improvements taken while moving, both from Bazel's `DiskCacheClient`: a
  two-hex-prefix fanout directory layout, and an fsync of the temp file before
  the rename that publishes it. There is no compatibility shim for the old flat
  layout.

### Changed

- Snapshotted all caller-owned byte arrays at Effect start and copied every
  read result.
- Added strict SHA-256 address validation, typed configuration and crypto
  failures, finite remote deadlines and body limits, and deterministic
  `findMissing` deduplication.
- Added workspace-wide writer/sweeper coordination with crash recovery, and
  reclaimed crash-orphaned lock files in the same conservative scratch sweep
  that reclaims `.tmp-*` payloads.
- Made download policy immutable and consistent across constructors and layers.
- Made `CombinedArtifacts.get`'s local write-back opportunistic: a local tier
  that cannot store bytes the shared tier already served costs the next read a
  round trip instead of failing this one. `minimal` now repairs a corrupt local
  address, because an address the local tier already claims must be one it can
  serve.
- Applied caller-configured headers before the protocol's own, so a configured
  `content-range`, `content-type`, or `content-length` can no longer overwrite
  a chunked upload's computed headers.
- Reported a refused byte snapshot as `unavailable`, the host-refusal code,
  rather than as a crypto `digest_failed`.
- Ignored a resume prefix past the safe integer range instead of trusting a
  rounded offset.
- Gave `ArtifactSweep` its own `SweepOptions` rather than the store's options,
  which carried a `durability` field it ignored, and exported
  `ArtifactStore.defaultDirectory` so the store and its sweep name one
  directory.
- Classified a backup-lease marker another process already reaped as a clean
  release rather than logging a release failure.
- Stopped a lock heartbeat from freshening a lock file it no longer owns. A
  holder reaped as stale and replaced kept touching that path every 10 seconds,
  which held the replacement fresh past every stale bound, so a replacement that
  was then hard-killed blocked the digest for as long as the reaped holder ran.
  A lock that is gone or now names another owner ends the heartbeat; a read the
  host refused for any other reason skips one beat and retries, so a transient
  refusal cannot retire a lock still held.
- Made per-digest lock bookkeeping per execution rather than per construction.
  A lock effect built once and run repeatedly, which is how the backup lease
  heartbeats, retired its entry underneath a live holder, and the next caller
  minted a second in-process semaphore for the same digest.
- Documented that reclaiming a stale lock measures and then removes in separate
  steps, so simultaneous reclaims of one stale lock can both proceed, and that
  `ifUnmodifiedSinceMs` and the backup lease are the fences that do not depend
  on it.
