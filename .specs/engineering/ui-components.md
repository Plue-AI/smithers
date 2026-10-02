# UI components: design builds, engineering wires

Version 0.3 · 2026-10-02 · Owner: engineering (contract), design (components) · Ruling: Will, 2026-10-02 (spec.md §14.2.1)

Design (smithers-06) builds every visual component in `apps/app` and `@smthrs/ui`. Engineering builds the containers that feed them data and turn their callbacks into catalog commands. This page lists the components in order of need and gives each one its props. The props are spec.md §14.3 in TypeScript. T-APP-19 transcribes them into zod schemas in `packages/rpc/src/<Card>Card.ts` with fixtures in `packages/rpc/test/fixtures/<Card>.ts`. Until it lands, design builds against this page with local fixtures.

```
  packages/rpc/src/<Card>Card.ts        zod schema + type   (engineering, T-APP-19)
            │                    │
            ▼                    ▼
  cards/views/<Card>View.tsx ◀── props ── <Card>Container.tsx ──▶ live topic (§7.2)
  design: T-UI-nn               engineering: T-APP-nn     catalog command (§6.1)
  fixtures + stories            subscribes, maps, binds
```

## Rules

- A View takes props only. It imports no topic, store, controller, RPC client or command module (C-UI-08).
- A View never decides who may act. The container passes `actions[]` already filtered for the viewer, and the View renders them in order. A missing action means no button.
- Every user gesture is `onAction(action.tag, input?)` with an action from `actions[]`, and the control carries `data-flow={action.tag}`. Tags are opaque to the View; the lists below name the buttons by label.
- Views live in `apps/app/src/mainview/cards/views/*View.tsx`. `flows/parity.test.ts` leaves that directory out of its pinned handler table and applies the View-seam rule instead: every handler goes through `onAction(<action>.tag)` with `data-flow`. Parity moves to the Container: every `*Container.tsx` builds `actions[]` through one helper that binds `onAction` to `flowAction`, so the three-door and agent-parity rules still hold (agreed with design, 2026-10-02). UI-only gestures (maximize, tab, filter, scroll) are `onView(patch)`, which the container stores in per-member view state (§14.1.2).
- A field the View needs but this page lacks is a spec change. Raise it with the tech lead, who updates §14.3, this page and T-APP-19 together.
- Copy follows §14.6b: product words, card lines of 12 words or fewer, no explanatory sentences.

## Order of need

Stage 1 is on the critical path. Within a stage, the order is the order a fresh install meets them in J1 then J2.

| # | Design ticket | Component | Wiring ticket | Stage | Journeys |
| --- | --- | --- | --- | --- | --- |
| 1 | [T-UI-01](tickets/T-UI-01.md) | `ActorChip`, `StateWord`, `Tone` primitives | T-APP-09 | S1 | all |
| 2 | [T-UI-02](tickets/T-UI-02.md) | `SetupView`, `SettingsView` | T-APP-03 | S1 | J1 |
| 3 | [T-UI-03](tickets/T-UI-03.md) | `DraftView` | T-APP-02 | S1 | J2, J7 |
| 4 | [T-UI-04](tickets/T-UI-04.md) | `TodoView` (with Needs you forms, conflict view, failure, evidence, PR line, Fork and Add to stack) | T-APP-02, T-STK-08, T-MCH-08 | S1 | J2, J4, J7, J10 |
| 5 | [T-UI-05](tickets/T-UI-05.md) | `ConfirmView` (`one_click`, `review_merge`) | T-APP-04 | S1 | J2, J4, J6 |
| 6 | [T-UI-06](tickets/T-UI-06.md) | `HomeView` (with the `main` sync row and Retry) | T-APP-01, T-GH-08 | S1 | J4, J10 |
| 7 | [T-UI-07](tickets/T-UI-07.md) | Conversation shell: `BranchTree`, `EntryRow`, `ContextLine`, Earlier archive | T-APP-16, T-APP-17 | S1 | all |
| 8 | [T-UI-08](tickets/T-UI-08.md) | `ToastStack`, `EdgeMap`, `Timeline` (Allow notifications variant at S2) | T-APP-07, T-APP-18 | S1 | all |
| 9 | [T-UI-09](tickets/T-UI-09.md) | `MembersView` | T-APP-06 | S1 | J1 |
| 10 | [T-UI-10](tickets/T-UI-10.md) | `FlowView` | T-APP-05 | S1 | J5, J11 |
| 11 | [T-UI-11](tickets/T-UI-11.md) | `CodeEditorView` (File, read-only) and `DiffView` | T-APP-15 | S1 | J1, J9, J11 |
| 12 | [T-UI-12](tickets/T-UI-12.md) | `RunView` monitor and Inspect | T-FLW-07 | S1 | J11 |
| 13 | [T-UI-13](tickets/T-UI-13.md) | `AgentView` and model roles | T-FLW-08 | S1 | J11 |
| 14 | [T-UI-14](tickets/T-UI-14.md) | `CommandsView` (`/help`) | T-CAT-01 | S1 | all |
| 15 | [T-UI-15](tickets/T-UI-15.md) | `BranchView` (with moved-off controls) | T-APP-10, T-COL-05 | S2 | J3, J7 |
| 16 | [T-UI-16](tickets/T-UI-16.md) | File and Diff states: reload, gone, renamed, Restore, Compare | T-APP-11 | S2 | J3 |
| 17 | [T-UI-17](tickets/T-UI-17.md) | `TerminalView` | T-APP-12 | S2 | J3, J6 |
| 18 | [T-UI-18](tickets/T-UI-18.md) | `SecretsView` | T-APP-13 | S2 | J1 |
| 19 | [T-UI-19](tickets/T-UI-19.md) | Co-editing visuals on `CodeEditorView` | T-APP-14 | S3 | J3, J8 |
| 20 | [T-UI-20](tickets/T-UI-20.md) | `ProposalView` and the lessons receipt | T-FLW-06 | S3 | J5, J8 |

