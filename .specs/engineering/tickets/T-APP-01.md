# T-APP-01 Home card on the `home` topic

Stage S1 · Size M · Depends on T-COL-02, T-STK-01, T-APP-08, T-APP-16, T-UI-06, T-APP-19, T-APP-22 · Unblocks T-MNT-01, T-REL-01, T-REL-02 · Issue: [#3496](https://github.com/smithersai/smithers/issues/3496)
Spec: spec.md §14.1, §14.2, §14.3 (Home), §14.5.2, §7.2, §4.1, §4.1.1, §4.1.2a, §4.4, §6.1.2, §8.2.1, §10.3, §10.6.1, §10.6.4, §12.3, §12.6, §15.1.5, §19.3 · Delta: delta.md §9 (Modify `StackCard.tsx`) · Product: mvp.md J4, §6.4 Home card, §4.1, §4.2, M-08, M-14

## Goal
Every member who opens `main`'s conversation or runs `/stack` sees the same Home card: `main` pinned with its sync time, TODOs in merge order with at most one action each, counts that filter, merges since their own last look, machines in use against capacity, and background runs. Each change arrives from the shared `home` topic within 1 s, and every per-member value is derived in that member's client.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `HomeView`, with the CSS, in T-UI-06. This ticket builds no View, CSS or editor presentation. It owns the topic decoder and golden fixture, the adapter, the Container and the commands in Changes ([card-kinds.md §1](../card-kinds.md)), plus the `home` snapshot builder that T-COL-02 assigns here. The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope

- The row action and ⋯ menu use its `actions[]` with `args {n}`. Check: C-UI-13.

In:
- A `home` card kind that renders the §14.3 Home model from the `home` topic (snapshot, then deltas), embedded and maximized from one component (AGENTS.md embed law). It is the standing card of `main`'s conversation (§14.1.1, T-APP-16).
- `home` is a shared topic (§7.2.2): its payload is identical for every subscriber. Per-member values come from the client:
  - `attention[]`: the open `stack_attention` rows filtered by the viewer's role (§4.1.2a): `order` for maintainers, `force_push` for the owner;
  - "N merged since you looked": merged items whose entry `seq` is above the member's own `last_seen_seq` from `view:<member>:main` (T-APP-16). Last look advances when the card has been on screen for 2 s (§14.3).
- `main` row from `main {sha, title, last_success_at, health, cause?, retry_at?}` (§12.6): short sha and title, and "synced N s ago" computed by the client from `last_success_at` on a local 1 s clock, so no delta is needed each second. Gold past 2 × target (§4.4); `refused` names its cause and links `/settings`; `limited` shows `retry_at`. **Retry** forces all streams (`POST /api/github/sync`); any member may press it, and the app agent may run it (`agent: run`).
- Attention rows: `order` shows "T3 merged before T2; T2's change is in T3's commit" with **OK** (§10.6.4); `force_push` shows **Reset to GitHub main** (§12.3). Both are in-card controls (§6.1.2), not TODO states.
- One row per stack item in stack order: state glyph and word (queued shows "waiting for a machine #<position>" from `queue`, §4.1.1; Starting while the machine wakes and the coding agent launches; working shows the step), branch, people and agents present (`present[]`), elapsed, PR number, "Merges after Tn", "approval cleared by rebase", "+n" amendments, lessons chip.
- One row action, derived per viewer by the shared §14.5.2 function (T-APP-07): Answer (`/todo.answer Tn`), Resolve (`/branch Tn`), Review (`/todo Tn`), Retry (`/todo.retry Tn`), or Merge (`/merge Tn`, only the first unmerged In review item, only for a viewer who may merge, never with `merge_block`). A ⋯ menu offers Move up and Move down (`/stack.move Tn up|down`, ⌥↑/⌥↓) and Drop (`/todo.drop Tn`, confirm).
- Agent permissions (§15.1.5): the app agent runs Move at once (`agent: run`); Drop posts a one-click Confirm card (`agent: confirm`, T-APP-04); Merge opens the person's Review & merge card.
- Counts as filters over Needs you, Starting, Working, Queued and In review. The filter is the member's own card view state (T-APP-16), so one member's filter never changes another's card.
- Machines: `in_use/capacity`; the owner sees the `parallel` stepper, which runs the owner setting command.
- Background runs below the stack (`{id, title, state, detail}`, state queued, running, waiting or failed; a finished run leaves the card). A failed run keeps **Retry** (`background.retry`: a new background run of the same flow, version and input) and **Dismiss** (`background.dismiss`: writes `background_dismissals`, so the run leaves every member's card and its record stays), both in-card catalog rows (§6.1.2, §14.3, §3).
- **New TODO** runs `/todo.new` with no input, so the form law renders the Draft card (T-APP-02).

Out:
- TODO and Draft cards (T-APP-02); Confirm (T-APP-04); the edge map and timeline (T-APP-07).
- The "incoming" filter (maintainer release, mvp.md §14); browser notifications (T-APP-18).
- Order, merge and parallel semantics (T-STK-02, T-STK-04, T-STK-03); sync health backend (T-GH-08); stack attention rows (T-GH-05, T-GH-07).

## Changes
- `packages/backend/internal/services/home_projection.go` (new): the `home` snapshot builder registered with T-COL-02: items from T-STK-01's `todos`, the `main` row from `github_sync` (T-GH-08), machines in use against capacity, and background runs that have no `background_dismissals` row. T-STK-01's writers publish the item deltas.
- `packages/backend/internal/services/background_runs.go` (new): `POST /api/runs/{id} {retry|dismiss}` (§6.3). Retry admits a new background run with the failed run's flow, digest and input; Dismiss writes `background_dismissals` and publishes `home`.
- `packages/rpc/src/topics/Home.ts` (new): the `home` decoder. `packages/rpc/test/fixtures/topics/home.json` (new): the golden snapshot, which `home_projection_golden_test.go` (new) compares with the builder's output on a seeded database.
- `apps/app/src/mainview/cards/containers/homeModel.ts` (new): `toHomeModel(topic, viewer, view, now)` returns the `HomeCard` model and actions. It derives `attention[]` for the viewer's role (§4.1.2a), `merged_since_last_look` from the viewer's `last_seen_seq`, `main.health` (`stale` past 2 × the 60 s target, else `fresh`; `limited` and `refused` pass through) from `last_success_at` and `now`, each row's one action through the shared §14.5.2 function (`packages/rpc/src/ConversationEntry.ts`, T-APP-07), and the ⋯ actions Move up, Move down and Drop for unsettled rows.
- `apps/app/src/mainview/cards/containers/HomeContainer.tsx` (new): subscribes `home` and `view:<member>:main`, ticks a 1 s clock for `now`, calls `toHomeModel`, binds actions with `cardActions`, and renders `HomeView` (T-UI-06). The filter and the ⋯ menu are `onView` patches. Last look advances through `PUT /api/conversations/main/view-state` once the View has reported the card on screen for 2 s (`onView({on_screen})`, T-UI-06). `cards/CardRenderers.tsx` maps kind `home` to this Container: the standing card of `main`'s conversation and the `/stack` card.
- `packages/rpc/src/Cards.ts`: add kind `home {repo}`. Move `stack` and `factory.home` to `LEGACY_CARD_KINDS` and delete their options (card-kinds.md §2, T-APP-22).
- `apps/app/src/mainview/flows/entries/history.ts`: `history.show` (`:29`) becomes `/stack`; add `/stack.move Tn up|down` over `POST /api/todos/{n} {move}` and the in-card `background.retry` and `background.dismiss`. Hide `history.bootstrap`, `history.backfill` and `history.parallel` (delta.md §6).
- Delete `cards/StackCard.tsx`, `StackCard.test.tsx`, `StackIssues.test.tsx`, and `cards/RepositoryHomeCard.tsx` with the `factory.home` slot in `App.tsx`. Remove `watchHomeStack`, `snapshot` and `observeItems` from `state/seams/StackSeam.ts`; T-APP-02 and T-APP-04 delete the rest.
- `apps/app/e2e/playwright/stack.spec.ts`, `stack-todo.spec.ts`: rewrite against the `home` card. `apps/app/e2e/real/home.spec.ts` (new): C-J4-01.

## Tests
- Unit (`homeModel.test.ts`): from `topics/home.json`, the model parses with the `HomeCard` schema. The row action for every (state, `needs_you.kind`, first in order, viewer role, `merge_block`) combination equals the §14.5.2 table; at most one row carries Merge; merged and dropped rows carry no ⋯ actions.
- Unit, same file: `attention` holds `order` only for maintainers and `force_push` only for the owner; `merged_since_last_look` counts only merges above `last_seen_seq` of `conversation:main` entries; two viewers' models from one snapshot differ only in those fields and in the actions.
- Unit, same file: `main.health` is `fresh` at 120 s and `stale` at 121 s after `last_success_at`; `refused` and `limited` keep `cause` and `retry_at`.
- Unit, same file: counts equal the snapshot's state counts after a sequence of deltas, including one that moves an item between filters while the viewer's filter is set.
- Unit (`HomeContainer.test.tsx`, fake live channel and clock): the clock moves `health` with no delta; last look advances only after 2 s on screen (1.9 s leaves it); a `gap` frame keeps the last snapshot's model until the new snapshot arrives (§19.3); `onAction` runs `flowAction` with the action's tag and input.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration (real PostgreSQL): `home_projection_golden_test.go` equals `topics/home.json`; Dismiss writes one `background_dismissals` row and the next snapshot omits the run for every subscriber; Retry creates a new run with the failed run's flow, digest and input; a 200-item snapshot fits the 2 MiB send budget (§7.1.1).
- e2e (`apps/app/e2e/real/home.spec.ts`): the C-J4-01 script through `HomeView`, including a failed background run's Retry and Dismiss.
- Rendering (labels, glyphs, the "synced N s ago" text and the filters' look) is T-UI-06's.

## Acceptance





- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J4-01](../checks/C-J4-01.md): counts, filters, merged since last look, sync time and machines against capacity match PostgreSQL for every member, and a failed background run's Retry and Dismiss act for every member (step 10).
- [C-J8-06](../checks/C-J8-06.md): a failed wiki refresh shows on the Home card with Retry and Dismiss.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- The TUI still imports `@smthrs/rpc/StackView` and `StackIssues` (`apps/tui/src/factory.ts`). The app stops importing them; T-CUT-03 defers the TUI but keeps it building.
- Risk: the `home` snapshot exceeds the 2 MiB send budget with long stacks (§7.1.1). Confirmed if the 200-item integration test produces `gap` on connect.
- Risk: merges since last look go wrong when `last_seen_seq` comes from a different topic's sequence. Falsified by the `homeModel` unit test, which uses `conversation:main` entry seqs only.
