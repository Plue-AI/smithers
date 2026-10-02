# T-APP-01 Home card on the `home` topic

Stage S1 · Size M · Depends on T-COL-02, T-STK-01, T-APP-08, T-APP-16, T-UI-06, T-APP-19 · Unblocks T-REL-01 · Issue: to file
Spec: spec.md §14.1, §14.2, §14.3 (Home), §14.5.2, §7.2, §4.1, §4.1.1, §4.1.2a, §4.4, §6.1.2, §8.2.1, §10.3, §10.6.1, §10.6.4, §12.3, §12.6, §15.1.5, §19.3 · Delta: delta.md §9 (Modify `StackCard.tsx`) · Product: mvp.md J4, §6.4 Home card, §4.1, §4.2, M-08, M-14

## Goal
Every member who opens `main`'s conversation or runs `/stack` sees the same Home card: `main` pinned with its sync time, TODOs in merge order with at most one action each, counts that filter, merges since their own last look, machines in use against capacity, and background runs. Each change arrives from the shared `home` topic within 1 s, and every per-member value is derived in that member's client.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: `HomeCard` view: `main` row, counts as filters, stack rows with their one action, attention rows, machines vs capacity, background runs with Retry/Dismiss. Engineering wires them: the `home` topic container, client-derived `merged_since_last_look` and `attention[]`, and every command a row fires. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- A `home` card kind that renders the §14.3 Home model from the `home` topic (snapshot, then deltas), embedded and maximized from one component (AGENTS.md embed law). It is the standing card of `main`'s conversation (§14.1.1, T-APP-16).
- `home` is a shared topic (§7.2.2): its payload is identical for every subscriber. Per-member values come from the client:
  - `attention[]`: the open `stack_attention` rows filtered by the viewer's role (§4.1.2a): `order` for maintainers, `force_push` for the owner;
  - "N merged since you looked": merged items whose entry `seq` is above the member's own `last_seen_seq` from `view:<member>:main` (T-APP-16). Last look advances when the card has been on screen for 2 s (§14.3).
- `main` row from `main {sha, title, last_success_at, health, cause?, retry_at?}` (§12.6): short sha and title, and "synced N s ago" computed by the client from `last_success_at` on a local 1 s clock, so no delta is needed each second. Gold past 2 × target (§4.4); `refused` names its cause and links `/settings`; `limited` shows `retry_at`. **Retry** forces all streams (`POST /api/github/sync`); any member may press it, and the app agent may run it (`agent: run`).
- Attention rows: `order` shows "T3 merged before T2; T2's change is in T3's commit" with **OK** (§10.6.4); `force_push` shows **Reset to GitHub main** (§12.3). Both are in-card controls (§6.1.2), not TODO states.
- One row per stack item in stack order: state glyph and word (queued shows "waiting for a machine #<position>" from `queue`, §4.1.1; Starting while the machine wakes and the coding agent launches; working shows the step), branch, people present (`present_count`), elapsed, PR number, "Merges after Tn", "approval cleared by rebase", "+n" amendments, lessons chip.
- One row action, derived per viewer by the shared §14.5.2 function (T-APP-07): Answer (`/todo.answer Tn`), Resolve (`/branch Tn`), Review (`/todo Tn`), Retry (`/todo.retry Tn`), or Merge (`/merge Tn`, only the first unmerged In review item, only for a viewer who may merge, never with `merge_block`). A ⋯ menu offers Move up and Move down (`/stack.move Tn up|down`, ⌥↑/⌥↓) and Drop (`/todo.drop Tn`, confirm).
- Agent permissions (§15.1.5): the app agent runs Move at once (`agent: run`); Drop posts a one-click Confirm card (`agent: confirm`, T-APP-04); Merge opens the person's Review & merge card.
- Counts as filters over Needs you, Starting, Working, Queued and In review. The filter is the member's own card view state (T-APP-16), so one member's filter never changes another's card.
- Machines: `in_use/capacity`; the owner sees the `parallel` stepper, which runs the owner setting command.
- Background runs below the stack (`{id, title, state, detail}`). A failed run keeps **Retry** and **Dismiss**, both in-card catalog rows (§6.1.2).
- **New TODO** runs `/todo.new` with no input, so the form law renders the Draft card (T-APP-02).