Kept as built, with no new design work unless design changes them: the Issue card (wired by T-GH-02), the PR card, the Review findings card, the Wiki cards, the flow Form card and the other retained cards spec §14.3.0 names. They keep their existing schemas, and C-UI-08 pins them. A field change to one of them is a spec change that first adds its §14.3 row.

## Shared types

```ts
type Via = "smithers" | "claude-code" | "codex" | "ssh" | "terminal" | "cli"
type Actor =                                   // §14.6a
  | { kind: "person"; login: string; name: string; avatar_url: string; via?: Via }
  | { kind: "agent"; role: "coding" | "app" | "fast"; todo?: number }   // "Agent"
  | { kind: "system"; for?: PersonRef }       // "Smithers", "Smithers, for Ben"
  | { kind: "github"; login: string }         // "@login" with the GitHub mark
  | { kind: "outside" }                       // "changed outside Smithers"
type PersonRef = { login: string; name: string; avatar_url: string }

type TodoState = "queued" | "starting" | "working" | "needs_you" | "paused"
               | "failed" | "in_review" | "merged" | "dropped"       // §4.1
type Tone = "live" | "attention" | "failed" | "done" | "quiet"      // §14.5.2
type NeedsYouKind = "question" | "approval" | "conflict" | "moved_off" | "foreign_push"

type Action = {                 // filtered for the viewer by the container
  tag: CatalogTag               // the catalog's tag type (T-CAT-01), opaque to the View
  label: string                 // "Answer", "Merge", "Retry"
  primary?: boolean
  disabled?: { reason: string } // e.g. "Waiting for T8"
  input?: FormField[]           // present when the action needs a form
}
type FormField = { name: string; label: string; kind: "text" | "choice" | "secret"; choices?: string[]; required: boolean }

type CardProps<M> = {
  model: M
  actions: Action[]
  onAction: (tag: CatalogTag, input?: Record<string, string>) => void
  view: { maximized: boolean; tab?: string; filter?: string }
  onView: (patch: Partial<CardProps<M>["view"]>) => void
}
```

## Props per component

### T-UI-01 Primitives

```ts
type ActorChipProps = { actor: Actor; size: "s" | "m" }
type StateWordProps = { state: TodoState; step?: string }   // "Working · implement"
```

### T-UI-02 Setup and Settings (`install` topic)

