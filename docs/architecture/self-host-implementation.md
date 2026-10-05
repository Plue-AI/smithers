# Shared backend implementation ledger

Owner brief: 2026-09-21. Epic: https://github.com/smithersai/smithers/issues/1655.

This ledger tracks implementation and required proof, not completion. [ADR 0002](0002-mac-install.md) supersedes the single-owner container and native-app topology for the Mac install. [ADR 0001](0001-shared-product.md) still governs the shared backend and Plue composition.

## Required deployment boundary

- Public Smithers owns the common Go product backend under `packages/backend`, app binaries under `apps/backend`, the canonical TypeScript Flow runtime, and the existing UI.
- The Mac install serves one team and one repository. Homebrew installs the host service, bundled PostgreSQL and microVM runtime. S1 uses a per-user LaunchAgent under `gui/<uid>` as the logged-in installing user, with no privilege escalation (§16.1.2). T-INS-02 owns the launcher, T-INS-08 the LaunchAgent, and T-INS-03 measured release evidence only; before-login daemon support is unproven. A roster plus live GitHub write access controls membership ([ADR 0002](0002-mac-install.md), M-17).
- Private Plue imports the common public backend and adds multitenant enterprise deployment, isolated execution, placement, and managed infrastructure. Shared permissions, job receipts, repository rules, and execution contracts must not fork.
- Repository code runs only in microVMs, with one shared machine per awake branch and no branch locks. The host runs packaged code only. Startup refuses missing microVM isolation and never falls back to `trusted_process`. Members and agents have no `sudo` ([ADR 0002](0002-mac-install.md), M-17, M-29, M-30).
- The browser connects to any owner-configured HTTP or HTTPS origin. HTTP and SSH always bind loopback and can also bind the address set by the owner; PostgreSQL stays on loopback. The install has no secure-context dependency, Tailscale requirement or certificate authority. A one-time setup token plus GitHub sign-in claims the install ([ADR 0002](0002-mac-install.md), M-28).
- Only a person's browser session can approve or merge, subject to role. Delegated agent credentials request person confirmations. Product state, durable admission and replay semantics remain shared with Plue ([ADR 0002](0002-mac-install.md), E-09).
- The container topology is superseded for the Mac install. T-INS-05 removes Docker as an install path; T-INS-05b retains the preview-only image; this ledger does not claim that deletion is complete.

## Mode acceptance matrix

| ID | Presentation | Product backend | Database | Execution | Required proof |
| --- | --- | --- | --- | --- | --- |
| mac-install | Browser | Public backend supervised by launchd | Bundled PostgreSQL, loopback | Shared branch microVM, multiple members | Homebrew install; token claim; roster; plain HTTP and configured origins; isolation refusal; restart and recovery; upgrade refusal; cancellation ([ADR 0002](0002-mac-install.md)) |
| web-plue | Browser | Plue shared-library composition | Managed PostgreSQL | Isolated cloud | Same product contract and authorization suite |

The shared product loop includes repository setup, conversation/tool invocation, branch/terminal, durable admission, approval, artifact/log observation, review/merge, reload, cancellation and recovery. Parameterize the harness by origin/auth/execution capability; do not duplicate scenarios by mode. Deterministic protocol tests, real local infrastructure tests, live provider smoke and production receipts establish different facts and must be reported separately.

Security tests for the shared app must retain Plue cross-tenant authorization and enforce the Mac install's roster, roles and credential kinds. Host-profile detection sets every Mac limit ([ADR 0002](0002-mac-install.md), E-17). No false sandbox claim or unsupported success status is permitted.

## Owners and sequence

One dedicated Sol owner per issue, scheduled in dependency waves due to bounded available worker slots. Astra may resolve critical architectural questions. Fable reviews run independently and feed later corrections; implementation does not wait for a review response. Root owns integration, the final cross-mode review, and acceptance evidence. Other agents' existing work must not be reset, committed, or overwritten.

| Step | Issue | Work |
| --- | --- | --- |
| 01 | smithers#1656 | Public composition and deployment contracts |
| 02 | smithers#1657 | Existing Go product and database extraction |
| 03 | smithers#1658 | Shared repository and jj engine |
| 04 | smithers#1659 | Filesystem blob storage |
| 05 | smithers#1660 | Shared identity; Mac multi-member bootstrap follows [ADR 0002](0002-mac-install.md) |
| 06 | smithers#1661 | Durable jobs and event receipts |
| 07 | smithers#1662 | Canonical Flow execution bridge |
| 08 | smithers#1663 | Locally hosted chat/model routing |
| 09 | smithers#1664 | Optional integrations and billing composition |
| 10 | smithers#1665 | Execution contract; Mac microVM-only execution follows [ADR 0002](0002-mac-install.md) |
| 11 | smithers#1666 | Shared frontend/CLI/backend selection |
| 12 | smithers#1667 | Mac Homebrew and launchd distribution, DB lifecycle and backup follow [ADR 0002](0002-mac-install.md); T-INS-05 removes the Docker install path; T-INS-05b retains the preview image |
| 13 | plue#508 | Shared-library Kubernetes composition |
| 14 | plue#509 | Cluster storage adapters |
| 15 | plue#510 | Isolated cluster execution adapter |
| 16 | smithers#1668 | Shared mode matrix and release gates |
| 17 | plue#511 | Verified cutover and duplicate ownership cleanup |

## Integration gates

1. Extract real behavior; a parallel reduced API or scaffold is not completion.
2. Install the Homebrew package and run the launchd-supervised host with real PostgreSQL and microVMs before claiming Mac usability.
3. Exercise the Mac install and Plue browser compositions against their shared contract and each assembly's authorization boundary.
4. Preserve acknowledged work across restart; uncertain external effects must not be silently repeated.
5. Prove Plue conformance before deleting its old authority; no unreviewed destructive production reset.
6. Bundled PostgreSQL packaging is build-time and version-pinned. Startup never silently downloads binaries, deletes an incompatible data directory, or rewrites a database owned by another process.
7. Land scoped changes on main; final evidence reports actual tested revisions, unresolved failures, and deployment state.

## Sleeping branch snapshots

Sleep remains disabled until authenticated final capture, object verification,
outbox drain, branch runtime binding and live state publication are available.
Snapshot reads never wake a machine. Work-triggered wake requires admission and
validated privileged entry; billing quota alone does not authorize it.

A captured working copy includes untracked files that are not ignored. Every
member can read those files from the host snapshot, including an unignored
`.env`. Snapshot reads use install-shipped store code and never execute captured
files or hooks. The branch head is `refs/smithers/branches/<id>/head`; immutable
source retention stays in its existing workspace namespace.
