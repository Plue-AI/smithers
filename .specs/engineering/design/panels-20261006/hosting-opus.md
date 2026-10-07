# Hosted and self-hosted: one product in cells, with ports

Claude Opus, design panel, 2026-10-06. Sources: `AGENTS.md`, `.specs/product/{overview,mvp}.md`, `.specs/engineering/{overview,spec}.md` (§1, §3, §5, §8, §16, §17, §21), tickets T-RMT-01..05 and T-CUT-03, and code at `~/smithers-frontrun` (`frontrun@ 5802e665`) and `~/plue`. Paths without a repository prefix are in smithers-frontrun. `B/` is `packages/backend/`.

## 1. Summary

1. Smithers Cloud is many installs. Each team and repository gets a **cell**: its own backend process set, PostgreSQL database, volume and origin, running the same install composition the Mac runs.
2. The product backend loses its mode switch (`auth.mode`, `topology.hosted()`, 138 call sites in 14 files). Every remaining difference becomes one of the ports in §2. Each port has a Mac adapter and a Cloud adapter, and each has a contract suite that both adapters pass.
3. Tenancy lives outside the product. An edge router maps the host name, SSH user and GitHub installation to a cell, and a directory signs people in and lists their installs. No product query ever carries a tenant id.
4. Machines go through one product admission queue over a `machines.Pool` port, with two adapters: the local microVM runtime and the fleet controller, which moves from plue into the public repository. Remote computers for a Mac install and Cloud machines for a cell then run the same code.
5. Before launch we do five cheap things that keep this possible:
   - fix plue's next pin bump;
   - freeze mode branches with a ratchet;
   - lift admission out of the microVM adapter;
   - extend the machine contract suite;
   - make the backup format OS-neutral.

   After launch we build the Cloud adapters and the cell manager, then delete the multitenant forge composition and the product code that leaked into plue.

## 2. The seam

**Rule.** Product code never names a deployment. `B/internal/compose` reads ports only. Two `main` packages choose adapters:
- `apps/backend/main.go` for the Mac;
- a new `plue/apps/cell/main.go` for Cloud.

`config.AuthConfig.Mode`, `config.IsSingleOwner`, `config.IsMultitenant`, `topology.multitenant` and `webapp.Mode` are deleted. `topology` keeps only `duties`.

Every behavior not in the table below is shared product code, with one implementation: roster, roles, credentials, TODOs, the stack, GitHub sync, flows, the wiki, chat, cards, the live channel, secrets, quiesce, backup and migration.

