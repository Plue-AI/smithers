/**
 * Deliver the cleaned request. Through the backend: append it to main under
 * the existing landing policy, or, when the repository's declared GitHub
 * policy is `send-upstream`, open its GitHub pull request for a maintainer to
 * merge. Without the backend (`local-landing.ts`): fast-forward main to the
 * one verified candidate commit, or push the candidate and open its GitHub
 * pull request, which GitHub's required checks and branch protection decide.
 */
import { Action, Flow, FlowRuntime, Interpreter, Poll } from "@smthrs/flow"
import { Node, type Planned } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import {
  AppendObservation,
  AppendPreparation,
  Delivery,
  LandingCandidate,
  LandingIdentity,
  LocalPull,
  PullChecks,
  QueuedAppend
} from "./landing-schema.ts"
import { Landing, requireBackend } from "./landing.ts"
import { requestIdFor } from "./native.ts"
import { type Check, CodingError, type Implementation, Receipt } from "./schema.ts"
import { verifySummary } from "./verify-schema.ts"
import { ReadLander } from "./vibe-lander.ts"
import { PublishVibeSource } from "./vibe-publication.ts"
import {
  cleanedTipRefusal,
  VibeCleanup,
  VibeDelivered,
  VibeFastForwarded,
  VibeLanded,
  VibeProposed,
  VibePullRequested,
  VibeSubmitted
} from "./vibe-schema.ts"
import { RunCheck } from "./workflow.ts"

const invalid = (message: string) => new CodingError({ code: "invalid_receipt", message })
/** Existing landing policy runs in Plue's worker; this bound covers full-history inspection. */
const observationIntervalMs = 10_000, observationAttempts = 90
const Unobserved = Schema.Struct({ status: Schema.Literal("unobserved"), reason: Schema.String })
const Observed = Schema.Union([AppendObservation, Unobserved])

