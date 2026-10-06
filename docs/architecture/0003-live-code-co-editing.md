# ADR 0003: Live code co-editing

## Every write carries `base_digest`; stale is refused

Every Smithers app and coding-agent file mutation carries the full-file SHA-256
it was based on, encoded as 64 lowercase hexadecimal characters. `absent`
means that the destination must not exist. Reads and successful writes return
`digest`, calculated over the exact bytes, including binary files. Missing or
malformed bases and caller-supplied actor, branch, machine or uid fields are
rejected with HTTP 400. Identity comes from the authenticated principal and
its execution binding.

The isolated mutation provider compares at the write boundary. A mismatch
returns HTTP 409 with `code: stale` and `current_digest`; coding tools return
`stale_read` with the path and both digests. Refusal changes no file bytes.
The writer re-reads before retrying; there is no blind retry. An existing file
that a coding run has not read cannot be overwritten. Paginated reads record
the digest of the whole file. A successful own write advances the run's base;
a resumed run re-reads because its in-memory read ledger starts empty.

A patch validates every affected source and destination under the branch lock.
A stale later hunk refuses the whole patch, including moves and deletions.
Rollback must preserve an outside writer's displaced bytes and must not publish
success diagnostics or advance the read ledger for a refused patch. A separate
host read followed by a write does not satisfy this contract.

Stage 1 comparison runs in the guest after dropping uid, gid and supplementary
groups, before consuming branch paths or bytes. Stage 2 uses the authenticated,
registered-run `write_file` daemon operation from ADR 0004, as `machined`, and
removes the interim guest path. Unavailable or unqualified mutation providers
refuse writes; they never fall back to unconditional writes or host execution.
Guest enablement requires the T-SEC-01 fresh and retained-machine security
receipts and outside-replacement race evidence. The wiki retains Yjs
`Y.Text("markdown")`.

## Topology

Decided by T-COL-11.

## S1 candidate qualification

The current guest exchange candidate is **not qualified**. Run the supplemental
Linux probe as an unprivileged user from `packages/backend/microsandbox`:

```sh
python3 -I -B testdata/compare_write_races.py guest/smithers-guest.py
```

At `11e3daf4`, both cases fail on real Linux disk. An outside replacement during
rollback is exchanged into the temporary path and then deleted; the older
outside bytes replace the latest save. Moving an opened parent directory outside
the workspace before exchange also lets the candidate modify that outside file
and report success. Descriptor-relative lookup alone does not preserve the
parent's continued membership in the workspace.

The probe injects only these scheduling boundaries around real `renameat2` calls;
it does not replace the file operations or expected bytes. A corrected provider
must pass both cases in addition to fresh/retained-machine privilege and startup
qualification. The production command and coding-tool write gates stay closed.
