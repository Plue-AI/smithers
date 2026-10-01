# Smithers UI runtime contract

## Chat timeline filter

The chat timeline interleaves cloud agent and run transcript rows with messages and cards by timestamp. Each source keeps its own order. Local harness agents have no structured transcript rows, so their existing cards represent those lanes. The embedded cloud agent and run cards omit transcript rows already shown in chat; maximized cards retain their transcript.

The Filter button opens a keyboard menu with Show all, Chat, each lane, Messages, Cards, Subagent rows, and Search. Arrow keys move between menu items, Enter or Space activates one, and Escape closes it. The same actions are available as `/chat.filter`, `/chat.filter.toggle <target>`, `/chat.filter.grep [text]`, and `/chat.filter.reset`, including through the agent door. `session.chatFilter` and `session.chatFilterMenuOpen` persist; every change is an actor-stamped transition.

The same React application runs against two explicit hosts: Smithers Cloud and a
local Bun origin. Electrobun is an optional native shell around the local
origin; it is not a separate application or state model.

## Composition roots

| Host | Server | Native privileges | Typical capabilities |
| --- | --- | --- | --- |
| Smithers Cloud | `apps/server` Cloudflare Worker | none | agent, identity, Smithers Cloud, checkout when configured |
| Web, hosted or self-hosted | `packages/backend` Go (`host: "cloud"`, `authFlow` `redirect` or `credentials`) | none | identity, cloud, `cloud.terminal`, GitHub when configured |
| Local browser/headless | `apps/app/src/bun/serve.ts` | none | agent/identity/cloud only in hybrid mode |
| Desktop shell | `apps/app/src/bun/NativeApp.ts` + Electrobun over the Go backend or Plue | system-browser handoff | the backend's rows plus `native.shell`, the one row native-shell UI reads (never `host`) |

The desktop app offers exactly the web app's feature set. The local backend —
targets, in-process language servers, terminals, local repositories and
harness detection — retired; see `LOCAL-BACKEND-RETIREMENT.md` for what each
one became. Code intelligence stayed, re-doored on `cloud.terminal`: plue's
language server in the workspace VM, over the tunnel this origin serves.

The client first loads `GET /api/bootstrap` and validates it with
`AppBootstrapSchema`. Commands declare required runtime capabilities; the
registry omits unavailable commands. Components render from that registry,
so disabled hosts do not expose controls that can only fail.

Supported capabilities are `agent`, `model.turn`, `recommend`,
`browser.read`, `identity`, `github`, `cloud`, `billing.checkout`,
`cloud.terminal`, `cloud.pat`, and `native.shell`. No
capability is local-only: a door no host can open is a flow that should not
exist.

## Local modes

`SMITHERS_LOCAL_MODE=offline` is the headless default and performs no Smithers
Cloud requests. `hybrid` enables the Smithers Cloud and identity upstreams:
chat turns go to the shared backend's `POST /api/agent/turn` on
`SMITHERS_CLOUD_API` as the signed-in Cloud user (`src/bun/CloudAgent.ts`),
and signed out a turn is refused with `cloud_sign_in_required`.
`SMITHERS_CHAT_STUB=1` selects the deterministic in-process agent
(`e2e/support/ChatStub.ts`) in the two hosts that read it — the browser test
host and the packaged app. `startLocalServer` itself never reads it: an agent
is injected through its `agent` option or the host has the Smithers Cloud one.

The native launcher starts the local origin in its own process, then opens the
window at it. There is no detached session owner: quitting the app stops the
server with it, because nothing long-running lives on this machine any more.
Long-running work lives in a plue workspace, which survives on its own.

The native launcher defaults to hybrid unless explicitly set to offline. The
packaged app serves its built SPA from `127.0.0.1` on a port chosen at first
launch and saved as `local-origin-port` in its application-support directory.
Later launches reuse that port because OPFS and localStorage belong to the
complete browser origin. If the saved port is occupied, startup fails rather
than moving the user's conversation to an empty origin. `SMITHERS_LOCAL_PORT`
is an explicit development/test override and does not replace the saved port. The
headless server prints `SMITHERS_LOCAL_ORIGIN=http://127.0.0.1:<port>` when it
is ready.

