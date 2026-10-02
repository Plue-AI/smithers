# T-INS-09 Bundle references for the built-bundle host lifecycle

Stage S1 · Size S · Depends on T-INS-01 · Unblocks — · Issue: to file
Spec: spec.md §1.2, §16.1.0, §16.1.1 · Delta: delta.md §1 (Restore→rewrite row) · Product: mvp.md J1.1, §6.1 Install on a Mac, §11 stage 1 item 1, §12.5, M-10

## Goal

Align the bundle contract and ticket references with T-INS-08 after the frozen assembler lands.

## Scope

In:
- The layout `apps/app/src/bun/NativeBackendProcess.ts:300-345` resolves (`bin/`, `libexec/git-core`, `share/git-core/templates`, `postgres/`, `bin/flow-hosts.json`, `bin/linux-arm64/`), under one prefix that `smthrs host start --bundle` runs from the build output (T-INS-08) and T-INS-05 installs as a keg `libexec`.
- Formula, entitlement signing, launchd and the `smthrs host` lifecycle group (T-INS-03, T-INS-05, T-INS-07, T-INS-08).

Out:
- The landed scope of T-INS-01, except the follow-up changes stated here.

## Changes

- Apply these header and lifecycle references after T-INS-01 lands:

Stage S1 · Size M · Depends on — · Unblocks T-INS-02, T-INS-08, T-INS-05 · Issue: [#3432](https://github.com/smithersai/smithers/issues/3432)

- `smthrs host` is the install lifecycle group (`start`, `stop`, `status`, `upgrade`, `backup`, `restore`; T-INS-08, T-INS-07). The launchd daemon runs this bundle's `bin/smithers-server`, so one launcher implementation exists.

## Tests

- unit `apps/app/scripts/build-server-bundle.test.ts`: refuses a missing or short `SMITHERS_BUILD_SHA`, a PostgreSQL major other than 18, Node outside 26.4+, an `msb` other than 0.6.16, and a binary linking a non-system dylib (`system-linkage.ts`).
- unit: a bundle file with no manifest entry, or a hash mismatch, fails the manifest check.
- integration `apps/app/scripts/server-bundle.integration.test.ts` (new): fresh clone, one build command, launcher started from the output with an empty state dir; `/readyz` within 30 s; every spawned executable and loaded dylib lives under the bundle prefix or the OS; `smithers-backend microvm doctor` is ready with the bundled `msb`; the first machine boots with the network to the image registry blocked.

## Acceptance

- [C-INS-05](../checks/C-INS-05.md): the bundle runs from clean build output with no hand-assembled files.

## Risks and notes

- The assembler lane builds its landed layout. Coordinate these reference changes with T-INS-08.
