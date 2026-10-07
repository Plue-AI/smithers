# One product, self-hosted and hosted: merged design

> **Status: proposal; two decisions settled (2026-10-06).** Produced by a four-way panel and a merger at Will's request. Not normative except where marked **Decided**: spec.md and mvp.md govern otherwise. The earlier conflict with M-40 is resolved: M-40 was revised to match this design (the install connects out; remote computers are the first item after launch; 76f526e2dc). Will reviews the two remaining choices, one copy (cell) per team and metering only at the gateway, on his brief due Oct 19; until then this document's position is the default.


Merger: Claude Fable, 2026-10-06. Inputs: `codex-sol.md`, `codex-astra.md`, `fable.md`, `opus.md`. Every contested fact below was re-read in `~/smithers-frontrun` (origin/frontrun, `0384b6be9a`) and `~/plue` (main). Paths without a prefix are in smithers-frontrun; `B/` is `packages/backend/`; `P/` is `~/plue`.

## Decisions for Will

- **Smithers Cloud runs each team's repository as its own complete copy of the self-hosted install** (its own process, database, disk and web address), not as rows inside one big shared system. The product is already built as "one team, one repository"; copying it needs no product change, and a bug in one team's copy cannot read another team's data because that data is not in its database.
- **Nothing hosted is built before the self-hosted launch**, except two guards that take a day and a half: a one-line fix so the next hosted update keeps its GitHub login working, and a gate that stops hosted and self-hosted code from drifting further apart.
- **Remote computers and Cloud machines use the Cloud fleet's controller and worker**, moved from the private repository into the public one after launch. The install always dials out, so a Mac behind NAT never opens a port.
- **People sign in to Cloud through one central Smithers sign-in page** that vouches for them to their team's copy; the copy then applies exactly the roster rules a Mac applies. GitHub allows an App only ten callback addresses, so each copy cannot do its own sign-in.
- **The hosted GitHub App's private key lives in one small broker**; team copies only ever receive short-lived tokens for their one repository.
- **Smithers meters model usage only at its own model gateway** (the fast model). Team copies hold their own keys like a Mac and never platform keys. Billing, when it comes, is a limit set from outside the copy, never code inside it.
- **The old hosted product (organizations, billing pages, repository jobs, previews) is frozen now and deleted after launch**, together with our own scripts that still use it (issue-sweep's Cloud sandboxes, benchmarks), once those run on the new shape.
- **Decided (engineering call, 8a, 2026-10-06; no Will review needed): one build per release produces the Mac bundle and the Linux image**, and the same journey tests run against both.

## Where the panel disagreed

| Topic | Positions | Decision |
| --- | --- | --- |
| Tenancy | Sol, Astra, Fable: one shared process scoped per repository (`FactoryScope` / `ports.Installs`); Opus: one process set and database per team ("cell") | Cells. The product is singleton-shaped by schema and API; scoping it is the largest and riskiest item on every shared-process list, and cells need none of it |
| Route prefix before launch | Fable: move `/api/todos`, `/members`, `/secrets`... under `/api/repos/{o}/{r}/` now; others: no | No. The host name selects the install; `catalog.mvp.json` and the CLI stay as they are |
| Delete the mode bit and the forge before launch | Fable: yes (A3, A4); Sol, Astra, Opus: after | Ratchet before launch; delete after. The forge still carries our own Cloud sandbox users |
| Move admission out of `microsandbox` before launch | Opus: before (L2); others silent | After launch, first fleet item. E-11 placed it there on purpose; the ratchet freezes the coupling meanwhile |
| Fleet transport direction | Fable: the worker dials the install (needs a bind address); Sol, Astra: both directions reachable; Opus: the install dials, one connection | The install dials. §1 loopback default and M-03; the controller already dials worker websockets today |
| Hosted GitHub App adapter | Sol, Astra, Fable: the platform PEM in the backend via env or Secret Manager; Opus: a broker that issues tokens | Broker. N copies of one master key is the wrong shape |
| Hosted sign-in adapter | Sol, Astra, Fable: the same OAuth code with platform App credentials; Opus: a directory that asserts identity to the cell | Directory assertion, because of the callback-URL limit; the cell runs the same roster admission |
| Hosted repository storage | Sol, Astra, Fable: plue's `clusterstorage` router; Opus: the local client on the cell's volume | Local client. The router exists for a shared process |
| Hosted chat model host | Astra: isolated microVM per turn via the fleet; Opus: trusted process like the Mac | Trusted process. A cell has one owner, which is the Mac's reason |
| Billing port | Sol, Astra, Fable: `commerce.Service` in the product, nil on the Mac; Opus: nothing in the cell | Nothing in the cell. Entitlements arrive as machine limits and gateway credits |
| OS-neutral backup before launch | Opus: before (L5); others silent | After. The manifest already records path, size and SHA-256; only the copier is APFS-bound |
| Plue's pins disagree | Sol, Astra: `go.mod` and `release-manifest.json` differ | Refuted: both pin `30e56fda1977` |
| `user_id` in the active workspace key blocks shared branches | Sol (migration 0095) | Refuted: `0108_branch_machines.sql:43-47` rekeys to `(repository_id, kind, target_bookmark, name)` |

## 1. Summary

1. Smithers Cloud is many self-hosted installs. Each team repository gets a **cell**: the install composition from `B/app`, its own PostgreSQL database, volume, origin and key, running the same binary the Mac runs. Tenancy lives outside the product in plue's edge, directory, webhook router and cell manager; no product query carries a tenant id.
2. The product backend loses its mode switch: `auth.mode`, `topology.hosted()`, `IsSingleOwner`, `IsMultitenant` and `webapp.Mode` (141 non-test sites in 15 files) go, and every remaining difference is one port in §2 with a Mac adapter in `apps/backend` and a Cloud adapter in plue, each passing one contract suite.
3. Machines go through one product admission over a `machines.Pool` port with two adapters: the local libkrun runtime and the fleet controller, which moves from plue to `B/fleet`. A remote Linux box for a Mac install and the machines of a cell then run the same code, and the install always dials out.
4. One release builds the Mac bundle and the Linux artifacts from one commit; plue's image copies them by digest, and the compose rehearsal, port contracts and journeys J1–J11 run against both compositions.
5. Before launch we land only a plue pin guard, a drift ratchet, a reader cleanup and a wider machine contract suite (about six agent-days). After launch we build the ports, the cell manager and the fleet move, then delete the forge composition and the product code that leaked into plue.

## 2. The seam

**Rule.** Product code never names a deployment. `B/internal/compose` composes from `app.Config` only. `config.AuthConfig.Mode`, `config.IsSingleOwner`, `config.IsMultitenant`, `topology.multitenant`, `webapp.Mode` and the always-`"cloud"` bootstrap host (`B/internal/compose/bootstrap.go:61`) are deleted; `topology` keeps only `duties`. Two `main` packages choose adapters: `apps/backend/main.go` for the Mac and a new `P/apps/cell/main.go` for Cloud.

Everything not in the table is shared product code with one implementation: roster and roles, credentials, confirmations, TODOs, the stack, GitHub sync and polling, flows, the wiki, chat, cards, the live channel, secrets, quiesce, backup and migrations.

| # | Concern | Port (interface, location) | Mac adapter | Cloud adapter (cell) | Today |
| --- | --- | --- | --- | --- | --- |
| 1 | Process supervision | None in the backend | `packages/smithers/src/internal/backend/HostService.ts` (launchd) plus bundled PostgreSQL 18 under `B/native` | Cell manager in plue: one StatefulSet per cell | Mac exists |
| 2 | Sign-in proof | `identity.SignIn` (new, `B/identity`): `Begin(w, r, returnTo)`, `Complete(r) (GitHubIdentity{ID, Login, UserToken}, error)` | `LocalGitHubOAuth`: OAuth through the install's own App at the effective origin, extracted from `B/internal/services/auth.go` | `DirectoryAssertion`: verifies an Ed25519 JWT from the directory (aud = cell origin, single-use `jti`, 60 s TTL, user token sealed to the cell key) | Mac only |
| 3 | GitHub App | `githubapp.Source` (reshaped `services.GitHubAppCredentialSource`, `B/internal/services/github_app_credentials.go:338`): `AppIdentity`, `InstallationToken(ctx, perms)`, `ExchangeUserCode`, `VerifyWebhook`. No method returns the PEM | Sealed manifest store (`github_app` row, E-08) | Broker client. The Smithers Cloud App's PEM stays in the broker; a cell gets tokens for its one installation id | `Load` hands out `PEM`, `WebhookSecret`, `ClientSecret` (`:32-42`) |
| 4 | Database | DSN plus the one product migration ledger (exists) | Bundled PG 18 under `$STATE` | One database and role per cell on a shared Cloud SQL PG 18 instance; plue's private tables in a separate control-plane database | Exists |
| 5 | Blobs | `ports.BlobStore` plus `B/blobs/blobsconformance` (exist) | Filesystem under `$STATE/blobs` | GCS prefix `cells/<id>/` with a per-cell service account (`P/internal/cloudstorage`, 137 lines) | Exists |
| 6 | Repository store | `*repository.Client` (exists) | `repository.OpenLocal` on `$STATE` | The same local client on the cell volume | Hosted uses `P/internal/clusterstorage` and the `repo-host` StatefulSet; both retire with the forge |
| 7 | Machines | `machines.Pool` over `workspace.WorkspaceRuntime` (§4) | `microsandbox.Runtime` as computer `this-mac`; `fleet.Runtime` per registered computer behind `remoteSandboxes` | `fleet.Runtime` presenting one pooled computer, "Smithers Cloud" | Fleet adapter private in plue |
| 8 | Capacity | `machines.Limits` from `Pool.Hosts()` | E-17 formula from the detected profile (spec §8.2.1) | Entitlement written by the cell manager | Three type assertions (`B/internal/compose/main.go:432-446`) |
| 9 | Secret keys | `ports.SecretKeySource` (new): `Active() []byte`, `Previous() [][]byte` | `$STATE/config/secrets.json` (0600) | Per-cell data key unwrapped at start by Cloud KMS | Env var `SMITHERS_WEBHOOK_SECRET_ENCRYPTION_KEY` |
| 10 | Model access | `models.Access`: one source per role (fast, coding, decisions) from owner key, owner subscription or the Smithers gateway | Owner keys sealed in the database; fast model through the gateway with a Smithers sign-in (design commit `7e315a68`) | Same | `OwnerModelKeys`, `PlatformModelKeys`, `ModelProxyUpstreams` split by mode (`main.go:1571`) |
| 11 | Origins and TLS | `install_settings` bind and public origins plus `middleware.EffectiveOrigin` (exist, spec §16.3) | Owner sets them in Settings; HTTPS from any proxy (E-13) | Cell manager writes `https://<slug>.smithers.cloud`; the edge terminates TLS and passes `Host` | Hosted uses a second middleware, `CanonicalBrowserAuthOrigin` (`router.go:353`) |
| 12 | SSH ingress | Product SSH gateway (exists, spec §8.10) | `<branch>@host -p 2222` | Router at `ssh.smithers.cloud`, user `<install>.<branch>`; the gateway accepts the qualified name when the prefix is its own slug | Two login forms (`B/internal/ssh/workspace_access.go:50-62` parses the forge's `msb_<id>+<user>`) |
| 13 | Setup handoff | `--setup-handoff terminal\|socket` (exists) plus `directory` | Terminal or socket | Cell manager hands the setup link to the directory; steps `address` and `app_manifest` (`B/internal/services/install_setup.go:23`) report "satisfied by deployment" | Partial |
| 14 | Upgrade and backup | Product quiesce, backup and migrate API (spec §16.4–16.5, exists); `hostbackup.TreeCopier` (new) | `smthrs host upgrade`, brew, APFS clone | Cell manager calls the same API; image swap plus plain-copy or volume snapshot | `clone_darwin.go` refuses non-APFS; `clone_other.go` aliases `RefusingCloner` |
| 15 | Observability | `TraceExporter`, `MetricsCollectors` (exist), logs | `$STATE/logs`, `/api/install/metrics` | Cloud Trace, Managed Prometheus, stdout; the cell label comes from the deployment | Exists |
| 16 | Wiki folder | `InstallWikiSync` (exists) | Obsidian folder | nil adapter; the feature is off | Two sync starts (`main.go:1989-2001`) |
| 17 | Billing (after M-09) | None in the cell; entitlements arrive through rows 8 and 10 | None | Directory and gateway in plue compose the public `commerce` and `credits` libraries | Product carries billing routes the install hides (`RejectDeferredCommerce`) |

**Metering** happens only in the Smithers model gateway (public `B/modelproxy` plus `B/credits`, composed by plue). Cells hold no platform keys and meter nothing. A Mac install and a cell call the same gateway for the fast model, and J1 passes with a bring-your-own fast-model key when the gateway is not configured, because the install "needs no Smithers account" (mvp.md §12 item 5).

**Chat model host.** The Mac runs the model host as a trusted process (`apps/backend/isolation.go`); plue launches a microVM per turn (`P/apps/backend/internal/composition/chat.go:227`) because one process held every owner's credentials. A cell has one owner, so the Mac path is the only path.

**OpenAPI.** Both compositions serve every product route. `x-composition` rows are allowed only for operator routes, never product routes.

**`app.Config`.** After the forge retires, remove the fields that exist only to switch modes: `EnvGitHubAppCredentials`, `RepositoryPlacement`, `RepositoryProvisioning`, `Admission`, `Commerce`, `PlatformModelKeys`, `InstallBranchMachines` and `ComputeProvider` (`sandbox.Provider`, `B/app/app.go:44-46`, which the install never sets). Add `Identity identity.SignIn`, `GitHubApp githubapp.Source`, `Machines machines.Pool`, `SecretKeys ports.SecretKeySource` and `Models models.Access`. Every other field stays.

## 3. Tenancy model: cells

```
                          smithers.cloud (plue: deployment code only)
 browser, CLI ─▶ edge (TLS; Host → cell) ───────────────▶ ┌ cell "acme-web" ──────────────────────┐
 ssh ──────────▶ ssh router (user "acme-web.<branch>") ──▶ │ smithers-backend (install composition) │
 GitHub ───────▶ webhook router (installation.id,         │ + flow host + model host               │
                 verified, re-signed per cell) ──────────▶ │ own PG database · own volume · origin  │
 directory (accounts, install list, OAuth through the      │ GCS prefix · KMS-wrapped key           │
   Smithers Cloud App, signed assertions) ────────────────▶ └──┬──────────────┬─────────────┬───────┘
 broker (App PEM; tokens per installation) ◀──────────────────┘              │ VMs         │ fast model
                                              fleet controller (public code) ─▶ workers   model gateway
```

**Why not one shared process with an `install_id` column.** The code says the install is a singleton, and the MVP contract agrees ("One team, one machine, one repository", mvp.md §1; "one repository per install", §8 and §16):

- `install_settings.key` is the primary key (`0104_install_settings.sql:3`); `github_app.singleton` (`0105`), `self_host_owners.singleton` (`0004`) and `stored_subscription_token_scan.id` (`0046`) are singletons.
- 14 non-test readers resolve `install_settings 'github.repository'` directly (`B/internal/chat/{shared,author,view_state,http}.go`, `B/internal/services/{secret,members..,member_recheck,install_review,approvals_confirmations,workspace_branch_machine_install}.go`, `B/internal/db/member_access.go`, `B/modelhost/owner_secrets.go`).
- `app.Start` supports one instance per process and owns process-wide logging and revocation state (`B/app/app.go:170-174`); install jobs run under `jobs.Scope{TenantID: "install"}` (`install_setup.go:313`).
- The MVP API is singleton-shaped: `/todos`, `/stack`, `/members`, `/secrets`, `/github/sync`, `/terminals` mount unprefixed (`B/internal/compose/router.go:963-1062`).

A shared process needs an install key on most of the ~270 rows in `B/db/ownership.csv`, a route prefix with a regenerated catalog and CLI, per-install background workers and either row-level security or a query audit; one missed predicate leaks data between teams. Plue today fences tenants in application code (`workspaceruntime/runtime.go:57-70`, `user_id::text = $2`). Every shared-process design put 11–18 agent-days of that work before launch on the MVP's critical path. Cells need none of it.

**Request routing.** Each door carries a key that names one cell: Host for the browser, CLI and skill; the SSH user prefix; `installation.id` on webhooks, verified by the router with the App secret and forwarded with a per-cell HMAC that the cell's `githubapp.Source` verifies; the cell credential on the fleet connection; the account token at the gateway.

**Sign-in.** A browser with no session is sent to the directory. The directory runs GitHub OAuth through the Smithers Cloud App (a GitHub App registers at most ten callback URLs, so per-cell callbacks cannot scale) and returns a signed assertion to the cell. The cell runs the Mac's roster admission unchanged (`services/auth.go` install path: roster row, live push permission, hourly recheck) and mints the same session cookie. The directory routes; the cell's roster decides.

**Creating a hosted install.** The person signs in at the directory, picks a repository where the Smithers Cloud App is installed, and the cell manager creates the cell (database, role, volume, origin, entitlement, setup token). The person lands on the same Setup card as J1 with `address` and `app_manifest` already satisfied; the owner claim consumes the same single-use setup token. A team with two repositories has two installs listed by the directory, which is mvp.md's "one repository per install" applied as is; a switcher is a directory page, never product code.

**Isolation**, from outside in: separate process; separate database and role with no cross-database grant; separate volume; GCS prefix with its own service account; KMS-wrapped key; installation-scoped GitHub tokens; fleet credential scoped to the cell's workspace ids; one microVM per branch.

**Cost claim (falsifiable).** An idle cell (backend, flow host and model host, pollers at M-03 cadence) uses under 1 GiB RSS and 0.05 vCPU. The only budget today is E-17's 8 GiB reserve for the host services plus macOS (spec §8.2.1), so this is a claim, not a measurement; §8 risk 1 says how to test it. One awake machine is 8 GiB, so the per-team control plane is under one eighth of one machine. Scale-to-zero is deferred until cost data asks for it; GitHub stays authoritative (M-22), so a woken cell catches up by polling.

**Portability.** The backup directory (spec §16.5.2) restores on either side once the copier is pluggable (§7 C5). A team can move from Cloud to a Mac or back with `smthrs host restore`, which is also the cheapest proof that both sides store the same product state.

## 4. Machines

```
 product (shared, B/machines)
 ┌─────────────────────────────────────────────────────────────────────────┐
 │ one workspace per (repository, kind, bookmark, name)  (0108 key; §8.1)  │
 │ Admission: person > TODO > background, FIFO; coalesce by holder;         │
 │   safe-idle release (§8.4); placement auto | pinned | disk host (§8.13.5)│
 │ capacity = Σ online computers' Limits (§8.13.4); restart reconcile       │
 │ capture → sleep → wake; asleep reads come from the host repo store       │
 └─────────────────────┬───────────────────────────────────────────────────┘
                       │ machines.Pool
      ┌────────────────┴──────────────────┐
 microsandbox.Runtime                fleet.Runtime ──install-dialed mTLS──▶ controller ──▶ workers (msb, KVM)
 computer "this-mac" (libkrun)       computers "beaver"… for a Mac, or one pooled "Smithers Cloud" for a cell
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

`workspace.WorkspaceRuntime` (`B/workspace/contracts.go:516`: lifecycle, execution, terminal, preview, files) stays the one machine contract; no second `MachineRuntime` and no SSH execution path (§8.13.0). `workspaces` gains a `host` column (NULL means `this-mac`); `CreateWorkspace` is the only call that chooses a computer, and every later call routes by the stored host (§8.13.5, "a machine that has a disk wakes on the host that holds it").

**Who owns what.** The product decides who waits, who goes first, when a machine is released, what a capture is and where a new disk goes. The adapter decides how a VM boots, where a disk physically lives, how it survives a node loss, how egress is enforced and which guest image matches the architecture.

| Behavior | Product (one implementation) | microsandbox (Mac) | fleet (Linux workers) |
| --- | --- | --- | --- |
| One branch, one machine | `0108` unique key; `workspace_shares` grants (E-03) | n/a | n/a |
| People first (M-13, E-11) | `machines.Admission`, moved verbatim from `B/microsandbox/admission.go` after launch | n/a | n/a |
| Sleep after safe-idle | Admission plus final capture (§8.4.3) over `ExecuteCommand`/`ReadFile` | `StopWorkspace` keeps the disk file | `StopWorkspace` suspends; the disk stays on the worker, GCS snapshot on drain |
| Wake | Grant on `DiskHost`, else placement | Start from the disk | Start on the holding worker; restore from GCS if it is gone |
| Reads while asleep | Host repository store | n/a | n/a |
| Capacity | Σ `Limits` over online, unpaused computers | E-17 formula | Each worker's signed heartbeat profile through the same formula, or the entitlement |
| Shared working copy | `smithers-machined` in the guest (§9) | Relay on a host loopback port | Relay over the install-dialed connection |
| Fleet fairness | n/a | n/a | The controller caps each client at its entitlement and bin-packs granted VMs |

**The controller loses its queue.** `PGStore.Allocate` (`P/internal/microsandbox/control/store.go:1083`) becomes bin-packing of VMs the product already admitted plus a per-client cap. It never ranks people against TODOs, so there is one placement brain. `FleetScaler` (GKE capacity pods) stays in plue.

**Direction rule: the install dials.** Spec §8.13.0 leaves open "whether a worker that dials the controller requires the install to be reachable from each computer, which §1.4's loopback default does not allow". Today the fleet is bidirectional: workers POST signed heartbeats to `SMITHERS_MICROSANDBOX_CONTROL_URL` (`P/cmd/microsandbox-worker/main.go:185-226`) and the controller dials worker websockets for exec, SSH and port streams (`P/internal/microsandbox/control/controller.go:2266, 2292, 2379`). The change is small: the controller-opened mTLS connection also carries the heartbeat and the guest relay, and the worker stops dialing. Then:

- On a Mac with `remoteSandboxes`, the backend embeds the controller (fleet tables in the install database) and dials each registered worker. Heartbeats, control calls and relay streams ride that one connection; the worker listens on the LAN, the Mac listens on loopback (spec §1, lines 66-67).
- For a "Smithers Cloud" computer, the Mac dials Smithers' controller.
- A cell dials the in-cluster controller the same way.

Fable's "Add computer requires a bind address" is rejected: it would make M-03 ("no public address is required") false for every remote computer. §8.13.7's SSH reverse forwards stay superseded.

**Per-branch machines in a cell** behave exactly as on a Mac: same daemon, same capture, same Branch card. The only visible difference is that Settings shows one computer, "Smithers Cloud", with the plan's limit, which `.specs/design/placement.md` already renders. `remoteSandboxes` (§8.13.2) gates only admitting a computer other than `this-mac`; a cell sets it on and has no `this-mac`. A previously placed machine still wakes on its computer after the flag is turned off.

## 5. Build, release and test

**One build per release tag.** `.github/workflows/release.yml` already runs `server-bundle` (macos-15, `build-native.ts`), `native-helper`, `installer-archive` and `homebrew-bottle`. Add one `linux-artifacts` job that builds `smithers-backend` and `smithers-worker` for linux-amd64 and linux-arm64, the TS host bundles, web assets and the guest image digests, and publishes `smithers-cell` as an OCI image plus sha256 values in the installer's manifest. Plue's `apps/backend/Dockerfile:19-30` stops downloading the module and rebuilding Go; it copies the artifacts by the digests in `release-manifest.json`, which `composition/release.go` already embeds and validates. `P/apps/cell/main.go` is about 150 lines: `app.Run(app.Config{...})` with Cloud adapters. Protocol adapters (fleet client, directory assertion, broker client) are public; vendor adapters (GCS, KMS, Cloud SQL IAM) stay in plue because `scripts/check-go-boundaries.py` bans cloud SDKs from public dependencies. Platform binaries differ; shared JavaScript and assets have identical digests.

**Test matrix.** Product logic is mode-free, so it is tested once; ports are tested per adapter; journeys run against both compositions.

| Layer | Test | Mac composition | Cell composition | Lives in |
| --- | --- | --- | --- | --- |
| Unit, integration | All product logic, once | n/a | n/a | Next to code |
| Port contract | `workspaceconformance` (extended, §7 P3) | microsandbox on a macOS VM runner; process fixture | fleet with an in-process controller and worker on a Linux KVM runner (`beaver`) | `B/workspaceconformance` |
| Port contract | `blobsconformance` (exists) | Filesystem | GCS (run in plue CI) | `B/blobs` |
| Port contract | `identityconformance` (new): replay, wrong audience, expired, unknown key, suspended member gets the same 401 | `LocalGitHubOAuth` with `githubfake` | `DirectoryAssertion` with a public fake directory | `B/identity` |
| Port contract | `githubappconformance` (new): token scope, webhook verify, OAuth exchange, no PEM exposure | Manifest store | Broker client against a public fake broker | `B/githubapp` |
| Port contract | `secretkeysconformance`: rotation, previous-key decrypt | File | KMS fake (real KMS in plue) | `B/ports` |
| Composition | `TestCompositionsServeOneProduct`: OpenAPI route set and bootstrap capabilities equal except operator rows | Yes | Yes | `B/internal/compose` |
| Ratchet | `scripts/check-deployment-branches.mjs`: mode checks 141 → 0; `internal/services` → `microsandbox` imports 8 → 0; app `host === "cloud"` sites 16 → 0 | n/a | n/a | `scripts/` |
| Rehearsal | `newRehearsal` (`B/internal/compose/rehearsal_integration_test.go:138`) gains a composition parameter: J1, J2, J4, J5, J6, J7, J11 now; J3, J8, J10 when written | Yes | Yes, with fake directory and broker | `B/internal/compose` |
| Real e2e | mvp.md §11 journeys on the reference Mac (`apps/app/e2e/real/`: `j1-activation`, `members`, `setup-no-github`, `team-no-github`, ...) | Release gate | n/a | `apps/app/e2e/real/` |
| Real e2e | Staging cell wrapping a scratch repository (`codeplanesmithers`): J1h (sign in, add repository, first merged TODO within 30 min), J2, J10 nightly; C-REL-03 upgrade rolled across staging cells per release | n/a | Release gate for Cloud; replaces `P/e2e/playwright/canary/*` | plue CI |
| Mode matrix | `run-packaged-mode-matrix.ts` modes `web-selfhost` and `web-cell` replace `web-plue,local-own,local-plue` (`release.yml:555`) | Yes | Yes | `apps/app/scripts` |
| Fault | Kill API, worker and controller around committed receipts, captures and outbound GitHub intents; no repeated merge, no false completion; partition one worker and retry elsewhere: no second writer before fencing | Now | When the fleet lands | `B/internal/compose`, `B/fleet` |

Hosted J1 starts after provisioning and the platform App instead of Homebrew and App creation; source-ready, machine-ready, first-merge and team-access assertions are identical. It does not count as Mac installation evidence. Keep the deliberately unresolved launch tests (chat usable, progress persists, duplicates deduplicate, failures retryable). Cells multiply upgrade rehearsals: every hosted release runs M-26's quiesce, backup, migrate and health path once per cell, so Mac upgrades inherit that evidence. T-PRC-03's owner, manual and provenance requirements remain binding.

## 6. What breaks today

Source findings, verified in this merge; not production incidents.

1. **Two products behind one mode bit.** `B/internal/config/auth_mode.go` (`selfhost` | `multitenant`) reaches 141 non-test sites in 15 files: `compose/router.go` 51, `compose/main.go` 38, `services/auth.go` 15, `compose/chat_routes.go` 7, `routes/auth.go` 4, `compose/github_sync.go` 4, `middleware/auth.go` 3, `config/validation.go` 3, `compose/{flow_composition,chat_composition,bootstrap}.go` 3 each. The MVP surfaces (`/stack`, `/terminals`, `/todos*`, `/proposals`, `/issues`, `/reviews`, `/secrets`, `/members`, `/install/*`, `/github/sync`, `/branches/{b}/*`) mount only under `IsSingleOwner` (`router.go:963-1062`); `composeBranchMachines` refuses hosted outright (`main.go:149-151`). Hosted runs `SMITHERS_AUTH_MODE=multitenant` (`P/infra/helm/smithers/templates/api-deployment.yaml:310-311`), which serves the retired forge. Hosted today cannot run a TODO.
2. **Hosted keeps the retired forge.** Route families the install hides by path (`middleware/tenant_routes.go:13-70`: `RejectTenantProvisioning`, `RejectDeferredTriggerManagement`, `RejectDeferredCommerce`, `RejectLocalAuth`) still mount hosted: orgs, admin users, local auth, Auth0, repository jobs, trials, agent sessions, egress audit, previews, plus `linear_*`, `alpha_*`, `onboarding_answers`, `oauth2_*`, `local_credentials` tables. Plue has not launched (`P/docs/architecture/shared-backend-cutover.md:63`), so no customer depends on them; our own tooling does (`packages/smithers/src/CloudSandbox.ts:145`, `flows/issue-sweep/vm.ts`, `packages/smithers/src/internal/backend/ProductApi.ts`).
3. **The app forks too.** 16 sites read `bootstrap.host === "cloud"` or `capabilities.includes("install")` (`state/AppController.ts` 4, `flows/entries/branch.ts` 3, `flows/entries/box.ts` 3, `state/controller/turns.ts` 2, `HostOpening.ts`, `flows/entries/wiki.ts`, `flows/entries/subjects.ts`, `App.tsx`). `B/webapp/handler.go:20-24` serves two index variants (`web-selfhost`, `web-plue`); `compose/bootstrap.go:61` hard-codes `Host: "cloud"` for both.
4. **Two machine runtimes for one contract.** `B/microsandbox` and plue's `workspaceruntime` (2,008 lines) over `P/internal/microsandbox` (2,439 + control 8,117 + worker 7,064 + cmd 1,711 lines) implement `WorkspaceRuntime` separately; files, terminal, services and egress secrets are each written twice. Plue's boundary script whitelists the name collision (`P/scripts/check-shared-backend-boundary.ts:33-36`). Capacity is bolted on by type assertion (`main.go:432-446`). People-first admission lives in `B/microsandbox/admission.go` and `services/workspace_machine_queue.go:17-22, 162-210` binds its types; eight `internal/services` files import `microsandbox`.
5. **Two compute models.** `workspace.WorkspaceRuntime` and `sandbox.Provider` (`B/sandbox/provider.go:44`, `app.Config.ComputeProvider`) coexist; the install never sets `ComputeProvider`.
6. **Fleet state is private.** `P/db/private/migrations/000001_private_baseline.sql` holds `sandbox_hosts`, `sandbox_instances`, `sandbox_operations`, `sandbox_snapshots`, `sandbox_access_grants`, `sandbox_volumes`, `sandbox_orphans`. `remoteSandboxes` exists only in specs, tickets and one `fixme` spec (`apps/app/e2e/playwright/spec/C-RMT-06.spec.ts`); C-RMT-01..06 have no code.
7. **Plue's next pin bump changes its GitHub App.** Plue pins `30e56fda1977` (2026-10-03 00:00, `P/go.mod:16`, same in `release-manifest.json`), which predates `d3915e36fe20` (2026-10-03 00:32) that added `selectGitHubAppCredentials` (`main.go:2340-2348`): with `EnvGitHubAppCredentials` unset, hosted moves to the empty sealed store. Plue sets the flag nowhere. Separately the port hands out the PEM (`github_app_credentials.go:32-42`).
8. **Product code and product coupling in plue.** `workspaceruntime/runtime.go:51-96` reads and updates `workspaces` by `user_id::text`, `outsider_workspaces` and `sandbox_environment_images`; it hard-codes the `developer` guest layout (`:28-30, 363, 589`) and `.preview.jjhub.tech` (`:661-671`). `control/private_queries.go:49-54` reads `agent_sessions` and `workspaces`. `composition/chat.go:152-227` holds provider origin defaults and the per-turn microVM launcher. `P/internal/hostedusage/usage.go` holds quota rules. `P/apps/github-sync` (4,360 non-test TypeScript lines) is a second GitHub sync worker beside product §6.3, driving `/api/repos/{o}/{r}/mirror-sync` from its own SQLite mapping. Feature flags are Helm values (`values.yaml:266-285`).
9. **Divergent sync, origins and wiki.** `compose/github_sync.go:22-56` picks two budget trackers and two fetcher factories and binds TODO polling only on the install; `router.go:311` vs `:353` are two origin middlewares; `main.go:1989-2001` starts two wiki syncs; `main.go:2061, 2079` start the storage reconciler from two branches; dead `provisioningEnforced` branches at `main.go:418, 1010, 2032`.
10. **Backup is APFS-only.** `B/internal/hostbackup/clone_darwin.go:14` ("never a copying fallback"), `clone_other.go` (`APFSCloner = RefusingCloner`), spec §16.5.2 ("A volume that isn't APFS is refused"). The manifest already records path, size and SHA-256 per file (`manifest.go:50-64`), so the format is portable and only the copier is not.
11. **Fleet transport is bidirectional.** Workers POST heartbeats to the controller and the controller dials workers (item 4 paths). A loopback-only install cannot receive heartbeats.
12. **Release evidence tests the forge.** `release.yml:555` runs `web-plue,local-own,local-plue`; plue's Dockerfile rebuilds Go from the module; `P/e2e/playwright/canary/` tests forge CRUD (`issue-crud`, `auth-flow`, `health`).
13. **Billing is a hosted startup dependency.** `P/apps/backend/internal/composition/composition.go:299` requires `Admission` for every role and `Commerce` for the API role, so a production-equivalent noncommercial rehearsal cannot start.

Refuted or stale panel claims: plue's pins disagree (they agree on `30e56fda1977`); `user_id` in the active workspace key (`0108_branch_machines.sql:43-47` already rekeyed it); `apps/app/src/runtime/BackendTargetSelection.ts` (no such file; mode selection lives in `apps/app/scripts/mode-matrix/plue-target.ts`).

## 7. Work needed

Sizes are agent-days. Items in a phase run in parallel unless Depends says otherwise. Every migration's acceptance includes deleting its old path. Reconcile with existing tickets (#2290, #3467, #3706, T-RMT) and claim before starting.

### Before the self-hosted MVP launch (about 6 agent-days, 4 lanes)

Only guards and evidence. Nothing here is on the stage 1–3 critical path, and nothing hosted waits on launch work.

| ID | Work | Days | Depends | Proof |
| --- | --- | --- | --- | --- |
| P0 | Plue: set `EnvGitHubAppCredentials: true` in the same commit as the next pin bump | 0.5 | — | Plue composition test: hosted loads the platform App after the bump |
| P1 | Ratchet `scripts/check-deployment-branches.mjs`: fail when non-test Go mode checks exceed 141 or appear outside the 15 listed files, when `internal/services` imports `microsandbox` from more than 8 files, when the app gains a `host === "cloud"` site beyond 16, or when a product OpenAPI row gains `x-composition` | 1 | — | Gate fixture tests; wired into `//scripts:gates` |
| P2 | Collapse the 14 raw `'github.repository'` readers onto `InstallRepositoryID` (`services/repo_permissions.go`); delete dead `provisioningEnforced` branches, the duplicate key-auth guard (`router.go:1116`, `auth.go:341`) and the triple issuer check | 2 | P1 | Ratchet count drops; existing install suites green |
| P3 | Extend `workspaceconformance`: sleep keeps the disk, wake after restart, capture yields the head ref, terminal, `base_digest` stale-write refusal, egress refusal, typed capacity error | 2–3 | — | Green on microsandbox real-VM CI and the process fixture |

P0 lands before plue's next bump; P1 this week. Everything else the panel put before launch is either MVP stage work that exists regardless of hosting (shared branch key: already `0108`; member provisioning; daemon capture; release rehearsal) or hosted-only work that costs the same after launch.

### After launch (Smithers Cloud, M-09)

| ID | Work | Days | Depends | Proof |
| --- | --- | --- | --- | --- |
| F1 | Move admission from `B/microsandbox/admission.go` into `B/machines` over `machines.Pool`; `microsandbox.Runtime` implements `Pool` as `this-mac`; `InstallCapacityService` reads `Pool.Hosts()[].Limits`; delete the type assertions; `internal/services` stops importing `microsandbox` | 3–4 | P3 | Admission tests move verbatim; a recorded 50-request trace grants in the same order; C-MCH-01, -04, -11 unchanged; ratchet import count 0 |
| F2 | Move controller, store, worker, protocol, client and fleet `WorkspaceRuntime` to public `B/fleet/{protocol,client,control,worker,runtime}` with fleet migrations under `B/fleet`; disk GC asks the product through a `Pool` callback instead of `private_queries.go`; plue keeps `FleetScaler`, Helm, certificate issuance and the GCS snapshot store | 4 (+2 plue) | F1, P3 | `workspaceconformance` against `fleet.Runtime` on a Linux KVM runner; plue boundary script passes with the packages gone; `go list -deps ./fleet/...` shows no GCP SDK; smithers-3f review (risk 11) |
| F3 | Install-dialed transport: the controller opens one mTLS connection per worker carrying control, heartbeat and the guest relay; the worker stops dialing | 4 | F2 | A 3 s drop reconnects; `pnpm install` of the smithers repository ≤ 2× local (T-RMT-01 bar); the worker never dials the install |
| F4 | Controller as a host-service duty on the Mac (fleet tables in the install database); `placement.Runtime` routing by `workspaces.host`; `remoteSandboxes` gates non-`this-mac`; Settings Computers per placement.md; T-RMT-02/04 reshaped onto the fleet | 3–4 | F3 | A real microVM run on `beaver` from the mini, recorded; C-RMT-02, -03, -04 |
| F5 | `PGStore.Allocate` becomes bin-packing plus a per-client cap; the controller's ranking goes | 2 | F1, F2 | Two-client fairness test; no reordering against the product admission trace |
| F6 | Pooled "Smithers Cloud" computer with `Limits` from the entitlement; a Mac install can dial Smithers' controller | 2 | F3, F4 | C-MCH-11 with an entitlement host; a Mac places one machine on Cloud |
| I1 | `identity.SignIn`: extract `LocalGitHubOAuth`; add `DirectoryAssertion` and a public fake directory; `identityconformance` | 3 | — | Conformance on both; C-ACC-01, -03 |
| I2 | `githubapp.Source` at token level: manifest-store adapter, broker client, public fake broker, per-cell webhook HMAC; delete `EnvGitHubAppCredentials` and `selectGitHubAppCredentials` | 3 | — | `githubappconformance`; C-GH-01, -07, -08 on both; no method returns a PEM |
| I3 | `ports.SecretKeySource` with file and KMS-wrapped adapters; replace env-var key reads | 1–2 | — | Rotation and previous-key decrypt on both; C-SEC-03 |
| I4 | `models.Access` per role; cells hold owner keys only; gateway source for the fast model; delete `PlatformModelKeys` and metered admission from the cell | 2 | I1 | Model proxy tests per source; no provider key in any guest environment |
| C1 | `P/apps/cell/main.go`; `linux-artifacts` release job and `smithers-cell` image; plue Dockerfile copies by digest, no Go rebuild | 3 | I1–I3 | Two builds of one commit yield equal digests; `release_test.go` pin check; cold deploy needs no sibling checkout |
| C2 | Parameterize `newRehearsal` by composition; run J1, J2, J4, J5, J6, J7, J11 on the cell composition; `TestCompositionsServeOneProduct` | 3–4 | C1 | Matrix green on both; route and capability parity |
| C3 | One `EffectiveOrigin` for both; delete `CanonicalBrowserAuthOrigin`; capabilities from ports replace the 16 app sites, `webapp.Mode` and the `"cloud"` bootstrap host; mode matrix `web-selfhost,web-cell` | 2–3 | C1 | C-INS-03 under both; `navigation-frames`, `todo-*`, `members` specs; `release.yml` matrix |
| C4 | SSH `<install>.<branch>` user form in the product gateway plus the plue SSH router | 2 | C1 | J3 SSH steps through the router |
| C5 | `hostbackup.TreeCopier` with APFS-clone and plain-copy adapters; restore accepts either; spec §16.5.2 amended | 2 | — | C-REL-06 plus a Linux backup → restore round trip; a Cloud backup restores on a Mac |
| H1 | Plue cell manager: create (database, role, volume, origin, entitlement, setup handoff), roll upgrades through the quiesce, backup and migrate API, delete, export a backup | 4 + 4 | C1, C5, I3 | Staging: create → J1 → upgrade → restore the backup on a Mac |
| H2 | Plue directory, edge router, webhook router and broker | 4 + 4 | I1, I2 | Staging cell J1h, J2, J10 nightly |
| H3 | Move the forge's own callers: `CloudSandbox.ts`, `flows/issue-sweep/vm.ts`, the `smthrs environment` Cloud location in `ProductApi.ts`, benchmarks, onto cells or TODOs | 2–3 | H2 | Zero `/api/repos/{o}/{r}/workspaces` callers outside tests |
| H4 | Retire the forge composition: delete `auth.mode`, `topology.multitenant`, `IsSingleOwner`, `IsMultitenant`, the multitenant route families, `sandbox.Provider`/`ComputeProvider`, `RepositoryPlacement`/`RepositoryProvisioning`, `previewgateway`, two-path repository creation (`main.go:625-633`), two budgets and fetchers, `webapp.Mode`, and the forge tables | 3–4 × 4 lanes | C2, H3 | Ratchet reaches 0; `TestRetiredTablesAbsent`; C-CAT-01; `mvp-deferred-doors.spec.ts`; OpenAPI loses forge rows |
| H5 | Remove product code from plue: delete `apps/github-sync`, `workspaceruntime` (moved in F2), `private_queries.go`, the per-turn chat launcher; outsider egress rule into `WorkspaceSpec` (the adapter only enforces it); chat origin defaults into `B/modelhost`; `hostedusage` quota becomes the entitlement; feature flags out of Helm values; `clusterstorage`, `repoprovisioning` and the `repo-host` StatefulSet go with the forge | 2–3 each | F2, H4 | Plue boundary script: no product table names in plue SQL; plue Go is adapters and infrastructure only |
| H6 | Billing (M-09): plans become entitlements (row 8) and gateway credits (row 10) at the directory; `commerce`/`credits` composed by plue only | post M-09 | H1, H2 | Product tree has no `commerce` import; duplicate charge, webhook replay and interrupted settlement tests |

**Lanes after launch:** Fleet F1 → F2 → F3 → F4 → F5, F6. Identity I1, I2, I3 in parallel → I4. Composition C1 after I1–I3 → C2, C3, C4; C5 independent. Plue H1 after C1, C5, I3; H2 after I1, I2. Cleanup H3 → H4 → H5; H6 later. Extracted fleet packages must build without GCP or private configuration. Split any package whose measured scope exceeds four days at a port boundary, never by leaving two implementations active.

## 8. Risks and open questions

| # | Risk or question | Cheap falsifier |
| --- | --- | --- |
| 1 | Cells cost too much per team | Run the J1 rehearsal composition idle for 1 h with pollers on. Backend + flow host + model host above 1 GiB RSS or 0.05 vCPU breaks §3's claim; then scale-to-zero moves before the Cloud release |
| 2 | Cloud SQL connections grow as cells × pool size | 100 staging cells at pool size 5. A C-PERF-02 p95 regression or `max_connections` means PgBouncer before launch |
| 3 | The fleet worker code cannot run `this-mac`, leaving two local adapters forever | `P/internal/microsandbox/worker/reflink_darwin.go` already exists. Build `B/fleet/worker` for darwin and boot one `msb` guest on the mini: one day. If it works, `this-mac` becomes a worker and `B/microsandbox` shrinks to the executor |
| 4 | The install-dialed relay is too slow for package installs on remote machines | T-RMT-01's bar, ≤ 2× local. If it fails, egress for those machines leaves from the worker and host-bound secrets are refused there |
| 5 | A partition creates two writers | Disconnect one worker while issuing wake and retry on another. Any second writable branch before the first is fenced invalidates recovery |
| 6 | Lifting admission (F1) reorders grants | Recorded-trace equality test; any reordering blocks the land |
| 7 | Retiring the forge breaks unknown callers | Grep public callers plus 7 days of plue request logs grouped by route family; issue-sweep and the benchmark pool are known callers and move first (H3) |
| 8 | One shared GitHub App exhausts its rate budget | Limits are per installation. Staging C-GH-08 telemetry stays above 50 % remaining at M-03 cadence |
| 9 | The fast model through a Smithers sign-in contradicted "needs no Smithers account" (mvp.md §12 item 5) | **Decided (product, 98, 2026-10-06):** the macOS install needs no Smithers account. The Smithers gateway is an optional fast-model source, and J1's default is the owner's own key. |
| 10 | Per-node volume attach limits cap the number of cells | Staging load script at 200 cells; move cell volumes to a shared filestore if a node hits its limit |
| 11 | Moving the controller public exposes code that was safe only while private | smithers-3f reviews `B/fleet` before F2 lands. Any embedded credential or trust in network position blocks the move |
| 12 | The same GitHub repository bound to two cells | Rule: one active cell per GitHub installation and repository within a deployment; a transfer freezes writes and preserves identity. Try the double binding on staging before H1 lands |
| 13 | "Small adapters" becomes a false promise | After H5, count product decisions and SQL left in plue. Remaining role checks, TODO transitions or GitHub behavior falsify the seam; placement fencing, GCS and GKE operations are legitimately infrastructure |
| 14 | A GKE node drain forces a GCS restore and warm wake misses spec §18's 5 s | Measure wake-after-drain on staging. Over 5 s, the card shows "Restoring" and the 5 s budget stays scoped to same-worker wakes |
| 15 | Open: does a hosted install keep Obsidian folder sync? | Product decision; default no (row 16, nil adapter) |
| 16 | Open: embedded controller in-process on the Mac or a sibling launchd job? | In-process unless `B/fleet` needs CGO or a privilege the backend lacks; check `go list -deps` and the entitlement list during F2 |

**First action:** land P0 and P1 this week. One plue line prevents a silent GitHub App switch on the next pin bump, and one gate stops hosted and self-hosted from drifting further apart while the MVP ships.
