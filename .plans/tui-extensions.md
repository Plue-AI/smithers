# TUI extensions: one API for flows, agents and UI

**One sentence.** A repository extends the Smithers TUI with files it already
has: `flows/<name>/flow.ts` flows, `flows/<name>/flow.mdx` markdown flows that
double as custom agents, and a `metadata.tui` block in their frontmatter, while
cells and built-in plugins contribute the same UI values at runtime through the
existing `ui.publish`.

**One paragraph.** No new plugin system, no `.smithers/agents/` directory and
no second graph model. The registry already parses a markdown flow's prompt,
`model`, `effort`, `flows`, `capabilities` and `budget`: that descriptor *is*
the agent definition, and `agent.delegate { agent }` runs it in a worker tab.
UI contributions are one serializable union, `Extension.Contribution` (a panel
placed as a tab or a transcript card, a status item, or a key), each carrying a
`Panels.Action` (prompt, flow, agent or open). Three doors feed one store:
cells call `ui.publish`, repository flows declare `metadata.tui`, and built-in
TUI plugins (the Smithers surface, monitors) push contributions from the
composition root. Descriptors are metadata only, so hot reload is a debounced
`flows/` watch that re-lists the registry and never imports repository code.
The shared types landed in this change (`apps/tui/src/extension.ts`,
`Panels.Action`); the AGENTS and UI-ELEMENTS tracks build on them in parallel.

```
            repository files                       runtime                  composition root
  flows/<n>/flow.ts   flows/<n>/flow.mdx      cell: ctx.call("ui.publish")   SmithersPlugin, Monitors
          \                 /   (metadata.tui)           |                          |
           Registry.list (metadata only)          Extension.decode          Contribution[]
                   |                                     |                          |
           Extension.project -> Descriptor               |                          |
             |                 |                         |                          |
   isAgent(d)│         Extension.declared(d)             |                          |
             v                 v                         v                          v
   agents.ts Profile     +-----------------  contributions.ts (one store)  ------------------+
   (seat, prompt,        | tabs (ui:<id>)  cards (transcript)  status (footer)  keys (Keys) |
    envelope, flows)     +---------------------------------------------------------------+
             |                                    |  perform(Action)
   workspace.request({agent}) <-------------------+--> runs.request / startTurn / setSurface
```

## Evidence read before designing

| Source | Finding the design depends on |
| --- | --- |
| `apps/tui/src/runtime.ts` (main) | `tui/runtime` catalog: `ui.publish`, `flow.list`, `flow.run`, `agent.delegate`, `tab.read`, `tab.list`. |
| `~/smithers-tuifeat-smithers-plugin` (`ozlrrvkv`, uncommitted) | `@smthrs/agent/SmithersPlugin`: `smithers.guide`, `smithers.flows`, `smithers.run`, `smithers.inspect` over `Ports`, plus a `cellModelRequest` brief; replaces `flow.list`/`flow.run`; `apps/tui/src/smithers.ts` adds a Smithers surface; `/smithers` command. |
| `~/smithers-tuifeat-which-key` (`lwnmtzuv`, uncommitted) | `apps/tui/src/keys.ts`: static `registry: Binding[]` with `id/keys/label/context/group`, `bindingFor`, `hintsFor`, `duplicateKeys`; `KeyHints` and `KeyPopup` in `view.tsx`. |
| `~/smithers-tuifix-seat-queue` (`ulxzkmyn`) | Worker tabs queue past three seats (`queued`). `Workspace.retry` drops `request.model`. |
| `~/smithers-tuifeat-monitors` (`wssvontv`) | `monitor.create/list/stop`; `Session.Record` gains `monitor` and `monitor-update`; `Transcript.alert`. |
| `packages/smithers/agent/registry/src/MarkdownFlow.ts` | Frontmatter fields `model`, `effort`, `flows`/`allowed-tools`, `capabilities`, `budget`, `metadata`, `disable-model-invocation`; body loaded only by `loadBody`. |
| `packages/smithers/agent/registry/src/Descriptor.ts` | `FlowDescriptor` has `body._tag` `Markdown`/`Module`, `model: Option`, `frontmatter`; `CallPresentation` sets the precedent that display hints grant no authority. |
| `packages/smithers/agent/src/Seat.ts`, `AgentAction.ts`, `AgentSession.ts` | A seat is a `provider:modelId` string resolved by `SeatResolver`; `AgentSession.patterns(capabilities)` builds the envelope; `AgentAction.make` is how a `flow.ts` body calls a model. |
| `packages/smithers/src/internal/NativeControl.ts:250` | `projectSources(root)` discovers `flows/` only. |
| `packages/smithers/control/src/Control.ts:234` | `Control.list` exists; the TUI never calls it. |
| Probe (`~/Desktop/tui-design/before-flows-picker.png`) | A `flow.mdx` with `metadata.tui` and `model: openai:gpt-6-sol` is discovered and listed today with no warning. |

