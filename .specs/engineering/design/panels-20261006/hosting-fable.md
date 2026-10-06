# One product, two deployments: Claude Fable design

Reads: `~/smithers-frontrun` at origin/frontrun (`0384b6be9a`), `~/plue` main. Paths below are repository-relative; `B/` is `packages/backend`, `P/` is `~/plue`.

## 1. Summary

Today the product backend ships two products in one binary: `auth.mode=selfhost` composes the MVP (TODOs, members, secrets, confirmations, flows, machines, GitHub sync) and `auth.mode=multitenant` composes the retired forge (orgs, billing, repository jobs, agent sessions), with 138 non-test branch sites in `B/` and 17 in `apps/app/src` deciding which one a request gets. The design replaces that mode bit with one rule: the product never asks "am I hosted?"; it asks a port, and hosted Smithers is N installs in one database, each install being exactly the MVP's "one team, one repository". Every behavior that truly differs (eleven of them, §2) already has or gets one Go interface in `B/ports` with two adapters: the self-hosted one in `apps/backend` and the hosted one in `P/apps/backend/internal/composition`. Machines get one `WorkspaceRuntime` composite that routes each branch machine to the host that holds its disk: `this-mac` through the existing libkrun adapter, every other computer through the Cloud controller and worker moved from Plue into `B/fleet`. One `release.yml` build produces the Mac bundle and the Linux artifacts the Plue image copies by digest, and one test matrix runs the compose integration suite and journeys J1–J11 against both compositions.

## 2. The seam

Rule: `B/internal/compose` composes from `app.Config` only. `config.IsSingleOwner`, `config.IsMultitenant`, `topology.hosted()`, `webapp.Mode` and `bootstrap.host === "cloud"` are deleted. Each row below is one interface, one place, two adapters. Everything not in the table is product code shared byte for byte.

| Behavior | Interface (lives in) | Self-hosted adapter | Hosted adapter |
| --- | --- | --- | --- |
| Tenancy | `ports.Installs` (new, `B/ports/installs.go`): `Resolve(ctx, *http.Request) (Install, error)`, `List(ctx) ([]Install, error)`. `Install{RepositoryID, OwnerUserID}` | `apps/backend/installs.go`: the one `install_owners` row | `P/.../composition/installs.go`: the `{owner}/{repo}` route param, verified against `collaborators` |
| Identity and sign-in | `ports.GitHubApp` = today's `services.GitHubAppCredentialSource` made public: `AppID`, `ClientID`, `ClientSecret`, `PrivateKey`, `InstallationToken(repo)` | `services.GitHubAppCredentialStore` (sealed rows, manifest flow, spec §12.1) | `services.EnvGitHubAppCredentials` (one platform App; a team installs it on their repository) |
| Sign-in policy | product: GitHub OAuth through the port's App, then `push` permission check (spec §5.1.2) | same | same |
| Database | `app.Config.DatabaseURL` + `B/postgres` | bundled PostgreSQL 18 under `native.Run` | Cloud SQL URL from Helm |
| Blob storage | `ports.BlobStore` (exists) | `B/internal/blob` filesystem under `$STATE/blobs` | `P/internal/cloudstorage` GCS |
| Repository storage | `ports.RepositoryEndpointResolver`, `RepositoryPlacement`, `RepositoryProvisioning` (exist) + `repohost.Client` | `localbootstrap.Client()` in-process | `P/internal/clusterstorage` router + storage sets |
| Machines | `workspace.WorkspaceRuntime` (exists) + `workspace.CapacityReporter` (new, §4) | `B/microsandbox` (libkrun via `msb`) for `this-mac`; `B/fleet/runtime` for registered computers | `B/fleet/runtime` for every host |
| GitHub App ownership | same port as identity; the budget tracker becomes one policy (`NewGitHubResponseBudgetTracker`) | install-made App | platform App |
| Secrets | `ports.SecretKey`: `Current() []byte`, `Previous() [][]byte` (today `SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY`) | `$STATE/config/secrets.json` (0600) | Kubernetes secret |
| Model access and metering | `modelproxy.Keys` + `admission.Policy` (exist). `OwnerModelKeys` is per install in both | `OwnerModelKeys` only; `UnlimitedBillingPolicy` | `OwnerModelKeys` per install (BYOK) plus `PlatformModelKeys` for the Cerebras fast model; `admission.NewMetered` |
| Origins, TLS | `ports.Origins`: `Known(ctx) []Origin`; one `middleware.EffectiveOrigin` in both | `services.InstallAddress` (owner-set + loopback) | `SMITHERS_PUBLIC_URL` (one origin) |
| Upgrades | product `services.QuiesceGate` + `POST /api/install/quiesce` (exist) | `smthrs host upgrade` drives quiesce, backup, brew, migrate | Helm pre-upgrade hook drives quiesce per install, the migration Job, rollout |
| Observability | `TraceExporter`, `MetricsCollectors` (exist); log field `install_id` | none, `/metrics` on the product router | Cloud Trace exporter, private collectors |
| Billing (later, M-09) | `commerce.Service` (exists); `/api/billing` mounts when `Commerce != nil` | nil | `P/internal/stripecommerce` |

