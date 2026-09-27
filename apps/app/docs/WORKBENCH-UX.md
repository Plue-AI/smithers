# Workbench UX: the Piper rows in Smithers

Owner: design (this document is the brief the NO INVENTION law refers to for
every surface below). Audience: will, the implementation lanes, the plue team.
Scope: the native app in `apps/app` against the plue backend (`~/plue`), through
the first three tracer bullets. Companion canon: `apps/DESIGN.md` (brand,
layout grammar, card idiom), `apps/app/AGENTS.md` (EMBED LAW, NO INVENTION,
frames, flux), `apps/app/docs/LOCAL-APP.md` (routes, tabs, frames),
`~/plue/docs/specs/{product,workspaces,design}.md` (backend product truth).

Status: 2026-09-01 draft. Nothing here is built. Section 8 lists the lanes and
who is running them.

## 0. Position

Google's stack is not twelve tools. It is two nouns and a habit. The nouns are
the **Workspace** (CitC: your working copy is the repository at a change, on a
machine you never set up) and the **Change** (the CL: one unit of work that is
described, reviewed, checked, and landed as a whole). The habit is that every
other surface takes one of those two nouns as its argument: Critique reviews a
Change, Tricorder annotates a Change, TAP checks a Change, OWNERS gates a
Change, Code Search opens a file in a Workspace, an LSC is a fleet of Changes.

So the app adds two first-class objects and one rule, and the remaining rows
become cards:

- `workspace` — a persistent NixOS computer bound to a repository bookmark,
  with a terminal, a desktop, files, services, and previews.
- `change` — a jj change (or stack) with its description, diff, findings,
  checks, owners, reviews, and landing state.
- The rule: a bare repo-scoped command means the selected repository
  (`RepoContext`).

Falsifiable claim: once `workspace` and `change` exist as embedded cards with
maximize, every other row in the table is an additional card or a facet of one
of those two, and needs no new navigation model. The falsifier is any row below
that needs a page.

What is missing and cannot be designed around: plue's workspace spec covers
terminals over WebSocket to SSH, files, services, and preview URLs
(`~/plue/docs/specs/workspaces.md` §5). It has no desktop or display transport.
The NixOS spike (`~/plue/spikes/nixos-guest/REPORT.md`, 2026-09-01) proves a
NixOS guest boots with systemd as PID 1 on the Microsandbox runtime; it says
nothing about a display. The desktop surface in §3.1 therefore states the
contract the UI needs (§6) and lets the backend choose the wire. pion WebRTC is
already in plue (`internal/wsrunner`), so WebRTC video plus a data channel for
input is the shortest path; a WebSocket VNC framing is the fallback.

Demand check, stated as assumptions because nobody outside this team has been
asked: the buyer of the desktop surface is will and the agent fleets that need
a real display to test UIs. The buyer of Change plus Review is every landing
that today round-trips through GitHub PRs. If neither holds, build the Change
surface first and defer the desktop.

## 1. Vocabulary

One line each. Names are the ones plue already uses; the app never invents a
second word for the same thing.

- **Repository** — a Smithers Cloud repository, the source of truth. The local checkout
  the app opens today is a working copy of one.
- **Bookmark** — a jj bookmark (branch).
- **Change** — a jj change: id, description, diff, position in a stack.
- **Landing** — plue's review-and-merge object for a change stack
  (`draft`, `open`, `closed`, `merged`; `internal/services/landing.go`).
- **Workspace** — a persistent Microsandbox VM per user per bookmark
  (`starting`, `running`, `suspended`, `stopped`, `failed`), lazily created.
- **Desktop** — a graphical session inside a Workspace (new; §3.1).
- **Target** — a Smithers build/test node (the targets table that exists).
- **Run** — one execution of a target or a flow.
- **Finding** — one analyzer or reviewer result anchored to a Change at
  `path:line`, with a severity and, when possible, a fix.
- **Owner** — an OWNERS rule that must approve a path.
- **Task** — a plue issue.

## 2. Laws every surface obeys

Restated from the canon; nothing new.

- **EMBED LAW.** Every surface is a card in the transcript at conversation
  width, composer visible. Maximize is a presentation transition of the same
  component, entered only by the user's act. The desktop is not an exception:
  it is a card first (§3.1).
