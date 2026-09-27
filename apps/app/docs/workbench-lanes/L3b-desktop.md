# Lane L3b — Desktop workspaces (NixOS VM + GUI over VNC) on the workspace card (2026-09-02)

Source: plue-0c, 2026-09-02 ~21:00 PT: the workspace API delta (NixOS compute
path + desktop workspaces) lands on api.jjhub.tech within the hour. ADR 0002
(`docs/decisions/0002-citc-sandbox-kinds.md`) said Phase B transport was open;
this is the transport. WORKBENCH-UX §5 and §6 stay the UI contract. Laws:
apps/app/AGENTS.md (no useEffect, collections via dispatcher, every act a flow
with data-flow, NO INVENTION, errors verbatim, EMBED LAW: the desktop is a
facet of the workspace card in the chat; maximize by the user's act only).
Lane L3 (`L3-workspace-card.REPORT.md`) just landed the card's header fields
and the Files/Services/Egress facets; build on it, do not redo it.

## The API delta (plue's words, shapes to parse verbatim)

1. `kind` on `POST /api/repos/{o}/{r}/workspaces` and on every workspace
   object: `container` (legacy OCI image, default), `vm` (NixOS closure image,
   systemd PID 1), `desktop` (same plus XFCE streamed over VNC).
2. `environment` on every workspace: `{ source, revision, closure_hash, image }`.
   `image` is new: the registry reference the vm/desktop workspace booted;
   empty for container. Header shows `closure_hash` short (first 8) and the
   image TAG (the part after the last `:`), never the full registry path.
3. `desktop` object, present ONLY when kind = desktop: `{ stream_url, session }`.
   `stream_url` is a path relative to the API origin; `session` is
   `{ id, expires_at }` or null before the first mint.
4. New route `POST /api/repos/{o}/{r}/workspaces/{id}/desktop/session` (write
   scope; workspace must be `running`). 201 once with `{ workspace_id,
   stream_url, session { id, expires_at }, token, vnc_password }`; this
   `stream_url` is ABSOLUTE and already credentialed. Load it directly in
   `<iframe allow="clipboard-read; clipboard-write" sandbox="allow-scripts
   allow-same-origin allow-forms">`. Sessions last 12 h; POST again to rotate
   (changes the VNC password in the guest; the old iframe disconnects).
   NEVER persist `token` / `vnc_password` client-side beyond the iframe src:
   not in a collection, not in the transcript, not in a card payload that
   the persistence backend writes. 409 when not running, 400 when kind !=
   desktop; both read verbatim on the facet.
5. Relay path `/api/workspaces/{id}/desktop/{token}/*` is plue's; never
   build it; use the POST's `stream_url`.
6. Optional, low priority: `GET /api/repos/{o}/{r}/environment-images` rows
   `{ id, repository_id, kind, source, source_revision, closure_hash, image,
   status, golden_snapshot_id, created_at }`; `repository_id 0` = platform
   base image; empty `golden_snapshot_id` = first boot of that closure is a
   cold pull (20–40 s slower).

## UI

- **Kind on create.** ADR 0002: "three sandbox kinds share one option surface;
  the kind is the choice." `box.open [bookmark] [repo] [--kind
  container|vm|desktop]`; the card's create affordance offers the three kinds
  as three buttons with plue's one-line descriptions in words; default
  `container`. No environment or image picker (ADR 0002 default stands).
- **Kind label** already renders in the header (L3); `desktop` and `vm` add
  the provenance line `env · <closure_hash[0:8]> · <image tag>`; absent
  fields render nothing.
- **Desktop facet**, present only when `kind === "desktop"`:

```
│ Terminal  Files  Services  Egress  Desktop  History                        │
│ ┌──────────────────────────────────────────────────────────────────────┐   │
│ │                    <iframe: noVNC, autoconnect>                      │   │
│ │                                                                      │   │
│ └──────────────────────────────────────────────────────────────────────┘   │
│ session until 09:12 tomorrow · Rotate session · ⤢                          │
```

  Opening the facet runs `box.desktop <workspaceId>` (user + button;
  agent-invocable only through confirm, since it mints a credential): POSTs
  the session, holds the absolute `stream_url` in COMPONENT-LOCAL memory
  (a `useRef`/`useState` in the facet is acceptable here because the value
  must never enter the store; document why in a comment) and renders the
  iframe with exactly the `allow` and `sandbox` attributes above. `Rotate
  session` (`box.desktop.rotate`, confirm) POSTs again and swaps the
  src. The status line reads `session until <expires_at local>`; a 409 reads
  the server text plus a Resume button; a 400 reads the server text.
  Maximize gives the iframe the card's full height (the card's maximize
  rules in `cards.css`; the iframe is `width: 100%; height: 100%`).
  Closing the facet or the card drops the src (the iframe unmounts); no
  token survives in memory beyond the mounted facet.
- **Cross-origin isolation.** Both origins serve the SPA with
  `Cross-Origin-Embedder-Policy: require-corp` (Worker: `ISOLATION_HEADERS`
  in apps/server/src/index.ts; check apps/app/src/bun/server.ts for the local
  origin). Under require-corp a cross-origin iframe document is blocked
  unless plue's relay sends `Cross-Origin-Resource-Policy: cross-origin` on
  `vnc.html` and every asset. The orchestrator has asked plue for that; the
  lane adds a CSP/`frame-src` allowance for the API origin where either
  server sets one, and writes a test that the iframe element carries the
  exact attributes. Do not weaken COEP (OPFS SQLite needs it).
- **Environment images** (item 6): a `box.images [repo]` flow rendering
  a small listing card (kind, closure short, status, cold-pull note when
  `golden_snapshot_id` is empty). Last; skip if time is short and say so.

## Tests

Seam: parser for `kind`, `environment.image`, `desktop`; the session POST
(201 shape, 409, 400) with route doubles; a test that the session response is
never written to any collection or transcript row (assert the store after
the flow). Card: facet present only for desktop; iframe attributes exact;
status line; rotate swaps src; header provenance line present/absent; create
offers three kinds and passes `kind` in the POST body. Keep L3's 108 lane
tests green. Note in the REPORT that the routes were not observed live (the
roll was in progress) unless you can reach them read-only.

## Verification

`cd apps/app && bun x tsc --noEmit -p . && bun test src/mainview/cards/WorkspaceCard.test.tsx src/mainview/state/seams/WorkspaceSeam.test.ts`, then the full `bun test src` once (3 pre-existing TargetGraph fixture failures; `src/bun/Main.test.ts` times out under load, rerun it with `--timeout 30000` before calling it red). Do not launch, relaunch, or quit the app. Do not commit; do not run jj or git write commands. Write `L3b-desktop.REPORT.md`.

## Addendum (21:40): agent runs as workspaces (plue main 495e7269e604, RFD-004)

Same files, same lane. Parse and render, nothing invented:

1. `kind` gains `agent`: the computer an agent run executed in, listed under
   its `target_bookmark` beside human workspaces. Render the kind label
   `agent` and, when `agent_session_id` is present, a link/action `Open the
   agent session` (bind to the existing run/session card flow if one takes a
   session id; otherwise render the id as text and note it in the REPORT).
2. Agent-session DTO gains optional `workspace_id`: on the run card
   (`cards/RunsCards.tsx`, seam that reads agent sessions) add `Open the
   agent's computer` → `box.view <workspace_id>`; the workspace
   persists after the run (suspended; Resume like any workspace).
3. Workspace status stream `GET …/workspaces/{id}/stream` now also emits
   `{ status, head { change_id, commit_id }, ahead, behind }` on new heads.
   The stream consumer applies `head`/`ahead`/`behind` to the row when
   present; status-only events keep working. `head`/`ahead`/`behind` are now
   populated for every running workspace, so the header line from L3 renders
   live.
4. FYI only, no UI: repo-host ref `refs/smithers/workspaces/<id>/head`;
   `POST …/workspaces/{id}/head` is the guest reporter's.

Tests: parser for `kind: "agent"` + `agent_session_id`; run-card action iff
`workspace_id`; stream event with head updates the row, status-only event
leaves head untouched.
