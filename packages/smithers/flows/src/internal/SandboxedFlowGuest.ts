/**
 * The guest half of `SandboxedFlow`: the program that runs a child flow inside
 * the machine.
 *
 * `SandboxedFlow.execute` bundles the caller's entry module together with this
 * module and starts the bundle on the provisioned machine. The bundle's main
 * calls {@link run} with the entry module's exports and the guest environment,
 * and everything below is the runner protocol as the guest sees it: read the
 * request JSON the host wrote at `SMITHERS_SANDBOX_REQUEST_PATH`, find the
 * flow the request names among the entry's exports, decode the payload through
 * that flow's own payload schema, run the flow to completion, and write the
 * result JSON to `SMITHERS_SANDBOX_RESULT_PATH`.
 *
 * The composition the flow runs under is the smallest one in the tree that
 * drives a flow to completion with no host services: `FlowEngine.layerMemory`
 * as the runtime, `Action.layerImplementations` as the table the entry's
 * action implementations file themselves in, `Interpreter.layer` for the flow,
 * and a `Crypto` built on the platform's WebCrypto. The child completes inside
 * one guest process and the PARENT journals the whole sandboxed execution as
 * one durable action, so an in-guest SQLite journal would add `node:sqlite`,
 * the migration ladder, and a `Jj` stub to every bundle without changing the
 * durability the parent can observe.
 *
 * The request carries the caller's effective capability ceiling. The guest
 * runs the flow under that ceiling intersected with its own default, which is
 * unrestricted, so the guest can only narrow what the caller held, never widen
 * it. It echoes the ceiling it enforced in the result, and the host refuses a
 * result whose echo differs from what it sent. A capability the ceiling
 * refuses comes back as the kernel's own `PermissionDenied`, so the host
 * fails with the same typed error a local run would.
 *
 * Failures split two ways on purpose. A flow that fails, a payload the schema
 * refuses, and an entry module that exports no flow of the requested tag are
 * all outcomes the protocol can state, so they are written as a `failed`
 * result and the process exits normally. A missing request path, an
 * unreadable request file, or a result that cannot be written are failures of
 * the protocol itself, so they throw, the process exits non-zero, and the host
 * reports the exit and the guest's stderr rather than a fabricated result.
 *
 * @since 1.0.0
 */

import { Capability, CapabilityPattern } from "@smthrs/capability/Capability"
import * as CapabilitySet from "@smthrs/capability/CapabilitySet"
import { isPermissionError, PermissionDenied } from "@smthrs/capability/Permission"
import { FlowEngine } from "@smthrs/engine"
import { Action, type Flow, Interpreter } from "@smthrs/flow"
import * as RedactedLogger from "@smthrs/journal/RedactedLogger"
import * as Redaction from "@smthrs/journal/Redaction"
import * as Cause from "effect/Cause"
import * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { readFile, writeFile } from "node:fs/promises"

/**
 * A capability ceiling on the wire: the normalized any-of groups of a
 * `CapabilitySet`. No groups is unrestricted authority; an empty group denies
 * every capability. A pattern that does not decode refuses the whole request.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Ceiling = Schema.Array(Schema.Array(CapabilityPattern))

/**
 * The request the host writes for the guest.
 *
 * `payload` is the flow payload encoded through `Schema.toCodecJson` of the
 * flow's payload schema, so the guest decodes it through the same codec: a
 * schema round-trip on both sides of the machine boundary, never a cast.
 * `capabilityCeiling` is the caller's effective authority, which the guest
 * only ever intersects with.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Request = Schema.Struct({
  attempt: Schema.String,
  flow: Schema.String,
  executionId: Schema.String,
  capabilityCeiling: Ceiling,
  payload: Schema.Unknown
})

/**
 * What the guest writes back: the flow's success value encoded through its
 * success schema's JSON codec, or the reason it did not produce one. Both
 * echo the ceiling the guest enforced; a failure a capability refusal caused
 * also carries that refusal as `denied`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Result = Schema.Union([
  Schema.Struct({
    attempt: Schema.String,
    capabilityCeiling: Ceiling,
    status: Schema.Literal("succeeded"),
    output: Schema.Unknown
  }),
  Schema.Struct({
    attempt: Schema.String,
    capabilityCeiling: Ceiling,
    status: Schema.Literal("failed"),
    error: Schema.String,
    denied: Schema.optionalKey(PermissionDenied)
  })
])

/**
 * The guest environment as the runner reads it.
 *
 * Passed in rather than read ambiently so the runner is a function of its
 * inputs: the bundle's main hands it the real `process.env`, and an in-process
 * test hands it two temp paths.
 *
 * @category models
 * @since 1.0.0
 */
export interface Environment {
  readonly SMITHERS_SANDBOX_REQUEST_PATH?: string | undefined
  readonly SMITHERS_SANDBOX_RESULT_PATH?: string | undefined
}