- **NO INVENTION.** The anatomy lists below are exhaustive. If it is not
  listed, it is not rendered.
- **Frames.** Every card has a durable identity, a parent frame, and a place in
  the frame graph; the URL `/w/:workspace/b/:branch/f/:frame` points into
  durable state. Section 9 records the one decision this raises.
- **Flows.** Every act is a flow with slash, agent, and button invocations of
  the same name. Consequential acts (`land`, `abandon`, `suspend`, `fork`,
  `migration.run`, `findings.fix`) carry `confirm`: the agent may ask, the
  human performs.
- **Trigger axis.** Input capture for the desktop, maximize, and minimize are
  `trigger: user`.
- **The 300ms law.** Background work states itself on the toast stack; a
  card's own pending state is not a toast.
- **State in collections.** `workspaces`, `changes`, `findings` are TanStack DB
  collections fed by the transition dispatcher; components project them.
- **Copy.** Sentence case, no badges that are scores, mono meta rows for
  ids and timestamps, the ember/sediment/water/slate status mapping.

## Responsive views

A view opens immediately. `preparedView` owns the pending card, request sharing,
short-lived preloads, failure state, and navigation races. Its `read` returns data;
only activation publishes the card or runs `before`/`after`. `project` combines a
prefetched result with current local state when the view also carries live facts.
Never put a mutation, provisioning, a read receipt, or tutorial progress in `read`.

A flow declares `prepare` beside its handler. Recommendations eagerly call it;
`flowAction` binds the same name and arguments to click, pointer intent, and keyboard
focus through one delegated listener. Existing runtime and prerequisite checks
still apply. Prefetch failures stay silent and are retried on activation. Resource
updates and mutations invalidate the bounded cache. Heavy renderers share their
preloadable module with Suspense and display `ViewSkeleton` when still loading.

## 3. Surfaces

Each row: the job, the card, its embedded and maximized anatomy, the flows, the
states, the data it needs, and the tracer bullet that proves it. "Exists" means
the route or card is in the tree today.

### 3.1 Workspace, desktop, compute (CitC + Google's cloud)

> **Status (lane `citc`, landed):** the card below exists minus the Desktop
> facet (waits on plue Phase B) and minus the image/size/uptime line — plue's
> workspace DTO carries none of those (plue#446), so the header is repo ·
> bookmark · the BOOKMARK's head, labeled as such. The Terminal facet runs
> over the `/api/cloud-ws/` tunnel; Files and Services render empty with the
> plue#449 wording until their routes exist; the Snapshots rows act (Fork
> from, Make template, Delete). `box.desktop`, `workspace.attach`,
> `box.services`, and `workspace.logs` are unregistered until then;
> the shipped flows are `box.open/view/terminal/suspend/resume/fork/
> snapshot/snapshot.fork/snapshot.delete/template/sessions/session.destroy/
> delete/list/facet`.

**Job.** Open the repository at a bookmark on a computer that is already set
up, and see it: a terminal, a desktop, the files, the services.

**Card `workspace`.** Embedded anatomy, top to bottom:

1. Header: repository name · bookmark · change id (mono), state pill
   (`starting` water-soft, `running` water, `suspended` slate, `stopped` slate,
   `failed` ember).
2. One line: image (the NixOS configuration name), size, uptime or suspended
   since.
3. Facet strip, as tabs inside the card, no page change: **Desktop**,
   **Terminal**, **Files**, **Services**, **Snapshots**.
4. The active facet's body (below).
5. Footer actions, right-aligned, all flows: Suspend / Resume, Fork,
   Snapshot, Open in tab.

Maximized: the same component fills the frame; the facet strip becomes a
left rail; the composer stays mounted below.

**Desktop facet.** Embedded: a live thumbnail of the display (one JPEG per
second while visible, nothing while hidden) with a centered "Attach" button.
Attach is the user's act; nothing captures input until they press it. After
Attach, the card body is the live video at the card's width, input focused,
and a mono meta row under it: connection state, round trip, and the resolution
the guest is rendering at. Maximized: the video fills the frame; the meta row
stays.

Input rules, explicit:

- Focus: clicking the video attaches; the card border shows the brand focus
  ring while input is captured.
- Release: `Esc` twice within 500ms, or clicking anywhere outside the video,
  releases capture. The first `Esc` is delivered to the guest.
