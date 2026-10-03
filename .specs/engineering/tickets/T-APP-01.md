# T-APP-01 Home card on the `home` topic

Stage S1 · Size M · Depends on T-COL-02, T-STK-01, T-STK-05, T-APP-16, T-APP-07, T-APP-22, T-APP-02, T-APP-04, T-UI-06, T-GH-03, T-GH-07 · Unblocks T-MNT-01, T-REL-01, T-REL-02 · Issue: [#3496](https://github.com/smithersai/smithers/issues/3496)
Spec: spec.md §14.1, §14.2, §14.3 (Home), §14.5.2, §7.2, §4.1, §4.1.1, §4.1.2a, §4.4, §6.1.2, §8.2.1, §10.3, §10.6.1, §10.6.4, §12.3, §12.6, §15.1.5, §19.3 · Product: mvp.md J4, §6.4 Home card, §4.1, §4.2, M-08, M-14

## Goal
Every member who opens `main`'s conversation or runs `/stack` sees the same Home card: `main` with its sync time, TODOs in merge order with at most one action each, counts that filter, merges since their own last look, machines in use against capacity, and background runs. Changes arrive within 1 s; per-member values are derived in the member's client.

## Scope
In:
- Mount the landed `HomeView` (`cards/views/HomeView.tsx`, ab2ab5e0b) through the landed card file `cards/HomeContainer.tsx`. It is the standing card of `main`'s conversation (T-APP-16) and the `/stack` card, embedded and maximized from one component.
- `main` row: short sha, title and "synced N s ago", computed from `last_success_at` on a local 1 s clock. Gold past 2 × target (§4.4); `refused` names its cause and links `/settings`; `limited` shows `retry_at`. **Retry** runs `POST /api/github/sync` (`agent: run`).
- Attention by viewer role (§4.1.2a): `order` for maintainers with **OK** (§10.6.4); `force_push` for the owner with **Reset to GitHub main** (§12.3). Both are in-card controls (§6.1.2).
- One row per stack item in stack order: state glyph and word, branch, people present, elapsed, PR number, "Merges after Tn", "approval cleared by rebase" and "+n" amendments. Queued shows its `queue.reason`: "waiting for a machine #<position>", "merges after T<after>", "rebase pending" or "Daily limit reached · starts tomorrow" (§4.1.1). A paused item shows "Paused · daily token budget · <owner>", keeping §4.1.0a branch-wait precedence.
- One row action from the shared §14.5.2 function (T-APP-07): Answer, Resolve, Review, Retry, or Merge (only the first unmerged In review item, only for a viewer who may merge, never with `merge_block`). The ⋯ menu offers Move up and Move down (`/stack.move Tn up|down`, ⌥↑/⌥↓, `agent: run`) and Drop (`/todo.drop Tn`, `agent: confirm`, T-APP-04). An agent's Merge opens the person's Review & merge card.
- Counts filter Needs you, Starting, Working, Queued and In review. The filter and last look are the member's own view state (T-APP-16). "N merged since you looked" counts merges above the member's `last_seen_seq`; last look advances after the card has been on screen for 2 s.
- Machines: `in_use/capacity`.
- Background runs (`{id, title, state, detail}`). A failed run keeps **Retry** (a new run of the same flow, version and input) and **Dismiss** (the run leaves every member's card; its record stays).
- **New TODO** runs `/todo.new` with no input, so the form law opens the Draft card (T-APP-02).

Out:
- TODO and Draft cards (T-APP-02); Confirm (T-APP-04); the edge map and timeline (T-APP-07); the per-resource SSE route deletions (T-COL-02).
- The "incoming" filter (maintainer release); browser notifications (T-APP-18); order and merge semantics (T-STK-02, T-STK-04); sync health and attention writers (T-GH-07, T-GH-03).
- The S2 `parallel` stepper (T-STK-03), live presence and Branch navigation, S3 learning, TUI changes and View/CSS changes (T-UI-06).

## Changes
- Home data, taken directly (absorbs T-COL-02's home builder): extend the existing stack read `packages/backend/internal/services/mythical_view.go`, served at `GET …/mythical` (`compose/router.go:1128`), to return the `HomeCard` payload. It is one pure function over facts committed in one transaction: T-STK-01's items, T-GH-07's sync health and attention, T-INS-06's capacity and background runs minus dismissals. Change notices reach the client over `/api/live` (T-COL-02, the WebSocket adapter over `sse.Broker`). No topic decoder, fixture, golden or second builder.
- Add dismissed_by and dismissed_at to the existing run record. `POST /api/runs/{id} {retry|dismiss}` uses Idempotency-Key; Retry admits the pinned flow/input in a machine, Dismiss updates that run once. No dismissal table.
- `cards/HomeContainer.tsx` (landed): reads the Home payload, re-reads it on each `/api/live` notice, ticks a 1 s clock, maps role and view state to `HomeView` props and binds actions with `flows/cardActions.ts`. The filter and ⋯ menu are `onView` patches; last look writes `PUT /api/conversations/main/view-state`. `cards/CardRenderers.tsx` maps kind `home` to it.
- `packages/rpc/src/Cards.ts`: kind `home {repo}`; `stack` and `factory.home` move to the legacy decoder (T-APP-22).
- `flows/entries/history.ts`: `history.show` becomes `/stack`; add `/stack.move`, `background.retry` and `background.dismiss`; hide `history.bootstrap`, `history.backfill` and `history.parallel`.
- Deletes `cards/StackCard.tsx`, `StackCard.test.tsx`, `StackIssues.test.tsx`, `cards/RepositoryHomeCard.tsx`, `RepositoryHomeCard.css` and the `factory.home` slot (`App.tsx:19,522`) (pair: HomeView ↔ StackCard + RepositoryHomeCard; minimal-code synthesis v1 §2). After T-APP-02 and T-APP-04 move their readers, move the wiki-refresh path (`flows/entries/wiki.ts`) to its packaged wiki command and delete `state/seams/StackSeam.ts`.
- `e2e/playwright/stack.spec.ts` and `stack-todo.spec.ts`: rewrite against Home. `e2e/real/home.spec.ts` (new): C-J4-01.

## Tests
- Unit (`HomeContainer.test.tsx`, landed): a literal action matrix over (state, `needs_you.kind`, first in order, viewer role, `merge_block`); at most one row carries Merge; merged and dropped rows carry no ⋯ actions; all four queue-reason labels pinned. `order` reaches only maintainers and `force_push` only the owner. Merged-since counts only merges above `last_seen_seq`. Health is `fresh` at 120 s and `stale` at 121 s with no new data; `refused` and `limited` keep `cause` and `retry_at`. Last look advances at 2.0 s on screen and not at 1.9 s. A `gap` keeps the last payload until the next read.
- Go unit (`mythical_view_unit_test.go`): a table of seeded facts to the literal Home payload; two viewers receive identical bytes.
- Integration (real PostgreSQL, composed router): Dismiss writes one row and the next read omits the run for every member; duplicate Retry with one key admits one machine run with the failed run's flow, digest and input and no host execution; a 200-item payload fits the 2 MiB send budget (§7.1.1).
- e2e (`home.spec.ts`): `/stack` through the production dispatcher, `CardRenderers`, `HomeContainer` and `HomeView` on the composed backend. Two members' view-state writes, New TODO, and background Retry and Dismiss after duplicate requests. Expected values are literals and an independently seeded event log.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-J4-01](../checks/C-J4-01.md): counts, filters, merged since last look, sync time and machines match PostgreSQL for every member; a failed background run's Retry and Dismiss act for every member.
- [C-J8-06](../checks/C-J8-06.md): a failed wiki refresh shows on the Home card with Retry and Dismiss.
- [C-UI-13](../checks/C-UI-13.md): `HomeView` is reachable from `CardRenderers`; `StackCard.tsx`, `RepositoryHomeCard.tsx` and `StackSeam.ts` are deleted.

## Risks and notes
- The TUI imports `@smthrs/rpc/StackView` and `StackIssues` (`apps/tui/src/factory.ts`). The app stops importing them; T-CUT-03 keeps the TUI building.
- Risk: the Home payload exceeds 2 MiB with long stacks (§7.1.1). Confirmed if the 200-item integration test fails.
- Background Retry never imports or runs the stored flow on the host (§17.3, M-29). smithers-3f reviews admission and credential scope.

## Ready checklist
1. Before start, smithers-06 confirms the on-screen and filter callbacks fit `HomeView` without visual edits; smithers-3f confirms Retry and Dismiss use durable admission and idempotency. Record pre-review in #3496.
