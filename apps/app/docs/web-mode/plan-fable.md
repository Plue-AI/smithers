# Web mode (funnel) beside native mode (default) — plan and architecture

Fable plan, 2026-09-02, from `web-mode.BRIEF.md`. Every claim below was read
from the tree; corrections to the brief come first because the plan depends
on them.

## 0. Brief corrections (verified against the tree)

## 1. Mode model

**Decision: two axes already in the tree, no new mode enum.**

- Host axis: `bootstrap.host` (`"cloud"` from the Worker, `"local"` from Bun).
  It names which API surface exists. The SPA loads it first
  (`ControllerBoot.client.ts` -> `loadBootstrap`).
- Shell axis: `runtime.shell.kind` (`"native"` when `window.__electrobun`
  exists, `NativeBridge.ts`). It names the two privileged doors
  (`pickLocalRepository`, `openExternal`).
- Web mode = `host: "cloud"` + `shell: "browser"`. Native = `host: "local"` +
  `shell: "native"`. Headless T1 = `host: "local"` + `shell: "browser"`.

**Gating stays on `runtime` tags** (`Commands.ts` `available()` already
refuses a flow whose capability is absent). Two capabilities are missing and
one axis is missing; add them, do not build a parallel capability set:

- `@smthrs/rpc/AppBootstrap.ts`: extend `RuntimeCapabilitySchema` with
  `"cloud.terminal"` (a workspace-terminal tunnel exists on this origin) and
  `"cloud.pat"` (a host-held Smithers Cloud PAT session: `/api/cloud-auth/*`, the
  after lane W3 and never `cloud.pat`.
- `flows/Flows.ts`: `box.terminal` -> `runtime: ["Smithers Cloud", "cloud.terminal"]`;
- `flows/registry.ts` `FlowMetadata`: add `readonly hosts?: ReadonlyArray<AppBootstrap["host"]>`;
  `Commands.ts` `available()` checks it. Used by exactly one flow
  (`app.download`, `hosts: ["cloud"]`), so native chrome gains nothing
  (NO INVENTION).
- Extract the two capability lists into `@smthrs/rpc/HostCapabilities.ts`:
  `cloudCapabilities(env: { identity: boolean; Smithers Cloud: boolean; agent: boolean; checkout: boolean; terminal: boolean }): RuntimeCapability[]`
  and `localCapabilities(opts: { agent; identity; Smithers Cloud; pathEntry }): RuntimeCapability[]`.
  `index.ts` and `server.ts` call them; the parity test (section 6) reads
  the same functions, so the matrix can never drift from the servers.

**Honesty lines.** Today an absent flow is `unknown-command`, and the agent's
`connectorLine` already says "this web client cannot connect any". Make the
refusal name the native app:

- `registry.ts`: `export const nativeOnly = (metadata: FlowMetadata): boolean`
  (true when any `runtime`/`runtimeAny` entry starts with `local.` or is
  `cloud.pat`).
- `Commands.ts`: `readonly explainAbsent: (name: string) => string | undefined`
  over the UNFILTERED `baseFlows`; on `host: "cloud"` a native-only name
  answers `"/repo.open is not in the web app — download the native app
  (/app.download)"`. `settle()` and `parseSubmit`'s `unknown-command` branch
  use it, so slash, button and agent get one sentence.
- `state/Instructions.ts`: `InstructionHonesty.host: "web" | "native"`; one
  generated line on web: "This is the Smithers web app. Local repositories,
  local terminals, build targets and local agents need the native app; when
  asked for one, say so and execute app.download." One line keeps the
  16 KiB `CHAT_INSTRUCTIONS_CAP_BYTES` budget intact.

## 2. Web feature set

| Feature | Web | Native | Both? | Reason (file) |
| --- | --- | --- | --- | --- |
| Cloud repos, files, branches, bookmarks | yes (after W0) | yes | both | seams on `/api/cloud/*`; Worker gets the cookie->cloud-token bridge (`handleCloudProxy`) |
| Issues, PRs, notifications | yes | yes | both | product paths already in `PLATFORM_PROXY_RULES` and `PRODUCT_PROXY_PREFIXES` |
| Changes and review (`change.*`, `prs.review`, land) | yes (W0) | yes | both | `ChangeSeam` via the bridge; landing is atomic server-side (ADR 0001) |
| Workspaces list/open/suspend/fork/snapshot | yes (W0) | yes | both | `WorkspaceSeam` via the bridge |
| Workspace terminal | W3 | yes | both | Worker WebSocket relay (below); gated by `cloud.terminal` |
| Agent chat | yes | yes | both | `WebAgent` -> `/api/agent/turn`; web adds `TURN_LIMITS` per login |
| Flows and runs (`flow.*`, `runs.*`, `approvals.*`) | yes | R6 | both | `/api/workflow/rpc` relay lives on the Worker |
| GitHub import, mirror sync | yes (W0) | yes | both | `/api/github/import` allowlisted; `RepoImportSeam` via bridge |
| Smithers Cloud PAT sign-in (`cloud.sign-in`) | no | yes | native | on web the session cookie IS the cloud identity (`fetchCloudToken`) |
| Local repositories, file tree, `repo.*`, `files.*` local | no | yes | native | `local.repositories`; folder picker is a native door |
| Local terminal (`tab.terminal`, PTY) | no | yes | native | `local.terminal`, `/ws` on Bun |
| Build targets (`target.*`) | no | yes | native | `local.targets`, smithers-build runtime in the bundle |
| Local agents (`agent.delegate`, `tab.harness`) | no | yes | native | `local.harnesses` |
| BYOK keys | no | no | neither (v1) | neither host emits `keys.byok`; Smithers Cloud has no key store (`PLATFORM_UNIMPLEMENTED`). When it lands: secret in Smithers Cloud, never the browser |
| Billing balance | yes | yes | both | `/api/billing/balance` on both origins |
| Billing checkout/portal | when `BILLING_CHECKOUT_ENABLED=1` | no | web | `billing.checkout` capability; money is a browser act |
| World notes | yes | yes | both | OPFS, no seam |
| Download button (`app.download`) | yes | no | web | `hosts: ["cloud"]` |

**Terminal transport decision: a Worker-level WebSocket relay, no Durable
Object, never direct-to-cloud.** Direct-to-Smithers Cloud needs a bearer in the
browser; a browser cannot set `Authorization` on an upgrade, so the token
would ride the URL or subprotocol (logged by proxies, visible in devtools),
and plue's upgrade authenticates Bearer principals (`cloudWsUpstreamHeaders`),
which would need a backend change to accept anything else. The relay keeps
the token where every other seam keeps it: server-side, minted per login by
`fetchCloudToken`. A Durable Object buys hibernation and per-session state
the terminal does not need (the client already reconnects and rate-limits,
`CloudTerminalClient`); it costs a class, a migration and a second hop.
`src/bun/server.ts` lines 152-238 (`CloudWsBridge`, refusal-code mapping,
64 KiB frame cap, status-recovery GET) port to
`apps/server/src/terminalRelay.ts` almost verbatim:
`export const relayWorkspaceTerminal = (request: Request, env: WorkerEnv, login: string, upstreamUrl: URL): Promise<Response>`.

## 3. The funnel

**Signed-out visitor, web (law: auth is a conversation state).** Nothing new
on the page except the download control in the chrome footer.

```
┌ Workspace ─────────┐ ┌──────────────────────────────────────────────────┐
│                    │ │  S  Smithers is a design-partner preview.        │
│  (no repositories) │ │     Sign in with GitHub to see your repositories │
│                    │ │     and start working.                           │
│                    │ │     [ Sign in with GitHub ]                      │
│                    │ │                                                  │
│                    │ │                                                  │
│                    │ ├──────────────────────────────────────────────────┤
│                    │ │ Sign in with GitHub to chat.            [ Send ] │
│ Sign in with GitHub│ └──────────────────────────────────────────────────┘
│ Download the app   │
│              ☾  ↻  │
└────────────────────┘
```

**Signed-in, first minute.** Sign-in is the existing redirect
(`window.location.assign(AUTH_SIGN_IN_PATH)`); the cookie lands on the web
origin; `loadCloudSession` is skipped on web (no `cloud.pat`) and
`loadRepositories` runs through the bridge; the sidebar lists `org/ → repo`;
a file click runs `files.read` and renders the file card. Steps: 1 click,
GitHub consent, 1 click on a repo row, 1 click on a file. No wizard.

```
┌ Workspace ✎ ───────┐ ┌──────────────────────────────────────────────────┐
│ smithersai/        │ │  S  Smithers initialized successfully            │
│  ▾ smithers  head  │ │     - Host: cloud (1.0.0 2f00e3c)                │
│     ▸ apps         │ │     - Capabilities: agent, identity, Smithers Cloud        │
│     README.md      │ │  ┌ /smithersai/smithers/README.md @ qupxosqw ──┐ │
│  ▸ plue      head  │ │  │ # Smithers                                   │ │
│                    │ │  │ Durable-execution engine ...        [ ⤢ ]    │ │
│                    │ │  └──────────────────────────────────────────────┘ │
│                    │ ├──────────────────────────────────────────────────┤
│ Download the app   │ │ Ask Smithers, or type / for flows       [ Send ] │
│              ☾  ↻  │ └──────────────────────────────────────────────────┘
└────────────────────┘
```

**Download button placement.** `tabs/ChromeBar.tsx` `chrome-actions` footer,
the block the file itself calls "the chrome that belongs to no session":
`<button data-flow="app.download" data-testid="chrome-download">Download the app</button>`
rendered when `controller.commands.find("app.download") !== undefined`
(host cloud only, through the registry like every affordance). No banner, no
pill, no second page. The second surface is the refusal line from section 1:
a native-only ask answers in the chat with the same action. Under the
sidebar-tree lane the footer is unchanged, so the two lanes do not collide.

**Flow.** `app.download` (`flows/Flows.ts`, namespace `app`, add
`{ id: "app", label: "App", summary: "The Smithers app itself" }` to
`NAMESPACES`): user + agent, `hosts: ["cloud"]`, handler
`actions.openDownload()` -> `window.open(DOWNLOAD_URL, "_blank", "noopener")`.
`DOWNLOAD_URL` lives in `@smthrs/rpc/AppLinks.ts`.

**Where the page lives, who builds it.** W1 points `DOWNLOAD_URL` at
`https://github.com/smithersai/smithers/releases/latest` (zero pages to
build). W5 adds `apps/app/src/mainview/public/download/index.html`, copied by
Vite into `dist/download/` and served by the same Worker at `/download/`
with no route code; apps/app owns it; `apps-deploy.yml` gains a macOS job
running `build:native` and uploading the artifact to the `apps-v*` release.

**After install.** No shared cookie domain exists (loopback vs
`app.smithers.sh`) and no URL scheme exists, so the handoff is the mechanism
already shipped: the native app's `auth.sign-in` runs
`AUTH_NATIVE_START_PATH` + `openExternal` (`controller/auth-billing.ts`),
the system browser already holds the web session, and the claim returns the
cookie rescoped onto the loopback origin (`rescopeCookie`). One click, no
second GitHub consent if identity honors its own session on
`/api/auth/github/start?handoff=` (verify in W6). `smithers://` deep links
are deferred (R5).

## 4. Build and deploy

**One SPA build.** The runtime already branches on bootstrap; two Vite modes
would fork the bundle for a boolean the server already states. Native-only
code is small and behind capability checks; the one measurable cost is the
static `electrobun/view` import in `NativeBridge.ts`. W4 makes it lazy:
`export const loadNativeDoors = (): Promise<NativeDoors | undefined>`
(dynamic import only when `window.__electrobun` exists), called once in
`ControllerBoot.client.ts`. A pin test reads `dist/.vite/manifest.json`
(`build.manifest: true`) and asserts no `electrobun` module in the
`initial` group.

**Cloudflare topology.**

```
 browser ── https://app.smithers.sh ──► Worker smithers-web (NEW, env "production")
 browser ── https://canary.smithers.sh ► Worker smithers-mvp-web (frozen, stays canary)
                     │  ASSETS ../ui/dist (SPA, /download/)
                     │  /api/bootstrap, /api/agent/*, /api/model/stream
                     │  /api/auth/*, /api/identity/*  ──► smithers-cloud-identity
                     │  /api/billing/*                ──► smithers-cloud-billing
                     │  /api/cloud/* + PLATFORM_PROXY_RULES ─► api.jjhub.tech (Bearer per login)
                     │  /api/cloud-ws/* (W3) ────────── wss api.jjhub.tech terminal
                     │  /api/workflow/*               ──► per-user gateway (GATEWAY_SESSIONS)
                     └─ DOs: TURN_CANCELS, GATEWAY_SESSIONS, TURN_LIMITS, CLIENT_ERRORS (fresh per Worker)
```

- `apps/server/wrangler.jsonc`: keep the top-level identity frozen
  (`DEPLOY.md`); add `"env": { "production": { "name": "smithers-web",
  "routes": [{ "pattern": "app.smithers.sh", "custom_domain": true }],
  "durable_objects": ..., "migrations": ..., "vars": { SMITHERS_CHAT_URL:
  "https://chat.smithers.sh/chat", SMITHERS_CHAT_ORIGIN:
  "https://app.smithers.sh", ... } } }`. Fresh DO storage is correct: all
  four hold ephemeral state. Fix `run_worker_first` to
  `["/api/*", "/rpc/*", "/projections/*", "/sync/*", "/health"]` in the
  same change.
- Secrets per env via `wrangler secret put --env production`:
  `SMITHERS_CHAT_AUTH_TOKEN`, `CHAT_PRODUCT_SERVICE_TOKEN`,
  `IDENTITY_SERVICE_TOKEN`, `BILLING_*`, `GATEWAY_*`. Identity and billing
  `ALLOWED_ORIGINS` must add `https://app.smithers.sh` (sibling repo,
  `apps/UPSTREAMS.md` deploy path).
- `apps/server/scripts/deploy.ts`: `--env <name>` flag; receipt gains
  `env` and `worker`; `scripts/canary/rollback-probe.ts` and
  `build-probe.ts` take `--worker`/`--origin`. Rollback stays
  `wrangler rollback --env production`.
- Preview: canary receives every merge to `main` (workflow_dispatch today;
  add a `push: main` trigger that deploys canary only); production deploys
  on `apps-v*` tags. Version previews (`wrangler versions upload`) are not
  needed while canary is the preview.
- `BUILD.ts` terms: `apps/app/BUILD.ts` gains `webBuild` (the `vite build`
  target, srcs = `src/**`, `vite.config.ts`, outputs `dist/**`) and
  `webE2E` (`Smithers.NodeTest` over `e2e/playwright`, project `web`), kept
  out of the per-push graph like T1; `apps/server/BUILD.ts` gains
  `deployDryRun` (`scripts/deploy.ts --dry-run --env production`) so
  `apps-deploy.yml` runs targets by label. `//:ci` is regenerated, never
  hand-edited.

## 5. State and persistence

- Both modes keep collections in the webview's OPFS SQLite
  (`smithers-mvp.sqlite`); origins differ, so canary, production and the
  loopback app each hold their own store. Nothing to add.
- OPFS needs cross-origin isolation; `withIsolationHeaders` already sets
  COOP/COEP on every asset response. Consequence: no third-party
  subresources without CORP; fonts are bundled, the download page is a
  navigation. Add a CSP in W4:
  `default-src 'self'; connect-src 'self' wss://app.smithers.sh; script-src 'self' 'sha256-<theme bootstrap>'; img-src 'self' data:`
  emitted from the same helper, with a Worker unit test that recomputes the
  inline-script hash from `dist/index.html`.
- Never in the browser: the Smithers Cloud token (minted per login inside the Worker,
  `fetchCloudToken`; relay records in `GATEWAY_SESSIONS`), the chat bearer,
  gateway tokens, admin tokens. The session cookie is set by identity and
  proxied; the SPA never reads it. `STRIPPED_IDENTITY_HEADERS` stays.
- Web keeps no local-session token: `createAppFetch` finds no meta and
  sends plain same-origin requests; `localSocketProtocols()` is empty, which
  is why the terminal relay authenticates on the cookie at upgrade (W3).

## 6. Testing

- **Tier T1w (web).** Same `playwright.config.ts`, second project `web`:
  `webServer` = `bun x wrangler@4.124.0 dev --config ../server/wrangler.jsonc --port 47312`
  with no identity/chat vars (bootstrap answers `host: "cloud"`, capabilities
  from `cloudCapabilities`). Upstreams are doubled with `page.route`
  exactly as `tabs.spec.ts` doubles the Bun seams (`/api/auth/session`,
  `/api/cloud/api/user/repos`, `/api/cloud/api/repos/*/contents`). Specs in
  `e2e/playwright/web/`: `boot.web.spec.ts` (title, transcript, composer,
  `chrome-download` present, `tab-add`/`chrome-sign-in`-gated states),
  `first-value.web.spec.ts` (sign-in double -> repo row -> file card),
  `refusal.web.spec.ts` (`/repo.open` answers the download sentence). No
  duplication of the native specs: they stay on the `chromium` project.
- **Parity matrix (unit, bun).** `flows/parity-hosts.test.ts` builds two
  registries with `cloudCapabilities(...)` and `localCapabilities(...)`
  from `HostCapabilities.ts` and asserts: (a) every flow with
  `nativeOnly(metadata)` is absent on cloud; (b) every flow present on cloud
  whose seam touches `/api/cloud/*` names a path prefix in
  `apps/server/src/index.ts` `PLATFORM_PROXY_RULES` (export the table;
  `smithers-server` is already an apps/app devDependency); (c)
  `box.terminal` is present only when `cloud.terminal` is. Any new
  `local.*` flow fails (a) automatically, so a native-only flow can never
  appear enabled on web.
- **Worker units (`apps/server/src/index.test.ts`).** `/api/cloud/api/user/repos`
  bridges with the bearer; `/api/cloud/api/admin/x` and any prefix outside
  the allowlist answer the canonical 404; `/api/cloud-ws/*` refusals map to
  the ADR 0002 close codes; bootstrap capabilities equal
  `cloudCapabilities` for each env shape.
- **Component units.** `ChromeBar.test.tsx`: host cloud renders
  `chrome-download`, host local does not. `Instructions.test.ts`: the web
  line is present under budget. `Commands` test: `explainAbsent`.
- **Deploy gate.** `apps-deploy.yml` runs T1 and T1w before any deploy;
  post-deploy `build-probe` checks the sha on the deployed origin.

## 7. Migration path

**Walking skeleton (W0, proves the funnel end to end on canary):** a visitor
signs in on the web, the sidebar lists cloud repos, a file renders, the
download button is visible, `/repo.open` answers the download sentence.

| Lane | Files | Tests | Depends on |
| --- | --- | --- | --- |
| W0 skeleton | `apps/server/src/index.ts` (`handleCloudProxy`: strip `/api/cloud/`, apply `PLATFORM_PROXY_RULES` to the remainder, add `{ prefix: "/api/user/repos", methods: ["GET"] }`, `/api/user/workspaces` already present); `packages/rpc/src/AppBootstrap.ts` (+`cloud.terminal`, `cloud.pat`), new `packages/rpc/src/HostCapabilities.ts`, `packages/rpc/src/AppLinks.ts`; `apps/app/src/bun/server.ts` (emit via `localCapabilities`); `apps/app/src/mainview/flows/{Flows,registry,Commands}.ts` (tags, `hosts`, `nativeOnly`, `explainAbsent`, `app.download`); `state/Instructions.ts`, `state/controller/turns.ts` (host line); `tabs/ChromeBar.tsx` (button) | `index.test.ts` bridge cases; `parity-hosts.test.ts`; `ChromeBar.test.tsx`; `Instructions.test.ts`; `InstructionsBudget.test.ts` stays green; manual canary proof recorded in `docs/plans/web-mode.W0-RECEIPT.md` | sidebar-tree lane A (footer untouched, tree rows read `repositories`) |
| W1 production Worker | `apps/server/wrangler.jsonc` (`env.production`, `run_worker_first` fix), `scripts/deploy.ts` (`--env`), `scripts/canary/{rollback,build}-probe.ts` (`--worker`, `--origin`), `DEPLOY.md`, `apps/UPSTREAMS.md` (ALLOWED_ORIGINS ops step), `.github/workflows/apps-deploy.yml` (canary on main, prod on tag), `apps/server/BUILD.ts` (`deployDryRun`) | `deploy.ts` dry-run per env; `workflow-wiring.test.ts` keeps probe callers; rollback drill receipt | W0 |
| W2 web e2e tier | `apps/app/playwright.config.ts` (project `web`), `e2e/playwright/web/{boot,first-value,refusal}.web.spec.ts`, `e2e/playwright/wrangler-webserver.ts`, `apps/app/BUILD.ts` (`webBuild`, `webE2E`), `apps-deploy.yml` step, `e2e/README.md` | the three specs; `//apps/app:webE2E` runs in `apps-deploy.yml` | W0 |
| W3 terminal relay | new `apps/server/src/terminalRelay.ts` (port of `server.ts` 152-238), `index.ts` route `/api/cloud-ws/*` (cookie session at upgrade), `wrangler.jsonc` `cloud.terminal` emission via `cloudCapabilities`; `state/CloudTerminalClient.ts` options gain `auth: "subprotocol" \| "cookie"`; `AppController.ts` passes `"cookie"` on host cloud | `terminalRelay.test.ts` (close codes, 64 KiB cap, refusal recovery GET); `CloudTerminalClient.test.ts` cookie mode; parity (c) | W0 |
| W4 bundle and headers | `native/NativeBridge.ts` -> `loadNativeDoors`, `ControllerBoot.client.ts`, `vite.config.ts` (`build.manifest`), `apps/server/src/index.ts` (CSP in `withIsolationHeaders`), new `apps/app/src/mainview/bundle.test.ts` | manifest pin; CSP hash test; T1 and T1w unchanged | W0 |
| W5 download page and artifacts | `apps/app/src/mainview/public/download/index.html` (+ `download.css`), `packages/rpc/src/AppLinks.ts` (`/download/`), `apps-deploy.yml` macOS job (`build:native`, release upload), `apps/app/docs/LOCAL-APP.md` | T1w asserts `/download/` serves 200 with the release link; `deploy.ts` dry-run copies the page | W1 |
| W6 first-value polish | `apps/server/src/index.ts` (`requireSession` vs `requireAllowlisted`: read-only cloud GETs need a valid session only), `controller/auth-billing.ts` handoff verification against a browser that already holds the web session, optional `electrobun.config.ts` URL scheme | Worker unit: GET repos with a valid non-allowlisted session; T2 handoff scenario | W1 |

**Risks.**

- R1 `ALLOWED_ORIGINS` on identity and billing live in `smithersai/ui`; until
  an operator adds `app.smithers.sh`, production sign-in 403s. W1 lists the
  step; canary proves the code path first.
- R2 The allowlist (`requireTurnSession`) gates the platform proxy, so a
  visitor who is not a design partner sees repos only after W6. Until then
  the funnel is sign in -> request access -> download.
- R3 Native carries two identities (GitHub cookie + Smithers Cloud PAT) while web
  carries one; `/api/user/*` on native forwards with the cookie and
  `/api/cloud/*` with the PAT. Not changed here (Q5).
- R4 A Worker WebSocket is bounded by the Worker's own limits (1 MiB
  message, no CPU budget beyond piping); frames are capped at 64 KiB by
  contract, and the client reconnects. If Cloudflare terminates idle sockets
  the client's existing backoff covers it.
