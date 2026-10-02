# Smithers App — Design Product Spec

Owner: design agent. Audience: will (CEO/product), engineering agent, implementation subagents.
Scope: the desktop app in `apps/app` through the Aug 13 demo and immediately after.
Companion docs: `AGENTS.md` (architecture rules — frames, flux, no `useEffect`), the ops vault `Now.md` / `Design.md` (product truth).

**Status log:** D1 (token bridge, rich chat, first-run) landed 2026-08-07 AM · D2 (cards, slash menu, identity, suggestions, surface polish) landed 2026-08-07 PM — both verified `tsc` + `vite build` green on the merged tree.

## 1. Locked decisions (2026-08-07, CEO)

- [x] **The app palette (paper / teal / gold) is the product brand.** Engine + monitor surfaces keep the violet/zinc styleguide theme; this app never falls back to it.
- [x] **Demo scope: one live approval.** Conversation + a flow-created Plan card + one inline ApprovalCard approved on camera.
- [x] **Roster: Smithers only.** No named sub-agents anywhere in product or docs. The message schema stays extensible to user-added agents later.
- [x] **Layout: cards between bubbles.** Conversation stays in bubbles; rich payloads (plans, approvals, artifacts, diffs) render as full-width cards in the transcript flow. No bubble tails on cards.
- [x] **Tailwind is out.** Semantic CSS + the library token bridge. The dead pipeline (config, PostCSS wiring, deps) gets removed, not adopted.

## 2. Brand & tokens

Single source: `src/mainview/styles/tokens.css`. The `@smthrs/ui` library resolves every visual value as `var(--house-token, fallback)`; **this app must define every consumed house token in both `:root` and `:root[data-theme="dark"]`** — a missing token is a brand leak (violet/zinc fallback). As of D1 the bridge is complete (50/50 tokens, both themes).

- Palette: `--paper-*` (warm paper), `--ink-*` (warm brown-black), `--water-*` (teal, brand = `--water-500`), `--sediment-*` (gold accent), `--ember-*` (danger, terracotta), `--slate-*` (info, muted slate-teal).
- Status mapping: success → water, warning → sediment, danger → ember, info → slate. Each has `-soft` / `-border` via `color-mix` (never alpha-concatenation).
- Type: Inter (`--font-ui`), IBM Plex Mono (`--font-mono`) for meta/labels/timestamps. Dense scale: body ~13.5px; mono meta 9–10px.
- Motion: `--ease-current`, `--dur` 180ms, `--dur-slow` 260ms. `prefers-reduced-motion` honored globally.
- A11y floor (already met — keep it): `role="log"` transcript, `aria-live` on status, `:focus-visible` brand ring, aria-labels on icon buttons.

## 3. Layout grammar

