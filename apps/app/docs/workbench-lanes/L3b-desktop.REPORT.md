# Lane L3b — REPORT (2026-09-02/03)

Brief: `L3b-desktop.md`, including its **Addendum (21:40): agent runs as
workspaces**. ADR: `../decisions/0002-citc-sandbox-kinds.md`. Prior state:
`L3-workspace-card.REPORT.md`.

Everything in the brief shipped, including the optional environment-images
listing, except **the run card's "Open the agent's computer"** (addendum item
2), because this app has no plue agent-session surface to hang it on — see
§"Not built".

## Files changed

| File | What |
| --- | --- |
| `apps/app/src/mainview/state/seams/DesktopStream.ts` | **New, 68 lines.** The one place a minted desktop credential lives: module memory with a `useSyncExternalStore` subscribe/read pair, plus `holdDesktopStream` / `dropDesktopStream`. Exactly one mint at a time; the acts that end a facet's life drop it. |
| `packages/rpc/src/Cards.ts` | `WorkspaceEnvironmentSchema` gained `image`; new `WorkspaceDesktopSchema` and `EnvironmentImageRowSchema`; the `workspace` payload gained `desktop`, `desktopRefusal`, `agentSessionId`, and `desktop` in its facet enum; new `environment-images` card kind. Every added field is nullable+optional, so a card persisted before this lane still parses. |
| `apps/app/src/mainview/state/AppState.ts` | `CloudWorkspaceRowSchema` gained `desktop` and `agentSessionId`; `CloudWorkspaceInput` picks both; the new shared schemas/types are re-exported. |
| `apps/app/src/mainview/state/seams/WorkspaceSeam.ts` | `parseEnvironment` reads `image`; new `parseDesktop`, `parseDesktopMint`, `parseEnvironmentImage`; `agent_session_id` on the DTO parser; `openWorkspace(bookmark, repo, kind)`; new acts `openDesktop`, `rotateDesktop`, `listEnvironmentImages`, `applyStatusEvent`; `setFacet` drops the credential when the facet leaves the desktop; `deleteWorkspace` and `dispose` drop it too; a refused create renders the server's words on the failed card that offered the kinds. |
| `apps/app/src/mainview/state/seams/WorkspaceSeam.test.ts` | 24 new tests (74 in the file). The harness now records request bodies and exposes the persistence backend's written bytes. |
| `apps/app/src/mainview/cards/WorkspaceCard.tsx` | The Desktop facet (`WorkspaceDesktopBody`), `environmentProvenance`, `sessionUntil`, `imageTag`, the three-kind create affordance, the agent-session line, the Desktop tab gated on `kind === "desktop"`, and `EnvironmentImagesCardBody`. |
| `apps/app/src/mainview/cards/WorkspaceCard.test.tsx` | 20 new tests (41 in the file); the existing Retry test became the three-kind create test. |
| `apps/app/src/mainview/flows/Flows.ts` | `box.open` takes `--kind`; `box.facet` accepts `desktop`; new `box.desktop` (confirm), `box.desktop.rotate` (confirm, hidden), `box.images`. |
| `apps/app/src/mainview/flows/SlashPayload.ts` | `box.open` parses `--kind` anywhere on the line and refuses an unknown one; parsers for the three new flows. |
| `apps/app/src/mainview/state/AppController.ts` | `openWorkspaceDesktop`, `rotateWorkspaceDesktop`, `listEnvironmentImages` on the interface and both action tables. |
| `apps/app/src/mainview/styles/cards.css` | `.workspace-desktop` / `.workspace-desktop-frame`, and the maximize rules that give the frame the card's full height (same shape as `.browser-card-frame` and `.html-card-frame`). |
| `apps/app/src/mainview/ChatCards.tsx` | **One additive line** (plus its import) mounting `EnvironmentImagesCardBody`. Outside this lane's owned list; a new card kind cannot render without it. |
| `apps/app/src/mainview/flows/registry.test.ts` | The three new flow names pinned. |
| `apps/app/src/mainview/flows/parity.test.ts` | `WorkspaceCard.tsx` handler count 15 → 17 (Rotate session, the 409's Resume). |

Not changed: `apps/app/src/bun/server.ts` and `apps/server/src/index.ts` — see
§"Cross-origin isolation". `APP_SCHEMA_VERSION` was not bumped: every new
field is nullable + optional.

## The credential guarantee

`POST …/workspaces/{id}/desktop/session` answers a `token`, a `vnc_password`,
and an ABSOLUTE `stream_url` that already carries both. **Nothing** from that
answer is dispatched. The seam parses only the URL, the session id and the
expiry, hands them to `holdDesktopStream`, and renders the card with
`facet: "desktop"` and nothing else. `token` and `vnc_password` are not even
read out of the body — the URL already carries them, and a second copy would
be a second place to leak from.

The facet reads the mint through `useSyncExternalStore` (React's own
external-store hook — no `useEffect`, no lifecycle synchronisation) and puts
it straight into the iframe's `src`. The mint is dropped when the facet leaves
the desktop (`box.facet <id> <other>`), when the workspace is deleted,
and when the seam is disposed.

**Deviation from the brief, stated plainly.** The brief allowed
"a `useRef`/`useState` in the facet". That cannot work here: the mint arrives
from an async flow, and `onRunCommand` returns `void`, so a component-local
`useState` has no way to learn the result without a `useEffect` or a change to
`ChatCards.tsx`'s prop contract. Module memory read through
`useSyncExternalStore` satisfies the actual requirement — the value never
enters a collection, a transcript row, or a persisted card payload — with the
same lifetime (one mint, dropped by the acts that unmount the facet) and no
lifecycle hook. `DesktopStream.ts` exists so that guarantee lives in one
auditable 68-line module rather than inside a 500-line card.

The proving test is
`the session answer never reaches a collection, a transcript row, or the
persisted bytes`: it serialises **every** collection in the store, the
transcript's messages, and the bytes the persistence backend actually wrote,
and asserts none contains the token, the VNC password, the credentialed URL,
or even the substring `vnc.html` — then asserts the holder *does* have the
URL, so the four negatives are not vacuous.

## Cross-origin isolation

**No CSP or `frame-src` exists on either origin, so none was added.** The
brief's instruction was conditional ("where either server sets one"), and the
condition does not hold:

- `apps/server/src/index.ts` sets `ISOLATION_HEADERS` (`COOP: same-origin`,
  `COEP: require-corp`) and no `Content-Security-Policy` anywhere.
- `apps/app/src/bun/server.ts` sets neither a CSP nor COEP/COOP on its HTML
  responses.

COEP was not weakened (OPFS SQLite needs it). The iframe-attribute test the
brief asked for is
`the iframe carries exactly the allow and sandbox attributes plue's relay
needs`, which pins `allow="clipboard-read; clipboard-write"` and
`sandbox="allow-scripts allow-same-origin allow-forms"` exactly.

**Mismatch for plue (found by probe, see below): the relay's error responses
send no `Cross-Origin-Resource-Policy`.** An anonymous
`GET https://api.jjhub.tech/api/workspaces/probe/desktop/probe-token/vnc.html`
answers `401 {"message":"invalid desktop session"}` with **no**
`Cross-Origin-Resource-Policy` header, with or without an `Origin`. Under the
Worker's `COEP: require-corp` that response is blocked by the browser, so an
expired or rotated-out session will show an empty frame instead of plue's own
words. The happy path could not be checked (no token), but the error path must
send CORP too.

## Routes: what was observed live, and what was not

The desktop roll (`smithers-api d5f613f9834b`) was announced live mid-lane.
**No repo-scoped route's shape was observed**, because no credential is
reachable from this session: `SMITHERS_CLOUD_TOKEN` and `SMITHERS_CLOUD_ADMIN_TOKEN` in the
environment both answer `401` on `GET /api/user/workspaces`, and the Bun
keychain PAT is not available here. Nothing was created and no session was
minted against production.

What the read-only probes *did* establish:

| Probe | Result | What it proves |
| --- | --- | --- |
| `GET /api/health` | `200 ok` | The API is up. |
| `GET /api/user/workspaces` (no auth) | `401` | Auth is the gate; the route exists. |
| `GET /api/user/workspaces` with `SMITHERS_CLOUD_TOKEN` / `SMITHERS_CLOUD_ADMIN_TOKEN` | `401` | No usable credential here. Fixtures below stay **unverified**. |
| `POST /api/repos/smithersai/smithers/workspaces/ws-probe/desktop/session` (no auth) | `404 {"message":"repository not found"}` | Indistinguishable from a missing route: the repo-context middleware answers before routing for an anonymous caller, and a deliberately bogus path under the same prefix answers identically. **No signal.** |
| `GET /api/repos/smithersai/smithers/environment-images` (no auth) | `404 {"message":"repository not found"}` | Same — no signal. |
| `GET /api/workspaces/{id}/desktop/{token}/vnc.html` (no auth) | `401 {"message":"invalid desktop session"}` | **The relay is deployed.** It is not repo-scoped, so it reaches its own handler, and that handler's words are plue's. |
| The same, with `Origin:` | no `Cross-Origin-Resource-Policy`, no `Access-Control-Allow-Origin` | The CORP mismatch above. |

The local `~/plue` checkout (`31957d42f`, 2026-09-02) predates the roll, so it
confirms only the parts that landed earlier:

| Contract | Local plue source | What shipped |
| --- | --- | --- |
| `kind` on `POST …/workspaces` | **Matches.** `createWorkspaceRequest.Kind` (`internal/routes/workspace.go:98`); `validateWorkspaceCreateMetadata` refuses anything but container/vm/desktop with `400 "kind must be container, vm, or desktop"`; `normalizeWorkspaceKind` defaults to `container`. | The create sends `kind` only when the caller named one, so plue's own default stands when nobody chose. The three-kind buttons always name one. |
| `kind` on the workspace object | **Matches.** `WorkspaceResponse.Kind` (`internal/services/workspace.go:166`). | Parsed onto the row; the header states it. |
| `environment.image` | **ABSENT** from `WorkspaceEnvironment` (`{Source, Revision, ClosureHash}`) in this checkout. | Parsed as `image`, nullable+optional, so a DTO without it is absence, not an empty reference. **Unverified against the deployed image.** |
| `desktop { stream_url, session }` | **ABSENT** from `WorkspaceResponse` in this checkout. | Parsed as `desktop`; absent reads as null. **Unverified.** |
| `POST …/workspaces/{id}/desktop/session` | **ABSENT** from `cmd/server/router.go` in this checkout. | Implemented from the brief's stated shape. **Unverified.** |
| `GET …/environment-images` | **ABSENT**; no `environment_images` table, no `golden_snapshot_id` column in this checkout. | Implemented from the brief's stated shape. **Unverified.** |
| The kind=desktop create 409 | Not in this checkout. | The coordinator's wording — `no NixOS environment image is registered for kind desktop` — is what the seam renders, because it renders plue's `message` verbatim and paraphrases nothing. Test: `a refused create reads the server's own words, verbatim, on the card that offered the kinds`. |
| `kind: "agent"` + `agent_session_id`, and the stream's `head`/`ahead`/`behind` (RFD-004) | Not in this checkout. | Parsed; `applyStatusEvent` applies stream heads. **Unverified.** |

Every fixture in `WorkspaceSeam.test.ts` for the routes marked unverified was
built from the brief's stated shapes, not from a wire capture. If plue's field
names differ, the parsers are the only place to change: nothing downstream
reads a raw wire key.

## Tests added

`src/mainview/state/seams/WorkspaceSeam.test.ts` (24 new, 74 in the file):

- the create carries the kind the caller chose
- a create that named no kind names none on the wire — plue's own default stands
- the DTO's desktop kind, its environment image and its relative stream path read onto the row and the card
- a container workspace carries no image and no desktop object — absence, never an empty one
- a desktop object plue answered with a session names the session it minted, and no credential
- the mint holds the credentialed stream for the facet and opens the facet on the card
- **the session answer never reaches a collection, a transcript row, or the persisted bytes**
- a 409 reads the server's own words and marks the workspace as not running
- a 400 reads the server's own words and offers no resume
- rotating mints again and swaps the held stream; the old one is gone
- leaving the Desktop facet drops the credential — nothing survives the unmounted facet
- deleting the workspace drops the credential too
- a signed-out session mints nothing, and a degraded one refuses with the enable wording
- a mint whose answer names no stream is malformed, not an empty desktop
- the listing names each image's kind, closure and status, and the cold-pull note when nothing is baked
- a repository with no images says so rather than rendering an empty list of nothing
- a refused listing is the server's own message, never an empty catalogue
- an agent workspace reads its kind and the session that drove it
- a workspace no agent drove names no session
- a stream event carrying a new head applies it to the row and the card
- a status-only event moves the status and leaves the head exactly as it was
- an event for a workspace nobody loaded, or one that names no status Smithers knows, changes nothing
- a refused create reads the server's own words, verbatim, on the card that offered the kinds
- a refused create touches no card of a workspace that did not offer one

`src/mainview/cards/WorkspaceCard.test.tsx` (20 new, 41 in the file):

- the create affordance offers the three kinds in plue's words and each carries its kind *(replaces L3's Retry test)*
- a workspace with no target bookmark re-opens on its repository alone
- the Desktop tab is offered only for a desktop workspace, and it mints through box.desktop
- **the iframe carries exactly the allow and sandbox attributes plue's relay needs**
- the status line says when the session lapses, and Rotate session rides its own flow
- a rotate swaps the src: the facet renders whatever the holder holds now
- a facet with nothing minted renders no frame at all
- another workspace's mint is not this card's — the holder is read by workspace id
- a 409 reads the server's own words and offers Resume
- a 400 reads the server's own words and offers nothing to press
- a desktop workspace names the closure short and the image tag
- a container workspace has no provenance line, whatever its environment says
- a vm that named only a closure says only the closure; one that named neither says nothing
- an image with no tag at all is not a tag — the registry path never renders
- the provenance line renders on a desktop card and not on a container one
- an agent workspace names its kind and the session that drove it
- a workspace no agent drove says nothing about a session
- a row names its kind, the closure short, the image tag and its status
- an image with nothing baked warns that its first boot is a cold pull, and the platform base says so
- a repository that has built nothing says so

