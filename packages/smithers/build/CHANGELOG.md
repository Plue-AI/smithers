# Changelog

## Unreleased

- Runtime version requirements compare numeric prerelease identifiers exactly,
  including values beyond JavaScript's safe integer range. Adjacent large
  identifiers no longer admit an older runtime through rounding.
- Breaking: install linking declares `irreversible`, not `sealed`. The planner
  now accepts that honest tier. Link uses a run-local identity, never publishes
  shared cache, and does not promise rollback of ignored dependency files.
  It has no automatic retry or uncertain-attempt recovery contract. This
  changes link and downstream plan identities; finish existing runs before
  upgrading rather than mixing declarations within a run.

## 1.0.0-rc.0

- First public release candidate of the Smithers build runtime.
