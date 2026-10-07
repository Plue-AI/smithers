# S-3: participant CPU ambiguity

Pending real-machine proof. This is a read-only spike, not a product attribution
implementation or an activation flag. It implements working-together.md §4/§10:
aggregate sessions by participant before counting ambiguous windows. The existing
`crates/smithers-machined/src/attrib.rs` also aggregates by participant;
its production implementation is owned by the attribution lane.

Run the observer unprivileged in the Linux guest on the Mac mini. Use the
installed broker / trusted host provisioning to establish these workloads;
never install or execute this branch's artifacts as root:

1. Person A: real VS Code server with a connected editor, in one session cgroup.
2. Person A: a continuously running real formatter, in another session cgroup.
   Format representative repository files throughout collection; record the
   formatter version, command, input hashes and cadence alongside the receipt.
3. Person B: a live, idle Node process, in a third session cgroup. Record its
   command and timers; do not replace it with a synthetic CPU burner or sleep.

Only A works during the measurement. B has no other active sessions. All
workload descendants must remain in their assigned session cgroup. Let server
startup, extension loading and formatter startup settle before sampling. Retain
VS Code version/extensions and the connected editor's activity description. The
observer records process argv, executable and verified real/effective/saved/fs
uids at every sample; argv is evidence, not proof that an editor was connected
or that a named program really is that workload. Operator workload evidence is
required in addition to the JSON before accepting the spike.

Copy `manifest.example.json` outside the repository and substitute the broker's
three real cgroups and two non-root uids. VS Code and formatter share A's
participant and uid; idle Node uses B's. Cgroups must not overlap. Then:

```sh
export LANE=fr3-wt-s3
source ~/lanes/env.sh
python3 scripts/spikes/session-attribution/probe.py /tmp/s3-manifest.json /tmp/s3-result.json --windows 200
```

The default is 40 windows (60 seconds); use 200 windows (5 minutes) for the
reference-host run and repeat with the team's normal extensions. Raw cumulative
`cpu.stat usage_usec`, per-window deltas, process identities, host/kernel and
probe digest remain in JSON. Any positive CPU gain counts, with no noise floor.
The formatter must gain CPU in every window; otherwise the one-active-person
workload is unproven and no decision is produced. More than one distinct
participant with positive gain makes a window ambiguous. Strictly over 10%
requires kernel attribution at launch. Exactly 10% does not. A result at or
below 10% is limited to the measured workload, not a general accuracy claim.

Windows sleep 1.5 seconds between readings. Observed intervals must be between
1.5 and 1.65 seconds; a heavily delayed observer refuses the result. Reading
three cgroups is sequential, not an atomic kernel snapshot. Missing processes,
permission failures, mixed uids, malformed/reset counters or insufficient
windows produce `status: pending`, no decision and exit 78. Existing output is
never overwritten. CPU alone does not prove who wrote a file: this spike tests
the ambiguity gate only. No HTTP/card path exists for this measurement.

```sh
export LANE=fr3-wt-s3
python3 -B -m unittest discover -s scripts/spikes/session-attribution -p 'test_*.py' -v
```

These are synthetic accounting, contract and CLI refusal tests, not S-3 proof.
This lane runs on a Mac without a microVM. The reference Linux guest run remains
pending; no percentage or launch attribution choice has been measured here.
