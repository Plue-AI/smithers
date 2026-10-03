# C-SPK-06 (dark)

T-INS-01 is absent on the pinned main revision. `run.sh --bundle <dir>`
refuses missing files and unapproved provenance before any VM command.
It accepts no image, mount, guest-command or guest-environment override.
This is a preflight only, not the completed Homebrew/GUI qualification harness.

Do not use the historical lane-built backend or npm package as approved inputs.
A supplied manifest or matching caller-selected hash does not authorize root code.
No formula, LaunchDaemon, sudo step or production service is installed here.

After T-INS-01 lands, complete hash verification using its actual manifest and
main-built receipts before adding install/pour, relocated-keg and GUI-agent probes.
Run qualification with `node scripts/check-run.mjs C-SPK-06` after the check owner
approves its reference-host mapping. Do not add another receipt runner.

The three ticket tests still require real Homebrew, installed msb 0.6.16,
production backend doctor, fresh pinned machines, in-machine `echo ok`, loaded
library observations, a fresh GUI user and logout/login evidence. Preflight
refusals do not pass those tests. Delete this disposable directory after the
answer is recorded. Historical evidence remains in the prior report/artifacts;
the lead retains the issue history.
