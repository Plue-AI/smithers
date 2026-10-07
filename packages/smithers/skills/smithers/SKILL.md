---
name: smithers
description: >
  Drive Smithers durable flows for ordered agent stages, retries, approvals,
  bounded loops, and crash-safe work. Run existing flows or author TypeScript
  flows with Flow.make, Action.make, and Effect v4. If SMITHERS_INSIDE_RUN is
  set, do the assigned step directly; never launch or steer another run.
---

# Smithers

A flow is ordinary TypeScript built from `Flow.make`, `Action.make`, and
Effect. Completed actions are recorded; recovery resumes at the frontier.
Use Effect `4.0.0-rc.115` and the Smithers 1.0 APIs. Read the owning package's
README and docs before authoring. Never use JSX or 0.x APIs.

## Rule 0: if you are already inside a run, do not use Smithers

Check `SMITHERS_INSIDE_RUN` before routing. If set, you are a worker executing
one step. Do the assigned work with your ordinary tools and finish your turn.
Never launch, steer, or poll another run from inside that step. Declare a
`HumanTask` in the flow when a person must decide; do not improvise orchestration
from inside an agent.

## Route first: not every ask needs a flow

1. Clarify missing acceptance criteria before building.
2. Handle one clear goal directly, however large.
3. Use a flow for ordered stages with real gates, durability, approvals,
   bounded loops, or reusable work.
4. Run an existing flow before writing another.

## The mental model

**Flow.** A tagged durable program with payload, success, and error schemas.
Its body builds a plan; effects belong in action implementations.

**Action.** A named recorded side effect. Declare it with `Action.make` and
attach its implementation with `Declared.toLayer`.

**Node.** The plan-time graph from `@smthrs/plan`. Compose nodes with `Node.map`,
`Node.andThen`, `Node.bindPlanned`, `Node.branch`, and `Node.all`.

**Plan.** The compiled graph and approval envelope. Planning executes authoring
callbacks; it does not sandbox untrusted JavaScript.

**Step key.** Persisted identity derived from declarations, dependencies, and
callback captures. Change meaning deliberately; keep secrets out of payloads
and captures.

## Sixty seconds to the aha

```sh
smthrs flow list
smthrs flow plan hello --data '{"name":"world"}'
smthrs flow start hello --data '{"name":"world"}' --json
smthrs runs show <run-id>
smthrs runs logs <run-id> --follow
```

Read the run ID from the receipt. Admission is not completion. Check the run's
actual result before reporting success. Use `smthrs <command> --help` or
`--schema` for the installed command contract.

## The flow directory

Put a file flow at `flows/<name>/flow.ts`. Default-export a literal tagged
`Flow.make("<name>", { description, capabilities, effects, payload, success,
error?, body })` from `@smthrs/flow`. Discovery reads metadata without executing
that module. Keep metadata literal; helpers and computed metadata can hide an
entry from discovery.

