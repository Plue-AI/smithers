# C-SPK-02 virtiofs `/home` keeps guest uid, gid and 0700 across two uids

Proves: mvp.md M-18, J6.1, J6.5 · spec.md §5.5.4, §8.7.1, §8.7.2 · Layer: spike · Stage: W0 · Tickets: T-MCH-02
Automation: `scripts/spikes/mch-02-virtiofs-homes/run.sh` (new) · Runs in: reference host

## Result (2026-10-02)

NO. Layout A: owner access fails. Layout B: ownership and isolation pass, but the step 6 interleaved writes lost data (183 of 2,000 shared reads ENOENT; 2,739 missing append records; SQLite errors and lost WAL rows). The spec drops shared homes (§8.7.1).

## Setup

- The reference host, `msb` 0.6.16, two VMs (VM 1, VM 2) booted from `DefaultImage`, both awake for the whole run.
- Host directory `$SPIKE/homes/` with mode 0700, owned by the macOS user running `msb`, with `ben/` and `alice/` inside.
- In both guests: users `ben` (20001) and `alice` (20002), and `agent` (19999).
- Layout B (spec §8.7.1), on both VMs: `--mount-dir $SPIKE/homes/ben:/home/ben:uid=20001,gid=20001` and the same for alice. Layout A (one `--mount-dir $SPIKE/homes:/home` plus `chown` in the guest) runs as the rejected control.

## Steps

1. Record `msb create --help` and the exact `msb create` lines, including every `--mount-dir` flag.
2. VM 1: `stat` both homes. As `ben`, write `/home/ben/.config/tool/login.json`. As `alice` and as `agent`, `cat` it.
3. Restart VM 1. Repeat the `stat` and the cross-reads.
4. VM 2: `stat` both homes. As `ben`, read the file; as `alice` and `agent`, read it.
5. Ben writes a new value in VM 1, then VM 2 reads it. Repeat 100 times and record the delay until VM 2 sees the new content.
6. Interleaved writes, both VMs at once as `ben`: each VM writes 1,000 files `~/.spike/vm<k>-<i>` (temp file, then `rename`, the way tools save) and rewrites `~/.spike/shared.json` 1,000 times the same way, alternating with the other VM at 10 ms intervals.
7. With VM 1 running, try to add a third mount (`/home/carol`) without a restart. Record the result.
8. On the host: `stat` the files under `$SPIKE/homes`.
9. Repeat steps 2–5 for layout A.

## Pass when

For layout B:
- `stat` shows `/home/ben` as `20001:20001 0700` and `/home/alice` as `20002:20002 0700` in VM 1 after restart and in VM 2.
- `alice` and `agent` reading Ben's file get `EACCES` in both VMs. `ben` reads it.
- 100 of 100 cross-VM reads see the new content, with p95 delay ≤ 1 s.
- Step 6: all 2,000 files exist in both VMs and on the host with their exact content, and every read of `shared.json` during and after the run parses (no torn file). The final `shared.json` is one of the two VMs' last writes.
- Host files under `$SPIKE/homes` are not readable by another macOS user.
- Step 7 is recorded either way. If `msb` can't add a mount to a running VM, the report says that a member added while a machine is awake needs a machine-local home until the next wake.

## Fail when

- Mode 0700 reads back as 0755 or similar after restart, or the presented owner differs from the mount's `uid`.
- A cross-read as `alice` or `agent` succeeds in either VM.
- A file from step 6 is missing, has the other VM's content, or `shared.json` is ever torn.
- The report records a pass for layout B without the exact `--mount-dir` flag, the mount-per-member-at-boot requirement and the step 7 result.

## Evidence

`.artifacts/checks/C-SPK-02/<UTC timestamp>/`: `results.json` (per layout, per step: command, exit code, `stat` output), the cross-VM delay CSV, the step 6 file manifest with SHA-256 per file and the `shared.json` read log, host-side `ls -ln`, the `msb` version, `msb create --help`, the exact `msb create` lines and the commit.
