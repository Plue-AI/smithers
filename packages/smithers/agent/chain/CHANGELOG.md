# @smthrs/chain

## [Unreleased]

### Breaking Changes

- `MemoryEntries.make` and `MemoryEntries.layer` now take a
  `WithMemory.Policy`. A script's `remember` or `recall` bank outside the
  policy fails with `invalid_namespace` before the store runs, and every
  remembered fact records the chain, link, and call ordinal as provenance.
  Before, a model-authored script could read or write any bank the store
  reached.
- `QuickJsRunner` reads the outcome from a sealed completion value. A script
  that closes its async wrapper fails with `runtime` and
  `QuickJsRunner.escapedWrapper` instead of replacing the outcome, its
  escaped statements reach no `ctx.call` handler, and the parse check no
  longer runs authored code.
- `Chain.run` hands catalog handlers and the author context the JSON copy
  it journals, never the runner's live payload object.

- `RegistryCatalog.declarationDigest` is now `Descriptor.declarationDigest`
  re-exported from `@smthrs/registry`, the package that owns
  `FlowDescriptor`, instead of a second hand-rolled digest of the same type.
  The digest hashed ten fields with `capabilities` in declaration order; the
  shared identity hashes every top-level field except `provenance.pack`, with
  `capabilities` sorted. Two declarations that differed only in
  `modelInvocable`, `budget`, `path`, `frontmatter` or `provenance` used to
  key identically and no longer do.

  This is a journal format break: every entry digest changes value, so a
  catalog entry key recorded by an earlier version does not match the key this
  version derives. Existing journals re-key, and a markdown call replayed
  against one fails its call-time declaration check with `CallError` asking
  for a rebuilt catalog. Rebuild the catalog rather than migrating the
  recorded keys.

  `@smthrs/harness`'s `Cell.declarationDigest` is the same re-export and its
  digest value is unchanged, so one declaration is now one number on both
  sides of the boundary.

- The shared JSON boundary moved out of `ScriptRunner` into its own
  `JsonBoundary` namespace: `jsonBoundary`, `decodeOutcome`, `failureMessage`,
  `maxJsonDepth`, `maxJsonSize`, `unserializableOutcome` and `notAnOutcome`
  are now `JsonBoundary.*`. `ScriptRunner` keeps the port, its
  `ScriptFailure`, and `layerInProcess`. Behavior, values and messages are
  unchanged; only the namespace moved.

### Fixed

- The four bridge messages both runner bindings answer with were spelled out
  at every use site: `ctx.call input must be JSON-serializable` in four
  places, `the link was aborted` in three, and the call-name and
  never-settles sentences in two each. `RunnerConformance` could only catch a
  divergence after it was written. They are now `JsonBoundary.unserializableInput`,
  `JsonBoundary.abortedLink`, `JsonBoundary.missingCallName` and
  `JsonBoundary.neverSettles`, and the QuickJS prelude interpolates the two
  it needs the way it already interpolated `maxJsonDepth`. Message text is
  unchanged.

- `Authorize` derived its own resource-glob grammar: a private `literalPrefix`
  hard-coded that `*` and `?` are the only metacharacters, and a private
  `resourcesMayOverlap` decided disjointness from those prefixes, so the
  grammar lived in two packages and a metacharacter added to
  `@smthrs/capability` would have left the seam reading a glob as a literal
  and dropping a `deny`. The seam now calls `Capability.mayOverlap` and
  `Capability.isLiteralResource`; it still owns rule ORDER and no longer owns
  any part of the grammar. Verdicts are unchanged.

- `Chain.run` re-read and rescanned the whole shared journal before every
  append, then mirrored it with an argument spread, so a run cost
  O(events x journal) and threw `RangeError: Maximum call stack size
  exceeded` inside `append` once the journal passed about 120,000 events on
  Node. A run now reads the journal once at start, keeps only its own
  scope's events, and tracks the position it last observed; a stale position
  conflicts, and one fresh read decides whether a sub-chain moved the journal
  (retry at the new position) or a second writer holds this scope
  (`journal_conflict`). `Journal.layerMemory` appends in place instead of
  copying the history, and `read` hands out a copy. The port is unchanged.

