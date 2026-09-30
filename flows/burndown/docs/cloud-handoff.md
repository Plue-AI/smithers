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
Export requires an ordered single-parent chain and applies the same path and
byte limits before the host validates the artifact. The VM does not need jj.

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
host verifies the exported base is an ancestor of the local prepared stack and
checks each touched path against its base, current `main`, local parent, and
working copy. Conflicting work is refused without overwriting it. The checked
paths are staged under the same lock so jj can select additions. A custom diff
editor reconstructs those paths, and each commit includes only those paths with
the required coauthor trailer. Preparation leaves `main` unchanged.

Successful receipt replay returns the same prepared IDs. An uncommitted failure
rolls back only checked own paths while their bytes still match the exported
states. A partial failure keeps the artifact, completed commit mappings, and
failure receipt for inspection; it does not silently restart or discard changes. Workspace cleanup can proceed
only after the host has retained the artifact, even when preparation refuses a
conflict.
