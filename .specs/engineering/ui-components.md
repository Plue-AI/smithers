# UI components: design builds, engineering wires

Version 0.5 · 2026-10-03 · Owner: engineering (contract), design (components) · Rulings: Will, 2026-10-02 (spec.md §14.2.1); minimal-code synthesis v1 §2 and v2, 2026-10-03

Design builds Views and visual components. Engineering uses the existing card file as the container, mapping data to props and callbacks to catalog commands. `CardRenderers.tsx` is the only mount point. Each card ticket owns its schema changes. No separate Container class, fixture layer or golden layer exists. The ticket that wires a View deletes the old card it replaces in the same change. Check: C-UI-13.

```
  topic → existing card file → <Card>View
               │
               └→ flows/cardActions.ts → catalog command
  CardRenderers.tsx mounts the card.
```

## Rules

- A View takes props only. It imports no state, store, topic, controller, flow, RPC client or command module, and it does no fetch (`flows/parity.test.ts`).
- A View never decides who may act. The container passes `actions[]` already filtered for the viewer, and the View renders them in order. A missing action means no button. A non-button gesture (hover, go to definition, a docs link) uses the action in `gestures`; a missing one means the gesture does nothing.
- A View handler does exactly one of three things (frontend lead, smithers-b8, adopted by the tech lead 2026-10-02). `flows/parity.test.ts` fails any other handler:
  1. It calls `onAction(action.tag, {...action.args, ...input})` with an action from `actions[]`, `gestures` or a row's own `actions`, and the control carries `data-flow={action.tag}`.
  2. It calls `onView(patch)` for per-member view state: maximize, tab, filter, scroll, selection, the cursor line, a timeline jump and hidden toasts. The container stores the patch in `collaborators.view_state` (§14.1.2), where the UI-only flows (`card.maximize`, `toast.dismiss`, B.1) write the same fields.
  3. It touches only React local state, DOM focus or the clipboard: roving tabindex, `onKeyDown`, Escape to close, controlled form inputs whose value is later sent through (1), hover and disclosures that don't persist, and Copy through `copyText` from `@smthrs/ui`, which has the `execCommand` fallback for plain-HTTP origins (T-UI-01 exports it).
- Tags are opaque to the View. T-APP-03 merges `CardActions.ts` and `InstallCardActions.ts` into `flows/cardActions.ts` and deletes both extra layers in the same change.
- Views live in `apps/app/src/mainview/cards/views/*View.tsx`. The existing card file binds `actions[]` and `gestures` through `flows/cardActions.ts` to `flowAction`. The View-seam rules also cover the branch tree, entry rows, Context line, Earlier archive, toasts, edge map and timeline. Their tickets update parity scans in the same change.
- View props are TypeScript types. Zod schemas exist only where data crosses HTTP or storage; the kept rpc card schemas are Todo, Draft, Setup, Settings, Confirm, Home, Members, `CardAction` and `CardPrimitives`. Private `@smthrs/rpc` card files need no public-API sign-off. Each card ticket updates §14.3 and this page with its own change.
- Copy follows §14.6b: product words, body blocks of 12 words or fewer, one sentence at most, and no explanatory sentences. Visual wrapping does not count. Check: C-UI-02.

## Completion gates

Each View ticket tests its View in `apps/app/src/mainview/cards/views/Views.test.tsx`; each wiring ticket tests its card file in its own suite. C-UI-13 is one test: every `*View.tsx` is reachable from `CardRenderers` and no replaced legacy card remains. The journey checks (C-J*) prove wiring end to end. No fixture or golden layer gates completion.

## Order of need

Stage 1 is on the critical path. Within a stage, design builds in J1 order, then J2, J4, J5 and J11. Each card ticket changes its own schema.

| # | Design ticket | Component | Wiring ticket | Stage | First need |
| --- | --- | --- | --- | --- | --- |
| 1 | [T-UI-01](tickets/T-UI-01.md) | `ActorChip`, `StateWord`, `Tone` primitives | T-APP-09 | S1 | every card |
| 2 | [T-UI-02](tickets/T-UI-02.md) | `SetupView`, `SettingsView` | T-APP-03, T-FLW-12 | S1 | J1.2–J1.4 |
| 3 | [T-UI-07](tickets/T-UI-07.md) | Conversation shell: `BranchTree`, `EntryRow`, `ContextLine`, Earlier archive | T-APP-16, T-APP-17 | S1 | J1.5, the first question |
| 4 | [T-UI-06](tickets/T-UI-06.md) | `HomeView` (with the `main` sync row and Retry) | T-APP-01, T-GH-07 | S1 | J1.5: `main`'s conversation opens on it |
| 5 | [T-APP-15](tickets/T-APP-15.md) | File on the existing `CodeFileView`; `DiffView` folded into `DiffSurface` | T-APP-15 | S1 | J1.5: the answer's file cards |
| 6 | [T-UI-03](tickets/T-UI-03.md) | `DraftView` | T-APP-02 | S1 | J1.6, J2.2 |
| 7 | [T-UI-04](tickets/T-UI-04.md) | `TodoView`: states, question and approval forms, failure, evidence, PR, merge and repair controls (absorbs T-UI-04) | T-APP-02, T-STK-08, T-MCH-08, T-GH-06 | S1 | J1.6–J1.7; repair: J7, J10.3 |
| 8 | [T-UI-08](tickets/T-UI-08.md) | `ToastStack`, `EdgeMap`, `Timeline` (Allow notifications variant at S2) | T-APP-07, T-APP-18 | S1 | J1.6: background progress |
| 9 | [T-UI-05](tickets/T-UI-05.md) | `ConfirmView` (`one_click`, `review_merge`) | T-APP-04 | S1 | J1.7 by an agent, J6 |
| 10 | [T-UI-09](tickets/T-UI-09.md) | `MembersView` | T-APP-06 | S1 | J1.8 |
| 11 | [T-UI-14](tickets/T-UI-14.md) | `CommandsView` (`/help`) | T-UI-14 (`CommandsContainer.tsx`), T-CAT-01 | S1 | any journey |
| 12 | [T-UI-10](tickets/T-UI-10.md) | `FlowView` | T-APP-05 | S1 | J5 |
| 13 | [T-FLW-07](tickets/T-FLW-07.md) | Run monitor and Inspect: `RunTraceCard.tsx` reshaped in place | T-FLW-07 | S1 | J11 |
| 14 | [T-FLW-08](tickets/T-FLW-08.md) | Model roles: restored `ModelCards.tsx` slice; `AgentCards.tsx` | T-FLW-08 | S1 | J11 |
| 15 | [T-UI-15](tickets/T-UI-15.md) | `BranchView` (with moved-off controls) | T-APP-10, T-COL-05 | S2 | J3, J7 |
| 16 | [T-UI-16](tickets/T-UI-16.md) | File and Diff states: reload, gone, renamed, Restore, Compare | T-APP-11 | S2 | J3 |
| 17 | [T-UI-17](tickets/T-UI-17.md) | `TerminalView` | T-APP-12 | S2 | J3, J6 |
| 18 | [T-UI-18](tickets/T-UI-18.md) | `SecretsView` | T-APP-13 | S2 | J1.8 |
| 19 | [T-UI-21](tickets/T-UI-21.md) | `DocsView` | T-APP-20 | S2 | any journey |
| 20 | [T-UI-22](tickets/T-UI-22.md) | `DebugApiView` | T-APP-21 | S2 | J11 |
| 21 | [T-UI-19](tickets/T-UI-19.md) | Co-editing visuals on the File card (CodeMirror restored by T-APP-14) | T-APP-14 | S3 | J3.5, J8 |
| 22 | [T-UI-20](tickets/T-UI-20.md) | `ProposalView` and the lessons receipt | T-FLW-06 | S3 | J5, J8 |

