/** The third pass begins by reusing the same policy gates as implementation. */
import * as Digest from "@smthrs/core/Digest"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Effect, Layer, Schema } from "effect"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { NativeCoding } from "./native.ts"
import { sameCode } from "./planning.ts"
import { CodingError, Result, Revision } from "./schema.ts"
import { ReadVibeRequest, readVibeRequest, VibeEvidence, VibeInput } from "./vibe-evidence.ts"
import { ReadLander } from "./vibe-lander.ts"
import { publicationLayers, PublishVibeSource } from "./vibe-publication.ts"
import { VibeAdmission } from "./vibe-schema.ts"
export { VibeAdmission } from "./vibe-schema.ts"
import { Assess, FastGate, ValidatePlan } from "./workflow.ts"

/** Private durable admission receipt. This does not claim cleanup or landing. */
export const FenceVibeSource = Action.make("coding/fence-vibe-source", {
  payload: { evidence: VibeEvidence, assessment: Result },
  success: VibeAdmission,
  error: CodingError,
  nondeterministic: true
})
export const VerifyVibe = Flow.make("coding/VerifyVibe", {
  payload: VibeEvidence,
  success: VibeAdmission,
  error: CodingError,
  body: (evidence) => {
    const { plan, outcome } = evidence.request
    // ReadVibeRequest requires this domain outcome before graph construction.
    // Validate every retained atomic chain and exact check using existing gates.
    const changes = outcome.result!.changes
    const gates = plan.changes.map((change, index) => {
      const current = changes[index]
      // Assess returns the ordinary typed missing-Change refusal. Do not read
      // absent result fields while constructing its graph.
      return current === undefined ? Node.succeed(null) : FastGate.call({
        change,
        parent: index === 0 ? plan.base : changes[index - 1]!.implementation.head,
        implementation: current.implementation,
        receipts: Object.fromEntries(
          current.receipts.filter((receipt) => receipt.tier === "fast").map((receipt) => [receipt.checkId, receipt])
        )
      })
    })
    return ValidatePlan.call({ plan }).pipe(
      Node.andThen(Node.all(Object.fromEntries(gates.map((gate, index) => [String(index), gate])))),
      Node.andThen(Assess.call({ plan, changes })),
      Node.bindPlanned((assessment) => FenceVibeSource.call({ evidence, assessment }))
    )
  }
})
/**
 * The backend lander retains the original source before any snapshot; a local
 * lander has nothing to retain it with and verifies the request directly.
 */
export const AdmitVibe = Flow.make("coding/AdmitVibe", {
  payload: VibeInput,
  success: VibeAdmission,
  error: CodingError,
  body: (input) =>
    ReadVibeRequest.call(input).pipe(
      Node.bindPlanned((evidence) =>
        ReadLander.call({ phase: "admission" }).pipe(
          Node.branch({
            if: (lander) => lander === "backend",
            then: () =>
              PublishVibeSource.child({ source: evidence.originalSource, phase: "original" }).pipe(
                Node.andThen(VerifyVibe.child(evidence))
              ),
            else: () => VerifyVibe.child(evidence)
          })
        )
      )
    )
})

export const fenceVibeSource = ({ evidence, assessment }: typeof FenceVibeSource.payloadSchema.Type) =>
  Effect.gen(function*() {
    if (
      assessment.status !== "validated" || assessment.findings.length !== 0 ||
      Digest.canonical(assessment) !== Digest.canonical(evidence.request.outcome.result)
    ) {
      return yield* new CodingError({
        code: "invalid_receipt",
        message: "Finalization evidence does not pass the current coding policy"
      })
    }
    const final = assessment.changes.at(-1)?.implementation.head
    if (final === undefined) {
      return yield* new CodingError({ code: "invalid_receipt", message: "Finalization has no validated native tip" })
    }
    const jj = yield* Jj.Jj, native = yield* NativeCoding
    yield* jj.snapshot("coding finalization source admission")
    const current = yield* native.read()
    if (current.head.kind !== "resolved" || !sameCode(current.head, final)) {
      return yield* new CodingError({
        code: "stale_revision",
        message: "Source changed after validation; revalidate before vibing"
      })
    }
    // A fresh operation fence is needed for the first rewrite; an unchanged
    // source may have a newer operation ID after unrelated native observations.
    const validatedHead = Schema.decodeUnknownSync(Revision)(current.head)
    return { ...evidence, validatedHead }
  }).pipe(Effect.mapError((error) =>
    error instanceof CodingError ? error : new CodingError({
      code: "unavailable",
      message: "Finalization could not inspect the current native source"
    })
  ))

export const vibeAdmissionLayers = Layer.mergeAll(
  publicationLayers,
  Interpreter.layer(AdmitVibe),
  Interpreter.layer(VerifyVibe),
  ReadVibeRequest.toLayer(readVibeRequest),
  FenceVibeSource.toLayer(fenceVibeSource)
).pipe(Layer.provideMerge(RunCatalogRead.layer))
