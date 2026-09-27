# Lane `citc` — REPORT

> Superseded 2026-09-27 (smithersai/smithers#2229): the terminal and harness tabs, the `+` menu, `tab.terminal`, `tab.harness`, `tab.read`, `tab.menu`, `tab.close.confirm/cancel`, the `pty.*` transitions and the harness inventory are gone. Tabs are card tabs (`tab.card`, `tab.select`, `tab.close`); a terminal is the workspace card's Terminal facet. The text below is the record of the lane as it ran.

Brief: `citc.md`. ADR: `../decisions/0002-citc-sandbox-kinds.md`. Status: all
six steps shipped and green; the lane's gates pass, and the only failures in
the tree are the three pre-existing TargetGraph integration tests plus two
`runs.rerun` tests from a concurrent runs-lane commit (below).

## What shipped, per step

## Decisions worth knowing

- **`cloudWorkspaces` is the authority, `workingCopies` the projection.**
  The name `workspaces` was taken (the frame-graph collection), so the new
  collection is `app-cloud-workspaces`; copy rows derive from it in the
  same dispatch transaction, so the tree and the card never disagree.
- **Acts never invent a status.** Suspend/resume trust the act's returned
  DTO; when plue answers without one, the seam re-reads the workspace, and
  failing that refreshes the repo list — never an assumed `suspended`.
- **A deleted workspace's card leaves the transcript** (`card.removed`):
  any status it could show afterward would be a lie; the delete itself is
  journaled.
- **A destroyed session detaches the card** that pointed at it
  (`terminalSessionId` cleared), so the facet re-offers Open rather than
  claiming a dead attachment.
- **The watch polls, it does not stream.** plue's SSE route is not proxied
  yet; the brief allowed poll. pollMs is injectable (tests run it at 1ms).
- **Bun's WS client carries the upstream subprotocol as a header.** Its
  options form takes `headers` but not `protocols`;
  `sec-websocket-protocol: terminal` goes in as a plain header (verified
  against a live double).

## Gates

- `pnpm exec tsc --noEmit` (apps/app, packages/rpc, packages/smithers/ui) — clean.
- `bun test src` (apps/app) — 1362 pass; 5 fail: the 3 pre-existing
  `src/bun/TargetGraph.integration.test.ts` failures (the `~/artsy/force`
  fixture, failing on a clean checkout) and 2 `runs.rerun` tests broken by
  the concurrent runs-lane commit `75ed77754c` ("runs.rerun refuses a run
  that is not settled"), which changed `controller/runs.ts` without
  updating `Runs.test.ts` — not this lane's files, left for that lane.
- `bun test` (packages/rpc) — 123 pass; (apps/server) — 402 pass;
  (packages/smithers/ui) — 1262 pass.
- T1 `e2e/playwright/citc.spec.ts` — 2 pass: open → card → starting→running
  stream → snapshots facet → tree row; degraded refusal with the exact
  wording in the toast.

## Follow-ups (not this lane)

- `plue#446` (kind, uptime, workspace head, ahead/behind): the card and the
  collection carry none; when the DTO grows them, the payload schema and
  the header line grow with it.
- `plue#449` (workspace file/service routes): Files and Services facets
  render the ADR's empty wording; the `service-log` payload already waits
  in the shared schema, and `box.services`/`workspace.logs` register
  when the routes exist.
- The Desktop facet waits on plue Phase B (WORKBENCH-UX §3.1 status note).
- plue's SSE status route could replace the settle watch's poll when it is
  proxied.
- The 2 `runs.rerun` test failures belong to the runs lane (commit
  `75ed77754c`); its tests were not updated with the behavior change.

## Review (Kimi K3, read-only, 2026-09-02) and what changed

Open from the same review: (4) a scope replace drops workspaces whose wire rows fail to parse (and their tree rows); (7) the seam test harness never asserts request bodies, so `source_bookmark`, `snapshot_id`, fork `name` are unverified; (10) fork/open acts refuse a malformed answer without refreshing the list, unlike suspend/resume.

Workspace lifecycle follow-up (2026-09-09): review item (6) is fixed.
Disposal invalidates both actor bindings, aborts workspace reads, and settles
pending retry sleeps as cancelled. Deleted workspaces invalidate watchers,
desktop retries, and terminal opens, including session settling and attachment.
Every watcher continuation checks its lifetime and authorization before
updating state or scheduling another poll. Terminal opens check authorization,
workspace existence, and supersession after each await before attaching.
Deferred-response and cancellation tests live in `WorkspaceSeam.test.ts`.

## Critique fixes (2026-09-02)

Six adversarially verified findings (scratchpad `citc-critique.json`), fixed in
order. Every fix has a regression test that was run red against the pre-fix
file (extracted from `HEAD` into a transient copy) and green against the fix.

1. **Zombie tunnel socket after the last detach** (`CloudTerminalClient.ts`).
   Fix: `scheduleReconnect` returns when `listeners.size === 0`; the detach
   nulls the closing socket's `onclose` before `close()` (a CONNECTING socket's
   abort surfaces as 1006, which used to redial an entry already forgotten);
   every opened socket sits in a client-wide `sockets` set that `dispose`
   drains, attached or not. Tests (`CloudTerminalClient.test.ts`): "detaching
   the last attachment closes the socket for good: no redial, nothing left for
   dispose", "detaching while the socket is still connecting aborts it and
   never redials (the abort reads as 1006)" (red before: a live orphan the
   server still held), "a drop the server forces while nobody listens never
   redials either", "dispose closes every socket, attached or reconnecting".
