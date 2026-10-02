# ADR 0002: Mac install, multiple members, microVM execution, any origin

Status: proposed (2026-10-02). Supersedes [ADR 0001](0001-shared-product.md) for the Mac install's deployment, membership and execution model.
This record becomes accepted when Will approves the MVP engineering spec.

## Context

The MVP serves one team and one GitHub repository from one Apple Silicon Mac. Members share branches with the coding agent. Repository flows and agents process untrusted issue text. ADR 0001's single-owner `trusted_process` model cannot protect host secrets or members' personal logins.

This record captures `.specs/engineering/overview.md` decisions E-01, E-02, E-03, E-09, E-10, E-13 and E-17, and the corresponding requirements in `.specs/engineering/spec.md`. The [product decisions](../../.specs/product/mvp.md#7-decisions) include M-10, M-17, M-28, M-29 and M-30. The [implementation ledger](self-host-implementation.md) tracks the work and required proof.

## Decision

### Install a Homebrew package supervised by launchd

A Homebrew tap installs the host service, PostgreSQL 18, packaged Flow runtimes, web assets and the microVM runtime with its pinned guest base image. A launchd daemon runs as the installing macOS user and starts before login. The host launcher supervises the backend and PostgreSQL. Durable data lives in `~/Library/Application Support/Smithers`.

The browser is the product surface. The install has no Electrobun app or Docker container. T-INS-05 ships the chosen launchd path and deletes the Docker self-host image, which cannot host the required microVMs on macOS. A notarized `.pkg` would require an Apple Developer identity and delay launch. T-INS-03 must confirm Hypervisor.framework works from the daemon; the specified fallback is a launchd agent with macOS automatic login.

Sources: E-01; engineering spec §1.1, §1.2 and §16.1; product M-10 and §6.1.

### Run repository code only inside microVMs

Repository code runs only inside machines: overridable TODO, learning, review and repository flows, coding agents, checks, terminals, SSH sessions and services. Repository flows run in the branch's coding host or an ephemeral background machine. The Mac host runs only code shipped in the install package and never loads repository flows into its process. The install refuses to start without working microVM isolation and never falls back to host processes.

This boundary keeps agents steered by untrusted text away from host secrets. ADR 0001's `trusted_process` executor cannot provide it. Stack operations, merge, members and settings remain system flows that the repository cannot override.

Sources: E-02; engineering spec §1.3 and §17; product M-29 and M-30.

### Share one machine per branch

Each awake branch has one machine shared by members and the coding agent. Branch locks are removed. Per-person or per-agent copies of a branch would leave multiple working copies of the same branch.

The install has a roster with Owner, Maintainer and Member roles. Access requires a place on the roster and live GitHub write access, checked at sign-in and hourly. Losing write access suspends the member. This replaces issue 1667's single-owner model. M-17 restores shared workspace access and presence, while the rest of Pair stays removed.

Each member has a stable Unix uid and a private home persisted across machines. Members and agents have no `sudo`. A shared Unix login would share personal tool credentials; elevated privileges would defeat their separation.

Sources: E-03 and E-10; engineering spec §5.1, §5.5 and §8.1; product M-05, M-17, M-18 and M-29.

### Reserve approval and merge for browser sessions

Only a signed-in person's browser `session` credential can approve or merge, subject to that person's role. Agents acting for members receive `delegated` credentials with `via` attribution. This includes `smthrs login`, branch terminal sign-in and the app agent. They can request a person confirmation bound to the exact revision. The coding agent's `run` credential and a machine's credential cannot approve or merge.

The CLI cannot tell whether an agent holds its token. A person PAT with a client-supplied agent flag would trust the client to enforce the boundary.

Sources: E-09; engineering spec §5.2, §5.3 and §5.4; product M-05 and M-21.

### Serve on owner-configured origins

The install is origin-agnostic. HTTP and SSH always listen on loopback, on ports 4000 and 2222 respectively. The owner can add a bind address and public origins in Settings or with `smthrs host start --bind <addr> --origin <url>`. Origins can use HTTP or HTTPS and any host name. PostgreSQL stays on loopback. Origin checks and GitHub App callbacks use the configured origins plus localhost.

First startup prints a one-time setup URL for each listener. A request must carry that setup token and complete GitHub sign-in to claim the install. Only the token's digest is stored, and a successful claim deletes it. The owner can finish setup from the Mac or a laptop using a configured listener.

The app works on plain HTTP without secure-context-only browser APIs. Clipboard operations have a fallback. The install creates no certificate authority. The team supplies HTTPS and remote access through whatever it puts in front, such as Tailscale serve or a reverse proxy. No code depends on either. Plain HTTP sends session cookies unencrypted; the quickstart recommends HTTPS in front.

Tailscale-only serving would tie the product to one vendor. An install certificate authority with `smthrs connect` would require certificate setup for every teammate. Neither is part of the install.

Sources: E-13; engineering spec §1.4, §5.1.0, §16.3 and §17.5a; product M-28.

### Derive limits from the detected host

Capacity, machine memory, vCPUs and the layer budget derive from the host profile detected at startup: memory, performance cores, free disk, macOS version and Hypervisor.framework availability. Reserve capacity for macOS and the install before allocating machines. Fixed defaults per Mac model cannot account for the team's available resources.

Sources: E-17; engineering spec §8.2.1; product M-06.

## Consequences

- The Mac install replaces the container, native WebView and single-owner process assemblies. Release checks must prove the Homebrew and launchd path with microVM isolation.
- Shared machines require separate member identities and personal logins. Host authorization must enforce credential kinds and roles for every action.
- Plain HTTP and configured origins must work throughout setup, sign-in and live connections. HTTPS remains the team's exposure choice.
- Capacity checks must record the detected host profile rather than assume a Mac model.
- Acceptance of this record does not certify a working install. The implementation ledger retains the required proof.

## What stays in ADR 0001

ADR 0001 continues to govern the shared backend, ownership and import rules, and Plue's assembly. Plue composes the public backend and supplies private deployment adapters. PostgreSQL remains the authority for server-side product records, with one schema and migration sequence. `@smthrs/flow` remains the sole Flow model.
