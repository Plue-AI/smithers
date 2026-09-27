/**
 * The fork verb: a new run seeded from a parent frame, never a parent mutation.
 *
 * `docs/guides/fork-a-run.md`: fork never touches the parent —
 * no compensation, no truncation, no restore of the parent's workspace — but
 * the boundary assessment still runs, and its result is **normalized to
 * warnings**: "this effect may execute again on the child". A fork with
 * warnings is a successful fork that disclosed something, not a refused one.
 *
 * @since 0.1.0
 */

import { Jj } from "@smthrs/jj"
import * as Journal from "@smthrs/journal/Journal"
import type * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as RunStore from "@smthrs/run-store/RunStore"
import type * as CacheStore from "@smthrs/step-cache/CacheStore"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as Scope from "effect/Scope"
import * as EffectBoundary from "../EffectBoundary.ts"
import type { Frame } from "../Frame.ts"
import { error, type TimeTravelError } from "../TimeTravelError.ts"
import { type Fork as ForkRecord, TimeTravelStore } from "../TimeTravelStore.ts"
import * as Compensation from "./Compensation.ts"
import type { EffectHandlerRegistry } from "./EffectHandlerRegistry.ts"
import * as HistoryLimit from "./HistoryLimit.ts"
import * as JournalPages from "./JournalPages.ts"
import * as StepHook from "./StepHook.ts"

/**
 * What a fork needs to know: which parent frame to branch from, and which lane
 * the child's workspace goes under.
 *
 * The lane is a root rather than a full path because a fork adds a jj
 * workspace for the child rather than restoring the parent's — the parent
 * keeps its own working copy untouched — and the child's own run id, minted
 * inside the operation, is what names it.
 *
 * @since 0.1.0
 * @category models
 */
export interface ForkOptions {
  readonly parentRunId: string
  readonly frame: Frame
  /**
   * The lane the child's jj workspace is materialized under. The workspace's
   * own name is {@link workspaceNameFor} of the child run id, never a
   * caller-supplied label: the fork mints the child id first precisely so the
   * lane and the run it holds carry one identity.
   */
  readonly workspaceRoot: string
  /** A CLI-created branch outlives the process that created it. */
  readonly retainWorkspace?: boolean | undefined
  /** Journal page size for the suffix scan; defaults to the store's own. */
  readonly pageSize?: number | undefined
  /**
   * The most journal entries the suffix scan may read before it refuses with
   * `limit_exceeded`. Defaults to `HistoryLimit.defaultMaxHistoryEntries`.
   */
  readonly maxEntries?: number | undefined
  /**
   * Brings the parent's frame anchors up to date, run AFTER the live-parent
   * refusal and before the assessment reads them. A fork of a live parent is
   * refused without reading its journal at all.
   */
  readonly refreshAnchors?: Effect.Effect<void, never, Journal.Journal | TimeTravelStore> | undefined
  /**
   * Fault injection between the fork's durable steps, the seam the crash
   * suite uses to kill a real process after the workspace exists and before
   * the store commits. Mirrors `Rewind.Options.hooks`.
   */
  readonly hooks?: {
    readonly beforeStep?: (step: ForkStep) => Effect.Effect<void, unknown>
  } | undefined
}

/**
 * The two steps a fork performs after its assessment, in order: provisioning
 * the child's jj workspace, then committing the child through the store.
 *
 * @since 0.1.0
 * @category models
 */
export type ForkStep = "provision-workspace" | "commit-fork"

/**
 * How long a reserved fork id may stay uncommitted before startup treats its
 * lane as abandoned and forgets it.
 *
 * Provisioning a workspace is one `jj workspace add`, seconds even on a large
 * repository, so five minutes separates a crash from a slow checkout by a
 * wide margin. An intent reclaimed while its fork was still in flight costs
 * that fork its lane registration and nothing else: the ordinal is never
 * reused, and the commit still lands.
 *
 * @since 0.1.0
 * @category constants
 */
export const intentStaleAfter: Duration.Duration = Duration.minutes(5)

/**
 * Everything a jj workspace name and a directory component both accept.
 *
 * @since 0.1.0
 * @category constructors
 */
const sanitize = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "-")

