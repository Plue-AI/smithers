# T-MCH-02 Spike: virtiofs `/home` across two VMs (answered NO: homes are per machine)

Stage W0 · Size S · Depends on — · Unblocks T-MCH-11 · Issue: [#3437](https://github.com/smithersai/smithers/issues/3437)
Spec: spec.md §5.5.4, §8.7, §21 · Delta: delta.md §3 (per-member users row) · Product: mvp.md J6.1, J6.5, §6.8 Terminals, M-18

## Result (2026-10-02)

Done. C-SPK-02 is NO: layout A keeps guest `chown` but its `0:0 700` mount root blocks traversal (a `0711` root is untested), and layout B passes ownership but two awake VMs writing one home lost data (`.artifacts/checks/C-SPK-02/20261002T212556Z/REPORT.md`). Product re-ruled homes as per machine with local tool logins (mvp.md §6.8; spec §8.7.1, §8.7.3; T-MCH-11, C-MCH-10).

## Goal

Record the C-SPK-02 NO result and the accepted per-machine-home decision. The matrix below is the historical experiment, not a shared-home implementation request.

## Scope

In:
- Layout A (spec §8.7.1): one shared mount of `$STATE/homes/` at `/home`, with host directories named by login (`$STATE/homes/<login>/`), so guest paths are `/home/<login>` (§5.5.4). In the guest, root runs `chown 20001:20001 /home/ben` and `chown 20002:20002 /home/alice`, then `chmod 0700` on both.
- Layout B (msb-native, a candidate only; the spec names layout A): one `--mount-dir $STATE/homes/<login>:/home/<login>:uid=<uid>,gid=<uid>` per member. `msb create --help` documents `uid=<N>,gid=<N>` as presenting host files "as that guest owner".
- For each layout: ownership and mode after write, after VM restart, and in a second VM mounting the same host directory at the same time. A cross-read as the other member and as `agent` (19999). Host-side mode and owner of the files under `$STATE/homes`.
- Write coherence between two concurrent VMs: Ben writes in VM 1 and reads the file in VM 2 within 1 s.
- If neither layout passes: record the fallback, per-machine homes on the root disk, and draft the product note (logins persist per branch, not per member).

Out:
- Creating member users, the `team` group and the image changes (T-MCH-11).
- Tool-login behavior inside homes (C-MCH-06, C-J6-01).
- Shared homes in production, repair of cross-machine coherence, and the deferred credential store (product §16).

## Changes

- `scripts/spikes/mch-02-virtiofs-homes/run.sh` (new): boots two VMs with the pinned `msb`, runs the layout A and B matrices with `setpriv --reuid --regid --clear-groups`, and writes `results.json`. Disposable. Its findings go to the issue and the C-SPK-02 evidence.
- No product code changes. Add a decision-completion mode to `scripts/spikes/mch-02-virtiofs-homes/run.sh` that validates the retained real-machine evidence and accepted NO without changing the shared-home hypothesis verdict. smithers-3f reviews its fail-closed completeness checks; smithers-8a accepts the decision receipt. C-SPK-02 uses that mode for this completed decision (§21.4).

## Tests

- spike: for each layout, 2 uids × {stat after chown, stat after reboot, stat in VM 2, cross-read as the other uid, cross-read as 19999}. This is C-SPK-02.
- spike: 100 write-then-read round trips across the two VMs. Record the p95 delay until VM 2 sees the new content.

## Acceptance

- [C-SPK-02](../checks/C-SPK-02.md): retain the recorded NO and raw ownership, traversal and concurrent-write evidence. A negative spike result completes this decision ticket; it does not satisfy the rejected shared-home hypothesis.

## Risks and notes

- Layout A fails. libkrun's virtiofs passthrough runs as the macOS user, so a guest `chown` fails with `EPERM` or the new owner doesn't persist. Confirmed if `stat` after reboot shows the mount's default owner. The `uid=,gid=` mount options point that way, since they set one presented owner per mount.
- Layout B passes but needs one mount per member at VM boot. A member added while a machine is awake has no home until that machine's next boot. Confirmed by adding a third mount without restarting. Escalate to the tech lead: either layout B with "home appears after the branch's next wake" (a spec change), or the per-machine fallback.
- Accepted fallback (§8.7.1): homes are per-machine directories on the root disk; tool logins persist locally across sleep and wake, with no token copying (C-MCH-10). smithers-8a records the technical decision; Will decides any change to the product ruling. T-MCH-11 starts from this result, not a shared-home layout.
- Two VMs writing one home at once (Ben on two branches) can corrupt tool state such as a SQLite login cache. Confirmed if a Claude Code or Codex login written in VM 1 and refreshed in VM 2 within 10 s is lost. Record it and don't fix it here.

## Ready checklist

1. Dependencies: W0 uses the existing pinned `msb` 0.6.16, `DefaultImage`, and two disposable machines; no later-stage ticket is needed to record this completed experiment.
2. Exclusions: production shared homes, coherence repair, member-user provisioning, tool-login behavior and credential-store implementation are explicitly excluded.
3. Boundary tests: C-SPK-02 runs `scripts/spikes/mch-02-virtiofs-homes/run.sh` through real `msb create` and guest commands. Fixture bytes, uid/gid, 0700 and cross-read outcomes are fixed in the harness; expectations never come from spec files or implementation values at runtime. Retain the NO evidence and record uncontrolled lock probes as uncontrolled.
4. Decisions: smithers-8a accepts the evidence and technical fallback; Will alone changes product behavior. Neither an untested 0711 root nor an uncontrolled lock probe reverses the recorded decision.
5. Owner pre-review: smithers-3f before any rerun. Does the pinned image exercise both layouts without production-state mounts? Does the evidence distinguish traversal failure from ownership failure and controlled results from uncontrolled probes?
6. Security: smithers-3f reviews the harness before any rerun. Repository code and probe payloads execute only inside disposable machines; host commands only provision, measure and collect evidence. Use synthetic credentials, no production homes or install secrets, and no member or agent sudo. C-SPK-02 checks cross-user isolation.
