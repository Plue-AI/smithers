# Agent and flow health: design and implementation contract

> Superseded in part 2026-09-27 (smithersai/smithers#2229): the local PTY sessions, their `pty.status` frames and the terminal-tab pills retired with the terminal and harness tabs; the run and flow health path below stands.

Designed with `claude-fable-5`, verified CLI session `38f2e0a0-b1cd-422f-8d26-84ecc98a2edb`, on 2026-09-13. Fable reviewed a source-grounded draft and the root agent's corrections. The design below records that review; the following implementation decisions resolve remaining contradictions and supersede corresponding suggestions in the review.

- Control/PTY lifecycle remains authority. A callback is observational and cannot approve, resume, or establish terminal success.
- An unobserved or stale nonterminal subject has unknown activity and health. Known authoritative waits and terminal states retain their meaning. Unknown exit outcome is not success; a nonzero exit is failing.
- Owner identity is an opaque incarnation fingerprint, matched against current authority, not a fabricated numeric order. Evidence and publication cursors are host-stamped. Equal-evidence ties use durable journal order, never wall-clock order.
- Quiet or chatty CLI output establishes no semantic activity. Only a configured semantic checker may report working, idle, or needs-input; idle does not necessarily mean a human owes input.
- Trusted host configuration registers TypeScript Effect callbacks. Read-only context is not a sandbox. Arbitrary synchronous CPU work cannot be forcibly interrupted by an Effect timeout.
- Local session observations also use the existing durable SQL journal. Publication follows committed evidence, with incarnation scoping preventing replay from reviving dead sessions.
- Alert delivery is enabled only when a real configured sink exists. A noop sink must not claim a dropped notification was delivered. OS push delivery remains the separate architecture in Plue's approval/notification audit.
- No additional status RPC or projection selector; optional `RunSummaryRow.statusRollup` and local PTY status snapshots/frames use existing authenticated transports. Go/Worker relays remain opaque.
- Exact compile-checked API and defaults live in `@smthrs/control/Health`; code examples below are architectural pseudocode where Effect RC APIs or types differ.

---

Accepted with corrections. The draft's spine survives: three-plus-one status axes, a pure precedence fold, Monitor reuse, additive projection, Alerts for attention. Five parts of the draft were wrong and are replaced below: probe registration moved out of flow bodies into `Application.Config`; the default CLI activity is now `unknown` (silence proves nothing, output movement proves nothing); evidence stamping moved from callback to host; the gateway surface is an additive `RunSummaryRow.statusRollup` field, not new selectors/RPCs; read-receipt states are deleted from the model. This is the implementation contract.

---

# Status & Health API — final architecture (#2)

## Corrected context

Repos: `~/smithers` (UI in `apps/app`, Worker in `apps/server`, runtime in `packages/smithers/*`) and `~/plue` (Go relay/backend). There is no flows UI app. The Go relay and Worker treat projection payloads as opaque; nothing in this change touches plue or `apps/server` beyond payloads they already pass through. `@smthrs/control/Monitor` exists but has **no production caller yet** — this change is also Monitor's first production wiring, through the shared `NativeControl.ts` gateway path (`Application.Config` → `layerControlFromEngine` capturing Control + control Journal → `layerGatewayHost` holding the Scope). `EngineJournalSupervisor` already forwards engine observations into the control journal, so the monitor reads one stream.

## Model — five distinguishable dimensions

| Dimension | Values | Authority |
|---|---|---|
| `state` | run: `accepted…cancelled`; session: `spawning\|running\|exited` | Control lifecycle / PTY owner. Never overridden. |
| `activity` | `working \| idle \| needs-input \| unknown` | **Only** a host-registered semantic checker. Default `unknown`. |
| `health` | Monitor vocabulary (`healthy…unknown`) | `Monitor.classify` over host-stamped evidence. |
| `attention` | `none \| awaiting-approval \| needs-input \| unhealthy` | Pure fold of the above. |
| `freshness` + provenance | `fresh \| stale \| unobserved` + who/when/what-evidence | Host-stamped only. |

The load-bearing corrections:

- **Default activity is `unknown`.** Output silence does not prove `idle` or `needs-input` (the harness may be thinking). Output movement does not prove `working` (it may be a spinner). Nothing in the default path maps PTY bytes to semantics. Only an explicitly registered checker (e.g., a harness adapter that parses a specific prompt marker) may report `working`/`idle`/`needs-input`. The PTY owner's lifecycle remains authoritative regardless.
- **Read receipts are not health.** `failed-unread`/`completed-unread`/`seen`/`unread` are deleted. Whether a human has looked at a terminal state is UI/Alerts territory; there is no observed ack state to model and we don't invent one.
- **Checks are observational.** `ProbeContext` exposes no Control methods, no approval handles, no resume/heal. No automatic heal is driven by checker output. Approval waits are never autohealed.

## Schema placement

`Health.ts` is the **leaf**: it defines every literal and struct. `Monitor.ts` imports Health and aliases (`export const Health = HealthSchema.HealthState` style), so `Monitor.Health` remains a valid reference for existing readers with no runtime cycle.

## Core API — `packages/smithers/control/src/Health.ts` (new)

```ts
import { Effect, Schema } from "effect"

export const SubjectId = Schema.String // "run:<runId>" | "session:<ptyId>"

export const RunState = Schema.Literals([
  "accepted", "running", "parked", "waiting-approval",
  "completed", "failed", "cancelled"
])
export const SessionState = Schema.Literals(["spawning", "running", "exited"])
export const SubjectState = Schema.Union(RunState, SessionState)

export const HealthState = Schema.Literals([
  "healthy", "stalled", "wedged-node", "runaway-loop",
  "awaiting-human", "failing", "unknown"
]) // Monitor.ts aliases this; single vocabulary.

export const Activity = Schema.Literals(["working", "idle", "needs-input", "unknown"])
export const Attention = Schema.Literals(["none", "awaiting-approval", "needs-input", "unhealthy"])
export const Freshness = Schema.Literals(["fresh", "stale", "unobserved"])

/** Closed reason vocabulary. No freeform error text crosses the trust boundary. */
export const ReasonCode = Schema.Literals([
  "ok", "no-progress", "awaiting-reply", "prompt-detected",
  "quota-wait", "timer-wait", "event-wait",
  "unreachable", "probe-timeout", "probe-error", "owner-changed"
])

const Detail = Schema.String.pipe(Schema.maxLength(128))       // host-truncated
export const MetricKey = Schema.Literals([                      // fixed label set
  "tokensPerMin", "toolCallsPerMin", "queueDepth", "lagMs"
])

/** What a checker returns. Untrusted until validated + host-stamped. */
export const ProbeReport = Schema.Struct({
  activity: Activity,
  reason: Schema.optional(ReasonCode),
  detail: Schema.optional(Detail),
  metrics: Schema.optional(Schema.Record(MetricKey, Schema.Finite))
})
export type ProbeReport = typeof ProbeReport.Type
```

### Checker and registration

Pure Flow bodies and persisted `AgentRoles` JSON **cannot carry Effect functions**. Checkers are trusted TS registered in the host; JSON may only *select* a predefined checker by id with schema-decoded config.

```ts
/** Read-only evidence. No Control, no approvals, no mutation, no terminal bytes by default. */
export interface ProbeContext {
  readonly subjectId: string
  readonly state: typeof SubjectState.Type
  /** Flows: control-journal events since the previous beat (incremental, never full replay). */
  readonly events: ReadonlyArray<ControlSchema.ControlEvent>
  readonly summary?: ControlSchema.RunSummary | undefined
  /** Sessions: owner-reported facts. No PID. Output tail only if the binding opted in. */
  readonly session?: {
    readonly alive: boolean
    readonly exitCode: number | null
    readonly outputCursor: number     // monotone byte counter, owned by the PTY layer
    readonly outputTail?: string      // present only when binding.exposeOutput === true
  } | undefined
  readonly sinceCursor: number        // evidence cursor at the previous beat
}

export class HealthProbeError extends Schema.TaggedError<HealthProbeError>()(
  "HealthProbeError", { reason: ReasonCode }
) {}

export interface CheckPolicy {
  readonly intervalMs: number
  readonly timeoutMs: number
  readonly ttlMs: number
  readonly backoff: { readonly initialMs: number; readonly maxMs: number; readonly factor: number }
}

export interface HealthChecker<C = never> {
  readonly id: string
  readonly configSchema?: Schema.Schema<C, unknown> // decodes JSON-selected config
  readonly defaults: Partial<CheckPolicy>
  readonly probe: (ctx: ProbeContext, config: C) => Effect.Effect<ProbeReport, HealthProbeError>
}

/** Built-ins. Both report activity "unknown"; they still project lifecycle usefully. */
export const lifecycleRunChecker: HealthChecker      // id "lifecycle.run": maps parks to quota-wait/timer-wait/event-wait reasons
export const lifecycleSessionChecker: HealthChecker  // id "lifecycle.session": alive/exit projection only
```

Registration lives in `Application.Config` (`packages/smithers/src/Application.ts`) and in the local server's trusted TS options, keyed by `flowId` or `roleId`:

```ts
// Application.Config addition (runtime side; mirrored shape in the local server options)
export interface HealthConfig {
  readonly checkers?: ReadonlyArray<HealthChecker<any>>
  readonly bindings?: Readonly<Record<string /* flowId | roleId */, HealthBinding>>
  readonly limits?: { readonly maxSubjects?: number; readonly maxConcurrentProbes?: number }
}
export interface HealthBinding {
  readonly checkerId: string
  readonly config?: unknown            // decoded via checker.configSchema before first use
  readonly policy?: Partial<CheckPolicy>
  readonly exposeOutput?: boolean      // opt-in terminal tail for session checkers
}
```

Persisted `AgentRoles` JSON gains one optional, schema-decoded field: `health?: { checkerId: string; config?: JsonValue }`. It can only name a registered checker; unknown ids fall back to the lifecycle default with a `probe-error`-free `unknown` projection.

### Host-stamped observation

The host stamps every identity and ordering field. A checker's report is data; it never supplies its own sequence, timestamps, or version.

```ts
export const statusObservedEventType = "control.status.observed"

export const HealthObservation = Schema.Struct({
  subjectId: SubjectId,
  checkerId: Schema.String,
  monitorId: Schema.String,       // host: which observer
  incarnation: Schema.Int,        // host: owner incarnation at probe start
  evidenceSeq: Schema.Int,        // host: journal seq (run) / outputCursor (session) at probe start
  observedAt: Schema.Number,      // host clock
  durationMs: Schema.Number,
  outcome: Schema.Literals(["ok", "timeout", "error", "interrupted", "discarded"]),
  report: Schema.optional(ProbeReport),   // validated, detail truncated, metrics key-filtered
  reason: Schema.optional(ReasonCode)     // failure reason; never raw error text
})
```

**Fencing and ties, exactly:** before invoking a probe, the host snapshots `(incarnation, evidenceSeq, state)`. After the probe returns, if the subject's owner incarnation or lifecycle changed during the probe, the host records `outcome: "discarded"` and the fold ignores the report — a reading about a dead incarnation never colors a new one. Across concurrent producers, the fold keeps the observation with the highest `(incarnation, evidenceSeq)`; when equal, the **authoritative journal sequence of the `control.status.observed` event itself** breaks the tie (later event wins). Wall clocks are display-only. Process PIDs are never identity — the PTY owner and run incarnation are.

### Rollup

```ts
export const StatusRollup = Schema.Struct({
  subjectId: SubjectId,
  state: SubjectState,
  activity: Activity,
  health: HealthState,
  attention: Attention,
  freshness: Freshness,
  reason: Schema.optional(ReasonCode),
  detail: Schema.optional(Detail),
  provenance: Schema.optional(Schema.Struct({
    checkerId: Schema.String, monitorId: Schema.String,
    observedAt: Schema.Number, evidenceSeq: Schema.Int, incarnation: Schema.Int
  })),
  updatedAt: Schema.Number
})

export const rollup = (input: RollupInput): StatusRollup => { /* precedence below */ }
```

**Precedence (top wins; the order is the contract):**

1. **Approval fence.** `state === "waiting-approval"` or parked on approval → `attention: "awaiting-approval"`, `health: "awaiting-human"`. No checker output can alter this, and nothing here ever resolves or heals a gate.
2. **Terminal states** (`completed | failed | cancelled | exited`) fold directly; activity is forced `unknown`; health is `failing` for failed, `healthy` otherwise.
3. **Freshness.** No observation → `unobserved`. Observation older than `ttlMs`, or with a stale incarnation, or `outcome !== "ok"` → `stale`. Freshness never claims better than the host stamped.
4. **Activity.** `fresh` → `report.activity`; otherwise `unknown`. Never `idle`/`needs-input` from silence, never `working` from byte movement.
5. **Health.** `Monitor.classify` over the Monitor observation. Known waits are honored: a park on a timer, event, or quota is *waiting*, not `stalled` (reasons `timer-wait`/`quota-wait`/`event-wait` keep health `healthy`). A fresh `working` report is fed **into** the Monitor observation as semantic progress evidence (so classify doesn't false-stall a quiet-but-working subject); a fresh `idle`/`unreachable` may demote `healthy` → `stalled`/`failing`. A checker can therefore prevent a false stall via evidence but can never post-hoc overwrite `stalled`/`failing`/`awaiting-human` with `healthy`. `control.status.*` bookkeeping events are **excluded** from progress evidence — a monitor must not keep a run "healthy" by observing it.
6. **Attention.** Fresh `needs-input` → `"needs-input"`; `health ∈ {stalled, wedged-node, runaway-loop, failing}` → `"unhealthy"`; else `"none"`.

A subject with no custom checker still gets a useful projection: correct state, wait-kind reasons, `activity: unknown`, `freshness` reflecting the lifecycle checker's beats. The UI renders `running · not yet observed`, never "working".

## Producer hosts

**Flows — extend `Monitor.ts`, first production wiring via `NativeControl.ts`.** `Monitor.Observation` gains `semanticProgress?: { at: number; evidenceSeq: number }` and the classifier honors it plus the known-wait rule. The beat loop resolves the subject's binding from the Health registry, builds `ProbeContext` from the summary plus **only the events streamed since the last beat cursor** (no full-journal replay per poll), and runs the probe under `Effect.timeout(policy.timeoutMs)` inside the beat fiber (structural cancellation on teardown), with `Schedule.exponential` backoff on repeated failure, reset on success. Admission is bounded: at most `limits.maxSubjects` monitored, at most `limits.maxConcurrentProbes` in flight, enforced with a semaphore. Each beat journals one `control.status.observed` via `emitDurableUnfenced` before any heal decision — evidence survives a crash one instruction later. Production wiring: `NativeControl.ts` builds the registry from `Application.Config.health`, `layerControlFromEngine` supplies the captured Control + control Journal, `layerGatewayHost` keeps the Scope alive so the monitor fiber lives and dies with the gateway host. **Local/embedded hosts only:** a config pointing at a remote gateway must not run checkers locally — the callbacks execute only where the journal and engine actually live.

**Sessions — `apps/app/src/bun/SessionMonitor.ts` (new).** A single bounded beat loop over the PtyManager's observable state (`alive`, `exitCode`, monotone `outputCursor`, opt-in tail). It is a pure reader: it never writes to or kills a PTY, and the LocalDaemon remains the lifecycle authority (this slots into the hook seams the daemon persistence work is adding). Same timeout/backoff/concurrency bounds as the flow monitor. Sessions have no journal: the latest `HealthObservation` is held in memory, folded, and published as a `pty.status` frame on the existing `pty:<id>` topic. After a daemon restart the monitor re-derives from live PTY state and emits `unobserved` until its first completed beat — a reattached tab is never "working" before it has been observed.

## Wire and projection — additive only

**No new selectors, RPCs, or poll services.** `RunSummaryRow` gains one optional field, `statusRollup?: StatusRollup`, computed in the existing run-summary projection fold (which now also consumes `control.status.observed`, tolerant-reader style so old journals and old clients decode). It flows through the existing authenticated `Projection.Snapshot`/`Projection.Subscribe`, opaquely through the Go relay and Worker. Sessions: `packages/rpc` gains the `PtyStatusFrameSchema` (`{ type: "pty.status", sessionId, status: StatusRollup }`) riding the existing topic socket, plus an optional `status?` on `PtySession` for list snapshots. That is the entire wire surface.

## UI

Reuse `@smthrs/ui` status pill; status is a qualifier on existing surfaces, no new chrome. The run card's pump reads `statusRollup` off the run summary it already subscribes to and **replaces** the "summary keeps saying running = progress" heuristic with the freshness axis (`running · not yet observed`, `running · stalled`, `waiting on you`). `attention: awaiting-approval` routes to the existing approval card. Terminal tabs render the `pty.status` frame: fresh `working` → "working", fresh `idle`/`needs-input` → "waiting for input", everything else → neutral "running" (with a stale marker when applicable) — the honest default for the nine harnesses with no adapter. A `statuses` TanStack DB collection, memory-only, derived during render, updated through the shared dispatcher; the frame branch is added to the existing PTY client without restructuring the socket. Pills are presentational, not focus stops; action goes through existing keyboard-accessible acts.

## Attention durability

Journaled observations carry the fields `AlertPolicy.defaultDetectors` already key on; add one detector for `freshness: stale` and wire the in-app/`layerNoop` sink. Existing `Alerts`/`AlertRuntime` provide the durable, coalesced boundary — **no new queues**. Real APNs/background delivery is architecture-only in agent #4's audit; this change delivers nothing to a lock screen and does not claim to.

## Trust limitations — stated plainly

Checkers are **trusted TS in the host's own trust domain**, not sandboxed plugins. `ProbeContext` being read-only is an interface discipline, not a boundary: a checker can import modules, capture ambient authority, spin CPU, or exfiltrate anything it can reach. What we actually enforce: registration only through host code (`Application.Config`/server options — the same trust level as the app itself), JSON can only select pre-registered ids, bounded timeout + fiber interruption, validated/truncated reports with closed reason and metric vocabularies, no approval or mutation capabilities in context, no terminal output without opt-in, and discard-on-ownership-change. What we do not claim: memory/CPU isolation or exfiltration prevention. Anyone extending checkers to third-party code must add a real sandbox first.

## Tests

- **`Health.test.ts` (control):** full precedence table; approval fence (a `working` report on `waiting-approval` still yields `awaiting-approval`/`awaiting-human`); unobserved/stale caps activity at `unknown` and never yields `healthy` for a non-terminal subject; fencing (stale incarnation discarded; lower `evidenceSeq` ignored; equal-evidence tie resolved by journal sequence); known waits stay healthy; report validation truncates detail and drops unknown metric keys; JSON binding decode (unknown checkerId → lifecycle default).
- **Monitor integration:** probe timeout → `outcome: "timeout"` → stale → activity `unknown`; backoff resets on success; teardown interrupts in-flight probes (no leaked fibers); observation journaled before heal; `control.status.observed` events never count as progress; concurrency semaphore holds under N subjects; incremental cursor (beat N+1 reads only new events).
- **`SessionMonitor.test.ts`:** default checker yields `unknown` activity for a live quiet PTY *and* for a live chatty PTY (spinner case); a registered marker-adapter yields `needs-input`; `!alive` → `exited`; restart → `unobserved` before first beat; hung probe → stale, never "working"; monitor never writes to the PTY.
- **Projection:** journal replay reproduces byte-identical `statusRollup`; old journals without observations decode with `unobserved`; old clients ignore the new optional field.
- **E2E (Playwright, existing fixtures):** approval-parked flow shows "waiting on you"; quiet default-checker session shows neutral "running", not "waiting for input"; adapter-equipped session shows "working"; killed evidence source shows stale, never "working".

## Observability

Effect `Metric` with bounded enum labels only: probe outcome counter by `(checkerId, outcome)`, observation-lag histogram, stale gauge, pending-approval age, `unhealthy` attention count. Spans: `control.monitor.beat` with a child per probe (`checkerId`, `outcome`, `activity`); identifiers in attributes, never free text, no payloads.

## Ownership and order

1. **Runtime Health/Monitor agent** — `packages/smithers/control/src/Health.ts` (+ index export), `Monitor.ts` extension, `Application.Config.health` surface in `packages/smithers/src/Application.ts`, `Health.test.ts` + Monitor tests. No dependencies; lands first.
2. **Gateway host/projection agent** — `NativeControl.ts` production wiring (first Monitor caller, registry from config, scope lifetime, local-only guard), run-summary projection fold + optional `RunSummaryRow.statusRollup`, `packages/rpc` frame/DTO additions, projection replay tests. Depends on 1.
3. **Local daemon persistence agent** (already active on `LocalDaemon*`/`Pty`/server) — owns the monotone `outputCursor` and the hook seams; exposes them, nothing more. This is the one shared-file dependency: the cursor lands once, in their PTY work, and everyone else reads it.
4. **Root** — `SessionMonitor.ts`, the `pty.status` route/frame publication, the `statuses` collection + client branch, run-card and terminal-tab pills, the stale Alerts detector, e2e. Depends on 1–3; UI pieces can start against the schema from 1 immediately.

Bounded scope check: this completes #2 now — a real configurable Effect API, two producer hosts, persisted observations with host-stamped provenance, a typed additive wire, live UI freshness on consistent components, tests and metrics — while explicitly deferring OS delivery (#4's architecture), the approval-path bug fixes (separate), cloud-terminal liveness relay from plue, and any checker sandboxing.