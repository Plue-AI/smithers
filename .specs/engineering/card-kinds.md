# Card kinds, schemas and owners

Version 0.2 · 2026-10-03 · Owner: engineering · Referenced by spec.md §14.1.5 and §14.2.1, T-APP-19 and T-APP-22 · Minimal-code synthesis v1 §2 and v2 applied

This page does three things. §1 names each card's one card file, its View and its owners. §2 states how persisted cards stay readable when a kind is removed. §3 maps every card kind in `packages/rpc/src/Cards.ts` today to what replaces it, keeps it or cuts it. `MV` is `apps/app/src/mainview`.

## 1. One card file per card

A card has one card file in `MV/cards/`. It reads the card's data, maps it to the View's props, binds `actions[]` through `MV/flows/cardActions.ts` to `flowAction`, stores `onView` patches as view state, and is mounted only from `MV/cards/CardRenderers.tsx`. There is no separate Container class, view-model module, topic decoder fixture or golden test (minimal-code synthesis v1 §2). Where a `*Container.tsx` already landed, that file is the card file. The ticket that wires a View deletes the old card it replaces in the same change (C-UI-13).

View props are TypeScript types. Zod schemas exist only where data crosses HTTP or storage: the card reference a conversation stores (`Cards.ts`, decoded by `CardSchema`) and the kept rpc card schemas Todo, Draft, Setup, Settings, Confirm, Home, Members, `CardAction` and `CardPrimitives`. T-APP-19 deletes the S2/S3 schemas (Proposal, Terminal, Secrets, Branch, Docs, DebugApi), `RetainedCards.test.ts` and its snapshot; each later card's ticket adds what it needs. A card with a topic stores only its subject (`todo {n}`, `branch {id}`); a Draft stores its fields (spec §3, `conversation_entries.card`).

