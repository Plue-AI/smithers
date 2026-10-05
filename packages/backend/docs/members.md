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
| read, triage, none | refused, `403 needs_github_access` | none |

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

| Command | Least role |
| --- | --- |
| `todo.read`, `todo.new`, `todo.answer`, `todo.steer` | Member |
| `merge` | Maintainer |
| `members.list` | Member |
| `members.write` | Maintainer |

The HTTP boundary admits a non-owner only on the routes in
`middleware.InstallMemberCommand`'s table; every other route stays the owner's,
so a new route ships closed to members. Git HTTP, SSE tickets and app agent
turns stay owner-only for members.

## Removal

`DELETE /api/members/{login}` runs one transaction: the roster row goes, the
person's sessions, tokens, OAuth grants and workspace sessions are deleted,
sign-in is barred, and one durable `collaborator_removed` revocation event is
written. Live connections close on its fanout; the bus catches up within 1 s.
Adding the person again lifts the sign-in bar; old credentials stay revoked.
