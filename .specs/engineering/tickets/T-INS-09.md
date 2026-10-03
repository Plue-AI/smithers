# T-INS-09 Bundle references for the built-bundle host lifecycle

Stage S1 · Size S · Depends on T-INS-01, T-INS-08 · Unblocks T-REL-02 · Issue: [#3524](https://github.com/smithersai/smithers/issues/3524)
Spec: spec.md §1.2, §16.1.0, §16.1.1 · Delta: delta.md §1 (Restore→rewrite row) · Product: mvp.md J1.1, §6.1 Install on a Mac, §11 stage 1 item 1, §12.5, M-10

## Goal

Align the bundle contract and ticket references with T-INS-08 after the frozen assembler lands.

## Scope

In:
- Document the complete bundle prefix: `bin/smithers-server`, `bin/smithers-backend`, packaged git/jj and Bun, `libexec/git-core`, `share/git-core/templates`, `postgres/`, `bin/flow-hosts.json`, `bin/linux-arm64/`, `bin/msb`, `lib/libkrunfw.5.dylib`, `share/microsandbox/smithers-guest.py`, `share/microsandbox/base-image.oci.tar`, `share/microsandbox/base-image.json`, `views/mainview/`, `licenses/` and `manifest.json`. T-INS-08 consumes this build output with `smthrs host start --bundle`; T-INS-05 installs it as keg `libexec`. Document that T-INS-02 sets `SMITHERS_MICROSANDBOX_BIN=<bundle>/bin/msb` and drops inherited PATH directories. Checks: documentation gates, C-CAT-01.
- Documentation references to entitlement signing, launchd and the `smthrs host` lifecycle group: S1 start/stop/status belong to T-INS-08; the R tap/formula and upgrade/backup/restore belong to T-INS-05/T-INS-07. This ticket changes references, not those implementations.

Out:
- Any edit to frozen T-INS-01, assembler redesign, launcher or launchd implementation, entitlement changes, release formula/bottles, upgrade/backup/restore implementation, Docker deletion and new toolchain/language detection.

## Changes

- `apps/app/scripts/README.md` and the host CLI reference under `packages/smithers/docs/reference/cli/` must name T-INS-08’s real built-bundle start/stop/status behavior. Do not rewrite T-INS-01’s header or scope. Document only implemented S1 commands; the pre-install site page may label the R lifecycle commands planned until release (§16.1.2, M-35). Generate the CLI reference from the exported `definitions` in `packages/smithers/src/internal/backend/Definitions.ts` after T-INS-08 registers the host group. Never generate the reference from T-INS-08’s ticket prose. Checks: documentation gates, C-CAT-01.

- The S1 CLI reference and `apps/app/scripts/README.md` list only `smthrs host start|stop|status`, registered by T-INS-08 through makeCli. Document `upgrade|backup|restore` only on the smithers.sh pre-install page, explicitly labeled planned until release (M-35, T-INS-07). The launchd service runs this bundle’s `bin/smithers-server`. Checks: documentation gates, C-CAT-01.

## Tests
- After T-INS-08 registers the host group, generate the reference from the real `definitions` registry and assert host start/stop/status are registered and documented. A missing registry entry fails the gate even if ticket prose lists it. Checks: documentation gates, C-CAT-01.


- Run `smthrs lint //apps/site:cliData` and `smthrs test //apps/site:docsLint` as the CLI-reference and site documentation gates. Add literal contract assertions to the documentation tests for `apps/app/scripts/README.md`, the host CLI reference and the smithers.sh install page. Assert literal S1 command lists containing only start/stop/status in the first two; assert planned labels for upgrade/backup/restore on the install page. Compare the documented full layout with T-INS-01’s landed manifest, including msb, libkrunfw, the three microsandbox share files, views, licenses and manifest. Refuse missing or incorrect paths and command-stage labels. Checks: documentation gates.
- Run T-CAT-01’s C-CAT-01 CLI allowlist test with the documented S1 host commands. It builds the real command registry and rejects absent or cut commands. Documented commands use the registered CLI contract. Check: C-CAT-01.

## Acceptance

- Documentation gates pass for the scripts README, CLI reference, install-page stage labels and full bundle layout.
- [C-CAT-01](../checks/C-CAT-01.md): documented S1 host commands pass the registered CLI allowlist.
- C-INS-05 and C-INS-06 remain runtime evidence owned by T-INS-01 and T-INS-08; this documentation ticket does not rerun or claim their implementation tests.

## Risks and notes
- smithers-b8’s documentation/public-command edits and smithers-3f’s bundle/security edits are adopted by the tech lead. smithers-38 confirms the CLI-library contract; smithers-8a accepts the bundle-to-service seam and any conflict with frozen assembler scope. Will decides install/release policy exceptions. Checks: documentation gates, C-CAT-01.
- Security precondition: T-INS-08 must consume T-INS-02’s isolated launcher and T-INS-03’s accepted service mode. Bundle/host commands execute packaged code only; registry-blocked machine probes and repository commands run inside the guest (§1.3, M-29), never on the Mac. smithers-3f reviews C-INS-05/C-INS-06 evidence and confirms no host fallback.

- The assembler lane builds its landed layout. Coordinate these reference changes with T-INS-08.

## Ready checklist
1. Dependencies: T-INS-01 supplies the frozen bundle contract and T-INS-08 the real host CLI/service, including isolated launcher and signing decision transitively. R formula and upgrade implementation are excluded.
2. Exclusions: frozen assembler edits, assembler/launcher/service redesign, signing changes, R distribution/lifecycle implementation, Docker deletion and new detection are explicit.
3. Tests: documentation gates validate command-stage labels and the full manifest layout; C-CAT-01 validates the registered CLI allowlist. Runtime bundle/service acceptance remains with T-INS-01 and T-INS-08.
4. Decisions: smithers-b8 approves docs/public commands, smithers-3f bundle/security, smithers-38 CLI library, smithers-8a shared/frozen-scope seams; Will decides policy exceptions.
5. Owner pre-review: smithers-b8: answered, BLOCKING edits applied (tech lead adopts). smithers-3f: answered, BLOCKING edits applied (tech lead adopts). smithers-38 must confirm the registered CLI-library contract before start. smithers-38: answered, BLOCKING edits applied (tech lead adopts).
6. Security: T-INS-08/T-INS-02 isolation and accepted launchd mode are preconditions; §1.3/M-29 confines repository execution to machines. smithers-3f reviews C-INS-05/C-INS-06 process and confinement evidence.