```ts
type StepState = "todo" | "active" | "done" | "failed"
type SetupModel = {
  address: { bind: string; origins: string[] }
  steps: { id: "address" | "repo_owner" | "app_manifest" | "sign_in" | "repository"
               | "models" | "source" | "machine";
           state: StepState; error?: { code: string; message: string; fix?: string } }[]
  this_mac: { chip: string; memory_gb: number; disk_free_gb: number; capacity: number }
  github: { signed_in: boolean; app_installed: boolean; squash_allowed: boolean }
  repository?: { owner: string; name: string }
  models: { fast: boolean; coding: boolean; jev: boolean }    // access flags
  source: { state: StepState; pct: number }
  machine: { state: StepState; pct: number }
}
type SettingsModel = SetupModel & { capacity: number; parallel: number; laptop_line: string }
```

### T-UI-03 Draft

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
// buttons: Commit ("Commit puts it on the stack as T12"), Discard. Make TODO is the Issue card's button that opens a Draft.
```

### T-UI-04 TODO (`todo:<n>` topic)

```ts
type TodoModel = {
  n: number; title: string; state: TodoState; owner: PersonRef
  place: number; queue?: { reason: "machine" | "merge_order" | "rebase"; after?: number; position: number }  // View renders the copy (spec §4.1.1)
  step?: string                                   // current flow step
  prompt_revisions: { text: string; by: Actor; at: string }[]
  acceptance: string[]
  issue?: { number: number; url: string }
  branch: { id: string; name: string }
  steps: ( { id: string; label: string; detail?: string
              state: "done" | "current" | "todo" | "failed" | "waiting" | "paused" }
          | { id: "merge"; kind: "wait"; state: "held" | "done" | "todo"; since?: string } )[]
                                                  // the run's trailing wait for merge (spec §10.4.1)
  run?: { attempt: number
          indicators: { tone: "wait" | "thrash"; text: string }[] }
                                                  // "Waiting for a person since 10:42";
                                                  // "Thrashing: TestRetryBackoff failed 3×" (spec §11.6.4)
  needs_you?: { kind: NeedsYouKind; prompt: string; since: string
                paths?: string[]                  // conflict
                by?: Actor; sha?: string }        // foreign_push, moved_off
  first_answer?: { by: Actor; text: string; at: string }
  failure?: { step: string; class: string; message: string; retryable: boolean }
  evidence: { attempt: number; items: { kind: string; label: string; url?: string }[] }[]
  pr?: { number: number; url: string; head: string; draft: boolean; draft_after?: number
         checks: "pending" | "passing" | "failing"; reviews: { by: Actor; verdict: string }[]
         included_items: number[] }
  merged_via?: number                             // "Merged · in T15's commit"
  merge: { state: "ready" | "waiting" | "blocked" | "merging" | "done"; reason?: string }
  amendments: number; lessons: number
}
// buttons by state: Answer, Steer, Stop, Resume, Retry, Retry with the current flow,
// Drop, Amend, Merge, Review & merge, Resolve, Done (conflict), Fork, Add to stack,
// Rebase now, Bring in, Discard
```

### T-UI-05 Confirm (`confirmations:<member>` topic)

```ts
type ConfirmModel = {
  kind: "one_click" | "review_merge"
  action: { tag: CatalogTag; verb: string }           // the button reads the verb
  summary: string                                 // one line
  subject: { kind: "todo" | "branch" | "flow" | "secret" | "member"; ref: string; revision: string }
  place?: number
  checks_line?: string
  asked_by: Actor                                 // "Ben via Claude Code"
  receipt?: { by: PersonRef; result: "done" | "cancelled" | "stale"; at: string }
}
// buttons: the verb (one_click) or Review & merge, and Cancel
```

### T-UI-06 Home (`home` topic)

```ts
type HomeModel = {
  main: { sha: string; title: string; last_success_at: string
          health: "ok" | "stale" | "refused"; cause?: string; retry_at?: string }
  attention: { kind: "order" | "force_push"; text: string; todo?: number }[]
  items: (Pick<TodoModel, "n" | "title" | "state" | "owner" | "place" | "queue" | "step"
                        | "amendments" | "lessons"> & {
           needs_you?: { kind: NeedsYouKind; prompt: string }
           merge_block?: string; pr?: { number: number; draft: boolean }
           approval_cleared?: boolean
           branch: string; present: PersonRef[]; elapsed_s: number
           actions: Action[] })[]                 // each row's one action
  counts: Record<TodoState, number>
  merged_since_last_look: number[]
  machines: { in_use: number; capacity: number }
  parallel?: number                               // owner only
  background_runs: { id: string; title: string; state: "queued" | "running" | "waiting" | "failed"; detail: string }[]
}
// buttons: Retry (main sync), Retry and Dismiss (background runs), Move (reorder), plus each row's one action
```

### T-UI-07 Conversation shell

```ts
// Open branches only; a closed branch's conversation opens from its merged TODO.
// "earlier" is the single read-only node for legacy per-member conversations (spec §14.1.5).
type BranchTreeNode = { id: string; name: string; kind: "main" | "item" | "scratch" | "earlier"
                        todo?: number; present: PersonRef[]; children: BranchTreeNode[] }
