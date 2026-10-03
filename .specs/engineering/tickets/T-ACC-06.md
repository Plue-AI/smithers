# T-ACC-06 Revocation on removal or suspension within 5 s

Stage S1 · Size S · Depends on T-ACC-02, T-ACC-03, T-STK-01, T-ACC-04, T-COL-02, T-INS-02 · Unblocks T-APP-02, T-APP-04, T-APP-06, T-APP-23, T-REL-02, T-TRM-02 · Issue: [#3495](https://github.com/smithersai/smithers/issues/3495)
Spec: spec.md §5.6, §5.1.3, §8.11.1, §15.1.4, §17.2 · Delta: delta.md §2 (Modify: member removal publishes `collaborator_removed`; deletes sessions, PATs, SSH grants) · Product: mvp.md §6.15 "Members and maintainers" (removal ends sessions, terminals, SSH), M-05

## Goal
Within 5 s of a member's removal or suspension, the person has no live access: sessions, delegated credentials, member-bound run credentials, SSH grants, sockets, terminals and SSH sessions are all gone. Their TODOs keep their history.

## Scope
Approved integration requirements (In):
- Every person-owned TODO run records the sponsoring member with its credential at minting. Run authorization checks that member's current active state without assigning the run a person role or person-command authority. Suspension or removal denies subsequent run calls immediately with HTTP 401, class `permission`, code `unauthenticated`; persistent token revocation completes within the same 5 s as the member's other credentials. Revoke all active run credentials bound to that member, including tokens minted before a later TODO ownership change. In-flight writes follow §5.2.1's state/fence ordering. Stop the affected execution from issuing further authenticated effects; retained TODO/run history is not permission to continue. Takeover by a maintainer does not reactivate a revoked token, and resumed execution mints a fresh credential bound to the new sponsoring member. Clearing suspension does not resurrect revoked credentials. Machine credentials remain separately workspace-scoped and gain no authority to continue a revoked member's run. Checks: C-ACC-01, C-ACC-03.
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
- TODO takeover: an owner or maintainer’s session invokes `todo.takeover` through `POST /api/todos/{n}/takeover`, changing `todos.owner_id`. A delegated credential gets 403 `never`; a Member gets 403 `permission`. The change is audited and appended to `todo_events` with the actor (§5.6, C-APP-01).
- Define the revocation consumer seam for T-APP-23: cancel queued turns and abort the running turn/model stream within 5 s, with no later write. The real runner wires and proves this before it enables host turns (C-UI-06); this ticket must not depend on that downstream runner.

Out:
- SSH gateway sessions on `:2222` (T-TRM-03, S2). They're registry sessions, so they inherit the consumer; C-ACC-03 is re-run when T-TRM-03 lands.
- Unix-user teardown on machines (T-MCH-11), new SSH gateways, app-agent runner implementation (T-APP-23), deferred credential-store implementation (product §16), deletion of TODO history.
- Restoring access on unsuspension. The person signs in again; nothing is restored.

## Changes
- `packages/backend/internal/services/members.go`: `RevokeMember`.
  - Uses `DeleteUserSessions` (`internal/db/auth.sql.go:620`) and token revocation by member for delegated tokens and stored sponsoring member for run tokens, publishing `KindTokenRevoked` per token (`revocation/event.go:38`).
  - Also uses grant revocation (`revocation/access_grants.go:20`) and `KindCollaboratorRemoved` with the member's live `SandboxIDs` (pattern in `services/revocation_publishers.go:157-170`).
- Verify each consumer closes within the budget:
  - `routes/workspace_socket_revocation.go:113` (terminal and workspace sockets);
  - `ssh/revocation.go:21` (SSH registry);
  - SSE stream lifecycle consumers identified through their revocation subscriptions; `middleware/sse_ticket.go` authenticates tickets but does not itself close an established stream.
  - Add the `/api/live` hub as a bus consumer.
- Revoke all run credentials bound to the member within 5 s, including pre-transfer tokens. Next authorization immediately refuses non-active sponsors with 401 permission/unauthenticated. TODO history survives; takeover/resume mints a fresh sponsor-bound credential. Restoration never revives old tokens. Check: C-ACC-03.
- Takeover:
  - `POST /api/todos/{n}/takeover` maps to the person-only `todo.takeover` descriptor and calls `Authorize` before changing the owner; a generic `todo.write` or owner PATCH is not this door;
  - the change writes `todo_events{kind: "owner_changed"}` and an audit row through `actor.FromRequest`.
- OpenAPI: document `POST /api/todos/{n}/takeover` and its person-only refusals in the TODO file T-STK-01 adds.

## Tests
- Boundary: `compose/member_revocation_integration_test.go` uses the production install router for `DELETE /api/members/{id}`, the actual hourly/reactive recheck job for suspension and `POST /api/todos/{n}/takeover` for takeover. Establish terminal/SSE/SSH/live connections through their real served transports, not direct bus injection. Use committed literal credential refusals, event fields and the 5 s limit; no runtime spec or implementation oracle. Record commit-to-close and DELETE-response-to-close times; an old credential is refused immediately after DELETE returns. Include a delegated takeover attempt and assert no owner change.
- Security: with T-INS-02’s real microVM path, start a terminal command and a lingering child in the guest. Removal must end the member’s session processes within 5 s, not just close the socket; run no repository command on the host. S2’s broker `kill_sessions` is an integration gate of T-TRM-07; rerun C-ACC-03 then.
- - Run sponsor fixtures cover suspended, removed and restored members, own/other tokens and pre-TODO-transfer tokens. Next call=401 immediately, physical revocation ≤5 s. Takeover preserves history; resumed execution mints a fresh sponsor-bound credential; restoration never revives old tokens. Check: C-ACC-03.

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
- Decisions before start: smithers-3f approves commit/publication ordering, guest process termination and consumer seams; smithers-b8 approves members/takeover API outcomes; smithers-38 approves cross-library revocation contracts. smithers-8a accepts downstream runner/daemon integration responsibilities. Will decides any change to the 5 s budget or person-only takeover policy.
- Security precondition: T-INS-02’s working microVM isolation and T-ACC-04’s stored delegated kinds must land. Revocation signals are packaged host code; any terminal test or member repository process executes only in a machine (§1.3, M-29). The S1 implementation must verify guest processes end. S2 consumers must wait for `kill_sessions` completion and remove seeded credentials; socket closure alone never proves full §5.6. smithers-3f reviews these gates (C-ACC-03, C-SPK-08).
- Resolved: Appendix B.4 `todo.takeover` is the door; T-APP-02 puts Take over on the TODO card (C-APP-01).
- Bus delivery is asynchronous. If a consumer is slow under load, the 5 s budget fails. That shows up as a maximum over 5 s in the 20-run sample. Revocation metrics exist (`revocation/bus_metrics.go`); record them in the evidence.
- `auth_sessions` deletion and bus publish must commit before the HTTP response. Otherwise a racing request on an old session can slip through. The integration test issues a request on the old cookie immediately after the response and must get `401`.

## Ready checklist
1. Dependencies: T-ACC-02 membership/recheck, T-STK-01 TODO history/projections, T-ACC-04 stored delegated kinds, T-COL-02 real live hub and T-INS-02 isolated terminal execution. APP-23 and S2 consumers are downstream integration gates, not back-edges.
2. Exclusions: gateway creation, unix-user teardown, runner implementation and the deferred credential store, history deletion and access restoration are explicit.
3. Tests: C-ACC-03 drives real DELETE/recheck/transports; takeover uses its production person-only route. Fixed refusals and timing limits cover immediate denial and guest child termination; full downstream gates remain pending until their consumers land.
4. Decisions: smithers-3f backend/process semantics, smithers-b8 public API, smithers-38 library seam, smithers-8a downstream responsibilities; Will decides budget/policy exceptions.
5. Owner pre-review before start: smithers-3f: Does revocation commit before response and revoke member-bound run tokens and guest processes within 5 s? Are late runner/daemon consumers required to wire the same event? smithers-b8: Is takeover person-only through its own route? smithers-38: Is one revocation contract shared across stream libraries?
6. Security: §1.3/M-29 and T-INS-02 confine repository commands to machines; guest processes must end, not only sockets. smithers-3f reviews C-ACC-03/C-SPK-08 and the S2 kill_sessions/credential-removal gates.
