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
  before accessing repository bytes. Guest `exec`, privileged `fs` dispatch,
  approved root recipes and both phases of setup now share that admission path.
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
`/var/lib/smithers/writer-coordinator`. Root admission takes the shared lock
while creating the managed group, then closes its protected descriptors before
forking. Setup's metadata phase and approved root recipes execute in that tree
without dropping credentials; only their validated helper call sites can choose
this private mode. Ordinary commands and home initialization still drop first.
The supervisor collects recipe descendants on normal completion or cancellation.
If the supervisor dies, its descendants remain subject to the aggregate freeze
and existing cgroup recovery, even after detaching their process sessions.
The transaction or recovery supervisor takes the exclusive lock.
Any `pending` entry refuses admission without opening or decoding journal
bytes. Retained startup installs the trusted helper, collects old command groups,
then invokes `recover-files` before preparation can admit new work. This fixed,
operand-free command can settle an existing journal but cannot start a mutation.
Recovery failure refuses startup; cancellation alone still never thaws a journal.
Production app and coding writes remain disabled. Tests use actual file locks
and process death with an ordinary-user
protected-directory fixture. The Linux lifecycle probe also exercises the real
recipe subprocess path with an instrumented root identity and test recipe pin.
These are not privileged guest receipts, nor proof that services started through
external IPC or already executing kernel I/O cannot write during exclusion.

The private mutation worker now prepares a bounded journal for one whole batch.
It compares all affected paths before creating workspace directories or changing
files, saves original bytes and modes, then records a durable prepared state.
Updates, additions, deletions and moves settle as one committed state. Recovery
validates every backup and current path before restoring anything; an unexpected
outside write or corrupt journal refuses further recovery. Settled commit/abort
records never reapply bytes after writers may have resumed. Process-death and
I/O-failure tests cover preparation, directory creation, replacement, deletion,
rollback and settlement. The supplemental Linux `testdata/mutation_batch/` probe
holds an actual competing writer while exercising stale refusal and recovery.

The private coordinator candidate now holds the exclusive admission lock and a
root-owned recovery directory. It grants only an inner journal descriptor to a
worker outside the frozen writer tree. Saved uid/gid and supplementary groups
are dropped and checked; dumpability is refused across the credential transition.
The worker consumes input before signalling readiness, then waits for freezing
before comparing or changing files. Only a durable settled signal allows thaw;
the potentially blocking response follows thaw. Recovery collects an orphan
worker before inspecting its journal as the dropped identity. Interrupted cleanup
keeps the pending fence. Root handles fixed metadata and control bytes, not journal
payloads or branch data.

The existing `kill-all` cancellation entry also collects the worker outside the
writer tree. It preserves the pending fence and freeze; cancellation does not
decide whether a partial transaction is safe to thaw.

The supplemental `testdata/mutation_coordinator/` probe runs this coordinator
with real Linux cgroups and pipes. A caller sends and receives more than a pipe
buffer; coordinator death during input, partial mutation, settled-before-thaw and
after-thaw recovers through `recover-files` without the old supervisor. An outside
save after thaw survives.
Root ownership and credential transitions are instrumented for ordinary-user
delegation, so this does not qualify privileged journal isolation or machine reboot.

The private guest adapter now decodes the same `changes` envelope as the existing
file-content route. Paths, bases, exact UTF-8/base64 bytes and explicit deletions
are decoded only after credential drop, before writers freeze. Duplicate fields,
identity/mode injection, malformed content and bounded-size violations refuse.
The journal preserves the existing mode observed under exclusion, or uses 0644
for a new file. Stale responses include the affected path and full digest as
structured data, emitted only after durable abort and thaw so a frozen caller
cannot block settlement on a full error pipe. The private host transport submits the whole batch once and
checks every acknowledgment path/digest; malformed or incomplete replies cannot
be reported as success. It does not implement the qualified runtime capability.

The existing authenticated file-content PUT also accepts a bounded `changes`
array: one full base per path, exact text/base64 bytes, explicit null deletions,
and at most 256 paths with 1 MiB of decoded content (the request body has its
own 1 MiB bound). Single-file requests retain their response shape and use this
same service transaction. Duplicate and ancestor/descendant paths are refused.
One mutation-authority scope encloses one provider batch call; a stale batch
response identifies its refusing path and acknowledges no writes. The qualified
runtime capability now requires whole-batch semantics and preservation of
existing modes. Service/HTTP tests of this seam do not qualify the guest.

The coding filesystem now prepares immutable snapshots from its existing
run-scoped ledger and submits every prepared path in one provider call. A move
includes both destination bytes and source deletion. Receipts must acknowledge
exactly those paths and expected full digests before own-write bases advance;
stale, malformed, cancelled and failed attempts do not advance them. Settlement
preserves any explicit read that raced the request. The operator-only provider
receives the pinned root and trusted logical run ID and must enforce live run
authorization and write permissions. No production provider is installed yet;
recording-provider tests exercise the standard dispatcher, not guest security
or authenticated HTTP acceptance.

The production CLI/runtime gate still refuses new mutations. Coding run-bound
authentication and transport, the actual working-copy filesystem
and path-alias behavior, external-service/kernel-I/O exclusion, and fresh/retained
security receipts remain outstanding. The old failing exchange candidate is
retained only for diagnostic counterexamples until repair cutover; neither
candidate is exposed by the production write gate.

The supplemental probe in
`packages/backend/microsandbox/testdata/compare_write_freezer/` checks queued
io_uring poll-and-write requests in ordinary and SQPOLL modes, with a thaw
positive control. Both stayed paused on the supplemental Linux host; this is
limited feasibility evidence, not guest qualification. T-SEC-01 fresh and
retained-machine receipts, C-COL-01's production HTTP and coding-tool tests,
and the named security owner's approval remain required before enablement.
