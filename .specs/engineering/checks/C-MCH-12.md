# C-MCH-12 Secrets as files at a declared path; host-bound API keys stay off the machine; no sign-in on a fresh machine (M-42)

Folded into T-MCH-16's tests (spec.md §8.8.1a, §8.8.1b).

Automation: `packages/backend/internal/compose/secret_files_real_vm_test.go`, invoked by `TestInstalledMemberTerminalAndSSHChain` through its approved-bundle gate. The native fixture declares secrets before the fresh TODO machine boots and checks placeholder files, literal file owners/modes, replacement/removal on the running machine within 5 s, and a member-created symlink's unchanged target. Declaration refusals and path metadata also run in `TestSecretsWriteComposedInstallPostgres` and `TestSecretsInstallAPIAndLivePostgres` against the composed HTTP router and PostgreSQL.

The native chain also observes a literal key at a local provider fixture reached through the production egress relay from a guest placeholder file. It does not contact a real provider account.

Declaration validation now asks the broker to inspect every retained branch
filesystem before storing a nonempty path, including value-only replacements.
The guest walks all provisioned homes without following links or creating
components. A member-planted link is refused with class `user`; an unavailable
inspection refuses the mutation. Sleeping machines use normal wake admission.
The writer still refuses links planted after inspection.

Pending reference-host evidence: execute the authored native lifecycle, relay,
whole-disk scan, retained-boot symlink and installed coding-tool campaign.
`testInstalledCodingToolSecret` runs the real installed Claude Code in the
fresh TODO branch as uid 19999, reads the declared placeholder file, and
requires a real Write-tool result without a subscription sign-in. Its local
Anthropic streaming fixture requires the relay-substituted literal key.
No fake coding executable or real provider account is used.

Replacement and deletion assertions include the HTTP mutation in their strict
five-second wall-clock budget; late responses or late guest observation fail.
The credential chain plants a member-owned target symlink before retained boot,
declares its secret while the machine sleeps, then verifies the symlink and
outside target remain unchanged after wake. This is authored native coverage,
not a passing native receipt. A replacement declaration is also refused before persistence.

The composed native chain observes placeholder ownership and mode in the
owner's, Ben's, Alice's and agent's private homes. Replacement and removal
share one deadline across the HTTP mutation and every home observation.
Environment scans send only the real fixture's SHA-256 digest to the guest,
so the acceptance command itself cannot plant the key in shell history.
These additional assertions still require execution on the approved bundle.

The native chain now invokes the existing installed-bundle `scan-secrets`
diagnostic after relay substitution. It requires a complete whole-disk and
process-environment scan with no hits for either literal host-bound key.
Sentinels travel only over the trusted diagnostic's stdin; no terminal command
contains them. This authors the disk scan; execution on the approved bundle
remain pending; the coding-tool falsifier is authored in the same native chain.

The native chain additionally declares `/run/smithers/files/mch/key` before
fresh boot, observes its literal `0:20000:640` ownership/mode and lack of write
access from every member and agent session, and checks replacement and deletion
within a shared five-second deadline. The composed HTTP/PostgreSQL campaign
checks absolute-path metadata, value-only replacement, moving the declaration
to a home path, persisted path identity and deletion. Native observations still
require execution on the approved reference host.

The runnable browser projection is `TestLiveSecretsBrowserPostgres` and
`apps/app/e2e/playwright/spec/C-MCH-12.spec.ts`: the production install,
PostgreSQL, app Secrets card, shared command flows and Live are used without
intercepted API replies or a seeded card. This proves declared path metadata,
write-only values, reload, replacement and deletion, not native qualification.
