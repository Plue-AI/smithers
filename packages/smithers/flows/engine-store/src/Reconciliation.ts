/**
 * The reconciliation seam: what happens when the world disagrees with the
 * declaration.
 *
 * `docs/guides/drive-a-plan.md` ("Install a reconciler") describes expected sets as the soft
 * mode: going outside them is allowed, journaled, and "triggers a
 * **reconciliation flow** — pluggable, a flow like everything else". The
 * deviation events have been emitted since the isolated-execution lane landed
 * (`internal/ActionPersistence.ts`, both `expectedSetDeviation` sites) and
 * had **no consumer at all**. This is the consumer, and
 * `PlanScheduler` is what feeds it.
 *
 * Pluggability is dependency injection at the owning seam, per the repository's
 * extension doctrine — there is no hook kernel. {@link layerDefault} installs a
 * deterministic verdict function; a model-backed reconciler is a different
 * `Layer` and lives in the agent packages. This package has no model
 * dependency and must not grow one.
 *
 * The three verdicts are exactly the vault's: **fail** the step where the
 * deviation is genuinely wrong, **reorder** — re-plan with the discovered
 * dependency made explicit — and **factor out** a shared step, where content
 * addressing does the heavy lifting because identical extracted steps collapse
 * to one key automatically.
 *
 * @since 0.1.0
 */

import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"

/**
 * A journaled `flows.engine.expected-set-deviation`, resolved against the plan
 * the scheduler is driving.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Deviation = Schema.Struct({
  nodeId: Schema.NonEmptyString,
  keyDigest: Schema.NonEmptyString,
  attempt: Schema.Int,
  /** Paths the execution touched that its declaration did not predict. */
  paths: Schema.Array(Schema.String),
  diffIdentity: Schema.String,
  /**
   * For each undeclared path, the OTHER plan node that declares it as a write
   * — the discovered dependency, resolved by the scheduler because only it
   * holds the plan.
   */
  declaredBy: Schema.Record(Schema.String, Schema.NonEmptyString),
  /** Other nodes in this run whose deviation named exactly the same paths. */
  alsoDeviatedBy: Schema.Array(Schema.NonEmptyString)
})

/**
 * The value form of {@link Deviation}.
 *
 * @since 0.1.0
 * @category models
 */
export type Deviation = typeof Deviation.Type

/**
 * A `WorkspaceSandbox.MaterializationConflict` the runtime strategy could not
 * absorb: the delay/rebase budget is spent, or the merge itself conflicted.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Conflict = Schema.Struct({
  nodeId: Schema.NonEmptyString,
  keyDigest: Schema.NonEmptyString,
  attempt: Schema.Int,
  /** How many times the scheduler rebased before giving up. */
  rebases: Schema.Int,
  strategy: Schema.Literals(["delay-rebase", "stop-merge"]),
  /** The plan nodes this one was annotated as conflicting with. */
  conflictsWith: Schema.Array(Schema.NonEmptyString)
})

/**
 * The value form of {@link Conflict}.
 *
 * @since 0.1.0
 * @category models
 */
export type Conflict = typeof Conflict.Type

/**
 * What reconciliation decided.
 *
 * @since 0.1.0
 * @category schemas
 */
export const Verdict = Schema.Union([
  Schema.TaggedStruct("Fail", { reason: Schema.String }),
  Schema.TaggedStruct("Reorder", { dependsOn: Schema.Array(Schema.NonEmptyString), reason: Schema.String }),
  Schema.TaggedStruct("FactorOut", { paths: Schema.Array(Schema.String), reason: Schema.String })
])

/**
 * The value form of {@link Verdict}.
 *
 * @since 0.1.0
 * @category models
 */
export type Verdict = typeof Verdict.Type

/**
 * The pluggable reconciler.
 *
 * @since 0.1.0
 * @category models
 */
export interface Service {
  readonly onDeviation: (deviation: Deviation) => Effect.Effect<Verdict>
  readonly onConflict: (conflict: Conflict) => Effect.Effect<Verdict>
}

/**
 * Service tag for the reconciliation seam.
 *
 * @since 0.1.0
 * @category services
 */
export class Reconciliation extends Context.Service<Reconciliation, Service>()("@smthrs/engine-store/Reconciliation") {}

/**
 * Names a {@link Service} implementation as a reconciler.
 *
 * It is the identity function: the value is checked against the interface at
 * its definition site, which is where a wrong-shaped reconciler should be
 * reported rather than at whichever layer eventually provides it.
 *
 * @since 0.1.0
 * @category constructors
 */
export const make = (service: Service): Service => service

/**
 * Provides a {@link Service} as the {@link Reconciliation} seam, replacing the
 * deterministic default.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (service: Service): Layer.Layer<Reconciliation> => Layer.succeed(Reconciliation, service)

/**
 * The deterministic default, in the vault's order of preference.
 *
 * 1. **Reorder** when every undeclared path is a path some *other* plan node
 *    declares it writes. That is a real dependency the declaration missed, and
 *    making it explicit is strictly better than failing.
 * 2. **Factor out** when another node in the same run deviated on exactly the
 *    same paths — two parallel steps that both ran `npm install`. No graph
 *    surgery follows: content addressing collapses two identical extracted
 *    steps to one key by itself, so the verdict is a record and a hint.
 * 3. **Fail** otherwise. The default is deliberately conservative — a
 *    deviation nobody can explain is the case the vault says is "genuinely
 *    wrong", and guessing is what the model-backed reconciler is for.
 *
 * A conflict the runtime strategy could not absorb always fails here: choosing
 * a winner between two landings is a semantic judgement this default does not
 * have the material to make.
 *
 * @since 0.1.0
 * @category constructors
 */
export const makeDefault = (): Service => ({
  onDeviation: Effect.fn("Reconciliation.onDeviation")((deviation) => {
    const paths = [...new Set(deviation.paths)]
    // Own keys only: a path named `toString` must not resolve to Object.prototype.
    const ownerOf = (path: string): string | undefined =>
      Object.hasOwn(deviation.declaredBy, path) ? deviation.declaredBy[path] : undefined
    const discovered = [
      ...new Set(
        paths
          .map(ownerOf)
          .filter((owner): owner is string => owner !== undefined && owner !== deviation.nodeId)
      )
    ]
    if (
      discovered.length > 0 &&
      paths.every((path) => {
        const owner = ownerOf(path)
        return owner !== undefined && owner !== deviation.nodeId
      })
    ) {
      return Effect.succeed<Verdict>({
        _tag: "Reorder",
        dependsOn: discovered,
        reason: `${deviation.nodeId} wrote paths declared by ${discovered.join(", ")}`
      })
    }
    if (deviation.alsoDeviatedBy.length > 0) {
      return Effect.succeed<Verdict>({
        _tag: "FactorOut",
        paths: deviation.paths,
        reason: `${deviation.nodeId} and ${deviation.alsoDeviatedBy.join(", ")} produced the same undeclared paths`
      })
    }
    return Effect.succeed<Verdict>({
      _tag: "Fail",
      reason: `${deviation.nodeId} wrote ${deviation.paths.join(", ")}, which no declaration explains`
    })
  }),
  onConflict: Effect.fn("Reconciliation.onConflict")((conflict) =>
    Effect.succeed<Verdict>({
      _tag: "Fail",
      reason: `${conflict.nodeId} could not land after ${conflict.rebases} rebases under ${conflict.strategy}`
    })
  )
})

/**
 * Installs the deterministic default reconciler.
 *
 * @since 0.1.0
 * @category layers
 */
export const layerDefault: Layer.Layer<Reconciliation> = Layer.sync(Reconciliation, makeDefault)
