# Deploying `smithers-mvp-web` as the shared edge (candidate)

The entrypoint is `src/edge.ts`: static site assets plus an unchanged `/api/*`
forward to the shared backend at `SMITHERS_BACKEND_ORIGIN`. Authentication,
bootstrap, chat, model credentials, recommendations, billing, jobs and streaming
all belong to that backend. The edge does not hold active product authority.

**Cutover is held.** This is the runbook for `wrangler.edge.jsonc`, not the
active deployment; `../DEPLOY.md` covers the live legacy Worker. Activation copies
`wrangler.edge.jsonc` over `wrangler.jsonc`, sets `WORKER_IDENTITY.entry` to
`src/edge.ts`, restores the hosted client half of 5d776f34b, and deploys over
the cutover fence, only after `shared-edge-cutover.md` has every receipt.

`wrangler deploy` uses the package's pinned Wrangler through
`scripts/deploy.ts`. It builds the site, runs the read-only preflight, publishes
and writes a receipt. `src/workerIdentity.ts` and `wrangler.jsonc` must agree.
`EFFECT.md` describes the Effect boundary; the old composition is recorded
in `../DEPLOY.md`.

## Frozen identity

The name, domains and six Durable Objects remain frozen. Retained bindings are
`TURN_CANCELS`, `GATEWAY_SESSIONS`, `TURN_LIMITS`, `CLIENT_ERRORS`, `RECOMMEND_LOG`,
and `MODEL_VAULTS`. The six classes and v1–v5 migrations are unchanged. The new
entry exports inert classes solely to retain storage after migration. Their
alarms do not launch jobs or delete history.

Never edit these identities as a routine deploy. No `deleted_classes` migration
is part of this cutover. The canary and apex retain their existing routes and
share the same site build, documents, chunks and isolation headers.

### Cutover log

- 2026-09-24 — **prepared, not deployed**: switch `src/index.ts` to `src/edge.ts`;
  replace the sibling-service vars with `SMITHERS_BACKEND_ORIGIN`; retain all
  Durable Object identities and encrypted secrets. Activate only with verified
  shared-backend, drain, encrypted-export/import, and browser-session receipts.
  Rollback includes the coordinated backend authority fence, not just a Worker
  rollback. The detailed historical log is in `../DEPLOY.md`.

## The preflight

`bun scripts/adopt-durable-objects.ts` is read-only. It compares live settings
against the declared identity, including domains, assets and retained bindings.
It detects unintended `new_sqlite_classes`, `deleted_classes` and
`renamed_classes` changes. It does not prove that data was migrated or that the
shared backend is ready. The candidate's intentional var change is recorded
above; old plain-text sibling URLs are no longer active configuration.

## Secrets: set once with `wrangler secret put`, kept by every deploy

The stateless edge requires no product secrets. Existing secrets are kept by
every deploy through `keep_bindings`, for encrypted export and rollback. The
preflight reports names and presence only. Do not rotate or delete them until
the migration and rollback window have a recorded disposition.

Retained names:

- `SMITHERS_CHAT_AUTH_TOKEN`
- `CHAT_PRODUCT_SERVICE_TOKEN`
- `IDENTITY_SERVICE_TOKEN`
- `PLUE_WORKER_EXCHANGE_TOKEN`
- `IDENTITY_ADMIN_TOKEN`
- `BILLING_AUTH_TOKEN`
- `BILLING_PRODUCT_SERVICE_TOKEN`
- `BILLING_ADMIN_TOKEN`
- `ANONYMOUS_TURN_SALT`
- `CEREBRAS_API_KEY`
- `AI_GATEWAY_API_KEY`
- `SMITHERS_GITHUB_APP_ID`
- `SMITHERS_GITHUB_APP_PRIVATE_KEY`
- `GITHUB_TOKEN`