## Owned backend environment

The owned backend never inherits the launcher's environment. A terminal launch
and a Dock launch give it the same configuration, and provider keys, cloud
tokens and `SMITHERS_*` exports in the shell never reach it.

| Source | Names |
| --- | --- |
| Launcher session, copied by name | `HOME` `USER` `LOGNAME` `TMPDIR` `TZ` `LANG` `LC_ALL` `LC_CTYPE` `XDG_CONFIG_HOME` `XDG_DATA_HOME` `XDG_CACHE_HOME` `XDG_STATE_HOME` |
| Launcher network policy, copied by name | `HTTP_PROXY` `HTTPS_PROXY` `NO_PROXY` `ALL_PROXY` (and lowercase) `SSL_CERT_FILE` `SSL_CERT_DIR` |
| `PATH` | the packaged `bin` directory, then the launcher's `PATH` or the system directories |
| Git | `GIT_EXEC_PATH` `GIT_TEMPLATE_DIR` (packaged), `GIT_CONFIG_NOSYSTEM=1` `GIT_CONFIG_GLOBAL=/dev/null` |
| Set by the app | `SMITHERS_AUTH_MODE` `SMITHERS_AUTH_BOOTSTRAP_TOKEN` `SMITHERS_NATIVE_POSTGRES_*` `SMITHERS_NATIVE_STATE_DIR` `SMITHERS_DATA_ROOT` `SMITHERS_SERVER_ADDR` `SMITHERS_PUBLIC_URL` `SMITHERS_WEB_ROOT` `SMITHERS_FLOW_HOST_MANIFEST` `SMITHERS_WORKSPACE_*` `SMITHERS_MODEL_HOST_BUNDLE` `SMITHERS_NODE_BINARY` `SMITHERS_CODING_LOCAL_OWNER` `SMITHERS_JJ_PATH` `SMITHERS_FFI_LIBRARY_PATH` |

The first-owner token comes from `config/secrets.json` in the state directory,
or is generated on first launch. Model credentials come from the owner
credential store. At spawn the app logs `owned backend env: <names>` to stderr,
with names only. An owned target always authenticates by session and ignores
`SMITHERS_API_TOKEN`.

## Local-origin security

Each launch creates a fresh 256-bit token. The token is placed in the
served document's `smithers-local-session` meta tag. The client sends it in
the `x-smithers-local-session` header and in the cloud tunnel's WebSocket
subprotocol.

The server rejects missing/invalid tokens, cross-origin API requests,
unexpected `Host`/`Origin` values, non-JSON mutation bodies, oversized HTTP
bodies and WebSocket frames. It binds loopback only.

The native RPC surface has exactly one privileged operation:

- `openExternal({ url })`, which accepts only HTTP(S) URLs and opens the
  system browser.

It has no HTTP fallback in the packaged app.

Chat acceptance, replay, cancellation, and retirement belong to the shared
Go backend and PostgreSQL journal. The renderer relay preserves the backend
turn identity and sealed delivery bytes; disconnecting it never erases a turn.

The identity proxy re-scopes the seam's session cookie to the local origin
before the WebView sees it: `Domain` goes because the cookie belongs to this
origin now, and `Secure` goes because WebKit refuses a `Secure` cookie set over
`http://127.0.0.1` (Chromium accepts one, so only the native renderer showed
the failure). The trail line for `/api/auth/native/claim` names the cookie's
attributes, never its value, and every `/` and `/api/*` request leaves a
`METHOD /path -> status in Nms` line.

