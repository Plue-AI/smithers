# Deploying `smithers-mvp-web`

> Retired 2026-09-27: `smithers-mvp-web` deploys the shared edge (`../DEPLOY.md`).
> This is the legacy Worker's runbook, kept for rollback reference only.

The deployable is one Cloudflare Worker, `smithers-mvp-web`, serving the
smithers.sh Astro build (`apps/site`, which prerenders the product app at
`/<owner>/<name>` as a React island) as static assets and the `/api` seams. The
legacy raw gateway proxy is removed (see the 1.0 migration below). The canary
Worker uses `canary.smithers.sh`.

The Worker is deployed with `wrangler deploy` over `wrangler.jsonc`
(`wrangler` is a devDependency of this package, so the version is the
lockfile's); `scripts/deploy.ts` builds the site, runs the preflight, runs
wrangler and writes the receipt. `src/workerIdentity.ts` is the identity as
plain data, and `src/workerIdentity.test.ts` holds `wrangler.jsonc` to it field
by field, so the file that deploys and the object the tests pin cannot drift.
`docs/EFFECT.md` describes the Worker's composition.

Secrets are set once with `wrangler secret put` and kept by every deploy; the
deploying shell never carries a value ("Secrets" below).

## Frozen identity — read this before touching `src/workerIdentity.ts`

The Worker's `name` (`smithers-mvp-web`), its custom domain
(`canary.smithers.sh`), its apex route, and its six Durable Objects are
deliberately frozen in `src/workerIdentity.ts` (`WORKER_IDENTITY`), and
`src/workerIdentity.test.ts` pins every field:

- Six Durable Objects (`TURN_CANCELS`, `GATEWAY_SESSIONS`, `TURN_LIMITS`,
  `CLIENT_ERRORS`, `RECOMMEND_LOG`, `MODEL_VAULTS`; classes `TurnCancelRegistry`,
  `GatewaySessionRegistry`, `TurnRateLimiter`, `ClientErrorLog`,
  `RecommendLog`, `AccountModelVault`) hold state keyed to this Worker's identity (`GatewaySessionRegistry` is retired: it
  answers 410 and stores nothing new). Renaming the
  Worker, or deploying under a different name, creates a **fresh** Worker
  with **fresh, empty** Durable Object storage: the existing state is
  orphaned, not migrated. Renaming a class or a binding is a migration, and
  a deploy carries one out without asking (next section).
- The `canary.smithers.sh` custom domain and the `smithers.sh/*` zone route
  follow whichever Worker declares them. Changing or removing either detaches
  it from this Worker.

Never edit `WORKER_IDENTITY.name`, `domain`, `routes`, or `durableObjects` as
part of a routine deploy. If the identity or domain genuinely needs to change,
that is a separate, deliberate decision, recorded in the cutover log below and
in the test, never a side effect of a deploy.

One such deliberate change is on record. The product for a repository lives at
`https://smithers.sh/<owner>/<name>`, so `routes` also carries a zone route
beside the canary custom domain. It began as three narrow routes
(`smithers.sh/smithersai/*`, `smithers.sh/api/*`, `smithers.sh/assets/*`, zone
`8ebd98d2f0dc7d8db2e61f31ebc19c14`) while `smithers.sh` itself was a separate
assets-only Worker; since this Worker serves the whole site build, one route,
`smithers.sh/*`, claims every apex path (see the cutover log below).
`www.smithers.sh/*` also reaches this Worker and redirects to the apex.
`runWorkerFirst` claims `/*` so repository slugs, casing, HTML headers, and
host redirects are handled before asset navigation. Catalog URLs redirect
mixed case to lowercase; available repositories use the app document and
coming-soon repositories use their site page. Other GitHub repository slugs
use the shared app document when no site asset exists. Invalid paths retain
the site's 404. The Worker name, canary domain, and Durable Object state
are unchanged; the cutover log records the route rollback.

