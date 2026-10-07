# Working-together fault evidence

`smthrs test //scripts:workingTogetherComponents` executes the existing Rust
versions, outbox, capture, reconcile, barrier, documents and rebase suites with
`testing,killpoints`. K1/K2's process-exit test repeats ten times per point.
These suites include real temporary disk/process boundaries and test-only
service fixtures. They do not qualify the integrated C-DUR-04 matrix.

`smthrs test //scripts:workingTogetherFaults` runs the same components, records
K1–K8 as blocked, and exits 2 after component success. A component failure or a
suite with zero assertions exits 1. Both write fresh C-DUR-04 directories with
commit, actual runner host profile, argv and complete logs. Symlink parents and
existing directories are refused. Hooks are enabled only for the debug test
build; no branch binary is installed or run by root.

Full proof still needs the integrated writer/head/receipt/browser matrix in
`packages/backend/internal/machined/fault_test.go`, W3 capture/VM composition,
and W15's daemon document wiring. The reference rehearsal also needs a second
Mac's authenticated browser/SSH fixtures, sleep/wake, two typists during rebase,
host restart, stale outside save, revocation and both themes. A component pass
or an unavailable performance run never marks any of those as complete.

`smthrs test //scripts:workingTogetherWikiFaults` runs the composed wiki
host crash/restart boundary ten times with real PostgreSQL and native document
state. Create the untracked `.artifacts/working-together-host.json` with
`databaseUrl` naming a dedicated test PostgreSQL server and `libraryPath` naming
the current unprivileged native library. The runner sets the required test
environment internally because target tools receive a narrow environment.
Credentials are never copied into receipts. The app's
pinned Yjs installation and Bun must be available. Missing native state fails,
and a skipped or incomplete test never qualifies. Fresh C-DUR-04 evidence
contains the runner profile and full Go JSON logs. `boundary-passed` qualifies
this fixture only: the complete writer/head/receipt/client-text artifact matrix
remains incomplete. No guest VM or second laptop proof is implied.
