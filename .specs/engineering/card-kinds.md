# Card kinds, schemas and owners

Version 0.1 · 2026-10-02 · Owner: engineering · Referenced by spec.md §14.1.5 and §14.2.1, T-APP-19 and T-APP-22

This page does three things. §1 gives each card's schemas and Containers one owner. §2 states how persisted cards stay readable when a kind is removed. §3 maps every card kind in `packages/rpc/src/Cards.ts` today to what replaces it, keeps it or cuts it. `MV` is `apps/app/src/mainview`.

## 1. Three schemas per card, one owner each

A card crosses three schemas:
- **Topic schema.** The snapshot and deltas a topic publishes (spec §7.2). The ticket that publishes the topic owns the Go snapshot builder. The card's wiring ticket owns the TypeScript decoder `packages/rpc/src/topics/<Topic>.ts`, the golden fixture `packages/rpc/test/fixtures/topics/<topic>.json`, and one Go test, `<topic>_golden_test.go`, that runs the publisher's builder on a seeded database and compares its JSON with the golden. The decoder's unit test parses the same golden, so the Go and TypeScript halves can't drift.
- **View model.** `packages/rpc/src/<Card>Card.ts` with fixtures in `packages/rpc/test/fixtures/<Card>.ts` (spec §14.2.1). T-APP-19 owns every view model in its list; a card added later (Docs, Debug API) has its wiring ticket own its view model. T-APP-19 is landed history; T-APP-19b owns the follow-up reconciliation of current §14.3 schemas and shared shell data contracts. RunView maps to MonitorCard, not a new RunCard. Checks: C-UI-08, C-UI-12.
- **Card reference.** The `{kind, payload}` a conversation entry stores (`Cards.ts`, decoded by `CardSchema`). A card with a topic stores only its subject (`todo {n}`, `branch {id}`); a Draft stores its fields (spec §3, `conversation_entries.card`).

The **adapter** is a pure function `to<Card>Model(topic, viewer, view) → {model, actions}` in `MV/cards/containers/<card>Model.ts`, owned by the wiring ticket. It derives every per-viewer value (role-filtered attention, merged since last look, the §14.5.2 action) and labels every action. Its unit test feeds the golden topic fixture and asserts that the result parses with the view model. The **Container** `MV/cards/containers/<Card>Container.tsx` subscribes, calls the adapter, binds `actions[]` through `cardActions`, stores `onView` patches as view state, and renders the View. It holds no derivation of its own. The **View** is design's (spec §14.2.1).

