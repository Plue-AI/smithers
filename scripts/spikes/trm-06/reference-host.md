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

The installed cgroup restart campaign also replaces the sessions parent inode
(with the original preserved) and makes a valid-named child writable. All three
cgroup metadata controls now install the positive control before mutation and
require explicit startup refusal; previously the writable-parent selector was
incorrectly routed to the install-time refusal branch. These fixtures have local
regression coverage only; reference-host execution is still pending.

Pass-5 supplemental Linux coverage (2026-10-07): a separate synchronized attacker
thread now exercises all 36 artifact/manifest replacement cases (file, symlink,
parent inode, in-place contents, mode and hardlink across six inputs), 14 guest
installer destination cases, four overlay artifact/parent replacements and four
manifest publication controls. Kernel fd execution independently observes the
literal PATH-only environment for 12 individual poison variables and their
combination. Held-child cleanup/enrollment and three control-file symlinks use
real openat/read/write syscalls with ordinary temporary files. These are local
regressions, not installed root, real cgroup or Darwin descriptor receipts.

Launcher pre-exec revalidation now checks mode and digest as well as inode,
including the initially read manifest bytes. Overlay manifest publication uses
a held directory and atomic replacement, so a substituted manifest symlink does
not truncate an outside file. Trusted install ownership still matters: these
checks do not make concurrent privileged in-place writes safe after the last
check. Reference tests must use the actual installed launcher/init/relay and
retain the independent samples. The root campaigns still return incomplete;
none of this local evidence changes their pending_controls or accepts the
unsupported-Landlock kernel variant. All nine steps, ten VS Code-connected
revocations and second-Mac recording remain unrun.

Pass-6 installed environment controls (unrun): `check-install` now schedules
12 individual poison variables and their combination in 13 fresh VMs. The
installed fixture sets the installer process environment before its imports and
init launch, alongside workspace import canaries. Each requires independently
observed installed supervisor bytes, root identity and PATH-only environment,
then revocation with no Ben process survivors and unchanged outside sentinel.
This exercises guest installer/init sanitation, not host launcher startup;
installed host poison/race and unsupported-Landlock controls remain pending.

Each root campaign scenario now owns a separate evidence subdirectory. In
particular, `positive-after.json` is retained for every startup poison control
instead of being overwritten by the next VM. The campaign receipt indexes
completed scenarios and the failing scenario with its evidence path. Per-case
passes do not change the campaign's incomplete status or reviewer acceptance.

Every guest fixture invocation also retains numbered raw output and operation,
timestamp, byte-count and error metadata before evaluation. Failed startup or
fixture parsing therefore keeps its NO artifacts. Missing evidence storage is
an error, rather than a passing control with discarded observations.


Unsupported-kernel handoff: the installed command
`run.sh root-session-input-validation-no-landlock` now provides the executable
variant. Provision its kernel through the approved ordinary main release bundle;
the campaign never installs or selects a caller-supplied kernel. Keep the actual
ABI/errno/kernel observation, SSH and explicit broker refusal, independent
process/canary/sentinel samples and incomplete receipt. The campaign is unrun;
no no-Landlock reference receipt is claimed.

Pass-3 repair (2026-10-08): the guest installer now holds and validates both
`supervisor` and `boot.json`, rechecking bounded regular-file bytes, mode and
hardlink count after every destination-link check and before init launch. The
local synchronized matrix covers 32 destination/artifact refusals and a positive
control, including same-inode/same-size byte changes and boot replacement. Six
separate bounded subprocess controls exercise initial FIFO, directory, symlink,
hardlink, oversized and valid artifacts. UID observations and init launch are
substituted only in the local tests; no installed root acceptance is inferred.
These checks do not authorize a writable install tree or a concurrent privileged
writer after final validation. Installed launcher/cgroup races and host-startup
matrices, unsupported-kernel execution and all manual evidence remain pending.

