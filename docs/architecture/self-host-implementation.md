# Shared backend implementation ledger

Owner brief: 2026-09-21. Epic: https://github.com/smithersai/smithers/issues/1655.

This is an active implementation, not a completion claim. It supersedes the epic's original KVM-only local deployment and root `server/*` layout.

## Required deployment boundary

- Public Smithers owns the common Go product backend under `packages/backend`, app binaries under `apps/backend`, the canonical TypeScript Flow runtime, and the existing UI.
- Self-hosting is one application Docker container plus PostgreSQL and persistent storage. It has exactly one owner. Code execution shares the instance's operating-system trust boundary; this is not hostile-tenant isolation. No Kubernetes, KVM, Docker socket, private service, or Smithers account is required.
- Private Plue imports the common public backend and adds multitenant enterprise deployment, isolated execution, placement, and managed infrastructure. Shared permissions, job receipts, repository rules, and execution contracts must not fork.
- Native own-backend mode supervises the same backend and a bundled native PostgreSQL process. Remote-backend mode must not start a redundant database/backend. Local browser development supports either backend.
- Product state, durable admission, and replay semantics are shared. Presentation-specific OS gestures stay native. User code executes in the local process adapter for the single-owner edition and through isolated Plue execution for cloud. A single-owner installation on a Mac or KVM host may instead require local microVM isolation (`SMITHERS_WORKSPACE_ISOLATION=microvm`, `packages/backend/microsandbox`, #2100): it then refuses to start without Microsandbox and never falls back to host processes.

## Mode acceptance matrix

| ID | Presentation | Product backend | Database | Execution | Required proof |
| --- | --- | --- | --- | --- | --- |
| web-selfhost | Browser | Public Docker app | External PostgreSQL | Single-owner process | Clean image + persistent volume; complete product loop |
| web-plue | Browser | Plue shared-library composition | Managed PostgreSQL | Isolated cloud | Same product contract and authorization suite |
| local-own | Local browser | Supervised public backend | Local PostgreSQL | Single-owner process, or local microVM | Same product loop and shutdown/restart; microVM refusal, cancellation, crash recovery |
| local-plue | Local browser | Plue | Remote only | Isolated cloud | No local DB/backend authority; same product loop |
| native-own | Packaged native WebView | Supervised public backend | Bundled native PostgreSQL | Single-owner process | Packaged app, first boot, restart, upgrade refusal |
| native-plue | Packaged native WebView | Plue | Remote only | Isolated cloud | Packaged app, auth handoff, shared product loop |

The shared product loop includes real repository creation/import, chat/tool invocation, workspace/terminal, durable job admission, approval, artifact/log observation, review/landing, reload, cancellation, and recovery. Parameterize the harness by origin/auth/execution capability; do not duplicate scenarios by mode. Deterministic protocol tests, real local infrastructure tests, live provider smoke, and production receipts establish different facts and must be reported separately.

Security tests for the shared app must retain Plue cross-tenant authorization. Local single-owner deployment is not an excuse to remove checks from shared services. No false sandbox claim or unsupported success status is permitted.

## Owners and sequence

One dedicated Sol owner per issue, scheduled in dependency waves due to bounded available worker slots. Astra may resolve critical architectural questions. Fable reviews run independently and feed later corrections; implementation does not wait for a review response. Root owns integration, the final cross-mode review, and acceptance evidence. Other agents' existing work must not be reset, committed, or overwritten.

| Step | Issue | Work |
| --- | --- | --- |
| 01 | smithers#1656 | Public composition and deployment contracts |
| 02 | smithers#1657 | Existing Go product and database extraction |
| 03 | smithers#1658 | Shared repository and jj engine |
| 04 | smithers#1659 | Filesystem blob storage |
| 05 | smithers#1660 | Shared identity and single-owner bootstrap |
| 06 | smithers#1661 | Durable jobs and event receipts |
| 07 | smithers#1662 | Canonical Flow execution bridge |
| 08 | smithers#1663 | Locally hosted chat/model routing |
| 09 | smithers#1664 | Optional integrations and billing composition |
| 10 | smithers#1665 | Single-owner process execution adapter |
| 11 | smithers#1666 | Shared frontend/CLI/backend selection |
| 12 | smithers#1667 | Docker and native distribution, DB lifecycle, backup |
| 13 | plue#508 | Shared-library Kubernetes composition |
| 14 | plue#509 | Cluster storage adapters |
| 15 | plue#510 | Isolated cluster execution adapter |
| 16 | smithers#1668 | Shared mode matrix and release gates |
| 17 | plue#511 | Verified cutover and duplicate ownership cleanup |

## Integration gates

1. Extract real behavior; a parallel reduced API or scaffold is not completion.
2. Build the container and run a real PostgreSQL-backed app before claiming local usability.
3. Exercise both shared app compositions and then native/web presentations.
4. Preserve acknowledged work across restart; uncertain external effects must not be silently repeated.
5. Prove Plue conformance before deleting its old authority; no unreviewed destructive production reset.
6. Native PostgreSQL packaging is build-time and version-pinned. Startup never silently downloads binaries, deletes an incompatible data directory, or rewrites a database owned by another process.
7. Land scoped changes on main; final evidence reports actual tested revisions, unresolved failures, and deployment state.
