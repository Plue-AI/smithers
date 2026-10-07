# One factory, two deployments

Codex Sol — independent design, 2026-10-06. Evidence is the supplied Smithers checkout and the read-only `~/plue` checkout; this is a target design, not a report of executed release tests. `packages/backend/AGENTS.md` is absent in this checkout; root rules and `apps/app/AGENTS.md` were read.

## 1. Summary

Smithers should ship one factory implementation from `packages/backend`, with one browser app and deployment adapters selected explicitly at startup. A factory belongs to a team and wraps one GitHub repository; the Mac hosts one factory, while Cloud hosts many instances of that same logical unit. Branch lifecycle, authorization, TODOs, flows, GitHub synchronization, working-copy semantics and usage receipts stay shared, while adapters supply infrastructure and credentials. Launch the Mac MVP first, then move the reusable Cloud controller and worker into the public backend and use them for both hosted compute and flagged remote computers. Build both deployments from one versioned product release and require the same behavioral tests and journeys before declaring hosted parity.

## 2. The seam

Keep `packages/backend/app.Config` as the composition entry point and `internal/compose` as the sole route/worker assembly. Preserve `DutiesAll`, `DutiesHTTP` and `DutiesWorkers`: process placement is independent of team count. Replace `topology.hosted()` with explicit dependencies; no product service chooses behavior from an edition, hostname or payment configuration.

The table names existing interfaces where available; **new** means a proposed exported contract. Public aliases belong in `packages/backend/ports`, referencing the owning package rather than introducing parallel types. Each row has one authority-bearing seam; supporting facets remain part of its contract.

| Difference | Port and location | Mac adapter | Hosted adapter |
| --- | --- | --- | --- |
| Identity and sign-in | **New** `IdentitySource`, `ports/identity.go`: verified external subject acquisition | `InstallGitHubIdentity`, using the owner's App | `PlatformGitHubIdentity`, using our App |
| Factory selection and tenancy | **New** `FactoryResolver`, `ports/factory.go`: resolve an authorized team/repository binding | `SingleFactory`, bound during setup | `DirectoryFactories`, resolving the same product directory by repository route |
| PostgreSQL ownership | **New** `DatabaseConnector`, `app/database.go`: open a configured `pgxpool.Pool` plus its closer | `BundledPostgres`, existing `postgres` supervisor | `ManagedPostgres`, deployment DSN/TLS/IAM connection configuration |
| Blobs and archived logs | Existing `ports.BlobStore`, with its agent-log facet | Public filesystem blob/log stores | Plue `internal/cloudstorage`, GCS |
| Repository storage and placement | Existing public `repository.Client`; its resolver/provisioning facets exported through `ports` | `localbootstrap` in-process repository engine and local durable reservation | Plue `internal/clusterstorage` router and `internal/repoprovisioning` reservation |
| Machines and placement | Existing `workspace.WorkspaceRuntime`, `workspace/contracts.go` | Public `microsandbox.Runtime`, libkrun | Controller-backed runtime, extracted from Plue `workspaceruntime` |
| GitHub App ownership | Existing `GitHubAppCredentialSource`, currently `internal/services/github_app_credentials.go`; export through `ports` | Sealed manifest-created `GitHubAppCredentialStore` | Platform App source backed by Secret Manager; current `EnvGitHubAppCredentials` is its transport |
| Encryption/root secrets | **New** `SecretKeySource`, `ports/secrets.go`, returning active key and decrypt-only previous keys | Protected install-key file | Mounted Secret Manager key ring |
| Model access and metering | Existing `modelhost.Resolver`, `modelhost/host.go`, extended with payer identity | Factory credentials and permitted connected accounts | Same resolver supplied platform seats and tenant payment authority |
| Addresses, TLS and origins | **New** `ServingConfigSource`, `ports/serving.go`; supplies listener and known origins | Owner's durable address settings, loopback default | Private edge/ingress configuration, HTTPS public origin |
| Upgrade and backup transport | **New** `ReleaseDriver`, `ports/release.go`, called by shared maintenance flows | Homebrew/launchd and APFS/`pg_dump` driver | Helm rollout and managed DB/object snapshot driver |
| Observability export | Existing `trace.SpanExporter` and Prometheus collectors in `app.Config` | Local logs, optional OTLP | Cloud Trace/managed collectors |
| Billing, later | Existing `commerce.Service`, `commerce` | Disabled commerce adapter | Plue `internal/stripecommerce`; shared admission evaluates entitlements |