Data shapes that change:

```sql
-- B/db/product/migrations/0131_install_tenancy.sql
ALTER TABLE install_settings ADD COLUMN repository_id BIGINT REFERENCES repositories(id);  -- team settings
CREATE TABLE host_settings (key TEXT PRIMARY KEY, value JSONB NOT NULL);                    -- address, capacity, upgrade marker
CREATE TABLE install_owners (repository_id BIGINT PRIMARY KEY REFERENCES repositories(id), user_id BIGINT NOT NULL REFERENCES users(id));
-- self_host_owners (singleton) is dropped; collaborators already carries repository_id.
```

`host_settings` has no tenant because a self-hosted Mac has exactly one host; hosted has no row at all and reads the same keys from Helm through `ports.Origins` and the fleet. Every other product table already carries `repository_id` (`mythical_items`, `workspaces`, `chat_turns`, `approvals`, `flow_loads`, `collaborators`).

Route shape: install-wide routes that are unprefixed today (`/api/todos`, `/api/members`, `/api/secrets`, `/api/github/sync`, `/api/install/*`; `B/internal/compose/router.go:955-1045`) become `/api/repos/{owner}/{repo}/...` in both deployments. The catalog descriptor is the source (E-14), so the CLI and `catalog.mvp.json` regenerate. Do this before launch: it is the one route change that is cheap now and a migration later.

## 3. Tenancy model

Hosted does not get a second identity model. An install is a `repositories` row plus `install_owners` and `install_settings(repository_id)`. A self-hosted Mac has one. Smithers Cloud has one per team repository, and a team with two repositories has two installs, which is mvp.md §1.4's "one repository per install" applied as is.

- **Scoping.** `ports.Installs.Resolve` runs once per request in `router.go` before authentication and puts `Install` in the context. Services take `repositoryID` as they do now; the 16 `InstallMainMirror()` and 25 install-service special cases in `B/internal/services` read the install from context instead of a process-wide fact. Workers (`gitHubMainPullService.Start`, `mythicalService.Start`, `memberRecheck`) already iterate repositories; they iterate `Installs.List`.
- **Routing.** Self-hosted: the resolver returns the only row and ignores the path, so `http://localhost:4000/owner/name` and `/api/repos/owner/name/...` work as today. Hosted: the resolver reads `{owner}/{repo}` from the route and 404s like a hidden private repository when the caller is not on that install's roster (spec §5.2.1a's byte-identical refusals carry over).
- **Isolation.** Tenant data never shares a row: `install_settings`, `collaborators`, `workspaces`, `mythical_*`, `chat_turns`, `approvals`, `flow_loads`, `wiki_*` all key on `repository_id`. The guard is a query audit test (`scripts/check-go-boundaries.py` already walks sqlc queries): every query on a tenant table must bind `repository_id`. Machines are isolated by the runtime (one VM per workspace, egress policy per install). The fleet tables (§4) carry `repository_id` on every placement.
- **Owner and roles.** `install_owners.user_id` is the owner; Maintainer and Member stay `collaborators.permission`. The hosted "sign up" is Setup steps 3–8 (`B/internal/services/repository_setup.go`: `sign_in`, `repository`, `models`, `source`, `machine`) run against the platform App; steps 1–2 (`address`, `app_manifest`) are skipped because `ports.Origins` and `ports.GitHubApp` are platform-supplied. Same card, same service, two fewer steps.
- **Capacity.** Self-hosted: the sum of the Mac and registered computers (§4). Hosted: `admission.Policy` grants slots per install from the fleet's free capacity; the product's people-first FIFO (E-11) is unchanged.