The second deliberate change is the assets directory. `assets.directory` is
`../site/dist`, the smithers.sh Astro build, instead of `../ui/dist`, the
app's own Vite build, and `notFoundHandling` is `404-page` instead of
`single-page-application`: the app is a prerendered page of that build at
`/<owner>/<name>/index.html`, so one build is deployed instead of two. The
Worker fetches that page from the assets layer for a catalog repository path
and for a frame path (`/w/<workspace>/b/<branch>/f/<frame>`) and adds
the isolation headers; every other path
passes through as the site serves it, and the canary hostname marks HTML
`noindex`. The `/_astro/*` chunks carry `Cross-Origin-Embedder-Policy:
require-corp` and `Cross-Origin-Resource-Policy: same-origin` from the build's
own `apps/site/public/_headers`, because the app's OPFS SQLite module worker is
one of those chunks and a browser refuses a worker script whose embedder policy
is weaker than its owner document's (`net::ERR_BLOCKED_BY_RESPONSE`, then a
silent fall back to localStorage). `scripts/canary/site-probe.ts` grades one
such chunk on every deploy. The name, routes, Durable Objects and migrations are
untouched (`src/workerIdentity.test.ts` pins them), so state is unaffected.
Rollback: restore `directory: "../ui/dist"` and `notFoundHandling:
"single-page-application"`, build `apps/app` (`bun run build:web`) and deploy,
or roll the Worker back to the prior version id from the last receipt (see
"Rollback" below); the assets travel with the version, so the rollback
restores the previous build without a rebuild.

### Cutover log

