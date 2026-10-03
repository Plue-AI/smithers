# @smthrs/errors

## [Unreleased]

### Changed

- Changed `ERROR_REFERENCE_URL` and the documentation suffix in every
  `SmithersError` message to link to the package-owned error code reference on
  GitHub instead of the removed website page.

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added `hasSmithersErrorShape` for structural refinement across duplicate
  package instances, with validation against the documented code vocabulary.
- Added package-owned documentation generated into
  `docs/pages/reference/errors.md`.

### Changed

- Trimmed the Smithers 0.x registry from 180 codes to the five codes the
  `@smthrs/integrations` trees raise under orchestrator ruling A1 (R-34) in
  the release policy.
- Closed the `SmithersErrorCode` union over the keys of
  `smithersErrorDefinitions`.
- Copy and freeze the top-level `details` record at construction, and freeze
  the definition and known-code tables. Nested detail values remain shared by
  reference and are not deep-frozen.
- Strip the documentation URL suffix from `summary`, match it only as a suffix
  instead of a substring, tolerate trailing and inter-suffix whitespace, and
  skip it when the summary is blank.
- Omit `cause` as an own property when the caller supplies no cause or passes
  `cause: undefined`.
- Renamed `knownSmithersErrorCodes` to `smithersErrorCodes` and
  `isKnownSmithersErrorCode` to `isSmithersErrorCode`.
- `hasSmithersErrorShape` now rejects a `details` value that is not a non-null
  object, and rejects an array. A `Date`, a `Map`, or a class instance passes.
- Install `name` as a non-enumerable own property and install `details` as an
  own property only when the caller supplies one, so logs no longer print
  `details: undefined`.

### Removed

- Removed the `KnownSmithersErrorCode` alias. `SmithersErrorCode` is now the
  derived type.
- Removed `getSmithersErrorDocsUrl`; use `ERROR_REFERENCE_URL`.
- Removed the constant `category` field from `SmithersErrorDefinition`.
- Removed the unused `effect` and `@effect/vitest` devDependencies.
