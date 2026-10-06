# One product, two deployments

## 1. Summary

Keep `packages/backend/app` as the sole product composition and `apps/app` as the sole browser application. Treat the self-hosted install as one repository-scoped factory, and host many such factories using the same authorization, flows, stack, machine lifecycle and schema. Replace decisions based on `topology.hosted()` with explicit deployment capabilities and an authenticated factory scope, preserving the existing storage and execution ports. Keep the Mac’s libkrun adapter and reuse the Cloud controller and worker for remote placement, moving their reusable implementation into the public backend before enabling remote machines. Ship the self-hosted MVP first, then complete hosted convergence through the same journey tests and release manifest, deleting each replaced implementation during its migration.

## 2. The seam

This is a target design, not a claim that both compositions work today. Paths below are relative to Smithers unless prefixed `plue/`; proposed interfaces and paths are marked **new**. The scoped `packages/backend/AGENTS.md` requested by the brief is absent in this checkout; root instructions apply. No tests or deployed systems were exercised for this design.

Keep `app.Config` as the composition boundary. `DutiesAll`, `DutiesHTTP` and `DutiesWorkers` already separate process placement; preserve them. Authentication mode must stop deciding whether TODOs, branch machines, live collaboration or conditional GitHub polling exist. Product capabilities follow their actual dependencies, and invalid combinations refuse startup.

Each row has one authoritative seam for its concern. A seam can be a configuration record or an existing protocol: it does not justify a second service hierarchy.

| Concern | Interface and location | Self-hosted adapter | Hosted adapter |
| --- | --- | --- | --- |
| Identity and sign-in | **New** `ports.IdentityBindingSource`, `ports/identity.go`: resolve sign-in methods and credential references for a factory/origin | `InstalledIdentityBinding`, backed by setup’s sealed App reference | `HostedIdentityBinding` in Plue, backed by the platform App reference |
| Tenancy and routing | **New** `ports.FactoryScopeResolver`, `ports/scope.go` | `BoundFactoryScope`: the one installed repository | `RoutedFactoryScope`: shared backend implementation resolving the repository route and authenticated membership; Plue supplies allowed hosts |
| Database | Existing `config.DatabaseConfig` → `database.NewPool`; same pgx/SQL contract | Bundled PostgreSQL 18, supervised by installed launcher | Cloud SQL PostgreSQL, deployment credentials and pool sizes; align its supported major before release |
| Blob storage | Existing `ports.BlobStore`, `ports/ports.go` | `blobs` filesystem adapter and authenticated transfer routes | `plue/internal/cloudstorage` GCS adapter |
| Repository storage | Existing `repository.Client`, `repository/repository.go`; placement is its existing resolver facet | `repository.OpenLocal` and bundled Git/jj engine | Remote client through `plue/internal/clusterstorage`, generation-fenced router and repo-host |
| Machines and placement | Existing `workspace.WorkspaceRuntime`, `workspace/contracts.go` | `microsandbox.Runtime`, bundled msb/libkrun | Controller-backed runtime extracted from `plue/.../workspaceruntime` to **new** `packages/backend/fleet/workspace` |
| GitHub App ownership | Export existing `GitHubAppCredentialSource` through `ports` | Manifest-created, sealed installation credentials | Platform-owned App credentials supplied by Plue; both use the same token cache, access verification and polling |
| Secret protection | **New** `ports.SecretKeySource`, `ports/secrets.go`, behind the existing shared secret codec | Install key in protected state directory | GCP-managed key access in Plue; same sealed product records and rotation semantics |
| Model access and metering | Existing `modelproxy.Keys` through `ports.PlatformModelKeys`; usage remains shared proxy policy | Owner resolver, owner pays provider | Plue platform-key resolver, platform pays provider; charging uses the admission seam below |
| Model-host execution | Existing `ports.ChatHost` and its `ModelStreamHost` facet | Packaged trusted model host on the install | Isolated packaged model host, with launch transport supplied by the fleet |
| Networking, TLS and origins | **New** `ports.ServingBinding`, `ports/serving.go`: allowed origins, listener and private callback addresses | Settings-backed binding, loopback default, optional owner proxy | Deployment binding, ingress TLS and private service DNS |
| Upgrade and recovery | **New** `ports.MaintenanceDriver`, `ports/maintenance.go`: backup, install artifact, restart; shared coordinator owns freeze and health gates | Homebrew/launchd driver, reusing `HostService.ts` and host-maintenance commands | Plue rollout/backup driver invoking the same coordinator |
| Observability | Existing `app.Config.TraceExporter` and `MetricsCollectors` | Local logs, optional OTLP exporter | Cloud Trace exporter and Prometheus collectors; shared redaction, events and metrics |
| Billing later | Existing `admission.Policy`; `commerce.Service` is its payment-facing companion | No-commerce adapter; physical capacity and owner budgets still enforced | Existing hosted admission/commerce service with `plue/internal/stripecommerce` transport |