/** Only send-upstream repositories hand results to an active mythical stack. */
const ReadStack = Action.make("coding/read-vibe-stack", {
  payload: { cleanup: VibeCleanup },
  success: Schema.Boolean,
  error: CodingError,
  nondeterministic: true
})
const SubmitLane = Action.make("coding/submit-vibe-lane", {
  payload: { cleanup: VibeCleanup, cleanedSource: PublishVibeSource.successSchema },
  success: VibeSubmitted,
  error: CodingError,
  nondeterministic: true
})
/** Recorded once, so a restart never switches an in-flight request to the other delivery. */
const ReadDelivery = Action.make("coding/read-vibe-delivery", {
  payload: { cleanup: VibeCleanup },
  success: Delivery,
  error: CodingError,
  nondeterministic: true
})
const OpenPull = Action.make("coding/open-vibe-pull", {
  payload: { cleanup: VibeCleanup, cleanedSource: PublishVibeSource.successSchema, landing: LandingIdentity },
  success: VibeProposed,
  error: CodingError,
  nondeterministic: true
})
const PrepareAppend = Action.make("coding/prepare-vibe-append", {
  payload: { cleanup: VibeCleanup },
  success: AppendPreparation,
  error: CodingError,
  nondeterministic: true
})
const CreateLanding = Action.make("coding/create-vibe-landing", {
  payload: { cleanup: VibeCleanup, preparation: AppendPreparation },
  success: LandingIdentity,
  error: CodingError,
  nondeterministic: true
})
const QueueAppend = Action.make("coding/queue-vibe-append", {
  payload: { cleanup: VibeCleanup, preparation: AppendPreparation, landing: LandingIdentity },
  success: QueuedAppend,
  error: CodingError,
  nondeterministic: true
})
const ObserveAppend = Action.make("coding/observe-vibe-append", {
  payload: { queued: QueuedAppend, attempt: Schema.Number },
  success: Poll.CheckResult(Observed),
  error: CodingError,
  nondeterministic: true
})
const VerifyLanded = Action.make("coding/verify-vibe-landed", {
  payload: {
    cleanup: VibeCleanup,
    cleanedSource: PublishVibeSource.successSchema,
    queued: QueuedAppend,
    observed: Observed
  },
  success: VibeLanded,
  error: CodingError
})
/** A local lander's candidate: the cleaned tip merged onto main as one commit. */
const PrepareCandidate = Action.make("coding/prepare-vibe-candidate", {
  payload: { cleanup: VibeCleanup },
  success: LandingCandidate,
  error: CodingError,
  nondeterministic: true
})
/** Fast-forward main to the candidate every required check passed on; otherwise evict it. */
const FastForward = Action.make("coding/fast-forward-vibe", {
  payload: { cleanup: VibeCleanup, prepared: LandingCandidate, receipts: Schema.Array(Receipt) },
  success: VibeFastForwarded,
  error: CodingError,
  nondeterministic: true
})
const OpenLocalPull = Action.make("coding/open-vibe-local-pull", {
  payload: { cleanup: VibeCleanup, prepared: LandingCandidate },
  success: LocalPull,
  error: CodingError,
  nondeterministic: true
})
const ObserveChecks = Action.make("coding/observe-vibe-pull-checks", {
  payload: { pull: LocalPull, attempt: Schema.Number },
  success: Poll.CheckResult(PullChecks),
  error: CodingError,
  nondeterministic: true
})
/** Merge the candidate GitHub's required checks passed, or report why GitHub keeps it open; failed checks evict. */
const MergeLocalPull = Action.make("coding/merge-vibe-local-pull", {
  payload: { cleanup: VibeCleanup, prepared: LandingCandidate, pull: LocalPull, checks: PullChecks },
  success: VibePullRequested,
  error: CodingError,
  nondeterministic: true
})
/** GitHub's required checks, observed in durable rounds for up to an hour. */
const checksIntervalMs = 15_000, checksAttempts = 240
const AwaitPullChecks = Poll.make("coding/AwaitVibePullChecks", {
  input: { pull: LocalPull },
  result: PullChecks,
  intervalMs: checksIntervalMs,
  maxAttempts: checksAttempts,
  onTimeout: "return-last",
  check: ({ pull, attempt }) =>
    ObserveChecks.call({ pull, attempt }).pipe(Node.catch({
      onFailure: () => Node.succeed({ satisfied: false, output: { status: "pending" as const, checks: [] } })
    }))
})
/** The candidate as the checks see it: one commit on main carrying every validated change's reads and writes. */
function candidateImplementation(cleanup: VibeCleanup, prepared: LandingCandidate): Implementation
function candidateImplementation(
  cleanup: VibeCleanup,
  prepared: Planned.Planned<LandingCandidate>
): Action.PlannedPayload<Implementation>
function candidateImplementation(
  cleanup: VibeCleanup,
  prepared: LandingCandidate | Planned.Planned<LandingCandidate>
): Action.PlannedPayload<Implementation> {
  return {
    change: "landing-candidate",
    parent: prepared.main,
    atoms: [prepared.candidate],
    head: prepared.candidate,
    reads: [...new Set(cleanup.result.changes.flatMap((change) => change.implementation.reads))],
    writes: [...new Set(cleanup.result.changes.flatMap((change) => change.implementation.writes))]
  }
}
/** Every check the plan declared, once each; the candidate is checked as the whole request. */
const candidateChecks = (cleanup: VibeCleanup): ReadonlyArray<Check> => {
  const checks = new Map<string, Check>()
  for (const change of cleanup.admission.request.plan.changes) {
    for (const check of change.checks) if (!checks.has(check.id)) checks.set(check.id, check)
  }
  return [...checks.values()]
}
/** Durable rounds: a process restart resumes the wait, never re-queues the append. */
const AwaitAppend = Poll.make("coding/AwaitVibeAppend", {
  input: { queued: QueuedAppend },
  result: Observed,
  intervalMs: observationIntervalMs,
  maxAttempts: observationAttempts,
  onTimeout: "return-last",
  check: ({ queued, attempt }) =>
    ObserveAppend.call({ queued, attempt }).pipe(Node.catch({
      onFailure: () =>
        Node.succeed({
          satisfied: false,
          output: { status: "unobserved" as const, reason: "Landing observation was unavailable" }
        })
    }))
})
export const LandVibeError = Schema.Union([CodingError, Poll.Failure])
/** Fast-forward: the project's checks on the candidate, then main moves or the candidate is evicted. */
const fastForward = (cleanup: VibeCleanup) =>
  PrepareCandidate.call({ cleanup }).pipe(
    Node.bindPlanned((prepared) =>
      Node.all(
        Object.fromEntries(
          candidateChecks(cleanup).map((check) => [
            check.id,
            RunCheck.call({ implementation: candidateImplementation(cleanup, prepared), check })
          ])
        )
      ).pipe(
        Node.map((receipts: Readonly<Record<string, Receipt>>) => Object.values(receipts)),
        Node.bindPlanned((receipts) => FastForward.call({ cleanup, prepared, receipts }))
      )
    )
  )