Export action implementations as the optional named `layer`: use
`Declared.toLayer`, `AgentAction.layer`, or `Layer.mergeAll`. The local CLI/TUI
host composes that layer with FileSystem, Path, ChildProcessSpawner, HttpClient,
and agent services (#2923). Export implementations directly; the host owns
`Action.Implementations`. Acquire extra dependencies during layer construction
so missing services are refused at load.

## Authoring checklist (learned from real flows)

- **Wire system actions explicitly.** `Sleep.action`, `WaitFor.action`, and
  `HumanTask.action` carry no compile-time implementation requirement. Merge
  the corresponding `Sleep.layer`, `WaitFor.layer`, and `HumanTask.layer` into
  your implementations unless your host already provides them. A missing
  handler is refused as `unresolved_action`: `Action "system/sleep" has no
  implementation`.
- **Export the implementation layer.** A discovered `flow.ts` may
  `export const layer = Layer.mergeAll(...)`. Include declared action layers
  and `AgentAction.layer`; use the host services above rather than rebuilding
  the host (#2923).
- **Separate admission from completion.** On the durable engine,
  `Flow.start` and `Flow.ensure` return after admission and scheduling; the
  child runs detached (#2932). Give each logical launch a stable `ensure` key
  that includes its round or execution component. Reuse it only for retries
  of the same payload; different payloads raise `ExecutionIdentityConflict`.
  Fan out with `Effect.forEach(items, launch, { concurrency })`; wrap each
  launch in `Effect.exit` so one refusal does not fail the batch. Retain exits
  and execution IDs; inspect completion separately.
- **Declare the real capability envelope.** Grant only what the flow uses,
  for example `["fs:read:**", "fs:write:**", "proc:spawn:*", "net:get:*",
  "net:post:*", "model:call:*"]`. `smthrs flow start` refuses to auto-approve
  `["*"]`.
- **Capture callback meaning.** Wrap bodies, branch predicates,
  `Node.bindPlanned` builders, and other persisted callbacks in `Node.capture`.
  Declare every semantic closed-over value and an explicit version for
  imported behavior. Bump the version when topology or meaning changes; plan
  a new run. Captures must be inert data, not service or function objects.
- **Type recursive handoffs.** Give a flow that hands off to itself through
  `.to` an explicit `Flow.Flow<...>` annotation to break recursive inference.
  For discovery, put the typed loop beside a literal
  `export default Flow.make(` entry that hands off to it. Keep the entry's
  description, capabilities, effects, payload, and success literal. Register
  the loop's interpreter in the exported layer.
- **Pin subscription seats.** Use `<seat>@<account>`, such as
  `claude-code:opus@claude-9` or `sol@codex-3`. Check the selected login;
  never accidentally send subscription work through a paid API route.
  Unpinned Claude aliases select the API when an Anthropic key is available;
  explicit `claude-code:` seats refuse an unavailable subscription rather
  than falling back to a key.
- **Treat unavailable observations as unavailable.** A 429 from a usage
  read is not evidence that execution quota is exhausted. Keep the last good
  reading with its original age; distinguish stale or unknown capacity from
  measured exhaustion. Retry observations without turning a throttled read
  into a hard stop or authorizing new work from unknown capacity.
- **Size local heartbeats for load.** `CommandSandbox` defaults to 15 seconds;
  each probe times out after twice that interval, and two silent probes fail
  the command. Loaded hosts can delay probes and kill healthy commands.
  Configure `heartbeat` for local placements; prefer remote placement for
  fleets.
- **Freeze a long-lived host's source.** Run it from a frozen checkout, such
  as a tarball of main plus fixed overlays, never a shared checkout agents
  edit. In a source checkout `smthrs` loads source even if `dist` exists;
  half-written modules can fail startup or body loading, and source drift is
  refused. Keep the host source fixed for its lifetime.

## Durability, retries, and waits

Keep clocks, filesystem reads, network calls, and other effects inside actions.
Use `Sleep.action` for a planned timer, `WaitFor.action` for a durable wait,
and `HumanTask.action` for a person's decision. Register their layers.
Use `@smthrs/patterns` before hand-rolling familiar topology. Give irreversible
work an idempotency strategy before retrying it; no retry rolls effects back.

## Operating a run

Read state before acting. On failure, inspect `smthrs runs show <run-id>`, then
the events if needed. Fix the cause before retrying. Preserve failed launch
receipts, cancellation, and completion evidence. Report the result, the run ID,
and the next action in a few words; never call an accepted launch completed.

Use `smthrs environment` for persistent local, SSH, or Cloud locations.
Tools manage their own login in the selected home; profiles describe locations.

## Recovery and completion gates

- Track admission, running, READY, verified and landed as separate receipts.
  READY work is pending until its queue drains; filtered or claimed open work
  is not completed. Require current evidence for final classifications.
- Retain assignment, result, claim owner and failure evidence across quarantine
  and restart. Repair uses a new execution identity without stealing claims.
- Unknown quota is not exhausted quota. Retry unavailable observations without
  authorizing launches beyond computed account ceilings.
- Unknown worker status preserves running work and held claims; only a verified
  missing execution permits recovery. Reject malformed recovery identities at admission.
- Resolve compatible helpers from immutable host source or explicit configuration.
- Verify before rebase and verify the final candidate again. Parse structured
  final reports rather than incidental tool text. Preserve meaningful errors
  and cancellation receipts through every recovery transition.

## Commands

- `smthrs agent` — run. Configure an agent
- `smthrs agent edit` — confirm; waits for the person's confirmation. Propose an instruction change
- `smthrs agents` — run. The factory's agents
- `smthrs branch show` — run. Open a branch's card
- `smthrs branch add-to-stack` — confirm; waits for the person's confirmation. Add a scratch branch as a TODO
- `smthrs branch archive` — confirm; waits for the person's confirmation. Archive a scratch branch
- `smthrs branch fork` — run. Fork a scratch branch
- `smthrs branch rebase` — run. Rebase this branch now
- `smthrs branches` — run. List branches with presence
- `smthrs diff` — run. Show a branch's changes
- `smthrs file` — run. Open and co-edit a file
- `smthrs files` — run. Browse a branch's files
- `smthrs flow show` — run. Show a flow's steps and versions
- `smthrs flow edit` — confirm; waits for the person's confirmation. Propose a change to a flow
- `smthrs flow new` — confirm; waits for the person's confirmation. Create a new flow
- `smthrs flow plan` — run. See what a flow would run
- `smthrs flow run` — run. Run a flow with typed input
- `smthrs flow source` — run. Co-edit a flow's source
- `smthrs flows` — run. List the repository's flows
- `smthrs github` — run. Show sync status and retry
- `smthrs issue show` — run. Open an issue's card
- `smthrs issue comment` — confirm; waits for the person's confirmation. Comment on an issue
- `smthrs issue new` — confirm; waits for the person's confirmation. Open a GitHub issue
- `smthrs issues` — run. List the repository's issues
- `smthrs merge` — confirm; waits for the person's confirmation. Review and merge the next item
- `smthrs monitor` — run. Every run, with its debug view
- `smthrs pr` — run. Open a pull request's card
- `smthrs review` — confirm; waits for the person's confirmation. Review a change, return findings
- `smthrs runs show` — run. Open a run's card
- `smthrs run inspect` — run. Open a run's monitor
- `smthrs runs list` — run. Active and attention-needing runs
- `smthrs search` — run. Search code, wiki and runs
- `smthrs stack` — run. Show the stack and background runs
- `smthrs stack move` — run. Reorder an item
- `smthrs todo show` — run. Open a TODO
- `smthrs todo amend` — confirm; waits for the person's confirmation. Change an unmerged TODO's prompt
- `smthrs todo answer` — run. Answer the agent's question
- `smthrs todo drop` — confirm; waits for the person's confirmation. Abandon an unmerged TODO
- `smthrs todo from-issue` — confirm; waits for the person's confirmation. Draft a TODO from an issue
- `smthrs todo new` — confirm; waits for the person's confirmation. Write and place a TODO
- `smthrs todo resume` — run. Resume a paused TODO
- `smthrs todo retry` — run. Retry a failed TODO
- `smthrs todo steer` — run. Send the agent a correction
- `smthrs todo stop` — run. Pause a working TODO
- `smthrs wiki show` — run. Open the wiki
- `smthrs wiki page` — run. Open or create a page
- `smthrs wiki save` — run. Save this answer as a page