Retained cards keep their existing schemas and renderers, outside `cards/views/` and the View-seam rule. Spec §14.3.0 lists them with the ticket that owns each one. A field change to one of them is a spec change that first adds its §14.3 row.

Design tickets fold the seven one-user sub-Views into their parents (`HomeRowView`, `HomeActionView`, `TodoActionView`, `CommandActionView`, `MembersActionView`, `EdgeGroupView`, `ToastNoticeView`) and merge `styles/views/*.css` into each card's existing CSS without the `mvp-` prefix.

The S2 and S3 props sections (T-UI-15 to T-UI-22) are deleted until their stage. Each of those tickets writes its props here when its stage starts, as TypeScript types (minimal-code synthesis v2).

## Tone

One table for design and engineering. The host derives tone (§14.5.2); design maps each tone to one Paper token: live is teal, attention is gold, failed is ember, done and quiet are neutral.

| Subject | Tone |
| --- | --- |
| TODO starting or working; any run while it executes | live |
| TODO needs_you; stack attention (`order`, `force_push`); a toast for an approval | attention |
| TODO failed; a run failed or interrupted | failed |
| TODO merged; a run done | done |
| TODO queued, paused, in_review or dropped; an entry with no run | quiet |

In review is quiet. A person is needed only for the first item in order, and its Merge action already says so (design README "One meaning per color"; mvp.md §6.4 names only Needs you gold and failures ember).

## Shared types

