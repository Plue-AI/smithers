# Design brief: one product, self-hosted and hosted, with minimal code

You are one of four independent designers (Codex Sol, Codex Astra, Claude Fable, Claude Opus). A fifth agent will merge the four designs. Design independently.

## Decision we need

Smithers must work **self-hosted** (one install on one Apple Silicon Mac for one team and one GitHub repository; the MVP contract) and in **our hosted version** (Smithers Cloud), and we want to maintain both with the least code: one product, one backend, differences confined to small deployment adapters. Say how, and list the work needed to get there from today's code.

## Ground rules already decided (do not relitigate; design within them)

- The product backend is `packages/backend` only. The hosted deployment (the private `plue` repository, `~/plue` on this machine) composes that backend and adds private deployment ports. Never add product code to plue. (AGENTS.md, "Zero tech debt; one backend".)
- No tech debt: one implementation per behavior; finish migrations; delete the old path.
- Self-hosted MVP first: Smithers Cloud, billing and plans come after the MVP (mvp.md M-09), but the MVP must not paint hosted into a corner.
- Remote machines reuse the Cloud fleet's controller and worker rather than a new SSH runtime; sandboxes must be placeable on the current machine and on remote boxes, feature-flagged (`remoteSandboxes`, spec §8.13, T-RMT tickets on hold).
- Everything is a flow; repository code runs only in machines (E-02); only people merge.

## Read first

- `AGENTS.md` (root and scoped ones for apps/app, packages/backend), `.specs/product/overview.md`, `.specs/product/mvp.md` (§1 user, §2 rules, §6.1 install and machine, §6.2 access, §6.3 GitHub sync, §8 cuts, §12 release, §16 deferred).
- `.specs/engineering/overview.md` (E-01 Homebrew/launchd, E-02, E-08 GitHub App, E-13 origin-agnostic serving, E-17 host-derived limits), `.specs/engineering/spec.md` §1 deployment topology, §5 identity, §8.13 placement and remote machines, §16 install and packaging.
- Code: `packages/backend/internal/compose/main.go` (the `topology` struct and `hosted()`; how install vs hosted composition differs), `packages/backend/internal/compose/*` (providers composed per topology), `apps/backend/` (installed/isolation entry points), `apps/app` (the one product app), `packages/smithers/src/internal/backend/HostService.ts` (launchd host service).
- Hosted: `~/plue` (read only): how it composes the backend, its controller/worker fleet on GKE, jjhub workspaces (per-branch microsandbox VMs), its docs and AGENTS.md.

## What to produce

One Markdown design (about 2,000–4,000 words):

1. **Summary** in five sentences.
2. **The seam**: exactly which behaviors differ between self-hosted and hosted (identity and sign-in, tenancy, database, blob and repository storage, machines/compute placement, GitHub App ownership, secrets, model access and metering, networking/TLS/origins, upgrades, observability, billing later) and the single port/adapter for each. Everything else is shared product code. Name the interface, where it lives, and the two adapters.
3. **Tenancy model**: self-hosted is one team and one repository; how hosted maps many teams/repositories onto the same product code without forking behavior (tenant scoping in queries, routing, isolation).
4. **Machines**: one runtime interface with local microVM (libkrun on the Mac) and Cloud worker adapters; how per-branch machines, sleep/wake, capacity and the shared working copy behave identically in both.
5. **Build, release and test**: one build producing both artifacts; the test matrix that keeps both working with little duplication (which tests run against both compositions, contract tests per port, a hosted rehearsal of the same journeys J1–J11).
6. **What breaks today**: concrete places in today's code where hosted and self-hosted already diverge or duplicate behavior, or where product code leaked into plue, with paths.
7. **Work needed**: an ordered, parallelizable list of work items (each about 1–4 agent-days) to reach the design, separating what must happen before the self-hosted MVP launch from what can follow, with the tests that prove each.
8. **Risks and open questions**, each with a cheap way to falsify it.

Be concrete: name files, interfaces and data shapes. Plain language; no padding.