Nothing in the product branches on "how many installs". The compose integration tests gain a two-install fixture so the single-install path is proven to be the N=1 case.

## 4. Machines

One contract, `workspace.WorkspaceRuntime` (`B/workspace/contracts.go:516`), already has two conforming implementations: `B/microsandbox` (local `msb`, libkrun) and Plue's `workspaceruntime.Runtime` over the controller client (`P/apps/backend/internal/composition/workspaceruntime/runtime.go:230`). Will's ruling (spec §8.13.0) makes the second one the remote mechanism. The design:

```
 services.MachinePlacement (product; spec §8.13.4–8.13.6: summed capacity, Runs on, sticky disk, pause, unreachable)
   └─ placement.Runtime  implements WorkspaceRuntime, routes by workspaces.host   (B/fleet/placement)
        ├─ "this-mac"  → microsandbox.Runtime      libkrun via msb              (B/microsandbox)
        └─ "<name>"    → fleet.Runtime             controller client            (B/fleet/runtime)
                            └─ fleet controller: registry, scheduler, placement generations   (B/fleet/control)
                                  ├─ self-hosted: an in-process duty of the host service, served on the bind address
                                  └─ hosted: the same package as its own Deployment
                                        └─ workers: `smithers-worker` on beaver, or a DaemonSet pod per KVM node (B/fleet/worker)
```

- **Move, don't fork.** `P/internal/microsandbox/{client,control,worker}`, `P/cmd/microsandbox-{controller,worker}` and `P/.../workspaceruntime` move to `B/fleet`. They are a runtime adapter, not product code, and the self-hosted install cannot depend on private code (AGENTS.md: public builds must not depend on private files). Plue keeps Dockerfiles, the Helm DaemonSet, mTLS certificate issuance and GCS. The five private fleet tables (`P/db/private/migrations/000001`: hosts, instances, operations, snapshots, grants) become product migrations `fleet_hosts`, `fleet_placements`, `fleet_operations`, `fleet_snapshots`, `fleet_grants`, each with `repository_id`.
- **Per-branch machines** stay the `workspaces` row (E-03) with a new `host` column (NULL means `this-mac`). `CreateWorkspace` is the only call that chooses a host (`auto` or Runs on); every later call routes by the stored host, which is spec §8.13.5's "a machine that has a disk wakes on the host that holds it".
- **Sleep and wake** are `StopWorkspace` (disk kept) and `StartWorkspace` on the holding host in both adapters; capture before stop (spec §8.4.3) is product code over `ExecuteCommand` and `ReadFile`.
- **Capacity** becomes an explicit contract instead of three type assertions (`compose/main.go:432-446`): `workspace.CapacityReporter{Profile(ctx) (HostProfile, error); InUse() int; FreeDisk(ctx) (int64, error)}`. Local: `microsandbox.Detect`. Fleet: the worker's signed heartbeat profile in `fleet_hosts`. `InstallCapacityService` sums reporters over reachable, unpaused hosts.
- **Shared working copy** is identical because the VM is the single writer in both; the host service only ever talks to `smithers-machined` through the relay. The one capability the fleet adapter must add is `workspace.HostEndpoints` (the product API, model proxy and relay URLs a guest dials): local answers the loopback bridge port (`microsandbox.Config.HostPorts`), fleet answers the install's public origin. That is why Add computer requires a bind address: a worker dials the install, so a loopback-only install (spec §1.4) cannot host a remote computer. Settings says so in one line; nothing else changes.
- **Secrets into machines**: both adapters implement `WorkspaceEgressSecrets` (local `B/egressrelay`, fleet per-sandbox egress proxy). Kept as adapter internals.
- **`sandbox.Provider`** (`B/sandbox/provider.go:44`, `app.Config.ComputeProvider`) is a second compute model used only by cut features (agent sessions outside TODOs, hosted CI jobs, repository gateways, golden snapshots, previews). It is deleted with those features (§8 cuts).