Authentication sessions, credential kinds, roster membership, GitHub write-access rechecks, CSRF, confirmation and person-only approval are product policy, never `IdentitySource` decisions. Both identity adapters use the same OAuth exchange implementation with different App credentials. Hosted email sign-in remains an honest unavailable result until an actual identity adapter supports it; preserve the existing minimal login card.

`FactoryResolver` selects scope; it does not authorize arbitrary user-supplied tenant IDs. The common access service authorizes the binding. Database adapters do not implement queries or migrations: both run `app.Migrate`, the same SQL and transaction semantics, on PostgreSQL 18. There is no alternative database backend.

Blob services retain shared staging, size checks, digest verification and generation-fenced deletion. Repository adapters retain one jj/native engine and one operation protocol; only endpoint selection, reservation and durability transport differ. Signing a cloud URL must not bypass the authorization that precedes a local transfer route.

`SecretKeySource` replaces ambient encryption-key reads, not the secret service. Rotation, sealing, scope, revocation and response redaction stay public. Likewise the model resolver yields a scoped seat with `{team_id, repository_id, principal_id, payer, credential_ref}`; canonical model requests never contain credentials. The existing model proxy records reserve/settle receipts for owner-paid and platform-paid calls. An unreadable ledger means unknown spend and refuses another paid call. `admission.Policy` remains the shared quota engine; hosted usage adapters contribute measurements, not a second plan evaluator.

Serving adapters supply facts to `middleware.ResolveEffectiveOrigin`; they cannot reinterpret forwarding headers. Cloud's edge preserves the original Host and proxies `/api`, live sockets and assets under one origin. HTTP on a LAN remains supported. Both use host-only cookies, exact Origin checks, CSRF and no ordinary browser CORS. Release drivers move bytes; the product owns freeze, drain, capture, schema compatibility and recovery. Wiki pages/revisions also stay product data; the Mac's Obsidian folder sync is an optional projection, with no replacement hosted wiki service.

## 3. Tenancy model

The logical unit is `FactoryScope {TeamID int64, RepositoryID int64}`. Reuse `organizations` for Smithers teams, `repositories` for wrapped repositories and `collaborators` for the repository roster. A Smithers team is not necessarily the GitHub organization that owns its source. Hosted personal-owner records migrate to a personal team; existing org-owner records map to their existing team. Preserve historical actor IDs and event decoding.

Before launch, every service receives an explicit repository scope, even though setup binds exactly one repository. Multi-repository selection and provisioning remain hidden. After launch, add the hosted directory constraint that every repository has a non-null canonical team binding; migrate old ownership in one effort and remove the old ownership lookup from active code.

Resolve `/{owner}/{repo}` to a canonical product repository ID, then verify the user's roster role and current GitHub write access. Global install aliases such as `/api/todos` bind the singleton through the resolver; hosted repository routes invoke the same handlers with their resolved scope. Never infer a team from a mutable slug, header or cookie alone. TODO numbers are unique per repository, and branch names identify branches only within that repository.

Queries in `db/product/queries` take repository/team parameters where they select factory resources. UUID-only getters are internal primitives, not an authorization boundary: each external lookup must join or predicate on its resolved repository before returning content. Compound constraints prevent a run, approval, share or conversation from pointing across repositories. List/search queries, notification fan-out, live topics, cursors, artifact capabilities, source caches and journals carry the same scope. Background claims record scope before leaving the request; recovery rechecks authority rather than borrowing a worker's ambient identity.

Extend `workspace.Operation` in `workspace/context.go` with `RepositoryID`; make `TenantID` the canonical team ID and keep `PrincipalID` the actor. An owner's user ID is neither a team ID nor proof of branch access. Placement grants bind `{team_id, repository_id, workspace_id, operation_id, generation, expires_at}` and are checked at controller, worker and guest entry. Reassignment invalidates old grants. Product branch access uses `workspace_shares`; physical placement lives behind the runtime port.

