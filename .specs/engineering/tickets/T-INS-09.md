# T-INS-09 Bundle references for the built-bundle host lifecycle

Stage S1 · Size S · Depends on T-INS-01, T-INS-08 · Unblocks T-REL-02 · Issue: [#3524](https://github.com/smithersai/smithers/issues/3524)
Spec: spec.md §1.2, §16.1.0, §16.1.1 · Delta: delta.md §1 (Restore→rewrite row) · Product: mvp.md J1.1, §6.1 Install on a Mac, §11 stage 1 item 1, §12.5, M-10

## Goal

Align the bundle contract and ticket references with T-INS-08 after the frozen assembler lands.

## Scope

In:
- The layout `apps/app/src/bun/NativeBackendProcess.ts:300-345` resolves (`bin/`, `libexec/git-core`, `share/git-core/templates`, `postgres/`, `bin/flow-hosts.json`, `bin/linux-arm64/`), under one prefix that `smthrs host start --bundle` runs from the build output (T-INS-08) and T-INS-05 installs as a keg `libexec`.
- Documentation references to entitlement signing, launchd and the `smthrs host` lifecycle group: S1 start/stop/status belong to T-INS-08; the R tap/formula and upgrade/backup/restore belong to T-INS-05/T-INS-07. This ticket changes references, not those implementations.

Out:
- Any edit to frozen T-INS-01, assembler redesign, launcher or launchd implementation, entitlement changes, release formula/bottles, upgrade/backup/restore implementation, Docker deletion and new toolchain/language detection.

## Changes

- `apps/app/scripts/README.md` and the host CLI reference under `packages/smithers/docs/reference/cli/` must name T-INS-08’s real built-bundle start/stop/status behavior. Do not rewrite T-INS-01’s header or scope. Document only implemented S1 commands; the pre-install site page may label the R lifecycle commands planned until release (§16.1.2, M-35).

- `smthrs host` is the install lifecycle group (`start`, `stop`, `status`, `upgrade`, `backup`, `restore`; T-INS-08, T-INS-07). The launchd daemon runs this bundle's `bin/smithers-server`, so one launcher implementation exists.

## Tests

- unit `apps/app/scripts/build-server-bundle.test.ts`: refuses a missing or short `SMITHERS_BUILD_SHA`, a PostgreSQL major other than 18, Node outside 26.4+, an `msb` other than 0.6.16, and a binary linking a non-system dylib (`apps/app/scripts/system-linkage.ts`).
- unit: a bundle file with no manifest entry, or a hash mismatch, fails the manifest check.
- integration `apps/app/scripts/server-bundle.integration.test.ts` (new, C-INS-05): fresh clone, one build command, real `bin/smithers-server` started from the output with an empty state dir; `/readyz` within 30 s; every spawned executable and loaded dylib lives under the bundle prefix or the OS; `smithers-backend microvm doctor` is ready with the bundled `msb`; the first machine boots with the network to the image registry blocked.
- lifecycle integration `packages/smithers/test/host-service.integration.test.ts` (T-INS-08, C-INS-06): run the documented `smthrs host start --bundle <output>`, `status` and `stop` through `makeCli` and real launchd. A changed or unlisted bundle file refuses before plist changes. Expected paths, manifest coverage, version constraints, readiness limits and refusal outcomes are committed literal fixtures; no expectation reads spec Markdown or the production resolver/manifest validator at runtime.

## Acceptance

- [C-INS-05](../checks/C-INS-05.md): the bundle runs from clean build output with no hand-assembled files.
- [C-INS-06](../checks/C-INS-06.md): the documented S1 host commands consume that bundle through the production CLI and launchd.

## Risks and notes
- Decisions before start: smithers-b8 approves documentation and host-command references; smithers-3f approves bundle layout and confinement evidence; smithers-38 approves the CLI-library contract. smithers-8a accepts the bundle-to-service seam and any conflict with frozen assembler scope. Will decides install/release policy exceptions.
- Security precondition: T-INS-08 must consume T-INS-02’s isolated launcher and T-INS-03’s accepted service mode. Bundle/host commands execute packaged code only; registry-blocked machine probes and repository commands run inside the guest (§1.3, M-29), never on the Mac. smithers-3f reviews C-INS-05/C-INS-06 evidence and confirms no host fallback.

- The assembler lane builds its landed layout. Coordinate these reference changes with T-INS-08.

## Ready checklist
1. Dependencies: T-INS-01 supplies the frozen bundle contract and T-INS-08 the real host CLI/service, including isolated launcher and signing decision transitively. R formula and upgrade implementation are excluded.
2. Exclusions: frozen assembler edits, assembler/launcher/service redesign, signing changes, R distribution/lifecycle implementation, Docker deletion and new detection are explicit.
3. Tests: C-INS-05 executes the real bundle build/launcher; C-INS-06 executes the documented production CLI and launchd. Literal fixtures define paths, versions, limits and refusals; no runtime spec or code oracle.
4. Decisions: smithers-b8 approves docs/public commands, smithers-3f bundle/security, smithers-38 CLI library, smithers-8a shared/frozen-scope seams; Will decides policy exceptions.
5. Owner pre-review before start: smithers-b8: Do documented S1 commands work from clean build output? Are R commands documented only where planned labels are allowed? smithers-3f: Does the layout match the launcher and contain all required binaries? Do probes run in machines with no host fallback? smithers-38: Does documentation use the registered CLI contract?
6. Security: T-INS-08/T-INS-02 isolation and accepted launchd mode are preconditions; §1.3/M-29 confines repository execution to machines. smithers-3f reviews C-INS-05/C-INS-06 process and confinement evidence.
