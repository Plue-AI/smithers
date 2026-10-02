# ADR 0001: One Smithers product, several assemblies

Status: accepted for the pre-release cutover (2026-09-21). Superseded for the Mac install by [ADR 0002](0002-mac-install.md). Implements the ownership decision in [issue 1655](https://github.com/smithersai/smithers/issues/1655). The source inventory below describes the starting point; it is not a claim that extraction is complete.

## Decision

Smithers owns one Go product backend, one web application, one product HTTP contract, and the existing TypeScript Flow engine. The root Go module is `github.com/smithersai/smithers`. Go libraries live under `packages/*`; application entrypoints live under `apps/*`, just like TypeScript packages and apps. `packages/backend/app` is the small public composition API and `packages/backend/internal` owns handlers, product services, persistence, and background jobs. `apps/backend` is the ordinary executable. `packages/backend/ports` contains only deployment-dependent repository, blob, and execution/access contracts demonstrated by the implementations. Plue may import public Smithers packages and supply adapters and configuration; Smithers must never import Plue.

**Superseded for the Mac install by [ADR 0002](0002-mac-install.md).** The supported self-hosted web topology is **one ordinary Smithers app container plus PostgreSQL** for one owner. The app serves the web assets and API, uses a persistent `/var/lib/smithers` volume for repository and blob bytes, and bundles the trusted TypeScript Flow host. The local executor runs bounded child processes for code trusted by that owner. Its advertised isolation level is `trusted_process`. It is not an untrusted-code boundary. The hosted Plue assembly uses the same product services, schema, routes, and Flow artifacts, with cluster storage and an isolated sandbox executor. An untrusted-code guarantee is advertised only when that executor actually provides it. The self-hosted bootstrap has one owner, no public signup or organization onboarding, and no claim of multitenant isolation; Plue retains the shared authorization core for secure multitenant deployment.

**Superseded for the Mac install by [ADR 0002](0002-mac-install.md).** The native app can start its own local Smithers backend and PostgreSQL, or point at a remote Plue or self-hosted Smithers backend. Its local database is a bundled real PostgreSQL instance in Application Support, with a singleton process, persisted credential, local-only listener, readiness before migrations, and safe restart. Remote native mode starts neither local service. The web app similarly points at Plue or a self-hosted Smithers origin. The frontend's modes are configuration of the same backend contract; modes do not get independent business rules or flow graphs.

PostgreSQL owns all server-side product records, admitted jobs, receipts, and event cursors in every edition. There is one schema and migration sequence. Runtime-local SQLite may store one executor's Flow journal; device-local storage may hold drafts and presentation state. Neither substitutes for product PostgreSQL. This costs one database service in a self-hosted deployment, but prevents a second product transaction, migration, queue, and recovery implementation.

`@smthrs/flow` remains the sole Flow model. Go admits and observes work and the packaged TypeScript host executes it through the explicit protocol in [issue 1662](https://github.com/smithersai/smithers/issues/1662). No Go graph, alternate node model, or backend-specific Flow interpreter is permitted.

The product is pre-release, so this is a deliberate breaking cutover. Existing Cloudflare identity, chat, billing, API forwarding, URLs, and Plue product handlers are extraction sources, not permanent compatibility requirements. Preserve product data and necessary security invariants; retire duplicate authorities after parity is proven.

## Ownership and import rules

| Concern | Smithers owns | Plue owns |
| --- | --- | --- |
| Product HTTP API, auth, permissions, repositories, jobs, chat, billing, integrations, notifications, UI and CLI | Services, handlers, schema, DTOs, generated clients, tests | Configures and imports the public app API; no copied handlers or product policy |
| Repository and blob bytes | Product semantics, local storage, integrity and recovery | Cluster placement, volumes/object-store adapter, movement and infrastructure backup |
| Execution | Job admission, durable receipts, Flow runtime, trusted local executor, capability contract | Isolated executor, fleet capacity and placement, node operations |
| Deployment | One-container release, asset bundle, migrations, local lifecycle | Kubernetes entrypoints, ingress, IAM, observability wiring and infrastructure state |

Only `packages/backend/app` and `packages/backend/ports` are supported Go imports for deployment consumers. `packages/backend/internal` is hidden by Go's `internal` rule. Plue must depend on a pinned Smithers version without a sibling checkout `replace` or source copy. The default `apps/backend` import graph must not include Kubernetes or GCP deployment SDKs. Cluster adapters belong in Plue. A dependency check enforces the Smithers side; the Plue side is also checked in the cross-repository parity gate.

Keep deployment seams narrow. Repository storage/execution is a product operation with a local store or cluster routing adapter. Blob operations use immutable keys, streams, integrity metadata, and idempotent deletion; signed cloud URLs are an optional adapter behavior, not the product contract. An executor reports its actual isolation, supports bounded execution and cancellation, and grants access to running workspaces without leaking provider SDK objects into product code. PostgreSQL connections and job admission are common implementation, not interchangeable deployment ports. Do not abstract every table, route, or graph node.

## Data authority

| Data | Authority | Recovery rule |
| --- | --- | --- |
| Users, sessions, permissions, product records, conversations, admitted commands, jobs, receipts, event cursors | Smithers PostgreSQL | Migrate and back up one product schema; replay durable server facts |
| Flow state, approvals, execution journal | Canonical TypeScript Control runtime | Restore the executor-owned journal and reconcile its terminal receipt with Go |
| Revisions, worktrees, immutable blobs | Repository/blob store | Reconcile recorded intent and expected revisions with PostgreSQL; no pretend cross-store transaction |
| Drafts, pending local intent, presentation projections | Device-local client journal | Recover server facts from API; export local-only drafts separately |
| Placement, fleet leases, infrastructure operations | Plue infrastructure | May reference product IDs; cannot redefine permissions or completion |

A command can return `requested` immediately after its client-side intent is persisted. The API says `accepted` only after durable PostgreSQL admission; execution completion needs a terminal receipt. Duplicate input is idempotent, in-flight work is recoverable after reload, and a transport acknowledgment is never success. The [app interaction rules](../../AGENTS.md) apply in every mode.

## Product extraction inventory

| Area and starting source | Smithers destination | Owning issue |
| --- | --- | --- |
| Plue `internal/services`, `internal/routes`, `db/schema.sql`, `cmd/server` | `packages/backend/internal`, product schema, public app composition | [1657](https://github.com/smithersai/smithers/issues/1657) |
| Plue `internal/repohost`, Git/SSH, `smithers-ffi`, repository jobs | Shared repo engine and local/cluster storage port | [1658](https://github.com/smithersai/smithers/issues/1658) |
| Plue blob/GCS paths and snapshots | Filesystem blob adapter, immutable storage contract | [1659](https://github.com/smithersai/smithers/issues/1659) |
| Plue auth, sessions, permissions, API tokens, SSH credentials; `smithersai/ui/workers/identity` | Common identity and credential services | [1660](https://github.com/smithersai/smithers/issues/1660) |
| Plue durable jobs/outbox and Smithers client notification state | Admission, receipts, authorized event replay | [1661](https://github.com/smithersai/smithers/issues/1661) |
| `packages/smithers/flows`, Control and workspace host | One Flow authority, Go-to-host protocol | [1662](https://github.com/smithersai/smithers/issues/1662) |
| `smithersai/ui/workers/chat`, Plue conversation APIs, app turn host, push | Common chat/model routing, durable turns and push dispatch | [1663](https://github.com/smithersai/smithers/issues/1663) |
| `smithersai/ui/workers/billing`, Plue billing/integrations, GitHub/Notion sync, email/push notifications | Optional common provider modules | [1664](https://github.com/smithersai/smithers/issues/1664) |
| Plue microsandbox worker and local harness; workspace terminal/access | Bounded trusted-process executor, explicit isolation capability | [1665](https://github.com/smithersai/smithers/issues/1665) |
| `apps/app`, `apps/server` Worker gateway, Bun local server, `packages/rpc`, Plue CLI | One web/native API, generated clients, common product CLI | [1666](https://github.com/smithersai/smithers/issues/1666) |
| Static assets, Bun host, native helpers, Go binary, migrations, `/data` lifecycle | One-container release and native bundle | [1667](https://github.com/smithersai/smithers/issues/1667) |
| Plue Kubernetes composition and deployment | Public Smithers API composition, cluster adapters | [plue 508–510](https://github.com/smithersai/plue/issues/508) |
| Mode parity, clean-room install, Plue cutover | Matrix gate then removal of duplicate product authorities | [1668](https://github.com/smithersai/smithers/issues/1668), [plue 511](https://github.com/smithersai/plue/issues/511) |

The CLI, SSH, runtime assets, chat, push, billing, and identity are all product surfaces. None can remain a required external Smithers-controlled service for self-hosting. GitHub, model providers, payment providers, email and push transports remain optional configured integrations; missing credentials must disable that feature honestly rather than route silently to Smithers infrastructure.

## External seams and licenses

The current web gateway declares identity, billing, chat and Plue API upstreams in `apps/server/wrangler.jsonc` and documents their deployed identities in `apps/UPSTREAMS.md`. Identity, chat and billing source lives in the separate `smithersai/ui/workers` tree; that inventory also names connectors-catalog, cron, status, sync and webhooks. Audit and move any product behavior before calling self-hosting independent. The existing repo includes `THIRD_PARTY_NOTICES.md`, and Plue's checked-in source is MIT licensed. The `smithersai/ui` worker tree is not present in this workspace; its license and transitive notices must be verified from source before copying code or publishing a distribution. Preserve notices for vendored Effect and jj code and produce dependency notices for the bundled Go, Bun and native artifacts.

## Mode gate

One test suite runs against a backend URL with the same contract assertions. Required rows: Docker self-hosted app + PostgreSQL, native app + local backend/PostgreSQL, native app + Plue, web app + Plue, and web app + self-hosted backend. The isolated execution tests are required only when the backend advertises `isolated`; trusted local process tests must prove bounded concurrency, cancellation and persistence without claiming isolation. The matrix covers auth, repository creation/import, chat, jobs and receipts, Flow approval/restart, artifacts, terminal and reload. `apps/backend` and Plue composition must run common Go service tests; the browser/native clients must run the same contract tests against both origins.
