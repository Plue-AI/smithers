/**
 * `smthrs gc`: the retention pass over this project's databases, then the
 * artifact pass over its objects directory.
 *
 * `@smthrs/engine-store`'s `Retention` and `ArtifactGc` own what a pass
 * deletes; this module owns which files they run against and how an operator
 * spells the threshold. A project has two databases — the control plane's and
 * the engine's — and a sweep of one without the other leaves half of a
 * deleted run behind. Retention deletes the attempt and cache rows that were
 * the only roots of a spilled output, and nothing else deletes a published
 * blob, so the artifact pass runs in the same verb.
 *
 * @since 1.0.0
 */

import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as ArtifactGc from "@smthrs/engine-store/ArtifactGc"
import * as Retention from "@smthrs/engine-store/Retention"
import * as ExecutionSnapshot from "@smthrs/registry/ExecutionSnapshot"
import { Cause, Effect, Layer } from "effect"
import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import * as CliError from "./CliError.ts"
import * as DatabaseLocation from "./internal/DatabaseLocation.ts"
import * as ExecutionSnapshotRoots from "./internal/ExecutionSnapshotRoots.ts"
import * as NodeControl from "./NodeControl.ts"

/**
 * How long history is kept when `--older-than` is omitted.
 *
 * Thirty days, because the question a retained run answers is "what did the
 * agent do to this repository", and that question is asked in the weeks after
 * a change lands, not the hours.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultRetention = "30d"

const units: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60 * 1000,
  h: 60 * 60 * 1000,
  d: 24 * 60 * 60 * 1000,
  w: 7 * 24 * 60 * 60 * 1000
}

/**
 * Parses a duration such as `30d`, `12h`, or `90m` into milliseconds.
 *
 * @category constructors
 * @since 1.0.0
 */
export const duration = (value: string): number | undefined => {
  const match = /^(\d+)\s*(s|m|h|d|w)$/.exec(value.trim())
  if (match === null) return undefined
  // The unit came from the closed regular-expression alternative above.
  const scale = units[match[2]!]!
  const window = Number.parseInt(match[1]!, 10) * scale
  // A zero window makes every terminal run older than the threshold, so
  // `gc --older-than 0s` is "delete all history" wearing the spelling of a
  // retention policy. Refusing it costs an operator who meant it one explicit
  // `1s`, and saves the one who typed it by accident their whole journal.
  return window === 0 ? undefined : window
}

/**
 * The databases a sweep runs against, in the order it runs them.
 *
 * @category getters
 * @since 1.0.0
 */
export const databases = (root: string): ReadonlyArray<string> =>
  [NodeControl.databasePath(root), NodeControl.executionDatabasePath(root)]
    .filter((file) => DatabaseLocation.exists(file))

/**
 * The content-addressed objects directory the engine spills large outputs
 * into, beside its database.
 *
 * @category getters
 * @since 1.0.0
 */
export const objectsDirectory = (root: string): string =>
  join(dirname(NodeControl.executionDatabasePath(root)), "objects")

/**
 * One store the sweep could not collect from, and why: a database it could
 * not open, or an objects directory whose artifact pass failed.
 *
 * @category models
 * @since 1.0.0
 */
export interface Failure {
  readonly database: string
  readonly reason: string
}

/**
 * What one sweep did, and what it could not do.
 *
 * @category models
 * @since 1.0.0
 */
export interface Sweep {
  readonly olderThan: string
  readonly dryRun: boolean
  readonly reports: ReadonlyArray<Retention.Report>
  /**
   * The artifact pass over {@link objectsDirectory}. Absent when the project
   * has no objects directory or no engine database, or when the pass failed.
   */
  readonly artifacts?: ArtifactGc.GcReport | undefined
  /** Stores the sweep could not collect from. Empty on a clean sweep. */
  readonly failures: ReadonlyArray<Failure>
}

/**
 * Runs the retention pass over every database this project has, then the
 * artifact pass over the engine's objects directory.
 *
 * A project with no `.flows/` reports an empty sweep rather than failing: `gc`
 * on a project that has never run anything is a no-op, not an error. That is
 * the only empty sweep this function reports. A database it could not open is
 * a {@link Failure}, never a report of zero runs: `gc --dry-run` is trusted to
 * name exactly what a real pass would delete, and a locked or corrupt file
 * rendered as `{ runs: [] }` reads as "there is nothing to collect".
 *
 * Every database is PROBED before any of them is written to, and a probe that
 * fails abandons the whole pass. A run owns rows in both files, so sweeping
 * them independently and continuing past a failure could delete a run's
 * control rows and leave its engine rows behind, which no verb afterwards
 * converges. Refusing to start costs the operator a retry; a half-swept run
 * costs them the run. The caller decides the exit status from `failures`.
 *
 * The artifact pass runs last, over the engine database's roots, and only
 * when both the engine database and its objects directory exist. Under
 * `dryRun` it marks from rows retention has not deleted yet, so it can name
 * fewer blobs than the real pass then collects.
 *
 * @category constructors
 * @since 1.0.0
 */
