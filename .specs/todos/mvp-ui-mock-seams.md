# MVP UI mock seams

Ledger of every seeded row and stub mutation behind the mounted MVP design cards
(mount-mvp-design, 2026-10-03, parent main 0380af69). Paths are relative to
`apps/app/src/mainview/` unless they start with `packages/` or `.specs/`.

## 1. The mock and how to delete it

`state/seams/DesignWorld/` is the one mock seam: a seeded design world held in
local-only TanStack DB collections, one instance per AppController
(`controller.design`), exposed to flow handlers as `actions.design`. Cards read
it through `DesignWorld/hooks.ts` (`useDesign*`); stub flows call its mutations
(`put`, `patch`, `setBranch`, `activity`, `present`, `move`, `merge`, ...). A
timer scheduler advances TODOs in place of the factory. Rows are mock-shaped
(`DesignWorld/world.ts`), not rpc wire models. Deletion is one change:

1. Delete `state/seams/DesignWorld/` (sources and its `*.test.ts`) and
   `state/DesignChat.test.ts`; rewrite the card and flow tests that assert
   `design:` ids against the real seams.
2. `state/AppController.ts`: drop the imports (~131–135), the `design` member
   (~484) and `createDesignWorld()` (~797), the `withDesignTodos(...)` wrap on
   `createTodoSeam` (~842), `runDesignTurn` / `designSend` /
   `cancelConfirmation` (~1223–1280; restore the real `send`), and `design` in
   the two context objects (~1510, ~1982).
3. `cards/CardRenderers.tsx`: drop the `design:` id intercept (`isDesignCard`,
   ~68) in `renderCardBody` and `pillStatus`.
4. Replace each card's `useDesign*` read and each flow's `actions.design` /
   DesignWorld import with the real seam named in §2.
5. Run §4; every command must print nothing.

## 2. Mocked seams