type EntryRowProps = {
  author: Actor; title: string; summary?: string; tone: Tone; state?: TodoState
  context?: { count: number; items: { kind: "file" | "page" | "issue" | "entry"; label: string; ref: string }[] }
  action?: Action; private?: boolean; card?: React.ReactNode
}
type ContextLineProps = { count: number; items: EntryRowProps["context"] extends infer C ? NonNullable<C>["items"] : never; expanded: boolean }
```

### T-UI-08 Toasts, edge map, timeline

```ts
type Toast = { id: string; title: string; tone: Tone; action?: Action; entry_id: string
               kind: "needs_you" | "approval" | "in_review" | "failed" | "conflict" | "merged"
                   | "progress" | "allow_notifications" }
type ToastStackProps = { toasts: Toast[]; more: number; onAction: CardProps<unknown>["onAction"]; onHide: (id: string) => void }
type EdgeMapProps = { above: Toast[]; below: Toast[]; narrow: boolean }   // two rows max plus a count
type TimelineProps = { lines: { entry_id: string; title: string; summary?: string; tone: Tone }[]
                       on_screen: [first: string, last: string]; onJump: (entry_id: string) => void }
```

### T-UI-09 Members (`members` topic)

```ts
type MembersModel = { members: { login: string; name: string; avatar_url: string
                                 role: "owner" | "maintainer" | "member"
                                 needs_access: boolean; suspended: boolean }[] }
// buttons: Add (by username), Role, Suspend, Remove
```

### T-UI-10 Flow (`flows` topic)

```ts
type FlowModel = {
  name: string; source: { builtin: true } | { path: string }   // "flows/<name>/flow.ts"
  versions: { id: string; state: "active" | "proposed" | "merged-syncing" | "merged-failed" | "previous"
              todo?: number; error?: string
              steps: ( { id: string; label: string; detail?: string; agent?: string }
                     | { id: "merge"; wait: true; signals: { on: "rebase" | "steer"; to: string }[] } )[] }[]
                                                  // TODO flow: rebase → check, steer → implement (spec §10.4.1)
}
// buttons: Source, Plan, Run, Edit
```

### T-UI-11 File (read-only) and Diff

```ts
type FileModel = { path: string; text: string; language: string; last_writer?: Actor
                   diagnostics: { line: number; severity: "error" | "warning"; message: string }[] }