```ts
type PersonRef = { login: string; name: string; avatar_url: string }
type Actor = ( | { kind: "person"; login: string; name: string; avatar_url: string
                   via?: "ssh" | "terminal" | "cli" }           // "Maya via SSH", "Ben's terminal", "Ben via CLI"
               | { kind: "agent"; id: string                    // participant id, stable per session or run (§14.6a.1)
                   agent: "smithers" | "coding" | "reviewer" | "claude-code" | "codex" | "external"
                   avatar_url: string; session_id?: string; run_id?: string
                   for_member?: PersonRef                       // no added authorization rights
                   name?: string                                // a step's agent ("planner") or an external agent's name
                   todo?: number }                               // "Claude Code for Ben"; TODO when ambiguous
               | { kind: "system" }                            // install event; Smithers is an agent participant
               | { kind: "github"; login: string }              // "@login" with the GitHub mark
               | { kind: "outside" } )                          // "Changed outside Smithers"
             & { color_index: number }
// M-34: every agent doing work is a participant with its own avatar in presence, activity, line flags and terminals.
// color_index: 0–5 a member's colour, stable per member; an agent or Smithers acting for a member takes that member's;
// 6 an agent acting for nobody; 7 neutral (GitHub users, outside writes). Design maps indexes to Paper tokens.

type TodoState = "queued" | "starting" | "working" | "needs_you" | "paused"
               | "failed" | "in_review" | "merged" | "dropped"       // §4.1
type Tone = "live" | "attention" | "failed" | "done" | "quiet"      // §14.5.2, the Tone table above
type NeedsYouKind = "question" | "approval" | "conflict" | "moved_off" | "foreign_push"
type SyncHealth = "fresh" | "stale" | "limited" | "refused"       // §4.4
type MachineState = { state: "awake" | "asleep" | "waking" | "closed" }
                  | { state: "waiting"; position: number }          // "Waiting for a machine · #2"
                  | { state: "failed"; error: { class: string; message: string } }   // with Retry (§4.2)

type Merge = {                                  // §10.6.2a; one object on TODO, Home rows and Confirm
  state: "ready" | "waiting" | "blocked" | "merging" | "done"
  // ready: MergeReady holds. waiting: the block clears by itself (order, rechecking, pending_work,
  // a required check still running). blocked: a person must act (state, attention, stale_head,
  // a failed required check, github). merging: the merge fence is set. done: merged.
  reason?: "state" | "order" | "attention" | "merging" | "rechecking" | "pending_work"
         | "stale_head" | "checks" | "review_required" | "github"   // MergeReady's first failing row; absent when ready or done
  detail?: string                               // Tn for order, the check's name for checks, GitHub's text for github
  on_github: boolean                            // the block is GitHub's (stale_head, checks, review_required, github): the control links to the PR
}

type EvidenceItem =                             // §10.4.3, T-STK-01
  | { kind: "diff"; files: number; added: number; removed: number }
  | { kind: "check"; name: string; state: "running" | "passed" | "failed"; took_s?: number; log_url?: string }  // run on the machine
  | { kind: "github_check"; name: string; state: "pending" | "passed" | "failed"; required: boolean; url: string }
  | { kind: "review"; summary: string }         // the agent's review summary
  | { kind: "usage"; tokens: number; time_s: number }
  | { kind: "flow"; name: string; version: string }   // the attempt's pinned flow version
  | { kind: "model_access"; label: string }     // "OpenAI key · gpt-5.2", "ChatGPT sign-in" (§15.2)
type Evidence = { attempt: number
                  revision: string              // the accepted generation's PR head, short sha
                  items: EvidenceItem[]
                  previous?: { revision: string; items: EvidenceItem[] }  // an earlier generation's review, shown
                                                                          // when its patch-id equals this one's (§10.4.3)
                  reviewing?: boolean }         // the review of `revision` is running

type Action = {                 // filtered for the viewer by the container
  tag: CatalogTag               // the catalog's tag type (T-CAT-01), opaque to the View
  label: string                 // "Answer", "Merge", "Retry"
  args?: Record<string, string> // bound by the container, e.g. { n: "12" }; the View passes them back unchanged
  primary?: boolean
  disabled?: { reason: string } // e.g. "Waiting for T8"
  input?: FormField[]           // present when the action needs a form
}
type FormField = { name: string; label: string; kind: "text" | "choice" | "secret"; choices?: string[]
                   required: boolean; value?: string; multiline?: boolean }   // value: prefill

type BaseView = { maximized: boolean; tab?: string; filter?: string }
type CardProps<M, V = {}, G extends string = never> = {
  model: M
  actions: Action[]                             // buttons, in order
  gestures: Partial<Record<G, Action>>          // non-button gestures by name
  onAction: (tag: CatalogTag, input?: Record<string, string>) => void
  view: BaseView & V                            // this member's view state (§14.1.2)
  onView: (patch: Partial<BaseView & V>) => void
}
```

## Props per component

### T-UI-01 Primitives

```ts
type ActorChipProps = { actor: Actor; size: "s" | "m"; live?: boolean }   // live: the agent is working now (Branch.tsx)
type StateWordProps = { state: TodoState; step?: string }   // "Working · Implement"
```

### T-UI-02 Setup and Settings (`install` topic)

At once / settings.parallel is absent in S1 and is bound only after T-STK-03's S2 backend guard lands. T-APP-03 implements the S1 controls. Check: C-J4-01.

Capacity 0 renders "No machine fits", the supplied limiting term and fix link on one line. The third role UI label is "Decisions"; its key field remains "AI Gateway key". 

```ts
// One step identity and order: spec §16.2 and T-INS-06 steps 0–6. T-INS-06 stores each step under `setup.<id>`
// and reports these states, so the container passes them through with no mapping. The squash check runs inside
// `repository` and blocks it with its fix link (§10.6.2); §16.2 step 1 is the setup session itself.
type SetupStepId = "address" | "app_manifest" | "sign_in" | "repository" | "models" | "source" | "machine"

// app_manifest uses POST /api/install/setup/app; no github_app route alias exists (C-J1-02).
type SetupStep = {
  id: SetupStepId
  state: "pending" | "running" | "done" | "blocked" | "failed"   // a step's control enables when the step before it is done
  blocked?: { line: string; fix_url: string }      // "Enable squash merging on GitHub ↗"
  error?: { class: string; message: string }       // §6.2.3; the row shows Retry
  pct?: number                                     // source and machine while running
}
type ModelRole = {
  role: "fast" | "coding" | "jev"                  // visible: "Fast model", "Coding model", "Decisions" (mvp.md §6.5)
  provider: string                                 // "Cerebras", "OpenAI", "AI Gateway"
  key: "none" | "validating" | "saved" | "failed"  // jev's key field reads "AI Gateway key"
  error?: string                                   // the provider's reason, from the typed error (§6.2.3)
}
type SetupModel = {
  address: { listen: "mac" | "network"; bind: string; origins: string[] }   // §16.3.1
  steps: SetupStep[]                               // all seven, in order
  this_mac: { memory_gb: number; disk_free_gb: number; capacity: number
              limit?: { term: string; fix: string } }   // capacity 0: the limiting term and its fix (§8.2.1a)
  github: { owner?: string                        // the account that owns the repository, asked in `app_manifest` (§12.1.1)
            signed_in: boolean; app_installed: boolean; squash_allowed?: boolean }
  repository?: { owner: string; name: string }
  repositories?: string[]                          // choices while the repository step runs
  models: ModelRole[]                              // fast, coding, jev
  chatgpt: boolean                                 // coding may use the owner's ChatGPT sign-in (§15.2)
}
type SettingsModel = SetupModel & {
  capacity: number; parallel?: number              // parallel is absent in S1; S2 T-STK-03 guards the TODOs at once stepper (C-J4-01)
  laptop_lines: string[]                           // `smthrs login <origin>`, one per origin
  notifications_need_https: boolean                // the viewer's origin is plain HTTP and not localhost (§14.6)
  health: { process: "ok" | "degraded"; postgres_bytes: number; disk_free_gb: number
            github: { health: SyncHealth; cause?: string; retry_at?: string
                      rate_remaining: number; rate_limit: number } }   // §20.2, T-APP-03
  obsidian?: { path: string; last_sync_at?: string; error?: string }   // [S2] T-FLW-12
}
// Setup buttons: each step's one control, Retry on a failed step. Settings buttons: Change (models), Repair (GitHub),
// the two steppers, the Obsidian folder field, and "Notifications need HTTPS ↗" (the `docs` action with
// args { page: "quickstart#put-https-in-front" }, C-UI-09 step 3; absent until `/docs` ships at S2).
// Add to machine image (image.add: a package field; opens a Draft, C-APP-03). Copy lines use copyText.
```