- Shortcut passthrough while captured: everything reaches the guest except
  `Cmd+Q`, `Cmd+W`, `Cmd+H`, `Cmd+Tab`, `Cmd+,` and the two-`Esc` release. `Cmd`
  is sent as `Super`.
- Clipboard: `Cmd+C` and `Cmd+V` inside the guest use the guest clipboard; a
  "Copy to Mac" and "Paste from Mac" pair in the meta row bridges explicitly.
  No silent clipboard sync.
- Resolution: the guest renders at the video element's size, re-negotiated on
  resize with a 250ms debounce; the meta row states it.
- Disconnect: the video freezes and the meta row reads "Reconnecting…"; after
  20s it reads "Disconnected — Attach to reconnect" and capture is released.
- Suspended workspace: the facet shows the last thumbnail dimmed with a Resume
  action; Attach resumes then attaches.

**Terminal facet.** The shared xterm adapter (`tabs/TerminalView.tsx`)
embedded in the card, connected to the workspace over the plue
WebSocket-to-SSH route. The terminal tabs and the local PTY retired
(smithersai/smithers#2229); the facet is the one terminal surface.

**Files facet.** `files.list` and `files.read` with a workspace as the target:
the same `file-list` and `file` cards, the same markdown editor. A path in a
workspace is read through plue's workspace file operations, not the local
route.

**Services facet.** Rows: name, state, port, one Logs action that opens a
`service-log` card (tail, follow toggle), one Restart action.

**Flows.**

**States.** Empty: no workspace for this bookmark, the card offers Open.
Starting: header pill plus a provisioning line from plue's SSE
(`workspace watch`). Failed: the reason plue gives, one Retry. Stale: the
card is older than the collection row; the row wins.

**Data.** Exists: create, get, list, delete, ssh, exec, files, services, SSE
status. New: the desktop
session contract in §6, a thumbnail route, and a workspace class with enough
memory for a display (the 512MB class cannot run a compositor; the spike used
c3-standard-8 hosts, the guest size is the open question).

**Tracer bullet A.** `/box.open main` on a Smithers Cloud repo shows the card
`running`; the Terminal facet echoes a command; the Desktop facet shows a live
thumbnail of a NixOS session; Attach types into a terminal emulator inside the
guest and the keystrokes appear. Exit criterion: a screenshot of the card,
embedded, with the guest's clock visible and ticking.

### 3.2 Change (the CL)

**Job.** See one unit of work whole: what it says, what it touches, whether it
is safe, who must agree, and land it.

**Card `change`.** Embedded anatomy:

1. Header: change id (mono), stack position ("2 of 3 on feature-x"), landing
   state pill (`draft` slate, `open` water-soft, `merged` water, `closed`
   slate), author, updated at.
2. Description: the jj description, rendered as markdown; an Edit action turns
   it into the shared markdown editor in place (this is the commit message,
   so the editor is the authoring surface, not a form).
3. Diff stat line: files changed, insertions, deletions; each file a row that
   opens the `diff` card at that file.
4. Facet strip: **Diff**, **Findings**, **Checks**, **Owners**, **Review**.
5. Footer: Land (confirm), Request review, Abandon (confirm), Open in tab.

Maximized: three columns, left file list, center diff, right the active
facet's rail (findings, checks, owners, or review threads).

**Card `diff`.** One file or the whole change through the library
`DiffHunks`, unified by default, split when maximized and wide; a hunk header
carries the anchor for comments (§3.3). Large diffs render by reference: the
first 400 lines and a "Load the rest" action.

**Stack.** `change.stack` renders the `change-stack` card: one row per change
in order, each with its landing state and check state; rows open the change
card. The stack is the unit an LSC wave lands (§3.8).

**Flows.**

| Flow | Args | Invokers |
| --- | --- | --- |
| `change.view` | `<changeId\|landing#> [repo]` | user, agent |
| `change.new` | `[description]` | user, agent (runs in the active workspace) |
| `change.describe` | `<changeId> <text>` | user, agent |
| `change.diff` | `<changeId> [path]` | user, agent |
| `change.stack` | `[changeId]` | user, agent |
| `change.land` | `<changeId>` | user; agent confirm |
| `change.abandon` | `<changeId>` | user; agent confirm |

Change acts require an explicit `owner/repo` when the loaded change ID
appears in several repositories. A committed mutation retains its success
result and returned identities if a card refresh fails, with a refresh
warning. Finding dispatch still opens its returned workspace; split attempts
both returned change cards. Retry the read to reconcile a refresh failure.

**States.** No changes on the bookmark: the card says so with New change.
Conflicted: the header carries an ember "conflicts" line and the diff card
shows the conflict markers, never a merged view.

**Data.** Exists: landings create, list, get, land, comments, reviews;
`listAllChanges`, `currentChangeId`. New: a per-change diff route (today a
diff means `jj diff` over workspace exec), a per-change stat route, and a
change description write.

**Tracer bullet B.** `/change.view` on an open landing renders the card;
the Diff facet shows the real diff; Land is a confirm flow that lands it on
Smithers Cloud. Exit criterion: the landing state pill goes `open` to `merged` on
camera without leaving the chat.

### 3.3 Review (Critique)

**Job.** Read a change with other people and with the agent, say what must
change, and agree.

**Where.** The Review facet of the `change` card. Not a separate card kind.

**Anatomy.** Embedded: a summary strip (verdicts by reviewer: approved,
changes requested, commented; the agent is one reviewer among them), then the
thread list, newest first, each thread showing `path:line`, the first
comment, the reply count, resolved or open. Maximized: the right rail lists
threads; the center diff shows each thread inline under its hunk with reply
and resolve controls.

**Comment anchor.** `{ changeId, path, side: "old" | "new", line }` plus a
content hash of the anchored line so a thread survives a rebase and reads
"moved" rather than pointing at the wrong line.

**Verdicts.** Human verdicts are user-only flows. The agent's verdict is a
Finding set (§3.4) rendered in the same summary strip under the agent's name;
it never approves on a human's behalf.

**Flows.**

| Flow | Args | Invokers |
| --- | --- | --- |
| `review.open` | `<changeId>` | user, agent |
| `review.comment` | `<changeId> <path>:<line> <text>` | user, agent |
| `review.reply` | `<threadId> <text>` | user, agent |
| `review.resolve` | `<threadId>` | user, agent |
| `review.approve` / `review.request-changes` | `<changeId> [text]` | user only |
| `review.ask` | `<changeId>` | user, agent (starts the agent review run; its findings land in §3.4) |

**Data.** Exists: landing comments and reviews. New: anchored comments
(`path`, `side`, `line`, `anchorHash`), threads with resolution, the
agent-as-reviewer identity.

**Tracer bullet B'.** Part of B: one anchored comment posted from the diff and
visible in the rail; `review.ask` produces at least one finding.

### 3.4 Static analysis and agent review (Tricorder)

**Job.** Every change carries its analyzer results, continuously, and each
result offers its fix.

**Card `findings`.** Also the Findings facet of the change card. Grouped by
analyzer (typecheck, lint, tests, security, agent review, each a plain
label), then rows: severity dot (ember / sediment / slate), `path:line`, one
sentence, and the actions Open (the diff at the line) and Fix (confirm).
A group header shows count and last run time. Nothing else.

**Fix.** `findings.fix` starts a flow run in the change's workspace that
applies the analyzer's suggested edit or asks the agent to fix that one
finding; the run card is the progress surface, and the finding row reads
"fixing" until the next analysis pass clears it.

**Continuous.** Findings arrive as plue check events on the change; the card
updates in place. A finding older than the change's current revision is
shown struck through as "stale" until re-analysis confirms or clears it.

**Flows.** `findings.list <changeId> [analyzer]`, `findings.fix <findingId>`
(confirm), `findings.mute <findingId> <reason>` (user only).

**Data.** New: a findings schema on changes (`analyzer`, `severity`, `path`,
`line`, `message`, `fix?: { kind: "patch" | "agent", payload }`), produced by
CI runs and by `review.ask`.

### 3.5 Build graph (Blaze)

**Job.** See the targets, their graph, and what a change affects, in the
workspace where they build.

**Exists.** `targets`, `graph`, `affected`, `ci-matrix`, `run-history`,
`run-timeline` cards and their `target.*` flows, all against the local
checkout.

**Change.** The target grammar gains a workspace: `target.list [workspace]`,
`target.graph [workspace]`, `target.affected [changeId]`. Runs execute in the
workspace over exec and stream over the workspace SSE, into the same
`target-run` card. No new card kinds.

**Constraint.** Builds do not run in 512MB VMs (Smithers Cloud skill, gotcha: never
run full builds in-VM). The workspace class for builds is the same open
question as the desktop's.

### 3.6 Code navigation (Code Search + Kythe)

**Job.** Find code by text or symbol, open it at the line, follow references.

**Card `search-results`.** Header: the query, the scope (repo or workspace),
the count, elapsed. Rows grouped by file: `path` then matching lines with the
match highlighted; a line opens the `file` card scrolled to that line. A
"Refine" action focuses the composer with the query prefilled as
`/code.search <query>`.

**File card.** Exists (`file`, markdown through the shared editor). Gains an
optional `line` in its payload; when present the card scrolls to and marks
the line. Symbol hovers and go-to-definition are out of scope until an index
exists; the honest first step is text search in the workspace (ripgrep) and
plue's code search for cloud repositories.

**Dependency graph.** The existing `graph` card is the target dependency
graph. A source dependency graph waits for the index.

**Flows.** `code.search <query> [repo|workspace]`, `code.goto <path>:<line>
[repo|workspace]`, later `code.refs <symbol>` and `code.def <symbol>`.

**Data.** Exists: plue code search (product spec §5.10). New: workspace
ripgrep over exec with a bounded result contract, and the line anchor on the
file card. An index (Kythe or an LSP-backed service) is a separate program.

**Tracer bullet C.** `/code.search resolveTargetRepo` over the workspace returns
grouped results; clicking one opens the file card at the line.

### 3.7 CI (TAP + Forge)

**Job.** Know whether a change is safe before landing, from the runs that
actually ran.

**Where.** The Checks facet of the `change` card: rows per check (name,
state, duration, a Logs action that opens the `run-timeline` card). The
affected set comes from `target.affected <changeId>`; the matrix from the
existing `ci-matrix` card. A change cannot land while a required check is
red; the Land action states which one.

**Flows.** `ci.status <changeId>`, `ci.rerun <changeId> [check]` (confirm),
plus the existing `target.affected` and `target.ci`.

**Data.** Exists: plue automation runs, checks on protected bookmarks. New:
checks attached to changes with the affected-target set.

### 3.8 Large refactors (LSC infrastructure)

**Job.** Make one change across many owners as many small changes, reviewed
and landed in waves.

**Card `migration`.** Header: the goal (one line), scope (a target pattern or
path glob), state (planning, awaiting approval, running wave n of m, done).
Body: waves as rows; each wave lists its changes with landing and check state
(the `change-stack` rows). Actions: Approve wave (confirm), Pause, Open a
change.

**Behavior.** `migration.plan` runs a flow that computes the scope and
proposes the wave split by owner; the card renders the plan; the human
approves a wave; the fleet (one agent per change, the recipe in
`~/smithers/.smithers/workflows/cloud-issue-fleet.tsx`) produces the changes;
each goes through §3.3 and §3.7; the wave lands when every change is green
and approved.

**Flows.** `migration.plan <goal> [scope]`, `migration.run <id>` (confirm per
wave), `migration.status [id]`, `migration.pause <id>`.

**Data.** Exists: the Smithers engine and landings. New: a migration record
linking waves to changes.

### 3.9 Ownership (OWNERS)

**Job.** Know who must approve a change, and whether they have.

**Where.** The Owners facet of the `change` card: rows per touched path
group, the OWNERS rule that applies, the approvers it accepts, and which
approval satisfied it. A missing approval is a sediment row with a Request
review action naming the owners.

**Flows.** `owners.view <path> [repo]`, `owners.request <changeId>`. Editing
ownership is editing the `OWNERS` file through a change.

**Data.** Exists: protected bookmarks with required reviews. New: per-path
`OWNERS` evaluation on a change (`/changes/{id}/owners`).

### 3.10 Tasks and specs (Buganizer)

**Job.** Track work, and jump from a task to the workspace and change doing
it.

**Exists.** `issue` and `issue-list` cards, `issues.*` flows.

**Change.** The issue card gains two rows when they exist: the workspace an
agent is working in (opens the `workspace` card) and the landing that
resulted (opens the `change` card). This mirrors plue's issue-to-workspace
automation (workspaces spec §5.5).

**Flows.** Existing `issues.*`; `box.open --issue <n>` reuses §3.1.

### 3.11 Source of truth (Piper) and working copy

**Job.** One place code lives; boxes hold working copies.

**Shipped (lane piper, ADR 0001; sidebar removed 2026-09-17).** The composer's
repository menu is the tree `org/ → repo → working copies`, fed by the cloud
inventory (`GET /api/cloud/api/user/repos` + `/user/orgs` + per-repo
`/bookmarks` for the default bookmark's head, through the `/api/cloud/*`
proxy). No mirror glyph — the backend has no
mirror status yet (plue#445). Selecting a repository names `org/repo`; a copy
names `org/repo#copyId`. The origin chip reads the selected box or `head @ qupxosqw` at a repository's head. `file` and `file-list` card headers
carry the global `address` and `readAt`; a `head moved to <id> · refresh`
line appears when the inventory's head commit differs from `readAt.commitId`
— nothing auto-refreshes. `/files.list` and `/files.read` accept the global
path as one token. The watched-repos collection, the `repos.watch*` flows,
and the first-run repo chooser are gone: the inventory is the one truth, and
signing in to Smithers Cloud (`/api/cloud-auth/*`, token in the macOS
keychain, never in the renderer) is the only door to it. The bare-command
rule (§0) applies to repository and box selections.

### 3.12 Review of the table

Rows that became a card: Workspace (`workspace`), Change (`change`, `diff`,
`change-stack`), Findings (`findings`), Search (`search-results`), LSC
(`migration`), Services logs (`service-log`). Rows that became a facet of
`change`: Review, Checks, Owners. Rows that already exist: Build graph, CI
matrix, Tasks, Files. No row needed a page. The claim in §0 holds on paper;
tracer bullets A, B, and C test it.

### 3.13 Runs (the agent's work on the workspace)

**Job.** Every run on the workspace is visible, reachable, and steerable from
the conversation — the operator never needs the CLI to see what their agents
are doing or to unblock one.

**Shipped (lane runs, `workbench-lanes/runs.md`).** Three embedded cards, all
over the workspace gateway's own projections and procedures: the `run-list`
inbox (`/runs.list`, count line by status, filter chips, Stop-all footer), the
`approvals-inbox` (`/approvals.list` — the workspace's pending gates, each
decidable in place because the row carries the gateway's submit-ready
envelope), and the `flow-run` card's grown lifecycle: Stop (confirming,
optional reason) on every live phase, Resume when the control plane names a
wait, Run again with the recorded launch input when settled, the steer row
(message, seat, thinking, tools) with `steering pending · delivered at the
next turn` until delivered, and Steps/Transcript/Events facet tabs —
Transcript follows the live run on `/runs.logs --follow`, Events is the raw
journal under `/debug.verbose`. What the wire does not carry is refused in
words, never invented: `by=` (no launcher on the run summary) and the wait's
reset time (no clock on `waitingReason`).

## 4. Wireframes

Embedded `workspace` card, Desktop facet, not attached:

```
┌ smithersai/smithers · feature-x · qupxosqw ────────── ● RUNNING ┐
│ nixos-gnome · 4 vCPU 8 GB · up 42m                              │
│ Desktop  Terminal  Files  Services  Snapshots                   │
│ ┌─────────────────────────────────────────────────────────────┐ │
│ │                     [ live thumbnail ]                      │ │
│ │                        ( Attach )                           │ │
│ └─────────────────────────────────────────────────────────────┘ │
│ 1440×900 · idle                                                 │
│                          Suspend   Fork   Snapshot   Open in tab│
└─────────────────────────────────────────────────────────────────┘
```

Attached and maximized (composer still mounted below the frame):

```
┌ ← → ⤢  smithersai/smithers · feature-x · qupxosqw   ● RUNNING  ┐
│ Desktop │                                                      │
│ Terminal│                 [ live video, input captured ]       │
│ Files   │                                                      │
│ Services│                                                      │
│ Snapshot│  connected · 38 ms · 1920×1080 · Copy to Mac · Paste │
└─────────────────────────────────────────────────────────────────┘
[ Ask Smithers to work on something…                          ↑ ]
```

Embedded `change` card:

```
┌ qupxosqw · 2 of 3 on feature-x ──────────────── ○ OPEN · will ┐
│ Serve repository files through one bounded, confined route     │
│ (description, markdown; Edit)                                  │
│ 9 files · +312 −41                                             │
│   apps/app/src/bun/RepoFiles.ts            +127                 │
│   apps/app/src/bun/routes/repoTargets.ts   +24  −0              │
│   …                                                            │
│ Diff  Findings (2)  Checks (5 ✓ 1 ●)  Owners (1 pending)  Review│
│                         Land   Request review   Abandon   ⤢    │
└────────────────────────────────────────────────────────────────┘
```

Maximized `change` card, Review facet: file list left, diff center with
threads inline, thread rail right; the summary strip across the top.

## 5. Desktop input contract

The renderer side of §3.1, stated so the backend and the UI agree:

- One session per attach; the session carries `width`, `height`, `scale`.
- Keyboard events are sent as `{ type: "key", code, key, down, mods }` using
  DOM `code` values; the guest maps them. `Cmd` is sent as `Super`.
- Pointer events are `{ type: "pointer", x, y, buttons, wheelX, wheelY }` in
  guest pixels.
- Clipboard is explicit: `{ type: "clipboard", direction: "toGuest" |
  "toHost", text }` only on the two actions in the meta row.
- Resize is `{ type: "resize", width, height, scale }`, debounced 250ms.
- The guest sends `{ type: "cursor", shape }` and `{ type: "state",
  connected, rttMs }` at most 4 times a second.

## 6. Data contracts the app needs from plue

| Contract | Exists | Needed by | Shape |
| --- | --- | --- | --- |
| Workspace CRUD, SSE status, exec, files, services, snapshots | yes | 3.1, 3.5, 3.6 | as specced in `workspaces.md` |
| Desktop session | no | 3.1 | `POST /api/repos/{o}/{r}/workspaces/{id}/desktop/sessions` → `{ sessionId, transport: "webrtc" \| "vnc-ws", signalUrl, iceServers?, width, height, expiresAt }`; input per §5 over the data channel or the same socket |
| Desktop thumbnail | no | 3.1 | `GET …/desktop/thumbnail` → `image/jpeg`, max 1/s per viewer |
| Workspace class with a display | no | 3.1, 3.5 | image + size selectable at create; the 512MB class stays for headless agents |
| Change read: description, stat, diff, stack | partial (landings) | 3.2 | `GET /api/repos/{o}/{r}/changes/{id}`, `…/diff?path=`, `…/stack` |
| Change description write | no | 3.2 | `PUT …/changes/{id}/description` |
| Anchored review threads | partial (comments) | 3.3 | comment gains `path, side, line, anchorHash`; threads gain `resolved` |
| Agent reviewer identity | no | 3.3, 3.4 | a reviewer kind `agent` on landing reviews |
| Findings on a change | no | 3.4, 3.7 | `GET …/changes/{id}/findings`, SSE on change events |
| Checks on a change with affected targets | partial | 3.7 | `GET …/changes/{id}/checks` |
| Code search over a workspace | no (cloud search exists) | 3.6 | exec-backed ripgrep with a bounded JSON contract |
| OWNERS evaluation | no | 3.9 | `GET …/changes/{id}/owners` |
| Migration record | no | 3.8 | waves → changes |
| Cloud API from the local app | partial (`/api/identity/*` proxy) | all | extend the local origin's proxy to `/api/cloud/*` so cookies and CSP stay the identity pattern (§9) |

## 7. Tracer bullets and exit criteria

Order is by dependency and by what can be shown.

1. **A — Workspace with a desktop.** Blocked on the desktop session contract.
   Unblocked parts: the `workspace` card, Terminal and Files facets, lifecycle
   flows. Exit: §3.1's screenshot.
2. **B — Change and Review.** Unblocked today for reading (landings exist) and
   landing; blocked for diff and anchored comments on two small routes. Exit:
   §3.2's `open` to `merged` on camera, one anchored comment.
3. **C — Code search to file at line.** Unblocked (exec ripgrep plus the file
   card's line anchor). Exit: §3.6.
4. **D — Findings and Checks facets.** After B, when the findings route
   exists.
5. **E — Owners, Tasks linkage, Migration.** After D.

Each bullet lands as a vertical slice: shared contract, bun route or proxy,
seam, card, flows, tests at every layer, and a T1 spec that drives it.

## 8. Lanes and dispatch

Seats per the delegation table: UI mocks to Kimi K3 (OpenCode), code lanes to
Codex Sol with Claude Opus as fallback, review to Fable + Kimi + Sol. On
2026-09-01 evening Codex is out of credits until Sep 8 and Fable subagents
hit the account session limit until 1am PT, so the mock lanes run now and the
code lanes are briefed here for the first available seat.

| Lane | Scope | Files | Exit | Seat | Status |
| --- | --- | --- | --- | --- | --- |
| M1 mock: workspace + desktop | §3.1 and §4, both states, all facets, tokens from `apps/app/src/mainview/styles/tokens.css` | `apps/app/docs/workbench-mocks/workspace.html` | opens standalone; embedded and maximized states toggle | Kimi K3 | running |
| M2 mock: change + review | §3.2, §3.3, §4 | `…/change.html` | same | Kimi K3 | running |
| M3 mock: search, findings, migration | §3.4, §3.6, §3.8 | `…/search-findings-migration.html` | same | Kimi K3 | running |
| C1 contracts | shared schemas for `workspace`, `change`, `diff`, `findings`, `search-results`, `migration` cards and the new flows' payloads | `packages/rpc/src/Cards.ts`, `packages/rpc/src/Workbench.ts` | tsc, Cards tests | Sol / Opus | briefed |
| C2 cloud proxy | `/api/cloud/*` on the local origin, the identity pattern, with the session capability stripped | `apps/app/src/bun/server.ts` | server tests | Sol / Opus | briefed |
| C3 workspace seam + card | `WorkspaceSeam`, `workspace` card, Terminal and Files facets, `workspace.*` flows, T1 spec | `apps/app/src/mainview/{state/seams,cards,flows}` | seam tests, card tests, T1 | Sol / Opus | briefed, waits on C1 |
| C4 desktop facet | video element, thumbnail, attach/release, §5 input encoder, meta row | `apps/app/src/mainview/cards/WorkspaceDesktop.tsx` | card tests with a fake session | Sol / Opus | blocked on plue desktop contract |
| C5 change seam + card | `ChangeSeam`, `change`, `diff`, `change-stack` cards, `change.*` flows, land confirm | as C3 | seam tests, T1 against Smithers Cloud | Sol / Opus | briefed, waits on C1 |
| C6 review facet | threads, anchors, verdict flows, `review.ask` run | `ReviewFacet.tsx` | tests | Sol / Opus | waits on plue anchors |
| C7 search + line anchor | `code.search`, `search-results` card, file card `line` | seams, cards | tests, T1 | Sol / Opus | briefed |
| P1 plue: desktop session + thumbnail | §6 rows 2–4 | `~/plue` | contract test | plue lane | briefed |
| P2 plue: change read/write, anchored threads, findings, owners | §6 rows 5–10 | `~/plue` | route tests | plue lane | briefed |

Each code lane brief lives in `apps/app/docs/workbench-lanes/` once written;
the mocks are the first artifact and the reference every code lane renders
against.

## 9. Open decisions

Each is consequential and hard to reverse; record the answer as an ADR.

1. **URL grammar.** `/w/:workspace/b/:branch/f/:frame` names the app's frame
   workspace and branch. With cloud repositories the natural identities are
   repository and change. Recommendation: keep the grammar, map the frame
   workspace to a repository and the frame branch to a bookmark or change id,
   and stop using the word "workspace" for the frame graph in new code.
2. **Desktop transport.** WebRTC (pion is in plue) with a data channel for §5,
   or VNC over WebSocket. Recommendation: WebRTC; VNC-over-WS only if the guest
   compositor cannot produce a video track within the first spike.
3. **Workspace class.** The 512MB VM cannot run a compositor or a build. A
   second class (the spike's host was c3-standard-8) is a capacity and cost
   decision, not a UI one.
4. **Cloud calls from the native app.** Renderer-direct calls would need CORS
   and credentials on the cloud origin and fight the app's COEP isolation.
   Recommendation: proxy through the local origin as `/api/identity/*` does
   today, with the local session capability stripped (already done for the
   identity proxy).
5. **Local checkout versus workspace.** When both are open for the same
   repository, a bare command means the active one in the selector; the
   selector shows which. No silent preference.

