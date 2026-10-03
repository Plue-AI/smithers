# T-UI-07 Conversation shell: branch tree, entry rows, Context line, Earlier archive

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-AGT-03, T-APP-16, T-APP-17, T-APP-22, T-REL-02 · Issue: [#3544](https://github.com/smithersai/smithers/issues/3544)
Spec: spec.md §14.2.1, §14.1, §14.5.1, §15.1.2 · Delta: delta.md §9 · Product: mvp.md §6.3, M-08 · Props: [ui-components.md § T-UI-07](../ui-components.md)

Landed (f21ddd50a).

## Goal

The conversation shell (`BranchTree`, `EntryRow`, `ContextLine`, `EarlierArchive`) renders from props, so T-APP-16 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-16 and T-APP-17. [S2, M-38] Design extends the existing chat components for T-AGT-03's read-only imported transcripts; no new card or View, and it is outside the S1 gate.

## Scope

In:
- Landed in `apps/app/src/mainview/`: `BranchTree.tsx` with crumbs, presence, per-node `action?` or an `onView` navigation patch, and the muted "Earlier · N" node last; `EntryRow.tsx` with author, title, summary, tone and action, the "Only you" lock chip on private entries, and title-only tombstones as one muted line; `ContextLine.tsx` chips; `EarlierArchive.tsx`, read-only with a "Read-only" chip.
- Remaining: merge `apps/app/src/mainview/styles/views/conversation.css` into `styles/chat.css` and drop the `mvp-` prefix (minimal-code synthesis v1 §6).

Out:
- Conversation storage, subscriptions, archive migration, access enforcement, preflight selection, summaries and transcript ingestion (T-APP-16, T-APP-17, T-AGT-03). The Inspect preflight cell is T-UI-12.

## Changes

- Move `styles/views/conversation.css` into `styles/chat.css`, renaming `mvp-` classes in the four shell files; delete it and its import in `styles/views.css`.
- Mounting: T-APP-16 mounts the shell. `cards/BranchesCard.tsx` is deleted in the change that mounts `BranchTree` (pair: BranchTree; v1 §2).

## Tests

The shell cases in `apps/app/src/mainview/cards/views/Views.test.tsx` cover:
- per-node action tag and arguments, the `selected_branch` patch, the archive selection patch and the final "Earlier · N" count;
- the lock chip on private entries; a tombstone is one muted line with the title and no summary or action;
- archived entries show "Read-only" and no mutation controls;
- shell text renders inert; a missing selected branch shows no unnamed crumb; popover arrow keys move and go to the parent.

## Acceptance

- The tests above pass in CI at the landed SHA. `styles/views/conversation.css` is gone.

## Risks and notes

- S2 transcript acceptance belongs to T-AGT-03 and cannot block this S1 ticket.
