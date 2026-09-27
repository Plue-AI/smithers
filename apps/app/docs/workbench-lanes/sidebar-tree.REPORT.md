# Lane A report: sidebar file tree, sessions wording, workspace name (2026-09-02)

> Superseded 2026-09-27 (smithersai/smithers#2229): the terminal and harness tabs, the `+` menu, `tab.terminal`, `tab.harness`, `tab.read`, `tab.menu`, `tab.close.confirm/cancel`, the `pty.*` transitions and the harness inventory are gone. Tabs are card tabs (`tab.card`, `tab.select`, `tab.close`); a terminal is the workspace card's Terminal facet. The text below is the record of the lane as it ran.
>
> Superseded 2026-09-27 (smithersai/smithers#2239): the local repository inventory (`repos.loaded`), pins (`repo.pinned`, `repo.unpinned`, `repo.unpin`), `repo.open`, `local:` working copies and `POST /api/repo/files` are gone. Working copies are boxes and shared copies.

Brief: `docs/workbench-lanes/sidebar-tree.md`, everything marked owner: lane A.

## What changed

### `packages/smithers/ui` FileTree (backward compatible)

`packages/smithers/ui/src/file-tree.tsx` gained the lazy, controlled surface the brief
names, plus two pass-throughs the laws require:

- `directories?: ReadonlyArray<string>`: explicit directory paths; an unloaded
  directory renders its caret with no children.
- `collapsed?: ReadonlySet<string>` + `onToggle?: (path, expanded) => void`:
  controlled mode. With `collapsed` passed the component never owns collapse
  state; a press only reports the state it asks for.
- `renderDirectoryEmpty?: (path) => ReactNode`: the one row an expanded
  directory with no loaded children shows (`""` for an empty root).
- `renderDirectoryFooter?: (path) => ReactNode`: a trailing row after a
  directory's children (the truncated line).
- `directoryProps?: (path) => FileTreeDirectoryProps`: the directory toggles'
  pass-through, the same shape as `nodeProps`, so every tree button carries
  `data-flow` without the host reaching into the DOM.
- `DataAttributes` typed onto both pass-throughs (`data-*` keys), so a host
  passing only `{ "data-flow": "…" }` compiles.

Existing consumers (`App.tsx` World sidebar, `ConversationCards.tsx`) are
untouched and keep the uncontrolled behavior. One CSS rule
(`.sui-file-tree-note`) in `uiCss.ts`; exports in `index.ts`.

### `apps/app` state

- `AppState.ts`: `RepoTreeRowSchema` (`{ id: "<copyId>#<path>", copyId, path,
  expanded, state: loading | loaded | failed, entries, error?, truncated?,
  loadedAt }`, `repoTreeRowId`), the sessions row's `workspaceName?` and
  `workspaceRenameOpen?`, `DEFAULT_WORKSPACE_NAME`, and six transitions
  (`repo-tree.toggled|loading|loaded|failed`, `workspace.renamed`,
  `workspace.rename.toggled`). Edits stayed on the sessions row and the
  transition union; lane B's `surface` enum line was left alone.
- `AppStore.ts`: `app-repo-tree` collection over a per-launch memory store
  (same collection machinery, dispatcher, and `acceptMutations`; never reaches
  the shared storage, so nothing survives a relaunch). Reducers for the six
  transitions; `repo.unpinned` forgets the copy's tree rows.
- `SchemaVersion.ts`: `app-repo-tree` declared in the inventory so
  `SchemaVersion.test.ts` stays exact. No version bump: the session fields are
  optional and the tree store is memory-only.
- `seams/RepoTreeSeam.ts` (new): `loadDirectory(copyId, path)` posts
  `POST /api/repo/files { repoId, path }` through `requestLocalFiles`, which
  was hoisted out of `FilesSeam.ts` (exported, not forked; `FilesSeam` now
  calls the same function). Loaded rows carry exactly the route's entries;
  failed rows carry the route's message verbatim.
- `seams/SeamContext.ts`: `readErrorMessage` now reads the local app's own
  envelope `{ error: { code, message } }` (`src/bun/routes.ts jsonError`).
  Before this, every seam showed its fallback instead of the local route's
  message ("Listing secret in … failed (403)" instead of "secret points
  outside the repository."). One FilesSeam assertion that had pinned the
  fallback text now pins the server's text.
- `controller/sidebar.ts` (new): `toggleRepoTree`, `renameWorkspace`,
  `toggleWorkspaceRename`; wired through `AppController.ts`.
- `flows/Flows.ts`: `repo.tree <copyId>[#path]`, `workspace.rename <name>`,
  `workspace.rename.edit` (all hidden, user-only; the agent keeps
  `files.list` / `files.read`). `flows/SlashPayload.ts` grammar for the two
  that take arguments. `flows/registry.ts`: the `tab` namespace's slash-menu
  label reads "Sessions". Pins updated in `registry.test.ts` (names) and
  `parity.test.ts` (ChromeBar affordance count 18 → 22).

### `apps/app` sidebar

- `tabs/ChromeBar.tsx`: the "Smithers" main row is gone. The strip opens with
  the workspace heading (`data-testid=workspace-heading`): the name is one
  `role="tab"` button, `data-flow="tab.select"`, `data-tab-id="main"`, so the
  roving ArrowUp/Down, Home/End, and Cmd+1 paths work unchanged; the pencil
  (`workspace.rename.edit`) swaps it for an input whose Enter runs
  `workspace.rename <value>` and whose Escape runs `workspace.rename.edit`
  (the draft lives in the input). Every local working copy row has a caret
  (`repo.tree <copyId>`, `repo-tree-toggle-<copyId>`); the expanded tree is
  the `FileTree` in controlled mode fed from `app-repo-tree` rows: directory
  rows run `repo.tree <copyId>#<path>`, file rows run
  `files.read <path> <repo.name>` (the existing file card in the chat),
  `loading…` / `empty` / the error verbatim render in place, and a capped
  directory shows the FileCards truncated line. Sessions render after the
  files under a `sessions` label once the tree is open. Wording: "New
  session", "New session in <copy>", "Close session", `aria-label`s
  "Sessions" / "Sessions and chrome".
- `tabs/TabBodies.tsx`: confirm reads `Close <title>?` / "this session" /
  `Close session`.
- `ChatCards.tsx`: the maximized card's action reads "Open in sidebar"
  (`data-testid` unchanged).
- `styles/chrome.css`: heading, caret, tree, state, and sessions-label rules;
  the width already read `--chrome-bar-width` (lane B).
- e2e specs (`tabs`, `terminal`, `harness`, `repo-targets`, packaged): the
  `tab-main` selectors moved to `workspace-heading` / `workspace-name`, the
  `.tab` counts drop the main row, and the confirm button is "Close session".
  Not run here (Playwright; the orchestrator owns the app instance).

## Tests added

`packages/smithers/ui/tests/file-tree.test.tsx`, describe "FileTree lazy and controlled":
- an explicit directory renders a caret with no children; expanded, it shows renderDirectoryEmpty once
- a controlled tree follows the collapsed set it is given
- an empty root renders renderDirectoryEmpty for ""
- directoryProps stamps the host's attributes on the toggle without surrendering its structure; renderDirectoryFooter trails the children
- without collapsed the tree still owns its state and reports onToggle

`apps/app/src/mainview/state/seams/RepoTreeSeam.test.ts` (new):
- /repo.tree <copyId> lists the root through POST /api/repo/files and writes the loaded row, nothing filtered
- a nested path rides the `#` grammar; a second toggle collapses without a request, a third expands without one
- a capped listing keeps the route's truncated flag
- a refusal writes the failed row with the server's message verbatim, and the next toggle retries
- a copy that is not open on this machine, or not a checkout, fails in place; an unknown copy is a refusal
- the rows are collection state for this launch only: a store reopened over the same storage starts collapsed
- unpinning a checkout forgets its tree rows
- the agent has files.list; repo.tree is the human's caret and never reaches the model's catalog
- /workspace.rename writes the heading's name; a blank name is refused; the pencil toggles the inline editor

`apps/app/src/mainview/tabs/ChromeBar.test.tsx`:
- (changed) the sidebar is vertical: the workspace heading first, the sessions below it, the chrome at the bottom of every session
- (changed) no repository: … the heading is the strip's first child
- the caret expands the copy's root and every deeper directory loads on its own expand; a file click renders the file card in the chat
- sessions nest under the copy after its files, labelled apart once the tree is open
- clicking the name selects the chat; the pencil opens an inline rename that Enter commits and Escape cancels
- nothing the sidebar, its menus, or its close confirm shows calls a session a tab (DOM scan of the sidebar's text, `aria-label`, `title`, `placeholder`; source scan of the ConfirmDialog's prose)

## Deviations from the brief, with reasons

- `repo.tree` argument grammar is `<copyId>[#path]` (the row's own id), not
  `<copyId> [path]`. Local copy ids are `local:<absolute path>` and both a
  path and a copy id may contain spaces, so a whitespace split cannot be
  deterministic; `#` is already the app's copy separator
  (`org/repo#copyId`). `repo.tree <copyId>` with no `#path` is the root, as
  the brief says.
- The tree rows and the expanded flag live on ONE collection row
  (`expanded: boolean`), the brief's second option.
- `files.read <path> <repo>` splits on whitespace (existing grammar), so a
  file whose path contains a space cannot be opened from the tree; the
  FileCards listing has the same limit. Not changed in this lane.

## Left unbuilt

- Left/Right on a directory row (the brief's nice-to-have). Tab order and
  ArrowUp/Down over `role="tab"` rows work; tree buttons are focusable.
- Flow summaries in `Flows.ts` still say "tab" ("Open a terminal tab", …).
  They are the composer's slash-menu copy and the model's catalog
  descriptions for `tab.*` ids, outside the sidebar; renaming them changes
  the agent's catalog, so they were left for a decision.
- `docs/LOCAL-APP.md` "Tabs" prose still describes the Smithers main row.
- Radix's `ConfirmDialog` does not portal under this test file's in-file
  happy-dom registration, so the confirm's copy is pinned at the source
  rather than in the DOM; the e2e specs click the real "Close session".

## Verification

Commands from the brief:

```
cd packages/smithers/ui && bun test tests/file-tree.test.tsx      # 10 pass, 0 fail
cd packages/smithers/ui && bun x tsc -p tsconfig.json --noEmit     # clean
cd apps/app && bun test src/mainview/tabs src/mainview/state/seams \
  src/mainview/state/InstructionsBudget.test.ts src/mainview/state/AppStore.test.ts
  # 305 pass, 1 fail: the 1 is ChangeSeam.test.ts failing to LOAD
  # ("Export named 'NO_INTERDIFF_REFUSAL' not found in ChangeSeam.ts"),
  # another lane's mid-edit of ChangeSeam.ts; none of this lane's files
  # are involved. Every test in tabs/, RepoTreeSeam, FilesSeam, SeamContext,
  # InstructionsBudget, and AppStore passes.
```

`bun x tsc --noEmit -p .` in `apps/app`: no errors in any file this lane
touched. The remaining errors are other lanes' mid-edit files
(`packages/rpc/src/Cards.ts`, `ChangeCards.tsx`, `ChangeSeam.ts`,
`WorkspaceCard.tsx` "egress", `Flows.ts` workspace-files actions).

`parity.test.ts`: the ChromeBar count pin is updated (22); the one remaining
diff is `SyncCards.tsx` 13 → 14, another lane's in-flight change.
`registry.test.ts` "one run path": this lane's three names are in the pin;

## Full `bun test src` in `apps/app`

1560 pass, 17 fail, 1577 tests across 172 files (78.6 s). The 17, none in a
file this lane touched:

- 3 × `src/bun/TargetGraph.integration.test.ts`: the pre-existing fixture
  failures the brief names (`//src:typeCheck` / `//src:srcs` not returned by
  the repository query; the force DAG).
- 10 × `src/bun/Main.test.ts`: the native main process ("printed no report
  (exit 143)", 5 s timeouts). The orchestrator owns the running app; this
  lane did not launch, relaunch, or quit it.
- 1 × `src/mainview/cards/WorkspaceCard.test.tsx`: expects "plue#449" from
  a `WorkspaceCard.tsx` another lane is mid-editing (both files modified in
  the working copy by that lane).
- 1 × `src/mainview/state/CloudTerminalClient.test.ts` "close 4404 is
  final": a real-socket test ("Expected 101 status code"); file untouched.
- 1 × `flows/parity.test.ts`: `SyncCards.tsx` 13 → 14 (another lane's
  in-flight affordance; this lane's ChromeBar pin is updated to 22).
  name pin (another lane's in-flight flow; this lane's three names are in).


