# T-APP-06 Members card

Stage S1 · Size M · Depends on T-ACC-02, T-UI-09, T-APP-19, T-APP-08, T-APP-16, T-APP-09, T-ACC-03, T-ACC-06, T-CAT-02 · Unblocks T-REL-02 · Issue: [#3500](https://github.com/smithersai/smithers/issues/3500)
Spec: spec.md §2 (Member), §5.1.2–5.1.4, §5.2, §5.4, §5.6, §7.2 (`members`), §14.2, §14.3 (Members), §15.1.4 · Delta: delta.md §2 (Add `members`, `/api/members`) · Product: mvp.md J1.8, §6.2, §6.15 Members and maintainers, M-05, M-17, Appendix A `/members`

## Goal
From `/members`, a maintainer adds a teammate by GitHub username, sees "needs access on GitHub ↗" when that person lacks write access, changes roles and removes people, and every member sees the same roster live.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds the `MembersView`, with the CSS, in T-UI-09. This ticket builds no View, CSS or editor presentation. It owns the topic decoder and golden fixture, the adapter, the Container and the commands in Changes ([card-kinds.md §1](../card-kinds.md)). The seam is the view model from T-APP-19 (spec §14.2.1).

## Scope
In:
- `members` card on the `members` topic: one row per member with avatar, name, `@login`, role, and state:
  - the owner's role is fixed; nobody can demote or remove the owner (§5.1.4);
  - maintainers change a role with a select (Maintainer, Member) and remove a person (confirm);
  - "needs access on GitHub ↗" links to the repository's collaborator settings when the person lacks write access (§5.1.2);
  - a suspended member shows "suspended" from the §14.3 `suspended` field, with the same GitHub link (§5.1.3).
- An add row: GitHub username and Add. The new row appears only when the `members` topic reports it, with the role seeded from GitHub: admin or maintain becomes Maintainer, write becomes Member (§5.1.4). A person with only read access, or none, can't be added.
- `/members` and its in-card Add, Role and Remove commands use the shared dispatcher; the person confirms removal in MembersView. The catalog is `agent: never`; eligible delegated callers receive HTTP 403 class/code `never` with "Only a person can do this", while insufficient role or scope keeps the earlier 403 permission refusal (§5.2.1). Neither creates a person confirmation or mutation. The CLI's `/members` path opens the app card for a person, performs no mutation and exposes no external-agent path (Appendix B.6).
- Non-maintainers see the roster read-only; the server authorizer refuses their writes with the `permission` class (§5.2.1, §6.2.3).

Out:
- Sign-in, the access check, the hourly re-check and role seeding (T-ACC-01, T-ACC-02); revocation within 5 s (T-ACC-06).
- `smthrs connect`, a LAN CA and mDNS names, which the mock shows for unconnected members: deferred, never built.
- Taking over a removed member's TODO: the TODO card's **Take over** (T-APP-02, C-APP-01).
- Owner transfer, invitation/email flows, organizations/teams, GitHub collaborator-permission writes, delegated/CLI member mutations, new person-confirmation paths, new Views/CSS and repository execution. Removing a member uses T-ACC-06 revocation; this ticket adds no second revoker.

## Changes
- `packages/rpc/src/topics/Members.ts` (new): the `members` decoder. `packages/rpc/test/fixtures/topics/members.json` (new): the golden, which `members_topic_golden_test.go` (new) compares with T-ACC-02's builder.
- `apps/app/src/mainview/cards/containers/membersModel.ts` (new): `toMembersModel(members, viewer)`: rows with login, name, avatar, role, `needs_access` and `suspended`; for a maintainer or owner viewer, a role action and Remove (confirm) on every non-owner row, and Add; none on the owner's row and none for a member viewer.
- `apps/app/src/mainview/cards/containers/MembersContainer.tsx` (new): subscribes `members`; renders `MembersView` (T-UI-09); builds actions through `cardActions` → `flowAction`, uses per-member view state, and registers `members` in CardRenderers. The login field applies T-ACC-02's validator before dispatch and keeps the server's typed refusal in place; the server remains the authority.
- `packages/rpc/src/Cards.ts`: kind `members`.
- `apps/app/src/mainview/flows/entries/members.ts` (new): the four commands over `/api/members` (§6.3) with `Idempotency-Key`.

## Tests
- Unit (`membersModel.test.ts`): rows for owner, maintainer, member, needs-access and suspended; actions only for a maintainer or owner viewer; the owner's row has no role action or Remove.
- Unit (`MembersContainer.test.tsx`): pinned empty/malformed-login cases send nothing. A no-write-access refusal preserves T-ACC-02's literal `needs_github_access`, class `user`, message and access fix link; GitHub/infra lookup failures keep their own typed class/message. No request refusal invents or inserts a member row.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration (`apps/app/src/mainview/state/seams/MembersSeam.test.ts`, new): invoke the production catalog dispatcher/authorizer and composed `/api/members` GET/POST/PATCH/DELETE routes with real PostgreSQL and `/api/live` subscriptions. Test literal role/credential outcomes: active Member reads but cannot write; eligible delegated read/write gets 403 never; lower-role writes get 403 permission; owner demotion/removal and role-to-owner attempts get owner_immutable after earlier auth checks. Refusals write no member/projection/confirmation row. A permitted removal calls the real T-ACC-06 revoker and closes the removed member's live session within 5 s. `members_topic_golden_test.go` compares the real builder with the pinned fixture. Expected responses and row counts are literal fixtures or independent input logs, never values computed by the authorizer or validator under test.
- e2e (`apps/app/e2e/real/members.spec.ts`): C-J1-05 invokes `/members` through the production dispatcher and CardRenderers/MembersContainer/MembersView, including keyboard Add/Role/Remove, LAN-origin sign-in, refused access and reconnect after backend downtime. The CLI person-facing path only opens the card. Roster changes appear only after committed deltas; reconnect retains the last roster until a fresh snapshot. No test reads spec files or derives expectations from production code at runtime.

## Acceptance



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J1-05](../checks/C-J1-05.md): add by username, "needs access on GitHub" for a person without write access, and a teammate signs in from the install's origin and appears on the card.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Resolved: §14.3 Members carries login, name and avatar.
- Take over lives on the TODO card (T-APP-02, Appendix B.4 `todo.takeover`).
- Risk: GitHub's login lookup for a username that does not exist returns 404; the card must preserve T-ACC-02's typed envelope and never expose a raw HTTP error. smithers-8a resolves contract disagreements; Will decides changes to role/owner policy. smithers-06 accepts the View/removal confirmation seam, smithers-b8 signs off public command/error behavior, smithers-38 accepts decoding under §21.1, and smithers-3f accepts access/revocation semantics.

