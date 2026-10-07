---
title: "Members and roles"
description: "How a self-hosted install admits its owner, maintainers and members, and how one authorizer decides each command."
---

## Roster

An install's roster is the `collaborators` rows of its one repository. The
owner is the person who claimed the install (`self_host_owners`). A
maintainer adds a person by GitHub username with `POST /api/members`. The
person must hold write access to the repository on GitHub now; their role
seeds from GitHub's `role_name`:

| GitHub role | Roster permission | Role |
| --- | --- | --- |
| admin, maintain | `admin` | Maintainer |
| write | `write` | Member |
| read, triage, none | refused, `403 needs_github_access` (class `user`, `fix` is the repository's access settings) | none |

After that the Members card is authoritative: `PATCH /api/members/{login}`
changes the role and `DELETE /api/members/{login}` removes the person. The
owner's row never changes (`403 owner_immutable`). A row added before the
person signs in carries their GitHub id; their first GitHub sign-in links it
to their account.

## Sign-in

A GitHub sign-in on a claimed install is admitted only for the owner's own
GitHub account or an active roster row with the same GitHub id, and only
while GitHub reports write access. Anyone else gets `403 not_a_member` or
`403 needs_github_access`, with no session and no stored identity.

## One authorizer

`services.Authorize(ctx, queries, command)` decides every member command the
install serves. It reads the person's role from committed rows on every call,
so a removal refuses the very next request. Only a person's own browser
session carries person authority; tokens get `403 permission` until
delegated credentials land.

| Command | Least role | Routes |
| --- | --- | --- |
| `install.read` | Member | `GET /api/install` |
| `repo.read` | Member | `GET /api/user/repos`, `GET /api/repos/{o}/{r}/mythical`, `.../mythical/events`, `.../mythical/items/{ref}` |
| `sync.read`, `sync.retry` | Member | `GET`, `POST /api/github/sync` |
| `live` | Member | `GET /api/live` |
| `agent.turn` | Member | `POST /api/agent/turn`, `POST /api/agent/turn/cancel` |
| `issue.read` | Member | `GET /api/issues`, `GET /api/issues/{n}` |
| `todo.read`, `todo.new`, `todo.answer` | Member | `GET /api/todos`, `GET /api/todos/{n}`, `POST /api/todos`, `POST /api/todos/{n}/answer` |
| `todo.steer`, `todo.stop`, `todo.resume`, `todo.retry`, `todo.drop`, `stack.move` | Member | `POST /api/todos/{n}` (by `op`) |
| `todo.amend` | Member | `PATCH /api/todos/{n}` |
| `merge` | Maintainer | `POST /api/todos/{n}/merge` |
| `members.list` | Member | `GET /api/members` |
| `members.write` | Maintainer | `POST /api/members`, `PATCH`, `DELETE /api/members/{login}` |
| `external.read` (person-only) | Owner | `GET /api/external/sessions`, live topic `external:<agent>:<session>` |
| `secrets.write` (person-only) | Maintainer | `POST /api/repos/{o}/{r}/secrets`, `PATCH`, `DELETE /api/repos/{o}/{r}/secrets/{name}` |

A person-only command checks the role first, then the credential, and it
applies to the owner too. Only the person's own browser session acts. A
delegated credential, including a personal access token (spec §5.3.0), gets
`403 never` ("Only a person can do this"), with no confirmation path. A run,
machine or agent-account credential gets `403 permission`. An ineligible role
gets `403 permission` whatever the credential. Org secrets are not served on
an install.

The HTTP boundary admits a non-owner only on the routes in
`middleware.InstallMemberCommand`'s table; every other route stays the owner's,
so a new route ships closed to members. For a member's request the router then
authorizes the route's command through `services.Authorize`, so a member's
token is refused and a lower role gets `403 permission`. An app agent turn
answers a member as that member: each read it makes goes through the same
table, and the turn runs on the install's models (the owner's fast role or
default, which the owner pays for), never on a model the member's request
names. `GET /api/install` answers a member the install's state; only the
owner changes it. Git HTTP and SSE tickets stay owner-only for members.

The issue list card and the issue card read the install repository's GitHub
issues from `GET /api/issues` and `GET /api/issues/{n}` (the issue with its
comments). The install reads them through its GitHub App as the stack's actor,
so a member needs no GitHub credential that can read them. Each browser issue
read returns an `issue_digest` bound to that member's original issue and
discussion. Make TODO commits that snapshot after remote edits; unknown or
another member's digests return `409 issue_snapshot_unknown`. The editable
Draft stays in the browser. The run receives the admitted discussion as quoted
data attributed to each author, with no later comments. A Member makes a TODO
only from an issue whose author and last writers are active roster members
with live GitHub write access, or the install's App; an
outsider's issue answers `403 permission` ("Only a maintainer can make a TODO
from this issue"), and a maintainer's TODO from it is marked outsider.

Steer (`POST /api/todos/{n}` with `steer`) and Amend
(`PATCH /api/todos/{n}`) are mounted and authorized by role. Their execution
remains disabled with `503 todo_control_unavailable` pending ordered input
and pinned guest acceptance. A delegated terminal amendment returns
`503 confirmation_unavailable` before mutation. See
[TODO steering and amendments](./mythical_items.md) for the transaction and
delivery contract. Other controls use their own service and lifecycle checks.

## Removal

`DELETE /api/members/{login}` runs one transaction: the roster row goes, the
person's sessions, tokens, OAuth grants and workspace sessions are deleted,
sign-in is barred, and one durable `collaborator_removed` revocation event is
written. Live connections close on its fanout; the bus catches up within 1 s.
Adding the person again lifts the sign-in bar; old credentials stay revoked.

## Hourly recheck

Every hour (`services.Members.Recheck` on the worker's periodic cleaner) the
install asks GitHub for each member's permission. A member GitHub confirms
below write is suspended with the same revocation as removal; the Members
card shows them suspended. Write access again clears the suspension, and the
person signs in again. An installation failure or a failed lookup changes
nothing.

Rechecks resolve each stored numeric `github_id` with `GET /user/{id}` before
using its current login. A confirmed missing account suspends; renames update
`github_login`. A successful permission reply must carry a `user.id` equal to
the stored ID. A missing or mismatched reply ID leaves that member unchanged
for this sweep as a transient failure (§5.1.3), and refuses sign-in. A missing
roster ID also skips only that member. Add writes the ID before creating the
row; legacy repository collaborators may lack one, while owner rows are excluded.

Member-specific lookup or permission failures skip only that member, are logged
and counted in `MemberRecheckFailures`, and let confirmed members proceed.

After GitHub replies, applying the result locks the roster and re-reads the
original row's current account binding. A first sign-in during the lookup is
included in revocation; a removed or replaced row makes the old result a no-op.
Removal's sign-in bar and a newly added membership cannot be changed by that
old result.

A permission-endpoint 404 confirms member loss only after resolving the
expected account ID and proving that the same installation token lists the
repository's numeric GitHub ID. A confirmed missing account also suspends.
Installation-level 401/403/404 changes no member row and sets permission-stream
health to `refused` in the existing GitHub sync health projection. Transient or
malformed replies preserve state; a complete successful recheck clears the
refusal. Explicit read or none suspends even with a contradictory role name.