Retained knobs: `MODEL_VAULT_KEY`, `SMITHERS_BUILD_SHA`, `UPSTREAM_TIMEOUT_MS`,
`BILLING_CHECKOUT_ENABLED`, `BILLING_PORTAL_ENABLED`, `CEREBRAS_MODEL_LIBRARIAN`, `CEREBRAS_MODEL_FLOWS`.
The site SHA is read from its built `/__build.json`; API bootstrap's SHA belongs
to the shared backend and is never synthesized from that asset stamp.

## Scripted deploy

Use `bun scripts/deploy.ts --dry-run` for a local bundle check. A real deploy is
the CI path below after the cutover gates pass. Preserve the existing script,
domain and migrations. The frontend and API build identities are separate
receipts and both must name the integrated candidate.

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

Every `/api/*` request uses the configured shared origin. Path, query, body,
Origin, session cookies, bearer/token credentials, CSRF headers, statuses,
redirects, response cookies and streams retain the common backend contract.
Caller-supplied proxy identity headers are removed. A missing backend returns
503; an unreachable backend returns 502; a header timeout returns 504. The
edge never falls back to old product handlers.

### 1.0 gateway migration

The old `/rpc`, `/projections`, `/sync` and `/health` product mounts remain
retired. Static site redirects may still serve documentation addresses. The
shared authenticated routes are `/api/workflow/provision` and
`/api/workflow/rpc`; every call names a box (`workspaceId`). Their authorization
is the shared backend's responsibility.
The old deployment-credential gateway relay cannot be reactivated by a secret.

### Other upstream services

The only active product upstream is `SMITHERS_BACKEND_ORIGIN`. Identity, chat
and billing sibling Workers are retirement subjects in the cutover manifest,
not dependencies of `src/edge.ts`. Do not disable them before their data and
in-flight work have verified disposition.

## Rollback

Cloudflare Workers keep prior versions. Nothing rolls back automatically:
the Deploy apps workflow reports a bad deployment by failing, and an operator
rolls back from a credentialed shell. Every version's message starts with its
sha, so `bun x wrangler deployments list` finds the version to return to. To
roll back to the immediately prior version:

```sh
bun x wrangler rollback --message "rollback to <git sha from receipt>"
```

run from `apps/server`, with the same `CLOUDFLARE_API_TOKEN` set. This
targets the immediately-prior version; for a specific historical version, use
`bun x wrangler deployments list` to find its Version ID and
`bun x wrangler rollback <version-id>`. Rollback does not touch Durable Object
state: storage for all six bindings listed above is unaffected, since it is
keyed to the unchanged Worker identity, not to a version. A rollback also
restores that version's bindings, secrets included.

### Receipt version IDs and recovery

`scripts/deploy.ts` parses the `Current Version ID` line wrangler prints and
writes it as `wranglerVersionId`, the key `scripts/canary/rollback-verdict.ts`
reads. A successful real deploy writes that ID to a timestamped receipt and
`deploy-receipts/latest.json`. A `--dry-run` publishes nothing and has no
version ID, so its receipts in `deploy-receipts/dry-run/` legitimately carry
`"wranglerVersionId": null` and `"dryRunMode": "bundle"`.

If wrangler succeeds but prints no version id, the script
exits with status 1 after publishing. It writes no fresh receipt;
`deploy-receipts/latest.json` still describes the previous deployment if it
exists. The nonzero exit does not undo the publish. A changed API shape or a
token without the deployments read permission can trigger this guard.

1. Preserve the command output and the build's recorded git SHA and dirty
   flag. Confirm the active version with
   `bun x wrangler deployments list` from `apps/server`, using the same
   Cloudflare account and credentials. Do not use an older receipt as evidence
   of what just published.
2. Check the API response and repair the reader if its shape has changed, then
   re-run the scripted deploy to obtain a fresh receipt. If redeploying is
   unsuitable, record the verified version ID by hand in a separate receipt
   with `worker`, `dryRun: false`, `gitSha`, `gitDirty`, `timestamp`, and
   `wranglerVersionId` from this publish; do not relabel an older receipt or
   guess an ID.
