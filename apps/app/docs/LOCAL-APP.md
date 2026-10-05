# Smithers UI runtime contract

## Chat timeline filter

The chat timeline interleaves cloud agent and run transcript rows with messages and cards by timestamp. Each source keeps its own order. Local harness agents have no structured transcript rows, so their existing cards represent those lanes. The embedded cloud agent and run cards omit transcript rows already shown in chat; maximized cards retain their transcript.

The Filter button opens a keyboard menu with Show all, Chat, each lane, Messages, Cards, Subagent rows, and Search. Arrow keys move between menu items, Enter or Space activates one, and Escape closes it. The same actions are available as `/chat.filter`, `/chat.filter.toggle <target>`, `/chat.filter.grep [text]`, and `/chat.filter.reset`, including through the agent door. `session.chatFilter` and `session.chatFilterMenuOpen` persist; every change is an actor-stamped transition.

The same React application runs against two explicit hosts: Smithers Cloud and a
local browser origin.

## Composition roots

| Host | Server | Native privileges | Typical capabilities |
| --- | --- | --- | --- |
| Smithers Cloud | `apps/server` Cloudflare Worker | none | agent, identity, Smithers Cloud, checkout when configured |
| Web, hosted or self-hosted | `packages/backend` Go (`host: "cloud"`, `authFlow` `redirect` or `credentials`) | none | identity, cloud, `cloud.terminal`, GitHub when configured |
| Local browser/headless | `apps/app/src/bun/serve.ts` | none | agent/identity/cloud only in hybrid mode |

Repository tools, terminals and harness execution run in the shared backend
and workspace VM. The browser host keeps the authenticated terminal tunnel.

The client first loads `GET /api/bootstrap` and validates it with
`AppBootstrapSchema`. Commands declare required runtime capabilities; the
registry omits unavailable commands. Components render from that registry,
so disabled hosts do not expose controls that can only fail.

Supported capabilities are `agent`, `model.turn`, `recommend`,
`browser.read`, `identity`, `github`, `cloud`, `billing.checkout`,
`cloud.terminal` and `cloud.pat`. No
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
host and headless app. `startLocalServer` itself never reads it: an agent
is injected through its `agent` option or the host has the Smithers Cloud one.

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
| Set by the app | `SMITHERS_AUTH_MODE` `SMITHERS_AUTH_BOOTSTRAP_TOKEN` `SMITHERS_NATIVE_POSTGRES_*` `SMITHERS_NATIVE_STATE_DIR` `SMITHERS_DATA_ROOT` `SMITHERS_SERVER_ADDR` `SMITHERS_PUBLIC_URL` `SMITHERS_WEB_ROOT` `SMITHERS_FLOW_HOST_MANIFEST` `SMITHERS_WORKSPACE_*` `SMITHERS_MODEL_HOST_BUNDLE` `SMITHERS_NODE_BINARY` `SMITHERS_JJ_PATH` `SMITHERS_FFI_LIBRARY_PATH` |

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

Chat acceptance, replay, cancellation, and retirement belong to the shared
Go backend and PostgreSQL journal. The browser transport preserves the backend
turn identity and sealed delivery bytes; disconnecting it never erases a turn.

The local HTTP identity proxy re-scopes the upstream cookie onto its loopback
origin: it removes `Domain` and `Secure` for the local HTTP browser session.
The sign-in claim log names cookie attributes without the credential value.
Request logs retain method, path, status, and elapsed time.

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
  saw it), and a steer row (`/runs.steer`) whose queued state reads `steering pending · delivered at
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
  the wire did not state. A vm adds what it booted (`env ·
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
  swapped in, never a value). The footer acts: Suspend or
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
reload, and recorded branch restoration operate on workspace/branch/frame records in
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

## Focused client scope

The app retains Paper in light and dark mode, ordinary chat explanations, the
browser reader, code intelligence, repository flows and wiki memory. Plugin
runtime APIs and local installation remain available; the Library storefront
and dedicated Explainer command are removed.

Saved palettes normalize to Paper through appended system events. Saved Library
surfaces reopen Chat; plugin installation records and earlier event bytes remain
intact. Historical explanation cards remain readable.

