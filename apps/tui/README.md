# smithers-tui

A minimal terminal coding agent over the Smithers cell harness.

[User guide](https://smithers.sh/docs/tui/) · [Recordings](docs/README.md) · [Playground](../tui-docs/README.md)

The agent has no tools. Each model turn writes a JavaScript cell that calls
flows through `ctx.call`. The TUI streams each cell as it is written, then its
flow calls, printed output, and result. Keys and commands follow
[pi](https://github.com/badlogic/pi-mono) where the cell harness has the same
idea.

```sh
bun run tui [directory]          # from the repository root
bun run tui --help              # command-line options
bun run tui -c                   # continue the latest conversation here
bun run tui -r                   # pick a conversation
bun run tui -p "prompt"          # print one answer and exit
bun run tui --model openai:gpt-6-astra
```

It runs on Bun or on Node 26.4 or later. `smthrs tui` (and `npx smthrs tui`)
takes the same flags and picks the runtime: `SMITHERS_TUI_BIN`, then an
installed compiled binary, then Bun (`SMITHERS_BUN`, or a CLI already on Bun),
then this Node with `--experimental-ffi`. To run it on Node from the
repository:

```sh
cargo build --locked --release -p smithers-ffi --bin smithers-jj-export
node packages/smithers/scripts/build-tui.mjs
SMITHERS_WORKSPACE_JJ_EXPORT_BINARY="$PWD/target/release/smithers-jj-export" \
  node --experimental-ffi --disable-warning=ExperimentalWarning packages/smithers/dist/tui/main.js [directory]
bun packages/smithers/scripts/build-tui-binaries.mjs --single   # compile this platform's binary
```

Compiled binaries load project flows from installed dependencies and share their
embedded Effect runtime with them. Projects must use the binary's pinned Effect
version; a mismatched version is refused before its module loads.
They embed the matching native filesystem helper. Cross-builds require
`SMITHERS_NATIVE_HELPERS_DIR/<os>-<arch>[-musl]/smithers-jj-export` for every
target; missing or mismatched helpers fail the build. Flow execution also needs
jj 0.39.0 or later on PATH; text search uses `rg`.
On Alpine, install the C++ runtime with `apk add libstdc++` before launching
a compiled musl binary.

Interactive chat prefers `cerebras:qwen-3.8-27b` with low reasoning effort
when `CEREBRAS_API_KEY` is configured, falling back to an available provider.
`--model` or `SMITHERS_TUI_SEAT` overrides chat. Background workers use the
first available non-Cerebras seat (usually the ChatGPT subscription from
`codex login`); `SMITHERS_TUI_WORKER_SEAT` overrides it. Workers try the other
detected non-Cerebras seats after a provider limit; `SMITHERS_TUI_WORKER_SEATS=a,b`
sets that fallback order. The picker lists only
providers this machine can reach. Print mode runs a task directly.

Edits, shell commands, and network calls run without asking. `--approve ask`
(or `SMITHERS_TUI_APPROVE=ask`) makes each wait for **y**/**n**; `deny` refuses
them. The flag wins over the variable, and `-p` cannot `ask`.

Spending is unbounded by default. `--budget-tokens <n>` (or
`SMITHERS_TUI_BUDGET_TOKENS=<n>`) stops each chat turn and each worker before a
model call would take it past `n` tokens; the tab shows **Token budget
reached**. The flag wins over the variable.

## Keys

Queue operations and worker action eligibility are shared with the GUI through
`@smthrs/rpc/PromptQueue` and `@smthrs/rpc/WorkerControls`. Each host keeps its
own rendering and execution adapter.

`src/keys.ts` lists every key; the footer, the `?` panel, `/hotkeys`, and
Ctrl+O read it.

| Key                                                   | Action                                                                                                                                                                                                                                                                                                                 |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enter                                                 | Send. While a turn runs: steer, delivered before the next cell                                                                                                                                                                                                                                                         |
| Alt+Enter                                             | Queue a follow-up for after the turn                                                                                                                                                                                                                                                                                   |
| Alt+Up                                                | Move queued follow-ups back to the editor                                                                                                                                                                                                                                                                              |
| Shift+Enter, Ctrl+J                                   | Newline                                                                                                                                                                                                                                                                                                                |
| Esc                                                   | Stop the turn (queued messages return to the editor) or the shell command                                                                                                                                                                                                                                              |
| ?                                                     | With the editor empty: show the keys for the current context. Esc or ? closes it; other typing keeps the `?`                                                                                                                                                                                                           |
| y, n, a                                               | Approval row showing its keys (editor empty, 400 ms after the row appears and after the editor last changed): allow once, deny, and where the row offers `a all bash` or `a all edits`, allow for the session. Otherwise the key is text                                                                               |
| Ctrl+C                                                | Clear the editor; twice within 500 ms to exit                                                                                                                                                                                                                                                                          |
| Ctrl+D                                                | Exit when the editor is empty                                                                                                                                                                                                                                                                                          |
| Up, Down                                              | Prompt history                                                                                                                                                                                                                                                                                                         |
| `/`                                                   | Commands: Up/Down choose, Tab inserts, Enter runs, Esc closes the menu                                                                                                                                                                                                                                                 |
| `@`                                                   | Mention a file (`git ls-files`, else `rg --files`), fuzzy-matched                                                                                                                                                                                                                                                      |
| Ctrl+K                                                | Search: commands and files; `/` commands, `text:` file text (rg, `text:/re/` for a regex), `conversation:` resumes, `tab:` opens a worker, `?` lists prefixes. Enter inserts `@path` or `@path:line`, runs the command, or opens the item. Replaces the editor's Ctrl+K (delete to line end); Ctrl+U and Ctrl+W remain |
| Ctrl+L                                                | Model dialog; type to filter                                                                                                                                                                                                                                                                                           |
| Ctrl+P, Shift+Ctrl+P                                  | Next, previous model                                                                                                                                                                                                                                                                                                   |
| Shift+Tab                                             | Cycle reasoning effort                                                                                                                                                                                                                                                                                                 |
| Ctrl+O                                                | Expand cell code, output, diffs, and the key list                                                                                                                                                                                                                                                                      |
| Ctrl+T                                                | Inspect the run timeline; arrows scrub, [ ] or Shift+Left/Right step milestones, Home/End jump, Esc returns to live                                                                                                                                                                                                    |
| Ctrl+S                                                | Open Summary / switch focus between the view and chat. With workers it is the overview: the worker tree beside the selected branch's cards (Chat heads the tree and shows the conversation review). Tab switches pane, arrows or hjkl move, Enter opens, Esc closes                                                    |
| Ctrl+], Ctrl+\\, Ctrl+Right, Ctrl+Left                | Next, previous tab: Chat, Summary, worker tabs, trees, and custom views. Click a tab to open it                                                                                                                                                                                                                        |
| Ctrl+Y                                                | In a worker tab: back to its parent worker, or the chat for a top-level worker                                                                                                                                                                                                                                         |
| Ctrl+\\ or `/chat`                                    | Return to full chat from a main view                                                                                                                                                                                                                                                                                   |
| hjkl or arrows                                        | In a view: move between rows, collapse/expand details                                                                                                                                                                                                                                                                  |
| Enter                                                 | In a view: toggle the selected row's details                                                                                                                                                                                                                                                                           |
| d, v                                                  | In a view: toggle the selected turn's diff; toggle split/unified                                                                                                                                                                                                                                                       |
| u                                                     | In the Summary view or a worker tab: undo the selected row's captured file changes (confirm first)                                                                                                                                                                                                                     |
| Tab                                                   | In a view: next tab. In the chat with the editor empty: focus the newest card; arrows move between cards, Enter opens it, Esc returns                                                                                                                                                                                  |
| Esc, i                                                | In a view: focus the composer without stopping background work                                                                                                                                                                                                                                                         |
| a                                                     | Activate the selected row's action, if present                                                                                                                                                                                                                                                                         |
| Contributed keys                                      | Keys a repository or a cell adds (`alt+r`); listed in the hints and the `?` popup under their owner                                                                                                                                                                                                                    |
| r, x                                                  | In a worker or flow tab: resume / stop. A worker resumes with its prior steps on its original model                                                                                                                                                                                                                    |
| m, w                                                  | In a failed worker tab: choose a model for resume / wait for reset                                                                                                                                                                                                                                                     |
| s                                                     | In a worker tab: steer it from the composer (Esc returns)                                                                                                                                                                                                                                                              |
| a                                                     | In a flow tab: approve or fill in                                                                                                                                                                                                                                                                                      |
| x, s, r, m, w, f                                      | On a focused subagent card: the worker keys its status allows (shown on the card), and `f` its changed files                                                                                                                                                                                                           |
| Tab/Down, Shift+Tab/Up, Space, Left/Right, Enter, Esc | In a flow form: next, previous field, toggle, choose, run, close (the run stays parked)                                                                                                                                                                                                                                |
| Ctrl+G                                                | Edit the prompt in `$VISUAL` / `$EDITOR`                                                                                                                                                                                                                                                                               |
| PageUp, PageDown                                      | Scroll                                                                                                                                                                                                                                                                                                                 |
| Shift+Up, Shift+Down                                  | Scroll a line                                                                                                                                                                                                                                                                                                          |
| `!cmd`                                                | Run a shell command; its output joins the next turn's context                                                                                                                                                                                                                                                          |
| `!!cmd`                                               | Run a shell command and keep it out of context                                                                                                                                                                                                                                                                         |

## Commands

The `?` key popup scrolls with PageUp/PageDown or the mouse wheel.

`/model [query]`, `/theme`, `/thinking [level]`, `/new`, `/resume`, `/fork`, `/conversation`, `/compact`,
`/name <name>`, `/copy`, `/summary`, `/tabs`, `/chat`, `/filter`,
`/grep [text]`, `/ui [id]`, `/smithers`, `/flows`, `/flow <name> [json|key=value]`, `/agent [name] [prompt]`,
`/retry <id>`, `/stop <id>`, `/hotkeys`, `/quit`, `/exit`. After `/model`, `/thinking`, `/flow` and `/agent`
the menu completes the argument, and the `/` menu lists the directory's flows.

## Look

Night Owl dark surfaces from the Smithers app (`apps/app/.../tokens.css`),
layered page, panel, element. Your messages keep the composer's shape, a
brand bar on a filled panel. Each cell is a left bar colored by status with
one row per flow call (`→ read`, `$ ran`, `← edited`); an edit draws its diff.
The Summary view keeps cell code behind expandable rows. Panels, dialogs, and the
completion menu follow opencode's shapes; fuzzy matching is pi's.

The bottom timeline shows recorded phases, edits, stalls, and verification
receipts. It follows running workers while chat stays usable. Inspection reads
the journal up to the selected event, so later results do not appear early.
Restoring a session reconstructs the same timeline from its saved events.
Worker tabs show `queued` (waiting for a pool seat), `requested`, `running`,
`waiting` for children, `parked` (with a reset time), `done`, `failed`, or
`cancelled`. Running, waiting, and parked workers auto-relaunch from their
recorded steps when the TUI restarts. Queued workers keep the chat context
captured with their request. A worker refused by a rate limit or quota parks
until the provider's reset or retry-after, then runs again; after 8 parks in a
row with no model answer it fails as "usage limit reached · still limited after
8 waits". A failed worker shows a short failure card; Ctrl+O reveals the raw
error and stack.

## Context and sessions

Each turn is told the working directory, instruction files (the first of
`AGENTS.override.md`, `AGENTS.md`, `CLAUDE.md` in every directory from the
repository root down, or the working directory alone outside a repository,
after `~/.smithers/agent/AGENTS.md`), and the conversation so far. A judged
worker leaves out each instruction chunk Jev is at least 90% sure its task does
not need; the coordinator sees every file whole.
Sessions are owner-only JSONL under `~/.smithers/tui/sessions/<cwd>--<hash>/`
(`SMITHERS_TUI_SESSION_DIR` overrides). A torn last line is dropped; a file
damaged earlier is renamed `.damaged` and left out of the list. Credential
shapes in prompts, shell output and flow calls are saved as `[REDACTED]`; file
patches keep their bytes so undo can apply them. `/fork` starts a new session from the
messages before a chosen one and puts that message back in the editor; the
original stays resumable.

Long cwd slugs are bounded to the filesystem's filename limit; the full path
still determines the hash. Existing session folders remain readable.

If session storage is inside the project, its exact session subtree and log
are excluded from workspace mutation accounting. Other project files remain
observed, including files beside that storage.

Without `AI_GATEWAY_API_KEY` the completion brake that asks Jev is disarmed
(`claimCap: 0`); you read every answer. **u** on a Summary or worker tab row
reverses its captured changes after a confirm, all or nothing; a deleted
file comes back with its mode. It refuses when a file
changed since, a change is binary or large, or the turn ran a shell command
that changed files: a shell diff can hold other workers' edits. The session
records the undo and the next turn is told. `/new`, `/resume` and `/fork` wait
for it.

## Runtime UI and delegation

The summary is a projection onto the same panel format agents can publish.
It starts with one sentence, followed by chronological rows. Each row retains
its cell source, flow calls, output, errors, and observed file changes.
Diffs have syntax highlighting, line numbers, contextual hunks, and a split
view on wide terminals. Filesystem flows capture edits, whole-file overwrites,
patches, deletions, and moves; creation and deletion are marked with
`/dev/null`, so they undo. Shell changes observed during a call are captured in Git and jj repositories;
shell edits outside a repository have no automatic diff. Binary, large, or excessively
expensive diffs are labeled instead of rendered as incomplete hunks.

Agents construct UI in sandboxed JavaScript cells through ordinary flows:

```js
await ctx.call("ui.publish", {
  id: "checks",
  title: "Checks",
  summary: "The addition check passed.",
  rows: [{
    id: "addition",
    label: "Checked addition",
    status: "done",
    details: [{ kind: "code", language: "javascript", code: "assert(add(2, 3) === 5)" }]
  }]
})
ctx.done("The check passed.")
```

Blocks support text, code, tables (`columns`, `rows`), and unified diffs
(`path`, `patch`). Rows optionally carry `action: {label, prompt}` or
`{label, action}` (see Extensions); only the user pressing **a** runs it. Reusing a panel id updates it. Publishing
never takes keyboard focus. `placement:"main"` shows a view beside chat at
120 columns or wider, or above chat on smaller terminals. `bind:{tree:rootId}`
adds live worker rows to that view. Documents are schema-validated, capped at 1 MB,
and persisted in the session. The host renders them; generated code is never
loaded into the UI process.

The chat coordinator has `ui.publish`, `agent.delegate`, `tab.read`,
`tab.list`, and `tab.retry`. Workers also have `agent.delegate`, `agent.wait({ids})`,
`tab.read`, and `tab.list`. A worker can delegate children through depth 3;
depth 4 returns `AgentDepthExceeded`. Waiting releases the worker's pool slot.
Delegation takes `{id, title, prompt}`, persists before launch, and returns a
`requested` receipt immediately. Reusing the id deduplicates the request.
A tab's one-line description comes from the worker's own seat. `r` or `/retry`
resumes a failed, stopped, or parked tab on its requested model.
Up to six workers can run at once (`SMITHERS_TUI_WORKERS` overrides the pool);
later requests queue FIFO. They share the working directory, so
independent tasks should name disjoint files. Worker transcripts persist in
separate session files. The chat shows the workers a cell delegated as
subagent cards after that cell (`@smthrs/rpc/SubagentCard`, shared with the
GUI): `◐ Running 3 subagents (1/3)` and a `▰` bar, then equal-height cards,
one column below 69 columns, up to four across. A card has its lane-colored
`▌` rail, glyph and title, `… +N earlier`, its last five steps (`├ Read x ✓`,
`└ Editing x…`), `▸ 2 files +31 -6` when it changed files, and `42s · sol` or
`Done 1m 04s · sol`. A focused card shows its worker keys (`[x Stop] [s Steer]`).
A worker tab's own children show the same way. `◉ <worker> finished` marks
where a worker settled. `/filter` shows or hides each kind of row;
`/grep <text>` keeps rows containing the text and `/grep` alone clears it. Chat receives every unsettled worker and the newest
five settled answers (1,500 characters each) as context, and remains usable
while workers run. Progress uses the shared toast stack,
with a 300 ms delay and real completion/failure as its end. A `tree:<rootId>`
tab appears when a worker gains children; its rows update from tab state.

Each worker's tab, and its row in the list beside the chat at 100 columns or
wider, shows the status glyph subagent cards share (`@smthrs/rpc/SubagentCard`):
`◐◓◑◒` turning while requested, running or waiting on children, else `●`, in
the color of its state (running, waiting for queued, parked or children, done,
failed, stopped), its model and its clock. Tabs are
never shortened: when they overflow, `‹ n` and `n ›` count and open the hidden
ones. Click a tab, a worker or a card to open it. A worker's tab starts with
`▌ Subagent · <title>` in its lane color and `Back (ctrl+y)`, then its status,
model, clock and tokens, and buttons for the actions its status allows:
**x** Stop, **r** Resume, **m** Switch model, **w** Wait for reset, **s**
Steer. Its transcript is drawn with the chat's own cells. **j**/**k** pick a
row and **u** undoes its changes. A worker's toast reads like its card
(`◐ title · 42s`) with Stop and Steer.

Workers run locally. Restarting the TUI restores their transcripts and
auto-relaunches running and waiting workers; parked workers relaunch at reset.
`/new`, `/resume`, and `/fork`
require running work to finish or be stopped first.

## Extensions

A repository, a cell, or a built-in plugin adds UI with one serializable
value, `Extension.Contribution` (`src/extension.ts`); the TUI owns rendering,
focus and keys. Publishing never runs an action: only a person (a key, a
click, `a` on a row, Ctrl+K) or an agent does.

| Contribution                                                  | Shows                                                                                                                                                           | Limits                                    |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| A bare panel, or `{ kind: "panel", placement: "tab", panel }` | A `ui:<id>` tab                                                                                                                                                 | 24 panels, shared with cards              |
| `{ kind: "panel", placement: "card", panel }`                 | A live card in the chat: title, summary, first 5 rows. The same id updates it in place; click, or `tab` then `enter` from an empty composer, opens it as a view | 24 panels, shared with tabs               |
| `{ kind: "status", status: { id, text, tone?, action? } }`    | A footer item beside the context meter; click runs `action`                                                                                                     | 24 characters, one line; 3 shown          |
| `{ kind: "key", key: { id, key, label, action, context? } }`  | A key in the hints and the `?` popup, grouped by owner. The footer shows every hint that fits whole, built-in first; `?` lists the rest                         | Global keys need ctrl or alt; 8 per owner |

An action is `{ kind: "prompt", prompt }`, `{ kind: "flow", flow, input? }`,
`{ kind: "agent", agent, prompt? }` or `{ kind: "open", surface }`. A panel
row's action is `{ label, prompt }` or `{ label, action }`.

Cells publish with `ui.publish`; a worker's ids are prefixed `<tab>/` and its
cards stay in its lane. A repository declares UI in a markdown flow's
frontmatter, which is metadata only, so nothing is imported to show it:

```yaml
metadata:
  tui:
    keys:
      - key: alt+p
        label: Plan release            # no action: runs its owner; an agent gets the label as its prompt
    status: true                        # the owner's latest run or agent tab
    card: true                          # each run of the owner as a live card
```

Where `metadata` must map strings to strings (`SKILL.md`), `tui` may be the
same mapping as a JSON string. Any change under `flows/` re-lists the registry
within 300 ms and replaces every repository contribution at once.

Built-in keys always win. A contributed key that collides with one, or with a
key another owner holds, is refused: a cell gets the one-line reason, and a
repository's collision or malformed manifest shows as `✗ N extensions` in the
footer, which opens an Extensions view with one row per problem. Built-in
plugins contribute the same values: the Smithers tab (`plugin:smithers`, open
while `/smithers` shows it) and one monitors status item while any monitor is
active (`plugin:monitors`). A `{ kind: "flow" }` key on a markdown flow starts a
durable run on the control plane, which runs the flow's prompt itself.
`examples/custom-ui` is a repository that adds a key, a status item and a live
card.

## Flows

`/flows` lists the file flows in `<cwd>/flows/<name>/flow.ts` (a `Flow.make`
default export) with their descriptions; Enter runs one. `/flow <name>` takes a
JSON object or `key=value` arguments. A run starts in its
own tab and runs through the same native control host as `smthrs flow start`: plan,
approve for this run, run, watch. Missing required input opens a form built
from the payload schema by `@smthrs/ui/flow-form`, shared with the GUI, once the composer is empty and no approval is pending;
Esc, Ctrl+K, Ctrl+S and the tab keys close it and leave the run parked. A
parked run never blocks `/new`, `/resume`, `/fork` or undo. Flows whose envelope grants every capability (`*`) use the same y/n/a approval row. Its status settles
only from the control plane's watch; **x** asks the control plane to cancel.

Listing reads `flows/` without importing anything and refreshes within 300 ms
of any change there. After first draw, projects with `flows/` warm the host
in the background, importing modules and opening `<cwd>/.flows` (the store `smthrs runs` reads), so an edited `flow.ts` needs a
restart to run. A markdown flow is a custom agent (below); choosing one in
`/flows` starts `/agent <name>`. Do not run `smthrs` executors in the same
directory at the same time. Restarting marks unfinished runs interrupted; retry
resumes the durable run.
`/smithers` opens the Smithers tab: every run, newest first, and the discovered flows.

Every turn runs with `SmithersPlugin` from `@smthrs/agent`: the system prompt
names the key packages and `smthrs` verbs, and `smithers.guide` returns the
details. The coordinator also gets `smithers.flows`, `smithers.run` and
`smithers.inspect` over the same runs (model-invocable flows only);
`smithers.run` returns a `requested` receipt at once. `smithers.flows` returns
`{name, description, agent, input}`: `input` lists up to 12
`{name, type, required}` fields once a run has imported the module (listing
never imports it), and `[{name: "args"}]` for an agent. The coordinator's
`Flow runs:` context also lists the store's 20 newest runs this session did not
start, such as `smthrs flow start` runs, marked `by: "cli"`. Reading them opens
no flow module and creates no store.

## Monitors

The coordinator has `monitor.create`, `monitor.list` and `monitor.stop`. A
monitor watches a worker tab, a `smithers.run` run, or a shell command's output,
on source events or an interval (10 s to 24 h; shell needs one). Each change
goes to Jev (`AI_GATEWAY_API_KEY`), which answers whether it is notable for the
monitor's `watch`; only a yes asks `openai:gpt-6-luna` for a one-line update,
shown as a toast and a chat row. An unchanged source asks nothing. There is no
fallback: without the key `monitor.create` is refused, and a Jev, Luna or
source failure fails the monitor with a typed error row. Creating the same id
restarts it. A shell monitor runs its command every tick, so creating one is
asked like `bash` under `--approve ask` and refused under `deny`; on `/resume`
and `-c` it asks again before its command runs. Monitors persist in the
session and resume on `/resume` and `-c`.
Stopping a monitor cancels its current shell command. Changing sessions and
quitting cancel active monitor commands too; quit waits within its 3-second
shutdown limit.

## Estimates

Every chat turn, worker tab and flow run gets a time and token estimate when it
is requested, and is scored when it settles. A flow or a turn is estimated from
its own past runs; a delegated task asks GPT-6 Luna with the most similar past
tasks and the model's own past errors in the prompt, or takes the median task
without a model. A model failure is logged with its reason and toasts once.
Scores calibrate the next estimate. A running tab and a working turn show
`~7m·250k` (time left, tokens) or `late`; the coordinator's `tab.eta` flow
answers ETA questions, queued tabs included. The eval log is
`<session dir>/<cwd slug>/evals/estimates.jsonl`. See
`.plans/estimation-system.md`.

## Custom agents

A custom agent is a markdown flow, `flows/<name>/flow.mdx` (or `SKILL.md`).
There is no other agent format: `smthrs flow start`, approvals and the app read
the same file. The body is the agent's system prompt; the frontmatter sets the
rest.

```yaml
---
description: Reviews the uncommitted change and returns a verdict.  # picker row
model: sol          # sol, astra, luna, opus, fable, qwen, or provider:modelId
effort: high        # none, minimal, low, medium, high, xhigh, max
capabilities: ["fs:read:**", "proc:spawn:*"]  # envelope; absent = every capability
flows: [read, grep, bash]  # standard flows it may call; absent = all of them
disable-model-invocation: false  # true = only a person may start it
---
```

`/agent` opens the Agents picker (name, model, description); choosing a row
puts `/agent <name>` in the composer, because the prompt is the agent's one
field. `/agent <name> <prompt>` opens a worker tab titled `<name>: <prompt>`.
The coordinator sees `Agents: [{name, description}]` (model-invocable agents,
at most 20) and starts one with `agent.delegate {id, title, prompt, agent}`.

Both doors persist the tab and return `requested` before the file is read; the
body is read when the tab launches, so chat stays usable while it loads. The
seat is the request's `model`, then the file's `model:`, then the worker seat.
The file may declare `model: [sol, opus]` to set an ordered primary and fallback list.
An explicit model override uses the host's fallback settings.
The tab runs as a worker with the body appended to the worker instructions,
`effort` as its reasoning effort, `capabilities` as its envelope and `flows`
narrowing the filesystem and shell flows. The registry lists a body that
declares `flows:` with capabilities `*`; the tab still runs under the file's
own `capabilities:`. Retry reads the file again, so edits apply,
and keeps the agent and the model. The tab records `agent: {name, digest}`.

Every refusal is a code and one line:

| Code             | When                                                       | Where                                                               |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `unknown_agent`  | No flow has that name                                      | Refused at once (tab `failed` if the first listing had not arrived) |
| `not_an_agent`   | The name is a `flow.ts` module                             | Refused at once; use `/flow` or `smithers.run`                      |
| `not_invocable`  | `disable-model-invocation: true` and the coordinator asked | Refused at once                                                     |
| `unreadable`     | The body could not be read                                 | Tab `failed`, retryable                                             |
| `unknown_seat`   | `model:` names no alias or known provider                  | Tab `failed`                                                        |
| `unknown_effort` | `effort:` is not a reasoning effort                        | Tab `failed`                                                        |

`examples/custom-agent` is a directory with one agent; run
`bun run tui apps/tui/examples/custom-agent` and type `/agent review`.

## Tests

| Command           | What                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `bun test ./test` | Transcript fold over a recorded run, and the pure modules                                     |
| `bun test ./e2e`  | The TUI in a real PTY through [zmux](https://github.com/smithersai/zmux): keys in, screen out |

The end-to-end suite needs `zmuxd` (`$ZMUXD`, `PATH`, or `~/zmux/zig-out/bin`).
Its model turns replay `test/fixtures/fix-add.jsonl` through the replay seat:
`SMITHERS_TUI_REPLAY=<file>` streams a run recorded with
`SMITHERS_TUI_APPROVE=all SMITHERS_TUI_RECORD=<file> bun src/ask.ts "<prompt>"`, and its cells run for
real. `SMITHERS_TUI_REPLAY_SPEED` and `SMITHERS_TUI_REPLAY_HOLD_MS` pace it.

Quoted `/flow` values retain spaces: `/flow echo text="hello world"`.
A durably parked flow shows `parked`; its tab retains the question. `r` resumes
the same run, `x` stops it, and chat stays usable. Routine tree diagnostics and
their hashes appear only when expanded with Ctrl+O.
