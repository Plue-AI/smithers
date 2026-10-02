# T-APP-10 Branch card: presence, activity, machine state, terminals, SSH line

Stage S2 · Size L · Depends on T-COL-06, T-COL-04, T-APP-16, T-APP-09, T-MCH-08, T-STK-11, T-UI-15, T-APP-19 · Unblocks — · Issue: to file
Spec: spec.md §3 (`activity`, `terminals`), §4.1, §7.2 (`branch:<id>`, `:activity`, `:files`), §7.3, §7.6 (presence `{path, line}`), §4.2, §8.4.4, §8.5, §8.10.5, §9.3.4, §9.3.8, §10.5.2, §10.7.3, §14.3 (Branch), §14.6a, §15.1.5 · Delta: delta.md §4 (Add [S1] activity; Add [S2] `:files`, bursts), §9 (Add [S2] Branch card) · Product: mvp.md J3.1–J3.6, J7.2–J7.3, §6.7 Branch card, §6.8 Presence, External changes, Shared agent activity, §8 (commit and branch lists merge into Home and Branch), M-17, M-27

## Goal
`/branch Tn` shows one card for the whole branch: its machine state, the item it works and its place, everyone on it (people and agents, each with where they are), grouped activity including steers and outside changes, changed files and terminals, and it reads a sleeping branch without waking it.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: `BranchCard` view: machine chip with Sleep/Wake, item and place, presence avatars, activity list, terminals, SSH line. Engineering wires them: the `branch:<id>` containers, presence feed, Sleep/Wake commands. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- `branch` card on `branch:<id>` + `:activity` + `:files`, embedded and maximized from one component:
  - header: branch name and machine state (Awake, Asleep, Waking, "Waiting for a machine #n" with the queue position, Closed); Asleep and Closed render dimmed from the captured snapshot (§8.4.4). In-card **Sleep** on an awake machine and **Wake** on an asleep one (§14.3); Wake is a `person` admission request (§8.3);
  - item line: the TODO's state (Queued, Starting, Working, Needs you, Paused, Failed, In review, Merged, Dropped; §4.1), title (`/todo Tn`) and place, or "Scratch" with **Add to stack** (`/branch.add-to-stack`): a new TODO placed after the item it was forked from, and this branch becomes its item branch `smithers/<slug>`, keeping its machine and the people on it (§8.5.3);
  - "<actor> moved this branch off Tn" with the in-card controls **Return to Tn** and **Keep for now** (§9.3.8), and "Rebase pending" with **Rebase now** (in-card `branch.rebase-now`, the same flow as `/branch.rebase`, §10.5.2) when the topic carries them. A scratch branch offers Rebase now onto what it was forked from (§8.5.2a);
  - presence: people first, then agents; each with the T-APP-09 actor, a verb and a where link: editing `path:line` (opens the File card at the line), in or running a terminal (with its command), watching a terminal, at a run step, or here;
  - tabs Activity, Files (count) and Terminals (count); the tab is the member's own card view state (T-APP-16), changed through a hidden `branch.tab` control;
  - Activity: the last 5 entries embedded and "N earlier", all 200 maximized. A burst reads "Maya via SSH changed 12 files", or "changed outside Smithers" when no single session owns it (§9.3.1), with **Diff**, which opens the diff between its `snapshot_before` and `snapshot_after` (§9.3.4) where **Restore this file** lives (T-APP-11). History writes (fork, place, reorder, rebase, merge) read as Smithers with the requester, "Smithers, for Ben" (§8.5.0, M-32). Steers carry a Steer tag and their author; GitHub-origin entries carry the GitHub mark; a question reads Asks or Asked;
  - Files: changed files against the item's base, each with its last writers; a row opens the File card;
  - Terminals: title, running command, owner and watchers, including the agent's terminal (T-TRM-05); a row opens the Terminal card;
  - a steer field on item branches (`/todo.steer Tn`);
  - actions: New terminal (`/terminal`), SSH, which copies `ssh -p 2222 <branch>@<host>` with the host name of the install's first public origin, or `localhost` when none is set (§8.10.5, `/ssh <branch>`), and Fork (`/branch.fork`). A closed branch offers Fork only.
