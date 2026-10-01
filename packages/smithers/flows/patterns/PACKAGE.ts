import { BuildAndCheckTypeScriptPackage } from "@smthrs/repo-targets"
/** Standard package targets plus package-owned documentation generation. */
import { Smithers } from "@smthrs/targets"

const cwd = "packages/smithers/flows/patterns"

const { check, circular, docs, docsFiles, fmt, lib, lint, test } = BuildAndCheckTypeScriptPackage({
  deps: [],
  cwd
})

// Pure orchestration combinators over @smthrs/flow. Member flows are often
// model agents, so every decision value (approval, review verdict, plan, task
// list, item id) is untrusted model output; the checks below say so per threat.
const securityReview = Smithers.SecurityReview({
  cwd,
  include: ["src/**"],
  checks: [
    {
      id: "approval-fails-closed",
      title: "A gated step runs only after a decision that decodes as the literal \"approved\"",
      threat:
        "A model or approver output that is a denial, malformed, or missing lets a write, deploy, or critical runbook step run without human consent.",
      lookFor: [
        "A path in WithApproval, Intervene, or Runbook where apply or the inner flow is reached before or without decoding the approval output as WithApproval.Approved.",
        "Runbook.run with onDeny \"skip\" or \"fail\" treating a thrown or undefined approval result as approval, or a risky/critical step called without an approval call.",
        "Intervene with dryRun true still calling apply, or make and run disagreeing on whether apply is reachable."
      ],
      paths: ["src/WithApproval.ts", "src/Intervene.ts", "src/Runbook.ts"]
    },
    {
      id: "accepted-decision-strict",
      title: "Review and escalation verdicts accept only the exact approved shapes",
      threat:
        "A reviewer model returning prose, a truthy non-boolean, or an inherited property settles a review, delegation, or escalation that should have been rejected.",
      lookFor: [
        "Compose.accepted accepting anything beyond true, \"approved\", or an own approved/accepted property strictly equal to true.",
        "Escalation.defaultEscalate settling a result that reports failure through error, failed: true, or ok: false.",
        "A ReviewLoop, DelegationChain, or Escalation call site that re-implements acceptance with truthiness instead of calling Compose.accepted.",
        "A stop verdict (Supervisor allDone, Loop done, ScanFixVerify resolved, DriftDetector drifted) read with the `in` operator, which admits an inherited property, instead of Object.hasOwn plus strict equality to true."
      ],
      paths: [
        "src/internal/Compose.ts",
        "src/ReviewLoop.ts",
        "src/DelegationChain.ts",
        "src/Escalation.ts",
        "src/Supervisor.ts",
        "src/Loop.ts",
        "src/ScanFixVerify.ts",
        "src/DriftDetector.ts"
      ]
    },
    {
      id: "decorator-envelope-no-widening",
      title: "A decorated or composed flow never declares fewer capabilities or effects than the flows it calls",
      threat:
        "A flow author wraps a privileged flow (or adds an approval/cache member) so the composite's declared capabilities and effect envelope hide what actually runs, bypassing policy checks keyed on those declarations.",
      lookFor: [
        "Decorate or a decorator (WithApproval, WithRetry, WithCache) copying only the inner flow's capabilities while its body also calls a separately supplied flow such as the approval flow.",
        "Compose.intersectCapabilities or intersectEffects used where a union of called members is required, or an envelope_conflict check that can be skipped when the template declares none."
      ],
      paths: [
        "src/internal/Decorate.ts",
        "src/internal/Compose.ts",
        "src/WithApproval.ts",
        "src/WithRetry.ts",
        "src/WithCache.ts"
      ]
    },
    {
      id: "model-output-bounds",
      title: "Plans, task lists, and rounds derived from model output stay within declared bounds",
      threat:
        "A planner or boss model returns an oversized plan, deep tree, or endless revise loop and burns another tenant's shared model budget or runner capacity.",
      lookFor: [
        "Supervisor, Trellis, DelegationChain, Recursion, or MapReduce iterating a model-returned task or leaf list without a maxDepth, maxRounds, or width cap checked before dispatch.",
        "Supervisor.run dispatching every task the boss plan returns with no cap on the task count, so one plan multiplies worker calls by maxRounds.",
        "Trellis running a model-authored parallel node with concurrency \"unbounded\" where fuel does not bound the leaves started at once.",
        "Loop, Optimizer, ReviewLoop, or Stalling where run can exceed the round count make declares, or a bound accepting non-safe-integer or Infinity values.",
        "Bounded or MergeQueue concurrency admitting 0, negative, NaN, or unbounded widths.",
        "Burndown launching more items than concurrency or capacity slots allow, or a lineage that continues past maxRounds."
      ],
      paths: [
        "src/Supervisor.ts",
        "src/Trellis.ts",
        "src/DelegationChain.ts",
        "src/Recursion.ts",
        "src/MapReduce.ts",
        "src/Loop.ts",
        "src/Optimizer.ts",
        "src/ReviewLoop.ts",
        "src/internal/Stalling.ts",
        "src/Bounded.ts",
        "src/MergeQueue.ts",
        "src/Burndown.ts"
      ]
    },
    {
      id: "untrusted-key-records",
      title: "Records keyed by model- or input-supplied ids cannot collide with prototype or protocol keys",
      threat:
        "An item id, task id, or worker type such as __proto__ or constructor supplied by a model routes work to the wrong worker, overwrites another item's result, or pollutes a prototype.",
      lookFor: [
        "A lookup like routes[task.workerType] or members[name] without Object.hasOwn, or a record built by assignment from input ids instead of Object.fromEntries or a null-prototype object.",
        "Quarantine or Sidecar outcome envelopes where a member's own value can be mistaken for the Quarantined or Succeeded protocol tag."
      ],
      paths: [
        "src/Kanban.ts",
        "src/Supervisor.ts",
        "src/Panel.ts",
        "src/Bounded.ts",
        "src/Quarantine.ts",
        "src/Sidecar.ts",
        "src/CheckSuite.ts",
        "src/Burndown.ts"
      ]
    },
    {
      id: "cache-key-isolation",
      title: "A cached result is served only for the same inputs, version, and scope",
      threat:
        "A run in one repository or account receives another run's cached model or tool output because WithCache or a pattern leaves input, version, or scope out of key material.",
      lookFor: [
        "WithCache accepting a scope wider than the caller asked for, or a blank version or non-positive ttlMs.",
        "A pattern that captures caller options by reference so a later edit changes key material or bypasses validation (DriftDetector, Kanban, Loop, MergeQueue snapshots)."
      ],
      paths: ["src/WithCache.ts", "src/DriftDetector.ts", "src/Kanban.ts", "src/Loop.ts", "src/MergeQueue.ts"]
    }
  ]
})

export const Package = Smithers.Package({
  targets: { check, circular, docs, docsFiles, fmt, lib, lint, test, ...securityReview }
})
