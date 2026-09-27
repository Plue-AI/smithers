/** Runtime configuration shared by injected and native hosts.
 * @since 1.0.0
 */

import type * as EngineStore from "@smthrs/engine-store/EngineStore"
import { Action } from "@smthrs/flow"
import type { Ownership, RunStore } from "@smthrs/run-store"
import type * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

/**
 * Configuration for the injected runtime.
 *
 * `isAlive` is intentionally required, and a stub is not an answer: a check
 * that returns `false` without asking says "that owner is gone" about an owner
 * it never looked at, and the engine steals runs out of live processes on the
 * strength of it. A single-machine host passes `Ownership.sameHostPidProbe`,
 * which asks this machine's process table; a multi-process deployment answers
 * from its supervisor or lease system instead.
 *
 * @since 0.1.0
 * @category models
 * @slop
 */
export interface Options {
  /** SQLite database filename. Its parent directory is created recursively. */
  readonly filename: string
  /** Workspace whose file actions may read or mutate. */
  readonly workspaceRoot: string
  /** Stable identity of this engine host. */
  readonly owner: {
    readonly hostId: string
  }
  /**
   * Whether a previously recorded owner is still alive.
   *
   * Takes the claim context as well as the owner, so a probe can tell whether
   * the recorded pid names a process on the machine it is running on. A
   * one-argument check that ignores the context still satisfies this.
   */
  readonly isAlive: Ownership.LivenessCheck
  /** Routes shared-store runs to the host configured for their workspace. */
  readonly canExecute?: ((row: RunStore.RunRow) => Effect.Effect<boolean>) | undefined
  /**
   * Records, for a host that keeps one, that the engine has asked a parked
   * execution to resume — a durable clock fired, a durable deferred
   * completed, or a child settled under a parent that parked on it.
   *
   * A control plane that refuses to re-enter a parked run nobody asked for
   * reads the record to tell an engine wake from its own heartbeat sweep.
   *
   * @since 1.0.0-rc.0
   */
  readonly requestResume?:
    | ((executionId: string, reason: EngineStore.RequestedResumeReason) => Effect.Effect<void>)
    | undefined
  /**
   * The complete runtime environment a sealed step's recorded result may be
   * reused under, folded into every cross-run cache key.
   *
   * Absent by default, and absence is the safe answer, not a missing feature:
   * `@smthrs/engine` `FlowEngine/ActionKey.actionKey` then scopes every sealed
   * keyed dispatch to its own execution, so a result recorded by one run is
   * addressed by an identity no later run can spell and nothing is ever
   * reused across runs. Declaring it is what lets a second run address the
   * first run's row.
   *
   * The engine cannot derive this value: it names the semantic runtime layers
   * and the effective capability groups a result was computed under, and only
   * the host knows both. It is complete or absent for that reason — a partial
   * environment would justify hits it cannot account for — so a host that
   * cannot enumerate its toolchain and its capability envelope leaves it out
   * rather than inventing one. A host that declares an environment its
   * machines do not actually share serves one machine's results to another.
   */
  readonly cacheEnvironment?: Action.CacheEnvironment | undefined
  /**
   * The revision of the tree this host read its flows out of.
   *
   * Every node record can carry where its action was declared, and a path
   * with a line does not say which bytes were at that line: the tree moves
   * under a long-lived host, and the same path after an edit or a branch
   * switch is a different file. A host that can name the revision it loaded
   * from declares it here, and every recorded graph page carries it, so a
   * reader opens the declared file AT that revision rather than at whatever
   * is on disk when they look.
   *
   * Absent by default, which is the honest answer for a host served out of
   * no version control, or out of a tree no commit describes. A reader with
   * nothing shows no code at all rather than code it cannot bind (D-068).
   *
   * A host that only learns the answer after this call declares a reader
   * instead of a string, and it is asked once per recorded page. The native
   * host is one: the modules whose sites those records carry are read during
   * registration, which is the last startup phase, so the revision that
   * describes them is not known while this runtime is being built. A reader's
   * answer is not decoded here for the same reason it is not read here — it
   * does not exist yet — so an answer that is not a revision records nothing
   * rather than being refused after startup.
   */
  readonly sourceRevision?: string | (() => string | undefined) | undefined
}

