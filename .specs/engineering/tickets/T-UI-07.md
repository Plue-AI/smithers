# T-UI-07 Conversation shell: branch tree, entry rows, Context line, Earlier archive

Stage S1 · Size L · Depends on T-UI-01, T-APP-19 · Unblocks T-AGT-03, T-APP-16, T-APP-17, T-APP-22, T-APP-23, T-REL-02 · Issue: [#3544](https://github.com/smithersai/smithers/issues/3544)
Spec: spec.md §14.2.1, §14.1, §14.5.1, §15.1.2 · Delta: delta.md §9 · Product: mvp.md §6.3, M-08 · Props: [ui-components.md § T-UI-07](../ui-components.md)

## Goal

The conversation shell (`BranchTree`, `EntryRow`, `ContextLine` and the Earlier archive) exists as props-only components matching the design mock and ui-components.md, so the wiring ticket only binds data and actions.

## Ownership (Will, 2026-10-02)

Design (smithers-06) owns this ticket. Engineering wires it in T-APP-16, T-APP-17 and reviews nothing visual. Design reviews engineering's wiring when idle.

[S2, M-38] Design owns the shared chat extension for T-AGT-03: imported prompts, assistant turns, tool calls/results, file-edit reports and errors, all read-only, with T-UI-01 agent avatars. Extend existing chat components; add no card or View. T-AGT-03 owns the S2 schema fixtures and wiring. This extension is outside the S1 completion gate. C-AGT-02 proves the live conversation and read-only controls.

## Scope

In:
- Private entries use the same small "Only you" lock chip as Drafts. A title-only tombstone is one muted line containing the card title, with no summary or action (§14.1.5). Place the muted "Earlier · N" node at the end of the branch tree; it opens read-only archives with a "Read-only" chip. Check: C-UI-12.
- The crumbs and `BranchTree` with presence, `EntryRow` with author, title, summary, tone and derived action, private-entry styling, `ContextLine` chips (the preflight cell in Inspect is T-UI-12), and the read-only Earlier archive node.
- Props exactly as `ui-components.md` § T-UI-07 until T-APP-19 lands, then the zod type from `packages/rpc/src/<Card>Card.ts`.
- Fixture stories for every state the props allow, light and dark, desktop and 390 px.

Out:
- Topic subscriptions, Containers, command dispatch, permission decisions and product copy changes. Will decides copy changes; smithers-06 reviews their presentation (§14.6b).
- Conversation storage, subscriptions, archive migration or access enforcement, app-agent turns, preflight selection, summaries, transcript ingestion and executable tool calls. T-APP-16/T-APP-17 own S1 wiring; T-AGT-03 owns S2 transcript fixtures and wiring. Inspect's preflight cell is T-UI-12. No person-to-person chat, external-agent resend/edit/retry/stop/steer controls, or new external-agent card.

## Changes

- Private entries use the same small "Only you" lock chip as Drafts. A title-only tombstone is one muted line containing the card title, with no summary or action (§14.1.5). Place the muted "Earlier · N" node at the end of the branch tree; it opens read-only archives with a "Read-only" chip. Check: C-UI-12.

- Title-only tombstone rows, branch tree, Earlier and Context chips. Check: C-UI-12.


- Add props-only `apps/app/src/mainview/BranchTree.tsx`, `EntryRow.tsx`, `ContextLine.tsx` and `EarlierArchive.tsx` (new) and CSS. These shell parts are not card rows and add no card View under `cards/views/`. Consume T-APP-19 shell types and fixtures through module subpaths. Every handler calls `onAction` with `data-flow`, `onView`, or local presentation state.
- Fixtures from `@smthrs/rpc` (`packages/rpc/test/fixtures/`, written with T-APP-19).

## Tests

- Assert the shared private lock chip, one-line muted tombstone title with no summary or action, final muted "Earlier · N" node, and archive "Read-only" chip with mutation controls absent. Retain ancestry coverage (J6 s11; J11 s13). Check: C-UI-12.

- C-UI-12, named case `Conversation shell renders branch navigation, entries and Earlier`: render the production exports in `apps/app/src/mainview/cards/views/Views.test.tsx` and `apps/app/e2e/playwright/view-stories.spec.ts` (new harnesses), in light and dark at 1280 and 390 px; each supplied action carries `data-flow`, disabled controls show their supplied reason and do not dispatch, and each enabled press calls only its agreed callback once. Cover main/item/scratch/Earlier nodes, agent presence, title-only tombstones, private styling, absent summaries, Context disclosure and read-only archive entries. Click supplied navigation actions and Context disclosure and compare literal tags/patches. Render the actual shell exports through the C-UI-12 harness, not a synthetic card. S2 external transcript acceptance belongs to T-AGT-03/C-AGT-02 and cannot block this S1 gate.
- Commit reviewed literal expected strings, tags, argument objects, patches and tone token names independently of the implementation. No test reads `.specs/` or derives expectations from schemas, action arrays, rendering helpers or other production code at runtime. C-UI-08 checks the production presentation files and seeded seam violations.
- smithers-06 records copy approval from the screenshots. C-UI-02 includes these fixtures when T-CAT-01 supplies the lint; that downstream audit does not block this props-only ticket.

## Acceptance

- Copy review: the design reviewer reads every fixture screenshot at 1,440 px and 390 px, light and dark, against spec §14.6b, and records approve or fix per screen in this ticket’s issue. Check: C-UI-12.


- [C-UI-12](../checks/C-UI-12.md) for this ticket's Views, with T-APP-19's fixtures. It needs no Container: the wiring ticket's own checks prove the card end to end.

## Risks and notes

- T-UI-01 and T-APP-19 are the landing prerequisites. Local props and fixtures allow drafting before the contracts land, not completion. S1 lands on the shell contracts and fixtures only. The S2 extension starts with T-AGT-03's reviewed fixtures and is accepted there; it is not a dependency of this S1 ticket. This ticket adds its own C-UI-12 harness coverage with smithers-b8 pre-review.
- smithers-06 decides visuals and accepts screenshots. Will decides product copy and behavior changes. Tech lead smithers-8a accepts any ADR or spec-field change after smithers-b8 approves the app callback seam and smithers-38 approves the shared TypeScript API; update §14.3, ui-components.md and T-APP-19 together before implementation.

## Ready checklist

1. Dependencies: T-UI-01 supplies shared primitives; T-APP-19 supplies contracts and committed fixtures. S1 lands on the shell contracts and fixtures only. The S2 extension starts with T-AGT-03's reviewed fixtures and is accepted there; it is not a dependency of this S1 ticket.
2. Exclusions: Out names the runtime effects and adjacent surfaces this presentation ticket must not implement.
3. Tests: C-UI-12 case `Conversation shell renders branch navigation, entries and Earlier` renders production exports and asserts committed literal output/callback expectations; C-UI-08 checks the seam. No spec or production-derived runtime oracle.
4. Decisions: smithers-06 accepts visuals and screenshots; Will decides product changes; smithers-8a accepts ADR/spec changes after smithers-b8 seam and smithers-38 API approval.
5. Owner pre-review before start: smithers-06: answered 18:10 with these changes (mock 21b445a6) smithers-b8: Are navigation/disclosure callbacks presentation-only, and will S2 imported text keep mutation controls absent without adding a card? smithers-38: Do the T-APP-19 schema and fixture subpaths cover these states and callback payloads without changing the shared public API?
6. Security: This presentation executes no repository code, shell commands or imported tool text. smithers-b8 pre-reviews data-only rendering and absence of RPC/fetch or host execution; wiring that executes repository code requires machine-only execution (M-29) and smithers-3f review.
