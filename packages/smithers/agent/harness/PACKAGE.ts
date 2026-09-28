import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/agent/harness"

const standard = BuildAndCheckTypeScriptPackage({ cwd })

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = standard

const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "cell-realm-escape",
      title: "Agent-authored cell code reaches the host only through the four prelude bridges",
      threat:
        "A model or a prompt-injected repository file writes a cell that runs code in the host process and reads the user's credentials or files.",
      lookFor: [
        "A host function installed with context.newFunction or setProp other than __call, __checkpoint, __print and __intent, or one left on globalThis after the prelude runs.",
        "A bridge callback that returns a host object, function or handle to the realm instead of JSON rebuilt by handleFromJson.",
        "A cell-controlled value (flow name, input, at, print parts, intent payload) passed to host eval, dynamic import, Function or a property lookup on a host object without JSON decoding.",
        "The ctx and console globals becoming writable or configurable, so a cell can replace ctx.call for later cells."
      ],
      paths: ["src/QuickJSSandbox.ts", "src/Sandbox.ts", "src/CellValidation.ts"]
    },
    {
      id: "realm-resource-limits",
      title: "Memory, step, time and print budgets bound every cell and every bridged flow result",
      threat:
        "A looping or allocating cell exhausts the host's memory or CPU and takes down every run sharing the process.",
      lookFor: [
        "A path where runtime.setMemoryLimit or the interrupt handler is skipped, or where an explicit limit a binding cannot enforce is silently ignored instead of failing unsupported.",
        "Host-side copies of print or intent payloads that are parsed before the printRetainedBytes ceiling is checked.",
        "A flow result materialized into the realm without the payloadBytes estimate, or a deep JSON payload whose handle building can overflow the host stack uncaught.",
        "Proxy or another getter-driven intrinsic available to cells that makes the variables-panel memory probe under-report held bytes."
      ],
      paths: ["src/QuickJSSandbox.ts", "src/Sandbox.ts", "src/VariablesPanel.ts"]
    },
    {
      id: "flow-call-authorization",
      title: "A cell can dispatch only model-invocable flows inside the run's capability envelope",
      threat:
        "A model calls a withheld, non-model-invocable or out-of-envelope flow and writes files, runs commands or spends money the run was not granted.",
      lookFor: [
        "A dispatch path in callHandler or CellCalls.make that runs a flow before the unknown_flow, flow_withheld, modelInvocable and CapabilitySet.allows checks.",
        "A capability string that Capability.parse rejects being treated as allowed rather than refused.",
        "A declaration digest mismatch between the catalog the model saw and the registry entry that runs, or a binding dispatched when its digest differs from the registry descriptor.",
        "A catalog refresh (openFrame nextCatalog) or discovered flow list that adds entries without the modelInvocable filter."
      ],
      paths: ["src/CellTurn.ts", "src/CellCalls.ts", "src/FlowBinding.ts"]
    },
    {
      id: "write-guards",
      title: "Writes are refused at checkpoints and when fed truncated flow output",
      threat:
        "A model overwrites a user's file with a truncated fragment, or mutates a pinned checkpoint tree the user expected to stay read-only.",
      lookFor: [
        "mutating() missing a write declared somewhere other than descriptor.effects.writes or input.writes, so a writing call skips the truncated_write and checkpoint refusals.",
        "TruncatedOutput.reuse matching that a trivial re-encoding of the fragment (whitespace, JSON escaping) evades.",
        "An at option accepted by Cell.checkpointOf that does not name a checkpoint this run minted."
      ],
      paths: ["src/CellTurn.ts", "src/TruncatedOutput.ts", "src/Cell.ts"]
    },
    {
      id: "prompt-injection-boundary",
      title:
        "Tool output, flow descriptions, skills and compaction summaries reach the model only inside escaped untrusted-data blocks",
      threat:
        "A repository file or third-party flow description injects instructions that the model follows as if they came from the user, exfiltrating code or widening its actions.",
      lookFor: [
        "Text derived from cell prints, flow results, flow or skill descriptions, or compaction summaries inserted into a model message without untrustedData().",
        "An untrustedData escape that misses a character sequence which closes the </untrusted-data> block or forges a Provenance line.",
        "A steering, monitor or notification message built from external content and sent with system or user authority."
      ],
      paths: [
        "src/internal/untrustedData.ts",
        "src/internal/cellPrompt.ts",
        "src/internal/printsObservation.ts",
        "src/CallLedger.ts",
        "src/NarrowedCheck.ts",
        "src/Compaction.ts",
        "src/Relevance.ts",
        "src/Supervisor.ts",
        "src/Steering.ts",
        "src/Monitor.ts",
        "src/Notifications.ts",
        "src/CellTurn.ts"
      ]
    },
    {
      id: "replay-key-integrity",
      title: "A journaled boundary replays only for the same cell source, call input, declaration and live tree",
      threat:
        "A resumed or later run replays a stale flow or model result over a changed workspace or input, so the agent acts on data the user has since changed.",
      lookFor: [
        "A boundary or step key that omits the invocation input, the declaration digest, the frame ordinal or the live-tree digest.",
        "A replayed outcome returned without re-checking the capability envelope or withheld-flow state that applied when it was recorded."
      ],
      paths: ["src/CellTurn.ts", "src/Cell.ts", "src/internal/frame.ts", "src/EngineLike.ts"]
    },
    {
      id: "completion-gate-bypass",
      title: "ctx.done cannot complete a run that its completion gates refuse",
      threat:
        "A model claims success over failed calls or unverified work and the user merges or deploys a change the harness should have blocked.",
      lookFor: [
        "A path from the __intent done payload to a successful run outcome that skips the CompletionClaim, UnresolvedFailure, FailedCall, UnmovedTree or VacuousVerification demands.",
        "A judgement or classifier failure that resolves as allowed rather than as a typed refusal."
      ],
      paths: [
        "src/CompletionClaim.ts",
        "src/Judgement.ts",
        "src/UnresolvedFailure.ts",
        "src/FailedCall.ts",
        "src/UnmovedTree.ts",
        "src/VacuousVerification.ts",
        "src/Sufficiency.ts",
        "src/CellTurn.ts"
      ]
    },
    {
      id: "journal-credential-leak",
      title: "Agent events and transcripts carry no provider credential or raw secret-bearing cause",
      threat:
        "Anyone who can read a run's journal or transcript recovers the user's model API key or a secret a flow handled.",
      lookFor: [
        "An AgentEvent, Transcript or EngineLike field populated from a signed request, header set or raw error cause rather than the credential-free prepared request.",
        "A flow handler cause or print buffer persisted verbatim without the redaction FlowBinding documents."
      ],
      paths: [
        "src/AgentEvent.ts",
        "src/Transcript.ts",
        "src/EngineLike.ts",
        "src/FlowBinding.ts",
        "src/HarnessError.ts"
      ]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
