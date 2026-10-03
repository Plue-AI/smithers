# T-UI-07 Conversation shell: branch tree, entry rows, Context line, Earlier archive

Stage S1 · Size S · Depends on T-UI-01 · Unblocks T-AGT-03, T-APP-16, T-APP-17, T-APP-22 · Issue: [#3544](https://github.com/smithersai/smithers/issues/3544)
Spec: spec.md §14.2.1, §14.1, §14.5.1, §15.1.2 · Delta: delta.md §9 · Product: mvp.md §6.4, M-08 · Props: [ui-components.md § T-UI-07](../ui-components.md)
Ready: 2026-10-03 smithers-8a sha256:1a325af9134e

Landed (f21ddd50a).

## Goal

The conversation shell (`BranchTree`, `EntryRow`, `ContextLine`, `EarlierArchive`) renders from props, so T-APP-16 only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-16 and T-APP-17. [S2, M-38] Design extends the existing chat components for T-AGT-03's read-only imported transcripts; no new card or View, and it is outside the S1 gate.

## Scope

In:
- Landed in `apps/app/src/mainview/`: `BranchTree.tsx` with crumbs, presence, per-node `action?` or an `onView` navigation patch, and the muted "Earlier · N" node last; `EntryRow.tsx` with author, title, summary, tone and action, the "Only you" lock chip on private entries, and title-only tombstones as one muted line; `ContextLine.tsx` chips; `EarlierArchive.tsx`, read-only with a "Read-only" chip.
- Remaining: reshape the existing conversation-shell rules in `apps/app/src/mainview/styles/cards.css` into `styles/chat.css` and drop their `mvp-` prefix. The former `styles/views/conversation.css` and `styles/views.css` are already absent; do not recreate them.
- Land dark: reuse the landed props-only shell. Until T-UI-01 is available, do not mount it or substitute primitives. T-APP-16 and T-APP-17 own activation, data and action binding; this change adds no live subscriptions or command dispatch. Check: C-UI-12.

Out:
- Conversation storage, subscriptions, archive migration, access enforcement, preflight selection, summaries and transcript ingestion (T-APP-16, T-APP-17, T-AGT-03). The Inspect preflight cell is T-FLW-07.
- Production mounting, catalog dispatch, persistence of view state and deletion of `cards/BranchesCard.tsx` belong to the wiring tickets. No new card, View, schema, actor-label module, person-to-person chat, archive mutation, host command execution or root step.

## Changes

- Move the existing conversation-shell rules from `styles/cards.css` into `styles/chat.css`, renaming their classes in `BranchTree.tsx`, `EntryRow.tsx`, `ContextLine.tsx`, `EarlierArchive.tsx` and `cards/views/BranchNode.tsx`. Update selectors in `cards/views/ConversationView.stories.tsx` and `cards/views/Views.test.tsx` in the same change. Retain shared primitive selectors used by other Views; delete the replaced shell rules. Reuse the existing components and handlers; add no new implementation.
- Mounting: T-APP-16 mounts the shell. `cards/BranchesCard.tsx` is deleted in the change that mounts `BranchTree` (pair: BranchTree; v1 §2).

## Tests

C-UI-12 runs the shell cases in `apps/app/src/mainview/cards/views/Views.test.tsx` through DOM events on the exported production shell components, including `BranchCrumbs` and `BranchNode`. This props-only boundary proves rendering and callback output, not dispatcher authorization. Keep expected text, tags, arguments and patches as literal test values; never read the spec or derive expectations from production code at runtime. Existing cases are named "Conversation shell renders branch navigation, entries and Earlier", "shell text is inert; private, empty and disabled boundaries", "ancestor crumb preserves action contract disabled=…" and "missing selected branch has no unnamed crumb; popover arrows move and go to parent". They cover:
- per-node action tag and arguments, the `selected_branch` patch, the archive selection patch and the final "Earlier · N" count;
- the lock chip on private entries; a tombstone is one muted line with the title and no summary or action;
- archived entries show "Read-only" and no mutation controls;
- shell text renders inert; a missing selected branch shows no unnamed crumb; popover arrow keys move and go to the parent.

## Acceptance
- [C-UI-12](../checks/C-UI-12.md): passes for this ticket’s phase at its stated layer.

- The tests above pass in CI at the landed SHA. The renamed shell selectors occur only in `styles/chat.css`, with no duplicate shell rules in `styles/cards.css`; light/dark Paper styles and keyboard focus remain intact. Extend the C-UI-12 shell cases to verify those styles using the app stylesheet entry, not a test-only replacement.

## Risks and notes

- S2 transcript acceptance belongs to T-AGT-03 and cannot block this S1 ticket.
- smithers-06 decides presentation, keyboard behavior and CSS placement. smithers-b8 decides the app binding seam. smithers-8a accepts any missing-prop spec change before implementation; this ticket does not change the public API.
- Security review: smithers-b8 reviews inert text, callback-only actions and read-only archive slots. No repository code execution or root step is introduced, so there are no root inputs from main or a branch. Any repository build/test execution runs only in a machine under M-29, without sudo; host execution and image changes remain outside this ticket. C-UI-12 proves hostile strings are inert and disabled actions do not dispatch.

## Ready checklist

1. Dependencies: T-UI-01 supplies the shell primitives; no runtime provider is needed for the props-only CSS change. Activation stays in T-APP-16/T-APP-17 and lands dark until its providers are available (C-UI-12).
2. Exclusions: Scope names storage, authority, dispatch, mounting, persistence, ingestion, archive mutation, new surfaces and root/host execution.
3. Tests: C-UI-12 uses DOM events on production shell exports with literal oracles; wiring tickets own production dispatcher and route acceptance. CSS checks use the app stylesheet entry.
4. Decisions: smithers-06 decides design/CSS, smithers-b8 decides binding, and smithers-8a accepts spec changes; no ADR or public API change is authorized.
5. Owner review: smithers-06 and smithers-b8 must pre-review the seam before implementation; under Will’s parallel-build directive, recorded owner answers stand and review may be post hoc. smithers-06: Does the CSS move preserve Paper light/dark and keyboard focus? Does the rename preserve every shell/BranchNode selector without changing shared primitives? smithers-b8: Does the change stay props-only, leaving mounting, dispatch and archive access enforcement to the wiring tickets?
6. Security: smithers-b8 reviews inert strings, disabled callbacks and read-only slots (C-UI-12); repository builds/tests run only in machines without sudo (M-29). No root step exists and the root-input inventory is empty.
