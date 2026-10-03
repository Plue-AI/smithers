# Changelog

## [Unreleased]

### Removed

- Removed the object-form `Flow.make(options)` and `Flow.MakeOptions` under
  [RELEASE_SUPPORT.md (MVP compatibility changes)](../../../../RELEASE_SUPPORT.md#mvp-compatibility-changes).
  Replace executable declarations with `Flow.make("tag", { payload, success, body })`
  from `@smthrs/flow`. For host handlers, pass a plain `FlowBinding` record with
  `name`, `input`, `output`, `capabilities` and `effects`. `Flow.isFlow` and
  `Flow.TypeId` remain available for retained Markdown metadata signatures.

- Removed `Flow.withCapabilities`, `Flow.sealed` and `Flow.annotateMerge` from
  core's deprecated object-form flow API. Nothing outside this package called
  them. Declare capabilities and effects on the flow itself, or use
  `@smthrs/flow`'s tag-first `Flow.make` with its `annotate` and
  `annotateMerge` methods.

### Added

- Added `Graph.maximumGraphNodes`, `Graph.maximumGraphEdges`,
  `Graph.maximumGraphConflicts`, and `Graph.maximumPayloadMembers`, the width
  bounds `Graph.build` enforces alongside its depth bounds, and the
  `plan_too_large` and `payload_too_large` diagnostics they throw.
- Added `Graph.maximumEffectPaths` and `Graph.maximumPlanEffectPaths`, the
  bounds on the read and write paths one effect declaration may list and on
  the paths admitted across a plan. `Graph.build` refuses either with
  `plan_too_large` naming the node before it copies a path and before the
  write-conflict pass runs.
- Added `Graph.maximumEffectPathLength` and `Graph.maximumEffectGlobs`, the
  bounds on the length of one effect path (4096 code units, `PATH_MAX`) and on
  the patterns one read or write list may carry (128). `Graph.build` refuses
  either with `plan_too_large` naming the node, or `payload_too_large` for a
  flow placed inside a plan value, reading only the path's length or last
  character, so every per-character cost of a build is bounded by the two
  limits together with `Graph.maximumPlanEffectPaths`.
- Added `Markdown.validateSkillFrontmatter` and the `Markdown.SkillFrontmatter`
  shape, so a caller holding already-parsed frontmatter can apply the Agent
  Skills rules without a document, and the `skill_invalid_name`,
  `skill_invalid_description`, `skill_invalid_allowed_tools`,
  `skill_invalid_compatibility`, `skill_invalid_metadata`, and
  `skill_invalid_license` error codes.

### Fixed

- Fixed `Markdown.parseSkill`, which accepted documents the Agent Skills
  specification forbids: any non-empty `name`, a `description` of any length,
  and a sequence-valued `allowed-tools`. It now enforces the specification's
  name grammar and 64-character limit, the 1024-character description limit
  counted in code points, a scalar `allowed-tools`, and the optional
  `license`, `compatibility`, and `metadata` shapes, each with its own stable
  code. A sequence-valued `allowed-tools` now fails with
  `skill_invalid_allowed_tools` instead of being lowered.
- Fixed `Graph.build`, which bounded depth but not width, so a shallow plan of
  a few thousand siblings, or one plan value holding an enormous array, could
  exhaust CPU or memory before any documented limit applied. Node, edge,
  conflict, and reflected-member counts are now refused at fixed limits before
  allocation, the write-conflict pass indexes literal writers by path instead
  of comparing every pair, and reachability walks an adjacency index instead
  of every recorded edge.
- Fixed `Effects.overlaps` and `Effects.narrow`, which compared every path of
  one declaration against every path of the other, so two writers naming the
  same twenty thousand files kept `Graph.build` busy for minutes with no limit
  reached. Both now index exact paths in a set and find the paths a glob
  covers by binary search over the sorted declaration, and `Graph.build`
  bounds the paths it admits. A flow placed inside a plan value now charges
  its effect paths to the member budget instead of copying them unbounded.
- Fixed `Effects.overlaps`, `Effects.narrow`, and the write-conflict pass,
  whose cost inside the limits still grew with the product of two
  declarations when their patterns nested, because every candidate under a
  pattern's prefix was compared as a string and rescanned for a dot segment:
  two writers of 1024 nested patterns took a second to compare and 16 of them
  minutes to build. Paths are now indexed once per comparison, each scanned
  once for a dot segment and located by rank, nested patterns collapse into
  the outermost, and every match is an integer comparison, so the same pair
  compares in milliseconds and 16 writers of the widest nested declaration
  the limits admit build in well under a second. An envelope is prepared once
  for every node it encloses instead of being re-sorted per node, so a wide
  envelope of long paths narrowed by thousands of nodes builds in under a
  second instead of several. Reachability in the conflict pass is answered
  from a transitive closure computed once, and a graph's conflict and
  diagnostic path lists are frozen in place instead of through allocated
  property descriptors, so the widest shared-literal conflict set the limits
  admit builds in about two seconds instead of eight.

## [1.0.0-rc.0] - 2026-08-31

### Added

- Added the Schema-first `Flow` and pipeable `Node` builders, placement and
  effect annotations, markdown lowering, graph introspection, and digest-free
  key-material handoff.
- Added `Node.priority` and the `Annotations.Priority` key, carried onto the
  graph node and inherited lexically. Priority stays out of key material.
- Added `Node.catch`, which recovers a node's typed failures with a statically
  planned arm, and `Node.fail`, which re-raises from one.
- Added `Node.capture`, which folds the inert values a plan-time function closes
  over into deterministic, cross-process function identity. Unannotated
  functions keep process-local identity.
- Added `Flow.annotate`, which attaches one typed annotation to a flow, and
  `Flow.withFlows`, which replaces the collaborators a flow declares.
- Added the `Digest` module: the synchronous, SHA-256-only `Crypto` service,
  its layer, `runSync`, `digest`, and `canonical`, delegating to
  `@smthrs/crypto`'s `digestSync` and `syncCrypto` and `@smthrs/canonical`'s
  `Canonical` after `@smthrs/keys/Digest` was deleted.
- Added `Graph.maximumGraphDepth` and `Graph.maximumPayloadDepth`, the
  documented bounds `Graph.build` enforces instead of overflowing the host
  stack, and `Graph.isFatalDiagnostic`, which reports whether a diagnostic
  blocks `Graph.keyMaterial`.
- Added the `capability_outside_grant`, `duplicate_node_id`, `invalid_node`,
  `plan_too_deep`, and `payload_too_deep` graph diagnostics, and the
  `unrepresentable_value` node build error.
- Added `model`, `flows`, and `prompt` to the `Flow` value, so a flow declaring
  collaborators alongside a body reports them and `Flow.withFlows` can rewrite
  them.
- Exported `Flow.MakeOptions` and `Graph.EdgeReason`, so a consumer can name
  what `Flow.make` and `Flow.agent` accept, and why one node depends on
  another, without reaching for `Parameters<typeof Flow.make>[0]`.
- Added `TestRuntime`, a pure evaluator for the deferred callbacks in in-memory
  Node declarations. It resolves execution leaves explicitly and can inline
  called flow bodies without pretending to model durable host behavior.

### Fixed

- Replaced the provisional `skill_parser_not_implemented` failure with complete
  Agent Skills YAML parsing. Callers now receive the stable
  `skill_missing_frontmatter`, `skill_invalid_frontmatter`,
  `skill_missing_name`, and `skill_missing_description` error codes.
- Made the plan-value projection injective. A `Date`, `Map`, `Set`, typed array,
  `RegExp`, or `Error` used to reflect to `{}`, every function to one constant
  tag, and two distinct symbols to the same value, so behaviorally different
  plans shared one content step key. Encoder tags are no longer forgeable from a
  user literal, own `__proto__` data properties survive, accessors are recorded
  rather than invoked, and a value the projection cannot represent is refused
  instead of collapsed.
- Fixed `Node.capture` of an already-captured function, which discarded the
  inner source and captures and produced one digest for every nesting.
- Fixed `Node.all`, which silently dropped a member named `__proto__`, deleting
  an executable branch with no error.
- Fixed `Effects.covers` for the universal `**` glob, which matched nothing and
  therefore turned an "anywhere" envelope into a spurious
  `effect_outside_envelope` diagnostic on every child step. A path containing a
  `.` or `..` segment is now never covered, so a declaration can no longer
  escape its own envelope.
- Fixed `Node.withEffects` on non-work nodes: the declaration was checked and
  projected, then dropped from key material, so two nodes with opposite
  declarations were byte-identical.
- Fixed `Flow.make`, which discarded `model`, `flows`, and `prompt` whenever
  `body` was present, making every `flows:` declaration in `@smthrs/patterns`
  dead configuration and `Flow.withFlows` a no-op on body flows.
- Fixed `Flow.make` capability normalization, which disagreed with
  `Flow.withCapabilities`, and the unnamed-flow `name` property, which was an
  own enumerable `undefined`.
- Fixed `Graph.keyMaterial`, which compiled step keys for a graph the builder
  had already recorded as invalid. Fatal diagnostics now block key material and
  are returned unchanged.
- Fixed `Node.all` member ordering, which leaked a record literal's insertion
  order into content step keys, and `schemaIdentity`, which collapsed branded
  and annotated schemas onto one empty JSON Schema document.
- Fixed silent capability attenuation: a capability a callee declares and its
  caller does not grant now records a `capability_outside_grant` diagnostic, and
  a flow called from a bare-node root keeps the capabilities it declares.
- Fixed envelope-narrowing diagnostics, which omitted the `nodeId` their own
  schema provides.
- Fixed `Markdown.parseSkill`, whose `extra` record could have its prototype
  replaced by a `__proto__` frontmatter key, and whose invalid-frontmatter
  message echoed the offending source line into a public error.
- Fixed `Markdown.lowerMarkdown`, which fabricated an empty hermetic envelope
  for a markdown flow that declared none, so the lowered flow stopped
  inheriting its caller's envelope.
- Replaced raw host `TypeError`s with package-shaped failures for a
  non-function passed to `Node.capture` and a malformed AST passed to
  `Graph.build`, and replaced the host stack overflow on a deep plan with coded
  `plan_too_deep` and `payload_too_deep` diagnostics.
- Detected colliding structural node ids, which previously dropped a node's key
  material without a word, as a `duplicate_node_id` diagnostic.

### Changed

- Bumped graph key material to `flows/key-material/v2` and captured-function
  identity to `sha256-source-captures/v4`, so the hardened reflection and
  capture encodings can never alias keys produced by their predecessors.
- Graph identity now has explicit encodings for `Option`, `Result`, `Chunk`,
  and `URL` values while continuing to reject unsupported class instances.

- A built graph is now deeply frozen, so `Graph.nodes`, `Graph.edges`,
  `Graph.conflicts`, and `Graph.diagnostics` can no longer be used to edit the
  plan being observed.