export const sweep = (
  root: string,
  options: { readonly olderThan: string; readonly dryRun: boolean; readonly now?: number | undefined }
): Effect.Effect<Sweep, CliError.UsageError> =>
  Effect.gen(function*() {
    const window = duration(options.olderThan)
    if (window === undefined) {
      return yield* Effect.fail(
        new CliError.UsageError({
          message: `--older-than must be a duration such as 30d, 12h, or 90m; got ${options.olderThan}`
        })
      )
    }
    const olderThanMs = (options.now ?? Date.now()) - window
    const files = databases(root)
    const pass = (file: string, dryRun: boolean, pins?: ReadonlyArray<string>) =>
      Retention.collect({ olderThanMs, dryRun, database: file, pins }).pipe(
        Effect.provide(NodeDatabase.layer({ filename: file })),
        Effect.map((report): Retention.Report | Failure => report),
        Effect.catchCause((cause) => Effect.succeed<Failure>({ database: file, reason: reasonOf(cause) })),
        Effect.provide(Layer.empty)
      )
    // The probe is a dry-run collect, so it opens, migrates, and reads exactly
    // what the real pass would and writes nothing.
    const probed = yield* Effect.forEach(files, (file) => pass(file, true))
    const failures = probed.filter(isFailure)
    if (failures.length > 0) {
      return { olderThan: options.olderThan, dryRun: options.dryRun, reports: [], failures }
    }
    const roots = yield* ExecutionSnapshotRoots.live(files).pipe(
      Effect.map((value) => ({ value })),
      Effect.catchCause((cause) => Effect.succeed({ failure: reasonOf(cause) }))
    )
    if ("failure" in roots) {
      return {
        olderThan: options.olderThan,
        dryRun: options.dryRun,
        reports: [],
        failures: [{ database: root, reason: roots.failure }]
      }
    }
    const reports = options.dryRun
      ? yield* Effect.forEach(files, (file) => pass(file, true, roots.value.runIds))
      : yield* Effect.forEach(files, (file) => pass(file, false, roots.value.runIds))
    const retained = {
      olderThan: options.olderThan,
      dryRun: options.dryRun,
      reports: reports.filter((entry): entry is Retention.Report => !isFailure(entry)),
      failures: reports.filter(isFailure)
    }
    // After retention, so the rows it just deleted no longer root their
    // blobs. The grace period, not `--older-than`, protects recent blobs: a
    // running step's spilled output is unreferenced until its attempt row
    // finishes.
    const engine = NodeControl.executionDatabasePath(root)
    const objects = objectsDirectory(root)
    if (retained.failures.length > 0 || !DatabaseLocation.exists(engine) || !existsSync(objects)) return retained
    const artifacts = yield* Effect.gen(function*() {
      const { digests } = yield* ExecutionSnapshotRoots.live(databases(root))
      const snapshots = yield* ExecutionSnapshot.makeFileSystem({ root })
      const pins = yield* snapshots.roots(digests)
      const collector = yield* ArtifactGc.ArtifactGc
      return yield* collector.gc({ dryRun: options.dryRun, pins })
    }).pipe(
      Effect.provide(
        ArtifactGc.layerFileSystem({ directory: objects }).pipe(
          Layer.provide([NodeDatabase.layer({ filename: engine }), NodeFileSystem.layer])
        ).pipe(
          Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer))
        )
      ),
      Effect.map((report): ArtifactGc.GcReport | Failure => report),
      Effect.catchCause((cause) => Effect.succeed<Failure>({ database: objects, reason: reasonOf(cause) }))
    )
    return isFailure(artifacts)
      ? { ...retained, failures: [artifacts] }
      : { ...retained, artifacts }
  })

const isFailure = (entry: Retention.Report | ArtifactGc.GcReport | Failure): entry is Failure =>
  (entry as { readonly reason?: unknown }).reason !== undefined

/** The one sentence a reader can act on, out of whatever the open threw. */
const reasonOf = (cause: Cause.Cause<unknown>): string => {
  const squashed = Cause.squash(cause)
  /* v8 ignore else -- database and retention failures are Error instances */
  if (squashed instanceof Error) return squashed.message
  /* v8 ignore next -- defensive fallback for a future non-Error failure type */
  return String(squashed)
}

/**
 * The stderr paragraph a sweep with failures owes its operator.
 *
 * @category constructors
 * @since 1.0.0
 */
export const failureMessage = (failures: ReadonlyArray<Failure>): string =>
  `gc could not collect from ${failures.length} store${failures.length === 1 ? "" : "s"}:\n` +
  failures.map((failure) => `  ${failure.database}: ${failure.reason}`).join("\n")
