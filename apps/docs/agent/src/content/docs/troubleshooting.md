---
title: "Troubleshooting"
description: "The typed failures @smthrs/agent reports, what causes each one, and what to change: seats, structured output, budgets, quota waits, approvals, children, checkpoints, and composition errors."
editUrl: "https://github.com/smithersai/smithers/edit/main/packages/smithers/agent/docs/troubleshooting.md"
---

Every failure this package reports is typed, and most of them are a decision
the host made, stated back plainly. Find the failure's tag or message and read
the matching section. The full error schemas are in the
[API reference](/reference/api/).

## SeatUnresolved

**What happened.** The host could not turn a declared seat string into a model
route: an unknown provider, a missing API key, or an invalid endpoint. The
message "No seat resolver is configured" means the composition provided no
`SeatResolver` at all (`SeatResolver.layerNoop`).

**What to change.** Provide a `SeatResolver` that serves the declared seat, or
fix the declaration. `AgentSession` resolves the seat at launch, so the failure
arrives as `LaunchFailed` before the run is accepted; `AgentAction` fails the
step with `SeatUnresolved` in its `AgentFailure` union. See
[Resolve seats into live models](/guides/seat-resolvers/).

## LaunchFailed: flow declares no model seat

**What happened.** A control-plane launch named a prompt flow whose frontmatter
has no `model:` line. No agent host can ever run one, so the launch is refused
rather than left pending. The refusal message says to add the line and run
[`smthrs doctor`](https://smithers.sh/docs/reference/cli/doctor/) to see which provider keys the project has.

**What to change.** Add `model: PROVIDER:MODEL_ID` to the flow's frontmatter.
A flow with a module body is a different case: it stays `pending`, because only
prompt flows run on the agent.

## LaunchFailed: selected sandbox unavailable

**What happened.** The flow's `sandbox:` names a provider this host cannot run
it on. The cause is `SandboxRefused`: `unconfigured` when the host configures no
provider of that name, `options` when the provider refuses the selection's
network or limits, and `module` for a module flow, since only prompt flows run
in a sandbox. `AgentSession` refuses before loading the body or resolving a
seat, including when an existing accepted run resumes, and never runs the flow
on the host instead.

**What to change.** Configure the provider on the host
(`Application.Config.sandboxProviders`, or `SMITHERS_SANDBOX_IMAGE` for
`container` on the CLI), or change the selection to one it can honor.

## StructuredOutputFailure

**What happened.** The model answered, and the answer did not fit the declared
`output` schema after the step's correction budget and, if declared, its repair
ask.

**What to change.** Read the failure's `issues` for how the last candidate
missed, and the run's `flows.agent.structured-output-rejected.v1` records for
how earlier candidates missed. Then fix the prompt or the schema, raise
`Options.corrections` or `Host.defaultCorrections`, or declare a `repair` prompt
for the failure mode you are seeing. The ladder is in
[Shape a model's answer into typed output](/guides/structured-output/).

## InvalidCorrectionBudget

**What happened.** A correction budget that is not a non-negative safe integer
was declared, in `AgentAction.make` or in `Host.defaultCorrections`. It is
raised synchronously at declaration time, because an unbounded correction
budget is a run that re-prompts forever, and the cheapest place to say so is
where the number was written.

**What to change.** Pass a non-negative safe integer. Zero is legal and means
"a first miss is terminal".

## Budget.ConfigurationError

**What happened.** Budget acquisition rejected an invalid policy or accounting
bound, before any model work. The message identifies the configuration path.

**What to change.** Use non-negative safe integers for token ceilings, finite
non-negative milliseconds for latency, and positive safe integers for
`maxRuns` and `recoveryEntries`. Omit a ceiling for no limit; do not use infinity
or `NaN`. `onExceeded` must be `fail`, `warn`, or `skip-remaining`.

## BudgetExceeded

**What happened.** The run has spent `used` of its `max` approved `scope`
(`tokens` or `latency`), and the next model call is projected at `next`, the
largest call the run has made. `reserved` is capacity held by other in-flight
calls. Until a positive cost is known, one call reserves the whole token
allowance; zero refuses new calls unless `warn` permits them. A paid step's
replay still proceeds for free. Estimates are soft, not provider billing caps.

**What to change.** Raise the ceiling where it was approved (the plan envelope,
or the `Budget.layer` policy), or switch `onExceeded` to `warn` to journal and
proceed. If capacity is temporarily reserved, let those calls settle before
retrying a `fail` refusal. `Budget.usageOf(runId)` reads actual spend, excluding
reservations.

## Budget.Skipped

**What happened.** The run's budget declared `skip-remaining` and an earlier
step already broke it. The latch is permanent for the run, and this failure
carries the `BudgetExceeded` it latched on. No retry can change the answer.

**What to change.** This is a verdict, not a transient failure. Build retry
policies through `Budget.neverRetrySkipped` so a ladder gives up on the first
refusal instead of re-dispatching the step. To let the run continue, raise the
ceiling and restart it.

## Budget.AccountingUnavailable

**What happened.** The budget could not account the run, so it will not say
what the run may spend. `phase: "record"` means a usage record or clock zero
could not be written; `phase: "recover"` means the run's ledger could not be
read, did not decode, or holds more than `recoveryEntries` journal entries.
Recovery also refuses to flush from inside a journal transaction. An account
with pending usage, active operations, or no durable journal cannot be evicted;
when every cache slot is pinned, admitting another run fails closed.

**What to change.** This fails closed on purpose: the run's spend is unknown,
not zero. Fix the journal (space, permissions, connectivity), or raise
`recoveryEntries` for a genuinely long run. If a sealed result exists, a
`record`-phase failure can be repaired by re-dispatching: the result replays
without another provider call. An unsealed capacity failure or interruption
has no such result; a fresh provider retry must not be used to repair its
pending usage write.
Run initial recovery outside transactions. If the cache is full, finish active
calls or retry their pending writes; increase `maxRuns` for the intended
concurrency or number of memory-only runs.

## A quota refusal propagates instead of parking

**What happened.** One of three things: the composition bound
`QuotaPolicy.layerUnclassified()`, the refusal's deadline was beyond
`maxWaitMillis` (default one hour), or the refusal was not quota-shaped
(`rate_limited`, a dated `quota_exceeded`, or HTTP 429). An exhausted balance,
a bad key, and a model the provider does not serve are terminal: they fail on
the attempt that earned them rather than parking.

**What to change.** Bind `QuotaPolicy.layerDefault()` and raise
`maxWaitMillis` if the provider's windows are genuinely long. A run that parks
more than `Host.maxQuotaParks` times on one ask (default 8) reports the
refusal: a window still closed after its own deadline eight times is not one a
run waits out forever.

## ApprovalUnavailable

**What happened.** A cell called `ask` on a host with nobody to ask. This is a
catchable refusal, not a park: the binding turns it into an ordinary call
failure the cell can route around.

**What to change.** For a run that should wait for a person, the host fails the
gate with a `HarnessError` carrying a `Permission.PermissionRequired`, or
intercepts the call in `Agent.Options.authorize`; `AgentSession` does this
through the control plane. TUI and `smthrs serve` hosts forward
`approvalChannel: true` to both whole agents and `AgentAction` steps. Custom
compositions set `AgentAction.Host.approvalChannel`. For an unattended run, leave `approvalChannel`
false: its `park` transitions are refused and answered in-frame rather than
left waiting on an operator who is not there.

## HarnessError: no cell-call runner is configured

**What happened.** A cell issued `ctx.call` and the `FlowEngineLike` port was
built without a `calls` runner, so there is nothing to execute the flow.

**What to change.** Build the port through `Agent.run`, which always wires a
runner, or pass `calls` to `FlowEngineLike.make` directly. The sibling refusal,
"has a module body; only prompt flows run on the agent", means `AgentSession`
was asked to execute a module-backed flow.

## HarnessError: the agent action ended without a completed answer

**What happened.** The event stream ended without a `complete` transition: the
model never called `ctx.done`, and the loop stopped for another reason (a frame
cap, an abort).

**What to change.** Read the run's trail for the stop reason. If it is
`maxFrames`, raise it on the step or the host; if a discipline cap fired, the
demand records say which one and why.

## The sandbox failed to build

**What happened.** `Agent.layerDefaults` failed with a `SandboxError`, most
often because the runtime refuses to compile WebAssembly from bytes, as
Cloudflare's workerd does.

**What to change.** Use `Agent.layerDefaultsWithVariant` over the QuickJS build
the host names, and provide `QuickJSSandbox.layerVariant(variant)` beneath it,
building the variant from a `.wasm` module import.

## ChildError

**What happened.** A detached child operation failed catchably:
`unsupported` (this host runs no detached children, or there is no running flow
to attach one to), `not_found` (the flow is not in the `EngineChildren` list,
no such child run exists, or the id names a run outside the calling run's own
children), or `failed` (the child never started, was cancelled, failed, or
handed its lineage to a new execution id).

**What to change.** For `not_found` on spawn, add the flow to
`EngineChildren.layer({ flows })` and register it with the runtime. For
`failed`, the message carries the child's rendered cause, bounded to 2,048
characters. Two concurrent children of one flow need two labels: the label is
the child's identity within the parent. For `not_found` on `await` or `send`,
check the id: a run reaches only ids under its own `${executionId}/child/`
prefix, which is what the refusal message names, so an id copied from another
run is refused whether or not that run exists.

## checkpoint_unsupported and checkpoint_unavailable

**What happened.** A cell call named a checkpoint and could not run against
one: the flow names what it touches rather than where it runs, the path was
absolute or climbed out of the tree with `..`, the store could not check the
tree out, or the host pins no trees at all.

**What to change.** The refusal messages name the remedy: take the reading with
a shell call at the same checkpoint, name the path relative to the repository
root, or drop `at` to read the live tree on purpose. A host that should pin
trees provides a `Checkpoints` store; see
[Isolate and observe a run's workspace](/guides/workspace/).

## A sink stalls the run

**What happened.** An `EventSink.emit` waited on a durable write. `emit` runs
inside the frame that produced the event, and that frame holds the engine's
write transaction, so the sink waits on a writer that is waiting on the sink.

**What to change.** Make the sink push onto a queue, write to a socket, or
resolve a deferred. Never journal from `emit`. The same rule is why
`AgentSession` buffers its trail and flushes it from a fiber of its own.

## Duplicate capability names fail composition

**What happened.** Two entries in the run's catalog (declared `flows` plus
plugin `cellFlows` contributions) declared the same flow name. Composition
fails rather than dispatching one descriptor to another implementation.

**What to change.** Rename one capability, or order the conflict away with a
plugin's `enforce: "pre" | "post"` and a `cellFlows` hook that transforms the
list deliberately.

## A wait is refused

**What happened.** A cell called `wait` with more seconds than the host's
ceiling, or a non-finite value. The default ceiling is one hour;
`StandardFlows.clock(services, { maxSeconds })` may only lower it, and a
non-finite or larger configured value is clamped back to the default.

**What to change.** Retry with a smaller value, as the refusal message says. A
host that means "no waiting" sets `maxSeconds` at or below zero.