| Card | Topics | Snapshot builder | Decoder, golden, adapter, Container | View model | View |
| --- | --- | --- | --- | --- | --- |
| Home | `home` | T-APP-08 (items from T-STK-01's writers) | T-APP-08 (decoder and golden); T-APP-01 (adapter and Container) | T-APP-19 | T-UI-06 |
| TODO | `todo:<n>` | T-STK-01 | T-APP-02 (T-STK-08 and T-MCH-08 add actions) | T-APP-19 | T-UI-04; T-UI-23 for conflict, moved-off, outside-push, Fork and Add to stack |
| Draft | the entry's `card` column | T-APP-16 | T-APP-02 | T-APP-19 | T-UI-03 |
| Setup, Settings | `install` | T-INS-06 | T-APP-03 (T-FLW-12 adds the Obsidian row) | T-APP-19 | T-UI-02 |
| Confirm | `confirmations:<member>` | T-ACC-05 | T-APP-04 | T-APP-19 | T-UI-05 |
| Flow | `flows` | T-FLW-03 | T-APP-05 | T-APP-19 | T-UI-10 |
| Members | `members` | T-ACC-02 | T-APP-06 | T-APP-19 | T-UI-09 |
| Branch | `branch:<id>`, `branch:<id>:activity` | T-COL-06; T-STK-01 (activity) | T-APP-10 | T-APP-19 | T-UI-15 |
| File, Diff | `branch:<id>:files` [S2]; the live document [S3] | T-COL-04; T-COL-08 | T-APP-15 [S1], T-APP-11 [S2], T-APP-14 [S3] | T-APP-19 | T-UI-11, T-UI-16, T-UI-19 |
| Terminal | the terminal stream; terminals on `branch:<id>` | T-TRM-01 | T-APP-12 | T-APP-19 | T-UI-17 |
| Secrets | `secrets` | T-MCH-12 | T-APP-13 | T-APP-19 | T-UI-18 |
| Run (monitor, Inspect) | `run:<id>` | T-FLW-07 | T-FLW-07 | T-APP-19 | T-UI-12 |
| Agent | `agents` | T-FLW-08 | T-FLW-08 | T-APP-19 | T-UI-13 |
| Proposal | `proposals` | T-FLW-06 | T-FLW-06 | T-APP-19 | T-UI-20 |
| Commands | `catalog.mvp.json` (no topic) | T-CAT-01 | T-CAT-01 | T-APP-19 | T-UI-14 |
| Docs | bundled pages (no topic) | none | T-APP-20 | T-APP-20 | T-UI-21 |
| Debug API | bundled OpenAPI (no topic) | none | T-APP-21 | T-APP-21 | T-UI-22 |
| Shell: entries, branch tree, Earlier | `conversation:<branch>`, `view:<member>:<branch>` | T-APP-16 | T-APP-16; T-APP-17 adds the Context line; T-APP-23 mounts them | T-APP-19 | T-UI-07 |
| Timeline, toasts, edge map | entry fields on `conversation:<branch>` | T-APP-07 | T-APP-07; T-APP-18 adds Allow notifications | T-APP-19 | T-UI-08 |
| Actor chip | the actor on every topic | each publisher | T-APP-09 (`ProductActor`, `toActor`, `actorName`) | T-APP-19 | T-UI-01 |

## 2. Legacy decoding

Confirm references and receipts are visible only to the person who must press the card; every other viewer sees nothing. Keep `file`, `diff`, `run-trace` and `agents` live when their names are reused under L4; never add those live kinds to `LEGACY_CARD_KINDS`. Checks: C-ACC-02, C-CUT-02. Legacy decoding preserves pinned records; current Confirm references validate their authorized confirmation subject. Legacy decoding never grants access to a forbidden Confirm subject. Check: C-UI-08.


L1. **One decoder.** `CardSchema` (`packages/rpc/src/Cards.ts`) decodes every persisted card: today's per-member transcripts (`MV/state/AppStore.ts`, OPFS or localStorage), the `card` frames of the agent turn journals read through `/api/agent/conversations/replay` (`packages/backend/internal/chat`), and from T-APP-16 `conversation_entries.card`. Its preprocessor turns a row whose kind is in `LEGACY_CARD_KINDS` into the tombstone `{kind: "retired", payload: {was: <kind>}}`. The tombstone keeps `id`, `ordinal`, `createdAt` and the stored `title`, and drops `body` and the payload. Today's two mechanisms, the preprocessor's `retiredKinds` (`Cards.ts:2952-2962`) and the app's `RETIRED_CARD_KINDS` (`MV/state/CardAvailability.ts:1`), become this one set. T-APP-22 builds it.

L2. **Rendering.** A tombstone is a read-only entry row with its title alone: no body, no action, no maximize, no reopen. A tombstone with an empty title renders nothing. `cardAvailable` is false for it, so no flow reopens it and no turn sends it to a model. The View is T-UI-07's entry row without a card.

L3. **Removing a kind.** The ticket that removes a kind's producer and renderer adds the kind to `LEGACY_CARD_KINDS` and deletes its option from `CurrentCardSchema` in the same change. A kind never has a live schema and a tombstone at once (AGENTS.md zero tech debt).

L4. **Reusing a name.** A ticket that keeps a kind's name for a new view model (`agents`, `diff`, `file`, `run-trace`, `secrets`) decodes every pinned row of that kind as the live kind: new fields are optional, or the preprocessor maps an old value (T-FLW-07 maps the `forks` filter to `all`). Otherwise it takes a new name, and the old name joins `LEGACY_CARD_KINDS`.

L5. **New kinds** store a subject reference only: `home {repo}` (T-APP-01), `todo {n}` and `draft` (T-APP-02), `setup` and `settings` (T-APP-03), `confirm {confirmation_id}` (T-APP-04), `flow {name}` (T-APP-05), `members` (T-APP-06), `branch {id}` (T-APP-10), `terminal {id}` (T-APP-12), `docs` (T-APP-20), `debug-api` (T-APP-21), `proposal` (T-FLW-06) and `commands` (T-CAT-01). None reuses a name in `LEGACY_CARD_KINDS`.

L6. **The pinned fixture.** `packages/rpc/test/fixtures/LegacyCards.ts` (T-APP-22) holds one row per kind in today's `CurrentCardSchema` (67 kinds) and one per name in today's `retiredKinds` (8), copied from producer output or the app's card fixtures at the commit T-APP-22 lands on. Rows are never edited. A ticket that adds a kind appends its row. Check: C-CUT-02.

## 3. Every card kind today

Listed with `rg -o 'kind: z\.literal\("([a-z0-9.\-]+)"\)' -r '$1' packages/rpc/src/Cards.ts | sort -u`, which prints 69 names: `error` (`Cards.ts:723`, inside `factory.home`'s payload) and `prs.triage` (`Cards.ts:2781`, inside `flow-form`'s payload) are nested discriminants, not card kinds, so 67 rows follow. Producers were found with `rg 'kind: "<kind>"'` under `apps/app/src` and `packages`, excluding tests. Decisions follow mvp.md §8 and Appendix B. "Legacy" means the kind joins `LEGACY_CARD_KINDS` when the named ticket lands, and its old rows read as tombstones. "Live" means it keeps its schema.

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
| `branches` | `MV/state/seams/BookmarksSeam.ts` (`branches.list`) | Replaced (§8 Merge; Appendix A `/branches`) | the branch tree (shell) | T-APP-23 | legacy |
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
| `retired` | the decoder (`Cards.ts:2984`) | The tombstone itself | keeps `title`, gains `payload.was` | T-APP-22 | live (tombstone) |
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
| `trigger-list` | `MV/state/seams/TriggersSeam.ts` (`triggers.list`) | Deferred (§8, §16 triggers) | hidden | T-CUT-03 | live |
| `wiki-graph` | `MV/state/controller/world.ts` | Retained (§14.3.0) | `wiki-graph` | none | live |
| `wiki-history` | `MV/state/controller/cloud-wiki.ts` | Retained (§14.3.0) | `wiki-history` | none | live |
| `wiki-links` | `MV/state/controller/world.ts` | Retained (§14.3.0) | `wiki-links` | none | live |
| `workflow-list` | `MV/state/controller/workflow-catalog.ts` (`flow.list`) | Retained (B.2 flows card for `/flows`) | `workflow-list` | none | live |
| `workflow-repo` | `MV/state/controller/workflows.ts:723` (`flow.create`'s repository choice) | Deferred (§8 multi-repository) | hidden | T-CUT-03 | live |
| `workspace` | `MV/state/seams/WorkspaceSeam.ts:728`, `MV/state/WorkspaceViews.ts:47` (`box.open`, `box.terminal`) | Replaced | Branch and Terminal | T-APP-10 (T-APP-12 takes the terminal facet) | legacy |
| `world` | `MV/state/controller/world.ts:349`, `cloud-wiki.ts`, `presentation.ts:60` | Retained (§14.3.0 Wiki) | `world` | none | live |

Totals: 17 replaced (5 of them keep their name), 7 cut, 14 legacy today, 8 deferred, 1 hidden, 19 retained, and the tombstone. Every replaced kind that doesn't keep its name and every cut kind ends in `LEGACY_CARD_KINDS`, so its old rows decode (L1). §14.3.0 doesn't list six retained kinds yet: `file-list`, `issue-list`, `pr-list` and `workflow-list`, whose cards Appendix B names, and `plan` and `status`, which are parts of an answer entry (§14.5.1).