Move factory-valued settings currently addressed by `install_settings.key` into scoped product configuration, using the existing repository configuration store where appropriate. Address, install key and local supervisor settings remain install-global; model roles, flow settings and parallelism are repository-scoped. Migrate each value and delete its former read/write path together. Do not introduce a second settings implementation. Hosted replicas share PostgreSQL, durable claims and revocation delivery; process memory is only a cache, never the source of singleton branch ownership.

## 4. Machines

Keep `WorkspaceRuntime` as the one product runtime interface. Lifecycle, execution, terminal, file, preview and managed-host facets describe operations on the same machine; no SSH runtime or Cloud-specific branch model appears. Shared services own requested/starting/awake/asleep/unreachable projections, safe-idle, capture and admission. Adapters own physical boot/stop/streams and report evidence, not optimistic state.

For the MVP, retain the bundled local libkrun adapter and fail startup if isolation is unavailable. `process.Runtime` remains an explicit test fixture only. Complete member provisioning, machine-daemon sessions, watcher/bursts and co-editing in the existing stage order; several contracts already exist but still refuse activation without receipts.

After launch, extract Plue's reusable `internal/microsandbox/{control,worker,client.go,protocol.go}` into `packages/backend/fleet`, with shared public binaries. Leave GKE scaling/IAM, Secret Manager wiring, GCS snapshot transport, Helm and Terraform in Plue behind narrow fleet store/export/scaler adapters. Extract controller-backed `workspaceruntime` into the public backend too. Its direct product-table SQL becomes public product queries; private fleet persistence stays behind a placement store.

Converge guest operations on the same `smithers-machined` protocol. Remove duplicate file scripts, session identity rules and service launch logic once their daemon replacements pass contracts. The physical drivers differ: the Mac uses libkrun/Hypervisor.framework, Cloud Linux workers use nested KVM. Refactor the local boot implementation into the worker's Darwin driver when that migration ships, deleting its former independent boot path. A local install can call the common controller/worker in process with loopback transport; Cloud starts them separately. There is one controller scheduler and recovery engine, not a new remote scheduler beside it.

One durable lane workspace exists per repository/branch, independent of member and agent. Concurrent join/wake uses its unique key and a generation-fenced lease, yielding one VM and one working copy. The agent has its own uid, each member a stable uid and a per-machine home, and nobody gets sudo. Their terminals, SSH editors and File cards attach to that machine's daemon; watching a terminal grants no access to its owner's tool credentials. A fork creates another branch and disk from the captured revision, never another live copy of the same branch or a clone of member login homes.

Sleep first ends relevant sessions, persists document acknowledgments, captures the working-copy head and journals, then confirms VM stop while retaining disk and homes. Failed capture leaves the machine awake or visibly failed. Wake uses the disk's existing computer and pinned image/flow; there is no routine live migration. Asleep reads use the repository store's last capture and identify that revision. Cold recovery preserves completed durable steps; an uncertain shell/model action is reconciled or shown interrupted.

Capacity is physical capacity constrained by owner reductions and, later, entitlements. Use one host-profile formula from E-17: detect memory, performance/physical cores and current free disk, reserve preparation within the branch's slot, and count unsuccessful stops as held. Share the people-first FIFO (person, TODO, background) without preempting working agents. The controller atomically reserves the chosen computer; it must not independently admit a second slot for an already admitted operation. Hosted fairness across teams adds eligibility to that queue, not different branch behavior.

`remoteSandboxes` is off on the MVP install and gates every new remote placement, including Cloud. Hosted composition explicitly enables it when Cloud is released. A previously placed machine still wakes on its computer after the flag is disabled. Auto picks the reachable eligible computer with most free slots, ties to `this-mac`; pinned work waits, and forks follow their origin. Unreachable computers contribute no new capacity but retain held slots until stop/removal is confirmed.

Remote enrollment uses the existing signed-heartbeat/mTLS controller-worker system, with a one-time owner enrollment grant and computer-scoped certificate. The current fleet also requires controller-to-worker streams: neither direction magically works through a loopback-only install. Require explicit private controller/worker reachability before enabling remote enrollment; preserve the default product listener on loopback. Do not revive §8.13's superseded SSH keys or reverse forwards. Remote disks stay remote; engine, journal authority, repository store, provider keys and merge authority stay at the factory control plane. The pending spike must prove guest journal/model/egress access under this topology before remote tickets leave hold.