Pass-4 live cgroup controls (2026-10-08, unrun on reference host):
`check-session` now also enrolls live foreground/background Ben processes,
arms held original cgroup events descriptors, then replaces the sessions parent
inode or makes it writable. A new authenticated open must return an explicit
refusal before the member canary runs; revocation must drain every original
observed group within five seconds. Each group needs its original populated-1
control and a timestamped raw populated-0 observation; a removed path or summary
alone cannot pass. All Ben processes must be absent and outside sentinel bytes,
owner and mode unchanged. Raw preparation/mutation/refusal/drain samples remain
in the scenario evidence directory. These enter the installed authenticated
relay, not a direct supervisor socket. Local fixture and receipt-parser tests
are supplemental; they do not qualify actual cgroup races, Darwin launcher
startup/replacement controls or native/manual acceptance. The campaign remains
incomplete and refuses PASS until the remaining controls are qualified.

Live ownership controls (unrun): `check-session` also changes the held original
sessions parent, session child or smithers ancestor to 20001:20001 after live
foreground/background enrollment. Mode and inode remain unchanged. Each uses
the same installed authenticated admission/refusal and original-descriptor
revocation campaign; retain raw mutation, refusal and drain observations.
Local syscall-selection regressions substitute fchown because the lane is
unprivileged; they are not installed ownership or revocation evidence.

Live child mutations enumerate directories with descriptor-relative, no-follow
metadata checks. Kernel control files (`cgroup.events`, `cgroup.procs`,
`cgroup.kill`, etc.) are not session children. Foreign directories and symlinks
refuse before mutation. Local regressions include those kernel-file entries
and verify their bytes remain unchanged; installed execution is still required.

Pass-4 close controls (unrun): each of the nine live cgroup replacement,
mode and ownership controls now runs twice in fresh machines, once with
`kill_sessions` and once with `close_session` followed by `kill_sessions`, selecting only the session ID
returned by the authenticated installed broker. The close campaign uses the
same original-descriptor observer, five-second bound, foreground/background
positive control, explicit admission refusal and outside sentinel comparison.
`-close` evidence directories distinguish these controls from revocation.
Close must leave foreground/background exec processes alive and owned (§9.6.3);
subsequent revocation must drain them. Both operations require strict `ok:true` replies; caller cancellation closes
the actual transport. These controls require installed execution before any
acceptance claim. A failed scenario no longer prevents later fresh-machine
scenarios from retaining evidence; cancellation still stops the campaign.

Startup ownership controls (unrun): the fixed boot and supervisor leaves,
parents and ancestors also change to 20001:20001 while retaining their bytes,
mode and inode. All six controls use installed fixture dispatch and the actual
init restart/refusal boundary. The local mutation regression substitutes only
fchown, verifying its held inode and fixed IDs; it grants no root authority.

Pass-5 additions (unrun): retain `sftp-packets.jsonl` for the concurrent leaf
racer and 32 acknowledged OPEN → replace → deny new OPEN → WRITE held inode →
CLOSE → restore schedules (16 leaf, 16 ancestor). A restored inode must contain
exactly `held-fixture`; outside bytes/owner/mode must remain unchanged. Five more
startup cases mutate boot bytes at the same inode (empty, oversized, same-size
invalid, duplicate key, changed secret), then require init's explicit refusal.
The supplemental Linux regression is not an installed receipt.

## Pass 6 handoff

Build release inputs without fabricating a base or key using `assemble.py
--build-only --output <new-dir>`. Retain `build-receipt.json` and all eight
artifacts. The regular overlay command still requires the same-revision base
and provisioned reviewer key; inputs alone never qualify an installed receipt.

Run `check-session`'s nine `-close-first` scenarios as well as the existing nine
`-close` and nine direct revoke controls. Each `-close-first` schedule arms the
independent original-events observer, acknowledges close, verifies exact
lingering PID/cgroup ownership, replaces the cgroup path, refuses new admission,
and revokes through the authenticated relay. Keep `live-observations.jsonl` with
every sample and failure; last-sample JSON files alone are insufficient.

The eight new boot restart mutations bring the startup matrix to 41 selectors.
They remain unexecuted installed controls until the approved provider runs them.
No acceptance or activation follows from local filesystem or gateway tests.