## (a) Smithers flows for the agent and the user

What the Smithers plugin lane already does, and what this design adds:

| Need | User | Agent | Status |
| --- | --- | --- | --- |
| List flows | `/flows` picker, Smithers surface | `smithers.flows` | Done (plugin lane) |
| Run a flow | `/flow <name> [json]`, form for missing input, approval rows | `smithers.run` (requested receipt, dedupe id, `modelInvocable` enforced) | Done |
| Watch a run | `flow:<id>` tab (node projection), toasts, `r` retry, `x` stop | `smithers.inspect`, completion in `Flow runs:` context, `monitor.create {kind:"run"}` | Done (monitors lane) |
| Know a flow's input | form | none: a guessed input parks the run in `input` | **Gap A1** |
| See runs started outside the TUI (`smthrs flow start`) | none | none | **Gap A2** |
| New or edited flow appears without restart | on `/flows` or Smithers open only | on next request | **Gap A3** (shared watcher, UI track) |
| Run a flow from a key or status item | none | n/a | **Gap A4** (UI track `Action.flow`) |
| Markdown flow as an interactive agent | no | no | **Gap A5** (AGENTS track) |

Gap specs:

- **A1.** `smithers.flows` returns `{ name, description, agent, input }` where
  `input` is `Form.fields(schema)` projected to `[{ name, type, required }]`,
  at most 12 fields, read from `Port.input` only for flows already imported;
  markdown flows report `[{ name: "args", type: "string", required: false }]`.
  Owner: AGENTS track, file `apps/tui/src/flows.ts` (`FlowRuns.describe`).
- **A2.** `Port.runs()` wraps `Control.list({ limit: 20 })`; the Smithers
  surface shows those rows read-only with `by: "cli"`. Owner: AGENTS track.
  Deferred until the plugin lane lands, because it edits `smithers.ts`.
- **A3.** `apps/tui/src/watch.ts`: one recursive `fs.watch` of `<cwd>/flows`,
  300 ms debounce, calls `runs.refresh()`. Owner: UI-ELEMENTS track.
- **A4, A5.** Covered below.

## (b) Custom agents

**Decision: an agent is a markdown flow.** `flows/<name>/flow.mdx` (or
`SKILL.md`) is the agent file. It already has every field the request lists:

```yaml
---
description: Reviews the uncommitted change and returns a verdict.   # picker row
model: sol                     # seat: alias (sol|luna|opus|fable) or provider:modelId
effort: high                   # thinking level
capabilities: ["fs:read:**", "proc:spawn:*"]   # envelope; empty = host default
flows: [read, grep, bash]      # ctx flows it may call; empty = host default catalog
disable-model-invocation: false # true = only a person may start it
metadata:
  tui:
    keys: [{ key: "alt+r", label: "Review" }]
    status: true
---
# The body is the agent's system prompt and knowledge.
```

Why not `.smithers/agents/<name>.ts`: it would be a second definition format
that the registry, `smthrs flow start`, approvals and the GUI do not read.
Why not `flow.ts`: a module body is a graph, not a prompt; a flow whose body
calls `AgentAction.make` is still run with `smithers.run`, and that is the
"flow as its body" case. The two doors stay distinct:

| Door | Runs | Shows | Use |
| --- | --- | --- | --- |
| `agent.delegate { agent }`, `/agent`, key | in-process worker tab (cells, steering, undo) | transcript tab | interactive work |
| `smithers.run { flow }`, `/flow` | control plane (`AgentSession`), durable | `flow:<id>` node tab | durable, approvable runs |

Runtime behavior:

1. `agent.delegate { id, title, prompt, agent? , model? }` persists a
   `requested` (or `queued`) tab and returns at once. The agent body is read
   in `launch`, never in `request`, so an unreadable file cannot block chat.
2. `launch` calls `Port.body(name)` (`Registry.loadBody`), builds an
   `Agents.Profile`, and passes it to `host.run` as `TurnInput.agent`.
3. `host.run` applies the profile: system gets the body plus the skill
   resources line from `MarkdownFlow.renderPrompt`; seat is the profile seat;
   `capabilityEnvelope` is `AgentSession.patterns(capabilities)` when
   declared; the standard flow sources are filtered to `flows` when declared;
   `thinking` is `effort`. The worker teaching still applies.
4. Seat precedence: `request.model` > agent `model` > worker seat.
5. The tab records `agent: { name, digest }`. Retry re-reads the file (edits
   apply) and keeps `agent` and `model` (fixes the seat-queue retry drop).
6. The coordinator sees `Agents: [{ name, description }]` (model-invocable,
   at most 20) in its background context, next to `Flow runs:`.

Typed failures (`Agents.AgentError`, code + one line, shown as the tab's
message and returned to the cell for synchronous refusals):

| Code | When | Surface |
| --- | --- | --- |
| `unknown_agent` | name not listed | `agent.delegate` refuses |
| `not_an_agent` | name is a module flow | refuses; message says use `smithers.run` |
| `not_invocable` | `disable-model-invocation` and `by: agent` | refuses |
| `unreadable` | `loadBody` failed | tab `failed`, retryable |
| `unknown_seat` | alias or provider unknown to `models.ts` | tab `failed` |

User surfaces (MINIMAL TEXT):

```
/agent                         -> Agents picker          /agent review look at src -> tab
┌ Agents ─────────────────────────────── esc ┐
│ Search                                      │         Chat  Summary  ◌ review: look at src
│ › review     GPT-6 Sol   Reviews the unco…  │
│   release    Opus 5.5    Drafts release n…  │
└─────────────────────────────────────────────┘
```

Choosing a picker row without a prompt fills the composer with
`/agent review ` (agent input is a form: the prompt is the one field).

## (c) Custom TUI elements

**Decision: extend `ui.publish`, do not add a second UI flow.** Its input
becomes `Extension.Contribution | Panel`; a bare panel still means a tab.

| Contribution | Renders | Limits | Selecting it |
| --- | --- | --- | --- |
| `{ kind: "panel", placement: "tab", panel }` | `ui:<id>` tab (today) | 24 panels | tab keys as today |
| `{ kind: "panel", placement: "card", panel }` | live card in the transcript; same id updates in place | 24 panels shared | `enter` opens `ui:<id>` |
| `{ kind: "status", status: { id, text, tone?, action? } }` | footer, right of the context meter | 24 chars, 3 shown | click or palette runs `action` |
| `{ kind: "key", key: { id, key, label, action, context? } }` | which-key popup group named by owner | global keys need ctrl or alt; 8 per owner | pressing runs `action` |

`Panels.Row.action` widens from `{ label, prompt }` to also accept
`{ label, action: Panels.Action }`. Publishing never executes an action; a
person or an agent does.

Owners and precedence:

- `runtime:<source>`: cells (`chat` or a worker tab id; worker panel ids stay
  prefixed `<tab>/<id>` as today). Persisted in the session file.
- `repo:<name>`: `metadata.tui` from `Extension.declared`. Recomputed on every
  registry listing; never persisted.
- `plugin:<name>`: built-in TUI plugins at the composition root. First two
  adapters: the Smithers surface (`smithers.ts`, a tab) and monitors (one
  status item while any monitor is active).
