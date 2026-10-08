# T-MCH-11 physical host restart campaign

Authored campaign, not executed evidence. Implements C-MCH-09 step 7 and
C-MCH-10 step 2 through the installed service, authenticated HTTP terminal launch,
terminal WebSocket and guest broker. Backend recomposition cannot pass this check.

Use a disposable approved Apple Silicon install at the commit under test,
PostgreSQL 18, the main-pinned C-SEC-02 bundle/helper and the real microVM runtime.
Serve the fixture repository `rehearsal-owner/app` from `cmd/githubfake`; never
point this campaign at a customer's repository. Allocate Ben as uid 20001.
Create two disposable branch machines with fresh Ben homes, with capacity for
both, and obtain Ben's browser session. No live tool login is required.

`TestInstalledPhysicalHomeRestart` writes distinct inert Claude, Codex and gh
login fixtures plus a 0664 marker on each machine as Ben. It runs the existing
1,000-write per-directory workload concurrently on both disks. It hashes only
those login files, the marker and workload trees (bytes, paths, uid, gid and mode)
inside Ben's terminal; only digests reach the test receipt. The test refuses
preexisting login/marker fixtures, missing workload trees and symlinks.

The test invokes the installed `smthrs host stop` and `smthrs host start`.
It requires launchd's `gui/<owner uid>/sh.smithers.host` job to disappear after
stop, readiness to recover and a different service PID after start. Then it
opens new authenticated terminals on both machines, allowing the production
wake path to recover their disks. All scoped hashes must match, home ownership
must remain 20001:20001 with 0700, marker ownership/mode must remain 20001:0664,
and neither machine may mount virtiofs under `/home`. A cleanup attempts to
restart the service if the campaign fails. The campaign leaves fixtures intact
for inspection; use new machines for a repeat.

Run on that install owner's Mac (the explicit opt-in permits stopping this
fixture service). Keep the session value out of command history and receipts:

```sh
export LANE=fr14-mch11
# Set SMITHERS_RESTART_BEN_SESSION privately, without recording its value.
export SMITHERS_PHYSICAL_HOME_RESTART=1
export SMITHERS_RESTART_ORIGIN=http://localhost:4000
export SMITHERS_RESTART_BRANCH_A=<first-machine-id>
export SMITHERS_RESTART_BRANCH_B=<second-machine-id>
export GOMAXPROCS=8
mkdir -p .artifacts/checks/C-MCH-10/<timestamp>
cd packages/backend
go test -p 4 ./internal/compose -run '^TestInstalledPhysicalHomeRestart$' \
  -count=1 -json > ../../.artifacts/checks/C-MCH-10/<timestamp>/physical-restart.json
```

Record the main commit, installed bundle/version, host profile and both machine
IDs beside the JSON receipt; redact the browser session. Retain the before/after
launchd PIDs and both digests printed by the passing test. Bind any required
owner signature to that exact commit. An opt-in skip, a process-recomposition
receipt or an authored procedure is never a passing physical restart receipt.
This campaign does not qualify a second Mac, live subscriptions (C-REL-05),
image isolation or every C-COL-04 case.

Run `TestInstalledMemberTerminalAndSSHChain` separately under its existing
approved native-bundle environment for C-MCH-06/09/10, including the new-recipe
empty-home regression. That regression sleeps A through the Branch API,
changes the fixture GitHub main image declaration to add `jq`, then opens a
new authenticated terminal on A. The common service wake refreshes the recipe
while A is stopped, retaining its branch identity and captured working copy.
The production runtime persists the target recipe before removing the old disk
and refuses a surviving old disk until removal is confirmed. The check requires
a different layer, jq in the new image, absent old personal logins/marker/cache
workload and unchanged B logins. No customer main moves and no retained branch
is deleted. Linux's recording-msb test supplies supplemental runtime/recipe
selection evidence, not a native private-home receipt.