## 0.1.0

The version the manifest has carried since the package moved into
`packages/`. Everything below shipped under it.

### Breaking Changes

- Renamed the package to `@smthrs/chain`, the scope every unreleased
  Smithers package carries.
- `Outcome.to` re-derives the successor's digest from its text and discards
  whatever the caller passed, and `Chain.run` journals the re-derived script.
  A script chooses the text it hands on, never the replay identity that text
  is keyed by. A caller that relied on passing a digest through unchanged now
  gets the digest of the text.
- `Catalog.withSystem` appends the system entries instead of prepending
  them, matching `RegistryCatalog.make` and `SubChains.make`. Because
  `Catalog.make` indexes last-wins, a host entry named `sys/now` or
  `sys/random` no longer shadows the journaled clock and generator that
  replay determinism rests on. The advertised order of the catalog block
  changes with it.
- Both runner bindings now put the script's OUTCOME through the same JSON
  boundary as a call payload. `done(NaN)`, `done(Infinity)`, a function or
  `undefined` property, and a `toJSON` hook were silently rewritten by the
  QuickJS binding's own `JSON.stringify` and are now a typed
  `invalid_outcome` in both runners.
- `Prompt.catalogBlock` advertises entry NAMES byte-identically or not at
  all. A name that is not already one bounded line — longer than
  `Prompt.maxEntryName` (64), carrying whitespace or a backtick, or failing
  to survive the round trip a reader makes through a rendered line — is
  omitted from the block rather than rewritten, because the model must read
  the exact string `Catalog.lookup` accepts. Descriptions are still collapsed
  to one line, stripped of backticks, and truncated at
  `Prompt.maxEntryDescription` (200): collapsing a description to one line is
  what makes a `#` or a fence inert. An entry named `-flag` still renders as
  `-flag`.

### Added

- `QuickJsRunner`: the production sealed interpreter. A fresh QuickJS-WASM
  realm per link, no host globals, `Date` and `Math.random` deleted, and
  `ctx.call` as the only bridge.
- `Authorize`: gate 4, the per-call authorization seam, with `layerRules`,
  `layerAllowAll`, and `layerNoop`.
- `SubChains`: sub-agents as one ordinary catalog entry, running a nested
  chain in the same journal under a derived child id.
- `Steering`: the root chain's inbound instruction channel, drained at a
  link and ordinal boundary and journaled.
- `MemoryEntries` and `RegistryCatalog`: durable memory and
  repository-discovered flows as catalog entries.
- `AuthorDeclaration` is exported from the barrel, and
  `Chain.authorCapability` re-exports the model seat's claim, so an operator
  can write a policy rule against it without hardcoding the string.
- `QuickJsRunner.Limits.stackBytes`, defaulting to `stackCeiling`
  (256 KiB).
- `ScriptRunner.maxJsonDepth` (128) and `ScriptRunner.maxJsonSize` (8 MiB).
- `Chain.defaultMaxLinks` (32), `Chain.defaultMaxCallsPerLink` (64), and
  `SubChains.defaultMaxDepth` (4). The budgets a caller silently inherits
  were literals buried in the implementation.
- `Prompt.renderableName`, the predicate deciding which entry names the
  catalog block can advertise verbatim.
- `QuickJsRunner.decodeCallInput` and `QuickJsRunner.dispatchBridgeCall`, the
  two host-side bridge gates, named so the suite can drive their fail-closed
  paths directly rather than only through a hardened realm.
- Package-owned documentation gates: `PACKAGE.ts` declares the standard
  targets, and `test/Docs.test.ts` is the drift check that runs under the
  `test` verb. It reads the barrel, the source constants and `package.json`,
  then asserts that `docs/api.md` carries a section and an opening bullet for
  every namespace and every runtime member, that `README.md` and
  `docs/README.md` quote the limits and the namespace count the source
  computes, that `docs/contract.md` names every error code the schemas
  declare, and that `docs/installation.md` pins the Node and Effect versions
  `package.json` pins. Member-level API drift had no gate before this.

