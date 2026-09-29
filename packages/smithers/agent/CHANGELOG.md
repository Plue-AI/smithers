# @smthrs/agent

## [Unreleased]

### Added

- Budgets accept `onExceeded: "park"`. Hosts provide `Budget.Parking` to
  request approval; `Budget.raise` and `raisedBy` apply approved ceilings.
  Exhaustive `OnExceeded` matches must handle `park` (#1843).

- `AgentAction.Host.serverTools` and `Agent.Options.serverTools`: provider-run
  tools, such as the provider's web search, forwarded to every frame.

### Changed

- **Breaking:** `Seat.auto` routes by the maintainer's routing graph. Jev
  answers phase, size, clarity and binary success (plus the variant) in one
  call, and `SeatRouter.plan`, `backupsOf` and `fit` pick the seat, its
  backups and, for important plans and reviews, an Opus/Fable/Astra panel
  merged by Fable. `SeatRouter.Service.candidates` is now the available seat
  ids; `SeatRouter.Candidate`, `seatInstructions`, `maxCandidates`,
  `State.parent`, the `only` decision and `too_many_candidates` are removed.
  `Decision` records `answers`, `backups` and `panel`; `SeatRouted` gains
  optional `backups` and `panel`. `route` takes `panel: false` for a caller
  that does not fan out, which `AgentSession` passes. `AgentAction` takes an
  optional `phase`, runs a panel's members in parallel and then the merger on
  the survivors' answers (`SeatRouter.mergePrompt`), and fails over along the
  route's backups. `fit` gives panel members that land on one seat the union
  of their backups, less the seats on the panel, and a panel reduced to one
  member is that member's chain. One member's quota park still suspends the whole
  execution, so its siblings wait for that reset.
- The recorded `agent/route-seat` decision moved with `DecisionSchema`, which
  its key folds in. A run recorded before this change asks Jev again when it
  resumes and may route to a different seat.
- `AgentAction`'s recorded quota park is named per session
  (`agent/quota-park/<session>`), so parallel panel members park independently.
  A run parked before this change classifies its refusal again when it resumes.
- The sealed model step key moved to `key1_71b2f391…` because
  `@smthrs/capability`'s `Action` union gained `memory:read` and
  `memory:write`. Runs recorded under the old key re-dispatch their model calls.
- The sealed model step key moved to `key1_674672c5…` because
  `ModelEvent.Settle` gained `sessionId`, which `RecordedModelStep` embeds.
  Runs recorded under the old key re-dispatch their model calls.
- The sealed model step key moved to `key1_15a4c259…` because
  `ModelErrorCode` gained `out_of_credit`, which the step's error schema
  embeds. Runs recorded under the old key re-dispatch their model calls.

### Fixed

- A latency budget's clock starts at the run's first budget decision again.
  The resume an engine port records when it is built had started it, so setup
  before the first model call was charged to the allowance.

- Workspace observation can omit exact host-owned paths without hiding other
  files with the same basename. The TUI excludes its session subtree and log
  from mutation accounting ([#2009](https://github.com/smithersai/smithers/issues/2009)).

- Ordered fallback seats now try the next model after context overflow or HTTP
  5xx failure without inventing a quota park ([#1797](https://github.com/smithersai/smithers/issues/1797)).

- `AgentAction.Host.approvalChannel` forwards the attended-host setting into
  agent steps. TUI and served hosts arm it; unattended hosts default to false
  ([#1784](https://github.com/smithersai/smithers/issues/1784)).

- A run the engine re-drives for a host that died mid-run is claimed in the
  control plane before it executes, so its status writes are its own instead
  of failing `ClaimLost`.

### Added

- Agent actions and markdown flows accept an ordered model list. The first seat
  is primary; the remaining seats are fallbacks, preserved through durable
  invocation and replay ([#1796](https://github.com/smithersai/smithers/issues/1796)).

- `control.agent.model-requested` and `control.agent.decision-settled`: the
  request a model call was asked and the decision a classifier made, journaled
  with the `scope` and `frame` that join each to its turn.
  `GenerationParams.maxTokens` is written as `maxOutput`, because the journal
  redacts a key ending in `token`. On a module step both are step facts,
  committed inside the step's own boundary. The executor writes them without
  advancing the frame ordinal, so a run journaled before they existed still
  deduplicates its prefix when resumed.
- A `model-requested` record holds what its call added to the previous record
  of the same `scope` and `purpose`: `prefixCount` and `prefixDigest` name the
  leading messages the two share, `messages` is the rest, and `system` is
  written only where `systemDigest` moved. A hundred-frame run journaled its
  system teaching a hundred times and its transcript quadratically, and once
  the transcript passed one field's bound every later call was unreadable; the
  trail now grows with the transcript, and a reader rebuilds a call by walking
  back until `prefixCount` is `0`. `AgentSession.tracer()` is the fold that
  keeps the previous record's digests, one per incarnation, and
  `AgentSession.trace(event, previous?)` stays pure. `AgentSession.RequestTrail`
  is what it keeps.
- Each rebuildable field travels with its pre-journal digest (`systemDigest`,
  `messagesDigest`, `paramsDigest`, `stateDigest`, `questionsDigest`,
  `answersDigest`). The journal's redaction rewrites text that only looks like
  a credential (`maxTokens: 4096`, `secret = hunter2`) and marks nothing, so a
  reader re-digests what it read and treats a mismatch as "redacted, not
  re-askable", the way it treats `truncated`.
- Bounds: `system`, `params`, `state`, `questions` and `answers` are each
  bounded by `AgentSession.maxTracedBytes`; the messages of one record share
  one such bound and each is replaced by its own marker past it. A record with
  any marker carries `truncated: true` so a reader reports it unavailable
  rather than rebuilding it from what fit.
- `decision-settled` writes `questions`, `answers`, a choice question's
  `criteria` and an answer's `probabilities` as arrays of entries (`{ id, ... }`,
  `{ option, description }`, `{ option, p }`). They were records keyed by names
  the classifier's author chose, and the journal replaces the value under a key
  such as `auth` or `session`.
- `FlowEngineLike` implements `EngineLike.resolve` from the credential-free
  prepared request, and `Agent` wraps it so the recorded request is the one its
  `cellModelRequest` plugins rewrote. The waterfall's exit is held per request,
  its failure included, so each plugin runs once per model call on success and
  on failure. A waterfall that fails, or a request no route accepts, resolves
  to none: no `model-requested` is written and the sealed step reports the held
  failure, so no record presents a request that was never sent.

- `ScriptedJudge.layer` is an explicit completion-only offline fixture that
  compares command claims with recorded evidence and refuses other questions.
  Whole-host scripts must dispatch all their classifier question IDs; see
  `flows/test/fixtures/scripted-judge.ts`.

- `StandardFlows.classify(services, options?)`: the cell's doors to Jev as the source `std/classify`, binding the ad-hoc `classify` flow and one `classify/<id>` flow per curated classifier (the three from `@smthrs/std` by default) over the `Evaluator` service. An explicit classifier outage fixture binds `Evaluator.layerUnavailable()` and every call resolves `{ ok: false, error: { code: "flow_failed", message } }` with a message containing `unreachable:` after the binding's `Flow classify failed:` prefix.

- `StandardFlows.memory(services, scope?)` and `StandardFlows.MemoryScope`
  (#1700, in part). With a scope, `remember` and `recall` are bound through
  `WithMemory.withMemory` and `Flows.handlersFor`: a bank outside
  `scope.policy.namespace` fails with `invalid_namespace` before any I/O, a
  recall naming no bank reads the policy namespace, and `recall: "none"` and
  `retain: "never"` behave as `@smthrs/memory` defines them. `scope.provenance`
  is recorded on remembered facts. The policy and provenance are the bindings'
  declaration identity, so a sealed recall recorded under one scope or run is
  never replayed into another. An invalid policy binds nothing and fails
  catalog composition with `assembly_failed`. Without a scope, the binding is
  unchanged.

### Changed

- `control.agent.vacuous-verification-observed` now projects `callDigest` where
  it projected `signature`. The journal's redactor treats `signature` as a
  sensitive field name, so the identity the row is reconciled against its
  `cell-call-settled` record by was written as `[REDACTED]`.
- **`Agent.run` and every `AgentAction` layer now require
  `Evaluator.Evaluator`** from `@smthrs/model`. The harness's sixth brake on a
  completion never falls back: a claim nothing could judge fails the run as
  `HarnessError` `completion_unjudged` rather than standing, so a host that
  binds no transport does not compile instead of quietly losing the brake.
  Bind `Evaluator.layerFromEnvironment(process.env, "my host")` before opening
  resources, or deliberately bind an evidence-based scripted judge. A host
  missing `AI_GATEWAY_API_KEY` now fails to boot instead of every completion. `Agent.layerDefaults` is unchanged and
  still supplies only the sandbox and the steering source: the evaluator is a
  decision about where the host's key comes from, not a default.
- `SeatResolver.contextWindowTokensFor` now re-exports
  `ModelCatalog.contextWindowTokensFor` from `@smthrs/model`, where the provider
  window table now lives. The resolved numbers are unchanged.
- `AgentSession.trace` types every event type it journals as
  `Transcript.ControlEventType`, so the `control.agent.` namespace this package
  writes and the one `Transcript.validateJournal` reads back cannot drift apart
  without a compile error.

- Preserve the sealed cell-call key and encoded result schema from before A2
  admission hardening. Success/failure validation remains at construction and
  decoding, and the port validates host results before persistence with typed
  causes. The pre-A2 golden `key1_8ab29627...` is unchanged, with canonical
  material and SQLite reopen/resume regressions. Intermediate builds with the
  result-schema filter require finishing their runs on that build; no stored
  key or approval is rewritten.

- Approval asks now read the explicit durable `Approved` or `Denied` token
  instead of inferring a decision from grants. Pending or unreadable decisions
  fail closed; denial still returns `approved: false` to the caller.

- `AgentSession.requestCancel` now records logical-run intent atomically across
  trampoline rounds. A completed predecessor no longer makes a live successor
  look terminal. Execution observation follows the current round's lifecycle
  while preserving the requested run's identity; see the API's snapshot and
  separate-control-database limits.

- Validate every supplied usage counter before choosing or aggregating a token
  total. Negative or non-finite components cannot be hidden by a valid total or
  cancel against another attempt. `tokensOf` returns `NaN` for malformed
  components; durable accounting refuses them without poisoning the tally.
- Budget acquisition now validates and snapshots its configuration, failing with
  `Budget.ConfigurationError` for invalid ceilings, exceeded policies, or cache
  bounds. `make`, `layer`, `layerFromEnvelope`, and `AgentSession.Options.budget`
  expose that typed failure. Omit ceilings for no limit; infinity is not valid.
- Reported usage before an unsealed capacity refusal or stream interruption is
  charged under a distinct invocation receipt. It survives journal recovery
  without giving a later provider retry a paid sealed-step marker. Partial
  failed text is still discarded; cumulative counters count once per attempt.
- The model action's encoded failure contract includes infrastructure failures
  from receipt allocation and usage persistence. Corrected its stale unreleased
  golden to `key1_b5b3584a…`: review baseline `a49b68ef7d` and the release fixes
  produce byte-identical canonical preimages under Effect `4.0.0-rc.112`, with
  the cell-call golden unchanged. This is a fixture correction for the first
  release, with no runtime or schema alteration. Schema representation is key
  material, so future dependency upgrades must verify these vectors as well.

### Fixed

- A model rate limit no longer cools every model on the same account route.
  Cooldowns use route and model identity, preserve longer waits across resume,
  and honor explicit `ModelError.quotaScope`. Generic rate limits default to
  model scope; shared quota and overload retain account scope. Hosts that
  know a rate limit is shared must mark it `quotaScope: "account"` instead of relying on the previous broad default.

- A parked run is re-driven only when a resume has actually been delegated.
  Every engine round for a run parked on its own ask used to claim the park,
  replay every settled frame, and suspend on the same ask again, once per
  heartbeat, for as long as the run waited on a human. Nothing had asked for
  that resume, and the incarnation that eventually consumed the operator's
  decision could be one that had read the run's durable history before the
  operator touched it, so a check the body makes on entry (the journal format
  refusal) was made against a history the completing incarnation never saw.
  `Control.approve` records the delegation before it hands over the decision,
  and `drainPendingResumes` polls for delegations taken in another process, so
  no resume loses its host.

- An ask answered through `Control.signal` re-drives the run that asked it.
  `Control.approve` is not how a `HumanTask` or `WaitFor` park is ever
  answered: the gateway's `Approval.Submit` routes a human-wait target to
  `Control.signal` (`ControlExecutor.answerableWait`), `smithers signal` calls
  it directly, and every flow-authored ask parks on one. That path completes
  the engine's durable wait point and recorded no resume delegation, so the
  round the engine scheduled next was refused as unrequested and the run stayed
  `waiting-approval` on the question the person had just answered — a job that
  never resumed when somebody approved it. `AgentSession.deliverSignal` now
  records the delegation on every `delivered` answer, including the retry of an
  answer whose first attempt died after the completion, and the
  `ControlExecutor.deliverSignal` port takes it up in the call that answered,
  so an in-process answer does not wait for the one-second poll and an answer
  delivered in another process still reaches the host that parked the run. The
  round that takes a delegation up now clears it, so one answer buys exactly
  one re-drive and a later park is not re-driven by a standing row.

## [1.0.0-rc.0] - 2026-09-01

### Added

- Added `defaultModelRetryWindowMillis` (45,000 ms), a wall clock on the transport retry ladder. Five rungs bounds how many attempts are made, not what they cost: r92 of the SWE-bench full benchmark burned ten `transport` retries and $0.85 across two instances against a socket that stayed dead for half a minute, and each of those attempts re-sent a whole prompt and streamed a partial body before dying. The window is the declared ladder's own jittered ceiling plus a rung's headroom, so a transport that fails fast still gets all five rungs, while one whose attempts are slow stops when the window closes. Elapsed time is the schedule's own, on the injected clock.

- `AgentSession.trace` now journals `control.agent.vacuous-verification-observed` with its payload — the stored check, the flow, and the controller's identity for that call — rather than letting it fall through to an empty one. The control that emits it is unwired from `CellTurn` as of the r93 verdict, so no new run produces the row; the mapping stays so the r93 journals that carry it keep reading and so a controlled re-measure needs no change here.

- Added `StandardFlows.tests`, which binds `@smthrs/std`'s `test` flow to a
  host's `TestRunner` declaration. A tool no production composition offers is a
  tool that does not exist, which is the same reason all seven filesystem flows
  are bound rather than two.

- `StandardFlows.shell` now supplies a `Container` transport, defaulting to the
  docker/podman CLI, so `bash`'s `container` field means something in the
  production composition. Without one the field resolves `{ ok: false }` with
  "this host has no container transport", and the agent goes back to typing
  `docker exec c bash -lc '…'` itself — the quoting stack that cost the measured
  SWE-bench program twelve failed probes and one instance's most expensive frame.
  A host with a different route passes its own transport; a host with neither
  docker nor podman fails the spawn with the shell's own "not found", which is
  the honest answer.

- Journaled `control.agent.discipline-armed` once at run start with the
  read-only and frame caps and every effective sandbox limit, so a run that
  never reaches completion still proves what it armed.

- Added `Agent.Options.readOnlyCap`, armed by `AgentSession` for every task run
  (`AgentSession.Options.readOnlyCap`, default `CellTurn.defaultReadOnlyFrames`).
  It caps consecutive frames that write nothing; a run that is meant only to
  answer leaves it unset.
- Journaled `durationMillis` on `control.agent.model-settled`, the wall-clock
  duration of that one sealed model call.
- Added `Seat`: the resolved seat record, `Seat.modelIdOf`, and the typed
  `Seat.SeatUnresolved` failure. The declared half stays an unvalidated string,
  because the resolver owns the seat vocabulary.
- Added `SeatResolver`, the host seam that turns a declared seat string into a
  live model. `AgentSession` and `AgentAction` both take it as a service instead
  of a `resolveSeat` option, so a composition installs one resolver rather than
  threading a function through every entry point. The context-window catalog
  moved here as `SeatResolver.contextWindowTokensFor`.

- Placed the run's task prompt in a prefix segment so it survives every frame; it previously lived in the rebuilt tail and vanished after frame one.
- Widened the sealed step's transient retry to five one-second-doubling attempts; a destroyed HTTP/2 session outlives a half-second backoff.

- Made agent reasoning effort configurable: the flow's `effort:` frontmatter wins, then the host's `Options.reasoningEffort`, then the `high` default.

- Defaulted every executor-launched run to medium reasoning effort; an unset effort left the model with near-zero thinking budget.

- Added durable `control.agent.*` trail projections with occurrence timestamps
  and bounded failure causes for executor runs.
- Added workspace-relative file boundary conversion for cell calls.
- Added transient sealed-model retries while preserving non-retryable model
  failures.

- Added package-owned documentation: `docs/Manifest.ts`, `docs/`, and
  `scripts/docs.mjs` generate `docs/pages/api/agent.md` from the package's own
  JSDoc and prose, so the API page has one source rather than three.

### Changed

- Production `Agent.run` now reports each failed `configResolved` observer as
  one warning with only its stable code, plugin, and hook. Startup remains
  nonfatal and the observer cause is never copied into the log record.
- Renamed the cost field of the durable `flows.agent.usage.v1` payload from
  `tokens` to `spent`, and gave the payload an owning schema,
  `Budget.UsageRecord`. `@smthrs/journal`'s redactor strips one trailing plural
  and tests the suffix, so `tokens` read as a credential and the production
  `SqlJournal` persisted `"[REDACTED]"` where the number was. Every usage record
  written under a real journal therefore came back unreadable, and the old read
  side dropped it silently, so a resumed run recovered nothing and was handed
  its whole token allowance again. Records written under the old name do not
  decode; they never carried a readable number either.
- Made durable budget recovery fail closed. A `flows.agent.usage.v1` or
  `flows.agent.budget-started.v1` record that does not decode now raises
  `Budget.AccountingUnavailable` naming the entry's sequence and journal source,
  instead of contributing nothing to the ledger.
- Made the latency budget's clock zero durable. The first budget question of a
  run writes `Budget.budgetStartedEvent`, and a later incarnation recovers the
  earliest recorded zero, so a park, reclaim, or process restart no longer
  re-arms the whole `milliseconds` allowance.
- Fixed `QuotaPolicy.parseDelay` reading "retry after 5 minutes" as five
  seconds. The `retry-after` pattern made its unit optional, so a minute- or
  hour-scale wait woke sixty or thirty-six hundred times too early and burned
  every park the step was allowed.
- Fixed the bare `Retry-After` pattern reading a PREFIX of a number whose unit
  it does not know. Its trailing lookahead forbade a unit word but not a digit,
  which a shorter capture satisfies: `Retry-After: 120ms` parked for twelve
  seconds and `Retry after 12 days` for one. An unknown unit now falls back to
  `defaultWaitMillis`, which is what the module always claimed it did.
- Made `StandardFlows.clock` clamp an invalid `maxSeconds` to
  `defaultMaxWaitSeconds` instead of comparing against it. `NaN` made every
  ceiling test false and `Infinity` admitted an unbounded park, so a host could
  remove the wait bound while the documentation said hosts may only lower it.
- Bounded the remaining two trail fields at `AgentSession.maxTracedBytes`:
  `cell-call-started`'s input and `cell-call-settled`'s failure message. A
  `write` carries its whole file in the input and a test runner writes megabytes
  of message, so only the result value was actually bounded.
- Made `AgentSession.launch` carry the registry's typed failure on
  `LaunchFailed.cause` rather than its `toString`. `body_unavailable` and
  `body_unreadable` need different operator answers and a stringified cause
  offers no field to route on.
- Made `AgentSession.settlementFailure` render a non-JSON PRIMITIVE as text.
  `JSON.stringify` does not refuse `Infinity` and `NaN`, it rewrites both to
  `null`, so an arithmetic failure settled as the same recorded value as a run
  that failed with a literal `null`. The JSON round trip is now reserved for
  objects.
- Made a child start that succeeds without creating a run row a
  `ChildError { code: "failed" }`. `not_found` is the answer that tells a cell
  the flow does not exist here, and the declaration had already been found, so
  spending it on a runtime's refusal told the cell to give up on a flow it has.
- Made a latched `skip-remaining` budget report the refusal it actually latched
  on. A latency latch previously answered every later call with a fabricated
  `tokens` scope and `max: 0`.
- Added `cause` to `Budget.AccountingUnavailable`, so the journal error under an
  accounting failure keeps its tag and fields instead of being stringified.
- Taught `packages/agent/scripts/docs.mjs` to follow named re-exports. It read
  documented declarations and `export *` forms only, so
  `FlowEngineLike.defaultModelOverruns`, published with an `export { }` clause,
  had no row in the generated table. A re-exported member the target module does
  not document now fails the generator rather than disappearing from the page.
- Renamed the package from `@smthrs/engine-harness` to `@smthrs/agent`. The
  package is named for what it ships: the Smithers agent, plus the two adapters
  that run it.
- Renamed `CellHarness` to `Agent` and made it a `Context.Service`. The loop is
  reached through the `Agent` tag rather than a bare `run` export, so a future
  agent that drives a foreign CLI is another implementation of the same service.
  `Agent.layer` provides the production one, `Agent.layerNoop` a silent one, and
  `Agent.layerDefaults` the browser-safe sandbox and steering defaults the old
  `CellHarness.layer` provided.
- Renamed `HarnessExecutor` to `AgentSession`, and its durable flow id from
  `engine-harness/agent` to `agent/run`.
- Collapsed `Options.seat` / `model` / `route` / `contextWindowTokens` into one
  resolved `Seat.Seat`. There is now exactly one resolved-seat record, produced
  only by a `SeatResolver`.
- Changed the composition identity folded into every step key this package
  derives from `flows/engine-harness/composition/v1:` to
  `flows/agent/composition/v1:` (`FlowEngineLike.ts`). Every step cached under
  the old prefix therefore misses. That is intentional: pre-release identity
  strings track module paths, and the package moved.
- Changed the failure an `AgentAction` reports when the host cannot serve its
  declared seat. It is now `Seat.SeatUnresolved` rather than a `HarnessError`,
  and `AgentAction.AgentFailure` carries the new member.

### Removed

- Removed `FlowEngineLike.ChildRunner`, `FlowEngineLike.appendBatch`,
  `FlowEngineLike.Options.children`, and `FlowEngineLike.Options.plan`.
  `splice` now refuses an elaborated batch because the cell loop superseded
  the provider-tool-call path, and rc.0 does not ship API it does not support.

## [0.1.0] - 2026-08-05

### Added

- Initial release.