- `/branches`: the branch list with machine state and presence avatars, and `/branch <name|Tn>` (Appendix A).
- Agent doors (§15.1.5, mvp.md Appendix B.2): `/branch`, `/branches`, `/branch.fork` and `/branch.rebase` are `agent: run` and run at once with the author's rights. `/branch.add-to-stack`, `/terminal`, Sleep and Wake are `agent: confirm`: the app agent posts a one-click Confirm card (T-APP-04) that the prompt's author presses, and the command runs from that session.
- The browser's presence heartbeat (§7.3.1): every 10 s and on every move, with where `{branch}`, `{path, line}`, `{terminal}` or `{run step}`.
- The model follows §14.3 Branch. Activity rows carry the §3 `activity` columns (kind, actor, summary, files, github); terminal rows carry the §3 `terminals` title plus §14.3 Terminal's owner, watchers and running command.

Out:
- Presence store, bursts, moved-off detection, fork and add-to-stack, rebase and admission (T-COL-06, T-COL-04, T-COL-05, T-MCH-08, T-STK-11, T-MCH-06).
- [D] Command names on entries, per-entry Undo and replaced-edit flags (§9.3.5–9.3.7); **Replace Tn** on Add to stack (§8.5.3); Ask to type (§8.11.2); the Machine view and the `box.*` services, egress and image facets (§0).

## Changes
- `apps/app/src/mainview/cards/BranchCard.tsx` (new) and test; spread into `cards/CardRenderers.tsx`.
- Delete `cards/WorkspaceCard.tsx` (590 lines), `cards/BranchesCard.tsx` and their tests; their member doors in `flows/entries/box.ts` (`box.list` `:26`, `box.open` `:36`, `box.terminal` `:70`) and `flows/entries/branches.ts:16` become `/branches`, `/branch` and `/terminal`. Remove from `state/seams/WorkspaceSeam.ts` what only `WorkspaceCard` read.
- `packages/rpc/src/Cards.ts`: kinds `branch {id}` (the tab is per-member view state) and `branches`; delete `workspace` and the old `branches` payload. `packages/rpc/src/Branch.ts` (new): the model, with a golden fixture shared with the T-COL-04 and T-COL-06 projection tests.
- `apps/app/src/mainview/state/Presence.ts` (new): the heartbeat sender over the live channel's `presence` frame.
- `apps/app/e2e/playwright/citc.spec.ts`: rewrite for the Branch card.

## Tests
- Unit (`BranchCard.test.tsx`): each machine state with Sleep on Awake and Wake on Asleep only; scratch versus item; moved-off row with Return to Tn and Keep for now; rebase-pending row and Rebase now on a scratch branch; people ordered before agents; a burst row has Diff and no Undo or command name; an outside burst reads "changed outside Smithers"; a fork entry reads "Smithers, for Ben".
- Unit: after Add to stack, the same card (same branch id) shows the new item line and name without a remount.
- Unit: an Asleep branch renders from the snapshot and sends no wake command; opening Files or Diff on it issues reads only.
- Unit: the SSH action copies `ssh -p 2222 <branch>@localhost` with no origin set and uses the first origin's host name once one is set.
- Unit (`Presence.test.ts`, fake clock): a heartbeat every 10 s, one per move, none after the card closes.
- e2e: the C-J3-01 and C-J3-03 scripts.

## Acceptance
- [C-J3-01](../checks/C-J3-01.md): two people, the coding agent and an SSH editor each appear with where they are.
- [C-J3-03](../checks/C-J3-03.md): an outside change shows as one grouped entry attributed to the only active session, else "changed outside Smithers"; it opens its diff, and open cards update.

## Risks and notes
- The mock's Add to stack offers "New TODO after <last stack item>" (`Branch.tsx:114`); §8.5.3 defaults to after the item the branch was forked from. The card follows §8.5.3.
- The mock's SSH line uses `smithers.local`, which is never built; the card uses §8.10.5's host.
- Risk: presence rows flicker as heartbeats from several tabs of one person interleave. Falsified if a person with two tabs ever shows two rows or a row that disappears and returns within 30 s (§7.3.2: one avatar per person).