- **2026-09-27 — `GatewaySessionRegistry` retired (#2198).** The box's coding
  host on the Smithers backend serves `/api/workflow/{provision,rpc}` and
  `/api/repository-setup/*`; this Worker forwards them as the signed-in user
  (`src/workflows.ts`, `src/repositorySetup.ts`). The class, binding and
  migration identity stay, now the retired class in
  `src/retainedDurableObjects.ts`: it serves 410 and leaves a marker for any
  alarm still scheduled. Its stored gateway records and setup requests are not
  migrated or deleted; a setup request admitted before the cutover answers
  404 on the backend and the app offers Retry, which asks again. Rollback: the
  prior version restores the live class over the same storage.

- **2026-09-23 — deploys move to the Deploy apps workflow.** From 2026-09-13
  to 2026-09-23 a Stop hook on one laptop (outside this repository) ran
  `scripts/deploy.ts` for every local `main` commit with no test gate: about
  520 versions, each `Source: Unknown` with no message, seven of them commits
  that exist on no branch. `.github/workflows/apps-deploy.yml` now deploys
  every push to `main` after the apps gates, and `scripts/deploy.ts` refuses a
  real deploy of a dirty tree or of a commit not on origin/main, so the hook
  can no longer ship an unpushed or rewritten commit. Each version is tagged
  with its sha's first 12 characters and its message starts with the full sha.
  No Worker identity, binding or storage change. Rollback of the path: none
  needed; a version rolls back with `bun x wrangler rollback <id>`.

- **2026-09-21 — frontend telemetry export (configuration/deployment pending).**
  Declare `PLUE_WORKER_EXCHANGE_TOKEN` on this Worker with the same value as
  the API's `SMITHERS_AUTH_WORKER_EXCHANGE_TOKEN`. No value was read or set
  during the local review. This adds a secret declaration only; Worker names,
  domains, DO identities and persisted keys are unchanged by this fix.
  Admitted `/api/telemetry/errors` reports send one bounded background POST to
  `${SMITHERS_CLOUD_API_BASE_URL}/api/telemetry/errors`, with only `client`,
  build version and a fixed `Error` type. Browser credentials, addresses,
  report text and URLs remain out of the export. The API's matching bearer
  selects its dedicated 120/minute Worker telemetry quota; the public quota
  remains 10/minute. Release both sides together with the matching binding.
  `202 accepted` remains local admission, not proof of export. Missing config,
  storage failure, transport timeout (at most 5 seconds for headers), and
  non-204 responses produce sanitized `client-error telemetry` log records;
  the local ring and chat remain usable. Release validation still needs the
  API `client_error_reporting` flag enabled and a verified increase in
  `smithers_client_errors_total{client="web"}`. No deployment was performed.

- Account provider vault (2026-09-20): append `MODEL_VAULTS=AccountModelVault`
  and migration `v5`; preserve every existing namespace and migration.
  Preflight permits only this named additive cutover when missing live, and
  still rejects renames and deletions. OPTIONAL secret `MODEL_VAULT_KEY` is
  base64 of 32 random bytes for AES-256-GCM. Without it (or if malformed),
  enrollment reports `vault_unavailable`; deployment models and identity work
  unchanged. Install once, interactively from `apps/server`:
  `pnpm exec wrangler secret put MODEL_VAULT_KEY --name smithers-mvp-web`.
  Keep the encryption key backed up; provider rotation uses the product's
  Rotate operation, not replacement of this key. Encryption-key replacement
  requires a separate ciphertext migration; a wrong key fails closed.
  Rollback: disable the optional secret or roll back the Worker version;
  retain the namespace and `v5`, never delete stored pins to roll back code.

- Worker routing and headers (2026-09-14, deployed 2026-09-14):
  `run_worker_first` now claims `/*` so any GitHub repository slug, case
  normalization, HTML security headers, HTTPS, and www redirects reach the
  Worker before asset navigation. Existing site assets and legacy redirects
  still resolve through ASSETS; valid repository paths missing an asset use
  the shared app document. Coming-soon documents are emitted at lowercase
  paths. `www.smithers.sh/*` joins the apex route and answers 301 to the
  apex. No Durable Object identity or storage changes. Rollback: restore the
  prior owner-prefix list and remove the www route together in wrangler.jsonc
  and workerIdentity.ts, then land on `main`.

Every deliberate change to the frozen identity, newest last, with its
rollback. `src/workerIdentity.test.ts` and `src/index.test.ts` pin the current
state, so a new entry here lands in the same commit as the test change.

- Three apex zone routes (`smithers.sh/smithersai/*`, `/api/*`, `/assets/*`)
  added beside the canary custom domain so the product lives at
  `smithers.sh/<owner>/<name>`; rollback = delete the routes and deploy.
- Assets directory moved from `../ui/dist` (SPA) to `../site/dist` (the
  smithers.sh Astro build, `404-page`); rollback = restore both fields, build
  `apps/app`, deploy, or roll back to the prior version id.
- Apex route `smithers.sh/*` added on 2026-09-07 so one Worker serves every
  apex path. The three narrow routes left every other apex path, `/_astro/*`
  included, to the old assets-only Worker `smithers-site-v1` through its
  custom domain, so the app page HTML came from the new build and its
  `/_astro` chunks from the old one (404). A zone route takes precedence over
  a custom domain on the same hostname (the live `/api/*` route proved it).
  Rollback = restore the three narrow routes and deploy (seconds).
  `smithers-site-v1` left the repository on 2026-09-24: this zone route had
  shadowed its apex custom domain since this change. Roll back with this
  Worker's own versions ("Rollback").
- Deploy tool moved from Wrangler to Alchemy 2 (2026-09-09) and back to
  wrangler (2026-09-12). The Alchemy path uploaded the binding set wholesale
  (`keepBindings: undefined`, `alchemy@2.0.0-beta.76` `WorkerProvider.ts:3584`),
  so it could not run without every live secret's value in the deploying
  shell, and nobody had them; it never deployed. The identity is byte for
  byte the same on both sides; wrangler keeps the live secrets
  (`keep_bindings: ["secret_text"]`) and sends only the migration steps after
  the live tag (`v4`, unchanged). Rollback of any version = `wrangler rollback
  <prior version id>`.

## The preflight (read before every deploy)

`wrangler deploy` uploads the Durable Object bindings and migrations
`wrangler.jsonc` declares and reports none of the following as an error, each
of which is Durable Object data loss:

| Declared vs live | What the upload carries | Effect |
| --- | --- | --- |
| binding name absent live | a `new_sqlite_classes` step | a fresh, empty namespace |
| live binding absent from the declaration | a `deleted_classes` step | the namespace and its storage are deleted |
| same binding, different class name | a `renamed_classes` step | a class rename, unwanted |

`scripts/adopt-durable-objects.ts` reads the live script settings, domains,
routes and subdomain state (GETs only) and compares them with
`src/workerIdentity.ts` and `wrangler.jsonc`. Every `FAIL` is a Durable Object
mismatch, a frozen var drift, a compatibility drift, or a route held by
another Worker; it exits 1 and `scripts/deploy.ts` refuses to continue. Every
`WARN` names something the deploy changes (a var it adds or drops, a route it
removes, a leftover secret to retire by hand). Secrets are reported by name as
live or not, never by value, and never fail: the deploy keeps them.

### Procedure

1. Export `CLOUDFLARE_API_TOKEN` (and `CLOUDFLARE_ACCOUNT_ID`; it defaults to
   the frozen account). Nothing here prints a value.
2. Preflight, read-only:
   ```sh
   cd apps/server
   bun scripts/adopt-durable-objects.ts
   ```
   A clean run passes all six bindings by name and class, the five frozen
   vars, the domain and routes, `workers.dev` off, the compatibility date and
   flags, and every required secret. Each `WARN` names a leftover to retire.
3. Dry run:
   ```sh
   pnpm run deploy:dry     # site build + `wrangler deploy --dry-run`
   ```
   The dry run bundles `src/index.ts`, reads the assets directory and prints
   the bindings it would upload (six Durable Objects, `ASSETS`, five vars).
   It reads no live script and needs no credential; step 2 is the verdict.
4. Deploy:
   ```sh
   CLOUDFLARE_API_TOKEN=<token> pnpm --filter smithers-server run deploy
   ```
   `scripts/deploy.ts` runs the preflight again, then `wrangler deploy`,
   parses the `Current Version ID` wrangler prints and writes the receipt.
5. Verify: `bun scripts/canary/build-probe.ts https://canary.smithers.sh --sha
   <gitSha from the receipt>`, then a signed-in turn (the
   `TURN_CANCELS`/`TURN_LIMITS` path), `GET /api/admin/errors` and
   `GET /api/admin/recommend/log` as an admin (the `CLIENT_ERRORS` and
   `RECOMMEND_LOG` namespaces still answer with their history), and a
   workflow provision (forwarded to the backend). Empty logs that were not empty
   before the deploy mean a namespace was recreated: roll back at once
   (below) and read the preflight output again.

## Secrets: set once with `wrangler secret put`, kept by every deploy

wrangler uploads the script with `keep_bindings: ["secret_text"]`, so every
secret on the live script survives a deploy from a shell that does not carry
it. Setting or rotating one is a hand step, never a deploy input:

```sh
cd apps/server
bun x wrangler secret put IDENTITY_SERVICE_TOKEN    # prompts; never pass the value on the command line
bun x wrangler secret list                         # names only
```

`src/Config.ts` reads each name below from the Worker's `env` bag into
`ServerConfig` as `Redacted`. `WORKER_IDENTITY.secrets` marks each one
required or not and states what the Worker does while it is unset. The
preflight prints that state for every missing secret and FAILs on a missing
required one (`SMITHERS_CHAT_AUTH_TOKEN`, `IDENTITY_SERVICE_TOKEN`,
`CEREBRAS_API_KEY`, `AI_GATEWAY_API_KEY`), because each leaves a core route
refusing every user:

| Name | Spent by |
| --- | --- |
| `SMITHERS_CHAT_AUTH_TOKEN` | the chat forward (`POST /api/agent/turn`) |
| `CHAT_PRODUCT_SERVICE_TOKEN` | vouching the validated login to chat |
| `IDENTITY_SERVICE_TOKEN` | `/api/identity/validate` |
| `PLUE_WORKER_EXCHANGE_TOKEN` | `/api/telemetry/errors`; matches API `SMITHERS_AUTH_WORKER_EXCHANGE_TOKEN` |
| `IDENTITY_ADMIN_TOKEN` | `POST /api/admin/allowlist`, `GET /api/admin/requests` |
| `BILLING_AUTH_TOKEN` | the admin charge summary |
| `BILLING_PRODUCT_SERVICE_TOKEN` | billing reads as the user |
| `BILLING_ADMIN_TOKEN` | `POST /api/admin/grant` |
| `ANONYMOUS_TURN_SALT` | the anonymous turn buckets |
| `CEREBRAS_API_KEY` | the cloud roles (the Librarian, the Flows agent) |
| `AI_GATEWAY_API_KEY` | Jev: `POST /api/recommend`, `POST /api/jev`, and the turn route's front door |
| `SMITHERS_GITHUB_APP_ID` | the GitHub App JWT (`src/githubApp.ts`) |
| `SMITHERS_GITHUB_APP_PRIVATE_KEY` | the GitHub App JWT (PEM, PKCS#1 or PKCS#8) |
| `GITHUB_TOKEN` | optional override of the App for catalog stats |

Optional knobs are set the same way (`wrangler secret put`) and kept the same
way: `UPSTREAM_TIMEOUT_MS`, `BILLING_CHECKOUT_ENABLED`,
`CEREBRAS_MODEL_LIBRARIAN`, `CEREBRAS_MODEL_FLOWS`.
`MODEL_VAULT_KEY` is also an optional secret (base64 of 32 random bytes), not
a deployment requirement: unset disables account enrollment alone. See the v5
cutover entry for the one-time installation command and encryption-key backup.
`SMITHERS_BUILD_SHA` is
not a binding: `scripts/deploy.ts` bakes it into the site build as
`/__build.json`. The frozen vars (`IDENTITY_UPSTREAM_URL`,
`BILLING_UPSTREAM_URL`, `SMITHERS_CLOUD_API_BASE_URL`, `SMITHERS_CHAT_URL`,
`SMITHERS_CHAT_ORIGIN`) are `wrangler.jsonc` `vars`, deploy as `plain_text`,
and are replaced wholesale on every deploy, so a knob that an old deploy bound
as a plain var (not a secret) is the one thing a deploy drops; the preflight
names it and `wrangler secret put` re-adds it.

Retiring a secret is `wrangler secret delete <NAME>`. A live secret that
`WORKER_IDENTITY` does not declare feeds nothing the Worker reads; the
preflight lists it as a warning until it is deleted.

The secret values above exist only on Cloudflare. They are not in any shell,
repository secret or secret manager, and Cloudflare never reads them back;
rotating one means minting a new value together with the upstream Worker that
checks it.

## Scripted deploy (`scripts/deploy.ts`)

The app's loading shell says that the session is starting until identity has
actually answered. The browser startup watchdog allows 60 seconds for cold
bundles, saved state and identity; its recovery panel leaves React's mount
point intact so a late successful boot can dismiss the panel and continue.
`apps/app/e2e/playwright/startup.spec.ts` holds the boot bundle past that
deadline and checks recovery without resetting saved data.

`scripts/deploy.ts` prepares the Electrobun devkit projection the island's
sources are typed against (`node scripts/ensure-devkit.mjs` in `apps/app`),
builds the site (`pnpm run build` in `apps/site`, stamped with the sha it
records, and read back from `/__build.json` before anything is published),
runs the preflight, then `wrangler deploy --tag <sha12> --message "<sha>
<subject>"`, and writes a receipt (git sha, UTC timestamp, Cloudflare version
id, version tag and message, and the workflow run URL) to `deploy-receipts/`.
The Deploy apps workflow runs it; see "CI (every push to main)".

```sh
# Dry run: real site build, then `wrangler deploy --dry-run`. Bundles the
# Worker and reads the assets; no credential, no live read, nothing published.
# Receipt lands in deploy-receipts/dry-run/.
pnpm run deploy:dry            # from the repo root
# or, equivalently:
pnpm --filter smithers-server run deploy:dry

# Real deploy — requires a Cloudflare credential and a clean commit already
# on origin/main (see below). Receipt lands in deploy-receipts/.
pnpm --filter smithers-server run deploy
```

## CI (every push to main)

`.github/workflows/apps-deploy.yml` ("Deploy apps") is the one deploy path.
Landing on `main` is the deploy. Every push to `main` runs two jobs:

1. `gate` runs the apps targets CI's `apps-e2e` job runs, by the same labels
   (`//apps/app:check`, `:unitTests`, `:conformance`, `:browserE2e`), plus
   `smthrs ci` over `//apps/server/...` and `//apps/site/...`, on the exact
   sha. It never sees a Cloudflare credential.
   `scripts/canary/workflow-wiring.test.ts` fails if its targets fall behind
   `apps-e2e`'s.
2. `deploy` needs `gate` and runs in the `production` environment, whose
   secrets `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` are the only
   deploy credentials; the Worker's own secrets live on the script and are
   kept.
   It runs `scripts/deploy.ts`, then CN-1 (the sha it published), the site
   probe, CN-18, CN-23 and CN-24, and uploads the receipt as the
   `deploy-receipt` artifact.

A manual `workflow_dispatch` run, or a push while the `production`
environment has no token, runs the gates and the dry-run deploy.

Deploys run one at a time and are never cancelled mid-publish. GitHub keeps
one pending run and replaces it on each push, so under load the newest `main`
deploys next and the shas between are skipped, never published out of order.
Production trails `main` by one run, about 30 minutes, more under load.

`scripts/deploy.ts` refuses a real deploy of a dirty tree or of any commit
not on origin/main ("push main first, deploys ship only commits on
origin/main"), whatever runs it. The version it publishes is tagged with the
sha's first 12 characters and its message starts with the full sha, so
`bun x wrangler deployments list` names every version's commit.

### Break-glass human run

Only when the workflow cannot run. The same refusal applies: the checkout
must be clean and its commit already pushed to `main`.

1. **Secret required:** `CLOUDFLARE_API_TOKEN` (a Cloudflare API token scoped
   to the `dd3525a4132493566aeb38de533c8827` account, Workers Scripts + Workers
   Routes + Zone DNS edit permissions). Export it in the shell running the
   deploy.
2. **Account id:** `CLOUDFLARE_ACCOUNT_ID=dd3525a4132493566aeb38de533c8827`;
   `scripts/deploy.ts` defaults it to `WORKER_IDENTITY.accountId` when unset.
3. **Build + deploy:**
   ```sh
   CLOUDFLARE_API_TOKEN=<token> pnpm --filter smithers-server run deploy
   ```
4. **Verify:** the receipt file's path is printed
   (`apps/server/deploy-receipts/latest.json`). Confirm
   `https://canary.smithers.sh` serves the new build
   (`bun scripts/canary/build-probe.ts https://canary.smithers.sh --sha <gitSha>`,
   or the receipt's version id against `bun scripts/canary/rollback-probe.ts`).

## The seams this Worker proxies

### 1.0 gateway migration

The deployment-identity gateway proxy has been removed. `/rpc`, `/projections`,
`/sync`, `/health` and their subpaths return HTTP 410 with
`code: "gateway_proxy_removed"`, including WebSocket upgrade requests. They
never forward under a deployment bearer or a placeholder user. Cross-origin
requests may be refused earlier by the existing same-origin guard. One
exception, by method: the former Mintlify site published its API reference
under `/rpc/<page>`, and `apps/site/public/_redirects` sends each of those
addresses to `/docs/reference/http-api/`. A `GET` or `HEAD` without an upgrade
asks the assets binding and keeps that declared redirect; every other request,
and any path the file does not redirect, is the 410
(`src/RetiredGatewayProxy.test.ts`, `src/staticRedirects.test.ts`).

`GATEWAY_UPSTREAM_URL`, `GATEWAY_AUTH_TOKEN` and
`GATEWAY_SESSION_USER_ID` / `_ROLE` / `_SCOPES` no longer configure this Worker.
Remove leftover legacy secrets with `wrangler secret delete`; they are ignored
and cannot reactivate the proxy, and the preflight lists them until they go. This is a breaking removal,
not an optional hardening flag. A deployment identity is not evidence of an
incoming user's authority to use a workspace.

Product clients use `/api/workflow/provision` and `/api/workflow/rpc`. These
require a validated, allowlisted session; the Worker forwards the body to the
same path on `SMITHERS_CLOUD_API_BASE_URL` with the user's Cloud token
(`forwardToCloud` in `src/proxies.ts`), and the box's coding host on the
backend validates the repository, box and procedure and answers. The Worker
waits up to 255 s for the answer's headers (the backend allows a Plan or Run
four minutes) and reads at most 4 MiB of it. Client-supplied identity headers
cannot select another user. `/api/repository-setup/*` is forwarded the same
way.

The local launch/canary scripts now assert the explicit retirement response.
Their expectations should ship with this Worker version; they are not evidence
that any existing deployment has already been updated.

### Other upstream services

Sign-in, balance, chat turns, and recommendations resolve in sibling
Workers that live in a different repository (`smithersai/ui`, under
`workers/`).
Deploying this Worker does not deploy them, and a broken sign-in is more
often theirs than ours. `apps/UPSTREAMS.md` names each one, its source, its
hostname, and how to deploy it with a receipt.

### Command suggestions need the AI Gateway key

`POST /api/recommend` decides which of the user's commands to suggest next,
and `POST /api/recommend/outcome` records what the user ran. Both are open to
signed-out visitors under their own daily ceilings (300 per address or login,
5000 deployment-wide). The route needs:

- `AI_GATEWAY_API_KEY` (secret, REQUIRED). The route asks Jev through the
  Vercel AI Gateway (`typesafe-ai/jev`, 1.5 s deadline): choice questions
  whose options are the commands the client offered, ordered by the
  probability Jev gives each. A catalog longer than 255 commands is split
  across several questions in ONE request — the gateway answers them in
  parallel — and the answers are merged by probability, so size never changes
  who decides. Every call asks the gateway for zero data retention.
- There is no second model. Jev is the main model: an unset key is a
  `seam_not_configured` 503 naming `AI_GATEWAY_API_KEY`, and a Jev that
  refuses, times out or answers something unreadable is a
  `service_temporarily_unavailable` 503 naming the failure. The route never
  asks an LLM instead, and the app keeps its own rule-based pills. The same
  rule governs the turn route's front door (`src/frontDoor.ts`), which
  refuses with the typed failures a cloud role turn uses for an unavailable
  model.
- The front door splits a long catalog the same way, one command smaller: a
  question offers at most 254 commands plus its own `none`. A split request
  also carries one boolean question, `isCommand`. Probabilities from
  different questions are never compared, so a split answer routes the turn
  only when `isCommand` is at or above 0.85, exactly one question names a
  command at or above 0.85, and every other question answers `none`. Two
  questions each naming a command is ambiguity, and the concierge answers
  that turn. A catalog that fits one question (the client offers 194 today)
  sends exactly the bytes it always sent: one `command` question, no gate.
- `POST /api/jev` is the same key's second door: the browser holds no gateway
  key, so it posts one decision (`{ state, questions }`, at most 8 questions,
  255 options per choice, 32 KiB of state, the 256 KiB body cap) and reads
  Jev's typed answers back. It spends the recommendation ceilings under the
  same buckets, refuses with the same typed 503s, and stores nothing. The
  wiki's `recall` door ranks its keyword shortlist through it.
- `CEREBRAS_API_KEY` is NOT spent here. It belongs to the cloud roles, the
  Librarian and the Flows agent (`src/cloudRoleTurn.ts`), and stays required
  for them.
- `RECOMMEND_LOG` (Durable Object binding, `WORKER_IDENTITY.durableObjects`,
  Wrangler migration `v4`). One row per recommendation, a ring of the newest
  5000, holding a SHA-256 of the chat tail and never the text. Admins read it
  at `GET /api/admin/recommend/log?limit=N`, newest first, to score hit rate
  and top-1 rate. Each row names the model that answered it, so a live score
  still reads one model's rows apart from another's.

### The public catalog's GitHub stats authenticate as a GitHub App

`GET /api/public/repos` reads each catalog repository's stars, forks, and open
issue count from `api.github.com`, one request per repository per cache
refresh, and caches the catalog for five minutes. GitHub allows an
unauthenticated address 60 requests an hour, so a busy hour or a shared egress
address can trip the limit and every landing-page card then shows "Stats
unavailable" until the limit resets.

Those reads authenticate as the GitHub App **`smitherspreviewrelease`** (app id
`4163546`, owned by the `smithersai` organization, installed on that org with
every repository selected), not as anyone's personal access token. The App
credential belongs to the organization, its installation token expires in an
hour, and it can be rotated without touching a person's account. `src/githubApp.ts`
signs a 9-minute RS256 JWT with WebCrypto, calls `GET /app/installations` to
find the `smithersai` installation, exchanges the JWT for an installation
token at `POST /app/installations/{id}/access_tokens`, and holds that token for
55 minutes in the isolate and in the Cache API under a private URL, so a cold
isolate does not exchange again. One `401` on a stats read buys exactly one new
token.

- `SMITHERS_GITHUB_APP_ID` (secret, set on the live script on 2026-09-08 and
  kept by every deploy since): the numeric app id.
- `SMITHERS_GITHUB_APP_PRIVATE_KEY` (secret, set on the live script on
  2026-09-08, same rule): the App's PEM private key, stored exactly as GitHub
  issues it — PKCS#1, `-----BEGIN RSA PRIVATE KEY-----`. The Worker wraps
  that DER in a PKCS#8 `PrivateKeyInfo` before `crypto.subtle.importKey`, so
  no `openssl` conversion is needed; a PKCS#8 key (`-----BEGIN PRIVATE
  KEY-----`) is imported directly.
- `GITHUB_TOKEN` (secret, optional): an **override**. Set, it is sent as the
  bearer and no App exchange happens at all — a fine-grained or classic token
  with no scopes, since every catalog repository is public. Unset, the App
  credential is used. With neither, the reads go unauthenticated.

Every App failure is honest and lands on the anonymous read the catalog has
always had, never a thrown stats route. One warning line names the cause, and
the failure is remembered for five minutes so a broken secret cannot turn every
refresh into two more GitHub calls:

| What went wrong | The line in the Worker's logs |
| --- | --- |
| The App is installed on no organization | `the GitHub App is not installed on any organization` |
| The private key does not import | `the GitHub App private key could not be imported` |
| GitHub refused the lookup or the exchange | `the GitHub App installation lookup answered <status>` / `... token exchange answered <status>` |

The private key, the JWT, and the installation token never enter a log line, a
response body, or a cache key; they leave the Worker only inside the GitHub
request's authorization header.

A 403 or 429 from GitHub nulls that repository's stats and keeps the normal
five-minute cache, so the Worker never retries into a tripped limit. Only a
network error or a 5xx shortens the cache to 30 s.

### The canary and e2e suites sign in as a scoped-down user

The probes that authenticate must hold a plain visitor's session, not an
operator's. Will's ruling (Factory spec 2026-09-08):
open sign-in is on and the permission tiers behind it stay deliberately narrow,
so the canary and e2e suites run as a scoped-down signed-in user and prove the
product works under the permissions a real visitor has. A probe holding an
admin's cookie is green while the deployment refuses everyone else, which is
the permission bug the probe exists to surface.

**The account.** The canary account must be a plain GitHub login that does
NOT appear in the identity Worker's `ADMIN_LOGINS`, does NOT hold a maintainer
claim on any repository, and does NOT appear on the hand-seeded closed-alpha
roster `CANARY_ALLOWLIST_LOGINS`. No such account is configured today:
`codeplanesmithers`, the shared test account, is in `ADMIN_LOGINS`, so its
cookie fails the canary's identity check. Satisfy the ruling one of two ways:
remove `codeplanesmithers` from the identity Worker's `ADMIN_LOGINS`, or create
a second account for the canary.
`codeplanesmithers` is the login the T1 Playwright doubles answer with
(`apps/app/e2e/playwright/identity.ts`).

Until `$CANARY_SESSION_COOKIE` is set, the scheduled canary still runs: the
browser check and the metered turn report `skip`, the run prints a `::warning`
naming the unset variables, and only the unmetered checks can open the alert
issue.

| Variable | Kind | What it names |
| --- | --- | --- |
| `SMITHERS_E2E_USER` | env var for a local `uptime-probe.ts` run | the e2e account's GitHub login, read when `CANARY_SESSION_LOGIN` is unset |
| `CANARY_SESSION_COOKIE` | secret, `Canary` workflow | that account's signed-in cookie header, sent on the hourly tick only |
| `CANARY_SESSION_LOGIN` | repository variable | the login `$CANARY_SESSION_COOKIE` must belong to; the `Canary` workflow reads only this variable, and a cookie with no declared login fails |
| `CANARY_ALLOWLIST_LOGINS` | repository variable | the hand-seeded closed-alpha roster; `invite-probe.ts` reads it back, and `uptime-probe.ts` refuses a cookie belonging to one of those logins |

**The assertion.** `uptime-probe.ts` reads its own session back through
`GET /api/auth/session` before it spends anything. It fails the run, taking no
metered turn at all, when the session carries the `admin` claim, belongs to a
login on `CANARY_ALLOWLIST_LOGINS`, is not the declared account, or
authenticated nobody. When the deployment states no `admin` field and no login
is declared, the check fails rather than guess, and says to set
`CANARY_SESSION_LOGIN`. Rotating the cookie into an operator's account
therefore reddens the canary instead of quietly passing on privileges no
visitor has.

**The one probe that needs admin.** `scripts/canary/invite-probe.ts` reads and
writes the allowlist, so it needs the identity Worker's admin credential. It
declares that credential by its own name, `IDENTITY_ADMIN_TOKEN`, and prints a
`skip:` line naming the missing variable rather than running under some other
identity. Any future probe of an admin surface follows that shape: a separate,
named credential and an honest skip, never a shared privileged session.

## Rollback

Superseded 2026-09-29: rollback, receipt recovery, the rollback probe and the
drill are in `../DEPLOY.md` "Rollback". `scripts/deploy.ts` now restores the
captured version automatically; read the rollout receipt's status there.

### Web Cloud session (2026-09-14)

`GET /api/cloud-auth/session` is served by both the native host and this
Worker. On the web, GitHub OAuth is the Cloud sign-in: `validateSession`
validates the app cookie, `fetchCloudToken` exchanges that login through
`/api/identity/cloud-token`, and a server-side `GET /api/user/workspaces`
checks the Cloud token's scope. Only `{ state, username, expiresAt, scopes? }`
reaches the renderer. An insufficient-scope 403 is a signed-in session with
`scopes: "degraded"`; identity/exchange/probe outages remain failures, never
signed-out answers or invented full-scope sessions.

The renderer keeps one host-independent Cloud session contract. Reading
`/api/auth/session` as though it were the native Cloud session would lose the
Cloud PAT scope verdict: its GitHub scopes are not workspace/agent scopes.
Web identity refreshes load the Cloud row before resuming deferred commands;
native boot independently loads its PAT session. Account epochs discard stale
reads after an identity change.

Cloud gate refusals render the controller's registered sign-in button:
`auth.sign-in` on web, `cloud.sign-in` on native. The agent is directed to
`cloud.prompt`. The same rule covers changes, workspaces, code intelligence,
egress and GitHub. The retained transcript sign-in prompt is a separate
presentation issue: `TranscriptMessage.tsx` and `onboarding/GuideShell.tsx`
render persisted `auth.sign-in` messages independently of the current identity.

Deploy the Worker **and site assets** through `bun apps/server/scripts/deploy.ts`;
this change needs both the route and the web identity refresh wiring. The
real-router regression lives in `apps/app/src/mainview/state/seams/CloudSeam.test.ts`;
`apps/server/src/cloudSession.test.ts` covers exchange and scope failures.

## Cutover interlock

Superseded 2026-09-29: the fence activation and its release-gate hook are gone. The current decision table is `../DEPLOY.md` "Cutover interlock".

Until 2026-09-27 `wrangler.jsonc` stayed on the legacy entry and the edge candidate was a separate file. Swapping the edge into `wrangler.jsonc` before the live version is the cutover fence made every deploy refuse with `DEPLOY_GUARD_EDGE_BEFORE_CUTOVER`; that happened from 5d776f34b until the legacy entry was restored (smithers#1729).