- R5 No URL scheme in Electrobun 2.0.1 config today; deep links stay out
  until proven with a disposable probe.
- R6 `/api/workflow/` is missing from `PRODUCT_PROXY_PREFIXES`; flows/runs on
  native are unproven. Separate fix, one line plus a test.
- R7 `run_worker_first` stale entries mean gateway mounts serve HTML today;
  the W1 fix changes routing for any client depending on that accident.

**Open questions for will (each with the default the lanes assume).**

1. Does a valid GitHub session without allowlist get read-only repo browsing
   on web? Default: yes for GET repos/contents/bookmarks; turns and
   mutations keep the allowlist.
2. Production hostname and Worker name? Default: `app.smithers.sh`,
   `smithers-web`; `canary.smithers.sh` stays the preview.
3. Native artifact signing: notarized DMG or an unsigned zip on GitHub
   Releases for the alpha? Default: unsigned zip behind `releases/latest`
   for W1/W5; notarization before the funnel goes public.
4. Terminal on web in the first release or after? Default: after W0-W2, as
   W3, Worker relay, no Durable Object.
5. Should native drop the Smithers Cloud PAT keychain and adopt the Worker's
   cookie->cloud-token bridge so both modes share one identity? Default: yes,
   as a later lane; this plan does not touch `CloudAuth.ts`.