## 5. Build, release and test

Use one public product release graph rooted at a source commit: web assets, Go backend, native repository engine, coding/model hosts, daemon, CLI/skill and architecture-specific guest images. `apps/app/scripts/build-native.ts` packages its Darwin outputs into the Homebrew bottle; Linux outputs form an immutable product payload consumed by Plue's thin wrapper build. A build graph has multiple architecture jobs, not one identical binary. No hosted UI rebuild from another commit, no copied product source in Plue, and no public build dependency on Plue.

A generated product manifest records component hashes, source commit, guest architecture, protocol versions and schema version. Plue records a separate deployment revision plus that product manifest digest. Preserve deployment attestations and worker drain protections. Darwin and Linux VM images may differ in architecture and platform layers, but the daemon/host protocol and product release are the same.

| Test layer | Run once/shared | Composition-specific execution |
| --- | --- | --- |
| Unit/behavior | Product authorization, transitions, retry/order, projections, quota and flow invariants | Both configuration assemblies and invalid dependency combinations |
| Real PostgreSQL integration | Same migrations, queries, outbox/recovery and scope tests | Bundled PG18 and managed-compatible PG18; hosted adds two teams/two repositories |
| Port contracts | One reusable suite per port, including cancellation, restart and uncertain outcomes | Filesystem/GCS, local/router repository transport, both machine drivers, key rotation and identity configurations |
| Product boundary integration | Same HTTP, CLI, authoring API and live-channel cases | All-in-one Mac and split HTTP/worker/controller composition |
| Journeys | One parameterized J1–J11 script/recording specification | Real reference Mac; then isolated hosted rehearsal against the same release |

Hosted J1 begins with provisioned infrastructure and a platform App rather than Homebrew and creating an App; source-ready, machine-ready, first TODO, human merge and team access assertions remain identical. Run J2–J11 without substituting a private product implementation. J9 remains P1; hosted availability is not evidence of its completion. Include plain HTTP LAN and HTTPS, keyboard-only operation, both themes, two simultaneous writers, roster revocation, capacity one, sleep/wake, reboot, duplicate launch and an unresolved remote launch while Chat remains usable.

Fault tests kill API, workers and controller around committed receipts, captures and outbound GitHub intents; check no repeated merge and no false completion. Mock transports are for bounded unit failure injection; integration uses real PostgreSQL, storage and microVMs. Record executed coverage, host profile, commit and limitations; configured coverage or skipped tests are not receipts. Existing engineering ticket checks retain authenticated provenance and owner-signature requirements. Cloud rehearsal follows MVP launch and maintainer delivery; it cannot delay stage-1 dogfooding or pretend to satisfy unexecuted Mac checks.

## 6. What breaks today

