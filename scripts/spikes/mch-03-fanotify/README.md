# S-2 stock guest prerequisite diagnostic

Run on the reference Mac with the installed runtime:

```sh
export LANE=fr3-wt-s2
source ~/lanes/env.sh
export SMITHERS_MICROSANDBOX_BIN=$(ls -d ~/lanes/integ-j1.evidence/install/smithers-*/bin/msb | tail -1)
python3 scripts/spikes/mch-03-fanotify/run.py ~/lanes/$LANE.evidence/stock
```

The runner uses the production image pin, a block root disk, no network,
and uid 19999. It records syscall results and mount information, then stops
and removes only its own randomly named VM. Exit 2 means attribution is
unqualified; subprocess failures remain errors. No product gate is activated.

Reference-host observation (2026-10-06, msb 0.6.16): Linux 6.12.99;
`/workspace` is on overlay. `FAN_REPORT_DFID_NAME` initialization succeeds
unprivileged; `FAN_REPORT_DFID_NAME | FAN_REPORT_PIDFD` initialization and
`FAN_MARK_FILESYSTEM` return `EPERM`. This contradicts the older T-MCH-03
prediction of missing fanotify / a pre-5.15 kernel. It does not prove that
the required privileged flags, filesystem handles, or writer attribution work.

The lane's product rule forbids loading or executing branch-produced code
as root. Consequently this diagnostic never copies or executes a root probe.
C-SPK-01's privileged observer, 24,000-operation writer matrix, editor rename,
and ignore-mark matrix remain unrun. A trusted installed privileged observer
is required to complete them. No missing event or unresolved-uid count is
reported as zero, and no rebuilt-kernel cost is inferred from `EPERM`.

Working-together design §4 and §10 supersede the deferred ticket's automatic
fallback build: S-2 measures stock support; exact attribution enters launch
only if the measured attribution gate fails. No libkrunfw rebuild or bundle
change is made here. The diagnostic is disposable when the lasting kernel
attribution integration test lands.
