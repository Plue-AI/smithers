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
| `todo.read`, `todo.new`, `todo.answer` | Member | `GET /api/todos`, `GET /api/todos/{n}`, `POST /api/todos`, `POST /api/todos/{n}/answer` |
| `todo.steer`, `todo.stop`, `todo.resume`, `todo.retry`, `todo.drop` | Member | `POST /api/todos/{n}` (by `op`) |
| `merge` | Maintainer | `POST /api/todos/{n}/merge` |
| `members.list` | Member | `GET /api/members` |
| `members.write` | Maintainer | `POST /api/members`, `PATCH`, `DELETE /api/members/{login}` |
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

`POST /api/todos/{n}` is mounted and authorized by role, and the TODO service
still answers every control `503 todo_control_unavailable` until a steer can
reach a running attempt (T-FLW-11, T-STK-01).

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