Out:
- TODO and Draft cards (T-APP-02); Confirm (T-APP-04); the edge map and timeline (T-APP-07).
- The "incoming" filter (maintainer release, mvp.md §14); browser notifications (T-APP-18).
- Order, merge and parallel semantics (T-STK-02, T-STK-04, T-STK-03); sync health backend (T-GH-08); stack attention rows (T-GH-05, T-GH-07).

## Changes
- `apps/app/src/mainview/cards/HomeCard.tsx` (new) and `HomeCard.test.tsx` (new): the card family, spread into `cards/CardRenderers.tsx`.
- `packages/rpc/src/Home.ts` (new): the §14.3 Home schema and the client derivations (`attentionFor(role)`, `mergedSince(lastSeenSeq)`, `syncedAgo(now)`). One golden JSON fixture is shared with T-STK-01's Go projection test so the two can't drift.
- `packages/rpc/src/Cards.ts`: add kind `home` with payload `{repo}` (the filter and the open ⋯ menu are per-member view state); delete kind `stack` (`Cards.ts:1805`) and its `stackCardFamily`.
- `apps/app/src/mainview/flows/entries/history.ts`: `history.show` (`:29`) becomes `/stack` and embeds the `home` card; add `/stack.move Tn up|down` over `POST /api/todos/{n} {move}` and the hidden controls `home.filter` and `home.menu`. Hide `history.bootstrap`, `history.backfill` and `history.parallel` (delta.md §6).
- Delete `apps/app/src/mainview/cards/StackCard.tsx`, `StackCard.test.tsx` and `StackIssues.test.tsx`. Remove `watchHomeStack`, `snapshot` and `observeItems` from `state/seams/StackSeam.ts`; T-APP-02 and T-APP-04 delete the rest.
- `apps/app/src/mainview/cards/RepositoryHomeCard.tsx`: drop its stack block.
- `apps/app/e2e/playwright/stack.spec.ts`, `stack-todo.spec.ts`: rewrite against the `home` card.
- `apps/app/src/mainview/styles/cards.css`: port the mock's `mvp-stack*`, `mvp-filter*` and `mvp-machines` rules onto Paper tokens.

## Tests
- Unit (`HomeCard.test.tsx`): the row action for every (state, `needs_you.kind`, first-in-order, viewer role, `merge_block`) combination equals the §14.5.2 table; Merge appears on one row at most; settled rows have no ⋯ menu.
- Unit (`Home.test.ts`): `attentionFor` shows `order` only to maintainers and `force_push` only to the owner; `mergedSince` counts only merges above `last_seen_seq`; two members' cards built from one snapshot differ only in those values and the action.
- Unit: "synced N s ago" advances on the local clock with no delta; label boundaries at 59 s, 60 s, 120 s and 121 s (gold above 2 × the 60 s target).
- Unit: counts equal the snapshot's state counts after a sequence of deltas, including a delta that moves an item between filters while the filter is set.
- Unit: last look advances only after 2 s on screen; 1.9 s leaves the merged count unchanged.
- Unit: a `gap` frame shows the last snapshot and never a guessed state until the new snapshot arrives (§19.3).
- Unit: the card passes the C-UI-02 product-word and minimal-text lint.
- e2e (`apps/app/e2e/real/home.spec.ts`, new): the C-J4-01 script, including a failed background run's Retry and Dismiss.

## Acceptance
- [C-J4-01](../checks/C-J4-01.md): counts, filters, merged since last look, sync time and machines against capacity match PostgreSQL for every member.

## Risks and notes
- The TUI still imports `@smthrs/rpc/StackView` and `StackIssues` (`apps/tui/src/factory.ts`). The app stops importing them; T-CUT-03 defers the TUI but keeps it building.
- Risk: the `home` snapshot exceeds the 2 MiB send budget with long stacks (§7.1.1). Confirmed if a 200-item fixture produces `gap` on connect.
- Risk: merges since last look go wrong when `last_seen_seq` comes from a different topic's sequence. Falsified by the `mergedSince` unit test using `conversation:main` entry seqs only.