### T-UI-03 Draft

When `private` is true, the header shows the small "Only you" lock chip used by Confirm. Commit removes the chip. 

```ts
type DraftModel = {                  // spec §14.3 Draft
  title: string
  prompt: string
  acceptance: string[]
  place: { mode: "append" | "before" | "amend"; n?: number        // n with before and amend
           options: { n: number; title: string; state: TodoState }[] }   // unmerged items only
  issue?: { number: number; title: string; url: string; fixes: boolean }   // "Closes #i when merged"
  seed?: { files: string[] }         // a seed patch, shown read-only
  committed?: { n: number; rev: number }   // rev 1: "Committed <title>"; rev > 1: "+1" on Tn
  private: boolean                   // true until Commit: only the author sees it
}
type DraftViewProps = CardProps<DraftModel, {}, "set">
// gestures.set: a field edit, sent on blur as { field: "title" | "prompt" | "acceptance" | "place" | "fixes", value }
// value is a string: title/prompt unchanged; acceptance JSON.stringify(string[]);
// place JSON.stringify({ mode: "append" | "before" | "amend", n?: number }); fixes "true" or "false".
// Emit place properties in mode, n order; omit n for append. The View test asserts literal strings.
// Commit forwards the complete supplied Draft input; the owning card ticket reconciles typed input.
// Discard binds draft.discard {draft: DraftId}; person or app agent, author only. It deletes the author’s uncommitted private Draft, never a TODO. The runtime strict z.object accepts only draft; the server policy enforces authorship (C-CAT-01).
// It deletes the author's uncommitted private Draft and never drops a TODO (C-CAT-01).
// (`form.set` into the entry's card column, T-APP-02). buttons: Commit ("Commit puts it on the stack as T12"), Discard.
// Make TODO is the Issue card's button that opens a Draft.
```

### T-UI-04 TODO (`todo:<n>` topic)

A question and moved_off can be open together. Render separate wait rows and actions, primary first; T-UI-04 supplies the repair form. 

```ts
type TodoModel = {
  n: number; title: string; state: TodoState; owner: PersonRef 
  owner_removed?: boolean                         // Take over (§5.6, C-APP-01)
  place?: number                                  // 1 is next to merge; absent once merged or dropped
  queue?: { reason: "machine" | "merge_order" | "rebase"; after?: number; position: number }  // View renders the copy (spec §4.1.1)
  rebase_pending?: { onto: string }               // "Rebase pending onto T2" (§4.2)
  step?: string                                   // the current step's label
  prompt_revisions: { text: string; acceptance: string[]; by: Actor; at: string }[]   // revision 1 first; later ones show as "+n"
  issue?: { number: number; url: string; fixes: boolean }   // "from #i"; "closed #i" once merged when fixes
  branch: { id: string; name: string; machine: MachineState }
  present: Actor[]                                // everyone on its branch, agents included (M-34)
  steps: ( { id: string; label: string; detail?: string
              state: "done" | "current" | "next" | "failed" | "waiting" | "paused" }
          | { id: "merge"; kind: "wait"; state: "held" | "done" | "next"; since?: string } )[]
                                                  // the run's trailing wait for merge (spec §10.4.1)
  run?: { id: string; attempt: number
          indicators: { tone: "wait" | "thrash"; text: string }[] }
                                                  // "Waiting for a person since 10:42";
                                                  // "Thrashing: TestRetryBackoff failed 3×" (spec §11.6.4)
  waits: { id: string; kind: NeedsYouKind; prompt: string; since: string
           paths?: string[]                       // conflict
           ssh_line?: string                      // conflict view, S1; supplied by the card file (§10.5.4)
           by?: Actor; sha?: string               // foreign_push, moved_off
           actions: Action[] }[]                  // every open wait, primary first (§4.1.0a), each with its own action
  first_answer?: { by: Actor; text: string; at: string }   // "Ben answered" after the latest question settled
  steers: { text: string; by: Actor; at: string }[]        // authored steers, in order (§10.7.3, C-J3-05)
  failure?: { step: string; class: string; message: string; retryable: boolean
              missing_tool?: { name: string; file: string } }   // Add to machine image (§8.6.2, C-APP-03)
  evidence: Evidence[]                            // one per attempt that has any, oldest first (§10.4.3, C-J2-04)
  pr?: { number: number; url: string; head: string; draft: boolean; draft_after?: number
         included_items: number[] }               // "Includes T3, T4 until they merge" (§12.5.1)
  merge: Merge
  approval_cleared?: boolean                      // "Approval cleared by rebase · checks rerun"
  merged_via?: number                             // "Merged · in T15's commit"
  lessons?: number                                // absent while learning runs
}
// buttons by state (T-UI-04): Answer, Send as steer, Steer, Stop, Resume, Retry, Retry with the current flow,
// Drop, Amend, Edit (Queued: todo.amend with prefilled inputs), Take over, Add to machine image,
// Merge, Review & merge, Rebase now, Open branch, Inspect. A late answer's 409 keeps the typed text
// in local state behind Send as steer. T-UI-04 builds Resolve, Done (conflict), Bring in, Discard, Fork, Add to stack.
```

### T-UI-05 Confirm (`confirmations:<member>` topic)