/**
 * Stable failure raised synchronously for invalid runtime construction input.
 *
 * @since 1.0.0
 * @category errors
 */
export class RuntimeConfigurationError extends Schema.TaggedError<RuntimeConfigurationError>()(
  "@smthrs/flows/RuntimeConfigurationError",
  {
    code: Schema.Literal("invalid_runtime_configuration"),
    field: Schema.String,
    message: Schema.String
  }
) {}

const invalidConfiguration = (field: string, message: string): RuntimeConfigurationError =>
  new RuntimeConfigurationError({ code: "invalid_runtime_configuration", field, message })

/**
 * Decodes one named option and reports the option that was wrong.
 *
 * A single struct decode would answer "options" for every refusal, and the
 * whole point of {@link RuntimeConfigurationError.field} is that an embedder
 * can tell an empty `filename` from an empty `owner.hostId` without reading
 * prose. Decoding field by field makes the name come from the call site rather
 * than from walking a schema issue tree.
 * @since 1.0.0
 * @private
 */
export const decodeField = <A>(
  field: string,
  schema: Schema.Codec<A>,
  value: unknown,
  expectation: string,
  label = "Runtime"
): A => {
  try {
    return Schema.decodeUnknownSync(schema)(value)
  } catch {
    throw invalidConfiguration(field, `${label} ${field} ${expectation}`)
  }
}

const nonEmpty = "must be a non-empty string"

/** Captures immutable options; paths resolve through the injected Path service.
 * @since 1.0.0
 * @private
 */
export const validate = (options: Options, label = "Runtime"): Options => {
  const filename = decodeField("filename", Schema.NonEmptyString, options.filename, nonEmpty, label)
  const workspaceRoot = decodeField("workspaceRoot", Schema.NonEmptyString, options.workspaceRoot, nonEmpty, label)
  // A JavaScript caller can omit `owner` entirely, so the field is read off a
  // possibly-absent record rather than dereferenced.
  const owner = options.owner as { readonly hostId?: unknown } | undefined
  const hostId = decodeField("owner.hostId", Schema.NonEmptyString, owner?.hostId, nonEmpty, label)
  const isAlive = options.isAlive
  if (typeof isAlive !== "function") {
    throw invalidConfiguration("isAlive", `${label} isAlive must be a function`)
  }
  const canExecute = options.canExecute
  if (canExecute !== undefined && typeof canExecute !== "function") {
    throw invalidConfiguration("canExecute", `${label} canExecute must be a function when supplied`)
  }
  const requestResume = options.requestResume
  if (requestResume !== undefined && typeof requestResume !== "function") {
    throw invalidConfiguration("requestResume", `${label} requestResume must be a function when supplied`)
  }
  // Decoded rather than trusted: this value is cache key material, and a
  // malformed one would silently key every sealed result of this host.
  const cacheEnvironment = options.cacheEnvironment === undefined ? undefined : decodeField(
    "cacheEnvironment",
    Action.CacheEnvironment,
    options.cacheEnvironment,
    "must name every runtime layer and capability group",
    label
  )
  // A ref a reader cannot resolve is not a revision: a declared one is refused
  // where it is written rather than recorded onto every page of every run. A
  // reader is checked for its shape only; its answers are checked by the store
  // that asks for them, because none of them exists yet.
  const sourceRevision = options.sourceRevision === undefined || typeof options.sourceRevision === "function"
    ? options.sourceRevision
    : decodeField("sourceRevision", Schema.NonEmptyString, options.sourceRevision, nonEmpty, label)
  return Object.freeze({
    filename,
    workspaceRoot,
    owner: Object.freeze({ hostId }),
    isAlive,
    canExecute,
    requestResume,
    cacheEnvironment,
    sourceRevision
  })
}
