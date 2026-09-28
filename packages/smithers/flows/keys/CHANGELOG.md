# @smthrs/keys

## [Unreleased]

### Security

- `KeyDerivationError.cause` is no longer a schema field. It stays available
  in process as a non-enumerable property, so schema encoding and
  `JSON.stringify` now yield only `_tag`, `code`, and `message` and no longer
  carry a throwing getter's message or a property path. `Cause.pretty` still
  renders the in-process `cause` chain.

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added explicit `KeyV1` and `StoredKey` schemas for identity-preserving
  validation of persisted keys.
- Added typed derivation through `deriveKey` with stable, cause-preserving
  `KeyDerivationError` codes.
- Added package-owned documentation and frozen `key1_` wire vectors.

### Changed

- Reject unsupported future version markers instead of guessing their payload
  representation.
- Redact derivation input from schema diagnostics and document domain,
  canonicalization, and memory requirements.
- Move cache, invocation, environment, and filesystem policy to the engine;
  this package owns only generic key derivation and wire validation.

### Removed

- Removed the `Key` compatibility schema and its attached `derive`,
  `StoredKey`, and `KeyV1` properties (commit 838d85c430). The package ships
  no compatibility surface before its first release. Migrate to the named
  exports:

  | Before          | After        |
  | --------------- | ------------ |
  | `Key`           | `DerivedKey` |
  | `Key.derive`    | `deriveKey`  |
  | `Key.StoredKey` | `StoredKey`  |
  | `Key.KeyV1`     | `KeyV1`      |

## [0.1.0] - 2026-08-05

### Added

- Added canonical serialization, injected SHA-256 digests, cache keys, and
  invocation keys.