Also run the five added restart selectors `cgroup-ancestor-replaced`,
`cgroup-ancestor-writable`, `cgroup-ancestor-owner`, `cgroup-parent-owner` and
`cgroup-child-owner`. They use fresh VMs and the installed init restart/refusal
path, distinct from enrolled-session live revocation. Eight cgroup restart
refusals are now scheduled; none has been qualified on this Linux lane.

`check-install` includes 16 `install-*` controls over fresh destination ancestor
permissions/ownership and both destination object types. They use the installed
provider's actual installer dispatch, preserve outside fingerprints and require
refusal before init. Local syscall tests do not replace installed receipts.

The installed session campaign includes six `-revoke-race` cases for parent
and ancestor replacement, ownership and writable-mode mutations. Both workers
wait at one launch barrier, then call the installed observer and authenticated
relay concurrently. `live-synchronized-revoke.json` retains both operation
intervals and failures; nonoverlapping intervals refuse. `live-drain.json` is
captured before subsequent admission probes, including on failed operations.
The independent original-descriptor samples must still meet the five-second
bound. These cases have not been executed on a reference guest by the Linux lane.

The synchronized SFTP leaf/ancestor schedules retain `sftp-mutations.jsonl`
alongside `sftp-packets.jsonl`: literal SSH commands, start/end timestamps, raw
acknowledgments and failures. Existing mutation evidence refuses before SSH
effects. A successful packet exchange without the independent outside-sentinel
observations remains insufficient for acceptance.

Release archive publication now extracts the archive writer from the overlay's
full main revision, verifies that revision is an ancestor of origin/main, and
records `archive_writer_sha256`. A modified checkout writer cannot execute or
select publication bytes. The supplemental test uses a real Git repository,
poisons its checkout with a host canary and publishes through `archive_overlay`;
unlanded revisions refuse. This does not provide a complete real base/key
reproducibility campaign or an installed root-validation receipt.

## Shell-entry and admission matrix addition

Rebuild the complete same-revision overlay: shell entries now carry loader and
gateway digest pins embedded by `assemble.py`. Copying the checkout templates
is not installation. Keep the outer bundle/OS verification receipt for the
initially executing shell entry; the inline bootstrap cannot certify its own
shell bytes before they execute.

`check-install` first runs fourteen actual installed host startup controls,
retaining child startup output, stderr and a separate OS UID/command sample.
Execute the 48 startup selectors, including `startup-supervisor-writable`,
`startup-supervisor-empty`, `startup-supervisor-same-size` and the four
`startup-*-held-leaves` ancestor replacements. Execute all nine
`cgroup-live-*-admission-race` session controls. Keep their
`live-synchronized-admission.json`, `live-observations.jsonl` and held original
cgroup drain samples. An admission that wins before mutation runs only sleep;
post-mutation admission must explicitly refuse, and revocation must drain all
Ben processes within five seconds. These installed controls are authored but
unexecuted on the Linux lane. The campaign remains partial-pass/unaccepted.

Installed startup and synchronized path controls (fr17-trm06-r2):

`check-install` now creates real Python import and shell startup files and a
native library constructor under its evidence directory. `/usr/bin/clang`
builds the Darwin library and an ordinary probe; import, shell and library
positive controls must each produce the literal marker before it is removed.
Compiler output, positive marker copies and the actual injected environment are
retained. Each installed shell/loader/gateway startup control then requires the
marker to remain absent, alongside the existing independent process/environment
samples. A missing compiler or ineffective positive control refuses the check.
The local Linux constructor control observes LD_PRELOAD executing before the
shell clears its environment; that platform result is not Mac startup evidence.
No compiler output is installed or used as prototype authority.

`check-session` additionally releases member-owned leaf/ancestor replacement and
SFTP OPEN together, sixteen times each, through the installed SSH listener.
`sftp-path-races.jsonl` retains both operation intervals and raw OPEN replies;
nonoverlapping operations are inconclusive and refuse. Each path has a positive
OPEN/CLOSE, and post-replacement OPEN must refuse. An OPEN that precedes the swap
must preserve its original workspace handle through WRITE/CLOSE, with the saved
bytes checked after restoring the path. Existing independent outside sentinel
bytes/owner/mode checks remain mandatory. Run these on the approved native
install; local reply-classification tests are not confinement acceptance.

