# T-APP-10 Branch card: presence, activity, machine state, terminals, SSH line

Stage S2 · Size L · Depends on T-COL-06, T-COL-04, T-APP-16, T-APP-09, T-MCH-08, T-STK-11, T-UI-15, T-APP-19, T-APP-11, T-APP-22 · Unblocks T-REL-02 · Issue: [#3555](https://github.com/smithersai/smithers/issues/3555)
Spec: spec.md §3 (`activity`, `terminals`), §4.1, §7.2 (`branch:<id>`, `:activity`, `:files`), §7.3, §7.6 (presence `{path, line}`), §4.2, §8.4.4, §8.5, §8.10.5, §9.3.4, §9.3.8, §10.5.2, §10.7.3, §14.3 (Branch), §14.6a, §15.1.5 · Delta: delta.md §4 (Add [S1] activity; Add [S2] `:files`, bursts), §9 (Add [S2] Branch card) · Product: mvp.md J3.1–J3.6, J7.2–J7.3, §6.7 Branch card, §6.8 Presence, External changes, Shared agent activity, §8 (commit and branch lists merge into Home and Branch), M-17, M-27

## Goal
`/branch Tn` shows one card for the whole branch: its machine state, the item it works and its place, everyone on it (people and agents, each with where they are), grouped activity including steers and outside changes, changed files and terminals, and it reads a sleeping branch without waking it.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `BranchView`, with the CSS, in T-UI-15. This ticket builds no View, CSS or editor presentation. It owns the topic decoder and golden fixture, the adapter, the Container and the commands in Changes ([card-kinds.md §1](../card-kinds.md)), plus the browser's presence heartbeat. The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope

- Map branch rebase facts to BranchModel `rebase` and `terminals[].frozen`; expose `waiting_for` only to the member who pressed Rebase now. Check: C-J10-04.

In:
- `branch` card on `branch:<id>` + `:activity` + `:files`, embedded and maximized from one component:
  - header: branch name and machine state (Awake, Asleep, Waking, "Waiting for a machine #n" with the queue position, Closed); Asleep and Closed render dimmed from the captured snapshot (§8.4.4). In-card **Sleep** on an awake machine and **Wake** on an asleep one (§14.3); Wake is a `person` admission request (§8.3);
  - item line: the TODO's state (Queued, Starting, Working, Needs you, Paused, Failed, In review, Merged, Dropped; §4.1), title (`/todo Tn`) and place, or "Scratch" with **Add to stack** (`/branch.add-to-stack`): a new TODO placed after the item it was forked from, and this branch becomes its item branch `smithers/<slug>`, keeping its machine and the people on it (§8.5.3);
  - "<actor> moved this branch off Tn" with the in-card controls **Return to Tn** and **Keep for now** (§9.3.8), and "Rebase pending" with **Rebase now** (in-card `branch.rebase-now`, the same flow as `/branch.rebase`, §10.5.2) when the topic carries them. A scratch branch offers Rebase now onto what it was forked from (§8.5.2a);
  - presence: people first, then agents; each with the T-APP-09 actor, a verb and a where link: editing `path:line` (opens the File card at the line), in or running a terminal (with its command), watching a terminal, at a run step, or here;
  - tabs Activity, Files (count) and Terminals (count); the tab is the member's own card view state (T-APP-16), changed through `onView`, not a catalog command;
  - Activity: the last 5 entries embedded and "N earlier", all 200 maximized. A burst reads "Maya via SSH changed 12 files", or "changed outside Smithers" when no single session owns it (§9.3.1), with **Diff**, which opens the diff between its `snapshot_before` and `snapshot_after` (§9.3.4) where **Restore this file** lives (T-APP-11). History writes (fork, place, reorder, rebase, merge) read as Smithers with the requester, "Smithers, for Ben" (§8.5.0, M-32). Steers carry a Steer tag and their author; GitHub-origin entries carry the GitHub mark; a question reads Asks or Asked;
  - Files: changed files against the item's base, each with its last writers; a row opens the File card;
  - Terminals: title, running command, owner and watchers, including the agent's terminal (T-TRM-05); a row opens the Terminal card;
  - a steer field on item branches (`/todo.steer Tn`);
  - actions: New terminal (`/terminal`), SSH, which copies `ssh -p 2222 <branch>@<host>` with the host name of the install's first public origin, or `localhost` when none is set (§8.10.5, `/ssh <branch>`), and Fork (`/branch.fork`). A closed branch offers Fork only.
- `/branch <name|Tn>` (Appendix A). `/branches` opens the branch tree (T-APP-16, T-APP-23); this ticket fills each tree node's `present` from `branch:<id>`.
- Agent doors use the catalog policy (§5.2.1): branch reads, fork, rebase, `/terminal`, Sleep and Wake are `run`; Add to stack is `confirm` and returns 202 with a confirmation id. No Container adds a confirmation to a `run` action. Check: C-ACC-01.
- The browser's presence heartbeat (§7.3.1): every 10 s and on every move, with where `{branch}`, `{path, line}`, `{terminal}` or `{run step}`.
- The model follows §14.3 Branch. Activity rows carry the §3 `activity` columns (kind, actor, summary, files, github); terminal rows carry the §3 `terminals` title plus §14.3 Terminal's owner, watchers and running command.

Out:
- Presence store, bursts, moved-off detection, fork and add-to-stack, rebase and admission (T-COL-06, T-COL-04, T-COL-05, T-MCH-08, T-STK-11, T-MCH-06).
- [D] Command names on entries, per-entry Undo and replaced-edit flags (§9.3.5–9.3.7); **Replace Tn** on Add to stack (§8.5.3); Ask to type (§8.11.2); the Machine view and the `box.*` services, egress and image facets (§0).

## Changes
- `packages/rpc/src/topics/Branch.ts` (new): the decoders of `branch:<id>` and `branch:<id>:activity`. Goldens `packages/rpc/test/fixtures/topics/branch.json` and `branch-activity.json` (new), compared by Go golden tests with T-COL-06's `branch:<id>` builder and T-STK-01's activity builder.
- `apps/app/src/mainview/cards/containers/branchModel.ts` (new): `toBranchModel(branch, activity, files, viewer, view)`: the machine state with Sleep only when awake, Wake only when asleep and Retry when failed; item or scratch, with Add to stack on a scratch branch; moved off with Return to Tn and Keep for now; the rebase state: pending with Rebase now (and, for the member who pressed it, the write it waits for, §9.4.2), rebasing, or a scratch branch's conflict with Resolve and Done; presence people first, then agents, through `toActor` (T-APP-09); activity rows, where an unowned burst reads "changed outside Smithers" with Diff, and history writes read "Smithers, for Ben"; changed files from T-APP-11's `branch:<id>:files` decoder; terminals; the SSH line `ssh -p 2222 <branch>@<host>` from the first public origin's host, or `localhost` when none is set. A closed branch offers Fork only.
- `apps/app/src/mainview/cards/containers/BranchContainer.tsx` (new): subscribes the three topics; the tab is an `onView` patch; renders `BranchView` (T-UI-15). For an asleep branch it issues reads only.
- `apps/app/src/mainview/state/Presence.ts` (new): the heartbeat sender over the live channel's `presence` frame.
- `packages/rpc/src/Cards.ts`: kind `branch {id}`. Move `workspace`, `commit` and `commit-list` to `LEGACY_CARD_KINDS` and delete their options (card-kinds.md §2); T-APP-23 moves `branches`.
- Delete `cards/WorkspaceCard.tsx` (590 lines) and its test, moving the deferred `environment-images` family to its own file unchanged (card-kinds.md §3: Deferred, T-CUT-03). Delete the `commit` and `commit-list` families of `cards/CommitCards.tsx` and their producers in `state/seams/CommitsSeam.ts`. The member doors `box.list` (`:26`), `box.open` (`:36`) and `box.terminal` (`:70`) in `flows/entries/box.ts` and `flows/entries/branches.ts:16` become `/branches`, `/branch` and `/terminal` (T-APP-12); `box.suspend` and `box.resume` become the in-card Sleep and Wake over `POST /api/branches/{b} {sleep|wake}`. Remove from `state/seams/WorkspaceSeam.ts` what only `WorkspaceCard` read.
- `apps/app/e2e/playwright/citc.spec.ts`: rewrite for the Branch card.

## Tests
- Unit (`branchModel.test.ts`): from the goldens, each machine state with Sleep only on Awake and Wake only on Asleep; scratch versus item; the moved-off actions; rebase pending with Rebase now on a scratch branch; people before agents; a burst row has Diff and no Undo or command name; an unowned burst reads "changed outside Smithers"; a fork entry's actor reads "Smithers, for Ben"; the SSH line with no origin and with one.
- Unit (`BranchContainer.test.tsx`): after Add to stack, the same branch id yields the new item line and name with no remount; an asleep branch's Container sends no wake command, and opening Files or Diff issues reads only.
- Unit (`Presence.test.ts`, fake clock): a heartbeat every 10 s, one per move, none after the card closes.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration: the two Go golden tests equal their goldens.
- e2e: the C-J3-01 and C-J3-03 scripts through `BranchView`.

## Acceptance




- [C-J3-01](../checks/C-J3-01.md): two people, the coding agent and an SSH editor each appear with where they are.
- [C-J3-03](../checks/C-J3-03.md): an outside change shows as one grouped entry attributed to the only active session, else "changed outside Smithers"; it opens its diff, and open cards update.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- The mock's Add to stack offers "New TODO after <last stack item>" (`Branch.tsx:114`); §8.5.3 defaults to after the item the branch was forked from. The card follows §8.5.3.
- The mock's SSH line uses `smithers.local`, which is never built; the card uses §8.10.5's host.
- Risk: presence rows flicker as heartbeats from several tabs of one person interleave. Falsified if a person with two tabs ever shows two rows or a row that disappears and returns within 30 s (§7.3.2: one avatar per person).
