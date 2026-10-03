# T-APP-09 Actor adapter: participants and "for Ben" (§14.6a, M-34)

Stage S1 · Size S · Depends on T-ACC-04, T-UI-01 · Unblocks T-AGT-03, T-APP-02, T-APP-04, T-APP-06, T-APP-07, T-APP-10, T-APP-16, T-MCH-08, T-REL-02, T-TRM-02 · Issue: [#3503](https://github.com/smithersai/smithers/issues/3503)
Spec: spec.md §2 (actor notation), §5.3, §6.4, §14.6a, §14.6a.1 · Delta: delta.md §9 (Modify: actor rendering with `via` badges) · Product: mvp.md J6.3, §6.13 Attribution, M-21, M-34

## Goal
Every card, toast and line that names who acted renders the §14.6a participant one way, from one actor module, one actor enum, one via enum and one role enum (minimal-code synthesis v1 §6).

## Scope
In:
- Keep the landed adapter `apps/app/src/mainview/state/ProductActor.ts` (`toActor`, stored notation) and `state/TodoActors.ts` (b1c772ed8) as the one actor-label module. It already maps `via`, `for_member` and `color_index` (members 0–5, undelegated agent 6, GitHub and outside 7).
- Delete the second module, `cards/views/actorName.ts`: move `actorName` into `state/ProductActor.ts` (which today only re-exports it) and point its one importer, `cards/views/ActorChip.tsx:7`, there. `EntryRow.tsx` and the Views keep importing through `ActorChip`.
- In `packages/rpc`: `ActorSchema` (`CardPrimitives.ts:129`) is the one actor schema; no `ActorRef` exists (verified with `git grep`). Keep `ViaSchema` (`:77`) and `AgentKindSchema` (`:92`) as the one via and agent enum.
- Delete the inline enums in `CardAction.ts:91-92`: `settings.model-key` takes its role from `MODEL_ROLES` (`CardPrimitives.ts:106`) and `settings.setup` its step from `SetupStepIdSchema` (`SetupCard.ts:31`).

Out:
- A new `packages/rpc/src/ProductActor.ts`; the stored notation stays an app type until a second package reads it.
- Minting delegated credentials, the `Smithers-Via` header and recording `via` (T-ACC-04).
- Broker registration of agent processes, presence, activity and terminals (S2 tickets).
- The app's dispatcher `ActorSchema` (`state/AppState.ts:525`), which names the Flux actor, not the product actor.

## Changes
- `apps/app/src/mainview/state/ProductActor.ts`: holds `actorName`; delete `cards/views/actorName.ts` (pair: `ProductActor.ts` stays, `actorName.ts` goes).
- `apps/app/src/mainview/cards/views/ActorChip.tsx`: import `actorName` from `state/ProductActor`.
- `packages/rpc/src/CardAction.ts`: replace the two inline unions with the existing types.
- `apps/app/lint/conformance/Rules.ts` (existing): card and toast source never builds " via ", " for " or "'s terminal" by hand.

## Tests
- Unit (`ProductActor.test.ts`): `toActor` and `actorName` for each stored shape give the literal names "Smithers for Ben", "Claude Code for Ben", "Codex for Ben", "Ben via SSH", "Ben's terminal", "Ben via CLI", "Coding agent for Ben", "Reviewer for Ben", "@login" and "Changed outside Smithers"; an unknown agent name renders verbatim; a removed member keeps their login. Color indices: members 0–5, an agent for nobody 6, GitHub and outside 7; -1 and 8 fail to parse.
- Unit, same file: a session credential's actor never becomes an agent participant, even with a `Smithers-Via` header (§6.4); a system write never becomes an agent.
- Unit (`CardAction.test.ts`): `settings.model-key` accepts each `MODEL_ROLES` value and rejects `"slow"` at type check; `settings.setup` accepts each `SETUP_STEP_IDS` value.
- Unit (conformance): a card or toast that formats " via " or " for " itself fails the lint.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-J6-01](../checks/C-J6-01.md): actions Claude Code takes from Ben's branch terminal show "Claude Code for Ben" on the cards that record them.

## Risks and notes
- M-34 replaces the "Ben via Smithers" badge with the agent's own avatar and "for Ben"; `via` stays on the wire and only the rendering changes.