- **One page: the chat. Auth is a conversation state, not a view. A second page is a design defect.** (law, 2026-08-09) A signed-out or non-allowlisted visitor sees THE CHAT — transcript + composer — whose opening Smithers message carries the one available action (sign-in rides the signed-out message with the scopes in plain words; request-access rides the closed-alpha message; a failed OAuth return is a chat message with a retry action). Session state changes what the chat CONTAINS, never which page exists. The only off-app surface allowed is the mid-redirect OAuth failure (the browser is off-app); everything else is the chat.
- **One chat. No tabs, no threads, no page takeovers.** World and Connectors open as embedded panes inside the persistent chat shell — transcript and composer never unmount, close is the registered `chat` command (full URL-addressable frames remain post-demo, see AGENTS.md).
- A pane sits **beside** the conversation on a wide window and **under** it on a narrow one; it never overlays it, and it never takes the chat's chrome with it. Chat chrome (balance, reset, theme) is anchored to the chat column, so a pane's own header keeps its full width and its back-to-conversation button stays clickable. `scripts/web-chat-shell-e2e.ts` proves all of this in a real browser, including node identity across the transition.
- **Bubbles** carry conversation: user (outgoing, green, tail bottom-right), Smithers (incoming, paper/dark, tail bottom-left).
- **Cards** carry payloads, full transcript width, between bubbles: PlanCard, ApprovalCard, ArtifactCard, DiffCard, StatusCard. Cards never get tails, never get avatars, always name the Flow they belong to.
- **System notes** (interruptions, failures, checkpoints) render as small mono marker rows under a bubble or between messages — never as text injected into a bubble.
- Composer is fixed at the bottom, glass, always visible; suggestion pills live directly above it. When the auth state gates chatting (signed-out / not allowlisted), the composer stays visible and honestly gated: its placeholder names the one needed step and an attempted send resolves to a calm one-line Smithers reply carrying that step's action.
- **The 300ms toast law (2026-08-09):** background work not settled within 300ms shows a toast on the one shared corner stack stating what is running, resolving into the result when done; work under 300ms never flashes. Toasts are notifications, not state mutations; a failure toast is honest and stays until dismissed.
- **Chat is complimentary during the alpha (2026-08-09):** no per-turn dollar line on chat turns; a $0 balance never pauses the composer or the chat (the pause discipline applies only to non-complimentary paid work); the dollar balance chip stays.
- **Watched repos are chosen, never defaulted (2026-08-09):** the first signed-in run asks ONE question — a repo-chooser card in the transcript (never a wizard page) — and repo work reads only the chosen set. Changing the set is "just ask": `repos.watch` is one command with three invocations (card confirm, slash, agent tool). `via` is recorded on every write.
- **Pills and buttons are command bindings (2026-08-09):** a suggestion pill never carries a prompt string for the model; it invokes its command directly. The pill row is derived (the genuinely-next step) — an empty row is correct, a fabricated one is a violation. The composer shows NO standing status chrome; broken states speak at the moment they happen.
- **The trigger axis (2026-08-09):** browser-mechanics commands (`auth.*`, `reset`, `theme`, `chat.stop`, `send`, maximize/minimize) are `trigger: user` — absent from the agent's tool catalog and uncallable by it, with an honest tool-result error naming the visible alternative. The agent's invocation of a surface command renders the EMBEDDED card; maximizing is the user's explicit act alone. The bare reset is admin-only dev tooling; users get `/clear`, which sweeps the transcript into world notes before clearing and clears nothing on a failed sweep. Tool acts render as at most one compact Smithers-side line — raw payloads never enter the transcript; the full stream lives in the admin-only dev-tools panel.
- **Sign-in IS the GitHub connector (2026-08-09):** a valid session means connected; the connect surface (extension-store rows: icon, name, one line, one action) and the agent context derive connection truth from the session + the watched set, never from the legacy local-connector store.

## 4. Chat surface spec

Anatomy per Smithers message, top→bottom: author label → optional collapsed Reasoning → Markdown body → system note (if `status ≠ complete`) → timestamp. User message: Markdown body → timestamp.

Message schema (v3): `role: "user" | "smithers"`, `text`, `reasoning?`, `status: "complete" | "failed" | "interrupted"`, `statusDetail?`, `createdAt`, `ordinal`.

States:

- [x] First-run: exactly one genuine Smithers greeting + suggestion pills (fake seeds removed D1).
- [x] Zero-message: no empty-state message (Will, 2026-10-01, retired "Nothing here yet"); the setup checklist, or its job tiles once dismissed, holds the empty transcript.
- [x] Streaming: text and reasoning deltas append live; Reasoning open while streaming, collapsed when done.
- [x] Pending: typing bubble "Smithers is responding".
- [x] Failed: in-character bubble + structured `failed` status + system note with detail.
- [x] Interrupted (Escape): partial message kept, `interrupted` status + system note.
- [x] Retry affordance on failed turns (D2 — resubmits the last user prompt).
- [x] Per-message hover actions: copy (D2).
- [ ] Day dividers / compact grouping via library `Marker` / `CompactGroup` (post-demo).

Composer:

- [x] Enter send / Shift+Enter newline / Escape stop; autogrow 160px; draft persisted via dispatch.
- [ ] Send/stop glyphs → lucide `ArrowUp` / `Square` — **blocked on a library gap**: `ChatComposer` hardcodes the text glyphs; `@smthrs/ui` needs ReactNode send/stop labels (queued for engineering, smithers repo).
- [x] `/` command menu v0 (D2): `/connect`, `/world`, `/plan`, `/reset` — keyboard-complete (arrows/Enter/Esc); the composer toolbar buttons route through the same command registry, so button/slash parity holds structurally.
- [x] Suggestions refreshed after every turn via the existing `actions.replaced` transition (D2 — context-honest: connector state decides the set).

## 5. Rich cards spec (D2 — the demo's "one live approval")

All cards compose `@smthrs/ui`; none are hand-rolled. Card states: active / acted-upon / error. Cards live in their own persisted collection and interleave with messages by `ordinal` — full width, no tails, no avatars.

**Landed (D2, UI complete):** PlanCard (library `Plan`/`PlanStep`), ApprovalCard (`Confirmation` family composed in the ApprovalCard idiom; Approve/Deny → `card.approval.decided` (actor: user) freezes the card with a mono decision stamp), StatusCard (`StatusPill` + `Progress`).

**The card-frame contract (proposed; UI half wired):** the controller validates and handles NDJSON frames `{ type: "card", card }` → `card.upsert` and `{ type: "card.update", id, patch }` → `card.updated` (zod-validated; invalid frames dropped, unknown frames ignored). **Engineering owns the backend half** — when `chat.smithers.sh` emits these frames mid-turn, cards go live with zero UI changes. Approval decisions leave via `forwardApprovalDecision` (today: journaled locally; the seam for the backend round-trip). Contract follow-ups: add `flow` (name) so card headers can name the Flow; widen `AgentTurnFrame` in `src/shared/NativeAgent.ts` to include the card frames.

- **ArtifactCard**: library `Artifact` / `Snippet`; large outputs by reference, never inlined. (post-demo)
- **DiffCard**: library `DiffHunks` (pierre adapter only if payload is large). (post-demo)

## 6. World surface spec

- [x] Sidebar FileTree + Milkdown Crepe editor; wikilinks re-parsed on edit with `user:world-editor` provenance.
- [x] Confidence + sources badges in the meta bar.
- [x] Empty state with create action.
- [x] Delete note — `world.document.removed` wired via `ConfirmDialog` (destructive) in the doc meta bar (D2).
- [ ] Right rail v0: library `BacklinksPanel` + `OutlineView`.
- [x] Header chrome: shared `SurfaceHeader` (`SurfaceChrome.tsx`) adopted by both World and Connectors; old `.world-header` CSS removed (D2).

## 7. Connectors surface spec

- [x] 3-card grid: Local repository (live: native picker, read-only vs read-write), Smithers Cloud + GitHub (pending, 72% opacity).
- [x] Connected repo cards: branch / head / worldview facts; empty state.
- [x] Copy fixes (D2): "Smithers Cloud repository", "Coming soon" badge pattern, plain-language connector copy throughout.
- [x] Remove repo → `ConfirmDialog` (destructive) before dispatch (D2).
- [ ] Worldview fact "Not analyzed" → triggers the analyze Flow when it exists (post-demo; button copy "Analyze codebase" must resolve to a named Flow — three-trigger law).

## 8. Identity

Smithers is the only named agent. Treatment (landed D2): `MessageAvatar` monogram "S" on brand teal + mono author label. Schema keeps `role` extensible (`user | smithers` today; user-added agents later — addressing one directly is an override, never the normal path).

## 9. Copy rules

- No internal/transitional names in user-facing copy: no "Smithers Cloud", no "— next", no flow/run jargon in first-run surfaces.
- Errors are in-character and structured: what happened + what to do next, one sentence each.
- Suggestion seeds (current): "Build my work queue" (primary/gold), "Connect GitHub", "Plan my day".

## 10. Demo storyboard — Aug 13, SLOP.COMPUTER (10–11am PDT)