2. **A refused upstream redialed at 1 Hz forever** (tunnel + client + tabs).
   Tunnel (`src/bun/server.ts`): a close before the upstream handshake
   completed is a refusal, translated to 4401/4403/4404/4409 (409 and plue's
   425 "still provisioning")/4429, 1011 only when unknown. Bun 1.4.0's
   WebSocket client hides the HTTP status of a refused upgrade (every non-101
   answer closes 1002 "Expected 101 status code"; scratch probe
   `bun-ws-refusal.ts`), so the tunnel re-reads the same route with one plain
   GET, same bearer and Origin policy; plue runs every pre-upgrade check
   (auth, scope, repo permission, open-rate limit, session lookup and state,
   active cap) before `websocket.Accept`, so the GET answers the status the
   handshake got, at the cost of one request per refusal. An upstream that
   drops after the handshake is relayed as its own code, or `terminate()` for
   1005/1006 (which cannot be sent). Client: 1000/1008/44xx are final with the
   reason shown; 1011 retries once (the retry is re-earned only after a 30 s
   healthy open, since plue's 1011 lands right after the 101); 1001/1006
   reconnect with a 1 s backoff doubling to 30 s, under a client-wide budget
   of 8 reconnect dials per rolling minute across every session (plue admits
   20 terminal opens per user per minute). Tabs: new transitions
   `workspace.session.destroyed` (closes the session's tab and clears the
   card's `terminalSessionId` in one transaction) and `workspace.deleted`
   (card, collection row, tree copy, and terminal tabs in one transaction);
   the `workspaces.loaded` reducer closes the tabs of the workspaces it
   dropped; `closeTabRows` is the one strip-removal helper `tab.closed` now
   uses too. Tests: `CloudWsTunnel.test.ts` "an upstream %i closes the
   renderer with %i after exactly one re-read, never a redial" (401→4401,
   403→4403, 404→4404, 409→4409, 425→4409, 429→4429, 500→1011; the record
   shows exactly the upgrade and one bearer-carrying re-read), "an upstream
   that drops after the handshake ends the renderer's socket";
   `CloudTerminalClient.test.ts` "close %i is final: no redial, the listener
   hears why" (seven codes), "1011 retries once, then is final", "1001
   reconnects with a doubling backoff capped at maxReconnectMs" (17 dials
   before, ≤ 7 after), "reconnect dials across every session stay under the
   per-minute budget" (68 before, 4 after); `WorkspaceSeam.test.ts` "a scope
   replace closes the terminal tabs of the workspaces it dropped", "destroy
   session detaches the card that pointed at it and closes its tab in the
   same transaction" (the harness snapshots the store after each dispatch),
   "delete with the name removes the card, the row, the copy, and the
   terminal tab together, then refreshes the list".
3. **Per-user list parsed to zero rows and scope-replaced everything away**
   (`WorkspaceSeam.ts`). Fix: `parseUserWorkspaceWire` reads plue's
   `UserWorkspaceRow` (`workspace_id`, `repository_owner`/`repository_name`,
   `workspace_title`, `state`) beside the DTO parser; a per-user row keeps the
   bookmark, stage, and suspension time the collection already holds (the
   switcher row carries none), dropping a stage or suspension time the new
   status has left behind. Both list routes request `?limit=100` and follow
   the `Link` header's `rel="next"` until exhausted (`X-Total-Count` is a
   second stop, 50 pages the ceiling); plue writes those links in the legacy
   `page`/`per_page` form and the per-user route's own parser reads only
   `cursor`/`limit` (`routes/workspace.go parseUserWorkspacesPagination`), so
   the seam re-issues a next page as the offset cursor `(page − 1) × per_page`,
   which both routes accept — a plue defect worth filing (its per-user
   pagination links are unfollowable as written). A next link that leaves the
   route is not followed. A non-empty body that parsed to zero rows is an
   honest error and the loaded rows stay. `arrayOf` also accepts plue's
   `{ items, next_cursor }` cursor envelope, which the bookmarks route
   answers (the bookmark head was silently null against real plue). Doubles
   rewritten to plue's shapes: `WorkspaceSeam.test.ts` (`USER_ROW`, bare
   arrays, the cursor envelope, a harness that keys on the path and records
   the query) and `e2e/playwright/citc.spec.ts` (bare arrays, regex routes
   that admit `?limit=100`, the bookmarks envelope). Tests: "box.list
   parses plue's per-user rows, asks for 100 a page, syncs the tree copies,
   and announces", "a per-user row keeps the bookmark the collection already
   knows; a status that moved on drops its stage", "a non-empty list Smithers
   cannot read is an error, and the loaded rows stay", "an empty list is a
   fact: the scope empties", "both list routes follow the Link header's next
   page until it is exhausted" (130 per-user rows, 101 per-repo rows, two
   requests each), "a next link that leaves the route is not followed".