`remoteSandboxes` (spec §8.13.2) gates only `placement.Runtime` admitting a host other than `this-mac`; hosted sets it on and has no `this-mac`.

## 5. Build, release and test

**One build.** `.github/workflows/release.yml` already has `server-bundle` (macos-15, `build-native.ts`), `native-helper`, `installer-archive` and `homebrew-bottle`. Add one `linux-artifacts` job producing `smithers-backend` and `smithers-worker` for linux-amd64 and linux-arm64, the TS host bundles, web assets and the guest image, and extend the existing manifest the installer publishes with their sha256 values. Plue's `apps/backend/Dockerfile` stops rebuilding Go from the pinned module (`P/apps/backend/Dockerfile:19-30`) and copies the release artifacts by the digests in `release-manifest.json`, which `P/.../composition/release.go` already embeds and validates. The Mac bundle and the Linux image are two packagings of one build.

**Test matrix.**

| Layer | What | Runs against |
| --- | --- | --- |
| Unit | product rules, no mode | once |
| Port contract | one conformance suite per port in `B/ports/*_contract_test.go` (today only `runtime_contract_test.go` and `B/workspaceconformance`) | both adapters: fs and GCS emulator; in-process and router repo-host; sealed and env GitHub App; owner and platform keys; unlimited and metered admission; install and platform origins; local msb (Mac runner) and fleet (Linux KVM runner, `beaver`) |
| Compose integration | `B/internal/compose/*_integration_test.go`, e.g. `TestDeadCredentialRepoRoutesComposedInstallPostgres` | a table over two `app.Config` fixtures: `installFixture()` (one install) and `hostedFixture()` (two installs, metered stub, env App) |
| Walk | `apps/app/e2e/local/{setup,team}-no-github.spec.ts` against the GitHub and model fakes | both compositions, every PR |
| Journeys | `apps/app/e2e/real/*` J1–J11 (`j1-activation.spec.ts`, `todo-*.spec.ts`, `members.spec.ts`, `wiki-*.spec.ts`…) | self-hosted on the reference mini; hosted through `run-real-e2e.ts --target hosted` against a dev cluster with a canary install |
| Hosted rehearsal | J1h = sign in on Cloud, add repository, first merged TODO within 30 min; J2–J11 unchanged | production, canary install, replaces `P/e2e/playwright/canary/*.canary.ts` |
| Fault, performance | unchanged | self-hosted now; hosted when the fleet lands |

Duplication removed: the Plue canary suite (repo-crud, issue-crud, landing, lfs, push-callback) tests the forge the MVP cut; it is deleted, and Plue's CI gate `e2e` runs the smithers journey specs.

## 6. What breaks today