- Built-in keys always win. A contributed key that collides is refused and
  listed as a problem; problems show as one danger status item
  `✗ 2 extensions` that opens an `Extensions` panel with one row each.

Hot reload: `watch.ts` refreshes the registry listing on any `flows/` change;
`contributions.repo(listed.map(Extension.declared))` replaces every `repo:`
contribution atomically. No repository module is imported, so reload is safe
before approval. Changing `metadata.tui` changes the descriptor's execution
digest and therefore requires re-approval of that flow; that is accepted.

`metadata.tui` on `flow.ts` is out of scope: module metadata is read
statically and `Flow.make` has no `metadata` option. A module flow gets UI by
returning a panel from a cell or through a plugin.

```
 Chat  Summary  ◌ review                                                    after
 ┃ Plan the release
 ┃ ▎ Release plan · Two steps left.                 <- card (placement: card)
 ┃ ▎ ✓ Changelog   ◌ Tag   · Publish
 ┃
 ╭──────────────────────────────────────────────────────────────────────────╮
 │ Ask Smithers to change this repository                                    │
 │ code · GPT-6 Sol                                                          │
 ╰──────────────────────────────────────────────────────────────────────────╯
 ~/smithers                          ◌ review  CI ✓  ✗ 1 extension   0.0%/128k
                                     └──────── status items ───────┘
 ? keys   alt+r Review   ctrl+k Search                <- which-key hints include contributed keys
```

## Shared types (landed in this change)

`apps/tui/src/panels.ts`

```ts
export const Action: Schema  // union below; defined here so Row can carry one without an import cycle
export type Action =
  | { kind: "prompt"; prompt: string }
  | { kind: "flow"; flow: string; input?: Record<string, Json> }
  | { kind: "agent"; agent: string; prompt?: string }
  | { kind: "open"; surface: string } // chat | summary | smithers | tab:<id> | flow:<id> | ui:<id>
```

`apps/tui/src/extension.ts`

```ts
export const Action = Panels.Action
export const keyProblem: (key: string, context: "global" | "panel") => string | undefined
export const Key: Schema    // { id, key, label (<=24), action, context? }, global needs ctrl|alt
export const Status: Schema // { id, text (<=24, one line), tone?, action? }
export const Contribution: Schema // panel(tab|card) | status | key
export const decode: (value: unknown) => Contribution // bare Panel => panel/tab; Panels.decode limits apply
export interface Descriptor { name; description; modelInvocable; kind: "markdown" | "module";
  seat?; effort?; flows; capabilities; path; tui? }
export interface Source // the FlowDescriptor fields project() reads; FlowDescriptor satisfies it
export const project: (source: Source) => Descriptor
export const isAgent: (descriptor: Descriptor) => boolean // kind === "markdown"
export const Manifest: Schema // metadata.tui: { keys?: [{ key, label, action?, context? }] (<=8), status?, card? }
export interface Declared { owner: `repo:${string}`; keys: Key[]; status: boolean; card: boolean; problems: string[] }
export const declared: (descriptor: Descriptor) => Declared // key action defaults to the owner's agent or flow
```

Rules both tracks follow: import these; never redefine them; widen them only
in a commit that touches no track file.

## Track AGENTS

Status: steps 1 to 9 landed in one change. Step 9 (`Port.runs`) feeds the
coordinator's `Flow runs:` context; its read-only rows in the Smithers surface
wait for the plugin lane. Step 5 also fixes the retry model drop on `main`;
the seat-queue lane's `queued` status merges on top. One code beyond the table:
`unknown_effort`, a tab failure for an `effort:` that is not a reasoning effort.

Owns: `agents.ts`, `models.ts`, `flows.ts`, `flow-control.ts`,
`workspace.ts`, `host.ts`, `runtime.ts` (`agent.delegate` only), `editor.ts`
(`/agent`), and the `/agent` + Agents picker parts of `app.tsx`.

