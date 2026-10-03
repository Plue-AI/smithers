# T-APP-06 Members card

Stage S1 · Size S · Depends on T-ACC-02, T-ACC-03, T-APP-16, T-APP-09, T-CAT-01, T-UI-09 · Unblocks T-REL-02 · Issue: [#3500](https://github.com/smithersai/smithers/issues/3500)
Spec: spec.md §2 (Member), §5.1.2–5.1.4, §5.2, §5.4, §5.6, §7.2 (`members`), §14.2, §14.3 (Members), §15.1.4 · Product: mvp.md J1.8, §6.2, §6.15 Members and maintainers, M-05, M-17, Appendix A `/members`

## Goal
From `/members`, a maintainer adds a teammate by GitHub username, sees "needs access on GitHub ↗" when that person lacks write access, changes roles and removes people, and every member sees the same roster live.

## Scope
In:
- `members` card: one row per member with avatar, name, `@login`, role and state.
  - The owner's role is fixed; nobody can demote or remove the owner (§5.1.4).
  - Maintainers change a role (Maintainer, Member) and remove a person (confirm in `MembersView`).
  - "needs access on GitHub ↗" links to the repository's collaborator settings when the person lacks write access (§5.1.2); a suspended member shows "suspended" with the same link (§5.1.3).
- An add row: GitHub username and Add. The new row appears only after the server commits it, with the role seeded from GitHub: admin or maintain becomes Maintainer, write becomes Member (§5.1.4). Read access or none can't be added.
- `/members` and its in-card Add, Role and Remove commands use the shared dispatcher. All are `agent: never`: an eligible delegated caller gets 403 `never` with "Only a person can do this"; insufficient role or scope gets 403 `permission`; neither creates a row. The CLI's `/members` opens the card and mutates nothing (Appendix B.6).
- Non-maintainers see the roster read-only; the server refuses their writes with `permission`.

Out: sign-in, the access check, the hourly re-check, role seeding and revocation within 5 s (T-ACC-01, T-ACC-02); Take over (T-APP-02); `smthrs connect`, LAN CA and mDNS (never built); owner transfer, invitations, organizations, GitHub permission writes and delegated member mutations.

## Changes
- Members are the existing `collaborators` table plus three columns and the uncalled `AddCollaborator` (`internal/db/repos.sql.go:27`), served at `/api/members` by T-ACC-02 (ruling 1). No `members` table.
- `cards/MembersCard.tsx` (new) is the card file: it reads `GET /api/members`, re-reads on each `/api/live` notice, maps rows and the viewer's role to `MembersView` props (56ff44a03), binds Add, Role and Remove with `flows/cardActions.ts`, and is mapped to kind `members` in `cards/CardRenderers.tsx`. It replaces no legacy card: none exists. Existing code considered: `MembersView` is props-only and no seam reads `/api/members`. The login field applies T-ACC-02's validator before dispatch; the server stays the authority.
- `packages/rpc/src/Cards.ts`: kind `members`.
- `flows/entries/members.ts` (new): `/members` plus Add, Role and Remove over `/api/members` and `/api/members/{login}` with `Idempotency-Key`.

## Tests
- Unit (`MembersCard.test.tsx`): rows for owner, maintainer, member, needs-access and suspended; Role and Remove only for a maintainer or owner viewer, and never on the owner's row. Empty and malformed logins send nothing. A no-write-access refusal keeps T-ACC-02's literal `needs_github_access`, class `user`, message and fix link; GitHub and infra lookup failures keep their own class and message; no refusal inserts a row. A user-not-found 404 shows the typed envelope, never a raw HTTP error.
- Integration (real PostgreSQL, production dispatcher, composed `/api/members` routes): an active Member reads but can't write; a delegated read or write gets 403 `never`; lower-role writes get 403 `permission`; owner demotion, owner removal and role-to-owner get `owner_immutable`. Refusals write nothing. A permitted removal calls T-ACC-02's revoker and closes the removed member's live session within 5 s. Expected responses and row counts are literals.
- e2e (`e2e/real/members.spec.ts`): C-J1-05 runs `/members` through the production dispatcher, `CardRenderers`, `MembersCard` and `MembersView`, including keyboard Add, Role and Remove, LAN-origin sign-in, refused access and reconnect after backend downtime; reconnect keeps the last roster until a fresh read.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.
- [C-J1-05](../checks/C-J1-05.md): add by username, "needs access on GitHub" for a person without write access, and a teammate signs in from the install's origin and appears on the card.
- [C-UI-13](../checks/C-UI-13.md): `MembersView` is reachable from `CardRenderers`; no legacy members card exists to delete.

## Risks and notes
- Member commands run packaged host code only; no Add, Role or Remove path launches a machine or shell. smithers-3f reviews access and revocation; Will decides role or owner policy changes.