Identity adapters select credentials, not authorization rules. Shared code performs GitHub OAuth, binds callbacks to state and origin, issues sessions, checks repository access and enforces Owner/Maintainer/Member roles. Keep the hosted embedded login’s email action honest until an email identity provider actually exists; it cannot silently become GitHub login. Self-hosting never requires a Smithers account.

Likewise, the model adapter supplies who pays; it cannot reinterpret usage. Both paths record tokens, time and actual provider usage, reconcile interrupted requests, enforce configured budgets, and keep provider keys out of branch guests. Move generic isolated model-host launch/probe logic from Plue into `modelhost`; leave only the fleet transport private or behind the extracted fleet API.

Database queries, migrations, approvals, GitHub synchronization, TODO state, scheduling priority, flow versions, wiki documents and UI projections are shared product code. Wiki folder synchronization is an optional filesystem attachment to that same wiki service: the install’s Obsidian folder remains supported, while Cloud provides no fictitious local folder. No new synchronization implementation or hosted wiki is needed.

## 3. Tenancy without another product

Use **team** as the tenancy boundary and **factory** as this document’s internal name for one team’s binding to one GitHub repository. Reuse organization/team and repository records; do not create a parallel tenant ownership graph. A hosted team can own several factories, each with its own stack, conversations, wiki, configuration and branch machines. Self-hosting enforces exactly one binding through provisioning constraints, not through a different domain model.

The proposed trusted context is:

```go
type FactoryScope struct {
    TeamID       int64
    RepositoryID int64
    ActorID      int64
    CredentialID string
    Kind         CredentialKind // session, delegated, run, machine, setup
}
```

Resolve this server-side from the credential and stored resource ancestry. Neither a URL slug, a caller-supplied tenant header nor `workspace.Operation.TenantID` authenticates anyone. Extend the existing runtime operation with repository scope and placement generation; retain separate principal and idempotent operation identifiers. Tenant means team, never whichever member happened to wake the VM.

Keep `/owner/name` as the browser location. A repository-scoped API mount resolves that path to `FactoryScope`; existing install shorthand routes mount the same handlers through the fixed binding. These are two routing adapters, not copied handlers. A tab’s binding is immutable until explicit navigation; cache keys, durable client records and live subscriptions include origin plus repository identity. A hosted repository switcher is post-MVP UI, not a launch prerequisite.

Move product settings currently hidden in singleton `install_settings` keys into repository/team-scoped settings. Leave physical bind addresses, install key and the one-time bootstrap claim installation-wide. Backfill existing data transactionally into the one scope; validate ownership and row counts, switch every reader/writer, then remove obsolete product-setting keys. Do not dual-write or maintain a compatibility database.

