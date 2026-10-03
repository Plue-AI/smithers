# T-APP-06 Members card

Stage S1 · Size S · Depends on T-ACC-02, T-ACC-03, T-APP-16, T-APP-09, T-CAT-01, T-UI-09, T-COL-02 · Unblocks T-REL-02 · Issue: [#3500](https://github.com/smithersai/smithers/issues/3500)
Spec: spec.md §2 (Member), §5.1.2–5.1.4, §5.2, §5.4, §5.6, §7.2 (`members`), §14.2, §14.3 (Members), §15.1.4 · Product: mvp.md J1.8, §6.2, §6.15 Members and maintainers, M-05, M-17, Appendix A `/members`
Ready: 2026-10-03 smithers-8a sha256:1f46952d97b7

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
- Land dark against the specified contracts. Until T-ACC-02 roster/revocation, T-ACC-03 authorization, T-APP-16 conversation mounting, T-APP-09 actor mapping, T-CAT-01 dispatcher/catalog, T-UI-09 View and T-COL-02 live channel are available and the Members checks pass together, keep the Members entry and renderer inactive. Direct requests fail closed before reads or writes when their authority or provider is unavailable; no legacy route or browser-side mutation fallback. C-J1-05 and the integration tests below prove activation and missing-provider refusals.

Out: sign-in, the access check, the hourly re-check, role seeding and revocation within 5 s (T-ACC-01, T-ACC-02); Take over (T-APP-02); `smthrs connect`, LAN CA and mDNS (never built); owner transfer, invitations, organizations, GitHub permission writes and delegated member mutations.

## Changes
- Reuse T-ACC-02's `/api/members` contract over the existing `collaborators` table and enabled `AddCollaborator` (`packages/backend/internal/db/repos.sql.go:27`). T-ACC-02 owns the three columns, routes and revoker; this ticket adds no table or backend membership implementation.
- Reuse `apps/app/src/mainview/cards/views/MembersView.tsx`, `apps/app/src/mainview/flows/cardActions.ts` → `flowAction`, and T-COL-02's `apps/app/src/mainview/runtime/LiveChannel.ts`. Add `apps/app/src/mainview/cards/MembersCard.tsx` as the card file: read `GET /api/members`, subscribe to `members`, re-read on member notices and reconnect, map rows and the viewer's role to View props, and register in `apps/app/src/mainview/cards/CardRenderers.tsx`. Rejected reuse: no Members card or roster consumer exists; the props-only View cannot fetch. Do not add a separate Container or live client. Apply T-ACC-02's login validator before dispatch; the server stays the authority.
- Reuse `packages/rpc/src/MembersCard.ts` and the existing `members`, `members.add`, `members.role` and `members.remove` inputs in `packages/rpc/src/CardAction.ts`. Wire kind `members` into `packages/rpc/src/Cards.ts` with that schema, not a duplicate model. Use T-ACC-04's shared member-role enum when available. Public export changes meet §21.1 and require smithers-38 sign-off.
- Add `apps/app/src/mainview/flows/entries/members.ts`: `/members` plus Add, Role and Remove over `/api/members` and `/api/members/{login}` with `Idempotency-Key`, registered through the existing flow registry and T-CAT-01 mapping. Rejected reuse: no Members entry exists; org/account commands have different authority and subjects.

## Tests
- Unit (`MembersCard.test.tsx`): rows for owner, maintainer, member, needs-access and suspended; Role and Remove only for a maintainer or owner viewer, and never on the owner's row. Empty and malformed logins send nothing. A no-write-access refusal keeps T-ACC-02's literal `needs_github_access`, class `user`, message and fix link; GitHub and infra lookup failures keep their own class and message; no refusal inserts a row. A user-not-found 404 shows the typed envelope, never a raw HTTP error.
- Integration (real PostgreSQL, production dispatcher, composed `/api/members` routes): an active Member reads but can't write; a delegated read or write gets 403 `never`; lower-role writes get 403 `permission`; owner demotion, owner removal and role-to-owner get `owner_immutable`. Refusals write nothing. A permitted removal calls T-ACC-02's revoker and closes the removed member's live session within 5 s. Expected responses and row counts are literals.
- Missing-provider integration (same production dispatcher and composed routes): omit each required authority or provider in turn; direct Members reads and mutations refuse before handler effects, with literal zero row changes, and no legacy fallback.
- All tests use committed literal expected tags, responses, rows and controls; none reads spec Markdown or derives expectations from production schemas, catalog data or implementation at runtime.
- e2e (`apps/app/e2e/real/members.spec.ts`, new): C-J1-05 runs `/members` through the production dispatcher, `CardRenderers`, `MembersCard` and `MembersView`, including keyboard Add, Role and Remove, LAN-origin sign-in, refused access and reconnect after backend downtime; reconnect keeps the last roster until a fresh read.

## Acceptance
- [C-J1-04](../checks/C-J1-04.md): first-merge journey regression with Members dark; roster activation does not gate that journey.
- [C-J1-05](../checks/C-J1-05.md): add by username, "needs access on GitHub" for a person without write access, and a teammate signs in from the install's origin and appears on the card.
- [C-UI-13](../checks/C-UI-13.md): `MembersView` is reachable from `CardRenderers`; no legacy members card exists to delete.

## Risks and notes
- Member commands run install-shipped host code only. They import or execute no repository module, hook or shell command; repository code runs only in machines (M-29). This ticket adds no root step and consumes no root-step inputs. Removal calls T-ACC-02's revoker without changing its machine-side root protocol; do not pass login strings or repository files to a root command. smithers-3f reviews this boundary and the revocation contract. The production-route integration tests prove no machine launch or shell execution on Add, Role or Remove.
- Will decides role and owner policy changes. smithers-b8 approves dispatcher, route and CLI seams; smithers-06 approves View props and confirmation behavior; smithers-38 approves RPC schema and public-API changes under §21.1; smithers-3f approves authorization, live publication and revocation seams. No ADR is introduced.

## Ready checklist
1. Dependencies: the S1 roster/revoker, authorizer, conversation mount, actor adapter, catalog/dispatcher, View and live channel are named in Depends on; Scope keeps unavailable integrations dark and fails closed until joint checks pass.
2. Exclusions: Out names access/recheck/seeding/revocation implementation, Take over, connect/LAN discovery, owner transfer, invitations, organizations, GitHub permission writes and delegated mutations; Changes excludes duplicate tables, models, Containers and live clients.
3. Tests: integration uses the production dispatcher and composed `/api/members` routes; C-J1-05 uses the mounted card and real sign-in; C-UI-13 proves reachability; expectations are committed literals, never runtime spec or implementation output.
4. Decisions: Will owns role/owner policy; smithers-b8 owns command/API seams, smithers-06 the View seam, smithers-38 RPC public exports and smithers-3f backend/security contracts; §21.1 sign-off applies before landing.
5. Owner pre-review: smithers-b8: Does `/members` and every row action use the shared dispatcher without fallback? Does the CLI only open the person card? smithers-06: Do supplied actions preserve read-only and immutable-owner controls? Where does the person confirm Remove before dispatch? smithers-38: Does the wire kind reuse MembersCard and shared action/role types? Does the export diff meet §21.1? smithers-3f: Are role/scope checks ordered before delegated refusal? Are post-commit roster notices and 5 s revocation preserved? Can missing providers expose roster data or effects? These are the recorded pre-review questions; under Will's parallel-build directive owners review post hoc without blocking Ready.
6. Security: install-shipped code only; M-29 forbids repository execution on the host. No new root step or root input exists; the existing revoker's root protocol stays with T-ACC-02. smithers-3f reviews this boundary; production-route tests assert no shell or machine launch and no effects on refusal.