/**
 * FNV-1a over the run id, as eight lowercase hexadecimal characters.
 *
 * This is a disambiguator, not an identity: it never crosses the journal, the
 * cache, or the wire, so it does not go through `@smthrs/crypto`'s injected
 * SHA-256, whose `Crypto` requirement would follow every fork into every
 * composition. What it must be is browser-safe, synchronous, and total, which
 * a 32-bit multiply-and-xor over the code units is.
 *
 * @since 0.1.0
 * @category constructors
 */
const digest = (value: string): string => {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, "0")
}

/**
 * The workspace name a forked run's lane carries.
 *
 * THE CHILD RUN ID IS THE ONLY INPUT, on purpose. Naming the lane after the
 * parent frame, meaning the parent run id and the frame's seq, gave the second
 * fork of one frame the first child's name, and gave two parents that differ
 * only in a character the sanitizer folds (`demo/a` and `demo:a`) one shared
 * name.
 * The child run id distinguishes exactly what the store distinguishes, and the
 * digest of the RAW id restores what sanitizing and the 64-character cap fold
 * away. Two children share a name only when their sanitized, capped ids match
 * AND their raw ids share a 32-bit FNV-1a digest, about one pair in 4.3
 * billion for ids that already differ by an ordinal the store hands out. That
 * residual case is loud rather than silent: `jj workspace add` refuses a name
 * the repository already holds, so the fork fails instead of two runs sharing
 * one directory.
 *
 * `jj workspace list` shows this name to an operator, so it carries the
 * product's name rather than the imported repository's.
 *
 * @since 0.1.0
 * @category constructors
 */
export const workspaceNameFor = (childRunId: string): string =>
  `smithers-fork-${sanitize(childRunId).slice(0, 64)}-${digest(childRunId)}`

/**
 * Reads the journal suffix a fork carries past, keeping only the boundary
 * records in it: the entries the child will diverge from, and therefore the
 * effects it may re-arm.
 *
 * Every other record in the suffix is counted against `maxEntries` and
 * dropped. The assessment decodes boundary records alone, so the whole suffix
 * used to be retained for nothing, and a long run decided how much memory a
 * fork took.
 */
const suffixAfter = (
  journal: Journal.Service,
  runId: string,
  frame: Frame,
  pageSize: number,
  maxEntries: number
): Effect.Effect<ReadonlyArray<JournalEvent.Entry>, TimeTravelError> =>
  Effect.gen(function*() {
    const boundary: Array<JournalEvent.Entry> = []
    let count = 0
    // The pager fails closed on a malformed page, so a transient empty page
    // never lets the fork commit with an incomplete disclosure.
    yield* JournalPages.forEachPage(
      journal,
      {
        runId,
        after: frame.seq,
        pageSize,
        label: "journal fork",
        readFailure: `could not read fork suffix for ${runId}`
      },
      (entries) =>
        Effect.gen(function*() {
          for (const entry of entries) {
            count += 1
            if (count > maxEntries) {
              return yield* Effect.fail(HistoryLimit.exceeded("fork", runId, maxEntries))
            }
            if (entry.eventType === EffectBoundary.eventType) boundary.push(entry)
          }
        })
    )
    return boundary
  })

/**
 * Drops a lane registration, reporting rather than hiding a failure to.
 *
 * The forget runs on the two paths where the lane must not outlive its fork:
 * a commit that failed after provisioning, and the service scope closing.
 * Neither path can act on the failure, but an operator can, and `jj workspace
 * list` still showing the lane is the symptom they would otherwise chase blind.
 */
const forgetLane = (jj: Jj, workspaceName: string, when: string): Effect.Effect<void> =>
  jj.workspaceForget(workspaceName).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning(`time-travel: could not forget fork workspace ${when}`, cause).pipe(
        Effect.annotateLogs({ workspaceName })
      )
    )
  )

/**
 * Turns a boundary assessment into fork warnings.
 *
 * Smithers' `normalizeBranchReport` is the prior art: blocking and revertible
 * entries both become warnings on a branch operation, because the fork will
 * never revert a parent effect. A `warning` entry keeps its own disclosure.
 */
