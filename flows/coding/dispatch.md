# One dispatched agent turn

`coding/dispatch` is the door for a caller that wants exactly one turn: a
person typed a message, the agent should answer it, and it may read and edit
the workspace while doing so. Its module IS the `coding/Dispatch` flow, in
[dispatch/flow.ts](dispatch/flow.ts), over the actions in
[dispatch.ts](dispatch.ts).

It exists because every other door in this package runs a programme.
`coding/ImplementPlan` implements a validated plan. `coding/Request` plans, then
implements with required checks, and it is registered when the host loads a
project JSON from `.smithers/coding-project.json` or `SMITHERS_CODING_PROJECT`.
`repository/Job` investigates an
event. All three answer with receipts rather than with what the agent said,
and `validatePlan` requires a fast and a slow check per change, so a plain
question has no legal shape in any of them.

`coding/dispatch` is registered unconditionally. It needs no project
configuration, no memory and no check table, because it makes no plan and
produces no receipts. The host advertises `coding-dispatch/v1` beside
`coding-plan/v1`.

## Input

```ts
{
  turnId: string            // the caller's identity for this turn, echoed back
  prompt: string            // what this turn is asked to do (1..32,768)
  history: Array<{ role: "user" | "assistant" | "system", content: string }>
  role: string              // the seat role, e.g. "coding/dispatch"
  model?: string            // an explicit provider:model for THIS request
  workspaceRoot: string     // must be the root this host serves
}
```

`history` is the caller's bounded session window, oldest first, at most 200
messages — the window plue ships. The bound is declared in the schema so an
oversized window is a decode refusal at the gateway boundary rather than a
prompt that silently outgrows the seat's context. The window is rendered into
the prompt as the conversation the turn continues; the cell loop takes a
prompt and system teaching, not a message list, and this package does not add
a second one.

The seat is per request. `model`, when present, _is_ the seat, because the
native resolver already answers a `provider:model` id; absent, `role`
resolves through the host's role table, where `coding/dispatch` defaults to
the configured implementation model. Neither is read from the host's launch
environment, because a dispatched turn is launched by a caller that already
knows which seat the person picked, and re-reading it from the host would make
every turn in a workspace run as the same role.

`workspaceRoot` is checked against the root this host was started on and is
never used to reach one. A gateway request cannot move a host onto another
tree; the field exists so a caller that addressed the wrong gateway is told
so, as a typed `coding/Error` with code `invalid_request`, instead of having
its turn silently run somewhere else.

## Output

```ts
{
  turnId: string
  runId: string // the host run: the handle /projections takes
  seat: string // the request's model, or its role
  messages: Array<{ ordinal: number; role: "assistant"; content: string }>
  head: Revision | null
  revisions: Array<Revision>
}
```

`messages` is what the agent said, in order, and it is the shape a caller
persists as assistant turns. A turn may produce more than one because a real
one does: a plan, then what it did. `head` and `revisions` are what the
workspace holds after the turn, read from the native adapter. A turn that
edited nothing still answers: the native read is evidence about the
workspace, never a condition on the reply, so an adapter refusal downgrades to
"no revisions observed" rather than discarding what the agent said.

## Progress

Nothing new is published. The turn runs as an ordinary flow execution, so the
control journal already carries its lifecycle and its agent frames, and the
gateway already folds those into the `transcript`, `run-events` and `run-tree`
projections that `packages/smithers/src/Serve.ts` mounts on `/projections`.
`runId` is the handle: it is the `runId` every one of those selectors takes. A
remote caller streams a turn by subscribing to that run and commits the result
when the turn ends.

## One loop

The turn is one `AgentAction`, which is one run of the 1.0 cell loop under the
host's registry, sandbox budget and capability envelope. Unlike this package's
evidence-only reviewers it is not attenuated: a dispatched turn is expected to
read and edit the workspace with the tools the host installed.

`AgentAction.Options.seat` accepts a function of the decoded payload for this
door. It is read once per execution, before the first ask, and every later
rung — a correction re-prompt, a declared repair — compares against the id it
chose. A declaration that writes a constant is the same declaration it was.

## Verification

[coding-dispatch.test.ts](../test/coding-dispatch.test.ts) runs the flow on the
real Flow engine with a real QuickJS cell loop and a scripted provider: it
pins the graph (admit, one model call, observe — no plan, no checks, no second
loop), that the request's own model is the seat that resolves, that a
role-only request goes through the host's role table onto the configured
implementation model, that the window reaches the model, and that a turn
addressed to another workspace is refused before any model call.

[coding-dispatch-host.test.ts](../test/coding-dispatch-host.test.ts) drives the
served gateway the way a remote caller does: `Plan`, `Approve` and `Run` on
`/rpc`, then `Projection.Snapshot` on `/projections` for the run the receipt
named. Like its sibling host tests it needs Plue's native adapter and JJ
exporter (`PLUE_CODING_ADAPTER_SOURCE`, `PLUE_JJ_EXPORT_BINARY`) and skips
without them.
