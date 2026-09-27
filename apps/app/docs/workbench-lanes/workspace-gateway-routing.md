# Every flow runs on a box

Every flow call names a box (a Plue workspace): flow provisioning, listing, planning, launch, run
inspection, approvals and triggers all run on that box's coding host. There is
no box-less path: the repository-level product gateway is deleted (#2194). This
is a routing choice, not an additional coding service or a browser-held
credential. Plue checks repository scope, write permission and workspace
ownership; the first bound-host release requires the actual workspace owner.

## Which box

One rule, `RepoContext.gatewayBindingFor`, answers which box a call on a
repository means:

1. a recorded run is addressed on the box its cards recorded; a run recorded
   with no box answers "This run's box is gone." and calls nothing;
2. otherwise the selected working copy, when it is a box of that repository;
3. otherwise the repository's default box (`RepoContext.repositoryBoxOf`, the
   same selection code intelligence uses): exactly one running box is the
   answer. With none running, the one suspended or stopped box is the answer
   and the call resumes it. Several running boxes, or several suspended or
   stopped ones, answer "Select a box of <repo> first.", one still starting
   "A box of <repo> is starting.", and none
   "Open a box of <repo> first: /box.open <repo>".

Repository jobs and the trigger registrar use the box their setups recorded,
else the same default box (`RepoContext.repositoryJobBinding`); flow authoring
prefers the selected box, then that one (`RepoContext.flowAuthoringBinding`).
A refusal is answered before anything reaches the network, on the surface the
act already uses (the command's failure toast, the plan or run card, the
lesson card), so it stays visible and the act can be retried once a box is
open. Chat is never held by it.

## Existing API extensions

The `POST /api/workflow/provision` and `POST /api/workflow/rpc` bodies
require `workspaceId` alongside `repo`; a body without one is refused. The box's
coding host on the Smithers backend serves both
(`packages/backend/internal/compose/browser_flow.go`); the Worker forwards the
body unchanged as the signed-in user (#2198). Provision answers `ready` once the
box runs and its host is live, else `provisioning`, which the app polls.
Canonical UUIDs are required.

```json
{
  "repo": "owner/repo",
  "workspaceId": "83e75ae5-0920-4000-8000-000000000001",
  "procedure": "Plan",
  "payload": { "flowId": "coding", "input": { "plan": {} } }
}
```

The example illustrates the envelope; a real coding plan must satisfy its
flow's schema. No box credential reaches the Worker or the browser.

The gateway's existing `GatewayHealth` schema accepts optional
`capabilities: string[]`. This schema addition alone does not advertise a coding
host. The configured host must validate its native binding and registered
`Executable.Catalog` before advertising `coding-plan/v1`; Plue refuses an ordinary
CLI as a coding host. Readiness also checks protocol, root hash, version and the
gateway row ID supplied by Plue through `SMITHERS_GATEWAY_ID`.

## Internal state and concurrency

The run-trace, run-list, approval, and approvals-inbox cards carry
`workspaceId` (optional only so cards saved before it existed still decode). New launches and opened
runs capture it before asynchronous work; Plan, approval, Run and provisioning
keep that captured binding even if the user selects another copy while waiting.
The run's subsequent reads, signals, approvals and cancellation derive their
route from recorded card provenance, including a run first seen in a list or
approval inbox. Conflicting stored bindings refuse instead of guessing. Approval
submissions use the trusted persisted approval binding. Older ancillary cards
that omitted a binding may inherit it only from the run’s already-recorded bound
run-trace card. Current selection never repairs historical ownership; explicit
disagreements still refuse and identify the conflicting card. A historical card
with no box refuses its acts ("This run's box is gone."); it is never
redirected to the current selection. UI frame/workspace IDs are unrelated to
Plue workspace IDs.

The gateway transport requires the app-level binding resolver, and its methods
accept a captured binding when several awaited calls form one operation.
The existing provisioning toast/deduplication identity includes the workspace.
The app uses the same flows, dispatcher and TanStack DB collections; this change
adds no component state or React effects.

List and inbox card IDs include their box so another listing does not
replace the first workspace's evidence. The existing `runs.list` flow accepts
optional `sourceCard`, used by its filter buttons to retain that card's binding
when the active selection changes; the controller validates kind and repository.
The same argument works through slash and agent doors:

```text
/runs.list parked sourceCard=run-list-owner/repo-83e75ae5-0920-4000-8000-000000000001 owner/repo
```

The shared `@smthrs/rpc/GatewayWorkspace` module exposes the small validation
contract persisted cards use:

```ts
import { GatewayWorkspaceIdSchema, isGatewayWorkspaceId } from "@smthrs/rpc/GatewayWorkspace"
const id = GatewayWorkspaceIdSchema.parse("ffffffff-ffff-ffff-ffff-ffffffffffff")
isGatewayWorkspaceId(id) // true: canonical hex, not restricted to an RFC version nibble
```

This aligns with Plue's existing canonical lowercase, non-nil ID predicate.

## Verification and limits

Tests cover canonical IDs, selection changes during actual controller
provisioning, every branch of the default-box rule, a box-less recorded run, and
a launch with no box (`src/mainview/state/BoxRequired.test.ts`). Run-card tests follow with a later run operation
under another active selection. The bound cloud host still needs to be staged
and deployed for a real end-to-end cloud run; these tests do not claim deployment.

## Workspace-qualified UI run references

A control run ID belongs to its gateway database. Two workspaces may both return
`run-1`. The app keeps those backend IDs unchanged and addresses a displayed run
by `(repo, workspaceId, runId)`. New run/approval card IDs encode that tuple.
Existing cards are found by their payload and retain their old IDs, so persisted
messages, frames and links still point to the same card.

The existing run flows now accept optional `sourceCard`: `runs.open`, `resume`,
`rerun`, `signal`, `steer`, `seat`, `thinking`, `tools`, `logs`, `steps`, `events`,
`trace.filter`, `trace.select`, `trace.view`, `trace.live`, `coding.select`, plus
`approvals.open` and `flow.run.stop-all`. This is an extension to their public
flow inputs, not a new backend service. Their embedded buttons send the same
input the agent or slash door can supply:

```text
/runs.steer sourceCard=flow-run@owner%2Frepo@83e75ae5-0920-4000-8000-000000000001@run-1 run-1 use the smaller diff
```

`sourceCard` comes first for these commands, keeping freeform message and JSON
arguments intact. A source must contain the requested run; an explicit different
repository refuses. A run-trace may open a child only when its control journal
actually records that child run ID. Native execution IDs do not establish a child
control run. Bare IDs still work when recorded provenance is unique and refuse
when several boxes contain the ID. Every asynchronous card action and pump
captures its own binding before awaiting a response.

Internal card metadata `gatewayBindingVersion: 1` distinguishes a card that
captured its binding from an old ancillary row written before bindings were
recorded. Only old rows lacking that marker may inherit the already-recorded
raw-key run-trace binding. The version is optional for persistence
compatibility; no collection migration discards or renames historical cards.
Refreshing an old list keeps its old card ID and pins the uniquely recorded box.
A historical list whose rows imply different boxes, or none, refuses the
refresh; it cannot choose one from the current selection.

Run search results keep separate opaque references for each recorded scope and
carry `sourceCard` into their existing Open, Resume and action-panel commands.
Their secondary line names the repository and bound workspace so equal backend
IDs remain distinguishable. Older bare search references continue to resolve
through the normal ambiguity check. Run lists and traces use the existing
runtime-owned-card boundary: agents obtain them by invoking flows and cannot
forge or rewrite their gateway provenance through `card.show` or `card.update`.
