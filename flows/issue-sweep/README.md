# Local microVM sessions

`placement: "vm"` accepts `agentsPerVm` (default **1**) and `maxVms` (default
**24**). `maxAgents` remains a count of agents: the sweep admits at most
`min(maxAgents ?? 4, 24, maxVms * agentsPerVm)`, also bounded by accounts and
host free disk. Cloud capacity is separate. These values pass through the
persisted work child and remote action; changing them requires a new sweep.
A host refuses conflicting pool configurations rather than silently applying
whichever sweep ran first.

Example payload:

```json
{ "repo": "smithersai/smithers", "placement": "vm", "maxAgents": 24, "maxVms": 8, "agentsPerVm": 3 }
```

VM memory is `memoryBaseMib + agentsPerVm * memoryPerAgentMib` (defaults
**1024 + k × 3072 MiB**); CPUs are `min(maxCpus, 1 + k * cpusPerAgent)` (defaults
**8**, **1**). These four sizing fields are also sweep payload options.
`LocalVm.make` additionally accepts explicit `memoryMib` and `cpus`; shared
memory must cover the base and every session ceiling. `maxAgents` bounds this
provider independently (default 24), and `bootConcurrency` still defaults to 8.

Each lease has a unique `Sandbox.Session.id`, workdir, HOME, login directory,
git index/refs and jj repository. Its colocated jj working copy borrows only
immutable git objects from the refreshed snapshot checkout, so a jj history
operation cannot move a neighbor's changes. `Sandbox.run` resolves and captures
only that checkout; `SandboxMerge.apply` consumes its independent patch.
A failure or cancellation releases that lease. The last release destroys the
VM; a freed lease can be reused while others continue.

The VM refreshes and installs once. Per-session pnpm installs use the shared
store with `clone-or-copy`, retaining independent links and writable package
files; reflink support determines whether imports copy data. Sharing writable
`node_modules` or hardlinking writable dependencies would let edits escape
between sessions. Go/build caches and the prepared toolchains remain shared;
Codex receives access only to the declared cache directories, not the template
checkout. This avoids repeated network fetches, but install cost and actual
physical memory savings have not been measured.

Shared sessions require writable cgroup v2 memory control. Each session's
preparation, install and commands enter a separate cgroup with `memory.max`
and `memory.oom.group=1`; release kills that cgroup before removing its files.
Missing support fails acquisition. This contains ordinary agent OOM and
cancellation; it is not a security boundary against hostile root commands.
A VM/kernel failure still affects every session in that VM. The default
one-agent path does not require cgroups and retains its 2-CPU/4-GiB shape.

## Capacity (configured, not measured)

At the unchanged **24-agent** local ceiling, fully packed VMs:

| Agents/VM | VMs | CPUs/VM | GiB/VM | Total configured GiB |
| --------- | --: | ------: | -----: | -------------------: |
| 1         |  24 |       2 |      4 |                   96 |
| 2         |  12 |       3 |      7 |                   84 |
| 3         |   8 |       4 |     10 |                   80 |
| 4         |   6 |       5 |     13 |                   78 |

These are allocation ceilings, not resident-memory or throughput claims.
Keep `agentsPerVm: 1` in production until the guarded k=3 test has an executed
receipt on the deployed snapshot. Then try k=3 at the same agent cap in the
separately scheduled measurement; do not raise concurrency from these numbers.

## Validation

`test/vm.test.ts` uses the fake SDK to cover leases, independent captured
patches, logins, OOM setup, cancellation, failed boots/preparation, capacity,
and the default path. `work.test.ts`, `claude.test.ts` and `decide.test.ts` cover
payload propagation, guest paths and placement accounting.

`test/vm.shared.real.test.ts` is the only shared real-VM acceptance test. It
requires explicit `ISSUE_SWEEP_SHARED_VM_REAL=1`, records host load, and skips
above its load guard before provisioning. It acquires exactly three sessions
on one VM, edits three independent files, captures each patch and applies each
through the real adoption path. No capacity/load benchmark is part of this
change. Track outstanding real evidence in #3365 and the test campaign #2290.

### Receipt — 2026-10-01

- Fake VM suite: 24 passing cases.
- Claude guest suite: 49 passing cases; placement/schema suite: 14.
- Work/adoption suite: all 20 cases passed across the full run and the corrected
  cancellation-fixture rerun. The first run had 19 passes and one stale fixture
  path; the affected rerun passed.
- Formatting and generated target-index checks passed. The target-index run
  also passed its registered-test coverage gate; this is not a code-coverage
  percentage. A broad flows typecheck was stopped under host pressure and has
  no passing receipt.
- Opt-in real k=3: **skipped before boot** at `2026-10-01T22:10:11.133Z`.
  Load averages were `123.249 / 60.667 / 44.158`, free host memory `817315840`
  bytes; the one-minute load guard was 16. No real VM or load benchmark ran.

The commands are `node --test flows/issue-sweep/test/{vm,claude,decide,work}.test.ts`
and, only during an approved idle window,
`ISSUE_SWEEP_SHARED_VM_REAL=1 node --test flows/issue-sweep/test/vm.shared.real.test.ts`.

After rebasing onto current `main`, the six affected Cloud/Codex cases passed
again, including the newly upstreamed provisioning-retry case.
