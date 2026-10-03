# T-APP-13 Secrets card

Stage S2 · Size S · Depends on T-UI-18, T-APP-22, T-COL-02, T-ACC-03, T-CAT-01 · Unblocks T-REL-02 · Issue: [#3462](https://github.com/smithersai/smithers/issues/3462)
Spec: spec.md §2 (Secret), §5.2, §7.2 (`secrets`), §8.8, §14.2, §14.3 (Secrets) · Delta: delta.md §3 (Modify: secrets reach machines) · Product: mvp.md J1.8, §6.15 Secrets, M-25, D-24 (via §8.8.2), Appendix A `/secrets`
Ready: 2026-10-03 smithers-8a sha256:0af9ab3393c3

## Goal
From `/secrets`, a maintainer adds, replaces and deletes secrets and sets each one's scope (all branches or main only); every member sees the names and scopes live, and nobody can read a value back.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `SecretsView`, with the CSS, in T-UI-18. This ticket builds no View, CSS or editor presentation. It owns the Secrets card file, which maps the topic to `SecretsView` props, and the commands in Changes (minimal-code synthesis v1 §2). smithers-b8 accepts app wiring and command behavior; smithers-38 approves the public RPC schema and legacy decoder; smithers-3f accepts backend authorization and secret-transport seams; smithers-06 accepts the View prop mapping. A missing field or product change goes to smithers-8a before implementation. Owner review is post hoc under Will’s 2026-10-03 directive; no new owner answer is claimed here.

## Scope
In:
- Wire the Secrets card to the `secrets` topic: one row per secret with its name, scope (all branches or main only, §14.3 Secrets) and optional hosts, with Replace and Delete (confirm); Add with NAME, a write-only Value, scope and optional Hosts. `cards/SecretsCard.tsx` (139 lines) stays the card file and renders `SecretsView` (T-UI-18) in place of its own markup.
- Values travel only in the write request; the card payload, the topic and the DOM never hold one after the request (§2 "Value write-only"). "Nobody reads values back" covers the API and this card; any session on a machine can print all-branches values by design (§8.8.1).
- Members see names and scopes read-only; writes refuse with the `permission` class for anyone but the owner and maintainers (§5.2, §6.2.3).
- Widening a secret from main only to all branches asks first, as today's card does.
- Reuse `/secrets` over `secrets.list` and `secrets.set` (Appendix A), with card actions bound through `flows/cardActions.ts`. Secret reads admit active member sessions; writes admit owner and maintainer sessions only. Delegated, run and machine credentials cannot read names or write secrets; no agent confirmation carries a value (§5.2.0c).
- Lands dark until T-UI-18 and T-APP-22: withhold the new View mount until its props contract and live-kind decoder are available; preserve pinned rows. Lands dark until T-COL-02: refuse live reads without the authorized `secrets` topic; do not fall back to polling. Lands dark until T-ACC-03 and T-CAT-01: refuse reads and writes without the shared authorizer and catalog policy. Lands dark until T-MCH-12: refuse writes until scoped delivery is available; never claim that a secret reached a machine. Lands dark until T-APP-03: do not activate the reshaped card family while `provider-accounts` still shares it. Tests: the unavailable-provider cases below.

Out:
- Delivering secrets into machines and keeping main-only ones out (T-MCH-12).
- "Used by N runs" ([D] §8.8.1, secret usage by run), which the mock still draws.
- The egress Bind control (`secrets.bind`): the mock has no door for it; it stays a hidden command (see notes).
- Coding-account connections (`secrets.connect*`, cloud runtime): cut surfaces (T-CUT-01); their extraction belongs to T-APP-03.
- New Views, CSS, a separate Container, a second secrets store or policy table, backend CRUD redesign, machine provisioning, guest-root writes, secret usage tracking, provider-key delivery and scheduled trusted runs.

## Changes
- `apps/app/src/mainview/cards/SecretsCard.tsx` stays the Secrets card file and the only mount point through `CardRenderers.tsx`: rows with name, scope and hosts; Add, Replace and Delete only for a maintainer or owner viewer; widening from main only to all branches carries a confirm step; Add and Replace send the value only in the write request. Deletes its own markup and replaces only obsolete markup assertions in `SecretsCard.test.tsx`; retain behavior coverage through the mounted View. T-APP-03 owns removal of its `provider-accounts` family.
- `packages/rpc/src/SecretsCard.ts`: reuse the existing schema and props type with T-UI-18; reshape only the live payload contract. No parallel schema or props module.
- `apps/app/src/mainview/state/seams/SecretsSeam.ts`: reads move to the `secrets` topic through `runtime/LiveChannel.ts` (T-COL-02); writes stay `PUT`/`DELETE /api/secrets` with `Idempotency-Key`.
- `apps/app/src/mainview/flows/entries/secrets.ts`: scope words become "all branches" and "main only" (product words, §2); `/secrets` replaces the member doors of `secrets.list` (`:140`) and `secrets.set` (`:100`).
- `packages/rpc/src/Cards.ts`: replace the duplicate live `secrets` payload with the shared schema and retain one read-only legacy decoder. Map old `mainOnly` to `scope`, preserve `hosts`, and remove host-count presentation in the card. The kind keeps its name, so every pinned `secrets` row still decodes (card-kinds.md L4).

## Tests
- Unit (`SecretsCard.test.tsx`, literal topic payloads): mount through `CardRenderers.tsx`; owner and maintainer actions versus member read-only rows; Delete and widening require confirmation and cancellation sends no write; Add and Replace clear the write-only field after success or failure. Values never enter serialized props, card payloads, journal entries, DOM attributes or preload arguments. A typed value is confined to the write-only input until submission.
- Unit: every `Action.label` and `disabled.reason` the card file emits passes T-CAT-01's `lintText` (engineering's copy; the View's copy is T-UI-18's).
- Unit (existing command tests through `createCommandRegistry` in `flows/Commands.ts`): `/secrets`, Add, Replace, Delete and scope actions dispatch the shared catalog commands. Delegated callers cannot read names or submit writes; no pending confirmation contains a value. Literal old pinned rows decode as live `secrets` rows with preserved names, scopes and hosts.
- Integration (`SecretsSeam.test.ts`, real backend and PostgreSQL through the production router in `packages/backend/internal/compose/router.go`, not direct handler calls): exercise the spec’d `GET`/`PUT`/`DELETE /api/secrets` boundary and scope command. Owner and maintainer sessions write; member writes return 403 `permission`; member reads contain names and scopes only; delegated, run and machine reads/writes are refused. No response contains a value. Current repo-prefixed routes are reuse sources, not a test substitute for the MVP routes.
- Integration (unavailable-provider cases, C-MCH-07 card phase and C-UI-13): independently withhold T-UI-18, T-APP-22, T-COL-02, T-ACC-03, T-CAT-01, T-MCH-12 and T-APP-03 contracts. Exercise the production mount and dispatcher; assert the Scope refusals, no unauthorized network write, no polling fallback and no success claim. Build against the specified contracts without a second runtime.
- e2e (C-MCH-07 card phase): open `/secrets` through the composer, then Add, Replace, scope and Delete through the mounted `SecretsView`. Another member sees committed names and scopes live and no write actions. Block a write response: Chat remains usable, the command acknowledges before completion, and the shared toast settles only on the real response. Cover failure, duplicate submission and reload; a lost write-only value is not replayed. After submission no value remains in the DOM, card payload or API reads.
- All expected roles, statuses, payloads and legacy rows are committed literals; tests never read `.specs/` or derive expected behavior from production code. Machine delivery and guest-root tests remain T-MCH-12's phase of C-MCH-07.
## Acceptance
- [C-MCH-07](../checks/C-MCH-07.md): passes for this ticket’s phase at its stated layer.
- [C-UI-13](../checks/C-UI-13.md): `SecretsView` is reachable from `CardRenderers`; the `SecretsCard.tsx` markup is deleted.

