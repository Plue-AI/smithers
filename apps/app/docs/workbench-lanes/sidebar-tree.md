# Lane: sidebar as a file tree, sessions not tabs, flows surface, file panels (2026-09-02)

> Superseded 2026-09-17: the sidebar drawer is removed. The wordmark is a
> static mark; the footer chrome (Wiki, Dispatcher, Flows, Secrets, History,
> Account, reset, theme) is the always-on icon dock at the bottom left
> (`src/mainview/ChromeDock.tsx`). Tabs are card tabs (Cmd+W / Cmd+1..9;
> the terminal and harness tabs, Cmd+T and the `+` menu retired, #2229);
> repository selection lives in the
> composer's repository menu. The tree seam (`repo.tree`) keeps its slash and
> agent doors. The rest of this document is the historical record.
>
> Superseded 2026-09-27 (smithersai/smithers#2239): the local repository inventory (`repos.loaded`), pins (`repo.pinned`, `repo.unpinned`, `repo.unpin`), `repo.open`, `local:` working copies and `POST /api/repo/files` are gone. Working copies are boxes and shared copies.

Source: will, in chat, seven asks in order. Laws as always (apps/app/AGENTS.md,
apps/DESIGN.md): EMBED LAW (a file opens as a card in the chat; maximize only
by a user act), NO INVENTION (render only what a seam returned), no React
`useEffect`, all state in TanStack DB collections through the dispatcher,
every act is a flow (slash + button; `data-flow` on every button), tests
red→green, T1 spec where a user can see it. Never touch the three
pre-existing `TargetGraph.integration.test.ts` fixture failures. Do not
launch, relaunch, or quit the app: the orchestrator owns the running app.

## The asks, verbatim

1. "Can you make the repositories on the left side essentially a file tree?
   I believe we already have a file tree component to make this work. We
   should be able to expand them and this will open up the actual root of
   that repo"
2. "Don't call these tabs either"
3. "REPOS — name this workspace" (the `Repos` section heading)
4. "it says smithers at the top of the left sidebar for no reason remove that"
5. "where it says connect chat and world an option should also be flows
   which should allow us to look at flows"
6. "when we show a file it should be shown in a panel with a reasonable max
   height that we can scroll within"
7. "When I maximize a file I can't see the left side of it because the left
   side is under the left sidebar"

## Target sidebar

```
┌ Workspace ✎ ───────────────┐   heading = the workspace's name (default
│ smithersai/                │   `Workspace` until the user names it);
│  ▾ smithers  ~/smithers  + │   click the name → back to the chat
│     ▸ apps                 │   (tab.select main); ✎ → rename inline
│     ▾ packages             │   (workspace.rename <name>).
│        ▸ ui                │   Repo row: ▾/▸ expands the working copy's
│        file-tree.tsx       │   ROOT, lazily, one directory per fetch.
│     README.md              │   File click → files.read <path> <repo>
│     ─ sessions ─           │   (the existing file card in the chat).
│     ▸ Terminal             │   Rows under a copy that used to be "tabs"
│     ▸ Claude Code · 2m     │   are SESSIONS: terminals, agents, pinned
│  ▸ plue      ~/plue      + │   cards. No user-visible word "tab" anywhere
└────────────────────────────┘   in the sidebar, its menus, or its confirms.
```

- The `Smithers` main row at the top is gone. The way back to the chat is the
  workspace heading (one button, `data-flow="tab.select"`), plus Escape and
  the existing keyboard path. Tests that clicked `tab-select-main` move to
  the heading.
- Group headers (`smithersai/`) stay. A repo row with one working copy is
  the copy; with several, each copy is its own expandable row.

## Tree mechanics (owner: lane A)

- `packages/smithers/ui/src/file-tree.tsx` gains three backward-compatible props:
  `directories?: ReadonlyArray<string>` (explicit directory paths so an
  unloaded directory renders with a caret and no children),
  `collapsed?: ReadonlySet<string>` (controlled mode; when passed the
  component never owns collapse state), and `onToggle?: (path: string,
  expanded: boolean) => void`. A directory that is in `directories` but has
  no loaded children renders its toggle and, when expanded, one child row
  from `renderDirectoryEmpty?: (path) => ReactNode` (the host renders
  `loading…`, `empty`, or the error verbatim). Unit tests in
  `packages/smithers/ui/src/file-tree.test.tsx` (extend the existing one if present).
- New collection `app-repo-tree` (AppStore + SchemaVersion), row
  `{ id: "<copyId>#<path>", copyId, path, state: "loading" | "loaded" |
  "failed", entries: Array<{ name, kind: "dir" | "file" }>, error?,
  truncated?, loadedAt }`. Expanded paths live in a second small collection
  `app-repo-tree-expanded` (`{ id: "<copyId>#<path>" }`) or on the same row
  as `expanded: boolean`; either way it is collection state, never React
  state, and it is NOT persisted across launches (a repo can change on disk).
- New seam `state/seams/RepoTreeSeam.ts`: `loadDirectory(copyId, path)` posts
  `POST /api/repo/files { repoId, path }` (the existing route; see
  `FilesSeam.listLocal` for the request and response shape, reuse it, do
  not fork it) and writes the row. Failures write `state: "failed"` with the
  server's error text verbatim; the tree shows it in place. Seam test with
  the real route contract like `FilesSeam.test.ts`.
- Box lane L1 (box-tab-tree): a cloud workspace copy (a box) carries the same
  caret. `loadDirectory` branches on `copy.kind === "workspace"` and reads
  `GET /api/repos/{o}/{r}/workspaces/{id}/files?path=` (the route the Files
  facet uses), mapping plue's `type: "dir" | "file"` rows to the tree's
  `{ name, kind }`. A box the inventory shows as pending, starting, suspended,
  stopped or failed fails the row with its state sentence and sends no
  request. File rows on a box bind `box.file <path> <workspaceId>`;
  local rows keep `files.read`. `repo.tree` registers with
  `runtimeAny: ["local.repositories", "cloud"]` so the web host has it.
- Box lane L2 (shared-box): a public catalog repository carries one SHARED
  copy, `shared:<org/repo>` (`WorkspaceViews.sharedCopyOf`): the read-only
  virtual box every signed-out reader shares over the mirror, no VM and no
  terminal (factory design session ruling; spec 04 §2 gives a signed-in
  person one box per branch). It is a materialized view, never a stored
  row: present while the catalog row stands and the visitor has no box on
  that repository. `kind: "shared"`, `access: "read"`, `bookmark` = the
  row's head bookmark (`RepoLink.openRequestedRepo` reads it from
  `GET /api/repos/{o}/{r}` `default_bookmark`, a public read); the row
  reads `<bookmark> · shared · read-only` (`workingCopyLabel`, the one label
  rule the sidebar and the connect menu share). `loadDirectory` branches on
  `copy.kind === "shared"` and reads `GET /api/repos/{o}/{r}/contents[/path]`
  (the files flows' public read, allowlisted signed out by
  `apps/server/src/publicRepositoryReads.ts`); file rows bind
  `files.read <path> <org/repo>`. Its root opens on the first paint of the
  catalog repository. No write door renders on a read-only copy (no `+`, no
  unpin); the chrome's Sign in line is the reader's door. Every row the seam
  writes holds its directory in one order, `FilesSeam.sortEntries`
  (directories first, then by name, the order the file-list card reads in):
  the three routes do not agree on one, and the mirror answers a git tree's
  byte order, where `CHANGELOG.md` precedes `Cargo.lock`.
- Flows: `repo.tree <copyId> [path]` — user and button only (the agent has
  `files.list`); toggles expansion and loads the directory on first expand
  (or when the row is `failed`, retry). `files.read <path> <repo>` is the
  file click; it renders the existing file card (markdown through the
  editor). Register in the catalog like the other `repo.*` flows; the
  instruction-budget test must stay green (`InstructionsBudget.test.ts`).
- Expanding a repo row expands ITS ROOT: `repo.tree <copyId>` with no path.
  Root entries render directly under the row; nested directories indent.
  A `.git`/`.jj` entry renders like any other (no filtering invented).
  Listings above the route's cap show the existing truncated line.
- Keyboard: the existing roving focus in the strip keeps working over the
  new rows (the tree's buttons are focusable; Left/Right collapse/expand on
  a directory row is a nice-to-have, not required).

## Sessions wording (owner: lane A)

Replace every user-visible "tab" in the sidebar and its menus with the
thing itself: `New session in <copy>` (the `+`), the menu title, `Close
session` (the × and `TabBodies` confirm: `Close <title>?`, confirm label
`Close session`), and the card action `Open in tab` becomes `Open in
sidebar`. Flow ids (`tab.*`) do not change in this lane. Grep
`apps/app/src/mainview` for `\btabs?\b` in strings before finishing; tests
that asserted the old copy change with it.

## Workspace name (owner: lane A)

`sessions` row gains `workspaceName?: string`. Heading renders
`workspaceName ?? "Workspace"`. `workspace.rename <name>` (user + button,
no confirm) writes it; the ✎ button swaps the heading for an inline input
(Enter commits, Escape cancels; both routes are flows or the cancel is
local input state only). Empty names are refused with the refusal on the
composer line like other refusals.

## Flows surface (owner: lane B)

`session.surface` enum gains `"flows"`; the composer's surface menu gains
a fourth entry `Flows` (icon `Workflow` from lucide, flow id `flows`,
label in `SURFACE_LABELS`). The surface renders, as a pane in
`App.tsx` beside `world` and `connectors`, exactly what the `flow.list`
card renders (reuse that card's rows component; do not write a second
list): the workspace's flows with their existing per-row actions (run,
open). A repo must be loaded for the list, so the empty state is the
`flow.list` seam's own honest text. The `chat.surfaces` Palette and
keyboard paths include it. Tests: `Composer` surface menu test gains the
entry; a T1 spec if one exists for surfaces.