Use existing repository foreign keys wherever sufficient. Queries receiving an object ID join back to its scoped repository; mutations also check current membership within the transaction. Add composite uniqueness/foreign keys where a relationship could otherwise cross repositories. Tenant-global data carries team scope explicitly. Worker claims, flow journals, outboxes, token issuance, idempotency keys, blob capabilities and stream cursors carry the same scope. PostgreSQL job leasing serializes work across API/worker replicas; process memory is never its authority.

For machines, enforce one live workspace per `(repository_id, branch_identity)` with a database constraint and generation-fenced admission. Creator `user_id` is attribution, not ownership. Grants in `workspace_shares` provide access to the shared branch. Cached membership and live streams revoke promptly across replicas. Missing/dead credentials and concealed repositories retain the specified refusal behavior, tested with another real team’s IDs.

Only a valid person session can approve or merge, including recording a TODO pre-approval. System execution consumes that exact approval bound to its permitted revision; it never acquires independent agent merge authority. GitHub alone advances `main`, and the shared mirror ingests it.

## 4. Machines

Keep `WorkspaceRuntime`; do not invent a second `MachineRuntime` or SSH execution path. The shared branch service owns creation, joins, captures, sleep/wake, cancellation and product state. Adapters report actual runtime observations and capabilities. `WorkspaceStarting` is not readiness, and a controller acknowledgment is not completion.

The local adapter boots a libkrun microVM on the Mac. The fleet adapter addresses the existing controller, whose workers boot microVMs and retain their disks. Both boot the same versioned `smithers-machined`, coding host, CLI and skill for the guest architecture. Both use daemon sessions, stable member UIDs, private per-machine homes and one live jj working copy. A fork captures the source working copy at a mutation boundary before creating a different branch; it never clones another member’s credentials into the new machine.

Extract reusable controller/client/worker logic from `plue/internal/microsandbox` and `plue/cmd/microsandbox-{controller,worker}` into `packages/backend/fleet`. Keep GKE discovery, node pools, Cloud storage integration, workload identity and rollout policy in Plue behind exported fleet ports. Move generic state schema with the extracted code; migrate existing private tables once, preserving IDs, leases and generations. No copied controller, dependency on private source, or new SSH scheduler remains.

For remote-enabled self-hosting, run the controller beside the backend under the existing supervisor, with its state in the install’s PostgreSQL. Remote workers register using the existing signed heartbeat and mTLS protocol. The local runtime remains the local execution adapter; it shares admission/capacity calculations with the controller-backed adapter. Product admission selects eligible work in people > TODO > background FIFO order; the controller reserves physical worker resources. These are consecutive gates, not competing product queues.

Extend `WorkspaceSpec` with a placement request and persist its resolved result:

```text
requested: {computer: auto | computer_id, resources, image_digest}
resolved:  {workspace_id, computer_id, generation, disk_ref, architecture}
```

Capacity derives from each computer’s measured memory, cores and free disk. Owner overrides only lower it. Fleet quotas may further restrict admission later; they never enlarge physical capacity. Pinning waits for its computer; `auto` chooses available capacity with the specified local tie-break. Existing disks wake where they live. Paused/unreachable computers grant no new capacity, and lost heartbeats do not prove their existing VMs stopped. Retain reservations until fenced stop or explicit recovery.

Safe-idle, capture and retry are identical: flush documents, close bursts, capture and publish the branch head, drain the outbox, then stop while retaining disk and member homes. A failed capture prevents a successful sleep receipt. Reading an asleep branch uses the captured repository snapshot without waking it. Cold resume does not promise surviving processes. Removal follows §8.13’s explicit loss confirmation and recovery from the last captured head, not automatic migration of an uncontactable live writer.

`remoteSandboxes` remains off by default and distinct from the old remote-client flag. It gates adding computers and new remote placement; turning it off does not strand already placed machines. T-RMT implementation stays on hold until the existing spike resolves reachability and security review.