const required = (environment: Environment, name: keyof Environment): string => {
  const value = environment[name]
  if (value === undefined || value === "") {
    throw new Error(
      `SandboxedFlow guest: ${name} is not set; the host starts the bundle with both request and result paths`
    )
  }
  return value
}

/** A flow declaration with its schemas erased, which is all the runner reads off one. */
type AnyFlow = Flow.Flow<string, Flow.AnyStructSchema, Schema.Top, Schema.Top, any>

/** Whether an export is a flow declaration of the requested tag. */
const isFlowTagged = (value: unknown, tag: string): value is AnyFlow =>
  Predicate.hasProperty(value, "payloadSchema") &&
  Predicate.hasProperty(value, "successSchema") &&
  Predicate.hasProperty(value, "execute") &&
  Predicate.hasProperty(value, "_tag") &&
  value._tag === tag

/**
 * The `Crypto` the guest composition provides: WebCrypto, which Node 26 and
 * Bun both expose as `globalThis.crypto`.
 *
 * Built here rather than imported from a platform package so the guest bundle
 * carries no dependency the entry's own `node_modules` may lack. Its digests
 * have to agree with the host's `NodeCrypto`: a child execution id derived in
 * the guest for a `.child()` boundary is the same SHA-256 the host would
 * derive from the same material, which the suite pins.
 *
 * @category services
 * @since 1.0.0
 */
export const guestCrypto: Crypto.Crypto = Crypto.make({
  randomBytes: (size) => globalThis.crypto.getRandomValues(new Uint8Array(size)),
  digest: (algorithm, data) =>
    Effect.tryPromise({
      try: () => globalThis.crypto.subtle.digest(algorithm, data as Uint8Array<ArrayBuffer>),
      /* v8 ignore next 8 -- WebCrypto refuses only an algorithm name, and the engine names none outside `DigestAlgorithm` */
      catch: (cause) =>
        PlatformError.systemError({
          _tag: "Unknown",
          module: "Crypto",
          method: "digest",
          description: `WebCrypto could not compute a ${algorithm} digest`,
          cause
        })
    }).pipe(Effect.map((buffer) => new Uint8Array(buffer)))
})

/** Diagnostic copies use the same key and value rules as engine logs. */
const redact = Redaction.redactDiagnostic

/** The most characters of a failure's fields a description quotes. */
const quotedFieldCharacters = 1024

/**
 * The own fields of a failure as JSON, `_tag`, `message`, and `stack` left
 * out, cut at {@link quotedFieldCharacters}; nothing when there are none or
 * they cannot be serialized. Redaction happens before truncation so a cut
 * cannot separate a credential from the key or prefix that identifies it.
 */
const fields = (value: object): string | undefined => {
  try {
    const rendered = JSON.stringify(
      value,
      (key, field: unknown) => key === "_tag" || key === "message" || key === "stack" ? undefined : field
    )
    if (rendered === "{}") return undefined
    return rendered.length > quotedFieldCharacters ? `${rendered.slice(0, quotedFieldCharacters)}…` : rendered
  } catch {
    return undefined
  }
}

/**
 * One failure as a line the host can quote: its tag or name, its message
 * when it has one, and its own fields as JSON. Not `Cause.pretty`, whose
 * rendering of a tagged error with no `message` is the tag followed by a
 * stack trace into the bundle, which tells the host nothing.
 */
const describe = (failure: unknown): string => {
  const value = RedactedLogger.redactArgument(failure, redact)
  if (typeof value !== "object" || value === null) return String(value)
  const tag = Predicate.hasProperty(value, "_tag") && typeof value._tag === "string"
    ? value._tag
    : value instanceof Error
    ? value.name
    : "failure"
  const message = Predicate.hasProperty(value, "message") && typeof value.message === "string" && value.message !== ""
    ? `: ${value.message}`
    : ""
  const own = fields(value)
  return `${tag}${message}${own === undefined ? "" : ` ${own}`}`
}

/**
 * The kernel's capability refusal behind a failure: a `PermissionDenied`
 * itself, or a guarded host service's `PlatformError` whose reason carries
 * one. Rebuilt from its checked plain fields so the class identity of the
 * copy that raised it does not matter, with the resource and reason redacted
 * under the same rules as the failure text: a denied command line can carry a
 * credential. A redacted resource the capability schema refuses carries no
 * refusal, and the failure is reported as text.
 */
const deniedBy = (failure: unknown): PermissionDenied | undefined => {
  const candidate = Predicate.hasProperty(failure, "reason") && Predicate.hasProperty(failure.reason, "_tag") &&
      failure.reason._tag === "PermissionDenied" && Predicate.hasProperty(failure.reason, "cause")
    ? failure.reason.cause
    : failure
  if (!isPermissionError(candidate) || candidate._tag !== "@smthrs/capability/PermissionDenied") return undefined
  try {
    return new PermissionDenied({
      capability: new Capability({
        action: candidate.capability.action,
        resource: String(redact(candidate.capability.resource))
      }),
      reason: String(redact(candidate.reason))
    })
  } catch {
    return undefined
  }
}