## File panel (owner: lane B)

The file card body (`FileCards.tsx`, the `world-card-doc` / listing
block) gets a scroll container with `max-height: 60vh` (`overflow: auto`)
in `cards.css`, both for plain text and markdown; maximized removes the
cap (`max-height: none`) like the other cards do. Long files scroll
inside the card; the chat never grows past the cap because of a file.

## Maximize beside the sidebar (owner: lane B)

`.smithers-card[data-maximized="true"]` and `.card-maximize-backdrop`
start to the right of the sidebar: add `--chrome-bar-width: 200px` on the
shell (the sidebar's width already lives in `chrome.css`; make it read the
var too) and set `left: calc(var(--chrome-bar-width) + 1.5rem)` on the
card and `left: var(--chrome-bar-width)` on the backdrop. The sidebar stays
usable while a card is maximized. Verify with a bridge screenshot when the
orchestrator relaunches; in this lane, a CSS pin test is enough (the
existing card-frame tests read `cards.css` for maximize rules, follow that
pattern).

## Verification (each lane)

```
cd apps/app && bun x tsc --noEmit -p . && bun test src/<touched dirs>
cd packages/smithers/ui && bun test src/file-tree.test.tsx   # lane A
```

Write `docs/workbench-lanes/sidebar-tree.REPORT.md` (lane A) and
`docs/workbench-lanes/sidebar-tree-B.REPORT.md` (lane B): what changed,
tests added (names), anything left honest-but-unbuilt.

## Ask 8 (added 11:40): "when I maximize a file I have no way of minimizing it" (owner: lane B)

A maximized card must always show a `Restore` button (icon `Minimize2`,
label `Restore`, `data-flow` of the existing restore flow) at the same
header slot the maximize button occupied, and it must stay visible while
the body scrolls (sticky header inside the fixed card). Escape restores;
clicking the backdrop restores. Find the flow that already restores
(`card.restore`/`card.maximize` toggle, check ChatCards.tsx ~1000 and
the frame controller) and bind to it rather than adding a new one. Test:
a card-frame test maximizes a file card and finds the Restore button,
presses it, and sees `data-maximized` gone; another presses Escape.
