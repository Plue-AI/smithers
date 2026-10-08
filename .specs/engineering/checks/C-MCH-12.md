# C-MCH-12 Secrets as files at a declared path; host-bound API keys stay off the machine; no sign-in on a fresh machine (M-42)

Folded into T-MCH-16's tests (spec.md §8.8.1a, §8.8.1b).

Automation: `packages/backend/internal/compose/secret_files_real_vm_test.go`, invoked by `TestInstalledMemberTerminalAndSSHChain` through its approved-bundle gate. The native fixture declares secrets before the fresh TODO machine boots and checks placeholder files, literal file owners/modes, replacement/removal on the running machine within 5 s, and a member-created symlink's unchanged target. Declaration refusals and path metadata also run in `TestSecretsWriteComposedInstallPostgres` and `TestSecretsInstallAPIAndLivePostgres` against the composed HTTP router and PostgreSQL.

The native chain also observes a literal key at a local provider fixture reached through the production egress relay from a guest placeholder file. It does not contact a real provider account.

Pending reference-host evidence: these authored cases and a coding tool consuming the declared key without sign-in; real-key disk scan; a symlink planted before retained boot. Arbitrary member-planted symlinks are currently refused by the writer, not at declaration; the route rejects known image symlinks. That declaration gap remains open; these tests do not waive it.