| # | File | Change | Test first (fails before) |
| --- | --- | --- | --- |
| 1 | `flow-control.ts`, `flows.ts` | `discover` maps `Extension.project`; `Listed = Extension.Descriptor`; `Port.body(name) => { text, baseDirectory, digest }` via `Registry.loadBody`, `FlowError("refused")` for module bodies | `test/flow-control.test.ts`: fixture `flows/review/flow.mdx` lists `kind: "markdown"`, `seat`, `tui`; `body("review")` returns the prompt; `body("echo")` refuses |
| 2 | `models.ts` | `seatOf(declared, available)`: aliases `sol luna` (OpenAI), `opus fable` (Anthropic), `qwen` (Cerebras); `provider:modelId` passes through; unknown => `unknown_seat` | `test/models.test.ts` table |
| 3 | `agents.ts` (new) | `Profile { name, digest, system, seat, thinking?, flows, envelope }`, `AgentError`, `profile(descriptor, body, seatOf)` | `test/agents.test.ts`: every row of the failure table; empty `flows`/`capabilities` keep host defaults |
| 4 | `host.ts` | `TurnInput.agent?: Profile`; extract `turnOptions(input)` (pure) from `run` and apply the profile there | `test/host.test.ts`: `turnOptions` has the body in `system`, the narrowed envelope, only allowlisted standard flows, `effort` as thinking |
| 5 | `workspace.ts` | `Request.agent?`, `Tab.agent?: { name, digest }`; body read in `launch`; dedupe compares agent; `retry` keeps `agent` and `model` | `test/workspace.test.ts`: with a `body` port that never resolves, `request` returns `requested` and chat stays usable; failure is typed and retryable; duplicate id with a different agent refuses |
| 6 | `runtime.ts` | `agent.delegate` input gains `agent`; synchronous refusals `unknown_agent`, `not_an_agent`, `not_invocable` | `test/runtime.test.ts` |
| 7 | `flows.ts` | Gap A1: `describe(flow)` feeds `smithers.flows` `input` | `test/flows.test.ts` |
| 8 | `editor.ts`, `app.tsx` | `/agent [name] [prompt]`, Agents picker (name, seat label, description), `Agents:` background context, tab title shows agent | e2e `test` in `e2e/tui.test.ts`: `/agent review x` with the replay seat opens a `review` tab while the composer accepts input |
| 9 | `flows.ts`, `flow-control.ts` | Gap A2 `Port.runs()` via `Control.list` | after the plugin lane lands |

## Track UI-ELEMENTS

Status: steps 1 to 8 landed. `enter` on a card focused with `tab` opens
`ui:<id>`; monitors are `plugin:monitors` (one status item while any is
active); the Smithers tab is `plugin:smithers` and shows only while open, as
main's `/smithers` surface did. The footer fits every whole hint and leaves the
rest to `?`. A key without an action on an agent starts it with its label as
the prompt. A `{kind:"flow"}` key on a markdown flow starts a control-plane
prompt run: `Port.input` no longer repeats the catalog's missing-delegate
refusal, which only applies to module delegation.

Owns: `contributions.ts` (new), `watch.ts` (new), `keys.ts`, `transcript.ts`
(`card` item), `session.ts` (`card` and `contribution` records), `view.tsx`
(`Card`, `StatusItems`), `panel-view.tsx`, `panels.ts` (`Row.action` widening,
teaching), `runtime.ts` (`ui.publish` only), and the footer, key dispatch and
`perform` parts of `app.tsx`.