/**
 * The capability refusal a cause consists of. Only a cause whose one reason is
 * the refusal carries it: a refusal beside another failure, defect, or
 * interruption is reported as text, so the typed error can never stand in for
 * a failure a caller would not recover from.
 */
const deniedIn = (cause: Cause.Cause<unknown>): PermissionDenied | undefined => {
  if (cause.reasons.length !== 1) return undefined
  const reason = cause.reasons[0]!
  return Cause.isFailReason(reason)
    ? deniedBy(reason.error)
    : Cause.isDieReason(reason)
    ? deniedBy(reason.defect)
    : undefined
}

/** Every reason the cause carries, one line each. */
const describeCause = (cause: Cause.Cause<unknown>): string =>
  cause.reasons.map((reason) =>
    Cause.isFailReason(reason)
      ? describe(reason.error)
      : Cause.isDieReason(reason)
      ? `defect ${describe(reason.defect)}`
      : "interrupted"
  ).join("; ")

/**
 * Runs the request the host wrote and writes the result it expects.
 *
 * `entry` is the namespace of the caller's entry module. The flow is found by
 * tag among its exports, default export included, and an export named `layer`
 * that is an Effect `Layer` is provided beside the interpreter: that is where
 * the entry supplies the implementations of the actions its flow body names.
 *
 * @category constructors
 * @since 1.0.0
 */
export const run = async (entry: Readonly<Record<string, unknown>>, environment: Environment): Promise<void> => {
  const requestPath = required(environment, "SMITHERS_SANDBOX_REQUEST_PATH")
  const resultPath = required(environment, "SMITHERS_SANDBOX_RESULT_PATH")
  const request = Schema.decodeUnknownSync(Request)(JSON.parse(await readFile(requestPath, "utf8")))
  const result = await Effect.runPromise(execute(entry, request))
  await writeFile(
    resultPath,
    // Every failure text is redacted where it is made. A second pass over a
    // finished line is not harmless: the diagnostic rules treat the words after
    // a placeholder as the rest of a credential, so a line already redacted
    // once loses everything that follows its first placeholder.
    JSON.stringify(Schema.encodeSync(Result)(result))
  )
}

const execute = (
  entry: Readonly<Record<string, unknown>>,
  request: typeof Request.Type
): Effect.Effect<typeof Result.Type> =>
  Effect.gen(function*() {
    // The guest starts unrestricted, the identity of intersection, so the
    // enforced ceiling is exactly the one the caller sent, normalized.
    const within = CapabilitySet.attenuateGroups(request.capabilityCeiling)
    const capabilityCeiling = (yield* within(CapabilitySet.current)).groups
    const flow = Object.values(entry).find((value) => isFlowTagged(value, request.flow))
    if (flow === undefined) {
      return {
        attempt: request.attempt,
        capabilityCeiling,
        status: "failed",
        error: String(
          redact(`the entry module exports no flow tagged "${request.flow}"; export the flow the host was asked to run`)
        )
      } as const
    }
    const implementations = Layer.isLayer(entry.layer) ? entry.layer : Layer.empty
    // The entry's layer arrives untyped, so what it requires beyond the table
    // and the runtime is unknown here. Anything it still owes surfaces when
    // the layer is built, which is the failure the `failed` result reports.
    const runtime = Layer.mergeAll(implementations, Interpreter.layer(flow)).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(Layer.succeed(Crypto.Crypto, guestCrypto))
    ) as unknown as Layer.Layer<never>
    const payloadCodec = Schema.toCodecJson(flow.payloadSchema)
    const successCodec = Schema.toCodecJson(flow.successSchema)
    const exit = yield* Effect.exit(
      Schema.decodeUnknownEffect(payloadCodec)(request.payload).pipe(
        Effect.flatMap((payload) => flow.execute(payload, { executionId: request.executionId })),
        Effect.flatMap((value) => Schema.encodeEffect(successCodec)(value)),
        Effect.provide(runtime),
        // Outermost, so building the entry's layer, its finalizers, and any
        // fiber it forks run under the ceiling too, not only the body.
        within
      ) as Effect.Effect<unknown, unknown>
    )
    if (Exit.isSuccess(exit)) {
      return { attempt: request.attempt, capabilityCeiling, status: "succeeded", output: exit.value } as const
    }
    const denied = deniedIn(exit.cause)
    return {
      attempt: request.attempt,
      capabilityCeiling,
      status: "failed",
      error: describeCause(exit.cause),
      ...(denied === undefined ? {} : { denied })
    } as const
  })