1. `internal/compose/main.go` derives `topology.multitenant` from auth mode and makes `hosted()` its synonym. `composeBranchMachines` rejects install providers in hosted mode and restricts injected providers to trusted-process tests. Cloud cannot simply inject its isolated runtime and receive the Mac branch-machine behavior.
2. `internal/config/auth_mode.go` still describes selfhost as “exactly-one-owner.” `internal/compose/router.go` attaches the member boundary and `/members` routes conditionally for selfhost. Hosted tenancy does not automatically get the MVP roster/roles boundary.
3. `internal/compose/github_sync.go` explicitly retains an old hosted budget policy, chooses different fetcher factories and binds TODO checks/review polling only on the install path. App ownership legitimately differs; polling correctness and merge evidence should not.
4. `main.go` chooses different repository service constructors and import provisioning: hosted import provisions a workspace, whereas local import ends at mirror readiness and prepares machines separately. This conflates storage placement with product setup milestones.
5. `db/product/migrations/0095_workspace_source_commit.sql` includes `user_id` in the active workspace key. `queries/workspace.sql` still has user-keyed lists and a flow-workspace predicate requiring a machine-service workspace's sole write grantee. Neither gives stage-2 multiplayer merely by passing another runtime.
6. Plue `apps/backend/internal/composition/workspaceruntime/runtime.go` directly reads/updates product `workspaces`, `outsider_workspaces` and `sandbox_environment_images`. It compares `Operation.TenantID` with `workspaces.user_id`, creates `developer`, and executes with that home. These are product ownership/policy decisions leaking into an adapter.
7. Plue `workspaceruntime/files.go`, `services.go` and `terminal.go` duplicate guest operation semantics already represented by public `microsandbox/{files.go,exec.go,guest.go}`. Shell operations and a shared `developer` identity must converge on the daemon contract, including file mutation ordering.
8. The reusable fleet controller/worker is private in Plue. Self-host remote placement cannot reuse it without extraction; adding SSH-prefixed execution would violate §8.13.0. That reconciliation expressly supersedes §§8.13.3, 8.13.7 and 8.13.8; those older paragraphs are not implementation instructions.
9. `install_settings` migration `0104` has a global key; `internal/compose/agent_models.go` uses `EffectiveInstallAgentModel` and `GetSelfHostOwner`. Model role configuration cannot be applied to several factories safely as written.
10. `apps/backend/main.go` wires a local model launcher while Plue `composition/chat.go` wires an isolated launcher: physical location is a valid adapter difference, but preserve the same `modelhost.New` and one credential/recovery contract. Public `microsandbox/member_identity.go:EnsureMember` currently refuses pending roster/image/broker receipts; declaring the interface implemented would overstate readiness.
11. Plue's checked-in release evidence disagrees: `go.mod` pins `aab4da61f8b5`, while `composition/release-manifest.json` pins the backend/hosts to `bf9d328b303c`, the UI to `e0cbb3f7ad43` and the guest to `b3f589afd39c`. Strict production validation may refuse this checkout; source inspection does not establish what production runs.
12. App `runtime/BackendTargetSelection.ts` still chooses `web-plue` versus `web-selfhost` partly from credential presence, and transport tests retain native/local modes. Production boot should use same-origin transport plus explicit capabilities. Keep persisted-history decoding and public library transport compatibility; remove obsolete product dispatch, not historical readers.

## 7. Work needed

These are design work items, not newly opened or claimed issues. Reuse implementing T-* tickets first; create/claim any missing implementation issue before work. Each slice is approximately 1–4 agent-days excluding external approval/release waiting. Dependencies define lanes, not permission to release deferred features early.

### Before self-hosted MVP launch

| Order / lane | Work item and estimate | Proof |
| --- | --- | --- |
| A1, foundation | Explicit `FactoryScope` and singleton resolver through current handlers (2d) | Wrong selectors cannot retarget TODO, wiki, secret or run APIs |
| A2, after A1 | Scope model/flow settings, migrate values and remove global factory reads (3d) | Restart preserves values; two-scope fixture cannot observe another binding |
| B1, parallel A | Export credential/key seams; remove `EnvGitHubAppCredentials` boolean selection in favor of a source (2d) | Single-use OAuth state, rotated key decrypt, zero exchanges after refusal |
| B2, after B1 | One response-budget/conditional GitHub polling implementation (3d) | ETag/304, rate-limit recovery, check/review observation and stale-head merge refusal |
| C1, stage 1 | Separate physical capabilities from `hosted()` in branch admission/import composition (3d) | Isolated runtime fixture can reach branch providers; mirror-ready is distinct from machine-ready |
| C2, stage 2 | Branch singleton key and grants; retire per-person active branch lookup (3d) | Two members racing join create one workspace; independent forks still work |
| C3, after C2 | Complete actual member provisioning/daemon sessions, removing `developer` assumptions on the Mac (4d) | C-MCH-10, C-COL-04, no sudo, homes retained and credentials inaccessible to watchers |
| C4, stage 3 | Complete daemon capture/document path and delete replaced file mutation paths (4d) | C-COL-05/C-DUR-04, outside save, concurrent edits, sleep capture failure |
| D1, parallel A | Same-origin production bootstrap, minimal identity card, origin configuration seam (2d) | HTTP LAN/HTTPS login, CSRF/socket Origin, no credential-based edition selection |
| D2, release | Public component manifest and Darwin packaging validation (3d) | Tampered bundle refusal, offline first VM, matching host/guest protocol |
| D3, after D2/C | Shared maintenance semantics with Mac release driver (4d) | C-REL-03/C-REL-06, backup/restore on second Mac, interrupted upgrade stays frozen |
| E1, across stages | Parameterize existing boundary/journey harness and collect actual MVP receipts (3d) | J1/J2 first, then remaining launch journeys/checks on reference Mac |