| # | Concern | Port: interface and location | Mac adapter | Cloud adapter (cell) | Today |
|---|---|---|---|---|---|
| 1 | Process supervision | None in the backend | `packages/smithers/src/internal/backend/HostService.ts` (launchd) plus `B/native` with bundled PG 18 | Cell manager in plue (StatefulSet per cell) | Mac exists |
| 2 | Sign-in proof | `identity.SignIn` (new, `B/identity`): `Begin(w, r, returnTo)`, `Complete(r) (GitHubIdentity{ID, Login, UserToken}, error)` | `LocalGitHubOAuth`: OAuth through the install's own App, callback at the effective origin (extracted from `B/internal/services/auth.go`) | `DirectoryAssertion`: verifies an Ed25519 JWT from `auth.smithers.cloud` (aud = cell origin, single-use jti, 60 s TTL, user token sealed to the cell key) | Mac only |
| 3 | GitHub App | `githubapp.Source` (reshaped `services.GitHubAppCredentialSource`): `AppIdentity`, `InstallationToken(ctx, perms)`, `ExchangeUserCode`, `VerifyWebhook` | Sealed manifest store (`github_app` row; the owner's own App, E-08) | Broker client. The Smithers Cloud App's PEM stays in the broker, and the cell receives only tokens for its one installation id | The interface hands out the PEM (`Load`, `github_app_credentials.go:338`) |
| 4 | Database | DSN plus the one product migration ledger (exists) | Bundled PG 18 under `$STATE` | One database per cell on a shared Cloud SQL PG 18 instance. Plue's private tables live in a separate control-plane database | Exists |
| 5 | Blobs | `ports.BlobStore` plus `B/blobs/blobsconformance` (exist) | Filesystem | GCS prefix `cells/<id>/`, with a per-cell service account | Exists |
| 6 | Repository store | `*repository.Client` (exists) | `repository.OpenLocal` with `InstallMainMirror` | The same local client on the cell volume | Exists. Hosted uses the remote client and storage sets today |
| 7 | Machines | `machines.Pool` over `workspace.WorkspaceRuntime` (§4) | `microsandbox.Runtime` as host `this-mac`; fleet hosts behind `remoteSandboxes` | `fleet.Runtime`, presenting one pooled host, "Smithers Cloud" | The fleet adapter is private in plue |
| 8 | Capacity | `machines.Limits` from `Pool.Hosts()` | Detected host profile formula (E-17, spec §8.2.1) | Plan entitlement, written by the cell manager | Mac only |
| 9 | Key ring | `keyring.KeyRing{Seal, Open, Rotate}` (new; today the env var `SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY`) | `$STATE/config/secrets.json` | Per-cell data key wrapped by Cloud KMS | Env only |
| 10 | Model access | `models.Access`: a source per role (fast, coding, decisions), chosen from owner key, owner subscription or Smithers gateway (today `OwnerModelKeys`, `PlatformModelKeys`, `ModelProxyUpstreams`) | Owner keys sealed in the database; fast model through the Smithers gateway | Same | Partial |
| 11 | Origins and TLS | `install_settings.bind/public_origins` plus spec §16.3.3 (exists) | Owner sets them in Settings; HTTPS from Tailscale or Caddy | Cell manager writes `https://<slug>.smithers.cloud`; the edge terminates TLS and passes `Host` | Exists |
| 12 | SSH ingress | Product SSH gateway (exists) | `:2222`, user = branch | Router at `ssh.smithers.cloud:22`, user = `<install>.<branch>`; the gateway accepts the qualified name when the prefix is its own slug | Two login forms |
| 13 | Setup handoff | `--setup-handoff terminal\|socket` (exists), plus `directory` | Terminal or socket | Cell manager hands the setup link to the directory. The Address and GitHub App steps report "satisfied by deployment" | Partial |
| 14 | Upgrade and backup | Product quiesce, backup and migrate API (spec §16.4–16.5, exists); `hostbackup.TreeCopier` (new) | `smthrs host upgrade`, brew, APFS clone | Cell manager calls the same API; image swap and volume snapshot | APFS-only |
| 15 | Observability | `TraceExporter`, `MetricsCollectors` (exist), logs | `$STATE/logs`, `/api/install/metrics` | Cloud Trace, Managed Prometheus scrape, stdout to Cloud Logging | Exists |
| 16 | Wiki folder | `InstallWikiSync` (exists) | Obsidian folder on the Mac | nil: the feature is off because no adapter is supplied | Exists |
| 17 | Billing (after M-09) | None in the cell. Entitlements arrive through rows 8 and 10 | None | Directory and gateway (plue, using public `commerce` and `credits`) | Product carries billing routes today |

**Metering.** Metering happens only in the Smithers model gateway: public `modelproxy` plus `credits`, composed by plue. Cells hold no platform keys and meter nothing. A Mac install and a cell call the same gateway for the fast model.

**OpenAPI.** Every product route is served by both compositions. `x-composition` rows are allowed only for operator routes (`/api/admin/sandbox/*`), never for product routes. This replaces spec §6.2.4's `x-composition: plue` for billing and triggers.

**`app.Config` change.** Remove the fields that exist only to switch modes: `EnvGitHubAppCredentials`, `RepositoryPlacement`, `RepositoryProvisioning`, `Admission`, `Commerce`, `PlatformModelKeys` and `InstallBranchMachines`. Add `Identity identity.SignIn`, `GitHubApp githubapp.Source`, `Machines machines.Pool`, `KeyRing keyring.KeyRing` and `Models models.Access`. Every other field stays.

## 3. Tenancy model: cells

```
                       smithers.cloud (plue: deployment code only)
 browser  ──▶ edge (TLS; Host → cell) ──────────────▶ ┌ cell "acme-web" ───────────────────────┐
 smthrs   ──▶   same                                   │ smithers-backend (install composition) │
 ssh      ──▶ ssh router (user "acme-web.<branch>") ─▶ │ + flow host + model host (processes)   │
 GitHub   ──▶ webhook router (installation.id,        │ own PG database · own volume (repos)   │
              re-signed per cell) ──────────────────▶ │ GCS prefix · KMS key · origin          │
 auth.smithers.cloud: directory (accounts, installs,   └──┬───────────┬──────────────┬────────┘
   sign-in via the Smithers Cloud App, assertions)        │ tokens    │ VMs          │ fast model
 broker (App PEM) ◀──────────────────────────────────────┘           ▼              ▼
                              fleet controller (public code) → workers   model gateway
```

**Request routing.** Each door carries a key that names one cell:

| Door | Key | Router |
|---|---|---|
| Browser, CLI, skill | Host `acme-web.smithers.cloud` | Edge |
| SSH | User `acme-web.retry-webhooks` | SSH router |
| GitHub webhook | `installation.id` | Webhook router: verifies the App secret, then forwards with a per-cell HMAC |
| Machine relay | Cell credential on the fleet connection | Fleet controller |
| Fast model | Account token | Gateway |

**Sign-in.** A browser with no session is redirected to `auth.smithers.cloud`. The directory runs GitHub OAuth through the Smithers Cloud App and returns a signed assertion to the cell. The cell runs the same roster admission as the Mac (`auth.go`'s install path: roster row, live push permission, hourly recheck) and mints the same `session` cookie. The directory only routes; the cell's roster decides access.

**Creating a Cloud install.** The person signs in at the directory, picks a repository where the Smithers Cloud App is installed, and the cell manager creates the cell. The person then lands on the same Setup card as J1. Address and GitHub App show as done, owner sign-in is the assertion, and the owner claim consumes the same single-use setup token (spec §5.1.0).

**Isolation**, from outside in:
- separate process;
- separate database and database role, with no cross-database grant;
- separate volume;
- GCS prefix with its own service account;
- KMS key;
- installation-scoped GitHub tokens;
- fleet credential scoped to the cell's workspace ids;
- one microVM per branch.

A bug in product query code cannot read another team's rows, because no other team's rows are in the database.

**Why not one shared process with an `install_id` column.** The code says the install is a singleton:
- `install_settings.key` is the primary key (migration `0104`).
- `github_app.singleton` (`0105`), `self_host_owners.singleton` (`0004`) and `stored_subscription_token_scan` (`0046`) are singletons.
- About 20 raw SQL readers resolve `install_settings 'github.repository'` directly, including `B/internal/chat/shared.go:43`, `B/identity/member_boundary.go:113`, `B/internal/services/secret.go:613` and `B/internal/services/members.go:61`.
- `app.Start` supports one instance per process (`B/app/app.go:172-174`).
- The MVP API is singleton-shaped (`/api/todos/{n}`, `/api/stack`, `/api/members`).

A shared process would need an install key on most of the 229 product tables (`B/db/ownership.csv`), per-install background workers and row-level security. One missed predicate would leak data between teams. Plue today has no row-level security and fences tenants in application code (`user_id::text = $2`, `plue workspaceruntime/runtime.go:289-295`). Cells need none of that work.

**Cost claim (falsifiable).** An idle cell (backend, flow host and model host, with pollers at M-03 cadence) uses under 1 GiB RSS and 0.05 vCPU. One awake branch machine uses 8 GiB (spec §8.2.1). The per-team control plane therefore costs less than one-eighth of one machine. Scale-to-zero for idle cells is deferred until the cost data asks for it. GitHub stays authoritative (M-22), so a woken cell catches up by polling.

**Portability.** The backup format (spec §16.5.2, made OS-neutral by L5) restores on either side. A team can move from Cloud to their Mac, or back, with `smthrs host restore`. That is also the cheapest test that both sides store the same product state.

## 4. Machines

```
 product (shared, B/machines)
 ┌──────────────────────────────────────────────────────────────────────┐
 │ one workspace per (repository, branch)        (0095 key, spec §8.1)   │
 │ Admission: person > TODO > background, FIFO; coalesce by holder;      │
 │   safe-idle release (spec §8.4); placement auto | pinned | disk host  │
 │   (spec §8.13.5); capacity = Σ online hosts' Limits; restart reconcile │
 │ capture → sleep → wake orchestration; sleeping reads from the host    │
 │   repo store refs/smithers/branches/<id>/head                         │
 └───────────────┬──────────────────────────────────────────────────────┘
                 │ machines.Pool
     ┌───────────┴────────────┐
 microsandbox.Runtime      fleet.Runtime ──client-dialed mTLS──▶ controller ──▶ workers (msb, KVM)
 host "this-mac"           per-worker hosts (Mac + beaver) or one pooled host ("Smithers Cloud")
```

```go
// B/machines (public). Adapters implement Pool; product code owns Admission.
type Host struct {
    Name   string // "this-mac", "beaver", "smithers-cloud"
    Kind   string // "macos" | "linux" | "cloud"
    State  string // "online" | "paused" | "unreachable" | "signed_out"
    Limits Limits
}
type Limits struct{ Machines, MemoryMiB, VCPUs int; LayerBudgetMiB int64 }
type Pool interface {
    Hosts(ctx context.Context) ([]Host, error)
    Runtime(host string) (workspace.WorkspaceRuntime, error)
    DiskHost(ctx context.Context, workspaceID string) (host string, ok bool, err error)
}
```

**Who owns what.** The product decides who waits, who goes first, when a machine is released, what a capture is, and where a new disk goes. The adapter decides how a VM boots, where a disk physically lives, how it survives a node loss, how egress is enforced, and which guest image matches the architecture.

| Behavior | Product (one implementation) | microsandbox (Mac) | fleet (Linux workers) |
|---|---|---|---|
| One branch, one machine | Workspace key; `workspace_shares` grants (E-03) | n/a | n/a |
| People first (M-13) | `machines.Admission` | n/a | n/a |
| Sleep after safe-idle | Admission plus final capture (spec §8.4.3) | `StopWorkspace` keeps the disk file | `StopWorkspace` suspends; the disk stays on the worker, with a GCS snapshot on drain |
| Wake | Grant on `DiskHost`, else placement | Start from the disk | Start on the worker that holds the disk; restore from GCS if that worker is gone |
| Reads while asleep | Host repo store | n/a | n/a |
| Capacity | Σ `Limits` | Host profile formula | Each worker's heartbeat profile through the same formula, or the plan entitlement |
| Shared working copy | `smithers-machined` in the guest (E-04) | Relay on a host loopback port | Relay over the client-dialed connection |
| Fleet-wide fairness | n/a | n/a | The controller caps each client at its entitlement and bin-packs granted VMs |

**The controller loses its queue.** `PGStore.Allocate` (`plue internal/microsandbox/control/store.go:1083`) becomes bin-packing of VMs that a product admission already granted, plus a per-client cap. It never ranks people against TODOs, so the fleet has one placement brain, not two. `FleetScaler` (GKE capacity pods) stays in plue.

**Direction rule.** The machine's client always dials, which keeps spec §1.4's loopback default and M-03's no-public-address rule:
- On a Mac with `remoteSandboxes`, the backend embeds the controller (tables in the install database) and dials each registered worker. Heartbeats, control calls and guest relay streams ride that one connection.
- For a "Smithers Cloud" computer, the Mac dials Smithers' controller.
- A cell dials the in-cluster controller the same way.

This answers spec §8.13.0's open question, and it replaces §8.13.7's SSH reverse forwards with one transport.

**Per-branch machines in a cell** behave exactly as on the Mac: same daemon, same capture, same Branch card. The only visible difference is that Settings shows one computer, "Smithers Cloud", with the plan's limit. The product already renders that row (`.specs/design/placement.md`).

## 5. Build, release and test

**One build per release tag.**
- The release job builds `smithers-backend` for darwin-arm64 (the Homebrew bundle, unchanged) and linux-amd64/arm64 from the same commit.
- It publishes `smithers-cell` as an OCI image: the Linux backend, flow hosts, model host, web assets and pinned guest image digests.
- `plue/apps/cell/main.go` is about 150 lines: `app.Run(app.Config{…})` with Cloud adapters. Protocol adapters (fleet client, directory assertion, broker client) are public. Vendor adapters (GCS, KMS, Cloud SQL IAM) stay in plue, because `scripts/check-go-boundaries.py` bans cloud SDKs from public dependencies.
- Plue pins the release tag, and its release manifest pins host bundle hashes, as it does today (`plue composition/release.go:14-40`).

**Test matrix.** Product logic is mode-free, so it is tested once. Only ports are tested per adapter, and journeys run against both compositions.

| Layer | Test | Mac composition | Cell composition | Lives in |
|---|---|---|---|---|
| Unit, integration | All product logic, once | n/a | n/a | Next to code |
| Port contract | `workspaceconformance` (extended in L4) | microsandbox (macOS VM runner), process | fleet: in-process controller and worker (Linux KVM runner) | `B/workspaceconformance` |
| Port contract | `blobsconformance` (exists) | Filesystem | GCS | Public; GCS run in plue CI |
| Port contract | `identityconformance` (new): replay, wrong audience, expired, unknown key, suspended member gets the same 401 | LocalGitHubOAuth with `githubfake` | DirectoryAssertion with a public fake directory | `B/identity` |
| Port contract | `githubappconformance` (new): token scope, webhook verify, OAuth exchange | Manifest store | Broker client against a public fake broker | `B/githubapp` |
| Port contract | `keyringconformance` | File | KMS fake | Public; real KMS in plue |
| Composition | `TestCompositionsServeOneProduct`: OpenAPI route set and bootstrap capabilities are equal, except operator rows | Yes | Yes | `B/internal/compose` |
| Ratchet | Mode checks in non-test Go: 138 → 0 | n/a | n/a | `scripts/` |
| Journey | `newRehearsal(t, …, composition)` (`rehearsal_integration_test.go:138` gains a parameter) for J1, J2, J4, J5, J6, J7, J11; J3, J8 and J10 once written | Yes | Yes, with fake directory and broker | `B/internal/compose` |
| Real e2e | mvp.md §12 journeys on the reference Mac | Release gate | n/a | `apps/app/e2e/real/` |
| Real e2e | Staging cell wrapping a scratch repository (codeplanesmithers): J1, J2, J10 nightly through Playwright; C-REL-03 upgrade rolled across staging cells per release | n/a | Release gate for Cloud | plue CI |
| Mode matrix | `run-packaged-mode-matrix.ts` modes `web-selfhost` and `web-cell` replace `web-plue` and `local-plue` | Yes | Yes | `apps/app/scripts` |

Cells multiply upgrade-in-place rehearsals. Every hosted release runs M-26's quiesce, backup, migrate and health path once per cell, so Mac upgrades inherit that evidence.

## 6. What breaks today

1. **The MVP product is install-only.** `/api/live`, `/api/stack`, `/api/todos*`, `/api/members`, `/api/secrets`, `/api/terminals`, confirmations, flows, `/api/github/sync` and `/api/branches/*` mount only under `config.IsSingleOwner` (`B/internal/compose/router.go:879, 963-1062`). Hosted runs `SMITHERS_AUTH_MODE=multitenant` (`plue infra/helm/smithers/templates/api-deployment.yaml:310`), which serves the older forge: per-user workspaces, orgs, billing and `/api/repos/{owner}/{repo}/…`. One backend contains two products.
2. **138 mode checks in 14 files** (router.go 53, main.go 37, `services/auth.go` 15). The mode also travels in parameters and types:
   - `composeBranchMachines(…, hosted, …)`, `chatRuntimeOptions(…, hosted, …)`, `browserCORS(…, install)`, `SecretService.installAuthorization`;
   - `webapp.Mode` (`web-selfhost`, `web-plue`);
   - the separate `InstallMainMirror` switch;
   - a hard-coded bootstrap `Host: "cloud"` for both modes (`compose/bootstrap.go:61`).
3. **Two implementations of one behavior:**
   - repository creation (`main.go:625-633`; `services/repo.go:801,942`);
   - the storage reconciler started from two branches (`main.go:2061,2079`);
   - two GitHub budget trackers (`compose/github_sync.go:22-27`) and two fetchers (`:49-53`);
   - two main-pull surfaces (`router.go:1309` and `:1034`);
   - two wiki folder syncs (`main.go:1989-2001`);
   - trigger management blocked twice (`router.go:168` and unmounted routes at `:638-651`);
   - key auth refused twice (`router.go:1116`, `auth.go:341`);
   - the credential-issuer check in three layers;
   - about 20 raw readers of the install repository instead of `InstallRepositoryID` (`services/repo_permissions.go:622`);
   - dead `provisioningEnforced` branches (`main.go:418,1010,2032`).
4. **Product policy sits inside the Mac adapter.** People-first ranking, coalescing and safe-idle release live in `B/microsandbox/admission.go` (`Request`, `GrantNext`, `AdmissionIdleRelease`). `services/workspace_machine_queue.go:22,210` type-asserts `microsandbox` types. A fleet runtime fails those assertions, so a hosted TODO either loses M-13 or fails with "machine admission runtime unavailable". The controller has a second placement brain (`store.go:1083`).
5. **`composeBranchMachines` refuses hosted** (`main.go:149-151`). One lane machine per TODO is single-owner only (`B/app/app.go:78-81`).
6. **Remote machines depend on private code.** The controller, worker and fleet `WorkspaceRuntime` are private (`plue internal/microsandbox/{control,worker}`, `plue apps/backend/internal/composition/workspaceruntime/runtime.go`). Spec §8.13.0 says remote machines must reuse them, and AGENTS.md forbids self-hosting from depending on private code. No public remote adapter exists; C-RMT-01..06 are `test.fixme`.
7. **Plue's next pin bump changes its GitHub App.** Plue pins smithers at 2026-10-03 (`plue go.mod:16`), before `EnvGitHubAppCredentials` existed. On a bump, `selectGitHubAppCredentials` (`main.go:2340-2347`) moves hosted to the empty manifest store unless plue sets the flag. Separately, the port hands out the PEM, so every cell would hold the shared App key.
8. **Product code in plue:**
   - `apps/github-sync` (about 4,360 lines of TypeScript) is a second two-way GitHub sync with its own SQLite mapping (`src/db.ts:139-239`), beside product spec §12.
   - `workspaceruntime/runtime.go:150-213` holds the outsider egress rule, with raw SQL on `workspaces` and `outsider_workspaces`, and a hard-coded `developer` guest layout.
   - `control/private_queries.go:10-54` reads `agent_sessions` and `workspaces`.
   - `chat.go:152-193` has provider origin defaults that differ from `B/modelhost/owner_models.go`.
   - `hostedusage/usage.go` holds quota rules.
   - Product decisions sit in Helm values (default model `cerebras:qwen-3.8-27b`, feature flags).
   - tutorial-coordinator's source is not in plue.
9. **The chat model host runs differently on each side.** The Mac runs a trusted process (`apps/backend/isolation.go:141`). Plue launches a microVM per turn (`plue chat.go:227-300`) because one process holds every owner's credentials. A cell has one owner, so the Mac path is enough.
10. **SSH forms diverge.** The install uses `<branch>@host -p 2222` (spec §8.10.1). Plue uses `msb_<sandbox>+<guest-user>` (parser at `B/internal/ssh/workspace_access.go:50`), and its DNS says `ssh.jjhub.tech`.
11. **Backup is APFS-only.** `B/internal/hostbackup/clone_darwin.go:14` has "never a copying fallback", and spec §16.5.2 refuses non-APFS volumes. A cell's ext4 volume cannot take the M-26 path, and a Cloud-to-Mac move is impossible.
12. **The release mode matrix tests the forge.** `release.yml:555` runs `web-plue, local-own, local-plue`, not the MVP product in Cloud.
13. **Billing logic straddles both repositories.** Plue configures pricing (`plue billing.go:36`, values.yaml), while product holds `commerce`, `credits`, `RejectDeferredCommerce` and billing routes that the install hides.

## 7. Work needed

Each item is 1 to 4 agent-days. Items within a phase run in parallel unless the Depends column says otherwise.

### Before the self-hosted MVP launch

About 12 agent-days in 3 lanes. Most of it is stage-1 or stage-2 work anyway (E-11, M-26).

| ID | Work | Days | Depends | Proof |
|---|---|---|---|---|
| L0 | Plue: set `EnvGitHubAppCredentials: true` and port `RecommendationLog` in the same pin-bump commit | 0.5 | — | Plue composition test: hosted loads App 4163546 after the bump |
| L1 | Ratchet `scripts/check-deployment-branches.mjs`: fail when non-test Go mode checks exceed 138, appear outside `B/internal/compose`, or when a product OpenAPI row gains `x-composition` | 1 | — | Gate fixture tests; wired into `//scripts:gates` |
| L2 | Move admission from `B/microsandbox/admission.go` into `B/machines` over `machines.Pool`. `microsandbox.Runtime` implements `Pool` as `this-mac`. `internal/services` stops importing `microsandbox` | 3–4 | — | Admission tests move verbatim. C-MCH-11 passes on microsandbox and on a fake two-host pool. A recorded 50-request trace grants in the same order as before. A grep gate blocks the import |
| L3 | `InstallCapacityService` reads `Pool.Hosts()[].Limits`; the formula stays with the host profile | 1–2 | L2 | C-MCH-01, -04, -11 unchanged |
| L4 | Extend `workspaceconformance`: sleep keeps the disk, wake after restart, capture yields the head ref, terminal, `base_digest` stale-write refusal, egress refusal, typed capacity error | 2–3 | — | Green on microsandbox real-VM CI and on process |
| L5 | OS-neutral backup: `MANIFEST.json` records paths, sizes and SHA-256 only. `hostbackup.TreeCopier` gets APFS-clone and plain-copy adapters, and restore accepts either | 2 | — | C-REL-06, plus a Linux backup→restore round trip in CI |
| L6 | Collapse the raw `github.repository` readers onto `InstallRepositoryID`, and delete dead `provisioningEnforced`, the duplicate key-auth guard and the triple issuer check | 2 | L1 | Ratchet count drops; existing install tests |

L5 must land before launch: M-26 makes the backup format durable from the first install. L0 must land before plue's next bump. L6 goes to the first free lane, or first after launch.

### After launch (Smithers Cloud, M-09)

| ID | Work | Days | Depends | Proof |
|---|---|---|---|---|
| H1 | Move the controller, store, worker, protocol, client and fleet `WorkspaceRuntime` to public `B/fleet`. Disk GC asks the product through a `Pool` callback instead of reading product tables. Plue keeps FleetScaler, Helm and the GCS snapshot store | 4 (+3f review) | L2, L4 | `workspaceconformance` against fleet on a Linux KVM runner; plue builds against the public package |
| H2 | Client-dialed fleet transport: one connection carries heartbeats, control calls and guest relay streams | 4 | H1 | `pnpm install` of the smithers repository ≤ 2× local (T-RMT-01's bar); a 3 s drop reconnects |
| H3 | `remoteSandboxes` on the Mac: embedded controller, plus Settings Computers with T-RMT-02/04 reshaped onto the fleet | 3–4 | H1, H2 | C-RMT-02, C-RMT-04 rewritten for the fleet |
| H4 | `identity.SignIn` port: extract `LocalGitHubOAuth`; add `DirectoryAssertion` and a public fake directory | 3 | — | `identityconformance`; C-ACC-01, -03 on both |
| H5 | `githubapp.Source` at token level: manifest adapter, broker client, public fake broker, per-cell webhook HMAC. Delete `EnvGitHubAppCredentials` | 3 | — | `githubappconformance`; C-GH-01, -07, -08 on both |
| H6 | `keyring.KeyRing` with file and KMS adapters | 1–2 | — | Keyring contract; C-SEC-03 |
| H7 | Cell composition in public tests: parameterize `newRehearsal`; run J1, J2, J4, J5, J6, J7 and J11 on the cell composition | 3–4 | H1, H4, H5 | Matrix green on both |
| H8 | `TestCompositionsServeOneProduct` | 1 | H7 | Route and capability parity |
| H9 | SSH `<install>.<branch>` user form plus the plue SSH router | 2 | — | C-J3 SSH steps through the router |
| H10 | Plue cell manager. Create: database, role, volume, origin, entitlement, setup handoff. Roll upgrades through the quiesce, backup and migrate API. Delete. Export a backup | 4 + 4 | L5, H6 | Staging: create → J1 → upgrade → restore the backup on a Mac |
| H11 | Plue directory, edge router, webhook router and broker deployment | 4 + 4 | H4, H5 | Staging cell J1, J2 and J10 nightly |
| H12 | Pooled "Smithers Cloud" host whose `Limits` come from the entitlement | 1–2 | H1, L3 | C-MCH-11 with an entitlement host |
| H13 | Retire the forge composition. First move its callers: `CloudSandbox.ts:145` (`/api/repos/…/workspaces`), `flows/issue-sweep` `providerFor("cloud")`, the `smthrs environment` Cloud location, benchmarks. Then delete `auth.mode`, the multitenant route families, the placement and provisioning ports, two-path repository creation and `webapp.Mode` | 3–4 × 4 | H7–H11 | Ratchet reaches 0; the OpenAPI loses forge rows |
| H14 | Remove product code from plue: delete `apps/github-sync`; move the outsider egress rule into `WorkspaceSpec` (the adapter only enforces it); move chat origin defaults into `B/modelhost`; delete the per-turn microVM chat launcher | 2–3 each | H13 for github-sync | Plue boundary script: no product table names in plue SQL |
| H15 | Billing: plans become entitlements (row 8) and gateway credits (row 10), at the directory | Post M-09 | H10, H11 | Product tree has no `commerce` import |

**Lanes after launch:**
- Fleet: H1 → H2 → H3, H12.
- Identity: H4, H5, H6 → H7 → H8.
- Plue: H9, then H10 and H11 once H6 and H5 land.
- Cleanup: H13, then H14.

## 8. Risks and open questions

| # | Risk or question | Cheap falsifier |
|---|---|---|
| 1 | Cells cost too much per team | Run the J1 rehearsal composition idle for 1 h with pollers on. Backend + flow host + model host above 1 GiB RSS or 0.05 vCPU breaks the cost claim in §3 |
| 2 | Cloud SQL connections grow as cells × pool size | 100 staging cells at pool size 5. A C-PERF-02 p95 regression or hitting `max_connections` means adding PgBouncer before launch |
| 3 | The fast model through a Smithers sign-in (design commit 7e315a68) contradicts mvp.md §12.5, "needs no Smithers account" | Product rules within one day by comparing the two texts. Until then the gateway source is optional, and J1 passes with a BYOK fast model |
| 4 | Moving the controller public exposes code that was safe only while private | smithers-3f reviews `B/fleet` before H1 lands. Any embedded credential, or any trust in network position, blocks the move |
| 5 | A GKE node drain forces a GCS restore, and warm wake misses spec §18's 5 s | Measure wake-after-drain on staging. If it is over 5 s, the card shows "Restoring" and the 5 s budget stays scoped to same-worker wakes |
| 6 | Retiring the forge breaks unknown callers | Grep public callers, plus 7 days of plue request logs grouped by route family. Any external caller blocks H13 for that family |
| 7 | One shared GitHub App exhausts rate budget | Limits are per installation. Staging budget telemetry (C-GH-08) must stay above 50% remaining at M-03 cadence |
| 8 | Guest relay over the client-dialed connection is too slow for package installs on Cloud machines of a Mac install | T-RMT-01's bar, ≤ 2× local. If it fails, egress for those machines leaves from the worker, and host-bound secrets are refused there |
| 9 | Lifting admission destabilizes stage 1 | L2's recorded-trace equality test. Any reordering blocks the land |
| 10 | Per-node volume attach limits cap the number of cells | Staging load script at 200 cells |
| 11 | Open: does a Cloud install keep Obsidian folder sync? | Product decision. The default is no (row 16, nil adapter) |
| 12 | Open: should the embedded controller run in-process on the Mac or as a sibling launchd job? | In-process, unless `B/fleet` needs CGO or a privilege the backend lacks. Check with `go list -deps` and the entitlement list during H1 |

**First action:** land L0 and L1 this week. One plue line prevents a silent GitHub App switch on the next pin bump, and one gate stops hosted and self-hosted from drifting further apart while the rest is built.
