import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd: "packages/smithers/agent",
  testData: ["docs/quickstart.md"],
  tests: Smithers.glob("test/**/*.test.ts", { exclude: ["test/faults/**"] })
})

/**
 * The package's fault-injection cases.
 *
 * A package opts into the matrix by declaring this key, so
 * `//packages/...:faults` is the whole matrix and nothing central lists which
 * packages are in it. The tier is separate from `test` because its cases are
 * machine-global — they kill process groups, bind ephemeral ports, and read
 * the process table — so they run serially, without coverage, from
 * `vitest.faults.config.ts`.
 */
const faults = Smithers.FaultSuite({ cwd: "packages/smithers/agent" })

/**
 * Security review: `security` reviews the diff against origin/main and
 * `securityAudit` audits every owned source file. Nested packages
 * (registry, harness, fs, ...) declare their own.
 */
const securityReview = Smithers.SecurityReview({
  cwd: "packages/smithers/agent",
  include: ["src/**"],
  checks: [
    {
      id: "flow-store-confinement",
      title: "A saved flow is written only under flows/<id>/ inside the store root",
      threat:
        "A model-driven cell writes or overwrites files outside the flows root on the host checkout, such as package sources or CI config.",
      lookFor: [
        "An id or file key reaching FlowStore.write that is not checked against idPattern and validatePath before any filesystem call.",
        "A symlink segment created between validateConfinement and fs.rename that redirects the publish outside the root (TOCTOU).",
        "makeMemory or a custom store accepting file keys outside flows/<id>/ because only the id is validated.",
        "Rollback or generation cleanup removing a path that was not staged by this save."
      ],
      paths: ["src/FlowStore.ts", "src/PromoteFlows.ts"]
    },
    {
      id: "promoted-flow-activation",
      title: "Model-written flow source never becomes executable without an approval pinned to its digest",
      threat:
        "A prompt-injected run writes a flow with broad capabilities and invokes it on the next frame, escalating from its own attenuated envelope to whatever the new flow declares.",
      lookFor: [
        "flows/write-flow followed by Registry.refresh making the new flow model-invocable in ctx.flows with no human approval step.",
        "A saved flow's declared capabilities not intersected with the writing run's capability ceiling when it is later invoked.",
        "Executable module loading that runs a flow whose content digest differs from the approved execution digest."
      ],
      paths: ["src/PromoteFlows.ts", "src/Agent.ts", "src/AgentSession.ts", "src/CellPlugin.ts"]
    },
    {
      id: "capability-envelope-attenuation",
      title: "Every run, module child and memory bank access stays inside the approved plan envelope",
      threat:
        "A launched flow or its cells use capabilities, flows or memory banks the operator never approved for that run.",
      lookFor: [
        "A code path that runs a flow body or executable module without CapabilitySet.attenuate(patterns(card.envelope.capabilities)).",
        "patterns() or a markdown flow default of `*` widening authority to *:** when a flow declares no capabilities.",
        "Memory recall or remember reaching a bank without memoryAuthority or the supervisor ceiling check.",
        "registry.loadBody or approvedModule executed without re-checking the approved execution digest after the registry changed."
      ],
      paths: ["src/AgentSession.ts", "src/Agent.ts", "src/AgentAction.ts", "src/StandardFlows.ts"]
    },
    {
      id: "ask-approval-binding",
      title: "An in-run ask proceeds only on an Approved decision bound to this run and this exact input",
      threat:
        "A run reuses another run's approval, or a pending or unreadable decision is read as approval, so an irreversible action proceeds without the operator.",
      lookFor: [
        "askIdentity omitting runId or part of the ask input from the digest.",
        "asker or authorize treating Pending, Denied or a read failure as approved.",
        "A flow other than ask able to register or resolve an approval against askEnvelope."
      ],
      paths: ["src/AgentSession.ts", "src/StandardFlows.ts"]
    },
    {
      id: "child-run-isolation",
      title: "agent/spawn, agent/send and agent/await reach only the caller's own children under the caller's ceiling",
      threat:
        "A cell in one run reads another run's result, steers it, or spawns a detached child that outlives the parent with a wider capability ceiling or no budget.",
      lookFor: [
        "ownedByCaller or ownsChild accepting a child id not derived from the calling execution via childExecutionId.",
        "The out-of-run bypass (no FlowInstance) reachable from a model tool call.",
        "A detached child resumed after restart without the parent's attenuated CapabilitySet or budget.",
        "agent/spawn starting a flow not in options.flows."
      ],
      paths: ["src/EngineChildren.ts", "src/ChildFlows.ts"]
    },
    {
      id: "sealed-key-integrity",
      title: "Sealed and cached keys carry no credentials and are never reused across differing authority",
      threat:
        "A run replays another run's cached model or cell result computed under broader capabilities, or a provider credential lands in durable key material.",
      lookFor: [
        "seal or callMaterial folding prepared headers other than publicHeaders, or any API key, into StepKey material.",
        "A sealed key made cross-run reusable when Options.capabilities is undeclared.",
        "The wire-body marker splice producing the same key for two different request bodies."
      ],
      paths: ["src/FlowEngineLike.ts", "src/internal/FlowEngineLike.ts", "src/internal/CallIdentity.ts"]
    },
    {
      id: "checkpoint-relocation",
      title: "A call pinned to a checkpoint reads and writes only the materialized scratch tree",
      threat:
        "A cell names a checkpoint and a path that climbs back into the live tree, reading or writing the user's working copy while its key records a pinned reading.",
      lookFor: [
        "A relocated input path containing `..` or an absolute path rewritten instead of refused with outside().",
        "A flow that names what it touches (not a shell call) run at a checkpoint without the relocation refusal.",
        "The scratch checkout not released when the call fails or is interrupted, leaving pinned trees on disk."
      ],
      paths: ["src/Checkpointed.ts"]
    },
    {
      id: "sandbox-declared-effects",
      title: "A cell call's undeclared reads or writes are discarded before any host state moves",
      threat:
        "A model-authored cell mutates host files outside its declared write set and the change is materialized into the user's workspace.",
      lookFor: [
        "sandbox.materialize reached for an Invalidated outcome or before admission.",
        "workspaceRelative or callBoundary mapping a declared path to one outside the workspace root.",
        "WorkspaceObservation following a symlink or reading file contents, or its prune list hiding real source edits."
      ],
      paths: [
        "src/FlowEngineLike.ts",
        "src/WorkspaceSandbox.ts",
        "src/InMemoryWorkspaceSandbox.ts",
        "src/WorkspaceObservation.ts"
      ]
    },
    {
      id: "spend-ceiling-enforcement",
      title: "Budget reserve runs before every paid model call and cannot be reset by resume or retry",
      threat:
        "A runaway or prompt-injected run spends provider credit past the approved token or latency ceiling, billing the account owner.",
      lookFor: [
        "A model dispatch path in the package that bypasses budget.reserve.",
        "Budget accumulator keyed so that a resumed or retried execution gets a fresh allowance.",
        "QuotaPolicy classifying a provider error so the call is retried unbounded or parked with spend uncounted."
      ],
      paths: [
        "src/Budget.ts",
        "src/RunawayGuard.ts",
        "src/QuotaPolicy.ts",
        "src/FlowEngineLike.ts",
        "src/AgentAction.ts"
      ]
    },
    {
      id: "journal-secret-redaction",
      title: "Model prose, steering text and memory writes pass secret redaction before they are persisted",
      threat:
        "A key the model read from the workspace is written in clear into the durable journal or long-lived memory readable by other operators or runs.",
      lookFor: [
        "A journal.emit or trail payload carrying model text, tool output or steer messages under a field name the redactor does not scan.",
        "supervisorMemory or MemorySnapshotRecorder writing a sentence without redaction.",
        "Fields renamed (spent, generation params) to dodge redaction that could still carry secret values."
      ],
      paths: ["src/AgentSession.ts", "src/Agent.ts", "src/EventSink.ts", "src/MemorySnapshotRecorder.ts"]
    },
    {
      id: "seat-routing-injection",
      title: "Task text can pick only among the seats and system variants the plan approved",
      threat:
        "Attacker-controlled task text steers Jev to a seat or model outside the approved set, or to an edit variant for a read-only run.",
      lookFor: [
        "SeatRouter or routeSeat accepting a routed seat id not in approvedSeats.",
        "A system-prompt variant choice that changes capabilities rather than only prompt text.",
        "ScriptedJudge answers reachable in production composition."
      ],
      paths: ["src/SeatRouter.ts", "src/SeatResolver.ts", "src/Seat.ts", "src/AgentAction.ts", "src/ScriptedJudge.ts"]
    },
    {
      id: "smithers-plugin-ports",
      title: "smithers.run and smithers.inspect reach only runs and flows the calling run may see",
      threat:
        "A model in one run inspects another user's run output or launches arbitrary project flows through the plugin ports.",
      lookFor: [
        "smithers.inspect forwarding a caller-supplied id to ports.inspect with no ownership check in the binding.",
        "smithers.run declaring no capabilities, so the envelope never gates which flow it starts.",
        "Port error messages returned to the model that expose host paths or credentials."
      ],
      paths: ["src/SmithersPlugin.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, faults, fmt, lib, lint, test, ...securityReview }
})