```ts
type ConfirmModel = {
  kind: "one_click" | "review_merge"
  action: { tag: CatalogTag; verb: string }       // verb label only; never dispatch this initiating tag
  summary: string                                 // one line
  subject: { kind: "todo" | "branch" | "flow" | "agent" | "wiki"; ref: string; revision?: string }
                                                  // the A✓ commands (Appendix B legend); members, secrets
                                                  // and settings are agent: never and have no confirmation
  text?: string                                   // one_click: the exact words the command sends
  asked_by: Actor                                 // "Claude Code for Ben"
  review?: { title: string; place: number; pr: { number: number; url: string }
             evidence: Evidence                   // the subject revision's evidence, each check shown (Confirm.tsx)
             approved_revision?: string           // "You approved 1b2c3d4; it is now at 9e8f7a6"
             merge: Merge }                       // review_merge only
  receipt?: { by: PersonRef; result: "done" | "cancelled" | "expired"; at: string; text?: string }   // "Steered T9"
}
// buttons: the verb (one_click) or Merge / Review & merge, on GitHub ↗, and Cancel 
// Verb, Merge / Review & merge and Cancel dispatch their supplied actions[] entries, not model.action.tag.
// T-APP-04 binds approve/deny with subject/revision in args. Cancel binds confirm.cancel
// with {confirmation, revision}; person only, no agent path, pending confirmations only (C-ACC-02). Use the existing Confirm revision schema; stale revision returns typed stale (C-ACC-02).

// T-STK-04 owns the prs.land handler and merge route; T-APP-04 binds the control only (C-STK-04, C-ACC-02).
// The View test asserts literal approval, denial and cancellation payloads.
// Only the person who must press sees this card; other viewers see nothing (C-ACC-02).
```

### T-UI-06 Home (`home` topic)

```ts
type HomeModel = {
  repository: string                              // the card title
  main: { sha: string; title: string; last_success_at: string
          health: SyncHealth; cause?: string; retry_at?: string }   // limited: "retries at 10:42"; refused: cause and Fix
  attention: { kind: "order" | "force_push"; text: string; todo?: number; actions: Action[] }[]
  items: (Pick<TodoModel, "n" | "title" | "state" | "owner" | "place" | "queue" | "step" | "rebase_pending"
                        | "merge" | "approval_cleared" | "lessons"> & {
           needs_you?: { kind: NeedsYouKind; prompt: string }
           pr?: { number: number; draft: boolean }
           branch: { id: string; name: string }
           present: Actor[]; elapsed_s?: number   // elapsed while live
           amendments: number
           actions: Action[] })[]                 // the row's one action, then the ⋯ menu: Move up, Move down, Drop
  counts: Record<TodoState, number>
  merged_since_last_look: number[]
  machines: { in_use: number; capacity: number
              slots: { branch: string; actor: Actor; awake: boolean }[] }   // who holds each machine (Home.tsx)
  parallel?: number                               // owner only
  background_runs: { id: string; title: string; state: "queued" | "running" | "waiting" | "failed"
                     detail?: string; actions: Action[] }[]   // Retry and Dismiss on a failed run (B.4)
}
// buttons: Retry (main sync), Fix (refused sync, opens Settings), New TODO, each row's actions 
// The 1 s clock uses useClock from @smthrs/ui/clock; no mainview useEffect import .
// Home tests cover attention/background actions and owner/non-owner main.reset-to-github.
// HomeView reports onView({on_screen: boolean}) through an IntersectionObserver in a ref callback.
// card file advances last look after 2 s on screen (C-J4-01).
type HomeViewState = { on_screen?: boolean }
type HomeViewProps = CardProps<HomeModel, HomeViewState>
```

### T-UI-07 Conversation shell

Private entries show the Draft "Only you" lock chip. A tombstone shows only the card title in one muted line, with no summary or action. The final muted branch-tree node reads "Earlier · N" and opens archives with a "Read-only" chip and no mutation controls. 

[S2, M-38] T-AGT-03 supplies existing chat components with normalized message/tool/error parts plus `origin: "external"`, `agent_kind: "claude-code" | "codex"`, `format_version: string`, `source_id: string`, `session_id: string`, `actor: Actor` and `read_only: true`. Tool calls/results retain their correlation id; edit reports retain path and reported outcome. Mutation action lists are empty. Copy, disclosure and navigation use existing handlers. smithers-06 owns presentation in T-UI-07 and T-UI-01; smithers-b8 owns binding. No new View or card is introduced. Check: C-AGT-02.

```ts
// Open branches only; a closed branch's conversation opens from its merged TODO.
// "earlier" is the single read-only node for legacy per-member conversations (spec §14.1.5).
type BranchTreeNode = { id: string; name: string; kind: "main" | "item" | "scratch" | "earlier"
                        todo?: number; state?: TodoState; present: Actor[]; children: BranchTreeNode[]
                        archive_count?: number; action?: Action }   // archive_count required for earlier
type BranchTreeView = { selected_branch?: string }
type BranchTreeProps = { nodes: BranchTreeNode[]; view: BranchTreeView
                         onAction: CardProps<unknown>["onAction"]
                         onView: (patch: Partial<BranchTreeView>) => void }
// A node with action dispatches onAction(action.tag, action.args) and carries data-flow.
// A node without action emits onView({ selected_branch: node.id }); no command.
type EarlierArchiveModel = { node: BranchTreeNode & { kind: "earlier"; archive_count: number }
                             archives: { id: string; title: string; entries: React.ReactNode[] }[]
                             read_only: true }
type EarlierArchiveView = { selected_archive?: string }
type EarlierArchiveProps = { model: EarlierArchiveModel; view: EarlierArchiveView
                             onView: (patch: Partial<EarlierArchiveView>) => void }
// Earlier has no mutation action or onAction. Selection emits selected_archive.
// React nodes are rendered slots, not serialized rpc fields.
type EntryRowProps = {
  kind: "prompt" | "answer" | "card" | "event"
  author: Actor; title: string; summary?: string; tone: Tone; state?: TodoState
  context?: { count: number; items: { kind: "file" | "page" | "todo" | "run" | "issue"; label: string
                                      ref: string; revision?: string }[] }   // §15.1.2 context[]
  action?: Action; private?: boolean; card?: React.ReactNode
  tombstone?: boolean   // true: title only; ignore summary, action and card
  onAction: CardProps<unknown>["onAction"]
}
type ContextLineProps = { count: number; items: NonNullable<EntryRowProps["context"]>["items"]; expanded: boolean
                          onView: (patch: { expanded: boolean }) => void }
```