### Fixed

- A QuickJS realm with no stack limit let deep recursion exhaust the HOST
  WebAssembly stack: `evalCode` threw an error the realm could not catch and
  disposal aborted the module, escaping `Chain.run` as an untyped defect
  that journaled nothing, so the resumed link replayed the same script and
  died the same way forever. The realm now carries a 256 KiB stack limit and
  raises its own catchable `stack overflow`; disposal is best-effort; and
  any remaining defect degrades to a journaled `runtime` script failure.
- `Authorize.layerRules` re-implemented permission evaluation with
  `Capability.subsumes`, which is documented to answer `false` for
  relationships it cannot prove. A single-`*` deny degraded to an approval
  prompt and a single-`*` allow parked forever. A claim naming one exact
  capability is now decided by `@smthrs/capability`'s own
  `Permission.evaluate`; a claim naming a set keeps the pattern path, where
  an `allow` must prove coverage and a `deny` fires unless it is provably
  disjoint.
- `ScriptRunner.jsonBoundary` validated one read of a value and then
  serialized a second, so an accessor that changed its answer between reads
  smuggled an unvalidated subtree across, and a throwing accessor, a
  throwing proxy trap, a cycle introduced on the second read, or a deeply
  nested value escaped as an untyped defect. The walk now builds the copy as
  it validates, reads every property exactly once, and refuses instead of
  throwing.
- `Chain.run` re-derived `expectedPosition` from a fresh read before every
  append, so the journal's compare-and-swap could not detect the condition
  it exists for: two concurrent runs both reported `Done`, settled one call
  ordinal twice, and journaled two `LinkEnded` events for one link. A run
  now tracks the events in its own chain scope and fails with
  `journal_conflict` when another writer advances it, while a sub-chain
  writing its own scope still appends freely.
- `Catalog.make`, `Journal.layerMemory`, and `Steering.layerMemory` retained
  the caller's array by reference. They copy it now, so a later mutation
  cannot move the advertised catalog away from the dispatched one.
- The QuickJS bridge's host-side `JSON.stringify` could throw inside a
  synchronous realm callback. It settles a refusal instead.
- The QuickJS realm's own encoder validated a value in place and then
  stringified the ORIGINAL, so the second read decided what actually
  crossed: a changing accessor, a non-enumerable `toJSON` hook, and an array
  hole all behaved differently from the in-process binding, and neither the
  depth nor the size bound applied to a production outcome. It now builds
  the same validated copy the host walk builds, and the parsed outcome
  crosses `jsonBoundary` host-side as well.
- `ScriptRunner.jsonBoundary` built its copy with plain assignment, so an own
  `__proto__` key — which any value made with `Object.create(null)` can
  carry, and which the prototype check admits by design — reached
  `Object.prototype`'s setter: the key vanished and the copy's PROTOTYPE
  became an object the walk had validated as data. Properties are defined
  now, not assigned, in both the host walk and the realm's.
- `Authorize.layerRules` applied an `ask` rule only when it could be proven
  to cover the whole of a wildcard claim, so a broad `allow` skipped a
  narrower later `ask` and the operator was never prompted. `ask` restricts
  exactly as `deny` does and now fires unless it is provably disjoint.
- `QuickJsRunner`'s defect boundary absorbed defects raised by the CALLER'S
  handler as well as the realm's own. `SubChains` deliberately turns a
  failing child run into a defect so the parent dies un-settled; under
  QuickJS that became a journaled script failure the parent authored around,
  unlike `layerInProcess`. Handler defects are re-raised unchanged.
- `jsonBoundary` returned `-0` unchanged where the QuickJS binding, which
  encodes in-realm, hands the host `0`. JSON has no negative zero, so it now
  crosses as `0` in both bindings.
