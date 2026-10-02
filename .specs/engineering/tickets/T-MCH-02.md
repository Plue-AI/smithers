# T-MCH-02 Spike: virtiofs `/home` keeps guest uids and 0700

Stage W0 · Size S · Depends on — · Unblocks T-MCH-11 · Issue: [#3437](https://github.com/smithersai/smithers/issues/3437)
Spec: spec.md §5.5.4, §8.7, §21 · Delta: delta.md §3 (per-member users row) · Product: mvp.md J6.1, J6.5, §6.8 Terminals, M-18

## Result (2026-10-02)

Done. C-SPK-02 is NO: layout A keeps guest `chown` but its `0:0 700` mount root blocks traversal (a `0711` root is untested), and layout B passes ownership but two awake VMs writing one home lost data (`.artifacts/checks/C-SPK-02/20261002T212556Z/REPORT.md`). Product re-ruled homes as per machine with a credential store (mvp.md §6.8; spec §8.7.1, §8.7.3; T-MCH-11, T-MCH-15).

## Goal

By the end of day 3, a recorded yes or no: a host directory mounted into `msb` 0.6.16 microVMs keeps per-directory guest ownership and mode 0700 across a reboot and across two VMs, so one member's home follows them from branch to branch.

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

## Changes

- `scripts/spikes/mch-02-virtiofs-homes/run.sh` (new): boots two VMs with the pinned `msb`, runs the layout A and B matrices with `setpriv --reuid --regid --clear-groups`, and writes `results.json`. Disposable. Its findings go to the issue and the C-SPK-02 evidence.
- No product code changes.

## Tests

- spike: for each layout, 2 uids × {stat after chown, stat after reboot, stat in VM 2, cross-read as the other uid, cross-read as 19999}. This is C-SPK-02.
- spike: 100 write-then-read round trips across the two VMs. Record the p95 delay until VM 2 sees the new content.

## Acceptance

- [C-SPK-02](../checks/C-SPK-02.md): at least one layout keeps uid, gid and 0700 per member home across reboot and across two VMs, and cross-reads fail with `EACCES`.

## Risks and notes

- Layout A fails. libkrun's virtiofs passthrough runs as the macOS user, so a guest `chown` fails with `EPERM` or the new owner doesn't persist. Confirmed if `stat` after reboot shows the mount's default owner. The `uid=,gid=` mount options point that way, since they set one presented owner per mount.
- Layout B passes but needs one mount per member at VM boot. A member added while a machine is awake has no home until that machine's next boot. Confirmed by adding a third mount without restarting. Escalate to the tech lead: either layout B with "home appears after the branch's next wake" (a spec change), or the per-machine fallback.
- Fallback (spec §8.7.1): homes become per-machine directories on the root disk. Tool logins then persist per branch, and mvp.md J6.1 changes for the person. The product agent must be told before T-MCH-11 starts.
- Two VMs writing one home at once (Ben on two branches) can corrupt tool state such as a SQLite login cache. Confirmed if a Claude Code or Codex login written in VM 1 and refreshed in VM 2 within 10 s is lost. Record it and don't fix it here.