4. **Sign-out left bridges running; a signed-out tunnel dialed plue with no
   bearer** (`server.ts`, reducer, seam). Fix: the tunnel answers 401
   `cloud_sign_in_required` before `bunServer.upgrade` when `cloudAuth.token()`
   is undefined and never dials; a `cloudBridges` registry of live bridged
   sockets is closed 4401 by the `/api/cloud-auth/sign-out` handler (and 1001
   on shutdown), each close releasing its upstream; the `cloud.session.loaded`
   reducer closes every workspace terminal tab in the same transaction as a
   `signed-out` record (the seam's sign-out mirror, and a boot that answers
   signed out); the settle watch stops when the session is not signed in.
   Tests: `CloudWsTunnel.test.ts` "signed out, the tunnel answers 401 and
   never dials plue", "sign-out closes every live bridge, upstream included";
   `WorkspaceSeam.test.ts` "a signed-out session record closes the workspace
   terminal tabs and only those", "the watch stops when the cloud session
   signs out".
5. **The typed-name delete gate lived only in card chrome** (`Flows.ts`,
   `SlashPayload.ts`, `WorkspaceSeam.ts`, `WorkspaceCard.tsx`). Fix: the flow's
   input is `{ workspaceId, confirmName }`, both required (`args:
   "<workspaceId> <name>"`); the slash parser refuses a missing name; the seam
   refuses before any request unless `confirmName` equals the workspace's
   name, whoever invoked; the card sends `${workspaceId} ${deleteDraft}`; the
   flow keeps `confirm` for agent invocations. Tests: `WorkspaceSeam.test.ts`
   "delete refuses unless the workspace's name is typed back, and never calls
   plue for a mismatch" ("", a prefix, a case change, the id), `WorkspaceCard.
   test.tsx` "the delete act asks for the workspace's name typed back" (args
   `ws-1 review`).
6. **open/view's final render overwrote a status the watch had settled**
   (`WorkspaceSeam.ts`). Fix: `renderWorkspace` reads name, repo, bookmark,
   status, provisioning stage, and suspension time from the collection row
   when it exists — every act dispatches its DTO before it renders, so the
   collection is never older than the act's answer, and a poll that landed
   during the auxiliaries wins. Tests: "a poll that settles before the
   auxiliaries load wins: card, tree, and collection agree and no watch
   remains" (aux routes delayed 30 ms, GET answers running: before, card
   `pending` against a `running` row and tree), "view renders the collection's
   status when a poll advanced it during the auxiliaries"; the open test now
   asserts the card equals the collection instead of pinning `pending`.

Also: the tab-close question for a workspace terminal reads "This tab
detaches from the workspace session; the session keeps running in the cloud
workspace." (`TabBodies.tsx`); the settle watch stops on sign-out (above);
per the coordinator (plue#475 deployed), the tunnel sends an upstream Origin
ONLY when `SMITHERS_CLOUD_WS_ORIGIN` is set — the `https://jjhub.tech`
default is gone — with the same policy on the refusal re-read (tests "bridges
frames both ways … and no Origin by default", "SMITHERS_CLOUD_WS_ORIGIN is the
only source of an upstream Origin").

Gates: `pnpm exec tsc --noEmit` clean. `bun test src` — 1437 pass, 5 fail:
the 3 pre-existing `TargetGraph.integration.test.ts` failures plus 2 from the
concurrent change lane's in-flight `Composer.tsx` edit (`ComposerLayout.test.
tsx` repo-chip copy and `parity.test.ts` Composer handler count 10 → 11),
files this lane does not touch. `bun test` — packages/rpc 130 pass, apps/server
402 pass. The same change lane applied the identical `WorkspaceCard.tsx` edit
and an optional-`confirmName` flow in parallel; the flow and parser were
tightened to required here.
T1 `e2e/playwright/citc.spec.ts` against the rewritten doubles — 2 passed.
A final `tsc` run showed one error in `ComposerLayout.test.tsx` ("Cannot find
name 'host'"), the change lane's edit in progress at that minute (95 changed
lines, not this lane's file); the run before it was clean with every citc
change in place.

