/** Use the host's existing registered project flows, without another gateway or runtime. */
import * as Digest from "@smthrs/core/Digest"
import { FlowRuntime } from "@smthrs/flow"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema } from "effect"
import { CodingError, Implementation, Receipt } from "./schema.ts"
import { Implement, RunCheck } from "./workflow.ts"

const invoke = (name: string, expectedDigest: string, input: Schema.Json, key: ReadonlyArray<string>) =>
  Effect.gen(function*() {
    const catalog = yield* Executable.Catalog
    const instance = yield* FlowRuntime.FlowInstance
    const runtime = yield* FlowRuntime.FlowRuntime
    const executable = catalog.executables.find((entry) => entry.descriptor.name === name)
    if (!executable) {
      return yield* Effect.fail(
        new CodingError({ code: "unavailable", message: `Project flow ${name} is not registered in this host` })
      )
    }
    const descriptorDigest = Descriptor.executionDigest(executable.descriptor)
    if (descriptorDigest === undefined) {
      return yield* Effect.fail(
        new CodingError({ code: "unavailable", message: `Project flow ${name} has no verified executable identity` })
      )
    }
    if (descriptorDigest !== expectedDigest) {
      return yield* Effect.fail(
        new CodingError({
          code: "stale_revision",
          message: `Project flow ${name} changed since this plan was prepared; replan under a new execution`
        })
      )
    }
    const suffix = Digest.digest(Digest.canonical([
      name,
      descriptorDigest,
      input,
      key
    ]))
    const legacyId = `${instance.executionId}/coding/${suffix}`
    // Preserve existing resumable child IDs. Only an overlong new lineage uses
    // the bounded form; hashing includes the complete parent identity.
    const executionId = legacyId.length <= 200 ? legacyId : Digest.digest(Digest.canonical([
      "coding/child/v1",
      instance.executionId,
      name,
      descriptorDigest,
      input,
      key
    ]))
    // The runtime reads the ambient FlowInstance and persists the parent edge.
    // Full payload and verified descriptor identity prevent stale child reuse.
    return yield* runtime.execute(executable.flow, {
      executionId,
      payload: { input }
    }).pipe(
      Effect.catch((cause) =>
        Effect.fail(new CodingError({ code: "execution", message: `Project flow ${name} failed: ${String(cause)}` }))
      )
    )
  })

/** The deployment supplies its existing Executable.Catalog and FlowRuntime layers. */
export const catalogLayers = Layer.mergeAll(
  Implement.toLayer((input) =>
    invoke(input.change.implementation, input.change.implementationDigest, input, [
      "implement",
      input.change.id,
      input.parent.commitId
    ]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Implementation)),
      Effect.catch((cause) =>
        Effect.fail(
          cause instanceof CodingError
            ? cause
            : new CodingError({
              code: "execution",
              message: `Implementation flow returned invalid JJ revision evidence: ${String(cause)}`
            })
        )
      )
    )
  ),
  RunCheck.toLayer((input) =>
    invoke(input.check.flow, input.check.flowDigest, input, [
      "check",
      input.implementation.change,
      input.implementation.head.commitId,
      input.check.id
    ]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Receipt)),
      Effect.catch((cause) =>
        Effect.fail(
          cause instanceof CodingError
            ? cause
            : new CodingError({
              code: "invalid_receipt",
              message: `Check flow returned invalid revision evidence: ${String(cause)}`
            })
        )
      )
    )
  )
)