/** Pull request: push the candidate, wait for GitHub's required checks, then merge or leave it open. */
const pullRequest = (cleanup: VibeCleanup) =>
  PrepareCandidate.call({ cleanup }).pipe(
    Node.bindPlanned((prepared) =>
      OpenLocalPull.call({ cleanup, prepared }).pipe(
        Node.bindPlanned((pull) =>
          AwaitPullChecks.child({ pull }).pipe(
            Node.bindPlanned((checks) => MergeLocalPull.call({ cleanup, prepared, pull, checks }))
          )
        )
      )
    )
  )
/** The backend: retain the cleaned source, then append, open the pull request or hand the result to the stack. */
const backend = (cleanup: VibeCleanup) =>
  // bindPlanned alone lets independent descendants run early. The explicit
  // andThen makes the whole delivery subtree wait for the retention receipt.
  PublishVibeSource.child({ source: cleanup.head, phase: "cleaned" }).pipe(
    Node.bindPlanned((cleanedSource) =>
      Node.succeed(cleanedSource).pipe(
        // A send-upstream repository with an active stack delegates proposal
        // to that stack; native repositories use the landing append policy.
        Node.andThen(ReadStack.call({ cleanup })),
        Node.branch({
          if: (stacked) => stacked,
          then: () => SubmitLane.call({ cleanup, cleanedSource }),
          else: () =>
            Node.succeed(cleanedSource).pipe(
              Node.andThen(PrepareAppend.call({ cleanup })),
              Node.bindPlanned((preparation) =>
                CreateLanding.call({ cleanup, preparation }).pipe(
                  // The policy is read once the landing exists, so a refusal before it reads nothing.
                  Node.bindPlanned((landing) =>
                    Node.succeed(landing).pipe(
                      Node.andThen(ReadDelivery.call({ cleanup })),
                      Node.branch({
                        if: (delivery) => delivery === "pull-request",
                        then: () => OpenPull.call({ cleanup, cleanedSource, landing }),
                        else: () =>
                          QueueAppend.call({ cleanup, preparation, landing }).pipe(
                            Node.bindPlanned((queued) =>
                              AwaitAppend.child({ queued }).pipe(
                                Node.bindPlanned((observed) =>
                                  VerifyLanded.call({ cleanup, cleanedSource, queued, observed })
                                )
                              )
                            )
                          )
                      })
                    )
                  )
                )
              )
            )
        })
      )
    )
  )
export const LandVibe = Flow.make("coding/LandVibe", {
  payload: VibeCleanup,
  success: VibeDelivered,
  error: LandVibeError,
  body: (cleanup) =>
    ReadLander.call({ phase: "landing" }).pipe(
      Node.bindPlanned((lander) =>
        Node.succeed(lander).pipe(
          Node.branch({
            if: (lander) => lander === "backend",
            then: () => backend(cleanup),
            else: () =>
              Node.succeed(lander).pipe(
                Node.branch({
                  if: (lander) => lander === "fast-forward",
                  then: () => fastForward(cleanup),
                  else: () => pullRequest(cleanup)
                })
              )
          })
        )
      )
    )
})

