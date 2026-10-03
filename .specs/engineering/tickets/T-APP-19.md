# T-APP-19 Card view-model schemas and fixtures from `ui-components.md`: the seam between design's views and engineering's containers

Stage S1 · Size S · Depends on none (catalog step: T-CAT-01) · Unblocks none · Issue: [#3474](https://github.com/smithersai/smithers/issues/3474)
Spec: spec.md §14.2.1, §14.3 · Delta: delta.md §9 · Product: mvp.md §6 (cards)

## Goal
The card contracts landed in a292b7328 and e3a521ad6 (+16,609 lines, about 79% tests, fixtures and a JSON snapshot of zod's own output). This ticket deletes what no S1 card needs, then closes as landed history. Later schema changes ride with each card's wiring ticket (minimal-code synthesis v2, card contracts).

## Scope
In:
- Delete `packages/rpc/test/cards/RetainedCards.test.ts` and its 5,046-line snapshot `packages/rpc/test/cards/__snapshots__/RetainedCards.test.ts.snap`.
- Delete the S2/S3 schemas, fixtures and tests: `packages/rpc/src/{Proposal,Terminal,Secrets,Branch,Docs,DebugApi}Card.ts`, `packages/rpc/test/fixtures/{Proposal,Terminal,Secrets,Branch,Docs,DebugApi}.ts` and `packages/rpc/test/cards/{Proposal,Terminal,Secrets,Branch,Docs,DebugApi}Card.test.ts`. No production file imports them (`git grep`; `CardRenderers.tsx:36` imports the app's own `./SecretsCard`, not the rpc schema). Each returns with its own stage's ticket.
- Keep zod for the schemas whose data crosses HTTP or storage: `TodoCard`, `DraftCard`, `SetupCard`, `SettingsCard`, `ConfirmCard`, `HomeCard`, `MembersCard`, `CardAction`, `CardPrimitives`.
- Convert the view-only schemas to TypeScript types: `ActorChipCard`, `AgentCard`, `BranchTreeNodeCard`, `CommandsCard`, `ContextLineCard`, `DiffCard`, `EntryRowCard`, `FileCard`, `FlowCard`, `MonitorCard`, `TimelineCard`, `ToastCard`. Before converting one, `git grep` its `Schema` for a runtime `parse`; a schema that parses HTTP or storage data stays zod and the ticket names its caller. Their fixture files and `test/cards/*Card.test.ts` go with them.
- Delete the temporary tag placeholder `packages/rpc/src/catalog/index.ts` ("Temporary Appendix A tag contract, replaced by T-CAT-01"), in the same change as T-CAT-01's descriptor source lands. Move its callers to that source: `packages/rpc/src/CardAction.ts:9,12`, `CommandsCard.ts:8`, `ConfirmCard.ts:9`, `apps/app/src/mainview/flows/FlowAction.ts:15` and `packages/rpc/test/cards/Catalog.test.ts:3`.

Out:
- New schemas, fixture rounds or per-card golden topic fixtures.
- `SubagentCard.ts` and `Cards.ts`, the legacy card union (T-APP-22).
- Views and their props tests (T-UI tickets, `cards/views/Views.test.tsx`).

## Changes
- The deletions and conversions in Scope, with `packages/rpc/package.json` subpath exports and `packages/rpc/docs/` updated to match; `pnpm docs:sync`, `pnpm docs:check`, `smthrs docs //packages/rpc:docs`.

## Tests
Folded from C-UI-08, only what still applies.
- Unit (`packages/rpc/test/cards/<Card>Card.test.ts`, kept schemas only): each kept schema parses a real payload captured from its route or store (literal JSON checked in beside the test), and an unknown enum value fails: a `TodoCard` state `"paused_forever"`, a `ConfirmCard` kind `"merge_now"`, a `SetupCard` step `"teleport"`. A `ConfirmCard` with a forbidden current subject fails to parse; a previous-version persisted Confirm payload decodes through the legacy path (T-APP-22).
- Unit (`apps/app/src/mainview/flows/parity.test.ts`, existing): each View handler calls `onAction(action.tag, …)` from a control with `data-flow`, calls `onView(patch)`, or touches only local state, focus or `copyText`; a seeded View that imports a store or calls `fetch` fails, and a compliant one passes. Each card file builds `actions[]` through `cardActions`.
- Type check: `tsc` over `apps/app` passes with the deleted schemas gone and the view-only types in place.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

## Risks and notes
- After this lands, the ticket closes as landed history; T-APP-19b is closed already.
- Risk: a view-only schema is parsed at runtime somewhere unseen. The `git grep` step names it before conversion; `tsc` and the kept tests catch the rest.