3. Run `bun scripts/canary/rollback-probe.ts` against the fresh receipt (use
   `--receipt <path>` for a manual receipt), then verify the deployed build with
   `bun scripts/canary/build-probe.ts https://canary.smithers.sh --sha <gitSha>`.

### Probe it: `scripts/canary/rollback-probe.ts`

```sh
CLOUDFLARE_API_TOKEN=<token> bun scripts/canary/rollback-probe.ts
```

It asserts three things about `smithers-mvp-web`:

1. the newest receipt (`deploy-receipts/latest.json`, or `--receipt <path>`)
   names a version id,
2. that version is the one Cloudflare is actually serving
   (`GET /accounts/<account>/workers/scripts/smithers-mvp-web/deployments`),
3. a prior version is still in Cloudflare's version list
   (`GET .../versions`), so `wrangler rollback <id>` has a target. The probe
   prints the exact rollback command for that version.

Both response shapes were read back from the live account on 2026-08-18:
`/versions` answers `{ success, result: { items: [{ id, number, metadata: {
created_on }, annotations }] } }` newest first, and `/deployments` answers
`{ success, result: { deployments: [{ versions: [{ version_id, percentage }] }] } }`
newest first.

**"Reachable" means rollback-eligible, not fetchable.** A prior Worker version
has no public URL; nothing can HTTP it. The probe never claims otherwise.

It skips (exit 0, `skip:` lines) when `CLOUDFLARE_API_TOKEN` is unset or no
receipt is on disk, and reports `INCONCLUSIVE` rather than `PASS` when it
verified nothing. It fails when a receipt exists but cannot support a
rollback. Receipts are gitignored; the deploy workflow keeps each one as its
run's `deploy-receipt` artifact, so this belongs in the deploy workflow after a
real deploy, not in a scheduled canary that has no receipt to read.

### The drill — do this once, by hand, and keep the receipt

A rollback plan nobody has ever exercised is not a rollback plan. Rolling back
and forward swaps the live deployment, so it is a human drill and is
deliberately not automated.

1. Take the receipt of the newest green Deploy apps run:
   `gh run download <run id> -R smithersai/smithers -n deploy-receipt`. Its
   `wranglerVersionId` is version **N**.
2. Run `bun scripts/canary/rollback-probe.ts --receipt <path to latest.json>`.
   It must pass and must name the prior version, **N-1**.
3. `bun x wrangler rollback <N-1 id> --message "CN-24 drill"` from
   `apps/server`, which runs this package's wrangler.
4. Confirm `https://canary.smithers.sh` serves the older build, and that
   `bun x wrangler deployments list` shows N-1 at 100%.
5. Roll forward: `bun x wrangler rollback <N id> --message "CN-24 drill, forward"`.
6. Confirm the canary serves N again and re-run the probe.
7. Add a line to "Drill record" below with the date, both version ids and
   the rollback and roll-forward timestamps.

#### Drill record

Not run yet.


## Cutover interlock

Every real deploy first runs `scripts/deployGuard.ts`, before it reads the revision, builds or spawns wrangler. It compares this checkout's entry (`src/index.ts` legacy, `src/edge.ts` shared edge) with the live version's entry module and annotations:

| checkout \ live | legacy `index.js` | edge `edge.js` | cutover admission / maintenance export | cutover fence |
| --- | --- | --- | --- | --- |
| legacy | deploys | refuses | refuses | refuses |
| edge | refuses | deploys | refuses | activation only |

Activation replaces the final fence with the exact artifact the release gate rehearsed. Its digest is in `deploy.ts --dry-run`'s receipt (`artifactSHA256`). The gate's hook (`SMITHERS_EDGE_ACTIVATION_AUTHORIZE`, subcommand `authorize-edge`) must authorize it while holding the production lease and naming the verified cutover and import receipts. There is no override flag. An unrecognized or contradictory live version refuses. While the shared edge is on main before the cutover, CI deploys refuse with `DEPLOY_GUARD_EDGE_BEFORE_CUTOVER`.