## Ready checklist

1. Depends on supplies roster/access/role storage, authorizer, revocation, live client, per-member view state, actors, schema/View and the CLI open-card path. Remove cannot land before the revoker it requires.
2. Out names identity/access/backend jobs, takeover, networking helpers, owner transfer, invites, organizations/teams, GitHub ACL changes, delegated/CLI mutations, extra confirmation paths, visuals and repository execution.
3. C-J1-05 uses production dispatcher/renderer/Container/View on the real members/live routes; integration tests current permission precedence, immutable owner, zero refused effects and removal/revocation. Literal fixtures and independent inputs define outcomes.
4. smithers-8a resolves contract disagreements; Will decides role/owner policy changes; smithers-06 accepts View/removal confirmation; smithers-b8 public behavior; smithers-38 RPC decoding; smithers-3f access/revocation.
5. Before start, smithers-06: do read-only rows and the person's Remove confirmation fit MembersView? smithers-b8: do person-only catalog/CLI-open paths match the real route/error behavior; do unavailable backends retain the last roster? smithers-38: does the Members decoder preserve owner, needs_access and suspended states with actor fields? smithers-3f: do role/owner guards and removal call the existing access/revocation chain without a second writer? Record pre-review in #3500.
6. Member commands execute packaged host code only and never run repository content; no Add/Role/Remove path launches a machine or shell. smithers-3f reviews access and credential revocation, and route tests prove refused calls have zero effects. Later repository execution remains machine-only (§17.3, M-29).