Two of L3's assertions were updated rather than added: the live-DTO expectation
now names `image: null` (a container answers no image), and the failed-card
test became the three-kind create test.

## Design notes worth keeping

- **The kind is the choice, and only that.** The create sends `kind` when the
  caller named one and nothing when they did not, so plue's own default
  applies rather than the app asserting `container` on the human's behalf. No
  environment or image field is ever sent (ADR 0002's standing default).
- **The Desktop tab is the mint.** Selecting the facet through
  `box.facet` does NOT mint; the tab runs `box.desktop`, which
  carries `confirm`, so the model may ask for a desktop and only the human
  performs it. `box.desktop.rotate` is `confirm` and `hidden`.
- **`⤢` was not added.** The brief's ASCII shows a maximize glyph in the meta
  row; the card header already carries the app's maximize affordance
  (`onMaximize`, bound to `card.maximize` at the App.tsx binding site), and a
  second one would be an unrequested duplicate. What the lane added is the CSS
  that makes maximizing give the iframe the card's full height —
  `.smithers-card[data-maximized="true"] .workspace-desktop-frame { height: 100% }`,
  the same shape the browser and html panels already use.
- **`History` was not added.** The brief's ASCII strip shows it; no History
  facet exists on this card and the brief's prose does not specify one, so
  none was invented. The strip is Terminal / Files / Services / Snapshots /
  Egress / Desktop.
- **The 409's Resume is the workspace's Resume.** `box.resume` already
  exists and already carries `confirm`; the facet's button invokes it rather
  than a new act.
- **Test hygiene:** the card suite now unmounts every React root in `afterAll`.
  The Desktop facet SUBSCRIBES to the module-level holder, so a root left
  mounted kept listening into the next suite in the same bun process and
  re-rendered against an unregistered happy-dom window. This is the same
  guarantee the product relies on (unmounting the facet closes the
  subscription), so it is a fair thing to assert by construction.

## Not built, and why

- **Addendum item 2 — "Open the agent's computer" on the run card.** There is
  no plue agent-session surface in this app to put it on.
  `cards/RunsCards.tsx` renders the **Smithers gateway** run inbox
  (`runId`, `flowId`, turns/calls; acts `runs.open`, `runs.resume`,
  `runs.steer`, `approval.*`) — a different domain from a plue agent session.
  The `agent` card kind is a LOCAL harness in a PTY tab
  (`harnessId`, `tabId`, `cwd`). Grepping `agent_session` across
  `apps/app/src` and `packages/rpc/src` finds only
  `ChangeRevisionSchema.agentSessionId` and `EgressSeam`'s
  `agentSessionEgressPath`. Putting a plue workspace link on a Smithers
  gateway run would claim a relationship that does not exist. When a plue
  agent-session surface lands, the action is one button running the already
  registered `box.view <workspace_id>`.
- **Addendum item 1's "Open the agent session" as an action.** The brief's own
  fallback was taken: no existing flow *opens* a plue agent session
  (`egress.session` lists what one called out to, which is a different act and
  would mislabel the button), so the card renders `agent session <id>` as
  text. When such a flow exists it is one line in `WorkspaceCard.tsx`.
- **A workspace status-stream consumer.** Addendum item 3 says "the stream
  consumer applies head/ahead/behind" — there is no such consumer: the seam
  settles a workspace by POLLING `GET …/workspaces/{id}` (`poll()`), and no
  `EventSource` exists anywhere under `src/mainview`. The polling path already
  carries the new head, because it parses the whole DTO. The event applier
  `applyStatusEvent(workspaceId, event)` is implemented and tested (head
  events apply; status-only events leave the head untouched; unknown
  workspaces and unknown statuses change nothing) and is the single seam a
  future SSE consumer plugs into. Building the SSE transport itself was not in
  the brief.
- **The relay path `/api/workspaces/{id}/desktop/{token}/*` is never built by
  this app.** The POST's absolute `stream_url` is used verbatim, as the brief
  requires.

## Gates

- `cd apps/app && bun x tsc --noEmit -p .` — **clean.**
  `packages/rpc`, `apps/server` and `apps/review` also typecheck clean.
- `bun test src/mainview/cards/WorkspaceCard.test.tsx
  src/mainview/state/seams/WorkspaceSeam.test.ts` — **115 pass, 0 fail**
  (41 card + 74 seam).
- `bun test src/mainview/flows/` — **102 pass, 0 fail** (registry and parity
  pins updated).
- `packages/rpc`: `bun test src` — **131 pass, 0 fail.**
- `bun test src` (apps/app, 173 files) — **1696 pass, 10 fail, 5 errors.**
  Every failure is pre-existing and outside this lane:
  - **3** — `src/bun/TargetGraph.integration.test.ts` fixture failures
    (`~/artsy/force`), untouched as briefed. Re-run alone: 6 pass, 3 fail —
    the same three L3 recorded.
  - **7 fail + all 5 errors** — `src/bun/Main.test.ts`, the 5 s default
    per-test timeout while the machine runs several lanes' suites at once.
    `bun test src/bun/Main.test.ts --timeout 30000` → **10 pass, 0 fail.**