1. **Two products behind one mode bit.** `B/internal/config/auth_mode.go` (`selfhost` | `multitenant`) reaches 138 non-test sites: `compose/router.go` 51, `compose/main.go` 37, `services/auth.go` 15, `compose/chat_routes.go` 7, `routes/auth.go` 4, `compose/github_sync.go` 4, `middleware/auth.go` 3, `config/validation.go` 3, `compose/flow_composition.go` 3, `compose/chat_composition.go` 3, `compose/bootstrap.go` 3, plus 16 `InstallMainMirror()` / `InProcess()` reads in `services`. The MVP surfaces are install-only: `/todos`, `/members`, `/secrets`, confirmations, `/flows`, `/github/sync`, `/branches/{b}/diff`, terminals and the live channel mount only under `IsSingleOwner` (`router.go:963-1045`); `composeBranchMachines` refuses hosted outright (`main.go:181`); `EnableTodoPublication`, `EnableTodoAdmission`, `EnableTodoSteering`, `SetTodoFlow` and the chat sources are single-owner only (`main.go:1122-1130, 1378-1399`). Hosted today cannot run a TODO.
2. **Hosted keeps the retired forge.** Route families, services and tables that `middleware.RejectTenantProvisioning`, `RejectLocalAuth`, `RejectDeferredCommerce` and `RejectDeferredTriggerManagement` (`middleware/tenant_routes.go`) hide by path on the install still mount in hosted: `/api/orgs`, `/api/admin/{orgs,users}`, `/api/auth/local`, repository jobs, trials, check receipts (`router.go:636-652`), agent sessions and egress audit (`router.go:1544`), Auth0 (`main.go:562-575`), `linear_*`, `alpha_*`, `onboarding_answers`, `oauth2_*`, `local_credentials` tables. Plue "has not launched" (`P/docs/architecture/shared-backend-cutover.md`), so no user depends on them.
3. **The app forks too.** 17 sites read `bootstrap.host === "cloud"` or `capabilities.includes("install")`: `state/controller/turns.ts:99` (chat needs sign-in), `AppController.ts:1284` (cookie vs subprotocol live auth), `:2180` (`hostSpendsOwnKey`), `flows/entries/branch.ts:78-100` ("Terminal unavailable" on an install), `box.ts:67` ("Branch unavailable" on an install), `wiki.ts:25`, `HostOpening.ts:68`. `B/webapp/handler.go:23` serves two index variants (`web-selfhost`, `web-plue`).
4. **Two machine runtimes for one contract.** `B/microsandbox` and `P/.../workspaceruntime` plus `P/internal/microsandbox` implement `WorkspaceRuntime` separately (files, terminal, services, egress secrets each written twice). Plue's boundary script whitelists the name collision (`P/scripts/check-shared-backend-boundary.ts`, `distinctPackages`). Capacity is bolted on by type assertion (`main.go:432-446`).
5. **Two compute models.** `workspace.WorkspaceRuntime` and `sandbox.Provider` (`app.Config.ComputeProvider`, `RuntimeStores` with golden snapshots, gateways, orphans, egress audit, environment images) coexist; the install has no `ComputeProvider`, so `sandboxClient` is nil on every path it feeds.
6. **Fleet state is private.** `P/internal/sandboxstore` and `P/db/private/migrations` hold hosts, placements, operations, snapshots and grants. The install's `remoteSandboxes` (spec §8.13, T-RMT-02..05 on hold) would have to recreate them. `remoteSandboxes` has no code yet in either repository.
7. **Divergent GitHub sync and import.** `newGitHubBudget` picks two budget policies, `composeGitHubSync` two fetcher factories, `ConfigureInstallSync` install-only (`github_sync.go:23-56`); `GitHubImportWorkspaceProvisioner` vs `GitHubImportProductProvisioning` (`main.go:1003-1012`); `repositoryStorageReconciler` starts in both branches (`main.go:2061, 2079`). `selectGitHubAppCredentials` (`main.go:2340`) exists only to refuse the env adapter on an install.
8. **Divergent origins, auth and wiki.** `EffectiveOrigin` (install) vs `CanonicalBrowserAuthOrigin` (hosted, `router.go:352`); `validateSingleOwnerBrowserSecurity`, `validateOptionalProviders`, `validateBilling` tie billing mode to auth mode (`config/validation.go:84-125, 279`); `middleware/auth.go:228-276` `BindInstallCredential` and `TokenCredentialKind(..., IsSingleOwner)`; `cfg.FeatureFlags.Wiki = true` forced on the install (`main.go:324`) and two wiki sync workers (`main.go:1989-2003`).
9. **Hosted-only packages in the product module.** `B/commerce`, `B/credits`, `B/modelprice`, `B/previewgateway`, `B/operator`, `B/provisioning`: contracts are fine, but previews, operator key tooling and the credits ledger's routes serve the cut forge.
10. **Two assemblies and two e2e worlds.** `build-native.ts` assembles the Mac bundle; Plue's Dockerfile rebuilds Go and pins TS hosts by digest. `apps/app/e2e/real` holds J1–J11; `P/e2e/playwright/canary` holds forge CRUD.

