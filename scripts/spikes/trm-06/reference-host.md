# C-SPK-08 reference-host handoff

Status: **not run**. Linux lane tests are synthetic/unprivileged and authorize
nothing. This procedure does not bypass the refusing launcher. Root and host
prototype bytes must first be installed from main by the reviewed authority
provider; T-SEC-01 R1–R3 receipts and both named prototype subchecks need
smithers-3f acceptance. Do not substitute a branch binary or an `accepted` file.

Retain all evidence, including a NO result, under
`.artifacts/checks/C-SPK-08/<UTC>/`. Record installed commit/artifact identities,
independently computed digests, image/runtime version, machine/host profile,
OpenSSH and VS Code versions. Use a fresh DefaultImage with nil environments,
no dependency/toolchain/artifact layer and no guest sshd. Verify the installed
SFTP server and Landlock ABI >=3 before admission. Ben is 20001/20001 with
supplementary group 20000; agent is 19999/19999 with group 20000; umask is 002.

## Root validation before admission

Enter through the actual installed launcher/init and authenticated SSH/relay,
not the Rust constructors or a direct supervisor socket. Preserve each refusal,
positive-control receipt, canary execution log and outside sentinel's bytes,
owner and mode. Receipts must bind the installed SHA; no manual marker is proof.

| Subcheck | Required cases |
| --- | --- |
| root-prototype-install-validation | Missing/unaccepted R1–R3 receipts; branch supervisor/gateway/scripts; poisoned PATH/HOME/import paths; replaced artifact/destination parents; symlink/raced parents; forged source/digest; layer/coding-artifact requests; main-pinned installed positive launch and init restart. Every negative must precede root/host canary execution and preserve outside sentinels. |
| root-session-input-validation | Root/other-user selection; forged boot credentials; oversized/truncated/duplicate/unknown envelopes; cgroup traversal and raced symlinks; invalid TCP targets/ports, signals and credit; sentinel writes outside workspace/home and other member homes. Observe real/saved/effective UID/GID and supplementary groups before member argv, cwd, SFTP bytes or repository content is used. Valid PTY/exec/SFTP/TCP, attach, close, revoke and restart controls must traverse the real listener/relay. |

Include Landlock failure and fixed-device replacement fixtures. Unsupported
Landlock must refuse; a positive UID drop alone is not filesystem confinement.
The fixed device exceptions need reviewer acceptance. The SFTP executable must
be installed base/bundle bytes; a member-supplied server path must refuse.

## Nine steps

Set the second Mac's SSH config to the actual installed gateway using Ben's key;
use `ssh ben@<gateway>` below with its real port/key configuration. Do not expose
or start a branch listener. Record `-vvv` transcripts as well as screen capture.

1. Run `ssh ben@<gateway> 'exit 7'`; capture literal exit 7. Run
   `ssh -vvv ben@<gateway> 'kill -TERM $$'`; require exit-signal TERM.
2. Create a local 1,048,576-byte fixture with bytes cycling 0..255. Record its
   independent SHA-256. Feed it to guest `wc -c` (expect 1048576), then guest
   `cat` (expect identical bytes/digest). Keep source and received artifacts.
3. Run guest `head -c 1073741824 /dev/zero` with the local consumer stalled for
   ten seconds. Independently sample supervisor RSS every 100 ms before/during/
   after the stall. Require exactly 1,073,741,824 received bytes and peak RSS
   growth below 16,777,216 bytes. Preserve `rss.csv` and byte counts.
4. Open a real PTY at 80x24; `stty size` must report `24 80`. Resize to 120x40;
   expect `40 120`. Run `sleep 100`, send Ctrl-C and measure termination <=1 s.
5. Run guest `python3 -m http.server 3000` and forward via SSH
   `-L 3000:localhost:3000`; curl the local forwarded port and retain the listing.
   Refuse agent forwarding, remote forwarding and non-loopback direct-tcpip.
6. **Person on second Mac:** record VS Code Remote-SSH connect, open /workspace,
   edit/save a.ts, terminal `ls`, Ports-view forwarding of 3000, close/reopen and
   automatic reconnect. Independently verify saved bytes in the machine. Retain
   the recording; a written description cannot replace it.
7. Ten fresh revocation runs: with VS Code and `nohup sleep 10000 &` live, call
   the installed gateway's host revocation operation. Independently timestamp
   invocation, SSH disconnect, and populated 0 for **every** Ben cgroup. Record
   `revoke.csv` (run, start UTC/monotonic, disconnect ms, final-empty ms) plus raw
   per-cgroup samples and `/proc` identity/process samples. All ten disconnect
   and drain maxima must be <=5000 ms; retain surviving PIDs/states on failure.
8. Independently record live foreground/background cgroups, then SIGKILL only
   the supervisor started for this disposable VM. Init must restart it. Observe
   every old cgroup reaching populated 0 before the first accepted open_session;
   all old Ben processes must be gone within 2000 ms. VS Code must reconnect
   automatically. Inject cleanup failure and retain refused admission. Do not
   infer emptiness/admission ordering from supervisor logs alone.
9. During guest `seq 1 100000`, cut only the real host/guest relay for ten seconds,
   restore within thirty seconds and require all 100,000 lines exactly once in
   order. Retain output/digest and actual attach snapshots. Exercise a cut during
   stdin, a lost input WINDOW and a possibly delivered stdin EOF separately.

Also retain installed gateway/supervisor/init logs, fixed-identity and cgroup
samples, root-validation receipts, raw transport fault timestamps and all NO
artifacts. Summarize measured maxima and limitations in T-TRM-07. No local lane
count, configured deadline or constructor test supplies a measured number.

## Installed commands and current limits

Use the unprivileged `assemble.py` main release overlay described in README.md.
The proposed system bundle must include the main-pinned gateway, supervisor,
install.py, validation.py, launcher and scripts plus the real reviewer key and
signed approval described in README.md. This lane neither installs nor signs
that bundle. From `/usr/local/lib/smithers/current/share/trm06/`, use `run.sh`,
`flow.sh`, `revoke.sh`, and `run.sh measure`; the latter two campaigns need the
protected matching `ben-fixture.key`. Evidence is written under the install
owner's protected `.local/state/smithers/trm06/evidence/`; copy all raw artifacts
to the check evidence directory without converting partial/NO results to PASS.

The named root-check operations are implemented as partial campaigns and return
78, even when their current subset passes. Complete the missing controls listed
in README.md before collecting passing receipts. The ten-run campaign arms a held-descriptor cgroup observer before revocation;
validate its raw independent populated-0 samples on the reference host. Missing
or errored observations remain NO, never inferred emptiness. Terminal fixtures and restart samples do
not replace the second-Mac video or the VS Code-connected ten-run requirement.

Linux fixture additions (2026-10-07): `check-session` includes an invalid
uppercase child cgroup and a writable session-parent restart refusal. Successful
startup controls retain independent `/proc` executable digest, root UID tuple
and literal PATH-only environment in `<scenario>-startup.json`. The local
seccomp ENOSYS test is not the real no-Landlock kernel receipt; that installed
variant, launcher replacement races and cgroup replacement races remain required.