C3/C4 are likely several existing tickets, so keep each implementing slice bounded; the estimate is for convergence work, not a promise that all missing multiplayer fits eight days. Launch still requires every existing stage and release check. After stage 1 J1/J2 pass, subsequent work defaults to TODOs on Will's install (M-31/M-37).

### After MVP; remote and hosted remain deferred until authorized

| Order / lane | Work item and estimate | Proof |
| --- | --- | --- |
| F1 | Reusable fleet extraction, first controller protocol/store boundary (4d) | Existing controller fencing/recovery tests run in public package; no GCP import required |
| F2, after F1 | Worker extraction and Darwin driver convergence (4d) | Real local VM lifecycle/cancel/snapshot contracts; remove former local boot path |
| F3, parallel F2 | Public controller-backed workspace adapter; relocate product SQL (3d) | No Plue product-table SQL outside approved ports; local/fleet runtime contracts identical |
| F4, after F2/F3 | Flagged remote enrollment/reachability spike, then placement/removal implementation slices (1d spike, 3d per slice) | C-RMT-02/03/04; loopback refuses inaccessible enrollment; stale worker never creates a second live copy |
| G1, after A | Hosted team/repository binding and scoped configuration migration (3d) | Old owner data survives; all externally reachable resource families pass two-team isolation |
| G2, after G1 | Scoped query/live/cache isolation audit, one resource family per slice (2d each) | Tampered IDs/cursors/capabilities and revoked credentials leak no content |
| H1, after F/G | Shared Linux payload consumption and coherent Plue re-pin; delete duplicate host/image builders (3d) | Manifest/hash/protocol checks; cold deploy needs no sibling checkout |
| H2, after H1 | Hosted J1–J11 rehearsal and failure matrix (3d) | Recordings/receipts on actual GKE/KVM and same product release as Mac |
| H3, later | Connect commerce and tenant metering without changing factory behavior (3d) | Duplicate payment events, lock-through-commit quotas, unknown-spend refusal |

Cut over each migration with verified data conversion, reader switch and old-path deletion in the same landed change. No dual runtime or settings implementation remains as a permanent rollout strategy. Plue keeps infrastructure tests; product behavior tests move to Smithers and receive deployment adapters from the rehearsal harness.

## 8. Risks and open questions

- **Fleet code may not boot on macOS under launchd.** Cheap falsification: run one extracted worker against the signed bundled libkrun on a clean Mac, create/sleep/wake one guest. Failure leaves remote tickets on hold and the proven local MVP adapter intact until a complete migration is ready.
- **Controller networking may contradict loopback-default installs.** Cheap falsification: enroll a second LAN box while the install is loopback-only, then with explicit private endpoints; verify both heartbeat and controller streams. Decide the documented reachability prerequisite before UI or enrollment work.
- **One shared branch may break existing owner-fenced placement.** Cheap falsification: two members and the agent join one branch, revoke one member, then restart the controller. Check one VM, separate homes and revoked access; no ownership reassignment workaround.
- **Shared Cloud App polling may exhaust a rate budget across teams.** Cheap falsification: replay conditional polls across two installations with recorded rate headers. Quotas/fairness are keyed to GitHub's actual budget identity, never a single process-wide guess.
- **Capture recovery may permit two live working copies.** Cheap falsification: partition a worker, expire its lease, attempt replacement, then restore the old connection. Replacement must wait for fencing; disk export is not proof the original VM stopped.
- **Mac ARM and Cloud x86 images may disagree.** Cheap falsification: identical tiny repository through image preparation, daemon session, captured head and flow replay on both architectures. Compare protocol and receipts, not byte-identical VM disks.
- **Current release pins may hide untested integration.** Cheap falsification: read built dependency metadata and invoke manifest validation on staged artifacts before deployment. Rebuild/re-pin coherently rather than weakening checks.
- **Hosted wiki disk projection and upgrade availability policy need owner decisions.** Cheap falsification: demonstrate shared wiki revision recovery without Obsidian, and measure one tenant's quiesced upgrade with another active. These decisions follow MVP; no new sync product or rolling-upgrade promise is assumed.
