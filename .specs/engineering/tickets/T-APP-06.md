# T-APP-06 Members card

Stage S1 · Size M · Depends on T-ACC-02, T-UI-09, T-APP-19 · Unblocks — · Issue: to file
Spec: spec.md §2 (Member), §5.1.2–5.1.4, §5.2, §5.4, §5.6, §7.2 (`members`), §14.2, §14.3 (Members), §15.1.4 · Delta: delta.md §2 (Add `members`, `/api/members`) · Product: mvp.md J1.8, §6.2, §6.15 Members and maintainers, M-05, M-17, Appendix A `/members`

## Goal
From `/members`, a maintainer adds a teammate by GitHub username, sees "needs access on GitHub ↗" when that person lacks write access, changes roles and removes people, and every member sees the same roster live.

## Ownership (Will, 2026-10-02)

Design (smithers-06) builds every visual component and its styles: `MembersCard` view: rows, roles, needs access, suspended, add by username. Engineering wires them: the `members` topic container and the member commands. The seam is the card's view-model schema (spec §14.2.1, T-APP-19). Design builds against it with fixture stories, and engineering doesn't edit components or CSS.

## Scope
In:
- `members` card on the `members` topic: one row per member with avatar, name, `@login`, role, and state:
  - the owner's role is fixed; nobody can demote or remove the owner (§5.1.4);
  - maintainers change a role with a select (Maintainer, Member) and remove a person (confirm);
  - "needs access on GitHub ↗" links to the repository's collaborator settings when the person lacks write access (§5.1.2);
  - a suspended member shows "suspended" from the §14.3 `suspended` field, with the same GitHub link (§5.1.3).
- An add row: GitHub username and Add. The new row appears only when the `members` topic reports it, with the role seeded from GitHub: admin or maintain becomes Maintainer, write becomes Member (§5.1.4). A person with only read access, or none, can't be added.
- Commands with three doors: `/members`, `members.add <login>`, `members.role <login> <role>`, `members.remove <login>` (the person confirms removal in the card). These are person-only: the catalog row is `agent: never` (mvp.md Appendix B: "Maintainer (P only; agents: never)"; spec §5.2), so a delegated credential, including the app agent's `delegated(via=smithers)` (§15.1.4), gets 403 `never` and no confirmation is created.
- Non-maintainers see the roster read-only; the server authorizer refuses their writes with the `permission` class (§5.2.1, §6.2.3).

Out:
- Sign-in, the access check, the hourly re-check and role seeding (T-ACC-01, T-ACC-02); revocation within 5 s (T-ACC-06).
- `smthrs connect`, a LAN CA and mDNS names, which the mock shows for unconnected members: deferred, never built.
- Taking over a removed member's TODO (§5.6): see notes.

## Changes
- `apps/app/src/mainview/cards/MembersCard.tsx` (new) and test; spread into `cards/CardRenderers.tsx`.
- `packages/rpc/src/Cards.ts`: kind `members`. `packages/rpc/src/Members.ts` (new): the `members` model, with a golden fixture shared with T-ACC-02's projection test.
- `apps/app/src/mainview/flows/entries/members.ts` (new): the four commands over `/api/members` (§6.3) with `Idempotency-Key`.
- `apps/app/src/mainview/styles/cards.css`: port the mock's `mvp-members` rules onto Paper tokens.

## Tests
- Unit (`MembersCard.test.tsx`): rows for owner, maintainer, member, needs-access and suspended; controls present only for a maintainer viewer; the owner row has no role select or Remove.
- Unit: Add with an empty or malformed login (outside GitHub's `[A-Za-z0-9-]{1,39}`) does not send; a refused add shows the server's reason in place.
- Unit: the card passes the C-UI-02 product-word and minimal-text lint.
- Integration (`apps/app/src/mainview/state/seams/MembersSeam.test.ts`, new, real backend with PostgreSQL): a member's `members.role` returns 403 `permission`; a delegated maintainer's `members.add`, `members.role` and `members.remove` each return 403 `never`, create no `person_confirmations` row and change nothing.
- e2e: the C-J1-05 script.

## Acceptance
- [C-J1-05](../checks/C-J1-05.md): add by username, "needs access on GitHub" for a person without write access, and a teammate signs in from the install's origin and appears on the card.
- [C-UI-13](../checks/C-UI-13.md): A Container's model from a real topic parses with its schema and its actions come from `cardActions`; at each stage exit every §14.3 row of the stage is wired and no View is orphaned

## Risks and notes
- Spec gap: §14.3 Members lists role, `needs_access` and `suspended`, but not the name, login and avatar every mock row shows (`cards/People.tsx`); `members.login` exists in §3. The tech lead adds them to the model.
- Resolved: product added `todo.takeover` (Take over, in-card, maintainers) to Appendix B.4.
- Risk: GitHub's login lookup for a username that does not exist returns 404; confirmed if Add then shows a raw HTTP error instead of the typed `github` class message.
