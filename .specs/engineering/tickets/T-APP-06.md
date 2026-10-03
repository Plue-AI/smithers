# T-APP-06 Members card

Stage S1 · Size M · Depends on T-ACC-02, T-UI-09, T-APP-19 · Unblocks T-REL-02 · Issue: [#3500](https://github.com/smithersai/smithers/issues/3500)
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
- Commands with three doors: `/members`, `members.add <login>`, `members.role <login> <role>`, `members.remove <login>` (the person confirms removal in the card). These are person-only: the catalog row is `agent: never` (mvp.md Appendix B: "Maintainer (P only; agents: never)"; spec §5.2), so a delegated credential, including the app agent's `delegated(via=smithers)` (§15.1.4), gets 403 class `permission` with no `fix`, and no confirmation is created (T-ACC-05).
- Non-maintainers see the roster read-only; the server authorizer refuses their writes with the `permission` class (§5.2.1, §6.2.3).

Out:
- Sign-in, the access check, the hourly re-check and role seeding (T-ACC-01, T-ACC-02); revocation within 5 s (T-ACC-06).
- `smthrs connect`, a LAN CA and mDNS names, which the mock shows for unconnected members: deferred, never built.
- Taking over a removed member's TODO: the TODO card's **Take over** (T-APP-02, C-APP-01).

## Changes
- `packages/rpc/src/topics/Members.ts` (new): the `members` decoder. `packages/rpc/test/fixtures/topics/members.json` (new): the golden, which `members_topic_golden_test.go` (new) compares with T-ACC-02's builder.
- `apps/app/src/mainview/cards/containers/membersModel.ts` (new): `toMembersModel(members, viewer)`: rows with login, name, avatar, role, `needs_access` and `suspended`; for a maintainer or owner viewer, a role action and Remove (confirm) on every non-owner row, and Add; none on the owner's row and none for a member viewer.
- `apps/app/src/mainview/cards/containers/MembersContainer.tsx` (new): subscribes `members`; renders `MembersView` (T-UI-09); Add sends only a login matching GitHub's `[A-Za-z0-9-]{1,39}` and keeps a refusal in place.
- `packages/rpc/src/Cards.ts`: kind `members`.
- `apps/app/src/mainview/flows/entries/members.ts` (new): the four commands over `/api/members` (§6.3) with `Idempotency-Key`.

## Tests
- Unit (`membersModel.test.ts`): rows for owner, maintainer, member, needs-access and suspended; actions only for a maintainer or owner viewer; the owner's row has no role action or Remove.
- Unit (`MembersContainer.test.tsx`): Add with an empty or malformed login sends nothing; a refused add maps the typed `github` class to its message in place.
- Unit: every `Action.label` and `disabled.reason` the adapter emits passes C-UI-02's `lintText` (engineering's copy; the View's copy is its T-UI ticket's).
- Integration (`apps/app/src/mainview/state/seams/MembersSeam.test.ts`, new, real backend with PostgreSQL): a member's `members.role` returns 403 `permission`; a delegated maintainer's `members.add`, `members.role` and `members.remove` each return 403 class `permission` with no `fix`, create no `person_confirmations` row and change nothing; `members_topic_golden_test.go` equals the golden.
- e2e: the C-J1-05 script through `MembersView`.

## Acceptance



- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.

- [C-J1-05](../checks/C-J1-05.md): add by username, "needs access on GitHub" for a person without write access, and a teammate signs in from the install's origin and appears on the card.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Resolved: §14.3 Members carries login, name and avatar.
- Take over lives on the TODO card (T-APP-02, Appendix B.4 `todo.takeover`).
- Risk: GitHub's login lookup for a username that does not exist returns 404; confirmed if Add then shows a raw HTTP error instead of the typed `github` class message.