The controller requires worker connectivity, and current heartbeats advertise worker addresses the controller calls. Loopback-only cannot magically support that. Propose explicit private management-network endpoints and mTLS enrollment, verified in both directions before registration; public browser exposure is not required. Repository credentials, model keys, merge authority and product journals remain with the factory host. A scoped relay carries guest API/model/journal traffic without exposing raw database or provider credentials. No SSH reverse-forward workaround becomes another runtime.

## 5. Build, release and test

One release graph starts from one public commit and produces a manifest containing product schema, wire versions, native engine, app assets, packaged flow/model hosts, CLI/skill, machine daemon and per-architecture guest digests. Platform binaries differ; shared JavaScript/assets must have the same digests. The macOS release job assembles the Homebrew bottle with PostgreSQL 18 and the guest OCI archive, retaining offline first boot and hypervisor signing checks.

Plue pins that public release and packages Linux binaries plus its adapters into deployment images. Its manifest adds private source revision, image digests and infrastructure inputs rather than independently rebuilding product hosts or selecting another UI commit. Preserve its immutable images, provenance and deployment gates. This is one product build with two packaging stages, not a requirement for identical Darwin and Linux executables or public access to private release credentials.

Use one parameterized suite against the real composed HTTP boundary, with fixtures supplying origins, database connection and runtime. Product unit suites run once. Run authorization, route/catalog parity, GitHub sync, TODO lifecycle, journal replay, restart, revocation and async UI tests against both compositions. Use real PostgreSQL and adapters; deterministic GitHub/model protocol fixtures are justified for exhaustive retry and failure cases, with real external-service journeys as separate release evidence.

| Layer | Required evidence |
| --- | --- |
| Port contracts | Filesystem/GCS generation-safe blobs; local/remote Git/jj fencing; both runtime adapters’ lifecycle, compare-write, traversal, termination confirmation and resource errors |
| Composition | Same catalog, person-only merge, tenant isolation, duplicate requests, interrupted side effects, split API/worker recovery and revoked streams |
| Mac release | Fresh user, real repository, second laptop; J1–J8/J10/J11, J9 advisory; HTTP LAN and HTTPS, keyboard, both themes, backup/restore and upgrade |
| Hosted release | Same J1–J11 scripts after a hosted bootstrap fixture, two teams and two repositories in one team, real GKE workers, rolling restart and worker loss |
| Deferred remote release | One Mac plus a Linux worker: placement/pinning, flag disable, partition, key mismatch, removal, and no host execution |

Hosted J1 substitutes provisioning and platform App connection for Homebrew and App creation, then uses identical source-ready, machine-ready and first-merge assertions. It does not count as Mac installation evidence. Preserve deliberately unresolved launch tests: chat remains usable, progress persists through execution, duplicates deduplicate and failures remain retryable. Record release SHA, artifact hashes, host profile and check receipts; T-PRC-03’s owner/manual/provenance requirements remain binding.

## 6. What breaks today

These are source findings, not production incident claims.