| Card | Card file (wiring ticket) | Deleted in the same change | View |
| --- | --- | --- | --- |
| Home | `HomeContainer.tsx` (T-APP-01) | `StackCard.tsx`, `RepositoryHomeCard.tsx`, then `StackSeam.ts` | T-UI-06 |
| TODO | `TodoContainer.tsx` (T-APP-02; T-STK-08 and T-MCH-08 add actions) | StackSeam's TODO paths, `history.view/todo/retry` | T-UI-04 (absorbs T-UI-23) |
| Draft | `DraftContainer.tsx` (T-APP-02) | none | T-UI-03 |
| Setup, Settings | `SetupContainer.tsx`, `SettingsContainer.tsx` (T-APP-03; T-FLW-12 adds the Obsidian row) | `AccountCard.tsx`, `EnvCard.tsx`, `RepoImportCard.tsx`, `RepositoryChoiceCard.tsx`, `CardActions.ts`, `InstallCardActions.ts` | T-UI-02 |
| Confirm | `ApprovalCard.tsx`, migrated in place (T-APP-04) | `ApprovalAnswer.tsx` | T-UI-05 |
| Flow | `FlowContainer.tsx` (T-APP-05) | `WorkflowCards.tsx` | T-UI-10 |
| Members | `MembersCard.tsx`, new: no members card exists (T-APP-06) | none | T-UI-09 |
| File, Diff | `FileCards.tsx` + `CodeSurface.tsx`; `ChangeCards.tsx` + `DiffSurface.tsx` (T-APP-15 [S1], T-APP-11 [S2], T-APP-14 [S3]) | `CodeEditorView.tsx`, the CodeMirror adapter (T-UI-11); `DiffView.tsx` folds into `DiffSurface.tsx` | T-UI-11, T-UI-16, T-UI-19 |
| Run (monitor, Inspect) | `RunTraceCard.tsx`, reshaped in place (T-FLW-07) | `RunsCards.tsx` folds into it | T-UI-12 |
| Agent, model roles | `AgentCards.tsx`; restored `ModelCards.tsx` slice (T-FLW-08) | `views/SettingsModels.tsx` | T-UI-13 |
| Commands | `CommandsContainer.tsx` (T-UI-14, T-CAT-01) | `CommandsCases.ts`, `CommandsExpectations.ts` | T-UI-14 |
| Shell: entries, branch tree, Earlier | the conversation surface (T-APP-16; T-APP-17 adds the Context line) | `BranchesCard.tsx` | T-UI-07 |
| Timeline, toasts, edge map | `ChatRunTimeline.tsx`, `ToastStack.tsx`, `EdgeMap.tsx` (T-APP-07; T-APP-18 adds Allow notifications) | their old markup | T-UI-08 |
| Actor chip | `MV/state/ProductActor.ts` (T-APP-09) | `views/actorName.ts` | T-UI-01 |
| Branch [S2] | the existing branch card (T-APP-10) | named by T-APP-10 | T-UI-15 |
| Terminal [S2] | the existing terminal card (T-APP-12) | named by T-APP-12 | T-UI-17 |
| Secrets [S2] | `SecretsCard.tsx` (T-APP-13) | its old markup | T-UI-18 |
| Proposal [S3] | T-FLW-06 | none | T-UI-20 |
| Docs, Debug API [S2] | T-APP-20, T-APP-21 (pending Will's ruling on M-35, M-36) | none | T-UI-21, T-UI-22 |

## 2. Legacy decoding

Confirm references and receipts are visible only to the person who must press the card; every other viewer sees nothing. Keep `file`, `diff`, `run-trace` and `agents` live when their names are reused under L4; never add those live kinds to `LEGACY_CARD_KINDS`. Check: C-ACC-02; T-APP-22's tests cover old-row decoding. Legacy decoding preserves pinned records; current Confirm references validate their authorized confirmation subject. Legacy decoding never grants access to a forbidden Confirm subject.


L1. **One decoder.** `CardSchema` (`packages/rpc/src/Cards.ts`) decodes every persisted card: today's per-member transcripts (`MV/state/AppStore.ts`, OPFS or localStorage), the `card` frames of the agent turn journals read through `/api/agent/conversations/replay` (`packages/backend/internal/chat`), and from T-APP-16 `conversation_entries.card`. Its preprocessor turns a row whose kind is in `LEGACY_CARD_KINDS` into the tombstone `{kind: "retired", payload: {was: <kind>}}`. The tombstone keeps `id`, `ordinal`, `createdAt` and the stored `title`, and drops `body` and the payload. Today's two mechanisms, the preprocessor's `retiredKinds` (`Cards.ts:3040-3056`, 14 names) and the app's `RETIRED_CARD_KINDS` (`MV/state/CardAvailability.ts:1`, 20 names), become this one set. T-APP-22 builds it.

L2. **Rendering.** A tombstone is a read-only entry row with its title alone: no body, no action, no maximize, no reopen. A tombstone with an empty title renders nothing. `cardAvailable` is false for it, so no flow reopens it and no turn sends it to a model. The View is T-UI-07's entry row without a card.

L3. **Removing a kind.** The ticket that removes a kind's producer and renderer adds the kind to `LEGACY_CARD_KINDS` and deletes its option from `CurrentCardSchema` in the same change. A kind never has a live schema and a tombstone at once (AGENTS.md zero tech debt).

L4. **Reusing a name.** A ticket that keeps a kind's name for a new view model (`agents`, `diff`, `file`, `run-trace`, `secrets`) decodes every pinned row of that kind as the live kind: new fields are optional, or the preprocessor maps an old value (T-FLW-07 maps the `forks` filter to `all`). Otherwise it takes a new name, and the old name joins `LEGACY_CARD_KINDS`.

L5. **New kinds** store a subject reference only: `home {repo}` (T-APP-01), `todo {n}` and `draft` (T-APP-02), `setup` and `settings` (T-APP-03), `confirm {confirmation_id}` (T-APP-04), `flow {name}` (T-APP-05), `members` (T-APP-06), `branch {id}` (T-APP-10), `terminal {id}` (T-APP-12), `docs` (T-APP-20), `debug-api` (T-APP-21), `proposal` (T-FLW-06) and `commands` (T-CAT-01). None reuses a name in `LEGACY_CARD_KINDS`.

L6. **The pinned fixture.** `packages/rpc/test/fixtures/LegacyCards.ts` (T-APP-22) holds one row per kind in today's `CurrentCardSchema` (69 kinds) and one per name in today's `retiredKinds` (14), copied from producer output or the app's card fixtures at the commit T-APP-22 lands on. Rows are never edited. A ticket that adds a kind appends its row. T-APP-22's tests read it.

## 3. Every card kind today

Listed with `rg -o 'kind: z\.literal\("([a-z0-9.\-]+)"\)' -r '$1' packages/rpc/src/Cards.ts | sort -u`, which prints 71 names at `383f82f40`: `error` (`Cards.ts:744`, inside `factory.home`'s payload) and `prs.triage` (`Cards.ts:2801`, inside `flow-form`'s payload) are nested discriminants, not card kinds, so 69 rows follow. Producers were found with `rg 'kind: "<kind>"'` under `apps/app/src` and `packages`, excluding tests. Decisions follow mvp.md §8 and Appendix B. "Legacy" means the kind joins `LEGACY_CARD_KINDS` when the named ticket lands, and its old rows read as tombstones. "Live" means it keeps its schema.

| Kind | Producer today | Decision | Becomes | Ticket | After |
| --- | --- | --- | --- | --- | --- |
| `account` | `MV/state/controller/account.ts` (`account.show`) | Replaced (B.2: account inside Settings) | Settings; `/sign-in`, `/sign-out` stay | T-APP-03 | legacy |
| `admin-health` | `MV/state/controller/auth-billing.ts:891` (`admin.health`) | Cut (§8 Admin console) | none | T-CUT-01 (producer); T-CUT-04 (kind) | legacy |
| `affected` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `agent` | `MV/state/seams/AgentSessionSeam.ts:353` (agent sessions, subagent grid) | Cut (§8 Cloud agent sessions; Subagent grid) | none | T-CUT-01 (producer); T-CUT-04 (kind) | legacy |
| `agents` | `MV/state/controller/agents.ts:120` (`agent.list`); `MV/state/seams/AgentSessionSeam.ts:643` (session list) | Replaced (`agent.list`); Cut (session list) | Agent | T-FLW-08; T-CUT-01 (session list) | live, name reused (L4) |
| `anonymous-ceiling` | `MV/state/controller/turns.ts` (Cloud anonymous ceiling) | Deferred (§8 Smithers Cloud, billing) | hidden | T-CUT-03 | live |
| `approval` | `MV/state/controller/runs.ts:1355` | Retained (§14.3.0) | `approval` | none | live |
| `approvals-inbox` | `MV/state/controller/runs.ts` (`approvals.list`, `runs.attention`) | Replaced (B.2 Rename → `/runs`) | the retained run list (`run-list`) | T-CAT-01's follow-up (T-CAT-01 is frozen) | legacy |
| `balance` | `MV/state/controller/auth-billing.ts:729` | Deferred (§8 billing) | hidden | T-CUT-03 | live |
| `billing-plans` | `MV/state/seams/BillingSeam.ts` | Deferred (§8 billing) | hidden | T-CUT-03 | live |
| `branches` | `MV/state/seams/BookmarksSeam.ts` (`branches.list`) | Replaced (§8 Merge; Appendix A `/branches`) | the branch tree (shell) | T-APP-16 | legacy |
| `browser` | `MV/state/controller/presentation.ts:401` (`browser.open`) | Retained (§14.3.0) | `browser` | none | live |
| `change` | `MV/state/seams/ChangeSeam.ts:961`, `MV/state/seams/SearchSeam.ts:238` | Retained (§14.3.0, Review findings) | `change` | none | live |
| `ci-matrix` | none (`RETIRED_CARD_KINDS`) | Legacy today (§8 CI matrix cut) | none | T-APP-22 | legacy |
| `commit` | `MV/state/seams/CommitsSeam.ts` (`commits.read`) | Replaced (§8 Merge) | Branch | T-APP-10 | legacy |
| `commit-list` | `MV/state/seams/CommitsSeam.ts` (`commits.list`) | Replaced (§8 Merge) | Home and Branch | T-APP-10 | legacy |
| `connect` | `MV/state/controller/presentation.ts:107` | Cut (B.1 retired surfaces) | none | T-CUT-01 (producer); T-CUT-04 (kind) | legacy |
| `connector-setup` | `MV/state/seams/GitHubSeam.ts` (`github.app*`) | Replaced (B.2 → setup card) | Setup's GitHub rows | T-APP-03 | legacy |
| `diff` | `MV/state/seams/ChangeSeam.ts:1313` (`change.diff`) | Replaced | Diff | T-APP-11 | live, name reused (L4) |
| `env` | `MV/state/seams/EnvironmentSeam.ts:184` (`env.*`) | Replaced (B.2 → Settings model access) | Settings | T-APP-03 | legacy |
| `environment-images` | `MV/state/seams/WorkspaceSeam.ts` (`box.images`) | Deferred (§8, §16 Machine view) | hidden; T-APP-10 keeps its renderer when it deletes `WorkspaceCard.tsx` | T-CUT-03 | live |
| `explain` | none (Explainer mode removed, AGENTS.md second-round scope) | Legacy today | none | T-APP-22 | legacy |
| `draft` | `MV/state/seams/TodoSeam.ts:225` (96aed3b0a, `todo.new`) | New (§14.3 Draft) | Draft | T-APP-02 | live |
| `factory.home` | `MV/App.tsx` | Replaced | Home | T-APP-01 | legacy |
| `file` | `MV/state/seams/FilesSeam.ts:347,380`, `DiffFilesSeam.ts:30`, `SearchSeam.ts:309`, `WorkspaceSeam.ts:1517` | Replaced | File | T-APP-15 [S1], T-APP-11 [S2] | live, name reused (L4) |
| `file-list` | `MV/state/seams/FilesSeam.ts` (`files.list`) | Retained (B.2 File card for `/files`) | `file-list` | T-APP-11 renames the door | live |
| `flow-form` | `MV/state/controller/forms.ts` and others | Retained (§14.3.0) | `flow-form` | none | live |
| `flow-plan` | `MV/state/controller/workflows.ts` (`flow.plan`) | Retained (§14.3.0) | `flow-plan` | none | live |
| `grant-confirm` | `MV/state/controller/auth-billing.ts:768` (`admin.grant*`) | Cut (§8 Admin console balance grants) | none | T-CUT-01 (producer); T-CUT-04 (kind) | legacy |
| `graph` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `issue` | `MV/state/seams/IssuesSeam.ts` (`issues.view`) | Retained (§14.3.0) | `issue` | none | live |
| `issue-list` | `MV/state/seams/IssuesSeam.ts` (`issues.list`) | Retained (B.2 issue card for `/issues`) | `issue-list` | none | live |
| `model-call` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `models` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `notifications` | `MV/state/seams/NotificationsSeam.ts:106` (`notifications.list`) | Cut (§8 Notifications center) | none | T-CUT-01 (producer); T-CUT-04 (kind) | legacy |
| `plan` | the app agent's turn frames (`MV/state/controller/turns.ts:149`) | Retained (the turn's plan on an answer) | `plan` | none | live |
| `plugin-library` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `pr` | `MV/state/seams/LandingsSeam.ts` (`prs.view`) | Retained (§14.3.0) | `pr` | none | live |
| `pr-list` | `MV/state/seams/LandingsSeam.ts` (`prs.list`) | Retained (B.2 PR card) | `pr-list` | none | live |
| `provider-accounts` | `MV/state/seams/SecretsSeam.ts` (`secrets.connections`, `secrets.connect*`) | Replaced (B.2 → Settings model access) | Settings | T-APP-03 | legacy |
| `registration` | `MV/state/controller/registration.ts` | Cut (§8 Registration) | none | T-CUT-01 (producer); T-CUT-04 (kind) | legacy |
| `repo` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `repo-import` | `MV/state/seams/RepoImportSeam.ts` (`repos.import`) | Replaced (B.2 Hide → setup card) | Setup's Source ready row; the flow stays hidden | T-APP-03 | legacy |
| `repo-update` | `MV/state/controller/repositoryUpdate.ts` (`repo.update`) | Deferred (§8 multi-repository) | hidden | T-CUT-03 | live |
| `repository-choice` | `MV/state/AppController.ts:865` (`repo.choose`) | Deferred (§8 multi-repository) | hidden | T-CUT-03 | live |
| `repository-setup` | `MV/state/controller/repositorySetup.ts` | Cut (§8 five-job setup) | none | T-CUT-01 (producer); T-CUT-04 (kind) | legacy |
| `retired` | the decoder (`Cards.ts:3079`) | The tombstone itself | keeps `title`, gains `payload.was` | T-APP-22 | live (tombstone) |
| `run-history` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `run-list` | `MV/state/controller/runs.ts`, `MV/state/RuntimeProjection.ts` (`runs.list`) | Retained (§14.3.0; `/runs`, `/monitor`) | `run-list` | none | live |
| `run-timeline` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `run-trace` | `MV/state/controller/workflows.ts`, `runs.ts`, `flowAuthoring.ts`, `workflow-launch.ts` | Replaced | Run monitor and Inspect | T-FLW-07 | live, name reused (L4) |
| `search-results` | `MV/state/seams/SearchSeam.ts` | Retained (§14.3.0) | `search-results` | none | live |
| `secrets` | `MV/state/seams/SecretsSeam.ts:556` | Replaced | Secrets | T-APP-13 | live, name reused (L4) |
| `service-log` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `stack` | `MV/state/seams/StackSeam.ts` (`history.show`) | Replaced | Home | T-APP-01 | legacy |
| `status` | `MV/state/PreparedView.ts:100` (loading placeholder) and turn frames | Retained (shell placeholder and turn status) | `status` | none | live |
| `sync-ops` | `MV/state/seams/GitHubSeam.ts` (`sync.ops.*`) | Hidden (§8 developer tools) | no member door | T-CUT-03 | live |
| `target-run` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `targets` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `theme-picker` | none (`RETIRED_CARD_KINDS`) | Legacy today | none | T-APP-22 | legacy |
| `todo` | `MV/state/seams/TodoSeam.ts:53` (96aed3b0a) | New (§14.3 TODO) | TODO | T-APP-02 | live |
| `trigger-list` | `MV/state/seams/TriggersSeam.ts` (`triggers.list`) | Deferred (§8, §16 triggers) | hidden | T-CUT-03 | live |
| `wiki-graph` | `MV/state/controller/world.ts` | Retained (§14.3.0) | `wiki-graph` | none | live |
| `wiki-history` | `MV/state/controller/cloud-wiki.ts` | Retained (§14.3.0) | `wiki-history` | none | live |
| `wiki-links` | `MV/state/controller/world.ts` | Retained (§14.3.0) | `wiki-links` | none | live |
| `workflow-list` | `MV/state/controller/workflow-catalog.ts` (`flow.list`) | Retained (B.2 flows card for `/flows`) | `workflow-list` | none | live |
| `workflow-repo` | `MV/state/controller/workflows.ts:723` (`flow.create`'s repository choice) | Deferred (§8 multi-repository) | hidden | T-CUT-03 | live |
| `workspace` | `MV/state/seams/WorkspaceSeam.ts:728`, `MV/state/WorkspaceViews.ts:47` (`box.open`, `box.terminal`) | Replaced | Branch and Terminal | T-APP-10 (T-APP-12 takes the terminal facet) | legacy |
| `world` | `MV/state/controller/world.ts:349`, `cloud-wiki.ts`, `presentation.ts:60` | Retained (§14.3.0 Wiki) | `world` | none | live |

Totals: 2 new (`draft`, `todo`), 17 replaced (5 of them keep their name), 7 cut, 14 legacy today, 8 deferred, 1 hidden, 19 retained, and the tombstone. Every replaced kind that doesn't keep its name and every cut kind ends in `LEGACY_CARD_KINDS`, so its old rows decode (L1). §14.3.0 doesn't list six retained kinds yet: `file-list`, `issue-list`, `pr-list` and `workflow-list`, whose cards Appendix B names, and `plan` and `status`, which are parts of an answer entry (§14.5.1).