const normalize = (
  assessments: ReadonlyArray<Compensation.Assessment>
): ReadonlyArray<string> =>
  assessments.map((assessment) =>
    assessment.classification === "warning"
      ? `${assessment.effect.kind} (${assessment.effect.id}): ${assessment.residue}`
      : `${assessment.effect.kind} (${assessment.effect.id}) was classified ${assessment.classification} for rewind; ` +
        `on a fork it is never reverted and may execute again on the child. ${assessment.residue}`
  )

/**
 * A fork's outcome: the child run, its lineage edge, and everything the
 * boundary assessment disclosed.
 *
 * A fork never compensates, so the
 * assessment still runs and its blocking and revertible entries are
 * **normalized to warnings** — "this effect may execute again on the child".
 * A fork with a non-empty `warnings` is a successful fork, not a refused one.
 * The store commits {@link ForkRecord} and knows nothing of the warnings; this
 * layer computes them.
 *
 * @since 0.1.0
 * @category models
 */
export interface Result extends ForkRecord {
  readonly warnings: ReadonlyArray<string>
}

/**
 * Branches a child run off a parent frame.
 *
 * Refuses with `live_parent` if the parent is still running, claimed, or
 * owned — a fork copies a settled prefix, and a live parent has no settled
 * prefix to copy. Otherwise it reads the journal suffix past the frame,
 * assesses the effects in it, normalizes every classification to a warning
 * (see the module header), mints the child's run id, provisions that child's
 * jj workspace under {@link ForkOptions.workspaceRoot}, and only then asks the
 * store to commit the fork in one transaction — so a failed provision leaves
 * nothing durable, and a failed commit forgets the lane it provisioned. The
 * parent is never mutated.
 *
 * @since 0.1.0
 * @category constructors
 */
export const fork = (
  options: ForkOptions
): Effect.Effect<
  Result,
  TimeTravelError,
  | CacheStore.CacheStore
  | EffectHandlerRegistry
  | Jj
  | Journal.Journal
  | RunStore.RunStore
  | Scope.Scope
  | TimeTravelStore