1. **Topology conflates policy and placement.** `internal/compose/main.go:255` makes `hosted()` equal multitenancy. `composeBranchMachines` explicitly rejects install branch providers for hosted operation. `router.go:963–1047` gates member commands, TODOs, terminals, secrets, flows and branch routes on `IsSingleOwner`. Supplying a Cloud VM adapter cannot enable the same product.
2. **Singleton scope is embedded in authorization.** `internal/identity/member_boundary.go` caches one `GetSelfHostOwner`; `services/workspace_branch_machine_install.go` joins `install_settings`’ single `github.repository`. `compose/secrets.go` substitutes that binding into repository routes. Removing route gates alone would authorize against the wrong factory.
3. **GitHub behavior differs.** `compose/github_sync.go` selects response-header budgets and conditional fetching only for installs, and only installs receive the TODO polling/check/review wiring. App credential selection is another boolean in `main.go`; Plue’s inspected composition does not set the newer `EnvGitHubAppCredentials` option. Re-pinning needs explicit wiring, not an assumed compatible environment.
4. **Cloud placement still identifies the creator as tenant.** `plue/apps/backend/internal/composition/workspaceruntime/runtime.go` looks up and updates `workspaces.vm_id` by `user_id::text = owner`. It also reads product outsider marks and environment-image eligibility directly. Some SQL is explicitly allowed by today’s port contract; this is not proof of an unauthorized backend fork. It is nevertheless product-state coupling that must move into public scoped stores before shared branches work across members.
5. **Runtime policy lives on both sides.** That same adapter builds outsider egress policy and guest activation commands; Plue’s `composition/chat.go` implements model credential-origin validation, environment construction and protocol probes. Transport belongs behind adapters, while those reusable product rules belong in the public backend. `workspaceruntime/runtime.go` also hardcodes `.preview.jjhub.tech`; retain any required legacy route decoding but make new routing deployment data, without restoring the deferred preview UI.
6. **Release identities disagree locally.** Plue’s `go.mod` pins `aab4da61f8b5`, while `composition/release-manifest.json` requires `bf9d328b303c`; its UI names `e0cbb3f7…`. `release.go` rejects a built dependency different from the manifest. This checkout cannot provide valid production release evidence unchanged; it does not establish what is deployed.
7. **Billing is currently a startup dependency.** Plue’s `composition/composition.go` requires Commerce for production API duty and metered admission for both roles. That prevents a production-equivalent noncommercial hosted rehearsal unless admission and payment availability are separated. Physical caps and actual usage must remain active.

The install entrypoints already compose useful boundaries: `apps/backend/main.go` injects repository, owner model keys and branch machines; `isolation.go` constructs the isolated runtime and measured profile. `HostService.ts` verifies bundle bytes and supervises via launchd. Preserve these rather than replacing them with Kubernetes on a Mac. Plue’s shared-backend boundary check already blocks the retired backend trees; strengthen its behavior checks instead of redoing that extraction.

## 7. Ordered work

These are design work packages, not newly filed or claimed issues. Reconcile them with existing tickets before implementation, including #2290, #3467 and #3706/T-RMT. Estimates are focused agent-days per package, excluding external provisioning or owner evidence. Every migration’s acceptance includes deleting its old path.

### Before self-hosted MVP launch

Keep the product’s stage 1 → 2 → 3 sequence; these additions accompany it and do not make Cloud a launch gate.

| Item | Days / dependency | Completion evidence |
| --- | --- | --- |
| A. Inventory topology conditions; separate dependency validation from auth-mode checks without enabling hosted features | 2 / first | Existing install route/security suites plus invalid-composition table |
| B. Introduce trusted factory scope at request/job boundaries; install resolves one binding | 3 / A | Forged scope, cross-repository child and stale credential refusals; J1/J2 |
| C. Make new branch/membership/settings code accept explicit scope; enforce singleton branch uniqueness | 4 / B, stage 2 | Concurrent two-member join creates one machine; creator departure preserves access |
| D. Publish reusable port conformance fixtures from existing tests | 3 / independent | Local blob/repository/runtime contracts, cancellation and stale generation cases |
| E. Emit one public artifact manifest from the existing release graph | 3 / independent | Hash mismatch refused; clean Mac bundle verifies and first VM boots without registry |
| F. Finish Mac release rehearsal and evidence | 3 / C–E, stage 3 | Required journeys, restart, duplicate launch, co-edit, upgrade and restore receipts |

After stage 1 passes J1/J2, implementation work moves onto the self-hosted stack as M-31 requires. F is evidence work, not an estimate to implement all remaining MVP features.

### After MVP, without advancing deferred release dates

