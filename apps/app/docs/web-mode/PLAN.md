# Web mode (funnel) beside native mode (default) — combined plan

> Partly superseded 2026-10-01 (smithersai/smithers#3334): the chrome icon rail and its `chrome-download` button are removed; Download the app is the card action the `app.download.prompt` and refusal cards carry.
>
> Superseded 2026-09-30 (smithersai/smithers#3228): the chat Worker and its `SMITHERS_CHAT_URL`/`SMITHERS_CHAT_ORIGIN` settings are retired; every chat turn is the shared backend's `POST /api/agent/turn`.
>
> Partly superseded 2026-09-27 (smithersai/smithers#2239): the local repository inventory (`repos.loaded`), pins (`repo.pinned`, `repo.unpinned`, `repo.unpin`), `repo.open`, `local:` working copies and `POST /api/repo/files` are gone. Working copies are boxes and shared copies.

Synthesis, 2026-09-02 20:50, from `web-mode.BRIEF.md`, `web-mode.fable.md`
and `web-mode.codex.md`. Every disagreement was re-read in the tree (the
file:line after each claim); each decision names its source plan and why.

## 0. Corrections to the brief (verified)

## 1. Mode model

**Decision: two axes already in the tree, no new mode enum (both).**
`bootstrap.host` (`"cloud"` from the Worker `index.ts:2243`, `"local"` from
Bun `server.ts:521-534`) names the API surface; `runtime.shell.kind`
(`Runtime.ts:63-90`, `"native"` iff `window.__electrobun`) names the two
privileged doors. Web = `cloud` + `browser`; native = `local` + `native`;
headless T1 = `local` + `browser`. Bootstrap is the only authority for
features; the bridge never turns a capability on or off (Codex's phrasing,
the same mechanism).

**Gating stays on `runtime` tags; two capabilities and one axis are added
(Fable: three files changed instead of a parallel list):**

- `packages/rpc/src/AppBootstrap.ts`: `RuntimeCapabilitySchema` gains
  `"cloud.terminal"` (this origin tunnels workspace terminals) and
  `"cloud.pat"` (a host-held Smithers Cloud PAT session: `/api/cloud-auth/*`, the
  W4 and never `cloud.pat`.
- New `packages/rpc/src/HostCapabilities.ts`:
  `cloudCapabilities(env: { identity; Smithers Cloud; agent; checkout; terminal: boolean }): RuntimeCapability[]`
  and `localCapabilities(opts: { agent; identity; Smithers Cloud; pathEntry: boolean }): RuntimeCapability[]`.
  `index.ts:2246` and `server.ts:524` call them; the parity test reads them.
- `flows/Flows.ts`: `box.terminal` -> `["Smithers Cloud", "cloud.terminal"]`;
- `flows/registry.ts`: `FlowMetadata.hosts?: ReadonlyArray<AppBootstrap["host"]>`;
  `Commands.ts available()` checks it. Used only by the two download flows.

**Honest refusal (Codex's two projections, Fable's sentence).**
`Commands.ts` keeps the enabled catalog as the only executable surface and
classifies an exact miss against the unfiltered `baseFlows`:
`readonly explainAbsent: (name: string) => string | undefined`, backed by
`registry.ts export const nativeOnly = (metadata: FlowMetadata): boolean`
(any `runtime`/`runtimeAny` entry starting `local.` or equal to `cloud.pat`).
`settle()` (`:232`) and `parseSubmit`'s `unknown-command` branch return a new
`{ status: "unavailable"; reason: string; action: "app.download.prompt" }`
instead of `unknown-command`, so slash, button and agent all say
"/repo.open is not in the web app — it needs the native app." with the
download action attached. Sign-in stays a prerequisite (`unmetRequirements`),
never a mode refusal.

**Instructions.** `InstructionHonesty.host: "web" | "native"`; one generated
line on web: "This is the Smithers web app. Local repositories, local
terminals, build targets and local agents need the native app; when asked
for one, say so and execute app.download.prompt." One line keeps
`CHAT_INSTRUCTIONS_CAP_BYTES` (`Instructions.ts:205`) intact.

## 2. Web feature set

| Feature | Web | Native | Reason (file) |
| --- | --- | --- | --- |
| Cloud repo list, orgs, bookmarks | W0 | yes | `RepositoriesSeam.ts:102` on `/api/cloud/*`; W0 adds the Worker handler |
| Cloud file list / read (`files.*`) | yes today | yes | `FilesSeam.ts:249` on `/api/repos/`, allowlisted `index.ts:2023` |
| Sidebar file tree for cloud repos | W3 | yes (lane A, local) | `repo.tree` local-only, correction 7 |
| Issues, PRs, notifications | yes | yes | `/api/repos/`, `/api/notifications/` in both allowlists |
| Changes, review, land | W0 | yes | `ChangeSeam.ts:700`; landing atomic server-side (ADR 0001) |
| Workspaces list/open/suspend/fork/snapshot | W0 | yes | `WorkspaceSeam.ts:371` |
| Workspace terminal | W4 | yes | Worker relay below; gated by `cloud.terminal` |
| Agent chat | yes | yes | `WebAgent` -> `/api/agent/turn`; web adds `TURN_LIMITS` per login |
| Flows, runs, approvals | yes | R6 | `/api/workflow/rpc` lives on the Worker (`index.ts:2299`); Bun forwards nothing |
| GitHub import, mirror sync | W0 | yes | `/api/github/import` allowlisted; `RepoImportSeam.ts:152` |
| Smithers Cloud PAT sign-in (`cloud.sign-in`) | no | yes | on web the cookie IS the cloud identity (`fetchCloudToken`, `index.ts:2172`) |
| Local repos, local tree, `repo.*` | no | yes | `local.repositories`; picker is a native door |
| Local terminal, targets, harnesses | no | yes | `local.terminal`, `local.targets`, `local.harnesses` |
| BYOK keys | no | no (v1) | neither host emits `keys.byok`; plue has no key store (`index.ts:2069-2075`) |
| Billing balance | yes | yes | `/api/billing/balance` both origins |
| Billing checkout / portal | when `BILLING_CHECKOUT_ENABLED=1` | no | `checkoutEnabled` (`index.ts:2053`) |
| World notes | yes | yes | OPFS, no seam |
| Download button and prompt | yes | no | `hosts: ["cloud"]` |

**Terminal transport: a Worker WebSocket relay on `/api/cloud-ws/*`, no
Durable Object, not direct-to-cloud (Fable's choice, corrected reason).**
The ticket door exists (correction 6), so direct is feasible, but it costs
three things the relay does not: a plue origin-allowlist change for
`app.smithers.sh` ("No reserved app origin exists"), a CSP `connect-src`
that names `wss://api.jjhub.tech`, and a fresh ticket per redial (single
use; the client redials up to 6/min, `CloudTerminalClient.ts:55`). The relay
keeps zero credential bytes in the browser, not even a 30 s ticket, and
needs no change outside this repo. A Durable Object buys hibernation the
client's own reconnect and rate limit already cover. `src/bun/server.ts:
152-238` (refusal-code map, 64 KiB cap at `:82`, status-recovery GET) port
to `apps/server/src/terminalRelay.ts`:
`export const relayWorkspaceTerminal = (request: Request, env: WorkerEnv, login: string, upstream: URL): Promise<Response>`
using a `WebSocketPair`, cookie session validated at upgrade, bearer minted
by `fetchCloudToken`. The ticket door is the recorded fallback (R4).

## 3. The funnel

**Signed-out visitor on web (Codex's opening message, Fable's placement).**
Auth is a conversation state. On `host: "cloud"` only, the transcript
carries one derived Smithers message with the one action that is the
visitor's; native and T1 keep the empty signed-out transcript that
`AuthChat.test.tsx:167` pins. The download control is chrome, not a
message action: a visitor who has not signed in should sign in first.

```
┌ Smithers ──────────┐ ┌──────────────────────────────────────────────────┐
│                    │ │  S  This is the Smithers web app.                │
│  Your cloud        │ │     Sign in with GitHub to open one of your      │
│  repositories      │ │     repositories and read its files here.        │
│  appear here after │ │                                                  │
│  you sign in.      │ │     [ Sign in with GitHub ]                      │
│                    │ │                                                  │
│                    │ ├──────────────────────────────────────────────────┤
│ Sign in with GitHub│ │ Sign in to chat.                        [ Send ] │
│ Download the app   │ └──────────────────────────────────────────────────┘
│              ☾  ↻  │
└────────────────────┘
```

**First minute.** Sign-in is the existing redirect
(`window.location.assign(AUTH_SIGN_IN_PATH)`); the cookie lands on the web
origin; `loadCloudSession` is skipped without `cloud.pat`;
`loadRepositories` runs through the W0 proxy; the sidebar lists `org/ ->
repo`. Clicking a repo row runs `files.list` (already
`runtimeAny: ["Smithers Cloud", "local.repositories"]`, `Flows.ts:1149-1151`) and
renders the listing card; clicking a file in it runs `files.read` and
renders the file card. Four clicks including GitHub consent, no wizard. The
sidebar tree for cloud repos arrives in W3 (Codex's generalization,
resequenced so W0 does not wait on the in-flight lane). SLO: an already
mirrored repo, GitHub return to a readable file card in under 60 s; a cold
import shows the real import card and is measured separately (Codex).

**Download button (Fable's placement: one control, in the chrome that
"belongs to no session", `ChromeBar.tsx:639`).**

```
│ chrome-actions ─────────────────────────────────┐
│ [ Sign in with GitHub ]  <- hidden once signed in │
│ [ ⬇ Download the app  ]  data-flow="app.download" │
│                          data-testid="chrome-download"
│                                        ☾  ↻      │
└──────────────────────────────────────────────────┘

refusal card (web, any native-only ask, slash / button / agent):
┌ S ──────────────────────────────────────────────┐
│ /repo.open is not in the web app. Local          │
│ repositories, terminals, build targets and local │
│ agents need the native app.                      │
│ [ Download the app ]                             │
└──────────────────────────────────────────────────┘
```

Rendered when `controller.commands.find("app.download") !== undefined`, so
native chrome gains nothing (NO INVENTION). **Flows (Codex's split, Fable's
namespace).** `app.download`: user-only,
`hosts: ["cloud"]`, handler `actions.openDownload()` ->
`window.open(DOWNLOAD_URL, "_blank", "noopener")`. `app.download.prompt`:
agent-invocable, renders the message above with `action: { flow:
"app.download", label: "Download the app" }`, mirroring `auth.prompt` /
`auth.sign-in`. The split is forced: `window.open` outside a user gesture is
popup-blocked, and the card is the prompt, the click the human's.
`NAMESPACES` gains `{ id: "app", label: "App", summary: "The Smithers app itself" }`.

**Where the page lives: `https://smithers.sh/download` in `apps/site`**
(new decision from correction 10; neither plan saw the scaffold). The app
Worker wraps every asset in COOP/COEP (`index.ts:2341`), the wrong envelope
for a marketing page, and `apps/site` already reserves the route.
`packages/rpc/src/AppLinks.ts`: `export const DOWNLOAD_URL = "https://smithers.sh/download"`.
Until that page answers 200, W0's canary build points the same constant at
`https://github.com/smithersai/smithers/releases/latest` and the W0 receipt
records which. `apps/site` renders only rows present in the release
manifest (`apps-v*` GitHub Release assets); `apps/app` owns `build:native`
and the artifact upload; `apps/site` owns the page.

**After install (Fable).** No shared cookie domain (loopback vs
`app.smithers.sh`) and no URL scheme exist, so the handoff is the shipped
one: native `auth.sign-in` runs `AUTH_NATIVE_START_PATH` + `openExternal`
(`controller/auth-billing.ts:228-302`); the system browser already holds
the web session; the claim rescopes the cookie onto loopback
(`server.ts:336`). One click, no second GitHub consent if identity honors
its own session on `/api/auth/github/start?handoff=` (W7 verifies). Codex's
`smithers://continue/<id>` needs unproven protocol registration, a
continuation store and a Bun claim route; deferred (R5).

## 4. Build and deploy

**One SPA build (Fable).** The shell is a runtime fact the bootstrap
states; two Vite modes would double the artifact matrix for a boolean. The
one measurable cost is the static `electrobun/view` import
(`NativeBridge.ts:1`, devkit alias `vite.config.ts:75-78`). W5 makes it lazy:
`export const loadNativeDoors = (): Promise<NativeDoors | undefined>`
(dynamic import only when `window.__electrobun` exists), called once in
`ControllerBoot.client.ts`. Codex's bundle-contract check becomes the pin:
`bundle.test.ts` reads `dist/.vite/manifest.json` (`build.manifest: true`)
and fails if any `electrobun` module or the local-session literal sits in
the initial chunk group.

**Cloudflare topology (both).**

```
 browser ── https://smithers.sh ─────────► apps/site (Astro static; /, /download, /docs)
 browser ── https://app.smithers.sh ─────► Worker smithers-web (NEW, wrangler env "production")
 browser ── https://canary.smithers.sh ──► Worker smithers-mvp-web (frozen; stays the preview)
                     │  ASSETS ../ui/dist (SPA)
                     │  /api/bootstrap, /api/agent/*, /api/model/stream
                     │  /api/auth/*, /api/identity/*  ──► smithers-cloud-identity
                     │  /api/billing/*                ──► smithers-cloud-billing
                     │  /api/cloud/* (W0) + PLATFORM_PROXY_RULES ─► api.jjhub.tech (Bearer per login)
                     │  /api/cloud-ws/* (W4) ────────── wss api.jjhub.tech terminal
                     │  /api/workflow/*               ──► per-user gateway (GATEWAY_SESSIONS)
                     └─ DOs: TURN_CANCELS, GATEWAY_SESSIONS, TURN_LIMITS, CLIENT_ERRORS (fresh per Worker)
```

- `apps/server/wrangler.jsonc`: top-level `name`/`routes` stay frozen
  (`DEPLOY.md:8-21`). Add `"env": { "production": { "name": "smithers-web",
  "routes": [{ "pattern": "app.smithers.sh", "custom_domain": true }],
  "assets": ..., "durable_objects": ..., "vars": { "SMITHERS_CHAT_URL":
  "<chat Worker URL>", "SMITHERS_CHAT_ORIGIN":
  "https://app.smithers.sh", "IDENTITY_UPSTREAM_URL": "https://identity.smithers.sh", ... } } }`.
  Wrangler does not inherit `assets` or `durable_objects` into an env, so
  both are re-declared; `migrations` are shared. Fresh DO storage is right:
  all four hold ephemeral state. `run_worker_first` becomes
  `["/api/*", "/rpc/*", "/projections/*", "/sync/*", "/health"]` in both
  blocks (Fable; one wrangler file over Codex's separate descriptors because
  environments are the Wrangler primitive for exactly this).
- Secrets per env (`wrangler secret put --env production`):
  `SMITHERS_CHAT_AUTH_TOKEN`, `CHAT_PRODUCT_SERVICE_TOKEN`,
  `IDENTITY_SERVICE_TOKEN`, `BILLING_*`, `GATEWAY_*`. Identity and billing
  `ALLOWED_ORIGINS` must add `https://app.smithers.sh` (sibling repo,
  `wrangler.jsonc:85-86`, `apps/UPSTREAMS.md`).
- `apps/server/scripts/deploy.ts`: `--env <name>`; receipt gains `env`,
  `worker`, `domain` beside sha, dirty bit and version id (`:26,103-116`);
  a real deploy with no version id stays a failure. `scripts/canary/
  {rollback,build}-probe.ts` take `--worker`/`--origin`. Rollback:
  `wrangler rollback --env production` to the receipt's version id.
- **Preview = canary (Fable).** `apps-deploy.yml` gains `push: main` ->
  canary; `apps-v*` tags -> production after the canary web e2e is green.
  Codex's per-PR Workers cannot sign in: identity gates on
  `ALLOWED_ORIGINS`, so every PR origin needs an operator step in the
  sibling repo. Vite preview bypasses bootstrap, proxy, headers and DOs.
- **`BUILD.ts` targets.** `apps/app/BUILD.ts`: `webBuild` (`vite build`;
  srcs `src/**`, `vite.config.ts`; outputs `dist/**`), `bundleContract`
  (`NodeTest` over `bundle.test.ts`, deps `webBuild`), `webE2E` (`NodeTest`
  over `e2e/playwright/web`, out of the per-push graph like T1).
  `apps/server/BUILD.ts`: `deployDryRun` (`deploy.ts --dry-run --env
  production`). `apps-deploy.yml` runs targets by label; `//:ci` is
  regenerated, never hand-edited. Real deploys stay workflow steps, not
  targets (a deploy is not a gate).

## 5. State and persistence

- Both modes keep collections in the webview's OPFS SQLite, localStorage as
  the recorded fallback (`persistence.md:6-21`); origins differ, so canary,
  production and loopback each own a store. Nothing to add (both).
- OPFS needs cross-origin isolation; `withIsolationHeaders` (`index.ts:384`)
  sets COOP/COEP on every response, so no third-party subresources without
  CORP; the download page is a navigation.
- **Headers to add in W5 (Codex's list, Fable's `'self'`-only connect):**
  `Content-Security-Policy: default-src 'self'; connect-src 'self' wss://app.smithers.sh; script-src 'self' 'sha256-<index.html:20 inline>'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
  `Referrer-Policy: no-referrer`, `X-Content-Type-Options: nosniff`, a
  minimal `Permissions-Policy`. Emitted from the same helper; a Worker unit
  test recomputes the inline-script hash from `dist/index.html` and asserts
  the real response, not `_headers`. The relay decision is what keeps
  `connect-src` at `'self'`.
- **Never in the browser:** the Smithers Cloud token (minted per login in the
  Worker), gateway relay tokens (`GATEWAY_SESSIONS`, `index.ts:369`), the
  chat bearer, admin tokens, the cookie value (HttpOnly, proxied opaquely;
  `STRIPPED_IDENTITY_HEADERS` `index.ts:181` stays). Web has no
  local-session token (`LocalSession.ts:9-13` finds no meta), which is why
  the relay authenticates on the cookie at upgrade.
- Native: same renderer store, plus Bun's `stateDir` and the OS keychain
  (`CloudSeam.ts:3-5`). The per-launch local-session capability is the one
  sanctioned DOM secret (Codex).

## 6. Testing

**Parity matrix (unit, bun): `flows/parity-hosts.test.ts`** (Fable's
fixtures, Codex's surfaces and drift failures). Build two registries from
`cloudCapabilities(...)` and `localCapabilities(...)` (the same functions
the servers call, so the matrix cannot drift from production) and assert,
per flow: (a) `nativeOnly(metadata)` => absent from the cloud registry,
slash tree, model catalog, recommendations, rendered `data-flow` controls
and the `data-flows` manifest (`App.tsx:340`); (b) every cloud-present flow
whose seam touches `/api/cloud/*` or `/api/*` names a prefix in the exported
`PLATFORM_PROXY_RULES` (`smithers-server` is already a devDependency);
(c) `box.terminal` is present iff `cloud.terminal` is. Drift
failures: a declaration naming a capability unknown to
`RuntimeCapabilitySchema`; a capability with no host row; a web DOM
`data-flow` absent from the web registry. A new `local.*` flow fails (a)
with no test edit.

**Worker units (`apps/server/src/index.test.ts`).** `/api/cloud/api/user/
repos` bridges with the bearer; `/api/cloud/api/admin/x` and any prefix
outside the allowlist answer the canonical 404; relay refusals map to the
ADR 0002 close codes (W4); bootstrap equals `cloudCapabilities` per env
shape; the production response carries the CSP with the right hash (W5).

**Component units.** `ChromeBar.test.tsx`: host cloud renders
`chrome-download`, host local does not. `AuthChat.test.tsx`: host cloud
signed-out renders the opening message; host local keeps the empty
transcript. `Instructions.test.ts`: the web line is present and the budget
test stays green. `Commands.test.ts`: `explainAbsent` and the `unavailable`
outcome for slash, button and agent.

**Web e2e (T1w): the `web` Playwright project runs against a deployed
origin, not `wrangler dev` (Codex's "real identity, real repo", pushed one
step further).** Two facts decide it: identity's `ALLOWED_ORIGINS` gate
means a loopback `wrangler dev` cannot sign in without doubling the identity
seam, and the repository forbids mocked backends in e2e (`CLAUDE.md`
invariants). Same `playwright.config.ts`, project `web`: `baseURL =
SMITHERS_WEB_ORIGIN`, no `webServer`, `storageState` built from the existing
`CANARY_SESSION_COOKIE` secret (`canary.yml`) for the signed-in spec, the
account-owned read-only mirrored fixture repo (the T2 pattern,
`e2e/README.md`). Specs in `e2e/playwright/web/`: `boot.web.spec.ts`
(bootstrap `host: cloud`, opening message, `chrome-download`, COOP/COEP/CSP
on the document), `first-value.web.spec.ts` (repo row -> listing card ->
file card, timed), `refusal.web.spec.ts` (`/repo.open` answers the download
sentence with the action). `chromium` ignores `web/**`; `web` ignores the
rest, so nothing is duplicated. `apps-deploy.yml` runs it after the canary
deploy; the production step waits on it; it reruns against
`app.smithers.sh` as the smoke. Pre-merge coverage is the unit layer above,
where the gating logic lives.

## 7. Migration path

**Walking skeleton (W0, proven on canary):** a visitor signs in on the web,
the sidebar lists cloud repos, a repo row renders the listing card, a file
renders the file card, the download button is visible, `/repo.open` answers
the download sentence. Receipt: `docs/web-mode/W0-RECEIPT.md`.

| Lane | Files | Tests | Depends on |
| --- | --- | --- | --- |
| W0 skeleton | `apps/server/src/index.ts` (`handleCloudProxy`: strip `/api/cloud/`, apply `PLATFORM_PROXY_RULES` to the remainder, export the table, add `{ prefix: "/api/user/repos", methods: ["GET"] }`); `packages/rpc/src/AppBootstrap.ts` (+`cloud.terminal`, `cloud.pat`), new `HostCapabilities.ts`, new `AppLinks.ts`; `apps/app/src/bun/server.ts` (emit via `localCapabilities`); `apps/app/src/mainview/flows/{Flows,registry,Commands}.ts` (tags, `hosts`, `nativeOnly`, `explainAbsent`, `unavailable` outcome, `app.download`, `app.download.prompt`, `app` namespace); `state/Instructions.ts`, `state/controller/turns.ts` (host line); `App.tsx` (web opening message); `tabs/ChromeBar.tsx` (footer button only) | `index.test.ts` bridge cases; `parity-hosts.test.ts`; `ChromeBar.test.tsx`; `AuthChat.test.tsx` host-cloud case; `Instructions.test.ts`; `InstructionsBudget.test.ts` green; canary receipt | none (footer and tree rows untouched by sidebar lane A) |
| W1 production Worker | `apps/server/wrangler.jsonc` (`env.production`, `run_worker_first` fix), `scripts/deploy.ts` (`--env`, receipt fields), `scripts/canary/{rollback,build}-probe.ts` (`--worker`, `--origin`), `DEPLOY.md`, `apps/UPSTREAMS.md` (ALLOWED_ORIGINS ops step), `.github/workflows/apps-deploy.yml` (canary on `push: main`, prod on tag), `apps/server/BUILD.ts` (`deployDryRun`) | dry-run per env; `scripts/canary/workflow-wiring.test.ts`; rollback drill receipt | W0 |
| W2 web e2e + targets | `apps/app/playwright.config.ts` (project `web`), `e2e/playwright/web/{boot,first-value,refusal}.web.spec.ts`, `e2e/playwright/web/session.ts` (storageState from the secret), `apps/app/BUILD.ts` (`webBuild`, `webE2E`), `apps-deploy.yml` step, `e2e/README.md` | the three specs against canary; `//apps/app:webE2E` gates the production step | W0, W1 |
| W3 cloud sidebar tree | `flows/Flows.ts` (`repo.tree` -> `runtimeAny: ["Smithers Cloud", "local.repositories"]`), `state/seams/RepoTreeSeam.ts` (cloud branch over `FilesSeam` contents listing), `state/AppState.ts` (`app-repo-tree` row gains `source: "cloud" \| "local"`), `tabs/ChromeBar.tsx` (tree rows under cloud repos) | `RepoTreeSeam.test.ts` cloud case; parity (a); `first-value.web.spec.ts` switches to the tree | W0, sidebar-tree lane A landed |
| W4 terminal relay | new `apps/server/src/terminalRelay.ts`, `index.ts` route `/api/cloud-ws/*` (cookie at upgrade), `cloudCapabilities({ terminal: true })`; `state/CloudTerminalClient.ts` options gain `auth: "subprotocol" \| "cookie"`; `AppController.ts` passes `"cookie"` on host cloud | `terminalRelay.test.ts` (close codes, 64 KiB cap, refusal recovery); `CloudTerminalClient.test.ts` cookie mode; parity (c); `terminal.web.spec.ts` real attach on canary | W0, W2 |
| W5 bundle and headers | `native/NativeBridge.ts` -> `loadNativeDoors`, `ControllerBoot.client.ts`, `vite.config.ts` (`build.manifest`), new `bundle.test.ts`, `apps/app/BUILD.ts` (`bundleContract`), `apps/server/src/index.ts` (CSP + headers in the isolation helper) | manifest pin; CSP hash test; T1 and T1w unchanged | W0 |
| W6 download page and artifacts | `apps/site/src/pages/download.astro` (+ release-manifest reader), `packages/rpc/src/AppLinks.ts` (final URL), `apps-deploy.yml` macOS job (`build:native`, upload to the `apps-v*` release), `apps/app/docs/LOCAL-APP.md` | page renders only manifest rows; `boot.web.spec.ts` asserts the button's href answers 200 | W1; `apps/site` deploy path (site lane) |
| W7 first-value policy and handoff | `apps/server/src/index.ts` (`requireSession` for read-only cloud GETs vs `requireTurnSession` for turns and mutations), `controller/auth-billing.ts` handoff verified against a browser holding the web session | Worker unit: GET repos with a valid non-allowlisted session; T2 handoff scenario | W1, Q1 |

**Risks.**

- R1 `ALLOWED_ORIGINS` on identity and billing live in `smithersai/ui`;
  until an operator adds `app.smithers.sh`, production sign-in 403s. W1
  lists the step; canary proves the code path first.
- R2 `requireTurnSession` (`index.ts:1393-1408`) gates the platform proxy
  on the allowlist, so a non-partner sees repos only after W7. Until then
  the funnel is sign in -> request access -> download.
- R3 Native carries two identities (GitHub cookie + Smithers Cloud PAT):
  `/api/user/*` forwards with the cookie, `/api/cloud/*` with the PAT. Not
  changed here (Q5).
- R4 A Worker-held WebSocket is bounded by Worker limits (1 MiB message, a
  live isolate per session). Frames are capped at 64 KiB by contract and the
  client reconnects. If a limit bites, the fallback is the plue ticket door
  (correction 6) plus its origin-allowlist change.
- R5 No URL scheme in Electrobun 2.0.1 config; deep links stay out until a
  disposable probe proves registration.
- R6 `/api/workflow/` missing from `PRODUCT_PROXY_PREFIXES`; flows/runs on
  native 404 today. One line plus a test, outside these lanes.
- R7 `Flows.ts`, `ChromeBar.tsx` and `RepoTreeSeam.ts` are uncommitted under
  the sidebar lane; W0 touches the first two. Land W0 as a stacked change
  after lane A or rebase its three hunks; never blanket-stage.

**Open questions for will (each with the default the lanes assume).**

1. Does a valid GitHub session without the allowlist get read-only repo
   browsing on web? Default: yes for GET repos, contents, bookmarks; turns
   and mutations keep the allowlist (W7).
2. Production hostname and Worker name? Default: `app.smithers.sh`,
   `smithers-web`; `canary.smithers.sh` stays the preview.
3. Native artifact for the alpha: unsigned zip on the `apps-v*` GitHub
   Release now, notarized macOS arm64 DMG before `smithers.sh/download` is
   linked from anywhere public? Default: yes to both, in that order; no
   Windows or Linux rows until their artifacts pass the same gate.
4. The download page lives in `apps/site` at `smithers.sh/download`, not in
   the app Worker? Default: yes; the button links to the GitHub Release
   until that page answers 200.
5. Should native drop the Smithers Cloud PAT keychain and adopt the Worker's
   cookie->cloud-token bridge so both modes share one identity? Default:
   yes, as a later lane; this plan does not touch `CloudAuth.ts`.

