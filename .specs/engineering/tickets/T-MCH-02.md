# T-MCH-02 Spike: virtiofs `/home` across two VMs (answered NO: homes are per machine)

Stage W0 · Size S · Depends on — · Unblocks — · Issue: [#3437](https://github.com/smithersai/smithers/issues/3437)
Spec: spec.md §5.5.4, §8.7, §21 · Delta: delta.md §3 (per-member users row) · Product: mvp.md J6.1, J6.5, §6.8 Terminals, M-18
Ready: 2026-10-03 smithers-8a sha256:4893ba410226

## Result (2026-10-02)

Done. C-SPK-02 is NO: layout A keeps guest `chown` but its `0:0 700` mount root blocks traversal (a `0711` root is untested), and layout B passes ownership but two awake VMs writing one home lost data (`.artifacts/checks/C-SPK-02/20261002T212556Z/REPORT.md`). Product re-ruled homes as per machine with local tool logins (mvp.md §6.8; spec §8.7.1, §8.7.3; T-MCH-11, C-MCH-10).

## Goal

Record the C-SPK-02 NO result and the accepted per-machine-home decision. The matrix below is the historical experiment, not a shared-home implementation request.

## Scope

The layout matrix is retained history. Remaining work reshapes the existing evidence harness, not member provisioning or a production home implementation. Land dark: decision completion refuses missing or malformed retained evidence and cannot enable shared homes. There are no first-merge or unlabeled ticket dependencies; the existing pinned runtime is the W0 precondition. C-SPK-02 proves the refusal.

In:
- Layout A (spec §8.7.1): one shared mount of `$STATE/homes/` at `/home`, with host directories named by login (`$STATE/homes/<login>/`), so guest paths are `/home/<login>` (§5.5.4). In the guest, root runs `chown 20001:20001 /home/ben` and `chown 20002:20002 /home/alice`, then `chmod 0700` on both.
- Layout B (msb-native, a candidate only; the spec names layout A): one `--mount-dir $STATE/homes/<login>:/home/<login>:uid=<uid>,gid=<uid>` per member. `msb create --help` documents `uid=<N>,gid=<N>` as presenting host files "as that guest owner".
- For each layout: ownership and mode after write, after VM restart, and in a second VM mounting the same host directory at the same time. A cross-read as the other member and as `agent` (19999). Host-side mode and owner of the files under `$STATE/homes`.
- Write coherence between two concurrent VMs: Ben writes in VM 1 and reads the file in VM 2 within 1 s.
- Retain the accepted fallback: per-machine homes on the root disk, with tool logins local to that machine (§8.7.3). No new product decision is requested.

Out:
- Creating member users, the `team` group and the image changes (T-MCH-11).
- Tool-login behavior inside homes (C-MCH-06, C-J6-01).
- Shared homes in production, repair of cross-machine coherence, and the deferred credential store (product §16).
- A new runtime, provisioning service, public API, image recipe or toolchain; production credentials; host-root execution and LaunchAgent/plist loading (T-INS-03).

## Changes

- Reshape existing `scripts/spikes/mch-02-virtiofs-homes/run.sh`, reusing `verdict.py`, `concurrent.py`, `concurrent-worker.cjs`, `test-verdict.py` and `test-concurrent.py`. The existing harness boots two VMs with pinned `msb`, runs the layout A and B matrices with `setpriv --reuid --regid --clear-groups`, and writes `results.json`. Retain that evidence path; do not build a second harness. Any rerun follows the root-input restrictions below.
- No product code changes. Add a decision-completion mode to `scripts/spikes/mch-02-virtiofs-homes/run.sh` that validates the retained real-machine evidence and accepted NO without changing the shared-home hypothesis verdict. smithers-3f reviews its fail-closed completeness checks; smithers-8a accepts the decision receipt. C-SPK-02 uses that mode for this completed decision (§21.4).

## Tests

- spike: for each layout, 2 uids × {stat after chown, stat after reboot, stat in VM 2, cross-read as the other uid, cross-read as 19999}. This is C-SPK-02.
- spike: 100 write-then-read round trips across the two VMs. Record the p95 delay until VM 2 sees the new content.
- C-SPK-02, extend existing `test-verdict.py` through the real `run.sh --decision-evidence <dir>` command: `test_decision_evidence_retains_no` accepts complete retained evidence and emits `hypothesis: NO`; `test_decision_evidence_refuses_incomplete` rejects absent, malformed or truncated matrix/concurrent logs and a forged cached verdict. Fixed fixtures and independently enumerated expected outcomes supply the oracle. The mode reads evidence as data and never boots a machine, executes evidence content or closes the issue.
- C-SPK-02, `test_rerun_root_inputs_and_guest_identity`, through the real rerun command and real `msb create`/`exec`: reject a branch harness, image, executable, script or toolchain before root dispatch; reject a scratch mount outside the owned temporary directory or through a symlink. Record guest effective uid/gid and cleared groups for each probe (20001, 20002 or 19999), and assert host uid is nonzero. Test changed branch root payloads for refusal, never for successful root execution. A validated branch script is still forbidden by README hard rule 1.

## Acceptance

- [C-SPK-02](../checks/C-SPK-02.md): retain the recorded NO and raw ownership, traversal and concurrent-write evidence. A negative spike result completes this decision ticket; it does not satisfy the rejected shared-home hypothesis.

## Risks and notes

- Layout A preserved ownership across reboot and the second VM; its root:root 0700 parent prevented traversal. Layout B passed the ownership matrix but failed concurrent mutable-state safety. Retain controlled lock classification separately from uncontrolled probes. Decision completion validates retained evidence and never converts the rejected hypothesis into PASS.
- Accepted fallback (§8.7.1): homes are per-machine directories on the root disk; tool logins persist locally across sleep and wake, with no token copying (C-MCH-10). smithers-8a records the technical decision; Will decides any change to the product ruling. T-MCH-11 starts from this result, not a shared-home layout.
- Two VMs writing one home at once (Ben on two branches) can corrupt tool state such as a SQLite login cache. Confirmed if a Claude Code or Codex login written in VM 1 and refreshed in VM 2 within 10 s is lost. Record it and don't fix it here.

## Security preconditions

smithers-3f reviews this boundary. Decision completion uses the approved non-root check runner on the reference host (§21.4a); retained JSON and logs are data, never executable input. Branch probe code runs only inside disposable machines as the fixed unprivileged uid. Member and agent sudo remain forbidden. No host-root step or plist load is in scope; README hard rule 2 applies only to T-INS-03.

For an optional rerun, inventory every guest-root input before dispatch: (1) `msb`/libkrun and the digest-pinned DefaultImage, including shell, node, useradd, mkdir, chown, chmod, stat, cat, sync, setpriv and their libraries/configuration, come from reviewed main-pinned or installed-bundle bytes; (2) setup command strings, MATRIX/stat/version diagnostics, uid/gid/login constants, layout/phase selectors, fixed paths, modes, mount flags and any root wrapper come from the main-pinned harness, never a branch build; (3) machine names, scratch mount sources and environment are generated by that harness from the non-root reference-host identity and owned temporary directory, with fixed guest PATH and no branch environment, working copy or production-state mount; (4) guest filesystem metadata, `/proc/mounts` and synthetic file state come from the pinned image and those disposable machines, seeded by main-pinned fixtures and unprivileged probes. Root never interprets synthetic file contents as code. Record resolved binary/image/harness identities and root command arguments in C-SPK-02 evidence. No branch-sourced input is permitted in these root steps. Run the matrix coordinator and data probes unprivileged; keep root dispatch limited to main-pinned setup and metadata operations. `test_rerun_root_inputs_and_guest_identity` checks this at the real machine lifecycle boundary. Until the reviewed main-pinned harness satisfies it, refuse reruns; retained decision validation remains available.

## Ready checklist

1. Dependencies: no ticket edge is missing for this W0 decision. The existing pinned `msb` 0.6.16, digest-pinned DefaultImage and two disposable machines are rerun preconditions; complete retained C-SPK-02 evidence is the decision-mode precondition. Scope lands dark and fails closed without it; no later-stage dependency or index change is needed.
2. Exclusions: production shared homes, coherence repair, member-user provisioning, tool-login behavior, credential-store implementation, new runtime/API/image/toolchain work, production credentials and host-root/plist operations are explicit.
3. Boundary tests: C-SPK-02 uses real `run.sh --decision-evidence` command tests for retained NO and incomplete evidence, and real `msb create`/`exec` for reruns and root-input/uid checks. Fixtures, uid/gid, 0700 and cross-read expectations are fixed independently of spec files and runtime implementation values. Uncontrolled lock probes remain uncontrolled.
4. Decisions: smithers-8a accepts evidence completeness and the technical fallback; smithers-3f approves the harness/security seam; Will alone changes product behavior. An untested 0711 root or uncontrolled lock probe cannot reverse the recorded NO.
5. Owner pre-review: smithers-3f. Does the pinned image exercise both layouts without production-state mounts? Does the evidence distinguish traversal failure from ownership failure and controlled results from uncontrolled probes? Do root steps consume only the inventoried main-pinned/bundle inputs, with branch probes unprivileged and real-command refusal/identity evidence? Recorded answer stands: smithers-3f: answered, BLOCKING edits applied (tech lead adopts). Review the added root inventory post hoc under Will's parallel-build directive.
6. Security: smithers-3f reviews the explicit root-input inventory and C-SPK-02 `test_rerun_root_inputs_and_guest_identity`. Branch code runs only in machines without sudo; root executes only main-pinned/bundle bytes, never branch artifacts. Approved host evidence validation runs non-root with publication credentials absent (§21.4a). Synthetic credentials and owned scratch mounts exclude production secrets/homes; unavailable trusted inputs refuse reruns.