| Item | Days / dependency | Completion evidence |
| --- | --- | --- |
| G. Migrate factory-owned settings and owner/member bindings to scoped storage | 4 / B | Existing install restore plus two-team/two-repository migration fixtures; old keys unused |
| H. Mount shared catalog/routes and GitHub pollers for either resolver | 4 / G | Same command matrix, checks/reviews and authorization across compositions |
| I. Move workspace product SQL and outsider/image policy into public stores | 3 / G | Creator-independent join, scoped CAS placement, outsider egress refusal |
| J. Extract fleet protocol/client and controller core; retain private infrastructure ports | 4 / D | Existing controller contract tests run from public package; no private imports |
| K. Extract worker and reusable state migrations; Plue imports public implementations | 4 / J | Signed heartbeat, fencing, snapshot/recovery and schema upgrade tests; old code deleted |
| L. Adapt fleet workspace to machined/shared branch lifecycle | 4 / I,K | Same runtime suite on real KVM, capture failure and revocation |
| M. Unify GitHub credential, model-host and secret-source wiring | 4 / H | Rotation, tenant key separation, callback origin, usage and no guest key exposure |
| N. Unify serving binding and split-process live behavior | 3 / H | Same-origin CSRF/WebSocket checks, arbitrary LAN origin, multi-replica revocation |
| O. Package remote controller/worker enrollment after spike approval | 4 / K,L | Mac/remote connectivity and partition drill; flag-off behavior; security receipt |
| P. Consume public release artifacts; repair Plue pins and upgrade driver | 3 / E,K,M | Exact-source/digest gates, upgrade with active work and recoverable failure |
| Q. Separate payment availability from admission; keep commerce deferred | 3 / H | Production-equivalent startup without Stripe, physical caps and actual usage intact |
| R. Hosted rehearsal of shared journeys | 4 / H,L–N,P,Q | J1–J11 records on staging; two-team leakage probes and worker-loss recovery |
| S. Enable hosted commerce when authorized | 3 / R | Paid-path duplicate charging, spend caps, webhook replay and interrupted settlement |

G/I and J/K can proceed independently; M/N/Q can proceed together after H. O remains blocked by the actual T-RMT hold, not merely by this dependency list. Extracted fleet packages must be independently buildable without GCP or private configuration. Split any package whose measured scope exceeds four days at a port boundary, never by leaving two implementations active.

## 8. Risks and cheap falsifiers

- **Scope migration is larger than estimated.** Search every singleton setting and owner lookup, then trace one TODO and one terminal through two repositories. A single implicit global lookup falsifies readiness for H; expand G before exposing hosted routes.
- **The Cloud guest cannot meet the daemon contract.** Boot the exact candidate daemon on one existing worker, join as two members, capture, stop and wake. Failure to retain files, UID separation or fencing blocks convergence without requiring a cluster-wide trial.
- **Remote networking contradicts install defaults.** Reproduce on a loopback-only Mac and one NATed worker. If bidirectional control and scoped guest relays cannot be established with explicit private endpoints, keep remote disabled and return the reachability decision to the spec owner; do not revive SSH execution.
- **A partition creates two writers.** Disconnect one worker while issuing wake/retry on another. Any second writable branch before the first is fenced invalidates recovery design.
- **One release manifest still permits mixed product behavior.** Deliberately substitute an old UI or coding host into a candidate. Both packages must reject the mismatch before serving users.
- **Hosted repository ownership remains ambiguous.** Try binding the same GitHub repository to two teams. Proposed rule: one active controlling factory per GitHub repository within a deployment; a transfer freezes writes and preserves identity. Resolve this before hosted provisioning, including how operators detect an independently running self-hosted factory.
- **Shared working copies weaken personal login isolation.** From member A’s terminal, attempt to read B’s home and invoke B’s delegated token, then revoke B while a stream is open. Any success blocks release, regardless of storage encryption.
- **“Small adapters” becomes a false promise.** Count product decisions and SQL in the extracted Cloud runtime after I–M. Remaining role checks, TODO transitions or GitHub behavior in Plue falsify the seam; placement fencing, storage protocols and GKE operations legitimately remain substantial infrastructure.
