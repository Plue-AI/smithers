# Public API review for the next 1.0 release candidate

Review inputs are the actual owning-compiler declarations, public export maps, installed consumers, and source history. Declaration hashes are a drift alarm, not a compatibility verdict. The baseline must be recorded only after the final candidate checks pass.

## Consumer migrations

- Custom `ControlRuntime` implementations need `queryPlans`. Custom kernel `GrantStore` implementations need a conservative policy snapshot. Descriptor-relative filesystem executors need `resolve` and the supported atomic batch variants.
- Custom `DurableEngineState` implementations must return the deferred digest in both completed/existing outcomes, return a boolean from `consumeDeferred`, and return completed clock rows from `completeRunClocks`.
- Exhaustive matches must handle new plans, USD guard sources, unavailable approvals, capabilities identity conflicts, and open network posture. Optional fields preserve old inputs; additional union members can still require source changes.
- App flows default-export canonical `Flow.make(tag, options)` from `@smthrs/flow`. The source migration removes `defineFlow`, `FlowSpec`, and `AnyFlowSpec`; `materializeFlow` receives the canonical flow and optional implementation layer and returns `flow` plus `layer`. Prompt flows inherit agent host defaults. The deprecated `@smthrs/core` adapter retains its callable signature and lowers to that same flow model.
- CLI host configuration adds optional database locations, replay-only composition, and sandbox providers. A requested provider must honor network and resource limits; missing support refuses admission. New history fork/verify helpers use isolated copied stores. `Run.Fork` and `Run.Verify` require an operator credential; callers must handle `Unauthorized`. Stopped trace milestones add the `muted` tone.
- CLI argument parsing adds transport metadata to its result while accepting the old `Globals` input. History fork options add step-result and input overrides; each edited input needs its own approved plan.
- `RuntimeOptions.privilegedJj` is optional. Hosts supplying a guarded action repository can provide the engine its separate bookkeeping repository; omission preserves ambient composition. The CLI now enforces declared action capabilities for repository, process, filesystem, and network access; bookkeeping snapshots remain host-only. This option is host configuration and does not enlarge flow payload authority.
- `Burndown.RoundOptions` adds a defaulted sixth generic for the landing result. `detail(output, landing)` receives that result, or `undefined` without a land operation, and `release` receives the final `detail`. Existing five-generic declarations and one-argument callbacks still typecheck. Direct callback invocations must supply the second argument; direct release invocations must supply `detail`. Return a revision from `land` when a receipt needs it, and handle an absent landing.

## Explicit public additions

The review admits `Scorers`, `ReplayOnly`, `DeferredClockFold`, `StepCacheFold`, `Deadline`, `Consensus`, `SqlConsensus`, kernel and platform process confinement, `ProcessSandbox`, `RunHistory`, and the upstream `Burndown` pattern. Existing conditional export mappings are retained. These helpers compose the current runtime; they do not grant claims, credentials, or history-write authority.

Module display documents remain optional and do not replace real payload schema/refinement admission. Typed prompt components retain concrete prop checks; dynamically compiled MDX is not automatic TypeScript prop-safety evidence. Scorer launch, transport, timeout, and malformed-output failures remain inconclusive.

## Private Effect adapters and compiler environment

The eight distribution owners ship their exact platform adapter closure privately. Published adapter resolver edges are removed, ordinary runtime dependencies remain exact, and one external Effect core remains the identity shared by first-party packages. Both ESM and CommonJS declaration branches are inventoried. The copied CommonJS `NodeWS` namespace uses an equivalent namespace import and named export to support the upstream `ws` export-assignment type. Runtime JavaScript is unchanged by that declaration correction.

The existing runtime floor is Node 26.4. Strict installed consumers use modern `Node20`/`NodeNext` interoperation, both `.mts` and `.cts`, with the actual installed Node ambient types and without `skipLibCheck`. Node16 compiler mode models older module interoperation and rejects the synchronous CommonJS-to-ESM loading required here; its retained failure is not a supported-runtime qualification. TypeScript documents this distinction in its [module reference](https://www.typescriptlang.org/docs/handbook/modules/reference).

## Evidence limits

The retained prior archive authenticates 181 baseline declaration texts. Seven prior registry/create-app texts do not match the baseline and are excluded. Other historical comparisons use actual current declarations and recorded owning source history; no missing old declaration text is invented.

Process confinement evidence executes the available macOS native path. Linux/Docker argument rendering and explicit `layerNoop`/`unavailable: unconfined` opt-outs do not establish OS enforcement. These declaration/build/installed-consumer checks do not publish packages, certify all native platforms, or establish a hosted Cloud release. Whole package coverage and unrelated release evidence remain separate gates.

Candidate `be30bf194f60d78b1d2999986638e02aa4b8b94f` produced 2,418 actual declaration files across 50 public packages, including 848 private adapter declarations. All 50 owning declaration compilers and all 50 complete JavaScript/CommonJS builds and packs passed; 46 packages form the mandatory CLI closure. The canonical declaration surface exactly matches the complete builds. Fresh CLI-only npm and pnpm installs passed installed MCP initialization and strict `.mts`/`.cts` checks in both modern compiler modes, each with one physical Effect core. No consumer pins or overrides were added.

Compiler identities, artifact hashes, semantic review receipts, the explicit baseline update, and the subsequent unchanged gate result are retained with the issue receipts.

The incoming main checkpoint `8820709eb8d8ef81c21d1c1c31f02a9348edaa68` adds a string `DuplicateImplementation.message` getter while preserving its existing wire field. A Burndown child whose work interrupts now settles its own item as failed with `work: interrupted`; cancellation of the outer round still propagates and releases all claims. Their actual declarations, 79 focused cases, owning type gates, and strict public source consumer were reviewed before updating the current baseline. The 48 other public package surfaces and all 848 private adapter declarations are unchanged from the full candidate above. The current unchanged owning-compiler baseline gate passed all 50 packages.
