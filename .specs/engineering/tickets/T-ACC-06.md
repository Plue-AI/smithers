# T-ACC-06 Revocation on removal or suspension within 5 s

Stage S1 · Size S · Depends on T-ACC-02, T-STK-01 · Unblocks T-APP-02, T-APP-23, T-REL-02 · Issue: [#3495](https://github.com/smithersai/smithers/issues/3495)
Spec: spec.md §5.6, §5.1.3, §8.11.1, §15.1.4, §17.2 · Delta: delta.md §2 (Modify: member removal publishes `collaborator_removed`; deletes sessions, PATs, SSH grants) · Product: mvp.md §6.15 "Members and maintainers" (removal ends sessions, terminals, SSH), M-05

## Goal
Within 5 s of a member's removal or suspension, the person has no live access: sessions, delegated credentials, SSH grants, open sockets, terminals and SSH sessions are all gone. Their TODOs keep their history.

## Scope
In (backend paths are under `packages/backend/internal/` unless shown in full):
- One `RevokeMember(member, reason)` path, called by `Remove` and by suspension (T-ACC-02). In one transaction it:
  - sets `removed_at` or `suspended_at`;
  - deletes `auth_sessions` rows;
  - revokes the member's `delegated` tokens, including the app agent's per-session `via=smithers` bearers (§15.1.4) and stage-1 terminal tokens (§8.11.1);
  - revokes workspace SSH grants;
  - then publishes on the existing revocation bus.
- Bus consumers close every live stream the member holds:
  - workspace and terminal sockets;
  - SSE streams;
  - SSH sessions in the registry;
  - `/api/live` sockets (T-COL-02's hub).
- TODO takeover: a maintainer changes `todos.owner_id`. The change is audited and appended to `todo_events` with the actor (§5.6).

Out:
- SSH gateway sessions on `:2222` (T-TRM-03, S2). They're registry sessions, so they inherit the consumer; C-ACC-03 is re-run when T-TRM-03 lands.
- Unix-user teardown on machines (T-MCH-11).
- Restoring access on unsuspension. The person signs in again; nothing is restored.

## Changes
- `packages/backend/internal/services/members.go`: `RevokeMember`.
  - Uses `DeleteUserSessions` (`internal/db/auth.sql.go:620`) and token revocation by `user_id AND kind='delegated'`, publishing `KindTokenRevoked` per token (`revocation/event.go:38`).
  - Also uses grant revocation (`revocation/access_grants.go:20`) and `KindCollaboratorRemoved` with the member's live `SandboxIDs` (pattern in `services/revocation_publishers.go:157-170`).
- Verify each consumer closes within the budget:
  - `routes/workspace_socket_revocation.go:113` (terminal and workspace sockets);
  - `ssh/revocation.go:21` (SSH registry);
  - `middleware/sse_ticket.go` streams.
  - Add the `/api/live` hub as a bus consumer.
- `run`-kind tokens from runs the member started aren't revoked. The run belongs to the TODO, which keeps its history (§5.6).
- Takeover:
  - `PATCH /api/todos/{n}` gains `owner` (owner or maintainer, `Authorize(todo.write)` plus a role check);
  - the change writes `todo_events{kind: "owner_changed"}` and an audit row through `actor.FromRequest`.
- OpenAPI: document `owner` on the TODO patch, in whichever file T-STK-01 adds for `/api/todos`.

## Tests
- Integration, real PostgreSQL: `compose/member_revocation_integration_test.go` (new). The member holds:
  - a browser session;
  - two delegated tokens;
  - an open terminal socket on a workspace;
  - an SSE ticket stream;
  - a workspace SSH session through the existing SSH library (`ssh/workspace_session_test.go` harness);
  - an `/api/live` socket.

  Remove the member and assert each is closed or refused within 5 s of the `DELETE` response. Measure with a monotonic clock and repeat 20 times; the maximum is the result.
- The same integration covers suspension from T-ACC-02's recheck, with an injected clock.
- Integration: after removal, the member's TODOs still list their events, and a maintainer takes one over. A Member's takeover attempt gets `permission`.
- Unit: `RevokeMember` is idempotent. A second call publishes nothing new and returns success.

## Acceptance

- [C-J1-04](../checks/C-J1-04.md): S1 part at its named layer.


- [C-APP-01](../checks/C-APP-01.md): `todo.takeover` is maintainer-only and person-only.

- [C-ACC-03](../checks/C-ACC-03.md): removal revokes every credential and stream within 5 s; suspension does the same after the hourly check.

## Risks and notes
- Resolved: Appendix B.4 `todo.takeover` is the door; T-APP-02 puts Take over on the TODO card (C-APP-01).
- Bus delivery is asynchronous. If a consumer is slow under load, the 5 s budget fails. That shows up as a maximum over 5 s in the 20-run sample. Revocation metrics exist (`revocation/bus_metrics.go`); record them in the evidence.
- `auth_sessions` deletion and bus publish must commit before the HTTP response. Otherwise a racing request on an old session can slip through. The integration test issues a request on the old cookie immediately after the response and must get `401`.