| What | File | Replaced by | Ticket |
| --- | --- | --- | --- |
| Home model (stack rows, main sync row, background runs) | DesignWorld/home.ts `designHomeModel`, `useDesignHome`; cards/HomeContainer.tsx `SeededHomeCard` (the `home` topic replaces it only with production props and served data) | topic `home`, `GET /api/stack` | T-APP-01 |
| `/stack` open | DesignWorld/home.ts `openDesignHome`; flows/entries/home.ts | per-member view topic | T-APP-01, T-APP-16 |
| Move | flows/entries/home.ts `actions.design.move` | `POST /api/todos/{n}/move` | T-STK-02 |
| Merge (person only) | flows/entries/home.ts `actions.design.merge` | `POST /api/todos/{n}/merge` | T-STK-04 |
| Background Retry / Dismiss | flows/entries/home.ts `retryRun`, `dismissRun` | `POST /api/runs/{id}` retry, dismiss | T-APP-01, T-STK-05 |
| Main sync Retry | flows/entries/home.ts `syncRetry` | `POST /api/github/sync` | T-GH-07 |
| TODO card rows (`todo:<n>` carries only n) | DesignWorld/todo.ts `useDesignTodoCard`; cards/TodoContainer.tsx | topic `todo:<n>`, `/api/todos` via TodoSeam | T-APP-02 |
| All `todo.*` / `draft.*` handlers | DesignWorld/todo.ts `withDesignTodos`; state/AppController.ts ~842 | createTodoSeam, `/api/todos` | T-APP-02, T-STK-01/02/05/06 |
| Draft audience `design:<member>` | DesignWorld/todo.ts `designAudience`; cards/DraftContainer.tsx | identity login | T-APP-02, T-ACC-01 |
| Scheduler (advances TODOs on timers) | DesignWorld/index.ts | factory on the install, observed through `home`, `todo:<n>` | T-STK-03, T-MCH-06 |
| Settings install model | DesignWorld/settings.ts `designInstall`; cards/SettingsContainer.tsx (the live model replaces it once `/api/install` serves one) | `install` + InstallSeam snapshots | T-APP-03 |
| `settings.capacity`, `settings.parallel` | DesignWorld/settings.ts `designSettings`; state/AppController.ts | `settings.*` against `/api/install` | T-APP-03, T-STK-03 |
| Quiet missing install | InstallSeam.ts `quietWithoutInstall`; state/AppController.ts | a real install answering | T-APP-03 |
| Members roster | DesignWorld/settings.ts `designMembersRoster`; cards/MembersCard.tsx | createMembersSeam, `/api/members`, topic `members` | T-APP-06, T-ACC-02 |
| `members.add` / `role` / `remove` | DesignWorld/settings.ts `designMembers`; flows/entries/members.ts | MembersSeam | T-APP-06, T-ACC-02 |
| Viewer role | DesignWorld/settings.ts `designViewerRole`; SettingsContainer (until a live install), MembersCard, members.ts | identity seam, one authorizer | T-ACC-03 |
| Secrets rows (no card consumes yet) | DesignWorld/settings.ts `designSecrets` | topic `secrets`, `/api/secrets` | T-APP-13 |
| Branch model (presence, activity, machine state) | DesignWorld/branch.ts `designBranchModel`; cards/BranchCard.tsx | topics `branch:<id>`, `:activity`, `:files` over runtime/LiveChannel.ts | T-APP-10, T-COL-02 |
| SSH line | DesignWorld/branch.ts `designSshLine`; flows/entries/branch.ts | SSH gateway | T-TRM-03 |
| `branch.fork`, `branch.add-to-stack` | flows/entries/branch.ts | `POST /api/branches/{b}` | T-MCH-08 |
| `branch.rebase` | flows/entries/branch.ts | `POST /api/branches/{b}` rebase | T-STK-08 |
| Terminal metadata and bytes | DesignWorld/branch.ts `designTerminalModel`, `designTerminalText`, `designTerminalPrompt`; cards/TerminalCard.tsx | CloudTerminalClient frames, `POST /api/terminals` | T-APP-12, T-TRM-01 |
| `terminal`, `terminal.watch`, `terminal.send` (owner only) | flows/entries/branch.ts → `design.typeTerminal` | CloudTerminalClient write | T-APP-12, T-TRM-01 |
| Burst Diff (subject = item ref) | DesignWorld/branch.ts, subjects.ts `designDiffs` | snapshot_before/after diff | T-APP-11, T-COL-04 |
| Viewer position on `/branch` | DesignWorld/shell.ts `goToBranch`, `shellViewsOf`; flows/entries/shell.ts | per-member view topic, `collaborators.view_state` | T-APP-16 |
| Presence | DesignWorld/shell.ts, branch.ts | `BranchPresence` lease roster | T-COL-06 |
| Branch tree rows | DesignWorld/shell.ts `designBranchTree`; SessionNavigation.tsx | topic `home` rows + presence | T-APP-16, T-UI-07 |
| Home line summary | DesignWorld/shell.ts `designHomeSummary`; ShellRail.tsx | topic `home` | T-APP-01, T-APP-07 |
| Timeline lines and edges | ShellRail.tsx `railLines`, `railEdges` (local transcript rows) | `chat_turns` title/tone/state + `/api/live` | T-APP-07 |
| Toasts | ShellRail.tsx `railNotices` (browser toast collection) | `toasts_hidden` view state | T-APP-07 |
| Issue, issue list, `issue.new`, `issue.comment` | DesignWorld/subjects.ts `newIssue`, `commentIssue`; flows/entries/subjects.ts | IssuesSeam `issues.view/list/create/comment`, GitHub sync | T-GH-02, T-STK-09 |
| File, file list, `file.restore` | DesignWorld/subjects.ts `designFileCard`; flows/entries/subjects.ts | FilesSeam, topic `branch:<id>:files`, Yjs | T-APP-11, T-APP-14, T-APP-15 |
| Diff | DesignWorld/subjects.ts `designDiffCard`, `designDiffs` | ChangeSeam `change.diff`, item evidence diff | T-APP-11 |
| Wiki page read, create | DesignWorld/subjects.ts `newWikiPage`, `wikiCard`; AppController.ts `runDesignTurn` | wiki collections, `wiki.open`, `wiki.new-note` | T-COL-09 |
| Review findings | DesignWorld/subjects.ts `ensureReview` | `/review` flow result, `change` findings | T-FLW-13, T-GH-04 |
| PR | flows/entries/subjects.ts `pr` | LandingsSeam `prs.view` | T-GH-03 |
| Issue/File/Diff/Wiki/Review/PR bodies | cards/SubjectCards.tsx `DesignSubjectBody` behind `design:` intercept | each kind's real card family | T-APP-11, T-COL-09, T-GH-03, T-MNT-02 |
| Run model (monitor, traces) | DesignWorld/run.ts `monitorOf`, `traceNamed`, `activeTraces`; cards/RunContainer.tsx | topic `run:<id>`, `/api/runs/<id>` | T-FLW-07 |
| `run`, `run.inspect`, `runs` | flows/entries/runs.ts | same topics; `presentRun` stays | T-FLW-07 |
| Flow model and versions | DesignWorld/run.ts `flowCardOf`, `flowNames`; cards/FlowCard.tsx | topic `flows`, `/api/flows` | T-APP-05, T-FLW-03 |
| `flow`, `flow.source`, `flows` | flows/entries/flow.ts | `/api/flows` | T-APP-05 |
| `flow.edit` (via `newTodo`) | flows/entries/flow.ts | templated TODO request | T-FLW-05 |
| Agents rows | DesignWorld/index.ts `agents` | topic `agents` | T-FLW-08 |
| Proposals | DesignWorld/index.ts `proposals` | learning runs | T-FLW-06 |
| Forms | DesignWorld/index.ts `forms` | FlowFormCards | product ruling |
| Chat turn (prompt → flows, reply, context, ask) | DesignWorld/chat.ts `designTurn`; AppController.ts `designSend`, `runDesignTurn` | host turn runner with preflight `context[]` | T-APP-16, T-APP-17 |
| A✓ acts and Review & merge | DesignWorld/chat.ts `designActCard`, `designMergeCard`, `useDesignAct`; cards/ActCard.tsx | topic `confirmations:<member>`, ConfirmView | T-APP-04 |
| Act cancel, merge card close | AppController.ts `cancelConfirmation` | topic `confirmations:<member>` | T-APP-04 |
| Bare Merge on a provider host opens the TODO (its Merge carries the reviewed head), not Review & merge: no `review_merge` source serves a real TODO | flows/entries/home.ts `merge` → `actions.showTodo` | `review_merge` confirmation from `POST /api/confirmations`, topic `confirmations:<member>` | T-APP-04, T-STK-04 |