- The QuickJS prelude resolved the boundary's intrinsics from mutable realm
  globals at call time, so a script could reassign one and rewrite what the
  boundary accepts: `Number.isFinite = () => true; return done(NaN)`
  journaled `Done(null)` in production while every in-process test reported
  `invalid_outcome`. The prelude now captures the `Object`, `Array`,
  `Number`, and `JSON` operations it uses, plus the error and promise
  constructors, into its closure before the script body runs, and walks its
  own arrays by index rather than through `Array.prototype`.
- `Authorize.layerRules` let a later, narrower `ask` erase a `deny` that
  still covered the rest of a wildcard claim: `[deny fs:read:secret/**,
  ask fs:read:secret/public]` answered `approval_required` for the claim
  `fs:read:secret/**`, although `Permission.evaluate` denies the member
  `secret/private`. A rule that provably covers the whole claim is still
  last-match-wins; a `deny` or `ask` that may cover only part of it can now
  only RAISE the verdict.
- `QuickJsRunner` invoked the caller's handler outside the effect its
  handler-defect guard wraps, so a handler that threw BEFORE returning its
  `Effect` became a typed `runtime` script failure under QuickJS and a defect
  under `layerInProcess`. The invocation is suspended into the guarded effect
  now, and both bindings let the caller's defect kill the run.
- `Catalog.make` froze the entries array but retained the caller's entry
  OBJECTS, so renaming one after construction still split the advertised
  catalog from the dispatched one: the block advertised the new name,
  `lookup` still answered to the old one, and neither matched. The
  declaration fields are copied and frozen now — including `capabilities` —
  while the handler stays by reference.
- Capturing the QuickJS boundary's intrinsics was not enough on its own,
  because the realm's PROTOTYPES stayed writable and `JSON.stringify` reads
  an inherited `toJSON`. The realm validated a value and then serialized
  whatever a script-installed hook returned instead:
  `Object.prototype.toJSON = () => ({ forged: true })` made a handler
  receive `{ forged: true }` in place of the payload the boundary had
  approved, and `Array.prototype.toJSON = () => "FORGED"` journaled
  `done([1, 2, 3])` as `Done("FORGED")` — laundering the in-process binding
  refuses, since it never stringifies. Every container the in-realm copy is
  built from now carries no prototype, so there is no `toJSON` to find.
- `Prompt.catalogBlock` advertised an entry named `—` as `- — — description`,
  whose first separator falls before the name rather than after it, because
  the bullet contributes a space of its own. A reader splitting that line
  recovers the empty string and calls something the catalog does not carry.
  `Prompt.renderableName` now checks that round trip against the renderer
  itself rather than against a hand-derived character rule, so the one name
  the separator swallows is omitted while a name that merely contains an em
  dash, like `flows—build`, still renders.

### Changed

- Promoted the package out of `apps/mvp/vendor/smthrs/chain` into
  `packages/chain` as a first-class workspace member: real workspace
  dependency specifiers in place of the vendored `file:` and `*` references,
  `effect` moved from `4.0.0-beta.102` to the workspace pin `4.0.0-rc.108`,
  and the sibling `tsconfig.json`, `tsconfig.test.json`, `eslint.config.js`,
  `dprint.json`, `vitest.config.ts`, and build scripts restored.
- Rewrote the import specifiers `smthrs/capability` used to carry to the
  scoped `@smthrs/capability`.
- The package owns its documentation. `docs/api.md` and `docs/contract.md`
  replace the `docs/specs/Concepts/` directory that nineteen modules cited
  as their governing design and that never came across with the package;
  `test/Docs.test.ts` fails when a namespace, a default, or a citation
  drifts from them.
- `ScriptRunner.layerInProcess` is documented as providing NO isolation. It
  builds the script body in global scope, where `globalThis`, `process`, and
  dynamic `import()` are reachable; `QuickJsRunner.layer()` is the only
  sandbox for model-authored scripts.
- `Chain.Options.envelope` is documented as what it is: opaque run identity
  pinned into `ChainStarted` and compared on resume, journaled verbatim and
  never a policy input.

## 0.0.0

- Initial slice: journal event vocabulary, call keys, trampoline outcomes,
  in-memory journal, catalog, mock author seat, in-process script runner,
  and the chain trampoline with gates 1–3 and prefix replay.