### T-UI-08 Toasts, edge map, timeline

Show at most three notices. "+N more" opens all hidden entries through local disclosure state; the supplied `toasts` array includes those entries and `more` is their hidden count. Keyboard activation opens the same disclosure. Timeline and wide edge rows start at ≥1180 px. 

```ts
type Toast = { id: string; title: string; detail?: string; tone: Tone; action?: Action; entry_id: string
               kind: "needs_you" | "approval" | "in_review" | "failed" | "conflict" | "merged"
                   | "progress" | "allow_notifications" }
type ShellView = { toast_hidden?: string; jump_to?: string
                   on_screen?: [first: string, last: string]; timeline_visible?: boolean }
// Shell reports its visible entry band; Timeline reports its visibility.
// T-APP-07 turns patches into the timeline_visible lease and band (C-UI-04).   // per-member view state (§14.4.2, §14.5.4)
type ToastStackProps = { toasts: Toast[]; more: number; onAction: CardProps<unknown>["onAction"]
                         onView: (patch: ShellView) => void }   // Hide: onView({ toast_hidden: id })
type EdgeMapProps = { above: Toast[]; below: Toast[]; narrow: boolean   // two rows max plus a count
                      onAction: CardProps<unknown>["onAction"]; onView: (patch: ShellView) => void }
type TimelineProps = { lines: { entry_id: string; kind: EntryRowProps["kind"]; title: string; summary?: string; tone: Tone }[]
                       on_screen: [first: string, last: string]
                       onView: (patch: ShellView) => void }  // a click: onView({ jump_to: entry_id })
```

### T-UI-09 Members (`members` topic)

```ts
type MembersModel = { members: { login: string; name: string; avatar_url: string; color_index: number
                                 role: "owner" | "maintainer" | "member"
                                 needs_access: boolean            // never had write access on GitHub
                                 suspended: boolean               // lost it; suspension is automatic (M-05, §5.1.3)
                                 actions: Action[] }[]            // Role, Remove
                      access_url: string }                        // the repository's GitHub access settings
// buttons: Add (by username), Role, Remove. Every Members command is person-only (agent: never).
```

### T-UI-10 Flow (`flows` topic)

```ts
type FlowModel = {
  name: string; source: { builtin: true } | { path: string }   // "flows/<name>/flow.ts"
  versions: { id: string; state: "active" | "proposed" | "merged-syncing" | "merged-failed" | "previous"
              todo?: number; error?: string
              steps: ( { id: string; label: string; detail?: string; agent?: string; added?: boolean }
                     | { id: "merge"; wait: true; signals: { on: "rebase" | "steer"; to: string }[] } )[] }[]
                                                  // TODO flow: clean rebase → check; resolved conflict → implement → check → review; steer → implement (§10.4.1)
// added: relative to Active; adapter sets it, View marks it (C-J5-01).
// The version chip selection uses React local state; it emits no view patch.
}
// buttons: Source, Plan, Run, Edit
```

### T-APP-15 File (read-only) and Diff

The File card renders through the existing `CodeFileView` (`@smthrs/ui` `adapters/code-view`) via `cards/CodeSurface.tsx`. Revert the CodeMirror adapter, `CodeEditorView` and the `@codemirror/*` and `y-codemirror.next` pins from 4a36b0cfb; T-APP-14 restores them in S3. Fold `DiffView` into `cards/DiffSurface.tsx`. Check: C-UI-13.

Binary and too-large content render one muted line with a formatted size (fixtures: "Binary file · 1.2 MB" and "Too large to co-edit · 4.1 MB") plus the supplied "on GitHub ↗" link. They render no editor. Keyboard equivalents of Ctrl-hover tooltip and F12 definition emit the supplied gestures without moving the text cursor.

```ts
type FileModel = FileBase & FileStates & CoEdit  // one schema, `FileCard.ts`; S2 and S3 fields are absent or empty before their stage
type FileBase = {                                 // `branch:<id>:files` (§14.3 File)
  path: string; branch: string; language: string; digest: string
  github_url?: string   // required for binary and too_large: "on GitHub ↗"
  content: { kind: "text"; text: string }         // UTF-8
         | { kind: "too_large"; bytes: number; text: string }   // over 1 MiB: muted size line and GitHub link, no editor
         | { kind: "binary"; bytes: number }      // no editor
  mode: "read_only" | "live"                      // live only at S3, for text up to 1 MiB
  last_writer?: Actor
  diagnostics: { line: number; col?: number; severity: "error" | "warning"; message: string }[]
  hover?: { line: number; col: number; markdown: string }   // the result of the last hover gesture
  reveal?: { line: number; col?: number; to_line?: number } // a same-file definition, or a cited range
}
type FileView = { line?: number; compare?: boolean }         // the viewer's cursor line feeds presence {path, line} (§7.6)
type FileProps = CardProps<FileModel, FileView, "hover" | "definition">   // rendered by CodeSurface over CodeFileView;
                                                                         // the live binding arrives with T-APP-14 (S3)
// Gestures: hover raises onAction(gestures.hover.tag, { path, line, col }); the container answers through
// `hover`. Definition raises onAction(gestures.definition.tag, { path, line, col }); the container opens the
// target's File card, or sets `reveal` when the target is in this file. line is 1-based; col counts UTF-16 units.
// Read-only mode: a changed content.text updates the same view with no remount, so scroll and the cursor
// line survive (T-APP-11).

type DiffModel = {
  path: string; branch: string
  against: { kind: "item_base"; rev: string }     // an item: the previous item's candidate (§12.5.1)
         | { kind: "fork"; rev: string }          // a scratch branch: its fork revision (§8.5.3b)
         | { kind: "burst"; burst: string; actor: Actor; at: string }   // one burst, before → after (§9.3.4)
  change: "added" | "modified" | "deleted" | "renamed"; renamed_to?: string
  binary?: { before_bytes: number; after_bytes: number }
  hunks: { old_start: number; new_start: number; lines: { op: " " | "+" | "-"; text: string }[] }[]
}
// buttons: Restore this file (against.kind burst only, §9.3.5)
// DiffSurface (with DiffView folded in) reuses @smthrs/ui/adapters/pierre-diff-view; serialize hunks to its unified patch.
// Count context/removal lines for the old range and context/addition lines for the new range;
// preserve op/text and file paths, with /dev/null for added/deleted sides. The View test pins literal patches.
```