## 7. Work needed

Sizes are agent-days. Every item names the test that proves it. "Before" items are the ones whose cost grows after launch (routes, schema, the mode bit); "After" items are hosted-only or fleet work.

### Before the self-hosted MVP launch

| # | Item | Size | Depends on | Proof |
| --- | --- | --- | --- | --- |
| A1 | Tenant key on the singleton stores: `install_settings.repository_id`, `host_settings`, `install_owners`; drop `self_host_owners`. `InstallAddress`, capacity and the upgrade marker read `host_settings` | 2 | — | migration gate (C-PRC-02); `TestInstallSettingsScopedByRepository` with two repositories in one database |
| A2 | Install-wide routes under `/api/repos/{owner}/{repo}/` from the catalog descriptor; CLI and `catalog.mvp.json` regenerate | 2 | A1 | C-CAT-01 allowlist; the 116 Playwright specs green |
| A3 | `ports.Installs` and the context install; delete `auth.mode`, `topology.multitenant`, `IsSingleOwner`, `IsMultitenant`, `webapp.Mode`. One lane per file: `router.go`, `main.go`, `services/auth.go` + `middleware/auth.go`, the rest | 4 (four lanes) | A1, A2 | a boundary test that greps `B/` for the deleted symbols; compose integration suite green; `e2e/local/*-no-github` walk on every lane |
| A4 | Delete the retired forge: orgs, admin users, local auth, Auth0, repository jobs and trials, agent sessions, `sandbox.Provider` and the fleet `RuntimeStores`, `previewgateway`, `linear_*`, `alpha_*`, `onboarding_answers`, `oauth2_*` tables and routes | 3 (three lanes) | A3 | `TestRetiredTablesAbsent`; C-CAT-01; `mvp-deferred-doors.spec.ts` |
| A5 | `ports.GitHubApp` public, both adapters, one budget policy; delete `selectGitHubAppCredentials`; one import provisioning path | 2 | A3 | GitHub App contract test per adapter; sync integration tests under both |
| A6 | `ports.Origins`; one `EffectiveOrigin` middleware; delete `CanonicalBrowserAuthOrigin` and the three mode validators | 1 | A3 | C-INS-03 table run under both adapters |
| A7 | App capabilities from ports: server computes `terminal`, `branch`, `model.owner-paid`, `billing`, `sign-in.github`; delete the 17 app branches and the "Terminal unavailable" / "Branch unavailable" install refusals | 2 | A3 | unit tests per removed branch; `navigation-frames`, `todo-*`, `members` specs |
| A8 | Compose two-fixture table: `installFixture()` and `hostedFixture()` for every `*_integration_test.go` in `compose` | 2 | A3 | the suite itself, twice |
| A9 | Query audit: every sqlc query on a tenant table binds `repository_id` (`scripts/check-go-boundaries.py`) | 1 | A1 | the audit's own negative test |

A1, A2 and A9 run in parallel on day 1; A3's four lanes start when A2 lands; A4–A8 fan out behind A3.

### After launch