type DiffModel = { path: string; base: string; hunks: { header: string; lines: { op: " " | "+" | "-"; text: string }[] }[] }
// gestures (catalog code.hover, code.definition, code.diagnostics): the View raises
// onAction with {path, line, col}; the container passes hover and definition results back as props
```

### T-UI-12 Run monitor and Inspect (`run:<id>` topic)

```ts
type PhaseTone = "live" | "ok" | "fail" | "thrash" | "wait"
type RunModel = {
  id: string; flow: string; version: string
  state: "running" | "waiting" | "held" | "failed" | "done" | "interrupted"
  held?: { since: string }                        // the trailing wait for merge
  attempts: { n: number; state: string
              graph: { id: string; label: string; state: string; deps: string[] }[] }[]
  steps: { id: string; label: string; state: string; started_at?: string; ended_at?: string
           input?: unknown; output?: unknown; agent?: string }[]
  phases: { step: string
            title: string                         // deterministic: the step plus its recorded output,
                                                  // e.g. "Ran checks · 2 failed" (spec §11.6.3)
            summary?: string                      // agent:fast one-liner, rendered as a model summary;
                                                  // absent while pending or failed: the View shows the title alone
            took_s: number; tone: PhaseTone; indicator?: string }[]
  cells: { phase: number
           kind: "context" | "read" | "edit" | "run" | "think" | "ask" | "steer" | "reviewer" | "rebase"
           label: string                          // deterministic, e.g. "Read retry.ts", "Ran pnpm test · 1 failed"
           explain?: string                       // agent:fast explanation of an agent-written cell, rendered as a
                                                  // model summary; absent: the label stands alone
           code?: string; output?: string; quote?: string
           tone?: PhaseTone; took_s?: number; tokens?: number; actor?: Actor }[]
  waits: { id: string; label: string; since: string }[]
  tokens: number; time_s: number; cost_usd: number
  engine: { label: string; detail: string }[]     // Appendix C labels, collapsed row
}
```

### T-UI-13 Agent and model roles

```ts
type AgentModel = {
  name: string                                    // planner, implementer, reviewer, app agent
  instructions_path: string                       // TODO-flow prompts beside the flow source;
                                                  // ".smithers/instructions/app.md" for the app agent (spec §11.5a)
  role: "fast" | "coding" | "jev"; model: string; provider: string; available: string[]
  runs: { id: string; title: string; state: string; at: string }[]   // runs it took part in
  owner: boolean
}
// buttons: Change model (owner only), Edit instructions (opens a Draft TODO)
```

### T-UI-14 Commands (`/help`)

```ts
type CommandsModel = { groups: { label: string; advanced: boolean
                                 commands: { tag: CatalogTag; title: string; agent: "run" | "confirm" | "never" }[] }[] }
```

### T-UI-15 Branch (`branch:<id>`, `:activity`, `:files`) [S2]

```ts
type BranchModel = {
  id: string; name: string; item?: { n: number; place: number }; scratch: boolean
  machine: { state: "asleep" | "waking" | "awake" | "sleeping"; wait_position?: number }
  rebase_pending: boolean
  moved_off?: { by: Actor; item: number }
  presence: { actor: Actor; where?: { path: string; line?: number }; watching?: string }[]
  terminals: { id: string; owner: Actor; command?: string }[]
  activity: { id: string; actor: Actor; asked_by?: Actor                 // spec §3 activity
              kind: "step" | "steer" | "question" | "answer" | "edit" | "change"
                  | "github" | "rebase" | "read" | "context"
              text: string; items?: string[]       // read paths, context labels
              files: number; github?: boolean; at: string }[]
  changed_files: { path: string; change: "added" | "modified" | "deleted" | "renamed"; renamed_to?: string }[]
  ssh_line: string
}
// buttons: Sleep, Wake, Return to Tn, Keep for now, Fork, Rebase now
```

### T-UI-16 File and Diff states [S2]

```ts
type FileState = { reloading: boolean; gone?: { by: Actor }; renamed_to?: string
                   outside?: { snapshot: string } }       // "Changed outside Smithers · Compare"
// buttons: Restore this file, Compare, Restore (deleted), Follow (renamed)
```

### T-UI-17 Terminal [S2]

```ts
type TerminalModel = { id: string; owner: Actor; watchers: PersonRef[]; command?: string
                       viewer_is_owner: boolean }
// the stream is a separate prop: { write: (bytes) => void; onData: (cb) => void }; input only when viewer_is_owner
```

### T-UI-18 Secrets [S2]

```ts
type SecretsModel = { secrets: { name: string; scope: "repo" | "branch"; hosts?: string[] }[] }
// buttons: Add, Replace, Remove (values are write-only; Add and Replace take optional Hosts)
```

### T-UI-19 Co-editing [S3]

```ts
type CoEditProps = { authors: { actor: Actor; color: string }[]
                     editors: { actor: Actor; line: number }[]
                     saved: "saving" | "saved" | "stale" }
// the Yjs binding is engineering's; design styles author colors, gutter flags and the Saved state
```

### T-UI-20 Proposal and lessons receipt [S3]

```ts
type ProposalModel = { id: string; title: string; evidence: string[]; refs: { label: string; url: string }[]
                       state: "open" | "accepted" | "dismissed" }
type LessonsReceipt = { todo: number; lessons: { title: string; ref: string }[] }
// buttons: Accept, Dismiss
```