### T-FLW-07 Run monitor and Inspect (`run:<id>` topic)

```ts
type PhaseTone = "live" | "ok" | "fail" | "thrash" | "wait"
// Run is the UI name. No new RunView: RunTraceCard.tsx and RunTracePhaseStrip.tsx are reshaped in place to
// take these props, and RunsCards.tsx folds into the same card (T-FLW-07). Props are TypeScript types.
type RunModel = {
  id: string; flow: string; version: string; title: string
  todo?: number; branch?: string
  state: "running" | "waiting" | "held" | "failed" | "done" | "interrupted"
  held?: { since: string }                        // the trailing wait for merge
  attempts: {                                     // a TODO's attempts oldest first; one for any other run
    n: number; run_id: string; state: "running" | "waiting" | "held" | "failed" | "done" | "interrupted"
    graph: { id: string; label: string; state: "done" | "current" | "waiting" | "failed" | "next" | "held"
             deps: string[] }[]
    steps: { key: string                          // stable per step instance: "<step id>#<k>"
             id: string; k: number                // the flow step, and its k-th execution in this attempt
             label: string; state: string; started_at?: string; ended_at?: string; took_s?: number
             input?: unknown; output?: unknown; agent?: Actor
             usage?: { tokens: number; cost_usd: number } }[]   // absent for a step with no model call (C-J11-01)
    phases: { id: string; step: string            // stable id; step is the step instance key
              title: string                       // deterministic: the step plus its recorded output,
                                                  // e.g. "Ran checks · 2 failed" (spec §11.6.3)
              summary?: string                    // agent:fast one-liner, rendered as a model summary;
                                                  // absent while pending or failed: the View shows the title alone
              took_s: number; tone: PhaseTone; indicator?: string
              cells: { id: string                 // stable
                       kind: "context" | "read" | "edit" | "run" | "think" | "ask" | "steer" | "reviewer" | "rebase"
                       label: string              // deterministic, e.g. "Read retry.ts", "Ran pnpm test · 1 failed"
                       explain?: string           // agent:fast explanation of an agent-written cell, rendered as a
                                                  // model summary; absent: the label stands alone
                       code?: string; output?: string; quote?: string
                       tone?: PhaseTone; took_s?: number; tokens?: number; actor?: Actor }[] }[]
  }[]
  waits: { id: string; kind: "question" | "approval" | "pause" | "sleep" | "signal" | "external_job"
           label: string; since: string
           settled?: { by: Actor; at: string } }[]   // "answered by Ben", and when (C-J11-01)
  tokens: number; time_s: number; cost_usd: number
  engine: { label: string; detail: string }[]     // Appendix C labels, collapsed row
  journal?: { seq: number; at: string; type: string; step?: string; text: string }[]
                                                  // read-only; the container loads it when view.tab is "journal"
  replay?: { at: number; last: number }           // journal seqs; at < last while scrubbing; the container
                                                  // re-projects the model at `at` and sends no write (§11.6.2)
}
type RunView = { selected?: string; at?: number }  // the selected cell id; the scrubber position
type RunViewProps = CardProps<RunModel, RunView> & { custom?: React.ReactNode }
// custom: the flow's declared view (the descriptor's `presentation`, §11.6.2), rendered by the container
// and placed by the View as the "View" tab. buttons: Inspect, Steer, Stop, Retry (interrupted)
```

### T-FLW-08 Agent and model roles

No new AgentView. Restore the model-assignment slice of `cards/ModelCards.tsx` and `flows/entries/model.ts` from `39e43c0f^`, without the laboratory, and delete `views/SettingsModels.tsx` (786f9ac5) as its duplicate (ruling 5). The Agent card stays `cards/AgentCards.tsx`. Use Decisions as the third-role UI label. Keep the internal role id jev.

```ts
type AgentModel = {
  name: string                                    // planner, implementer, reviewer, app agent
  instructions_path: string                       // TODO-flow prompts beside the flow source;
                                                  // ".smithers/instructions/app.md" for the app agent (spec §11.5a)
  role: "fast" | "coding" | "jev"; model: string; provider: string; available: string[]
                                                  // visible role names: "Fast model", "Coding model", "Decisions" (mvp.md §6.5)
  runs: { id: string; title: string; state: string; at: string }[]   // runs it took part in
  owner: boolean
}
// buttons: Change model (owner only), Edit instructions (opens a Draft TODO)
// Change model binds settings.model.set {role, model}; owner session only, agent: never. Use the existing
// model-role enum (including jev) and model-catalog id schema; the HTTP route parses the input strictly.
// Edit instructions uses the supplied Draft-opening tag with prefilled text, never a TODO commit.
```

### T-UI-14 Commands (`/help`)