The cloud proxy (`/api/cloud/*`, lane piper) forwards to `SMITHERS_CLOUD_API`
(default `https://api.jjhub.tech`) with the same rules as the identity proxy:
Host and Origin follow the upstream, `content-length` and the local session
header are dropped, Set-Cookie is re-scoped, and the request carries
`Authorization: Bearer` from the Bun-side credential. The cloud token NEVER
reaches the renderer. Cloud sign-in (`/api/cloud-auth/*`) is the CLI's browser
flow: start answers the login URL, the callback lands on a loopback listener,
and the token lives in the macOS keychain (`smithers-cloud`) plus Bun memory;
the session route answers `{ state, username, expiresAt }` only.
`SMITHERS_CLOUD_TOKEN` is a dev/CI override read first. A signed-in session
loads the repository inventory (the composer's repository menu reads it)
through the proxy; the bootstrap advertises the `cloud` capability when
the proxy is enabled.

## Repository resolution

Repo-scoped slash commands treat a trailing `owner/repo` in argument text as
an explicit target only when it names a loaded repository or the active working
copy's repository. Other path-shaped tokens stay in the text: `/issues.create Fix
src/index.ts` keeps the full title and uses the active repository, or the sole
loaded repository when none is selected. Repository-only commands such as
`/repos.import acme/new` can name a repository that is not loaded yet.

A repository is a Smithers Cloud workspace, never a directory on this machine.
The picker grant flow, the open-repository set, per-repository access levels,
the local file route and the local language servers all retired with the local
backend (`LOCAL-BACKEND-RETIREMENT.md`).

A workspace terminal lives in its workspace card's Terminal facet; closing the
card detaches without deleting the session. Tabs are card tabs ("Open in tab"
on a maximized card, `tab.card`, `tab.select`, `tab.close`): the terminal and
harness tabs, the `+` menu and the PTY seams retired with the local backend
(`LOCAL-BACKEND-RETIREMENT.md`, smithersai/smithers#2229).

## HTTP and WebSocket surface

All mutations require `Content-Type: application/json`; failures use
`{ error: { code, message } }` locally. A path whose percent-encoding is not
valid UTF-8 answers `400 invalid_path` in that envelope, static or routed, and
leaves its trail line. An agent turn body is capped at 1 MiB by the bytes
received, so a chunked body is refused with `413 body_too_large` like one that
declares its length.

Beside `error`, the same refusal is stated in the one shape the app
classifies, `{ status: "error", code, message, origin: "local" }`, with the
code in this host's own namespace (`native_invalid_path` for the route's
`invalid_path`; `@smthrs/rpc/NativeFailureCodes` holds the registry, its fault
and its status). The route name inside `error` does not change, and is still
what this host's clients match on. The namespace exists because eight of these
route names are also plue's spellings and one is the Worker's, and they do not
all mean the same thing. The status comes from the registry, so a route and its
code cannot disagree about one.

The routes this host shares with the Cloudflare Worker (`/api/cloud/*`,
`/api/auth/*`, `/api/identity/*`, `/api/tools/browser-fetch`) refuse in the
WORKER's vocabulary instead (`@smthrs/rpc/WorkerFailureCodes`), still with
`origin: "local"`. An upstream those proxies forward to gets 20 s to send
headers, which is the Worker's own default and the host's `upstreamTimeoutMs`
option, and then answers `504 upstream_timeout`. The deadline covers headers
only, so a streaming answer is never cut off. A body an upstream refuses with
is restated in this host's envelope, keeping the upstream's status, `code`,
`retry_after` and `Retry-After`, so a router's plain 404 or an HTML error page
never reaches a reader. A top-level page navigation (the system browser opening
`/api/auth/github/start`) keeps the upstream's own page.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/bootstrap` | Versioned host/capability contract |
| GET | `/api/health` | Local process status |
| POST | `/api/agent/turn` | NDJSON agent stream (`/api/chat/turn` is a compatibility alias) |
| POST | `/api/agent/turn/replay` | Read committed batches from a persisted leg cursor; never start inference |
| POST | `/api/agent/turn/retire` | Retire a leg using its private replay capability |
| POST | `/api/agent/turn/erase` | Delete-only proof, including fencing a not-yet-accepted leg |
| POST | `/api/agent/turn/cancel` | Cancel a turn (`/api/chat/cancel` is an alias) |
| GET | `/api/model/catalog` | Built-in models, credential names with `present` and their pinned origins, and seats; never a value |
| POST | `/api/model/test` | One request to a configured model; 200 with a typed result for a pass and a failure; no sign-in |
| POST | `/api/tools/browser-fetch` | Guarded, pinned HTTPS page read (501 offline) |
| POST | `/api/telemetry/errors` | Renderer crash report; logged and counted |
| ANY | `/api/cloud/*` | Cloud proxy to `SMITHERS_CLOUD_API` (Bearer from the Bun credential; 501 offline) |
| POST | `/api/cloud-auth/start` | Begin the browser login; answers `{ url }` |
| GET | `/api/cloud-auth/session` | `{ state, username, expiresAt }`, never the token |
| POST | `/api/cloud-auth/sign-out` | Delete the keychain credential and the in-memory token |

The only WebSockets this origin serves are the two cloud tunnels under
`/api/cloud-ws/`. The renderer's own topic bus (`/ws`) went with the local
backend: its only publishers were the local PTY, the target runs and the
local language server.

A file card asks the language server plue runs inside the repository's running
workspace (lane L6, plue#505): the renderer's
`CloudLspClient` creates the session (`POST …/workspace/sessions
{ workspace_id, kind: "lsp", language }` through `/api/cloud/`), opens
`/api/cloud-ws/repos/{o}/{r}/workspace/sessions/{id}/lsp`, the same tunnel
as the terminal, with plue's `lsp` subprotocol and a 1 MiB frame cap on that
branch alone (a larger message crosses as `{ seq, last, data }` fragments the
renderer reassembles up to 16 MiB), and speaks LSP itself: `initialize` with
`rootUri file:///home/developer/workspace`, `initialized`, `didOpen` with the
card's text at its checkout-relative path, then hover, definition and the
publications. A refused upgrade closes the renderer's socket with a 44xx code
that mirrors plue's status; on this branch the reason carries plue's
`code: message` verbatim (`language_server_missing: npm i -g …`) and, for a
425 `workspace_session_pending` (4425) or 503 `guest_not_ready` (4503), the
`Retry-After` it named, which the client honors with a bounded retry while the
card shows the server's words. 1011 retries once with a fresh initialize,
1001 and an abnormal drop reconnect, 1008/1002/1003/1009 are final, and every
close reason reaches the card verbatim. A cloud repository without a running
workspace is told which act opens or resumes one; a file no relayed language
handles is told the DTO's `lsp.languages`.

## Model-authored cards

Models can provide explanatory text but cannot author markup, scripts, command
labels, bridge messages, or action handlers. Historical HTML cards remain
decodable for migration and render in a CSP-restricted inert iframe with
scripts and network access denied.

Build targets, their runs, the target graph and its replay retired with the
local backend (`LOCAL-BACKEND-RETIREMENT.md`); nothing replaced them, because
the web app never had them.

## Cards

Every capability's output is an embedded card in the transcript (THE EMBED
LAW); maximizing one is a presentation transition of the same component. Each
card file's header comment is that card's own contract: the facts it renders,
the facets it switches, and the acts it binds. This section names the
surfaces; the file states the detail, and its tests pin it.

The run lifecycle (lane `runs`, `docs/workbench-lanes/runs.md`) adds three
surfaces, all over the workspace gateway's own projections and procedures:

- **`run-list`** (`/runs.list [status] [flow] [by=] [lineage=] [owner/repo]`):
  the workspace's runs from the `workspace-runs` projection, newest first, a
  mono count line by status in the header and filter chips that re-invoke
  `runs.list` with the chip's argument. A row's Open materializes the run's
  own card (`/runs.open <runId>`); the footer's `Stop all N` runs
  `/flow.run.stop-all` (a confirming flow). `by=` refuses honestly: the wire's
  run summary records no launcher.
- **`approvals-inbox`** (`/approvals.list [owner/repo]`): every pending gate
  across the workspace's runs (the `approvals` projection with no run id).
  Each row carries the submit-ready envelope the gateway published, so its
  Approve/Deny dispatch the ordinary `approval.approve` / `approval.deny`
  flows addressed `inboxCardId:requestId` and the decision goes back
  unchanged. `/approvals.open <runId>` materializes one run's gates as
  ordinary approval cards.
- **`flow-run`** grows the run card's lifecycle beyond launch: Stop on
  every non-terminal phase (`/flow.run.stop <cardId> [reason]`, confirming),
  Resume when the control plane names a wait other than an approval
  (`/runs.resume`), Run again when settled (`/runs.rerun`, the launch input
  recorded on the card at launch; an honest refusal when this client never
  saw it), and a steer row (`/runs.steer`, `/runs.seat`, `/runs.thinking`,
  `/runs.tools`) whose queued state reads `steering pending · delivered at
  the next turn`. A waiting run names the control plane's reason:
  `accepted · nothing is driving it` for an accepted run, the wait's word for
  a parked one. Three facet tabs switch the body: Steps (default),
  Transcript (`/runs.logs <runId> [--follow]`: follow merges the
  `transcript` projection on the pump's own cycle), and Events
  (`/runs.events <runId>`, the raw journal, rendered only where
  `/debug.verbose` is on).

Lane `citc` (ADR 0002) adds the persistent cloud computers:

- **`workspace`** (`/box.open [bookmark] [owner/repo]`, `/box.view
  <id>`) opens one cloud computer bound to a repository bookmark. The header
  names the repo, the target bookmark, and the BOOKMARK's head (`bookmark
  main head @ qupxosqw`), then the facts line the DTO carries: the sandbox
  kind, the workspace's OWN head (`workspace head @ qupxosqw a03f5f11`), how
  far it is `ahead` of and `behind` the bookmark, its uptime, the Nix
  environment it was built from (`source @ revision`), its persistence, and
  the languages it relays a language server for (`lsp: typescript`, from the
  DTO's `lsp.languages`). Every fact renders only when the payload carries
  it: an absent field renders NOTHING, never a placeholder and never a zero
  the wire did not state. A vm or desktop adds what it booted (`env ·
  <closure> · <image tag>`), a driving agent session is named but not opened,
  and the ssh host rides its own copyable line. A six-state pill (pending,
  starting, running, suspended, stopped, failed) leads; a starting workspace
  streams its `provisioningStage`, a failed one names the stage plus plue's
  failure code and message verbatim and offers the three kinds as the retry
  (`/box.open … --kind <kind>`). The facet strip switches Terminal (the
  attachment or the refusal in plue's own words and code, then every session
  with its id, its status, and its Destroy), Files (the repository file
  card's own listing, bound to the workspace's routes), Services (each
  declared service with the port and url it publishes), Snapshots (Fork
  from, Make template, Delete per row), and Egress (each call this computer
  made, whether it was allowed or blocked, and which secret NAMES the proxy
  swapped in, never a value); a `desktop` workspace also gets Desktop, which
  mints a session and streams plue's NixOS VM over VNC, so it is its own
  confirmed act rather than a facet switch. The footer acts: Suspend or
  Resume, Fork, Snapshot, and Delete behind a typed confirm.
  `/box.terminal` opens the workspace's terminal in the card's Terminal
  facet (the socket tunnels through the origin's `/api/cloud-ws/` bridge with
  the host-held bearer attached upstream, and the token never reaches the
  renderer); leaving the facet detaches, and killing the session is the
  explicit `/box.session.destroy`. That act is rendered only where the
  live registry holds `box.terminal`, and the Terminal facet otherwise
  says terminals are not on the web yet. Every workspace act refuses a
  `degraded` cloud session with the "sign in again to enable" wording (ADR
  0001's legacy scope set).

Lane `change` (ADR 0003) makes the change the unit of review:

- **`change`** (`/change.view <changeId>`) renders one card per change, from
  plue's change DTO plus its auxiliaries: the per-repo stat, the carrying
  landing request's stack position (`Landing #42 · position 2 of 2 · open →
  main`), and the changeset when the repository's owner is an org (a `failed`
  changeset renders its `failure_reason` verbatim). The header names `rev N of M`
  when recorded, the landing pill, and whose turn
  it is by LOGIN (`turn: will · reviewer`); a field the GET did not state
  renders nothing, so a change with no recorded revision shows no revision
  count. Five facets always switch the body: Diff (two revision pickers that
  pin any pair through `change.pins`, the file rows at those pins each
  opening its one-file diff and offering Split while the stack's landable
  prefix is short, and `since your review at rev N` with show all once a
  human review is recorded), Findings (the analyzer runs, then one row per
  finding with its severity, analyzer, `path:line`, summary, the revision
  that raised it, `· stale` when its anchor moved off, the feedback that
  dimmed it, and its two acts, Please fix and Not useful), Checks (a revision
  picker, then the newest answer per context with the work it did, `12
  affected · 3 ran · 9 cached · 4s`), Review (the verdict strip with the
  confidence WORD, the Request review picker off the landing's
  `review_requests[]`, and the threads with Done / Ack / Reopen, each anchor
  carrying `· stale` or `· moved → :line`),
  and History (one row per revision with its provenance, its Diff to current
  and Open computer acts, then the landed row). Walkthrough joins the strip
  only when an artifact exists, leading when the current revision came from
  an agent session and the change touches more than 20 files and otherwise
  sitting after History; Owners closes the strip only when the change GET
  carried ownership. The footer acts: Land (the carrying landing request:
  queued, never "merged"; `Land 1 → N` for a stack, `Retry land` for a failed
  one, the changeset's own atomic route when one carries the change, a 409
  re-reads, and a blocked gate names its reason beside the button), Split
  ready while the changeset can still land, Revert on a landed change, and
  Full diff. A `degraded` sign-in reads a change freely; dispatching the
  resolve agent refuses with the "sign in again to enable" wording.
- **`diff`** (`/change.diff <changeId> [from] [to] [path]`) renders one from →
  to pair pinned at the change's commit (`parent → rev 2 · pinned at rev 2 ·
  a03f5f11`), conflicted files leading. Any pair pins: `parent → current`
  reads plue's bare route and every other pair is a revision diff with jj
  interdiff semantics, so a rev → rev interdiff is an ordinary read; a token
  naming no recorded revision refuses by name and guesses nothing. A hunk
  inlines up to 400 patch lines; a larger one rides by reference and names
  its re-read (`/change.diff <changeId> parent current <path>`), and a binary
  file says so instead of showing a diff.

- **`connector-setup`** renders the GitHub App status from `/github.app`,
  its trusted install link through `/github.app.open`, and Re-check and
  Reconcile through `/github.reconcile`.
- **`sync-ops`** renders GitHub mirror runs, their repository status, counts,
  per-ref results, and errors. Failed refs retry through
  `/github.mirror.retry-ref`. `/sync.ops.show-more` reveals additional rows.
  A null run state retains the pending pill.
- **`repo-import`** grows the job's own progress: the stage counts (`refs
  214 of 214 · objects … · issues …`) when the wire carries them, the
  failed phase's Retry through `/repos.import.retry <jobId>` (the route
  exists), and the done state's workspace link (`/box.view`). A
  structured 429 (`code: "github_rate_limited"`) renders the ADR's
  rate-limit line on every sync card (`GitHub rate limit reached · 0 of
  5,000 · resets 12:40 · Retry after`), as does a status answer whose
  remaining budget drops under a fifth; a plain 429 invents no reset.


The Connectors surface's GitHub row reads loaded App statuses. A repository never checked is absent, never
assumed.

The composer's origin chip carries the probed checkout's pin: `~/smithers ·
qupxosqw · a03f5f` (`changeId#seq` only when the changes collection knows a
sequence, never from a commit comparison alone), beside piper's `N ahead of
main`. `rev N exists · view` renders only when BOTH seqs are known.

## Navigation and persistence

`AppStore` declares persisted collections once, including each schema, key,
and recovery policy. Construction, preload, and recovery use that declaration;
the repository tree remains memory-only. Cloud seams share `CloudClient` for
JSON transport and failure metadata while keeping their own authorization,
DTO parsing, and retry decisions.

`cloudWorkspaces` owns live workspace facts. `WorkspaceViews` derives working
copies and card headers through TanStack DB queries; ordinary updates and status
polls write the workspace row only. Local pins and sparse older inventory remain
readable until a full workspace row supersedes them. Removing a workspace from the
inventory retains its last observed card facts until a live row is available again.
Frame and branch snapshots capture complete cards and mark workspace cards as
snapshots. Restoring one preserves its captured facts until an explicit workspace
act refreshes it.

Durable routes use `/w/:workspace/b/:branch/f/:frame`. Browser back/forward,
reload, and immutable branch forks operate on workspace/branch/frame records in
the same store as cards. Fullscreen is explicit; the composer remains mounted
and usable while a card is maximized.

Repositories have one address space (lane piper, ADR 0001): the composer's
repository menu is the tree `org/ → repo → working copies`: cloud repositories
from the signed-in inventory, cloud workspaces beneath their repo. Selecting a
repository names `org/repo`; selecting a copy names `org/repo#copyId`. The
composer's origin chip states where the selection lives (the selected box, or
`head @ qupxosqw` at a repository's head). File cards carry the global address
(`/org/repo/path`) and the position the read was taken at; when the
repository's head commit has moved since, a "head moved" line offers an
explicit refresh. Nothing re-reads on its own. `/files.list` and
`/files.read` accept a global path (`/files.read /org/repo/README.md`) when
the two-segment prefix is a repository the app knows.

## Client error reporting

`ClientErrors.report` never throws or awaits delivery. Non-stringifiable
rejection reasons use an object label, then `Unknown error` if that also fails.
Report construction, clock/pathname callbacks, and transport failures are
contained. Failed construction and sends count toward the per-page attempt cap.

## Build and verification

```sh
pnpm --filter smithers-app typecheck
pnpm --filter smithers-app test
pnpm --filter smithers-app build:web
pnpm --filter smithers-app test:e2e
bun run test:e2e
```

The web build is the Cloud Worker asset and the local server asset. The heavy
knowledge-graph, code-view and markdown-editor modules are dynamic chunks, so
they are absent from the initial application chunk.

The piper, runs, citc, change and sync browser specs install common routes with
`e2e/playwright/cloudFixture.ts`. Local bootstrap, repository and cloud-session
responses use the shared RPC contracts. Cloud inventory lists use bare arrays;
bookmarks use `{ items, next_cursor }`. Repository loading reads that cursor
envelope when resolving the default bookmark head. Fixture options override
capabilities, cloud inventory, per-repository bookmarks, workspaces and
degraded sessions. Register scenario routes after the installer
to override its defaults. Route matching uses exact pathnames and accepts query
strings. `cloudFixture.spec.ts` checks these contracts and override isolation.

The default Playwright host also owns a temporary home/state directory and
reads no host credentials. `SMITHERS_CHAT_STUB=0` is an explicit real-chat
request: the turn runs on the backend (`SMITHERS_CLOUD_API`) as the Cloud user
`SMITHERS_CLOUD_TOKEN` names; no stored login is read. A successful server shutdown removes only its owned temporary
directory; failed startup/shutdown retains it for inspection.

The root `test:e2e` command packages the stable macOS app with Electrobun's
native renderer, launches the actual bundle, and drives it through a loopback
bridge that exists only when `SMITHERS_E2E_BRIDGE=1` and requires a random
bearer token. The runner redirects application state to a temporary home,
keeps the local origin fixed across relaunch, and preserves failure artifacts
under `apps/app/test-results/electrobun-packaged/`. It covers the stable
renderer, bridge security, and chat persistence across relaunch.

`PackagedApp.quit()` drains only the native process group recorded at launch,
including descendants remaining after the launcher exits. It never discovers
cleanup targets by executable path, so another instance of the same bundle
keeps running. Quitting the app ends its local origin with it. Bridge
deadlines cover headers, the complete response body, and decoding, including
error responses and screenshots.

`PackagedApp.eval(script)` sends potentially mutating scripts once. A failed
reply reports an unknown outcome and does not retry, because renderer execution
may already have completed. Use `evalReadOnly(script)` only for repeatable reads;
it retries bridge timeouts within its deadline. `waitFor` also requires a
read-only expression because it polls repeatedly.

The runner holds an atomic lease plus a per-test cleanup marker. If a prior
process died before cleanup, the next run preserves its isolated state, writes a
stale-fixture report, and fails before launching a test.
`SMITHERS_E2E_RECOVER_STALE=1 bun run test:e2e` explicitly repairs a readable
lease whose owner is no longer alive and continues in a single invocation.
Recovery and cleanup claim and recheck the lease generation before moving it
aside for deletion. Missing or unreadable leases may belong to initializing
owners and are always preserved. An interrupted retirement leaves a `.retiring`
guard; inspect and remove the abandoned registry only after confirming no
suite is running. Failed package staging removes its temporary workspace and
reports both errors if cleanup also fails. The packaged lane is macOS-only and
the GitHub fixture scenario requires network access.

### Deep links

`smithers://open/<owner>/<repo>` (`src/bun/DeepLink.ts`) opens that
repository page. On a cold launch macOS can deliver the link before the SDK
loads; it waits in `pendingDeepLink` and becomes the window's first URL.

Electrobun 2.0.1's native wrapper frees each link right after calling its URL
handler, and the SDK's handler is a threadsafe `JSCallback` that reads the
string a task later: freed memory (#3061). In 10 packaged cold launches the
first window opened the linked page 0 times. So `src/bun/NativeUrlOpen.ts`
installs its own handler, a few lines of C compiled by Bun that copy the link
inside the native call. It installs before `electrobun/main` loads, which
drains the links buffered before launch, and again right after, replacing the
SDK's. The native probe (`src/bun/Main.test.ts`) and
`src/bun/NativeUrlOpen.test.ts` deliver links through a fake wrapper with the
same string lifetime (`e2e/native/FakeNativeWrapper.ts`); the SDK's own
handler reads garbage there.

Packaged check (#1969). It needs no install: `open -a` delivers the link
through the same `application:openURLs:` path a `smithers://` click uses.

1. `pnpm build`, then launch the stable bundle once without a link so it
   unpacks itself.
2. `open -n -a build/stable-macos-arm64/Smithers.app --env HOME=<scratch>
   --env SMITHERS_E2E_BRIDGE=1 --env SMITHERS_E2E_BRIDGE_PORT=<port> --env
   SMITHERS_E2E_BRIDGE_TOKEN=<token> smithers://open/smithersai/smithers`.
3. `GET /state` on the bridge: `window.url` ends with `/smithersai/smithers`.
   Repeat with the app running: the open window navigates to the link.

### Approval ownership

Approval and approvals-inbox cards are created by runtime transitions from
chain policy or gateway requests. The store persists their trusted request
records separately in `app-approval-requests`, binding the displayed question
to the original submit-ready envelope. A pending gate cannot be relabeled or
retargeted. Inbox refreshes retain the wording and envelope of existing rows.
Decision submission reads the trusted record; decision state remains on the
card. Signing out clears both collections.

Model card frames and the chain's `card.show` and `card.update` calls cannot
create or replace approval, approvals-inbox, grant-confirm, or flow-form cards,
or patch existing cards of those kinds. Runtime flow handlers still create
their own output. Chain policy registers approvals directly with the store.
Legacy cards without a trusted request cannot authorize an operation; a fresh
runtime request or gateway refresh must register the gate first.

## App-shell verification

From `apps/app`, `pnpm test` runs Bun tests under `src/` and `scripts/`.
`pnpm run test:e2e:auth` runs the browser OAuth callback regression with
Playwright Chromium and local fixture servers. `pnpm run test:e2e:probes` runs
the probe helpers' Chromium tests under `e2e/probes/`. CI's `browserE2e`
wrapper runs both before the Playwright specs; packaged native probes remain a
separate tier.

`pnpm run checklist -- --target <origin>` works from the repository root or
`apps/app`. `--dry-run` writes reports without network calls or a browser.
Exit codes are `0` for no failed or undecided probes (prerequisite skips are
allowed), `1` for failures, and `2` for probes that ran but could not decide.
See [the scripts runbook](../scripts/README.md#launch-checklist-launch-checklistts)
for prerequisites, commands and report fields.

## Plugin Library configuration

`AppServices.features.pluginLibrary` defaults to `false`. Enable it explicitly
at controller construction to register Library navigation, commands, recommendations,
and agent tools. Disabled controllers refuse Library mutations and leave existing
plugin installations available to the other app features. Saved Library cards are
inert while disabled.