## Risks and notes
- Resolved: the MVP card has no separate Bind door. Add and Replace take an optional Hosts field, and a secret with hosts stays egress-bound (§8.8.0, §14.3).
- The mock's "used by N runs" is [D] (§0, §8.8.1); §14.3 doesn't list it, so the card omits it.
- Security review: smithers-3f reviews person-only authorization and the write-only transport with smithers-b8. This ticket executes no repository code and adds no root step. Repository execution remains machine-only with no host fallback (M-29); guest-root env delivery and all its input validation belong to T-MCH-12, not this card. Hosts preserve the existing egress binding; values never enter agent input, a durable request or a confirmation.

## Ready checklist
1. Dependencies: only called View/schema, decoder, live-channel, authorizer and catalog contracts appear in Depends on. Scope names fail-closed dark landing for each dependency and the T-MCH-12/T-APP-03 landing preconditions; missing landings do not block Ready.
2. Exclusions: Scope explicitly excludes delivery, guest root, new presentation, duplicate stores/policy, usage tracking, Bind UI, coding accounts, provider keys and scheduled runs; existing card, seam and schema are reshaped.
3. Boundary tests: the production card mount, command registry, authorized live topic and HTTP router are exercised with real PostgreSQL and literal expectations; C-MCH-07's card phase and C-UI-13 cover this slice.
4. Decisions: smithers-b8 accepts app behavior, smithers-38 the public RPC/decoder contract, smithers-3f backend/security seams, smithers-06 prop mapping, and smithers-8a spec or product changes.
5. Owner pre-review questions (post hoc per Will’s directive): smithers-06: does the mapping use the approved SecretsView props without new presentation? smithers-b8: do all card/slash actions share the dispatcher and preserve write-only/background behavior? smithers-38: does one schema preserve old pinned secrets rows without a duplicate live contract? smithers-3f: do the production routes/topic enforce person-only access, and does dark landing prevent writes before scoped delivery? Existing recorded owner answers stand.
6. Security: smithers-3f and smithers-b8 review authorization and value transport. No repository execution or root step is introduced, so this ticket consumes no root-step inputs; guest-root work stays in T-MCH-12. Tests cover actor refusals and value exclusion.