Restoration sources: [Pair #3401](https://github.com/smithersai/smithers/issues/3401),
[marketplace #3402](https://github.com/smithersai/smithers/issues/3402), and
[theme collection #3403](https://github.com/smithersai/smithers/issues/3403).
The immutable pre-removal source is
[`ce7fbc112fa37951c0beca985805600c3f8dfe8f`](https://github.com/smithersai/smithers/tree/ce7fbc112fa37951c0beca985805600c3f8dfe8f).
Client removal and validation are tracked in
[#3406](https://github.com/smithersai/smithers/issues/3406).

## MVP feature recovery

The native app and Cloud desktop were removed for the focused MVP in
[smithers#3387](https://github.com/smithersai/smithers/issues/3387). Their clean
source baseline is commit `2ad6fe2afcd2e45d81587b62f79d51b4ab02ae0d`.
VM/container execution, terminals, previews, files, internal snapshots, and
agent memory remain supported. Historical desktop database fields remain
readable for upgrades; they do not expose a desktop launch door.

## Client scope recovery

Model experiment cards, request composers, model CRUD/tests, per-run model/effort/tool controls, and manual frame forks are retired for the MVP ([#3387](https://github.com/smithersai/smithers/issues/3387)). The pre-removal source is commit `8c3d1e7c0260c3f78d6bbcb7de339880dffe95cb`. Model configuration and credentials remain host concerns. Recorded histories and existing branch snapshots still decode; ordinary navigation, log inspection, and automatic recovery remain available.

## Setup without a GitHub account

On an Apple Silicon Mac with at least **72 GiB free disk**, build the server
bundle at the checkout's HEAD, then start a disposable local install:

```bash
pnpm exec smthrs build //apps/app:serverBundle
pnpm --filter smithers-app local:no-github
```

The command starts the existing GitHub stand-in and the real server bundle as
your logged-in user, prints the setup URL, and opens Chromium. Enter
`local-owner` as Owner. The stand-in has one private repository,
`local-owner/demo`, and fresh credentials on each start. Ports 4000, 4001 and
2222 must be free. Each run keeps its state, including PostgreSQL and the
machine image records, in a fresh private directory
`~/Library/Caches/smithers-local-*`; the installed backend refuses a data root
under `/tmp`. Ctrl-C stops all three processes and deletes that directory;
`--keep` keeps it. `--no-browser` starts just the two servers.

Address, Create GitHub App, sign-in, repository selection and model access work
through the Setup card. The walk needs no provider key and sends no model call
off the Mac: the launcher points every built-in model provider at the loopback
model stand-in (`e2e/real/support/model-provider.ts`), and the walk saves the
stand-in's key as the Cerebras key and as the AI Gateway key, which the coding
model (`e2e-answers`) and Decisions share. Model access tests each role at the
stand-in, and the model proxy, which a coding host's model calls go through,
forwards to it too. After Source ready it asks the app agent, which runs on the fast
model, about `README.md`; the host reads the file from the mirrored
`main` as the signed-in owner and the answer shows its File card. `local-owner/demo`
is a Node canary (`.node-version`, `packageManager`, `pnpm-lock.yaml`), so
Machine ready loads the bundle's base image and builds main's toolchain and
dependency layers in real microVMs. TODO start, PR and merge remain with their
owning lanes. Source import and
retention still hard-code `https://github.com/<repo>.git`, and their Git process
drops the refusing proxy, so Source ready can reach real GitHub. This rehearsal
does not replace models, machines, Git objects or later journey steps.

```bash
pnpm --filter smithers-app test:e2e:local
```

The unattended headless walk uses the same command and writes
`apps/app/test-results/local-no-github/steps.tsv`, `writes.json` (method, path
and status only) and `github-requests.json`. Each missing step runs its real
browser walk as an expected failure with its owner recorded; a newly working
step fails the test as “expected to fail but passed” until its annotation is
removed. Later rows remain blocked by the first unfinished step.

Only the browser's manifest form POST to GitHub is carried to the stand-in;
other GitHub browser requests are aborted and fail the walk. The test launcher
injects the three existing GitHub base variables and
`SMITHERS_MODEL_PROVIDER_ORIGIN` through its spawn hook and uses a refusing
HTTPS proxy for backend HTTP calls. The installed backend keeps those values,
like the proxy variables, because they name no file
(`apps/backend/installed.go`). The model origin must be an `http` loopback
origin with a port, or the backend refuses to start; the backend sends a
built-in key there under a stand-in credential name pinned to that origin
alone. Unset, every key goes to its provider. The production launcher's
passthrough list is unchanged. Existing configuration-file overrides for auth
bases remain outside this environment-filter guarantee.
