# @smthrs/capability

## Unreleased

- **Security.** An `fs:*` capability whose absolute resource has a `.` or
  `..` segment, or whose relative resource climbs above its start, is matched
  by no pattern, `Permission.evaluate` returns `deny` for it, and `subsumes`
  never proves such a filesystem pattern covered, so an adapter that skips
  canonicalization cannot turn `/w/**` into `/w/../etc/passwd`. A relative
  declared scope (`.`, `./src`, `src/a/../b`) still matches, but only when the
  pattern selects its lexical normal form as well as its text.
  `tierOf` classifies an `fs:write` to a drive-lettered, backslash-bearing, or
  `~`-leading resource as `irreversible`.
- Added `Capability.mayOverlap`, the conservative converse of `subsumes`: it
  answers `false` only when two patterns are PROVABLY disjoint, so a caller
  deciding whether a `deny` rule still applies keeps the restriction for any
  relationship the grammar cannot settle. Added `Capability.isLiteralResource`
  so callers ask the grammar whether a resource carries a metacharacter
  instead of scanning for `*` and `?` themselves. `@smthrs/chain`'s
  authorization seam had both rules copied locally.
- Fixed permission-error boundary validation to reject optional accessors and
  inherited fields, and inspect metadata descriptors at every depth without
  invoking getters. Cyclic metadata is rejected; shared JSON references remain
  valid. Schema-identified grant-store errors retain their default empty message.
- **Breaking.** `isPermissionError` and `fromPlatformError` now return the
  data-only `PermissionErrorPayload` type. `formatError` accepts that payload.
  Added `decodePermissionError` to construct yieldable error instances explicitly.
  Kernel HTTP recovery uses the same payload type.
- Corrected recovery documentation: valid foreign causes are accepted by
  structure and reason tag. Producer or request identity requires a separate
  check across a trust boundary.

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added `Capability.parsePattern`, the inverse of `Capability.format` for a
  pattern. Every consumer that needed one previously hand-rolled it, and the
  three hand-rolled readers disagreed on the whole-authority pattern `*:**`.
- Added `Capability.patternFromCapability`, which derives the exact grant for a
  capability and returns `Option.none()` when the resource contains a glob
  metacharacter the grammar cannot express exactly.
- Added `Capability.maxResourceLength` as the shared bound on exact and pattern
  resources and `Capability.maxMatchWork` as the defensive matcher work budget.
- Added `Capability.withinMatchBudget`, which reports whether the matcher can
  decide a pattern and exact capability within `Capability.maxMatchWork`.
- Exported the schema values `Capability.Action`, `Capability.PatternAction`,
  `Capability.EffectTier`, `Permission.RuleEffect`, and `Permission.PermissionError`
  beside the existing type names, so a consumer can validate a bare selector,
  tier, or failure at an RPC, config, or persistence boundary.
- Added `Permission.maxDisplayFieldLength` and package-owned documentation under
  `docs/`, generated into the published API page.

### Changed

- **Breaking.** Renamed the `Rule` schema id from
  `@smthrs/capability/Permission/Rule` to `@smthrs/capability/Rule`, so every id
  in the package is flat under the package name. Schema ids are digested into
  step keys, so this changes recorded keys.
- **Breaking.** `Permission.PermissionRequired.meta` is a JSON record rather than
  an unbounded unknown record. A value the grant journal cannot encode now fails
  at the construction site with a decode error naming the key, instead of
  throwing later at the persistence boundary. The snapshot is deep and frozen,
  so the caller's object is no longer shared with a parked approval.
- **Breaking.** `Capability.format` accepts only a record whose action is an
  `Action` or a `PatternAction` and throws on anything else. Two structurally
  different records could otherwise render one durable identity, and that string
  is the identity a grant envelope is deduplicated and sorted by. The bytes of
  every valid value are unchanged.
- **Breaking.** Removed the Windows path accommodation. Windows is Unsupported
  in the frozen rc.0 release policy, and matching is now byte-exact over
  UTF-16 code units with no separator normalization and no case folding. A
  stored grant relying on either behavior no longer matches. This closes four
  widenings. On Linux and macOS, where `\` is a legal filename character, 0.1.0
  rewrote it unconditionally, so a `fs:write:/workspace/**` grant authorized the
  real path `/tmp/x\..\..\workspace\y` and `tierOf` reported that write
  `compensable`, undoable from a snapshot it was not in. Narrowing the rewrite
  to drive-shaped strings left three more: a drive-shaped requested resource
  whose backslashes were rewritten could still escape its granted subtree;
  `patternFromCapability` was not exact for a drive-shaped resource; and a
  drive-shaped `workspaceRoot` made `tierOf` fold case.
- **Breaking.** `Capability` and `CapabilityPattern` reject a resource longer
  than `Capability.maxResourceLength`, which 0.1.0 accepted. Adapters must
  reject or summarize a larger host value before authorization.
- Replaced the backtracking RegExp compilation with a linear-scan iterative glob
  matcher. A pattern such as `a*a*a*a*b` against a long non-matching resource
  made the old compilation exponential on the authorization path.
- Folded the former `formatPattern` into `format`. The two had byte-identical
  bodies over structurally identical records, and a third inline copy in
  `@smthrs/kernel` was the one writing patterns into durable journal payloads.

### Fixed

- `Permission.evaluate` returns `deny` when a rule cannot be matched within
  `Capability.maxMatchWork`. Previously the rule was skipped, so an over-budget
  deny fell through to a later allow.
- `Capability.patternFromCapability` returns `Option.none()` for a resource
  longer than `Capability.maxResourceLength` instead of throwing.
- `Permission.PermissionRequired.meta` accepts and drops undefined-valued object
  properties before validating the JSON snapshot. The kernel's `proc:spawn`
  path passes `{ cwd: undefined }` for the common command with no explicit
  working directory, which previously failed construction with a schema error.
- Permission errors no longer retain the caller's `Capability` instance.
  `PermissionRequired.capability`, `PermissionDenied.capability`, and
  `PermissionRequired.meta` are non-writable data slots; the copied
  capability's action and resource are non-writable too, so a parked approval
  cannot be mutated into a different or unencodable request.
- `Permission.isPermissionError` now validates `PermissionRequired.runId` and
  `meta` as well as the exact enumerable structural shape. Missing, excess,
  overlong, or accessor-backed fields are no longer refined and unwrapped by
  `fromPlatformError`.
- Cyclic permission metadata now reaches the JSON schema refusal instead of
  overflowing during undefined-property normalization.
- `Permission.formatError` escapes C0 and C1 controls and caps each field. It is
  documented as a one-line renderer, and an agent-chosen resource containing a
  newline used to add lines a log reader could not distinguish from real ones.
- Documented the glob grammar, the `?` wildcard, the absence of an escape, the
  matcher's cost bound, `tierOf`'s lexical containment and symlink precondition,
  and the fail-closed `workspaceRoot` on the exported symbols rather than in
  test comments. The API page no longer documents a `formatPattern` export that
  does not exist.

## 0.1.0

- Extracted `Capability` and `Permission` from `@smthrs/kernel` into a leaf
  package so a protected Host service (`@smthrs/jj`) can name the permission
  failures its guarded interface declares without depending on the kernel that
  guards it.
- Added `Permission.PermissionError`, `Permission.toPlatformError`, and
  `Permission.fromPlatformError` for the Effect-owned services whose tags fix
  their error channel to `PlatformError`.