Advanced starts collapsed and supports keyboard disclosure. The model comes from the live command registry, like `chat.commands`; `CommandsCases.ts` and `CommandsExpectations.ts` are deleted. The supplied `agent` policy renders a muted trailing "Asks first" for confirm or "Only you" for never; run renders no mark.

```ts
type CommandsModel = { groups: { label: string; advanced: boolean
                                 commands: { tag: CatalogTag
                                             synopsis: string       // "/todo.answer Tn"
                                             description: string    // "Answer the agent's question" (Appendix A)
                                             agent: "run" | "confirm" | "never" }[] }[] }
```

### TODO repair props (T-UI-04)

```ts
type TodoRepairSlots = { conflictTerminal?: React.ReactNode } // rendered by the card file for the selected conflict; never part of TodoCard or imported by packages/rpc
// No model of its own: TodoModel (§ T-UI-04). It renders the waits[] of kind conflict (paths; the S1 conflict
// view with the terminal and SSH line), moved_off (by) and foreign_push (by, sha), and the card's Fork and
// Add to stack actions (§8.5, §9.3.8, §10.5.4, §12.3).
// buttons: Done and, from S2, Resolve (conflict); Resolve (moved_off); Bring in and Discard (foreign_push); Fork; Add to stack
```

**Merge blocker tones (design G12, 2026-10-02).** A failed required check is ember (`failed`). Gold (`attention`) is only for blockers where a person must act (`review_required`, a question, an approval). System or order waits (`order`, `machine`, `rebase`, `merging`) are neutral (`quiet`).

### T-UI-17 Terminal

`TerminalCardSchema` is retained for metadata crossing the live socket. The app View takes a `terminal: ReactNode` slot outside the serialized model, as with the S1 conflict terminal (§14.2.2b). T-APP-12 binds the existing `@smthrs/ui/adapters/terminal` to the transport.

```ts
type TerminalModel = {
  id: string; title: string; branch: string; owner: Actor
  agents: Actor[]; watchers: Actor[]; command?: string
  viewer_is_owner: boolean; frozen: boolean
}
type TerminalViewProps = CardProps<TerminalModel>
// App-only: TerminalViewProps & { terminal: ReactNode }
```

Watchers and frozen terminals have an inert, read-only emulator. They never receive input focus or forward keys. Watching and Rebasing… are neutral; each working agent has its own ActorChip and acting-for name. T-APP-12 binds the stream, replay, geometry and palette shortcut through the shared runtime.

### T-UI-15 Branch (S2)

`BranchViewProps = CardProps<BranchCard>` from `@smthrs/rpc/BranchCard`.
The existing Branch boundary decoder and fixtures are retained. §14.3 defines
machine, item/scratch, rebase, moved-off, presence, terminals, activity,
changed_files and ssh_line. `view.tab` selects activity, files or terminals.
Buttons render supplied actions in order; activity actions retain burst ids.
Scratch Done carries conflict_change and onto_revision in its supplied args
(§8.5.2b). Sleep/Wake/Retry use the retained box.suspend/box.resume controls.
Copy SSH uses the shared clipboard helper. Presence has no local state.
BranchView is pending T-APP-10/T-COL-05/T-REL-02 and remains unmounted.
Named gestures are `item`, `file` and `terminal`. Each optional supplied action
opens the TODO, file (path and optional line) or terminal (id); bound args are
retained. No gesture means plain text. Renamed files open renamed_to.

### T-UI-16 File live states (S2)

`CodeSurface` reuses the File props and existing CodeFileView. Gone keeps the last content with a Snapshot caption; Restore and Follow are supplied actions. Outside shows Changed outside Smithers with the supplied Compare action. Compare needs the outside text; contract pending (T-UI-16 report: Issues to file). `DiffCardSurface` retains renamed and burst Restore states. Check: C-UI-12.

### T-UI-18 Secrets

```ts
type SecretsCard = { secrets: {
  name: string
  scope: "all_branches" | "main_only"
  hosts?: string[]
  actions: Action[]
}[] }
type SecretsViewProps = CardProps<SecretsCard>
```

Values never enter the model. Add and Replace supply Value, Scope and optional
Hosts through `Action.input`; Add also supplies Name. Replace expands locally.
Rows show names and scope, without a Hosts count or Bind control.

### T-UI-20 Proposal and lessons receipt

`ProposalCard.ts` retains the evidence/ref projection: `{id, title, evidence: string[], refs: {label, url}[], state: open | accepted | dismissed, todo?: {n, title}}`. `ProposalViewProps` uses `CardProps<ProposalCard, {}, "todo">`; the optional TODO gesture opens the accepted TODO. Supplied actions render in order (Make TODO, Dismiss). Evidence starts expanded for open proposals, collapsed otherwise.

`LessonsReceipt` is `{todo: number, lessons: {title, ref}[]}`. `LessonsReceiptViewProps` uses `CardProps<LessonsReceipt, {}, string>`; gestures keyed by lesson ref open wiki pages or proposals. Without a gesture the title is plain text. The receipt does not alter the merged TODO state (M-15). Retained zod schemas preserve existing boundary validation tests; Views use their TypeScript types only.

### T-UI-21 Docs (bundled pages)

`DocsViewProps = CardProps<DocsCard, {}, "open">` from `@smthrs/rpc/DocsCard`.
`DocsCard` is decoded by `DocsCardSchema`: `toc[] {slug, title}`, `page {slug, title,
summary, markdown}`, `anchor?`, `not_found?`. The missing slug appears above the
supplied fallback page. The read-only wiki Markdown adapter renders inert
HTML. TOC and document links dispatch the supplied `open` gesture with
`{...args, page: "<slug>#<anchor>"}`; absent or disabled gestures are inert.
The adapter reveals `anchor` once per page/anchor reset. At 390px the rail wraps
above the page. No router, loader or authorization belongs to this View.
