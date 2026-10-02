# T-APP-13 Secrets card

Stage S2 · Size S · Depends on T-MCH-12 · Unblocks — · Issue: [#3462](https://github.com/smithersai/smithers/issues/3462)
Spec: spec.md §2 (Secret), §5.2, §7.2 (`secrets`), §8.8, §14.2, §14.3 (Secrets) · Delta: delta.md §3 (Modify: secrets reach machines) · Product: mvp.md J1.8, §6.15 Secrets, M-25, D-24 (via §8.8.2), Appendix A `/secrets`

## Goal
From `/secrets`, a maintainer adds, replaces and deletes secrets and sets each one's scope (all branches or main only); every member sees the names and scopes live, and nobody can read a value back.

## Scope
In:
- Rework the existing Secrets card (`cards/SecretsCard.tsx`, 139 lines) onto the `secrets` topic and the mock's shape (`cards/People.tsx:42-66`): one row per secret with its name, a scope select (all branches, main only), Replace and Delete (confirm); an add row with NAME, a write-only Value, scope and Add.
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
- `apps/app/src/mainview/cards/SecretsCard.tsx` and its test: rewrite on the topic; drop the Hosts column and the Bind button.
- `apps/app/src/mainview/state/seams/SecretsSeam.ts`: reads move to the `secrets` topic through `runtime/LiveChannel.ts` (T-APP-08); writes stay `PUT`/`DELETE /api/secrets` with `Idempotency-Key`.
- `apps/app/src/mainview/flows/entries/secrets.ts`: scope words become "all branches" and "main only" (product words, §2); `/secrets` replaces the member doors of `secrets.list` (`:140`) and `secrets.set` (`:100`).
- `packages/rpc/src/Cards.ts`: the `secrets` payload loses per-secret host counts.

## Tests
- Unit (`SecretsCard.test.tsx`): maintainer versus member controls; Delete and widening confirm; after Add, no value string remains in the card payload or the rendered markup.
- Integration (`SecretsSeam.test.ts`, real backend with PostgreSQL): a member's `PUT` returns 403 `permission`; `GET /api/secrets` never returns a value field.
- e2e: the C-MCH-07 script's card steps.

## Acceptance
- [C-MCH-07](../checks/C-MCH-07.md): secrets set on this card are present in every session and the coding host, and no API or card path reads a value back.

## Risks and notes
- Open: whether the MVP card carries a Bind door for egress binding (§8.9 swaps bound secrets in by host; Appendix B.2 lists `secrets.bind` under `/secrets`; §14.3 Secrets has name and scope only). Hidden until decided (owner: product).
- The mock's "used by N runs" is [D] (§0, §8.8.1); §14.3 doesn't list it, so the card omits it.
