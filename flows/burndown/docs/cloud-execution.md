# Cloud workers

Tracked in [smithers#2924](https://github.com/smithersai/smithers/issues/2924).

The worker layer selects `assignment.placement`. Cloud assignments use
`CloudSandbox.make` from `@smthrs/cli/CloudSandbox` and the same
`RunAgent` action and `Sandbox.layerHost` boundary as local assignments.

Configure the launcher with `SMITHERS_API_ORIGIN`, `SMITHERS_TOKEN`, and
`BURNDOWN_REVIEW_ACCOUNT`. The Cloud token must authenticate as `smithers-dev`.
The review account must identify an available local Claude login. Account
selection honors `BURNDOWN_EXCLUDE_EMAILS`; only the assigned login directory
is read when launching a worker. See [Cloud setup](../CLOUD.md) for bootstrap
commands without secret values.

Before creating a workspace, the launcher requests the supported GitHub main
pull and compares its receipt to GitHub's current main commit. Stale mirrors
fail before admission. Issue bodies and comments are read on the launcher and
included in the guest brief. GitHub credentials remain on the launcher.

The guest receives agent authentication on command stdin. Codex's `auth.json`
is written into a temporary `CODEX_HOME`; Claude receives an OAuth access token
in its process environment and a temporary `CLAUDE_CONFIG_DIR`. Cleanup removes
these directories after success, failure, or interruption. The native installer
supplies Codex, its code mode companion, and Claude (Codex 0.159.1 and Claude 2.1.285, with published archive digests verified). Large installers use the guest home cache rather than RAM-backed `/tmp`; guest commands run with
`HOME=/home/developer` and the Cloud checkout as their working directory.
Agent output is redacted before the launcher retains it. Cloud commands do not
write an unredacted agent log in the checkout.

A READY response starts handoff before the sandbox scope closes. The host first
retains the assignment identity, workspace ID and reported commits in a bounded
recovery receipt. The guest reports `READY <40-hex sha>`. Read-only Git plumbing
commands export the ordered single-parent commits, including before/after bytes, executable
modes, symlinks, and deletions. The launcher validates and durably retains this
artifact, runs the trusted host Fable CLI with source-only stdin and an explicitly selected review account,
and retains the verdict. Failed review leaves the artifact available for
recovery and returns an error.

The host reconstructs one local commit per exported commit under the existing
VCS lock. It refuses conflicting local edits or mismatched base bytes, preserves
unrelated working copy changes, and leaves `main` unchanged. Reconstruction
anchors to the artifact base even when the shared parent is stale; the queue
rebases the resulting commits. Retained artifacts can be requalified with
`recoverCloudHandoff(recoveryPath)` without launching Cloud coding again. The worker returns
these local commit IDs to the existing merge queue. After durable artifact retention, scope release may delete the Cloud workspace.
Export failure preserves the workspace and recovery receipt; review or
reconstruction failure preserves the retained bytes and receipts. Unknown
execution outcomes also keep the workspace. Temporary agent login material
still receives its normal cleanup.

Export errors identify the metadata, tree or blob stage and distinguish a Git
exit from SSH grant or command transport failures. Diagnostics are bounded and
redacted; agent notes and SSH grant commands are excluded from recovery receipts.
The actual coding tool/model also survives reconstruction, so Opus work receives
its own coauthor trailer. See [commit recovery](cloud-handoff.md).

Run deterministic lifecycle and handoff checks with:

```sh
node --experimental-strip-types --test flows/burndown/test/cloud-*.test.ts flows/test/burndown-cloud-handoff.test.ts
```

The paid live test is gated by `BURNDOWN_CLOUD_SMOKE=1`. It uses two selected
local test accounts sequentially, creates scoped `smithersai/plue` workspaces,
and requires each CLI to execute a command. Supply the Cloud environment from
Secret Manager in the launcher process; do not persist the token in a file.