| # | File | Change | Test first (fails before) |
| --- | --- | --- | --- |
| 1 | `runtime.ts`, `panels.ts` | `ui.publish` decodes with `Extension.decode`; `Ports.publish(Contribution)`; teaching adds placement, status, key in one sentence | `test/runtime.test.ts`: a bare panel still publishes a tab; a status contribution reaches the port; a bad key returns the typed refusal text |
| 2 | `contributions.ts` (new) | Store keyed `owner/id`: `runtime(owner, c)`, `repo(declared[])`, `plugin(name, c[])`, `snapshot() => { cards, status, keys, problems }`; limits; built-in key collisions refused | `test/contributions.test.ts`: `repo` replaces atomically; limits; collision refused; problems collected |
| 3 | `keys.ts` | Rebase on the which-key lane: `Binding.action?`, `Binding.owner?`; `bindings(contributed)` merges; `bindingFor` takes the merged list; group = owner | `test/keys.test.ts`: contributed `alt+r` appears in `hintsFor("global")` and the popup; `ctrl+c` refused |
| 4 | `transcript.ts`, `session.ts` | `Item { kind: "card", panel }`; one item per panel id; records `card`, `contribution`; restore | `test/transcript.test.ts`, `test/session.test.ts`: republish updates in place; reload restores cards and status |
| 5 | `view.tsx`, `panel-view.tsx` | `Card` (left bar, title, summary, first 5 rows with glyphs); `StatusItems`; `a` runs a row's `Action` | zmux e2e + PNG to `~/Desktop/tui-design/after-*.png` |
| 6 | `app.tsx` | `perform(action)`: prompt => `startTurn`/queue, flow => `runs.request({ by: "user" })`, agent => `workspace.request({ agent })` or composer prefill, open => `setSurface`; never awaits | e2e: `alt+r` in a fixture repo requests the flow; toast settles only with the run; chat stays usable |
| 7 | `watch.ts` (new), `app.tsx` | Gap A3: recursive `flows/` watch, 300 ms debounce, dispose on exit | `test/watch.test.ts` on a temp dir: add `flow.mdx` then one refresh; burst of writes then one refresh |
| 8 | `app.tsx`, `smithers.ts`, `monitors.ts` | Plugin door: Smithers surface and monitors register as `plugin:` contributions | after the plugin and monitors lanes land |

UI-ELEMENTS status (change `utkyxozm`, on the which-key lane `lwnmtzuv`):

| # | State |
| --- | --- |
| 1-7 | Done, test-first. |
| 8 | Smithers surface done (`plugin:smithers`, `ui:smithers`). Monitors not done: the monitors lane has not landed. |

Found while building:
- The registry parses frontmatter with YAML's failsafe schema, so `status: true` arrives as `"true"`. `Extension.Manifest` accepts both.
- `metadata` must map strings to strings: a nested `metadata.tui` gets an `invalid_metadata` discovery warning (a `smthrs doctor` warn), and `SKILL.md` rejects it outright (`skill_invalid_metadata`). `metadata.tui` may therefore be a JSON string. Clearing the flow.mdx warning needs a registry change; not made here.
- The TUI's flow control refuses markdown flows (`delegates to "agent", which no registered flow provides`), so a `{ kind: "flow" }` action on a markdown flow fails today. A key without an action runs the owner as an agent instead (AGENTS track).

## Order and independence

```
 this change: extension.ts + Panels.Action (shared)  ──┬── AGENTS 1..8 ──┐
                                                        └── UI 1..7 ─────┴── both: A2, UI 8 after plugin + monitors lanes
```

The tracks share no file except `runtime.ts` and `app.tsx`, and inside them
they touch disjoint bindings and handlers. Land order: which-key lane before
UI 3; plugin lane before AGENTS 9 and UI 8; seat-queue lane before AGENTS 5.

## Acceptance

- A cell, a `metadata.tui` key, and a person pressing the key all reach the
  same request path and the same receipt.
- `/agent`, a key, and `agent.delegate { agent }` return before the agent
  body is read; chat accepts input while the tab runs; the toast settles only
  from the real outcome; duplicate ids dedupe; failures stay retryable.
- Editing `flows/review/flow.mdx` changes the next run and the contributed
  keys within one debounce, with no restart and no module import.
- Every refusal is a typed code with one line of text.

## Not done in this change

- Neither track is implemented; only the shared types and their tests are.
- `metadata.tui` for `flow.ts` modules needs a `Flow.make` metadata option in
  `@smthrs/flow`; not proposed.
- Descriptor `budget` is not applied to interactive agent tabs in v1; the
  worker's `maxFrames` and sandbox limits apply.
- Third-party TUI plugins loaded from packages are not supported; plugins are
  built in at the composition root until a second external adapter exists.