/** The bound landing, refused when it is not a local lander. */
const requireLocal = Effect.flatMap(
  Landing,
  (landing) =>
    landing.kind !== "backend" ? Effect.succeed(landing) : Effect.fail(
      new CodingError({ code: "unavailable", message: "This host lands through the backend, not a local lander" })
    )
)
const atomsOf = (cleanup: VibeCleanup) => cleanup.result.changes.flatMap((change) => change.implementation.atoms)
export const landingLayers = Layer.mergeAll(
  Interpreter.layer(LandVibe),
  Interpreter.layer(AwaitAppend),
  Interpreter.layer(AwaitPullChecks),
  ReadStack.toLayer(() =>
    Effect.flatMap(
      requireBackend,
      (landing) =>
        Effect.flatMap(landing.readStack ?? Effect.succeed(false), (stacked) =>
          stacked
            ? Effect.map(landing.readDelivery, (delivery) => delivery === "pull-request")
            : Effect.succeed(false))
    )
  ),
  SubmitLane.toLayer(({ cleanup, cleanedSource }) =>
    Effect.gen(function*() {
      const landing = yield* requireBackend, instance = yield* FlowRuntime.FlowInstance
      if (landing.submitLane === undefined) return yield* invalid("This host cannot hand results to the mythical stack")
      const original = cleanup.admission.originalSource
      if (cleanedSource.source.commitId !== cleanup.head.commitId || original.parentCommitIds.length !== 1) {
        return yield* invalid(
          "A stack submission requires the exact retained cleaned source and a linear original source"
        )
      }
      const lane = yield* landing.submitLane({
        workspaceId: landing.binding.workspaceId,
        base: original.parentCommitIds[0]!,
        source: cleanup.head.commitId,
        requestRunId: cleanup.admission.requestExecutionId || instance.executionId,
        summary: cleanup.summary
      })
      return { cleanup, cleanedSource, lane }
    })
  ),
  ReadDelivery.toLayer(() => Effect.flatMap(requireBackend, (landing) => landing.readDelivery)),
  OpenPull.toLayer(({ cleanup, cleanedSource, landing: identity }) =>
    Effect.gen(function*() {
      const landing = yield* requireBackend, instance = yield* FlowRuntime.FlowInstance
      if (cleanedSource.source.commitId !== cleanup.head.commitId) {
        return yield* invalid("Pull request requires this exact retained cleaned source")
      }
      const pullRequest = yield* landing.openPull(identity, cleanup.head.commitId, instance.executionId)
      return { cleanup, cleanedSource, landing: identity, pullRequest }
    })
  ),
  PrepareAppend.toLayer(({ cleanup }) =>
    Effect.gen(function*() {
      const landing = yield* requireBackend
      const refusal = cleanedTipRefusal(cleanup)
      if (refusal !== undefined) return yield* invalid(refusal)
      const main = yield* landing.pinMain
      const preparation = yield* landing.prepare({
        target_bookmark: "main",
        expected_commit_id: main,
        source_commit_id: cleanup.head.commitId,
        source_base_commit_id: main
      })
      // Plue computes the complete suffix after the shared immutable prefix. This
      // request's validated atoms must be that suffix's ordered tail, so earlier
      // steered implementation is covered and nothing foreign is appended as ours.
      const atoms = atomsOf(cleanup), tail = preparation.changes.slice(-atoms.length)
      if (
        tail.length !== atoms.length ||
        tail.some((change, index) =>
          change.change_id !== atoms[index]!.changeId || change.commit_id !== atoms[index]!.commitId
        )
      ) {
        return yield* invalid("Native append preparation does not end with this request's validated atoms")
      }
      return preparation
    })
  ),
  CreateLanding.toLayer(({ cleanup, preparation }) =>
    Effect.gen(function*() {
      const landing = yield* requireBackend, instance = yield* FlowRuntime.FlowInstance
      return yield* landing.create(requestIdFor(instance.executionId, "vibe-landing"), preparation, cleanup.summary)
    })
  ),
  QueueAppend.toLayer(({ cleanup, preparation, landing: identity }) =>
    Effect.flatMap(
      requireBackend,
      (landing) =>
        landing.queue(identity, preparation, {
          commit_id: preparation.source_commit_id,
          expected_commit_id: preparation.expected_commit_id,
          source_base_commit_id: preparation.source_base_commit_id,
          description: cleanup.summary
        })
    )
  ),
  ObserveAppend.toLayer(({ queued }) =>
    Effect.map(
      Effect.flatMap(requireBackend, (landing) => landing.observe(queued)),
      (observation) => ({
        satisfied: observation.status === "landed" || observation.status === "failed",
        output: observation
      })
    )
  ),
  VerifyLanded.toLayer(({ cleanup, cleanedSource, queued, observed }) =>
    Effect.gen(function*() {
      if (observed.status !== "landed") {
        return yield* new CodingError({
          code: observed.status === "failed" ? "invalid_receipt" : "unavailable",
          message: observed.status === "failed" ?
            `Existing landing policy refused append task ${queued.taskId}; inspect landing ${queued.number}`
            : `Append task ${queued.taskId} has not landed; landing ${queued.number} remains pending work, not a changed main`
        })
      }
      if (
        cleanedSource.source.commitId !== cleanup.head.commitId ||
        observed.result.landed_count !== queued.preparation.changes.length
      ) {
        return yield* invalid("Landed receipt does not bind this exact retained cleaned source")
      }
      return {
        cleanup,
        cleanedSource,
        landing: { requestId: queued.requestId, number: queued.number },
        taskId: queued.taskId,
        mainCommitId: observed.result.target_commit_id,
        landedCount: observed.result.landed_count
      }
    })
  ),
  PrepareCandidate.toLayer(({ cleanup }) =>
    Effect.gen(function*() {
      const landing = yield* requireLocal, instance = yield* FlowRuntime.FlowInstance
      return yield* landing.prepare(cleanup, requestIdFor(instance.executionId, "vibe-landing"))
    })
  ),
  FastForward.toLayer(({ cleanup, prepared, receipts }) =>
    Effect.gen(function*() {
      const landing = yield* requireLocal
      const summary = verifySummary(candidateChecks(cleanup), candidateImplementation(cleanup, prepared), receipts)
      // A check the host could not run is an outage, not a verdict on the candidate.
      if (summary instanceof CodingError) {
        yield* landing.abandon(prepared)
        return yield* summary
      }
      if (summary.status === "failed") {
        yield* landing.abandon(prepared)
        return yield* new CodingError({
          code: "evicted",
          message: `The candidate failed required checks on main: ${summary.failed.join(", ")}`
        })
      }
      const mainCommitId = yield* landing.fastForward(prepared).pipe(
        Effect.tapError((error) => error.code === "evicted" ? landing.abandon(prepared) : Effect.void)
      )
      return { cleanup, prepared, mainCommitId, receipts }
    })
  ),
  OpenLocalPull.toLayer(({ prepared }) =>
    Effect.gen(function*() {
      const landing = yield* requireLocal, instance = yield* FlowRuntime.FlowInstance
      return yield* landing.openPull(prepared, requestIdFor(instance.executionId, "vibe-landing"))
    })
  ),
  ObserveChecks.toLayer(({ pull }) =>
    Effect.map(
      Effect.flatMap(requireLocal, (landing) => landing.observeChecks(pull)),
      (checks) => ({ satisfied: checks.status !== "pending", output: checks })
    )
  ),
  MergeLocalPull.toLayer(({ cleanup, prepared, pull, checks }) =>
    Effect.gen(function*() {
      const landing = yield* requireLocal
      if (checks.status === "failed") {
        return yield* new CodingError({
          code: "evicted",
          message: `Pull request #${pull.number} failed required checks: ${
            checks.checks.filter((check) => check.bucket === "fail" || check.bucket === "cancel").map((check) =>
              check.name
            ).join(", ")
          }`
        })
      }
      if (checks.status === "pending") {
        return yield* new CodingError({
          code: "unavailable",
          message: `Pull request #${pull.number} still has pending required checks; it stays open, not landed`
        })
      }
      const merge = yield* landing.merge(pull, prepared)
      return { cleanup, prepared, pullRequest: pull, merge }
    })
  )
)