1. Fresh profile → greeting + suggestions. (Keyboard only from here.)
2. "Connect GitHub" suggestion → connector card state change.
3. Ask Smithers to work → streamed reasoning collapses → Markdown answer.
4. PlanCard lands: "Flow created — <name>".
5. ApprovalCard lands → approve on camera → card freezes acted-upon → run starts (StatusCard).
6. Escape hatch ready: pre-warmed workspace if live backend hiccups (engineering owns).

Fallback rule (CEO's): if a capability can't be honest by Monday, the capability is cut from the demo, not the honesty.

## 11. Out of scope (post-demo)

Frames navigation (URL-addressable, embedded mini-apps, fork) per `AGENTS.md`; multi-human co-editing/presence; slash menu full command registry; WorkflowCanvas surface; terminal card; admin surface; storybook house-theme stories for every family this app consumes.

## 12. State-coverage checklist (living)

Per surface, every row must exist and be reachable: empty / loading / error / populated / streaming(where relevant) / unauthorized(where relevant). Chat ✅ (D1). World: no error state needed (local-only). Connectors: error ✅, empty ✅, busy ✅, skeleton ☐. Cards: all four states per card type (D2). Smoke-test per surface rendering these states doubles as the test floor (engineering: vitest + Testing Library, post-demo).

## 13. Runtime and persistence target (planned, not implemented)

The POC loop on 2026-08-08 proved that the local `@smithers/database`, `@smithers/journal`, `@smithers/harness`, `@smithers/adapters`, and `@smithers/connectors` closure can be packed from this repository, imported by an external consumer, and installed together with the owning Effect version. The v15 isolated external install contained 59,620 files and measured 778,911,744 bytes (about 743 MiB) in `node_modules`; earlier attempts exceeded 1 GB when they installed a broader closure. These are run-scoped prototype measurements, not production claims.

The same run falsified three workflow assumptions. First, a typed planner can still put prose inside a machine path, so every lane plan now passes a deterministic ownership validator and automatic repair iteration before package work. Second, synchronous package commands can freeze the Smithers engine heartbeat even when the command itself is healthy, so deterministic preparation now uses asynchronous child processes with bounded time and output. Third, Bun cannot directly resolve the transitive absolute `file:` tarball graph emitted by the local packer; a disposable proof showed that npm can resolve that graph, `bun pm migrate` can convert it, and `bun install --frozen-lockfile --ignore-scripts` can verify the resulting sole `bun.lock` after `package-lock.json` is removed.

The v14 learning receipt rated the frozen MVP at 24/100 against the production architecture contract. That is a run-scoped assessment, not a launch metric: it means the current UI prototype demonstrates useful interaction seams while host SQLite authority, the Flow/Harness composition, recursive agents, durable URL frames, the backend approval round trip, and product E2E remain unproven. The reusable workflow gates those claims rather than promoting the disposable code.

The v15 authority foundation then proved a narrower, correctly phased slice. Commit `32a9b068b3a9869e59464099daf2fdf28193e761` in its disposable worktree composes the real `@smithers/database` and `@smithers/journal`, creates the seven owning `flows_*` tables, closes and reopens the same SQLite file, and passes eight focused tests with 31 expectations plus scoped TypeScript validation. The implementation is 288 lines with a 139-line test. This is **proven POC**, not integrated product code. It also exposed a Bun packaging constraint: the upstream `node:sqlite` driver requests extension loading, while Bun's bundled SQLite rejects that mode, so the POC must preload a compatible system SQLite library. Production packaging must replace that host-specific shim with a portable, owned driver-loading decision.

v15 also corrected the acceptance topology. A full product Vite build took 525,745 ms under a host load above 35 and produced 6.3 MB across 186 chunks; three earlier 120-second attempts timed out. The authority foundation had already proved its own boundary, so treating this product build as a foundation assertion was invalid phase coupling. The transcript lane owns the UI migration and the serial integration node now owns exactly one bounded product build. Every bounded command runs in its own process group: timeout or output overflow terminates the whole group with `SIGTERM`, escalates to `SIGKILL`, and does not resolve while resistant descendants remain. This prevents a timed-out package manager or bundler from starving later workflow nodes.

The v15 architecture-learning agent produced a clean 12-section, 10-contract site and a browser screenshot, but its 24/100 score correctly remained unchanged because no domain fleet or integration ran. That node is now documentation-only: it may read receipts, write the requested self-contained site, validate its structure once, and render it once; it may not install packages, mutate product configuration, run the full product build, or start a persistent preview server.

The target boundary is therefore:

- **Renderer:** TanStack DB collections remain the typed, reactive application authority consumed by React. React components remain projections and never own state.
- **Shared protocol:** Flux intents, actors, Flow bindings, frame pointers, and projection batches are schemas only. Shared code contains no driver, Harness, connector, or adapter runtime.
- **Bun host:** the SQLite driver, app-table stores, `Journal.transact`, Flow registry, Harness Cell, connectors, and external adapters compose here.
- **Atomicity:** a renderer intent crosses one typed native boundary. Each application-state transition mutates any required app tables and appends its Journal evidence in one storage-only SQLite transaction. Only the committed acknowledgement is projected into TanStack DB. Flow bodies, model calls, tools, MCP, connectors, filesystem operations, and other external effects never execute inside `Journal.transact`.
- **External effects:** Flows execute outside the local storage transaction. Every effect is a real Smithers `Activity` classified as sealed, compensable, or irreversible; retries use content identity or an explicit idempotency key, ownership is fenced where applicable, and compensable effects register recovery. No local WAL can make a remote effect atomic.
- **One durable database:** the Bun host owns the single SQLite file. TanStack DB uses a native-bridge sync adapter to hydrate and apply committed `ProjectionBatch` revisions; it does not maintain an independent OPFS persistence writer. The existing browser OPFS store is prototype code to replace, not a second source of truth.
- **Distribution:** product source may depend only on new `@smithers/*` packages owned by this repository. Local tarballs are POC transport; production requires publishable or workspace-portable package specs.

Before any implementation fleet starts, the workflow must prove this control sequence:

```ts
const plan = await planner.proposeRound(priorValidation)
const validation = validatePocRoundPlan(plan, pinnedBaseline)
if (!validation.valid) return repairPlan(validation) // zero implementation agents

const distribution = await runInProcessGroup(packAndExternalSmoke)
await runInProcessGroup(npmResolveLocalTarballGraph)
await runInProcessGroup(bunMigrateLockfile)
await runInProcessGroup(bunFrozenInstall)

const foundation = await composeThinHostAuthority(distribution)
const lanes = await Promise.all(domainLanes.map((lane) => lane.implement(foundation)))
return serialIntegrator.buildVerifyAndLearn(lanes) // exactly one product build
```

Expected product-owned structure:

```text
src/
├── shared/
│   ├── NativeRPC.ts       # serial composition of module-local RPC schemas
│   ├── authority/          # runtime-free package provenance + boundary schemas
│   ├── state/              # FluxIntent, Actor, ProjectionBatch, CommitReceipt
│   ├── flows/              # FlowId, Invocation, bindings, frame pointers
│   ├── platform/           # connector/worldview/adapter DTOs
│   └── agent/              # renderer-neutral AgentTurnFrame protocol
├── bun/
│   ├── index.ts           # serial host composition root; no domain owns it
│   ├── authority/          # real @smithers/* composition root
│   ├── database/           # SQLite driver, migrations, app-table stores
│   ├── state/              # Journal.transact transition host
│   ├── flows/              # one registry and invocation router
│   ├── harness/            # script-first Cell and recursive native children
│   ├── connectors/         # real connector bindings; credentials stay here
│   ├── worldview/          # fresh versioned context snapshots
│   └── agent/              # model/card stream and external-agent adapters
└── mainview/
    ├── state/              # TanStack DB collections + projection application
    ├── flows/              # slash/button/agent bindings; no feature callbacks
    ├── frames/             # URL-addressed durable frame projections
    ├── transcript/         # renderer-neutral timeline and agent renderers
    ├── world/              # Markdown-native worldview projections
    └── platform/           # connector/workspace UI projections
```

`src/bun/index.ts` and `src/shared/NativeRPC.ts` are intentional serial seams. Domain modules own their implementation directories and module-local RPC schemas; they never append handlers or protocol members to a shared switchboard in parallel. The serial integrator composes those exports into the Bun startup path and the complete native protocol. This keeps the real host runtime reachable while removing two high-conflict files from parallel ownership.

Agent presentation is a renderer concern, never transcript state. Persist normalized events such as `message`, `thinking`, `tool`, `diff`, `permission`, and `status` with `provider`, `agentId`, `turnId`, ordering, and raw/provenance references. A renderer registry selects the view at read time.

For Claude Code and Codex, use the accessible React primitives from [Brainless](https://brainless.swerdlow.dev/components). Vendor only the individual primitives needed by the mixed transcript—Claude message/thinking/tool-call/diff/permission and Codex message/working/exec/diff/permissions—after recording the upstream URL, content digest, captured CLI version, and reuse terms. Do not install either full `claude-session` or `codex-session` block: those blocks include their own headers/composers and would violate the one-composer chrome. Keep pinned tmux screenshot fixtures and, for Codex, source references to the open-source `openai/codex` terminal client as drift evidence; never derive persisted schema from pixels or provider-specific React props.

```ts
type AgentEvent = {
  id: string
  provider: "smithers" | "claude-code" | "codex" | string
  kind: "message" | "thinking" | "tool" | "diff" | "permission" | "status"
  payload: JsonValue
  source: { runId: string; turnId: string; sequence: number }
}

const AgentEventView = ({ event }: { event: AgentEvent }) => rendererRegistry.for(event.provider).render(event)
```

The execution path has two different durable boundaries and must never collapse them:

```ts
// Renderer: every ingress creates the same Invocation.
const invocation = flowRegistry.resolve(binding, {
  actor,
  ingress: "slash" | "button" | "agent" | "trigger",
  invocationId,
  workspaceId,
  branchId,
  frameId
})

// Native bridge: one Flow request, no direct controller mutation.
const run = await native.flows.invoke(invocation)

// Flow body: durable orchestration occurs OUTSIDE Journal.transact.
const result = yield * flowRuntime.execute(invocation, function*() {
  yield* appTransitions.commit({ type: "connector.requested", actor })

  const remote = yield* githubConnectActivity({
    request: invocation.input,
    idempotencyKey: invocation.invocationId
  })

  return yield* appTransitions.commit({
    type: "connector.connected",
    actor,
    remote
  })
})

// State transition host: storage work only.
const commitTransition = (transition: FluxIntent) =>
  Journal.transact(
    Effect.gen(function*() {
      const revision = yield* appState.apply(transition)
      yield* journal.emitDurable(toJournalEvent(transition, revision))
      return yield* appState.projectionBatch(revision)
    })
  )

// Renderer: consume only a committed transition acknowledgement.
const projectionBatch = await native.projections.next(run.id)
tanstackDatabase.transaction(() => {
  for (const patch of projectionBatch.patches) {
    collections[patch.collection].applyCommitted(patch)
  }
  revisions.assertNext(projectionBatch.revision)
})
```

The durable engine journals Activity attempt/intent/outcome around external work, but the Activity body itself remains outside the SQLite transaction. A crash can therefore replay an external Activity; its tier, idempotency key, fencing token, or compensation policy is what makes replay safe.

TanStack DB collection mutation handlers therefore submit typed Flux intents to the native host instead of persisting local rows. Startup and reconnect stream a versioned snapshot followed by monotonic projection batches from the same host SQLite record. A failed or missing revision triggers snapshot recovery; it never exposes a partial cross-collection transition.

The Harness path should remain equally small:

```ts
const turn = await flowRuntime.call("smithers/turn", input)

// The model writes one Smithers script per frame.
const frame = await harness.cell({
  context: await worldview.snapshot(input.workspaceId, input.branchId),
  sources: await flowRegistry.sources(input.scope)
})

// Tools, MCP, connectors, approvals, memory, and native child agents are
// ordinary Flow calls from that script. Claude Code and Codex are adapter Flows.
return frame.execute({ call: flowRuntime.call })
```

Every visible capability still follows the same presentation law: its first output is a message plus an embedded frame; maximizing renders the same persisted component state; composer chrome remains visible; URL back/forward follows durable frame history; and forking a historical frame creates a new workspace branch at the recorded app revision.

## 14. Agent Chain integration (decided 2026-08-11; supersedes §13's cell vocabulary, keeps its boundary)

**Retirement amendment (2026-09-18):** the in-page chain loop is deleted.
`chain/ChainRuntime.ts`, `chain/Policy.ts`, `chain/FlowCatalog.ts`,
`chain/StreamModel.ts`, `chain/RelayProtocol.ts`, `chain/HostPrompt.ts` and
`chain/Worldview.ts` are gone, and the controller holds the host's agent
directly — the HTTP agent against the app origin, or the unavailable adapter.
The three-tier approval policy below, and the capability claims
(`app:act`, `session:*`, `outbound:*`, `approve:*`) app flows declared to key
it on, are gone with it: capabilities are typed and injected, and approval is
a host-injected decorator (a GrantStore) that arrives with the harness cell
loop, never a string a flow declaration claims. What survives in `chain/` is
app persistence — storage, schema versions and recovery. The unused
CollectionJournal, chain projections, debug folds and Chain panel are removed;
application events and verified checkpoints own UI persistence. Every paragraph below that describes the
in-webview loop, its relay seat, its catalog adapter or its approval tiers is
history, not current behaviour.

**1.0 review amendment (2026-09-04, R7/R8; supersedes the earlier clear/sweep rule):**
`/chat.clear` is an offline-capable local archive/start-new operation, not a
model-dependent deletion. `/chat.clear --summarize` explicitly requests additive
World notes. Archive, notes and clear commit atomically; generated titles never
overwrite existing documents. A recovery link opens the archived branch after
reload. Failed/partial/oversized summaries leave the conversation intact and
do not block the plain local command. Agent invocations require human
confirmation. See `ui/docs/persistence.md` for bounds and recovery semantics.

Full plan with phase bars and rationale: the agent-chain UI integration plan of 2026-08-11, which is not in this repository. The spec vault, a separate repository, wins where they disagree. This section is the product-side contract each stacked PR lands against.

**The agent is the Agent Chain** (`@smthrs/chain`, a workspace package at `packages/smithers/agent/chain` — promoted 2026-08-15 from the vendored copy, which was the last living source after the upstream agent repo deleted it): a bootstrap authors one flow script per link, the trampoline runs it, and the journal — `ChainStarted · LinkAuthored · CallSettled · GateRejected · LinkEnded · SteeringDrained` — is the only state. The concierge chain runs **in the webview** behind the existing `AgentPort` seam, and since 2026-08-19 it is the ONLY chat backend: the flag and the second loop are gone, `/debug.backend` reports rather than switches, and every turn authors over `/api/model/stream`. Heavy or server-placed work is a sub-chain catalog call, not a second loop.

**Dependency law** (updated 2026-08-15; the vendored form below is superseded). Product code imports `@smthrs/chain`, `@smthrs/harness`, `@smthrs/model`, and `@smthrs/kernel` as pnpm workspace packages from this monorepo's `packages/` tree — the apps live at `apps/*` in `pnpm-workspace.yaml`, so the links come from the one workspace lockfile and no `file:` or sibling-checkout dependency exists. The property vendoring existed to buy — exactly one `effect` instance, because identity-keyed features (the `Redacted` registry, context references) fail across a pair — is now guaranteed by the workspace itself (single lockfile, `linkWorkspacePackages`) and asserted, not assumed: `apps/app/src/mainview/chain/deps.test.ts` fails if any dependency reintroduces a path specifier or if `effect` resolved from the app and from any `@smthrs` package realpath to different directories. The historical vendored mechanism (`vendor/smthrs/*` as `file:` deps, `scripts/vendor-smthrs.mjs`, `MANIFEST.json` as pin of record) is deleted; its rationale is preserved in git history. `src/shared/` (now the `@smthrs/rpc` workspace package at `packages/rpc`) stays runtime-free zod: it mirrors chain vocabulary and never imports it, which is what keeps the worker effect-free.

**Wire.** `AgentTurnFrame` grows a chain family — `link.authored`, `call.started`, `call.settled` (verdict `run | hit | replay`), `gate.rejected` (`shape | fuel | catalog | denied | call_failed | script_failed`), `link.ended` (`done | to | park`), `steering.drained`, `park` (`approval | event | timer | quota | plugin`). `runId` is the lineage id. The proxy vocabulary (`delta`, `done`, `card`, `card.update`) is unchanged; `tool_call` retires with the client tool loop.

**Catalog.** The command registry is the catalog: `agentVisible()` commands project as entries whose handlers run `executeForAgent` (actor `smithers`), plus `Catalog.system` (`sys/now`, `sys/random`), typed card entries (`card.show`, `card.update` — widgets are typed cards; no generative HTML in v1), worldview `remember`/`recall` bound to `worldDocuments`, and the recursive `agent` entry. `recall` shortlists with the keyword scorer and then asks Jev, through the Worker's `POST /api/jev` relay, for the order and for whether the wiki covers the query at all; it answers `{ covered, results }` and fails the call when Jev cannot decide, because the keyword order alone is not an answer. Every entry is journaled, envelope-gated, and disclosed exactly once (the double-declaration hazard is a resume-breaker).

**Journal residency.** Chain events persist as a `chainEvents` collection (same persisted-collection layer as every other row). This is the honest app-layer stand-in §13's "one durable database" eventually replaces: when the Smithers engine mounts, the collection becomes a sync-fed projection and the UI folds do not change. Acceptance tests assert journal contents, never runtime API.

**1.0 replay-safety amendment (2026-09-04, R13):** This collection is execution
authority, never a bounded diagnostic tail. Keep full active and completed
lineages until a replay-safe archive exists. Account sign-out/expiry/replacement
scrubs private events and atomically retains permanent hashed lineage-ID
tombstones; retired IDs refuse replay/reuse after reload. Ordinary chat archive
does not delete execution evidence. Collection adapters compare append positions
and wait for commit/rollback before serving reads. Independent tabs still need
single-writer lineage ownership; this is not an exactly-once external-effects
claim. Schema version 11 adds the retirement collection.

**Approvals.** `Authorize.layerRules` encodes the three-tier policy (free / ask-once-per-session-revocable / outbound-always-asks). `approval_required` parks the lineage without `LinkEnded`; approval resumes it, re-executing the link from its settled prefix. Denial is a journaled observation the next link routes around.

**Debug mode** is the same journal fold at full fidelity — seven read-only, admin-gated, command-registered surfaces: link x-ray (script, calls, `run|hit|replay` verdicts), two-histories diff, prompt inspector, event console, store inspector with revision scrubber, fetch wire tap (ring buffer around the injected `fetchImpl`; the only new capture), and the journal scrubber. Debug surfaces never mutate; mutating verbs arrive only as chain verbs.

**Decided defaults** (D1–D4 of the plan): new `/api/model/stream` worker route speaking full `ModelEvent`; worldview binds to `worldDocuments` now with `@smthrs/memory` underneath later; OPFS collection journal now; typed cards only. Chain gaps (live event tap, typed Control event, notifications-backed steering, park/wake) are fixed upstream in the agent repo, never as private mvp semantics.

**Deferred, deliberately.** The `/clear` sweep is a plain model call on `/api/model/stream`, not yet an authored flow (a background chain reading the transcript and writing worldview through `remember`); that conversion is mechanical and stays open. Closed 2026-08-19: the relay no longer holds a provider key at all. It forwards to the same managed-inference upstream `/api/agent/turn` uses, which owns the Cerebras key, authorizes the balance before the provider call, and meters the usage onto the vouched login — so per-user attribution came with the upstream rather than being rebuilt on the relay. Recorded here so the absences are decisions, not gaps.
