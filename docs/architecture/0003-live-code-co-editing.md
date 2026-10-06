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

### Repair requirements, still unqualified

Engineering spec §9.4.1 prescribes the same exchange-and-rollback sequence.
The outside-save-during-rollback counterexample therefore identifies a spec
algorithm defect as well as an implementation defect: the sequence does not
establish the promised stale-write guarantee. T-COL-10 (#3508) tracks the
correction; this ADR does not silently weaken the product contract or amend
the frozen ticket's prescribed implementation.

An exchange-based repair must exclude outside writers throughout comparison,
mutation and any rollback, including writers that can move an opened ancestor.
A lock used only by Smithers file tools cannot establish that exclusion. The existing rewrite
protocol in §9.4.2 is a candidate to extend, subject to qualification:

- Every unprivileged working-copy writer must enter the managed process tree
  before accessing repository bytes. Guest `exec`, privileged `fs` dispatch and
  setup's unprivileged home initialization now share that admission path.
  Direct unprivileged `fs` stays in its caller's command cgroup. Host-initiated
  helpers must serialize with the same transaction, and concurrent launches
  must remain stopped until it finishes.
- The mutation worker must remain outside the stopped tree and drop credentials
  before consuming branch inputs. The current `drop_to` retains the team
  supplementary group; it does not meet T-COL-10's no-supplementary-groups
  qualification requirement for that worker.
- A whole patch needs one bounded guest transaction. Standard file tools now
  prepare provider-bound snapshot bytes and submit one batch through the
  existing precondition policy, including both halves of a move. The production
  guest provider remains unavailable. Its transaction must finish independently
  of the frozen coding caller; a sequence of caller-driven filesystem calls
  would deadlock. Reuse the existing ledger and errors, without a second public
  write protocol.
- Failure, cancellation and restart must preserve the exclusion until a partial
  mutation is recovered. Thawing before rollback would reintroduce the known
  lost-update race. Outstanding kernel I/O also needs qualification on the
  actual guest kernel and working-copy filesystem.

The guest now has a fixed, protected coordinator lock in
`/var/lib/smithers/writer-coordinator`. Root admission takes the shared lock;
setup's fixed metadata phase and approved root recipes hold it while executing.
A future transaction or recovery supervisor must take the exclusive lock.
Any `pending` entry refuses admission without opening or decoding journal
bytes. Admission closes protected descriptors before forking unprivileged
workers. This is a prerequisite, not a transaction implementation: production
does not yet create or settle that recovery fence, freeze writers, or recover
a patch. Root recipe descendants surviving their supervisor also need lifecycle
coordination before this can establish exclusion. Tests use actual file locks
and process death with an ordinary-user protected-directory fixture; they are
not privileged guest receipts.

The supplemental probe in
`packages/backend/microsandbox/testdata/compare_write_freezer/` checks queued
io_uring poll-and-write requests in ordinary and SQPOLL modes, with a thaw
positive control. Both stayed paused on the supplemental Linux host; this is
limited feasibility evidence, not guest qualification. T-SEC-01 fresh and
retained-machine receipts, C-COL-01's production HTTP and coding-tool tests,
and the named security owner's approval remain required before enablement.