| # | Item | Size | Depends on | Proof |
| --- | --- | --- | --- | --- |
| B1 | Move the fleet from Plue to `B/fleet/{client,control,worker,runtime}`; product migrations for the five fleet tables with `repository_id`; Plue keeps Dockerfiles, Helm, certs; bump Plue's pin | 4 + 2 (Plue) | A4 | `P/scripts/check-shared-backend-boundary.ts` passes with the packages gone; `B/workspaceconformance` against `fleet.Runtime` with one dev worker |
| B2 | `workspace.CapacityReporter` on both adapters; `InstallCapacityService` sums reporters; delete the type assertions | 1 | B1 | capacity unit tests; C-MCH-04 |
| B3 | `placement.Runtime` composite, `workspaces.host`, Runs on, sticky disk, pause, unreachable, Remove (spec §8.13.4–8.13.6) behind `remoteSandboxes` | 3 | B1, B2 | conformance against the composite with two fake hosts; C-RMT-02, C-RMT-04 |
| B4 | Controller as a host-service duty; `smithers-worker` join line from Settings (design placement.md); worker dials; Add computer refuses without a bind address | 3 | B3 | a real microVM run on `beaver` from the mini (recorded); C-RMT-03 |
| B5 | Hosted composition = N installs: `Installs` adapter from the route; "Add repository" = Setup steps 3–8 on the platform App | 2 | A8 | `hostedFixture` two-install tests; J1h on a dev cluster |
| B6 | `run-real-e2e.ts --target hosted`; delete the Plue canary suite; canary = J1h + J2 on production | 2 | B5 | J2–J11 green against the dev cluster |
| B7 | One build: `linux-artifacts` job, manifest digests; Plue image copies artifacts, no Go rebuild | 2 | — | `release_test.go` pin check; two builds of one commit yield equal digests |
| B8 | Upgrade parity: Helm pre-upgrade hook quiesces per install through the product gate | 1 | B5 | C-REL-03 run as a rolling upgrade with work in flight |
| B9 | Model access in hosted: per-install `OwnerModelKeys` (BYOK) plus platform Cerebras seat; metering through `admission.Policy` | 2 | B5 | model proxy tests over both key sources per install; C-SEC-03 |
| B10 | Secrets and observability ports: `ports.SecretKey` with rotation test in both; `install_id` on metrics and logs | 1 | A3 | rotation test; a metrics assertion per install |
| B11 | Billing (M-09): `/api/billing` mounts on `Commerce != nil`; Plue Stripe adapter unchanged | 1 | B5 | commerce integration tests under `hostedFixture` |

B1, B5 and B7 start in parallel the day after launch; B2–B4 chain behind B1; B6, B8–B11 behind B5.

## 8. Risks and open questions

| Risk or question | Position | Cheap falsification |
| --- | --- | --- |
| The fleet worker code assumes Linux KVM (`/dev/kvm`, cgroups) and cannot run `this-mac` | Keep two adapters: libkrun local, fleet remote. The composite hides it | Build `B/fleet/worker` for darwin and run one `msb` boot on the mini: one day. If it works, `this-mac` becomes a worker too and `B/microsandbox` shrinks to the executor |
| A loopback-only install cannot accept a dialing worker | Add computer requires a bind address; the form says so | Read spec §1.4; confirm no reverse-dial path is wanted by asking product once |
| One missed `repository_id` predicate leaks data across installs in hosted | A9's query audit plus A8's two-install fixture | Write the audit first and run it against `B/db/product/queries`; count the misses today |
| Removing 138 branch sites regresses the install mid-MVP | File-by-file lanes, each gated by the compose suite and the no-GitHub walk; the install is the only composition with tests today | Land `router.go` first; if the walk breaks, the lane is one revert |
| Hosted = N installs with one repository each is not the product Will wants (teams with several repositories, an org switcher) | mvp.md §1.4 defers multi-repository; two repositories are two installs | One question to the product Fable proxy with this sentence; no code waits on it |
| Moving fleet tables into the product schema bloats self-hosted | Five tables, empty when no computer is added | Count after B1; delete if any stays unused |
| Plue's Dockerfile consuming prebuilt binaries loses reproducibility | Digests pinned in `release-manifest.json`, already validated at startup | Build twice from one commit and compare sha256 |
| Deleting `sandbox.Provider` removes something a hosted customer uses | Plue has not launched (cutover doc) | `grep -rn ComputeProvider` after A4; zero callers outside tests |
| `smithers-56`'s `beaver` spike contradicts the controller-as-duty shape | Spec §8.13.0 leaves "where the controller runs" open; this design answers "in the host service" | Read the spike receipt when it lands; if the controller must be its own process on the Mac, B4 becomes a second launchd job and nothing else moves |

Action: start A1, A2 and A9 today; they are schema and route changes that only get more expensive.