> =>
  Effect.fn("Fork.fork")(() =>
    Effect.gen(function*() {
      yield* Effect.annotateCurrentSpan({
        parentRunId: options.parentRunId,
        lineageId: options.frame.lineageId,
        seq: options.frame.seq
      })
      const runs = yield* RunStore.RunStore
      const live = (row: RunStore.RunRow): boolean =>
        row.status === "running" || row.claim !== null || row.owner !== null
      const parent = yield* runs.get(options.parentRunId).pipe(
        Effect.mapError((cause) => error("unknown", "could not read parent", cause))
      )
      if (live(parent)) {
        return yield* Effect.fail(error("live_parent", `parent run ${options.parentRunId} is live`))
      }
      /**
       * The ancestors the run table names, walked BEFORE anything is
       * provisioned. The store re-walks the whole ancestry, fork edges and
       * engine spawn edges included, inside the commit transaction, and that
       * walk is the authoritative refusal; this pass only keeps a fork a live
       * ancestor will refuse from provisioning a lane it would forget a
       * moment later. A cycle terminates on the visited set.
       */
      const seen = new Set([options.parentRunId])
      let ancestorId = parent.parentRunId
      while (ancestorId !== null && !seen.has(ancestorId)) {
        const currentId = ancestorId
        seen.add(currentId)
        const ancestor = yield* runs.get(currentId).pipe(
          Effect.mapError((cause) =>
            cause.code === "not_found_row"
              ? error("not_found", `parent ${currentId} was not found`)
              : error("unknown", `could not read ancestor ${currentId}`, cause)
          )
        )
        if (live(ancestor)) {
          return yield* Effect.fail(error("live_parent", `ancestor run ${currentId} is live`))
        }
        ancestorId = ancestor.parentRunId
      }
      const store = yield* TimeTravelStore
      const journal = yield* Journal.Journal
      if (options.refreshAnchors !== undefined) yield* options.refreshAnchors

      // Assessment BEFORE any mutation, exactly as a rewind does — the fork
      // simply refuses to act on the verdict beyond disclosing it.
      const snapshot = yield* store.snapshotAt(options.parentRunId, options.frame)
      const suffix = yield* suffixAfter(
        journal,
        options.parentRunId,
        options.frame,
        options.pageSize ?? 100,
        options.maxEntries ?? HistoryLimit.defaultMaxHistoryEntries
      )
      const effects = yield* EffectBoundary.fromEntries(suffix)
      const plan = yield* Compensation.assess(effects, snapshot?.changeId)
      const warnings = normalize(plan.assessments)

      const jj = yield* Jj
      /**
       * MINT, THEN PROVISION, THEN COMMIT — in that order, on purpose.
       *
       * The mint is what makes the lane and the child one identity: the
       * workspace is named after the run that will live in it, so a frame
       * forked twice provisions two lanes and two parents that sanitize alike
       * never share one. The mint is a durable RESERVATION and nothing more:
       * no run exists yet, but the ordinal is taken, so a process that dies
       * between the two steps below retries under a fresh id instead of
       * asking jj for the lane name its own leftover still holds. Startup
       * hands the stale reservation back through `abandonForkIntents` and
       * forgets the lane it named.
       *
       * The store commit is the fork's finalization step, the way Temporal
       * finalizes a workflow record only after what it names exists
       * (Temporal's transactional finalization): `createFork`
       * writes the child run, its copied prefix, attempts, and anchors, and
       * the lineage edge in ONE store transaction, and consumes the
       * reservation with them. A failed `workspaceAdd` therefore leaves no
       * orphan child, no half-copied history, and no lineage edge to a run
       * that cannot execute, which is the durable residue the reverse order
       * left behind. A commit that fails AFTER provisioning is compensated
       * right here by forgetting the lane it provisioned.
       */
      const childRunId = yield* store.nextForkId(options.parentRunId, options.frame)
      const workspaceName = workspaceNameFor(childRunId)
      yield* Effect.annotateCurrentSpan({ childRunId, workspaceName })
      yield* StepHook.run("fork", options.hooks?.beforeStep, "provision-workspace")
      yield* jj.workspaceAdd(workspaceName, `${options.workspaceRoot}/${workspaceName}`, snapshot?.changeId).pipe(
        Effect.mapError((cause) => error("unknown", "could not add fork workspace", cause))
      )
      /**
       * THE COMMIT AND THE LANE'S FINALIZER ARE ONE UNIT.
       *
       * COMMIT can finish in an uninterruptible SQL finalizer, so the store
       * call and the forget-on-close registration share one mask: an interrupt
       * that lands while the commit finishes is observed only once the
       * committed child's lane has its finalizer. Registering it after the
       * commit returned let that interrupt either strand the lane with no
       * finalizer and no reservation left to reclaim it, or send a committed
       * child's lane through the refused-commit forget. Only the hook stays
       * interruptible, because nothing durable has happened when it runs.
       */
      const result = yield* Effect.uninterruptibleMask((restore) =>
        restore(StepHook.run("fork", options.hooks?.beforeStep, "commit-fork")).pipe(
          Effect.andThen(store.createFork(options.parentRunId, options.frame, childRunId)),
          Effect.onError(() => forgetLane(jj, workspaceName, "after a refused commit")),
          Effect.tap(() =>
            options.retainWorkspace === true
              ? Effect.void
              : Effect.addFinalizer(() => forgetLane(jj, workspaceName, "when the service scope closed"))
          )
        )
      )
      /**
       * THE CHILD'S WORKTREE IS PINNED AT THE FRAME'S POINTER.
       *
       * A fork wants the child's lane
       * restored to the frame's jj pointer, and `Jj.workspaceAdd` now takes
       * that pointer as its optional `revision`: the new workspace is pinned
       * at provisioning time, so the parent is never restored — "Fork never
       * touches the parent. No compensation, no truncation, no workspace
       * restore of the parent". A frame with no recorded pointer still lands
       * at the lane default, and that is what the warning channel discloses.
       */
      return {
        ...result,
        warnings: snapshot === undefined
          ? [
            ...warnings,
            `Frame ${options.frame.lineageId}@${options.frame.seq} has no recorded jj pointer; ` +
            `the fork workspace ${workspaceName} starts from the lane default rather than the frame.`
          ]
          : warnings
      }
    })
  )()
