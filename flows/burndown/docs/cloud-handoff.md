# Cloud commit handoff

Cloud workers export their committed issue changes before their scoped workspace
is deleted. `prepareCloudHandoff` in `../cloud-handoff.ts` validates and retains
these bytes with a receipt on the local host, then reconstructs one local jj
commit per exported commit. The landing queue consumes the resulting local
commit IDs.

The Cloud VM commits with Git in its shallow clone. Read-only `git show`
exports the commit ID, single parent, and exact message; `git diff-tree --raw
--no-renames -z` exports changed paths, modes, and blob IDs. `git cat-file blob`
exports before/after bytes through base64, including symlink target bytes.
Each command runs through a bounded stdout receipt so a nonzero Git exit retains
its stage (`metadata`, `tree`, or `blob`), commit ID, exit status, and a redacted
stderr excerpt. Metadata and file bytes use base64; stderr is limited to 8 KiB in
the guest and 2,048 characters on the host. Export requires an ordered single-parent
chain and applies the same path and byte limits before the host validates the
artifact. An SSH grant failure or transport failure is separate from a Git exit.
The VM does not need jj for export.

The version 1 artifact contains `repository`, `base`, and an ordered `commits`
array. Each commit supplies `sha`, `parent`, `message`, and `changes`. Each change
supplies a repository-relative `path` and `before` / `after` entries, where `null`
means absence. An entry has `type` (`file` or `symlink`), `mode` (`644`, `755`, or
`120000`), and canonical base64 `data`. Renames are represented by the old-path
deletion and new-path addition. This preserves binary data, executable bits, and
symlink targets.

The host rejects unsupported entries, unsafe or ambiguous paths, file/directory
transformations, inconsistent
parent and file histories, more than 20 commits or 1,000 changed paths, entries
larger than 8 MiB, symlink targets longer than 1,023 bytes, and artifacts
exceeding 64 MiB of decoded file data. Artifact
and receipt directories are on the host filesystem; command credentials are
excluded from artifacts.

All jj mutations run in one executable through the repository's VCS lock. The
host verifies the exported base belongs to current main history and checks each
owned path against its exported base, current main, shared parent and working
copy. A stale or divergent shared parent is supported when those owned bytes
match. Changed owned paths are refused with the artifact retained. Under the
same lock, `jj split --onto` extracts only artifact paths onto the exported base,
then onto the preceding reconstructed commit. A private diff editor restores
exact artifact trees, including reversions. Full changed-path and parent checks
reject any unexpected content. Shared files, parent, description, bookmarks and
other prepared revisions remain intact; a working revision with descendants is
refused before extraction. The queue owns subsequent rebasing. Each commit uses
the coauthor trailer from the trusted coding assignment. The host retains its
`tool` and `model` in `attribution.json`; Sol uses the GPT-6.1 Sol trailer and
Opus uses the Claude Opus trailer. Reconstruction replaces guest-generated model
trailers with that assignment's attribution. A replay with a different identity
is refused. An artifact prepared without an assignment preserves its original
message without inventing an author. Preparation leaves `main` unchanged.

Before seeding shared paths, a durable intent records the exact initial and
seeded states plus the shared revision identity. A retry restores only matching
states under the same lock; changed bytes, a new parent or descendants refuse
rollback with the intent retained. While a crashed seed remains in the shared
checkout, another worker must respect the retained intent and path claim; if it
commits those bytes, automatic rollback refuses its changed parent. Only the
locked script writes `receipt.json`. Lock-runner failures use separate immutable
`runner-error-<id>.json` evidence and cannot overwrite another attempt's intent. This also covers process death before split.
Successful receipt replay rechecks the exact visible commit chain under the lock
and returns the same prepared IDs. An uncommitted failure
rolls back only checked own paths while their bytes still match the exported
states. A partial failure keeps the artifact, completed commit mappings, and
failure receipt for inspection; ordinary replay does not restart or discard changes.
Supported retained recovery can qualify already extracted commits under the lock:
it requires visible, nondivergent commit IDs and verifies source order, exact parent,
message and model attribution, the entire
changed-path set, every cumulative byte and mode, and current owned before-states.
It archives the prior receipt as `recovery-from-<hash>.json` and reuses verified
IDs without splitting again. Each lock attempt has its own immutable executable
so another caller cannot change its recovery mode while it waits. A wrong or ambiguous candidate
is refused with its receipt retained. Later unrelated work, parent changes and
descendants remain intact when recovery requires no additional extraction.
A pending extraction records its source, parent and candidate IDs before mapping
completion. Replay refuses an incomplete mapping so a process or wrapper failure
cannot duplicate a commit. Workspace cleanup can proceed only after the host has durably retained the
artifact, even when review or preparation fails. Without an artifact, execution
that may have produced commits keeps its workspace for recovery.

Before export, `recoveries/<attempt-id>/recovery.json` on the host records the repository, assignment key,
actual tool/model, workspace ID, reported status, and full commit IDs. It omits
agent notes, login material, and SSH grant commands. It retains the last export
stage, grant outcome, and cleanup outcome. A failed export keeps this receipt and
the workspace; a report receipt alone does not authorize deleting committed work.
Each attempt gets a separate receipt directory. Retrying an assignment cannot
overwrite an earlier workspace ID or report. Enumerate `recoveries/` to find
preserved workspaces, recover their commits, and delete them after retention;
empty or unknown reports alone are insufficient evidence for deletion.

Recovery uses the retained workspace ID to obtain fresh SSH access, inspect the
actual agent report and Git history, and retry export for verified commits.
Do not treat a `running` workspace status as proof that SSH works, or a transport
failure as proof that the reported commit is invalid. Retain the artifact before
cleanup, then run host review and reconstruction through their existing boundaries.
Tracked in [smithers#2944](https://github.com/smithersai/smithers/issues/2944).

For an already retained artifact, call `recoverCloudHandoff(recoveryPath)` from
`../cloud-placement.ts` on the host. It validates the manifest assignment and
READY sources against the content-addressed artifact, repeats source review,
and invokes the same locked preparation. It returns the original assignment key
with local commit IDs for the existing queue and retains source-to-local mappings
in the manifest. It requires `BURNDOWN_REVIEW_ACCOUNT`; it performs no Cloud
coding, workspace deletion, or engine-state edits. Review failure retains its
own verdict receipt. A successful retry moves an earlier failure to historical
evidence and clears active failure/stage fields. A recovered SSH grant likewise
retains the sanitized previous grant as `grantFailure`, with active status acquired.