A real seam may be added beside a seed, but the seed stays the fallback until the real seam serves data; no mounted card goes dark (#3496). Setup reads only InstallSeam. Settings controls are person-only. Legacy Settings replacement and image.add wait for the later T-APP-03 providers.

## 3. Follow-ups

- Rename the TodoContainer/HomeContainer prop to `presentation` so the "actions from cardActions" parity rule passes. T-APP-01, T-APP-02
- `onView` is a no-op in the Settings, Members and Commands bodies. Settings shared view state waits for T-APP-09; Members waits for T-APP-06
- CommandsBody rebuilds the catalog every render. T-CAT-01
- `secrets.*` flows still target Cloud routes. T-APP-13
- `box.suspend` / `box.resume` are legacy Cloud flows; Sleep and Wake are not offered. T-MCH-07, T-APP-10
- `todo.return-to-item`, `todo.keep-moved` are not in FlowName. T-COL-05
- `branch.bring-in`, `branch.discard-foreign` are not in FlowName. T-GH-06
- The `file` gesture drops `line`. T-APP-11
- Branch cutover deletions not done: WorkspaceCard.tsx, CommitCards.tsx commit families, CommitsSeam.ts. T-APP-10
- Presence heartbeat and tree presence wait on the live channel. T-COL-02, T-COL-06
- Add to stack takes no text. T-MCH-08
- Toasts are no longer in a modal dialog. product ruling
- Worker toasts lost Stop and Steer (one action per notice). T-APP-07
- Recommendation pill row is gone; `Recommend.ts` state has no UI. product ruling
- AppState still decodes `chatFilter` and `chatUsage`. T-CUT-04
- No view story for the shell breakpoint (1180px). T-UI-07, T-UI-08
- File card is read-only. T-APP-14
- Issue, Review, Wiki and PR have no rpc models or `*View.tsx`. T-MNT-02, T-MNT-04, T-COL-09, T-GH-03
- Make TODO uses `todo.new` with no issue link; `todo.from-issue` is unregistered. T-STK-09
- `wiki.save` is unavailable. T-APP-02
- StackSeam.ts and the `onHome` / `readRepositoryHome` chain remain. T-APP-01
- `history.show` → `/stack` rename not done. T-APP-01
- HomeView ignores `view.maximized`. T-UI-06
- ⌥↑ / ⌥↓ and last-look persistence not wired. T-APP-01
- `e2e/real/home.spec.ts` needs the real `home` topic. T-APP-01
- `card-kinds.md` still marks `factory.home` and `stack` pending. T-APP-01
- `CardAction.ts` types `todo.new` `text` as `string`; the flow makes it optional. T-APP-02
- The command runner hides decode failures behind a generic message. T-CAT-01
- FlowName.test reds for `storage.recovery.export` / `reset`. T-CUT-01
- FlowOrder.test: `code.hover`, `code.definition`, `code.diagnostics` unregistered (same on main). T-APP-15
- agentToolsList.test makes an `/api/install` request from InstallSeam. T-APP-03
- lint/conformance TestInventory sees 541 unregistered files because `inspectTarget` returns `[]`. T-PRC-01
- FlowView does not honour the `flow` payload version. T-APP-05
- MonitorCardCallbacks still lists `monitor` / `background.retry`. T-FLW-07
- FormCardsAgainstMain is red from every lane's new flows (`CUT_FLOW_NAMES`). T-CAT-01
- Bare Appendix A flows (`flow`, `flows`, `runs`, `run`, `issue`, `issues`, `file`, `files`, `diff`, `review`, `pr`) must join `SURFACE_FLOWS` or be hidden to clear the registry and RepositoryFlows orphan gates. T-CAT-01
- Persisted search-results cards carry flow `search.open`; apply `currentFlowName` at the read site. T-APP-22
- Act card ⏎ press is visual only. T-APP-04
- `requestFlowConfirmation`'s message should become the Confirm card. T-APP-04
- mvp.md B.1 keeps `chat.filter`; the mount removed it. product ruling
- `/docs`, `/debug-api`, `/monitor`, `/agents`, `/agent` have no owner in this mount. T-APP-20, T-APP-21, T-FLW-07, T-FLW-08

## 4. How to verify the mock is gone

Run from `apps/app/src`; each command must print nothing.

```sh
grep -rn DesignWorld .
grep -rnE 'useDesign|actions\.design|controller\.design|withDesignTodos|designSend|runDesignTurn' .
grep -rn 'MOCK SEAM' .
grep -rnE 'isDesignCard|DESIGN_CARD|"design:' .
test ! -d mainview/state/seams/DesignWorld || echo "DesignWorld directory still present"
```

Then from `apps/app`: `node_modules/.bin/tsc --noEmit` passes.
