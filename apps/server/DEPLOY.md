# Deploying `smithers-mvp-web` as the shared edge

The entrypoint is `src/edge.ts`: static site assets plus an unchanged `/api/*`
forward to the shared backend at `SMITHERS_BACKEND_ORIGIN`. Authentication,
bootstrap, chat, model credentials, recommendations, billing, jobs and streaming
all belong to that backend. The edge does not hold active product authority.

`wrangler.jsonc` is the edge (`main` = `src/edge.ts`); `docs/legacy-worker-deploy.md`
records the retired legacy Worker for rollback reference. The first edge deploy
replaces the live legacy version directly, admitted by the committed owner
record `cutover/activation.json` (see "Cutover interlock");
`docs/shared-edge-cutover.md` lists the acceptance receipts.

`wrangler deploy` uses the package's pinned Wrangler through
`scripts/deploy.ts`. It builds the site, runs the read-only preflight, publishes
and writes a receipt. `src/workerIdentity.ts` and `wrangler.jsonc` must agree.
`docs/EFFECT.md` describes the Effect boundary; the old composition is recorded
in `docs/legacy-worker-deploy.md`.

## Frozen identity

The name, domains and six Durable Objects remain frozen. Retained bindings are
`TURN_CANCELS`, `GATEWAY_SESSIONS`, `TURN_LIMITS`, `CLIENT_ERRORS`, `RECOMMEND_LOG`,
and `MODEL_VAULTS`. The six classes and v1–v5 migrations are unchanged. The new
entry exports inert classes solely to retain the unmigrated storage (`cutover/activation.json`). Their
alarms do not launch jobs or delete history.

Never edit these identities as a routine deploy. No `deleted_classes` migration
is part of this cutover. The canary and apex retain their existing routes and
share the same site build, documents, chunks and isolation headers.

### Cutover log

- 2026-10-02 — **per-install GitHub App credentials**: removed the unused App
  id and PEM from the edge secret inventory. Product callers read the backend's
  sealed PostgreSQL store. No live binding or Durable Object identity changed.