These controls do not complete installed host artifact/destination replacement
validation, the unsupported-Landlock execution, native steps/revocations, complete
same-revision overlay or the second-Mac/security/protocol acceptance.

Pass r3 installed destination schedules (reference execution pending):
`check-install` now includes 45 additional fresh-VM schedules: a positive control,
30 ancestor/destination cases and 14 supervisor/boot artifact cases. After the
actual installer holds and verifies both artifacts, an installed observer waits
for a separate mutation process to complete before resuming final validation.
The production installer’s validation and init launch are unchanged. Literal
selectors cover symlink, copied ancestor, preserved child inodes, writable and
wrong-owner directories; executable canary, FIFO, directory, hardlink, same-size
contents, writable and wrong-owner artifacts. Preserve worker PID, monotonic
ordering, explicit installer refusal, and outside digest/owner/mode in each
scenario. The earlier unsynchronized writable-parent loop is removed. This does
not complete the native host launcher replacement matrix, execute the guest
controls, grant acceptance, or supply a recording.

Pass-4 startup ordering repair (2026-10-08): the embedded bootstrap retains every
no-follow install ancestor and rechecks those identities and metadata, plus the
launcher leaf identity, immediately before evaluating the held launcher bytes.
The supplemental Linux namespace campaign adds 22 synchronized schedules at
that boundary, including preserved-child-inode ancestor replacements. A forked
worker records hold/mutation/resume monotonic timestamps; the real rendered
bootstrap resumes its normal validation. Positive execution and explicit exit-78
refusals preserve literal outside bytes/owner/mode. Set `TRM06_LOADER_EVIDENCE`
to a new file when running `test_bootstrap.py` to retain the raw schedule samples.
The campaign totals 113 loader controls and uses `/bin/true` as a substitute
gateway; it is not installed prototype, native cgroup or native startup evidence.

The remaining installed host replacement matrix needs a reviewed disposable
root-owned native fixture, not the live system installation. This Linux lane has
neither that fixture nor a same-revision Darwin base/reviewer key. The startup
repair is part of the assembled embedded launcher used by every root campaign;
its supplemental schedules do not remove any `pending_controls`, grant authority
or change acceptance. Native execution, the unsupported-Landlock variant, all
nine steps, ten VS Code-connected revocations and both owner acceptances remain
required. Issue #3554 is still closed despite those missing receipts; the lead
owns its reconciliation.

Pass-5 supplemental launcher controls (2026-10-08): `test_bootstrap.py` adds
95 synchronized schedules after the production launcher's initial artifact
hashes and before its final path checks. The rendered embedded bootstrap loads
the unchanged production launcher; no ownership check or exec function is
mocked. A forked worker replaces each of manifest, launcher, run/revoke/flow
entries and gateway with copied bytes, retained-inode links, symlinks, writable
files, same-size bytes, hardlinks, FIFOs, directories and an executable canary.
Seven ancestor matrices (including `/usr/local`, `/usr/local/lib` and
`/usr/local/lib/smithers`) also preserve child inodes when replacing a parent.
Thirteen positive schedules complete the same trace/worker ordering without mutation.
The literal shell canary is independently executed before refusal controls;
Sentinel owner 0 and regular-file mode 0644 are literal expectations;
every refusal retains exit 78 and the exact authority error, with outside
sentinel digest/owner/mode unchanged. Samples include worker PID and monotonic
hold/start/end/resume ordering. Removing final launcher revalidation makes the
retained-inode manifest schedule accept, failing the regression assertion.

The combined namespace campaign now has 208 controls (22 synchronized bootstrap
and 95 synchronized launcher schedules). Its receipt retains both arrays and
`accepted=false`; the gateway remains `/bin/true`. These controls supplement
the installed root-validation campaign but are **not** wired as passing native
controls, do not remove `pending_controls`, and do not supply the missing
reviewed disposable native fixture. The native launcher/artifact/destination
matrix, complete overlay, unsupported-Landlock execution, nine steps, ten
connected revocations, recording and reviewer acceptances remain uncompleted.
