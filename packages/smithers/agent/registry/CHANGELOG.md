# @smthrs/registry

## [Unreleased]

### Fixed

- A flow's module closure no longer misses a load hidden behind a misread `/`
  ([#3106](https://github.com/smithersai/smithers/issues/3106)). The scan reads
  a regular expression after `break`, `continue`, `debugger`, a label and an
  `if`/`while`/`for`/`with` head, reads `#return` and `o.return` as names,
  reads Unicode and `\u`-escaped identifiers whole, and reads a line-leading
  `/` after an operand, and a `/` after `}`, both ways, pinning or refusing
  whatever either reading finds.

### Changed

- A delegating flow's declared `capabilities` are the ceiling of its delegate
  grant. `flow.ts` and `flow.mdx` descriptors that name `flows` carry the
  intersection of the declaration and the delegate's wildcard instead of `["*"]`;
  a declaration only narrows and never widens. A delegating flow that declares
  no capabilities keeps the wildcard
  ([#2763](https://github.com/smithersai/smithers/issues/2763)).

### Added

- `BudgetOnExceeded` includes `park`; flow budget metadata carries an optional
  `onExceeded` policy through the approved envelope (#1843).

- Flow model metadata accepts an ordered, non-empty seat list and preserves it
  in execution identity and invocation. Invalid markdown lists are refused
  with an `invalid_model` warning ([#1796](https://github.com/smithersai/smithers/issues/1796)).

- `Executable.Refresh` rebuilds one entry of a catalog the host is already
  serving from: rescan discovery, load that flow's body from the bytes now on
  disk, register it, and swap it into the snapshot. No restart, and the
  previous body stays registered until the new one is. `Executable.Refreshed`
  is its four-case answer — `Registered`, `Refused`, `Removed`, `Fixed`.
- `Executable.RefreshOptions.refreshable` decides which discovered flows a
  host rebuilds. A host serving part of its catalog out of its own measured
  bundle answers `false` for those entries and `refresh.flow` leaves them
  `Fixed`. Every flow is refreshable by default.
- `Executable.layerRefreshable(built, options)` serves a catalog the host
  assembled itself and keeps one entry rebuildable, without registering
  anything twice.
- `Executable.layer` now takes `RefreshOptions` and provides `Refresh` beside
  `Catalog`. Both changes are source compatible: the new option is optional
  and the layer's output only widened.

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added portable flow descriptors, progressive discovery, markdown skill
  compatibility, and the refreshable registry service.
- Added inline JSON Schema references that round-trip with every tagged schema
  reference through flow descriptors.
- Recognised the `effort` frontmatter key on markdown flows.
- Recognised a `budget` frontmatter declaration, projected as
  `Descriptor.FlowBudget` and read through `Descriptor.budgetOf`.
- `BodyRef` now carries the SHA-256 of the bytes discovery read, and both
  `Registry.loadBody` and `Executable.fromDescriptor` refuse a body that changed
  after discovery until the registry is refreshed.
- `Discovery` exports its two resource ceilings, `entrySizeLimit` and
  `maximumTraversalDepth`.
- `Executable.Invocation` carries `placementOptions`, the image, profile, and
  target that select a sandbox or remote host. An absent key decodes to `null`,
  because hosts pass the envelope itself as a durable action payload schema and
  a row journaled before the field existed is decoded again on replay. Encoding
  still writes the key, so the step key an envelope carrying a placement hashes
  to does not move.
- `DiscoveryError`, `RegistryError`, and `ExecutableError` carry the offending
  `path` as a field rather than only inside their prose message.
- `Pack.Installed` carries the manifest warnings `Pack.read` produced, so
  spreading that result into an installed pack reports `unknown_pack_key`
  through `registry.warnings()`.
- Added the `unreadable_pack_range` registry error code and the
  `unknown_pack_key`, `symlink_cycle`, `max_depth_exceeded`, and
  `entry_too_large` discovery warning codes.
- Added `packages/smithers/agent/registry/PACKAGE.ts`, which declares the
  package's targets through `BuildAndCheckTypeScriptPackage` from
  `@smthrs/repo-targets`, so the package is a target in the build graph. Its
  `docs` target checks the README and its `docsFiles` target names the package
  documentation. `apps/site/scripts/sync-api-docs.mjs` generates
  `apps/site/src/content/docs/docs/reference/api/registry.mdx` from
  `packages/smithers/agent/registry/docs/api.md` instead of a hand-maintained
  page.

### Fixed

- A source-root failure now carries the root as `path`, so `root_missing`,
  `invalid_root`, and `read_failed` name the offending directory as a field
  rather than only inside their message.
- `not_found` names the method the caller invoked, so a missing flow reported
  by `loadBody` or `runPrompt` no longer says `get`.

- Carried `Source.confinementRoot` from packs into discovery. When real paths
  are available, every descended directory and selected entry file is checked
  against the pack root; nested symlink escapes are skipped with `outside_root`
  before they can contribute descriptors, loaded bodies, or catalog imports.
  Links within the pack and unrestricted project sources remain supported.

- Confined pack manifest paths to the pack root. A `flows` or `skills` entry
  that is absolute, traverses with `..`, or resolves through a symlink to a
  directory outside the pack is refused as `invalid_pack` instead of registering
  and executing flows from anywhere on the host.
- Built every sanitized frontmatter mapping with a null prototype, so a
  `__proto__` key can no longer install inherited metadata that steers discovery
  while staying invisible to the descriptor's digest.
- Projected the conservative wildcard authority and an irreversible tier for
  both markdown and module flows that delegate to another flow, so an
  indirectly writing flow is no longer disclosed or cached as sealed.
- Bounded directory traversal with a visited-directory identity set and a
  32-segment depth ceiling, so a symlink loop under `flows/` no longer yields
  one flow many times over until the operating system raises `ELOOP`.
- Skipped entry files larger than 4 MiB with an `entry_too_large` warning rather
  than reading them whole at layer-construction time.
- Inferred `irreversible` for a home-relative, variable-prefixed, or
  scheme-prefixed `fs:write` scope, which the workspace-relative rule never
  meant to admit as compensable.
- Checked every pack's compatibility before scanning any pack, as the contract
  documented and the implementation did not.
- Accepted the npm ranges packs actually write, including `>= 1.0.0`, `>=1.0`,
  `^1`, and inclusive hyphen ranges, and reported a range this runtime cannot
  parse as `unreadable_pack_range` rather than as an incompatibility.
- Made `Pack.digest` a total order over duplicate paths and validated measured
  paths, so file-read order cannot change a lock address.
- Froze the descriptors, warnings, and configuration a registry hands out, and
  the `Invocation` envelope a delegate receives, so a caller can no longer
  rewrite a live snapshot or diverge from the identity the engine recorded.
- Escaped `file:` specifiers the way `pathToFileURL` does, so a POSIX path
  containing a backslash, a control character, a space, or non-ASCII text
  addresses the file it names.
- Carried a body-annotated placement, including its profile and image, into the
  delegate invocation and the durable identity instead of the descriptor's own
  directive.
- Replaced XML 1.0-forbidden code points, lone surrogates, and Unicode
  noncharacters with U+FFFD in `Disclosure.toXml`, so one malformed description
  cannot invalidate the catalog a model reads.
- Constrained `Descriptor.FlowBudget` to positive safe integers and froze
  `budgetUnbounded`, so an invalid ceiling cannot be decoded and one host cannot
  rewrite the budget every undeclared descriptor reports.
- Bounded frontmatter parse diagnostics to a line and column, so a malformed
  document no longer discloses its own source line through a public warning.
- Reported unknown top-level `pack.json` keys, so a misspelled `requires` no
  longer disables the compatibility gate in silence.
- Target module discovery at the default Flow export and conservatively classify
  regex-bearing, agent, and external-write declarations.
- Validate Agent Skills frontmatter leniently with field-specific warnings.
- Conservatively classify module spreads, computed properties, and unscoped
  writes; parse skill frontmatter with failsafe scalar and space-separated
  `allowed-tools` semantics.
- Preserve CJS constructor identity across root and subpath exports.
- Project the real `Flow.make` effects contract and retain conservative schema
  references for unprojectable object members.
- Keep Agent Skills tool preapproval separate from authority, disclose skill
  resource roots on activation, and sanitize frontmatter to serializable JSON.
- Cover registry loading with an unmodified, provenance-pinned Agent Skills
  fixture from Anthropic.
- Replaced the module headers' links into a `docs/specs` tree this repository
  does not have with the package's own published contract.