- 2026-09-30 — **`IDENTITY_ADMIN_TOKEN` undeclared** (#2145): signup is public
  and the admin allowlist/requests routes are gone, so nothing reads the secret
  and `WORKER_IDENTITY.secrets` no longer lists it. `keep_bindings` keeps the
  live binding, which the preflight now WARNs on as undeclared; the operator
  may `wrangler secret delete IDENTITY_ADMIN_TOKEN`. No identity, binding or
  storage key changes.
- 2026-09-29 — **activated by direct switch** (#1795, #2103): `wrangler.jsonc`
  is the edge and the hosted documents declare the session application target.
  The apex is the GitHub callback origin. The owner (Will) ruled a direct switch
  through the normal deploy path with no rehearsal, fence, export/import or
  staged cutover (smithersai/plue#531). `cutover/activation.json` records that
  decision, the no-user import disposition (legacy Durable Object state retained
  unmigrated under unchanged identities) and, retroactively, the 2026-09-27
  no-user backend bootstrap at plue `0453975821e593aa5718ad7658629d7ed6a034c2`.
- 2026-09-24 — **prepared, not deployed**: switch `src/index.ts` to `src/edge.ts`;
  replace the sibling-service vars with `SMITHERS_BACKEND_ORIGIN`; retain all
  Durable Object identities and encrypted secrets. (Its export/import and fence
  preconditions were superseded by the 2026-09-29 direct-switch ruling.) The detailed historical log is in `docs/legacy-worker-deploy.md`.

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
the retained legacy state and the rollback window have a recorded disposition.

Retained names:

- `SMITHERS_CHAT_AUTH_TOKEN`
- `CHAT_PRODUCT_SERVICE_TOKEN`
- `IDENTITY_SERVICE_TOKEN`
- `PLUE_WORKER_EXCHANGE_TOKEN`
- `BILLING_AUTH_TOKEN`
- `BILLING_PRODUCT_SERVICE_TOKEN`
- `BILLING_ADMIN_TOKEN`
- `ANONYMOUS_TURN_SALT`
- `CEREBRAS_API_KEY`
- `AI_GATEWAY_API_KEY`
- `GITHUB_TOKEN`

Retained knobs: `MODEL_VAULT_KEY`, `SMITHERS_BUILD_SHA`, `UPSTREAM_TIMEOUT_MS`,
`BILLING_CHECKOUT_ENABLED`, `BILLING_PORTAL_ENABLED`, `CEREBRAS_MODEL_LIBRARIAN`, `CEREBRAS_MODEL_FLOWS`.
The site SHA is read from its built `/__build.json`; API bootstrap's SHA belongs
to the shared backend and is never synthesized from that asset stamp.

## Scripted deploy

Use `bun scripts/deploy.ts --dry-run` for a local bundle check. A real deploy is
the CI path below. Preserve the existing script,
domain and migrations. The frontend and API build identities are separate
receipts and both must name the integrated candidate.

Immediately before publication, `scripts/deploy.ts` reads `/api/bootstrap` from
the candidate's configured `SMITHERS_BACKEND_ORIGIN` and decodes it with the
same `AppBootstrapSchema` that the candidate frontend bundles. Network, HTTP,
JSON or schema failures refuse publication and record `bootstrap-compatibility`
in the rollout receipt. The deployment receipt records the successful check's
time, backend origin, backend SHA, API version and decoded capabilities.

Capability names are additive in API version 1. Unknown strings are ignored by
clients; malformed rows and incompatible required fields still fail. Deploy
the tolerant frontend from [#3343](https://github.com/smithersai/smithers/issues/3343)
before adding capabilities served to older strict clients. The frozen released
input schema at `packages/rpc/contracts/app-bootstrap-v1.schema.json` is the
backend release contract; keep it independent of candidate schema generation.

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
   `scripts/deploy.ts` owns publication, the required probes, automatic
   restoration and re-verification. The workflow uploads its receipts as the
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
is the shared backend's responsibility; the legacy Worker already forwards them
there (#2198).
The old deployment-credential gateway relay cannot be reactivated by a secret.
`IDENTITY_ADMIN_TOKEN` is no longer read (#2145); retire it with
`wrangler secret delete IDENTITY_ADMIN_TOKEN`.

### Other upstream services

The only active product upstream is `SMITHERS_BACKEND_ORIGIN`. The identity,
billing and chat sibling Workers are retired; their data disposition and the
operator retirement steps are in `docs/shared-edge-cutover.md` (#3124).

## Rollback

Every real deploy captures the live Worker version and checks it before
publication. Only checks this deploy can affect trigger rollback: CN-1 (served
SHA), the site probe and CN-24 (exact version and rollback target). CN-18 checks
upstream services. Upstream failures mark the run red but never roll back the
Worker. Missing
inputs for a required check, exceptions and timeouts fail the check.

A red baseline permits fix-forward. If the candidate passes its deployment
checks, keep it. If the candidate also fails, the rollout automatically restores
the exact baseline so it never deliberately leaves a worse version live. Record baseline,
candidate and restored checks, including existing failures. A restored check
that was already red does not claim the baseline is healthy; a new failure or
failed restore is `rollback-failed`.

Restoration uses the package's pinned `wrangler rollback <version-id> --yes`,
then re-runs checks against the previous build SHA. It never chooses a target
from version-list ordering or asks an agent or person. The invocation remains
unsuccessful after recovery. A failed edge activation restores the captured
legacy version exactly. That is safe because the legacy Durable Object state was
retained, not migrated: no product state was written anywhere the legacy Worker
would fork from. The only residue is a legacy alarm that fired while the edge was
live: the retired class records a `_smithers_cutover_alarm_v1` marker row and
refuses, so that alarm is not re-armed; the legacy code never reads the marker.
The next edge deploy retries the same recorded switch.

Rollbacks restore code, assets and bindings, not mutable Durable Object or
upstream database state. Releases must preserve storage compatibility.
[Cloudflare's rollback contract](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
describes the provider limitations.

### Receipt version IDs and recovery

Before publication, `deploy-receipts/rollout/latest.json` records the exact
previous version, captured Worker identity and baseline checks. Atomic updates
retain publication, failed checks, rollback outcome and re-verification, with
timestamped copies. The deployment receipt (`deploy-receipts/latest.json`)
embeds the final rollout receipt as `rollout`. A missing `Current Version ID`
after publication triggers restoration too. An unreadable previous build stamp
writes a `refused` receipt without publishing. Dry runs publish and restore
nothing; they still run CN-18, record the result and fail on a red check.

Read the live version from `rollout.status`, not from the exit code or an older
receipt:

| `rollout.status` | Live version | `wranglerVersionId` |
| --- | --- | --- |
| `passed` | candidate | candidate |
| `failed` | candidate; only CN-18 failed | candidate |
| `refused` | previous; nothing published | `null` |
| `rolled-back` | previous, restored and re-verified | previous |
| `rollback-failed` | unknown | `null` |
| `captured`, `prepared`, `publishing`, `checking`, `restoring` | unknown; the process stopped | no deployment receipt |

A deploy that exits before capture (interlock refusal, red preflight) publishes
nothing and writes no receipt. When the live version is unknown, or no receipt
from this run exists, run `bun x wrangler deployments list` from `apps/server`
and compare the live version with `rollout.previous` and `rollout.candidate`.
Fix forward by landing on `main`; break glass with
`bun x wrangler rollback <rollout.previous.version>`.

`scripts/deploy.ts` is the current Actions entry and calls the same policy as
`flows/rollout/flow.ts`. Self-hosters use `executionLayer` from
`flows/rollout/host.ts` with an exclusively leased host, bounded checks and
durable `record` storage; its structured result
is the rollout receipt. Any status other than `passed`, including `rolled-back`,
fails the flow with that receipt. No model or approval is involved.

[Cloud migration #2276](https://github.com/smithersai/smithers/issues/2276)
tracks moving this existing invocation to Cloud and publishing receipts through
the existing app run card. Until then, receipts are Actions artifacts, not app
receipts. Hard runner termination requires host recovery from the prepared
receipt before another deployment; a killed process cannot restore a release.
After rollback, the next deploy may use `rollout/last-rollback.json` to verify
an older live version. The receipt must record a terminal restoration attempt
and a passing CN-24 recheck, the same account, Worker, target version, immutable
version annotations, module identity/digests and newest upload seen at restore.
The guard re-reads live traffic and newest upload to reject races; the
decision table and the owner activation record still apply.
Arbitrary older versions, missing or mismatched evidence and split traffic
remain refused. A red restored baseline can still take the fix-forward path,
even if the restore command reported failure but CN-24 proved the baseline is live.

The existing Actions deploy restores this evidence from the latest applicable
`deploy-receipt` artifact of a completed main-push Deploy apps run, including
failed runs, and carries it into the next artifact. Receipt storage is trusted
host state; self-hosters must retain it under their deployment lease. Missing
or expired evidence cannot authorize an older live version. #2276 retains
ownership of Cloud execution, crash recovery and app receipt publication.

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
run's `deploy-receipt` artifact, so this is a read-only diagnostic for a deployment receipt. The automatic rollout
checks its captured target directly, without relying on this diagnostic’s
version-list ordering or inconclusive exit status.

### The drill — do this once, by hand, and keep the receipt

The automated failure tests exercise rollback and re-verification offline.
This optional production drill retains independent live evidence; it does not
decide recovery after a failed rollout.

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

| checkout \ live | legacy `index.js` | edge `edge.js` | cutover admission / fence / maintenance export |
| --- | --- | --- | --- |
| legacy | deploys | refuses (`DEPLOY_GUARD_LEGACY_OVER_EDGE`) | refuses (`DEPLOY_GUARD_LIVE_CUTOVER`) |
| edge | activation, by owner record | deploys | refuses (`DEPLOY_GUARD_LIVE_CUTOVER`) |

Activation is the one direct switch from the live legacy Worker to the edge. It is admitted only when `cutover/activation.json` validates against the strict schema in `deployGuard.ts`: owner, decision `direct-switch`, source smithersai/plue#531, the no-user `importDisposition` naming exactly the retained Durable Object identities, and the retroactive backend bootstrap record. A missing record refuses with `DEPLOY_GUARD_EDGE_BEFORE_CUTOVER`; an invalid one, or one carrying any unknown field such as an import receipt digest, refuses with `DEPLOY_GUARD_ACTIVATION_UNAUTHORIZED`. The disposition states that nothing was imported; it is not a receipt and nothing accepts it as one. The deploy bundles the artifact first and, after publication, requires the live edge to serve exactly those code modules (`DEPLOY_GUARD_ARTIFACT_DRIFT` otherwise). Activation is admitted whenever the legacy Worker is live and the record validates. After a successful switch CI cannot make legacy live again (legacy over edge refuses, and a rollback targets the previous edge), so in practice the switch happens once; only an operator publishing or rolling back to a legacy version outside CI would make the next edge deploy switch again. It is not pinned to one legacy version because every main deploy before the switch publishes a new one. Once the edge is live, every deploy is normal and the record is never read. There is no override flag or environment switch. A split, unreadable, changing, unrecognized or contradictory live version refuses.
