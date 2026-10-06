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
