# T-APP-13 Secrets card

Stage S2 · Size S · Depends on T-MCH-12, T-UI-18, T-APP-22 · Unblocks T-REL-02 · Issue: [#3462](https://github.com/smithersai/smithers/issues/3462)
Spec: spec.md §2 (Secret), §5.2, §7.2 (`secrets`), §8.8, §14.2, §14.3 (Secrets) · Delta: delta.md §3 (Modify: secrets reach machines) · Product: mvp.md J1.8, §6.15 Secrets, M-25, D-24 (via §8.8.2), Appendix A `/secrets`

## Goal
From `/secrets`, a maintainer adds, replaces and deletes secrets and sets each one's scope (all branches or main only); every member sees the names and scopes live, and nobody can read a value back.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `SecretsView`, with the CSS, in T-UI-18. This ticket builds no View, CSS or editor presentation. It owns the Secrets card file, which maps the topic to `SecretsView` props, and the commands in Changes (minimal-code synthesis v1 §2).

## Scope
In:
- Wire the Secrets card to the `secrets` topic: one row per secret with its name, scope (all branches or main only, §14.3 Secrets) and optional hosts, with Replace and Delete (confirm); Add with NAME, a write-only Value, scope and optional Hosts. `cards/SecretsCard.tsx` (139 lines) stays the card file and renders `SecretsView` (T-UI-18) in place of its own markup.
- Values travel only in the write request; the card payload, the topic and the DOM never hold one after the request (§2 "Value write-only"). "Nobody reads values back" covers the API and this card; any session on a machine can print all-branches values by design (§8.8.1).
- Members see names and scopes read-only; writes refuse with the `permission` class for anyone but the owner and maintainers (§5.2, §6.2.3).
- Widening a secret from main only to all branches asks first, as today's card does.
- `/secrets` with three doors over `secrets.list` and `secrets.set` (Appendix A).

Out:
- Delivering secrets into machines and keeping main-only ones out (T-MCH-12).
- "Used by N runs" ([D] §8.8.1, secret usage by run), which the mock still draws.
- The egress Bind control (`secrets.bind`): the mock has no door for it; it stays a hidden command (see notes).
- Coding-account connections (`secrets.connect*`, cloud runtime): cut surfaces (T-CUT-01).

## Changes
- `apps/app/src/mainview/cards/SecretsCard.tsx` stays the Secrets card file and the only mount point through `CardRenderers.tsx`: rows with name, scope and hosts; Add, Replace and Delete only for a maintainer or owner viewer; widening from main only to all branches carries a confirm step; Add and Replace send the value only in the write request. Deletes its own markup and the matching `SecretsCard.test.tsx` assertions (pair: SecretsView ↔ `SecretsCard` markup). T-APP-03 removes its `provider-accounts` family first.
- `packages/rpc/src/SecretsCard.ts` (T-UI-18 adds back the props type): zod only for the `secrets` payload, which crosses the live socket.
- `apps/app/src/mainview/state/seams/SecretsSeam.ts`: reads move to the `secrets` topic through `runtime/LiveChannel.ts` (T-COL-02); writes stay `PUT`/`DELETE /api/secrets` with `Idempotency-Key`.
- `apps/app/src/mainview/flows/entries/secrets.ts`: scope words become "all branches" and "main only" (product words, §2); `/secrets` replaces the member doors of `secrets.list` (`:140`) and `secrets.set` (`:100`).
- `packages/rpc/src/Cards.ts`: the `secrets` payload loses per-secret host counts. The kind keeps its name, so every pinned `secrets` row still decodes (card-kinds.md L4).

## Tests
- Unit (`SecretsCard.test.tsx`, literal topic payloads): maintainer versus member actions; Delete and widening carry a confirm step; after Add, no value string remains in the props or the card payload.
- Unit: every `Action.label` and `disabled.reason` the card file emits passes T-CAT-01's `lintText` (engineering's copy; the View's copy is T-UI-18's).
- Integration (`SecretsSeam.test.ts`, real backend with PostgreSQL): a member's `PUT` returns 403 `permission`; `GET /api/secrets` never returns a value field.
- e2e: a maintainer adds a main-only secret on the card through `SecretsView`; a member sees its name and scope read-only, and no value appears in the DOM, the card payload or `GET /api/secrets`.

## Acceptance
- [C-MCH-07](../checks/C-MCH-07.md): passes for this ticket’s phase at its stated layer.
- [C-UI-13](../checks/C-UI-13.md): `SecretsView` is reachable from `CardRenderers`; the `SecretsCard.tsx` markup is deleted.

## Risks and notes
- Resolved: the MVP card has no separate Bind door. Add and Replace take an optional Hosts field, and a secret with hosts stays egress-bound (§8.8.0, §14.3).
- The mock's "used by N runs" is [D] (§0, §8.8.1); §14.3 doesn't list it, so the card omits it.
