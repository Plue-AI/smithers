/**
 * Journal-backed durable notification admission and turn-boundary drain.
 *
 * Governing contract: `packages/smithers/notifications/docs/api.md`, published as
 * `/api/notifications`.
 *
 * @since 0.1.0
 */

import { canonicalize } from "@smthrs/canonical"
import { digestSync } from "@smthrs/crypto/Sha256"
import { Journal, JournalEvent } from "@smthrs/journal"
import { Context, Effect, HashMap, Layer, Option, Schema, SchemaIssue, Semaphore } from "effect"
import * as FoldCache from "./internal/foldCache.ts"
import * as NotificationModel from "./Notification.ts"
import * as NotificationEvent from "./NotificationEvent.ts"
import * as NotificationState from "./NotificationState.ts"

/**
 * The queue could not be reached, or it refused what a caller handed it.
 *
 * `code` is the stable half and the one to branch on. `notification_unavailable`
 * is the seam reporting that it serves nothing; `notification_id_reused` says a
 * stable id was admitted once already with different content, which is a
 * producer bug rather than a storage failure; `notification_invalid` says the
 * value is not a notification, and `path` names the field inside it that failed.
 * `notification_closed` means the receiver has finished and the caller must
 * start a new request; `notification_full` means nothing was retained and the
 * same notification may be retried after pending work drains. Neither the
 * message nor `path` ever carries the offending value.
 *
 * @category errors
 * @since 0.1.0
 */
export class NotificationError extends Schema.TaggedError<NotificationError>()(
  "/notifications/NotificationError",
  {
    code: Schema.Literals([
      "notification_unavailable",
      "notification_closed",
      "notification_full",
      "notification_id_reused",
      "notification_invalid"
    ]).pipe(
      Schema.withConstructorDefault(Effect.succeed("notification_unavailable" as const))
    ),
    message: Schema.String,
    /** The notification the failure is about, when one was readable. */
    notificationId: Schema.optional(Schema.String),
    /** Dotted path of the offending field, for `notification_invalid`. */
    path: Schema.optional(Schema.String)
  }
) {}

/**
 * What admitting one notification decided.
 *
 * `seq` is the journal sequence the admission committed at, and it is absent
 * exactly when nothing was written, which today means a `rejected-full`
 * refusal. `duplicate` says the id was already admitted, in which case
 * `decision` and `seq` are read back from the committed record rather than
 * recomputed here.
 *
 * A caller MUST inspect `decision`: `rejected-full` means the queue was at
 * capacity and retained nothing, so the notification never reaches the model
 * unless the caller admits it again once a boundary has drained.
 *
 * @category models
 * @since 0.1.0
 */
export interface AdmissionReceipt {
  readonly notificationId: string
  readonly decision: NotificationState.AdmissionDecision
  readonly seq: number | undefined
  readonly duplicate: boolean
}

/**
 * The boundary a drain is attempted at, and whether the run would go idle
 * if nothing were delivered.
 *
 * `(runId, targetLineageId, boundary)` is the unit of drain: two lineages
 * closing a turn under the same boundary name are two drains, and each is
 * recorded separately.
 *
 * @category models
 * @since 0.1.0
 */
export interface DrainInput {
  readonly runId: string
  readonly targetLineageId: string
  readonly boundary: string
  readonly wouldIdle: boolean
  /**
   * The journal sequence that opened this turn. A steer admitted after it is
   * held for the next boundary, which is what keeps a message that arrived
   * mid-turn out of the turn already in flight. Omitting it delivers
   * everything pending for the lineage.
   */
  readonly cutoffSeq?: number | undefined
}

/**
 * The notifications this boundary delivers, and whether the boundary had
 * already drained.
 *
 * The notifications are the ones the committed promotion record names, so two
 * processes draining one boundary report the same delivery rather than two
 * divergent guesses.
 *
 * @category models
 * @since 0.1.0
 */
export interface DrainReceipt {
  readonly notifications: ReadonlyArray<NotificationModel.Notification>
  readonly boundary: string
  readonly duplicate: boolean
}

/**
 * The durable pending queue: admit a notification exactly once, and drain
 * what a boundary is allowed to deliver.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  readonly admit: (
    runId: string,
    notification: NotificationModel.Notification
  ) => Effect.Effect<AdmissionReceipt, Journal.JournalError | NotificationError>
  readonly drain: (
    input: DrainInput
  ) => Effect.Effect<DrainReceipt, Journal.JournalError | NotificationError>
  /**
   * What this run has been told that no boundary has delivered yet, in
   * admission order.
   *
   * The queue is the owner of that fact: pending is admitted minus promoted,
   * and both halves are its own journal records. A supervisor that counted
   * admissions alone would report a steer as waiting forever.
   */
  readonly pending: (
    runId: string
  ) => Effect.Effect<ReadonlyArray<NotificationModel.Notification>, Journal.JournalError | NotificationError>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class NotificationQueue extends Context.Service<NotificationQueue, Service>()(
  "/notifications/NotificationQueue"
) {}

/**
 * Builds a {@link Service} from an implementation of its methods.
 *
 * @param implementation the methods to serve
 * @category constructors
 * @since 0.1.0
 */
export const make = (implementation: Service): Service => NotificationQueue.of(implementation)

const unavailable = (operation: string): NotificationError =>
  new NotificationError({ code: "notification_unavailable", message: `${operation} is unavailable` })

/**
 * A {@link Service} that fails every method as unavailable. Overrides
 * replace individual methods.
 *
 * @param overrides methods to serve instead of failing
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  make({
    admit: Effect.fn("NotificationQueue.admit")(() => Effect.fail(unavailable("admit"))),
    drain: Effect.fn("NotificationQueue.drain")(() => Effect.fail(unavailable("drain"))),
    pending: Effect.fn("NotificationQueue.pending")(() => Effect.fail(unavailable("pending"))),
    ...overrides
  })

/**
 * Provides {@link makeNoop}.
 *
 * @param overrides methods to serve instead of failing
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<NotificationQueue> =>
  Layer.succeed(NotificationQueue)(makeNoop(overrides))

/**
 * The deepest a notification's JSON may nest.
 *
 * The bound exists because the value is walked and serialized on the way to
 * the journal, and an unbounded walk turns a hostile payload into an untyped
 * `RangeError` instead of a refusal a caller can read.
 */
const maximumPayloadDepth = 256

/** Bounds an issue message so a refusal cannot journal or log an essay. */
const maximumIssueCodeUnits = 200

/**
 * Whether a value nests deeper than the bound, walked iteratively so the walk
 * itself cannot exhaust the stack. A cycle is caught by the same bound: it has
 * no finite depth, so it trips the limit rather than looping forever.
 */
const tooDeep = (value: unknown): boolean => {
  const pending: Array<{ readonly value: unknown; readonly depth: number }> = [{ value, depth: 0 }]
  while (pending.length > 0) {
    const next = pending.pop()!
    if (typeof next.value !== "object" || next.value === null) continue
    if (next.depth >= maximumPayloadDepth) return true
    const nested = Array.isArray(next.value) ? next.value : Object.values(next.value)
    for (const child of nested) pending.push({ value: child, depth: next.depth + 1 })
  }
  return false
}

/**
 * A structural copy of the caller's value, so nothing the queue journals or
 * retains can be edited afterwards through a reference the caller kept. Values
 * that are not arrays or objects pass through, which is what leaves a function
 * or a symbol in place for the schema to reject.
 */
const copied = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(copied)
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, copied(nested)]))
  }
  return value
}

const formatIssue = SchemaIssue.makeFormatterStandardSchemaV1({ leafHook: (issue) => issue._tag })

const bounded = (text: string): string =>
  text.length <= maximumIssueCodeUnits ? text : `${text.slice(0, maximumIssueCodeUnits - 3)}...`

const identifiedBy = (value: unknown): string | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const id = (value as Readonly<Record<string, unknown>>)["id"]
  return typeof id === "string" ? id : undefined
}

const decodeNotification = Schema.decodeUnknownEffect(NotificationModel.Notification)

/**
 * Decodes the caller's argument at the durability boundary and returns a value
 * the caller cannot reach.
 *
 * Nothing downstream re-checks the shape: a structurally invalid notification
 * that reached the journal would be acknowledged at a real sequence and then
 * skipped by every replay, which is acknowledged data loss. The depth bound
 * runs first so a hostile payload cannot exhaust the stack before the schema
 * sees it.
 */
const validated = (
  notification: NotificationModel.Notification
): Effect.Effect<NotificationModel.Notification, NotificationError> =>
  Effect.gen(function*() {
    const notificationId = identifiedBy(notification)
    if (tooDeep(notification)) {
      return yield* new NotificationError({
        code: "notification_invalid",
        message: `A notification nests deeper than the ${maximumPayloadDepth} level bound`,
        ...(notificationId === undefined ? {} : { notificationId })
      })
    }
    return yield* decodeNotification(copied(notification)).pipe(
      Effect.mapError((error) => {
        // The formatter reports at least one issue for a failure and gives
        // every issue a concrete path. Standard Schema's result type widens
        // both, so a fallback for either would be code no input can reach.
        const issue = formatIssue(error.issue).issues[0] as {
          readonly message: string
          readonly path: ReadonlyArray<PropertyKey>
        }
        const path = issue.path.map(String).join(".")
        return new NotificationError({
          code: "notification_invalid",
          message: bounded(issue.message),
          ...(notificationId === undefined ? {} : { notificationId }),
          ...(path === "" ? {} : { path })
        })
      })
    )
  })

// Persisted notification JSON predates RFC 8785's rejection of lone surrogates.
const canonical = (value: unknown): string => canonicalize(value, { loneSurrogates: "escape" })

/** Fingerprint the validated input before the journal redacts its payload. */
const fingerprint = (notification: NotificationModel.Notification): Effect.Effect<string> =>
  Effect.sync(() => digestSync(canonical(notification)))

/** Freeze the decoded JSON graph before any queue output can expose it. */
const freeze = (value: unknown): void => {
  if (typeof value !== "object" || value === null) return
  for (const nested of Object.values(value)) freeze(nested)
  Object.freeze(value)
}

/**
 * One committed admission, as the journal recorded it.
 *
 * This is an identity, not a payload: the fold keeps the fingerprint that
 * settles a duplicate and the sequence the record lives at, and reads the
 * notification itself back from the journal on the rare path that needs it.
 * Retaining every admitted payload for a run's lifetime is what made a
 * capacity-one queue grow without bound.
 */
interface Committed {
  readonly fingerprint: string | undefined
  readonly decision: NotificationState.AdmissionDecision
  readonly seq: number
}

/**
 * One run's folded notification history.
 *
 * `cursor` is the sequence of the last entry folded, absent when the run has
 * no entries at all. It is what the next read pages from, so a fold costs the
 * entries added since the previous call rather than the run's whole journal.
 */
interface Loaded {
  readonly state: NotificationState.State
  readonly admissions: HashMap.HashMap<string, Committed>
  /** Drain identity to the sequence its record committed at. */
  readonly promotions: HashMap.HashMap<string, number>
  readonly cursor: number | undefined
}

/**
 * How many runs one layer keeps folded at a time. Evicting is safe: the next
 * call for an evicted run folds it again from the beginning, and the retention
 * policy is scan-resistant, so a supervisor sweeping more runs than this reads
 * journal tails for all but a fixed handful of them.
 */
const maximumCachedRuns = 64

const admissionSource = (id: string): JournalEvent.SourceId =>
  JournalEvent.SourceId.make(`/notifications/admission/${id}`)

/**
 * The identity of one drain: the lineage and the boundary, each encoded so a
 * value containing a slash cannot forge another pair's identity.
 */
const drainKey = (targetLineageId: string, boundary: string): string =>
  `${encodeURIComponent(targetLineageId)}/${encodeURIComponent(boundary)}`

const drainSource = (targetLineageId: string, boundary: string): JournalEvent.SourceId =>
  JournalEvent.SourceId.make(`/notifications/drain/${drainKey(targetLineageId, boundary)}`)

/**
 * Journal-backed production layer, with the pending capacity a composition
 * chooses.
 *
 * Admission and drain evidence is written through `emitDurableUnfenced`, so
 * both return only after the corresponding entry is durably committed and a
 * dropped lifecycle event is unrepresentable. The channel is the unfenced one
 * on purpose: the notifying process owns no run, so there is no ownership
 * fence to hand over, and both records are first-writer-wins on their own
 * identity instead.
 *
 * The capacity guard is a conditional write at the storage layer, not a check
 * against a fold one process happened to load: the fold, the guard, and the
 * admission record are decided and written inside ONE `journal.transact`
 * write transaction, which the durable writer serializes against every other
 * writer of the database and replays when a concurrent writer commits between
 * the guard's reads and the insert. Two processes admitting to one full queue
 * therefore produce one admission and one `rejected-full`, never two
 * admissions.
 *
 * @param options the pending capacity, defaulting to `NotificationState.defaultCapacity`
 * @category layers
 * @since 1.0.0
 */
export const layerWith = (
  options: { readonly capacity?: number | undefined } = {}
): Layer.Layer<NotificationQueue, never, Journal.Journal> =>
  Layer.effect(
    NotificationQueue,
    Effect.gen(function*() {
      const journal = yield* Journal.Journal
      // Orders this layer's own fibers so one process never runs two of its
      // admissions or drains against the fold cache at once. It is
      // process-local by construction and is NOT what enforces capacity or
      // drain identity across processes: those are the conditional writes
      // inside `journal.transact`, decided and committed in one serialized
      // write transaction. Always enter the journal transaction before taking
      // this permit, matching callers already inside an enclosing transaction.
      const operations = yield* Semaphore.make(1)
      const capacity = options.capacity ?? NotificationState.defaultCapacity
      // Only committed folds may be shared. A transaction reads its own
      // inserts, but its read-back is still provisional until the OUTERMOST
      // commit; neither a retry nor a later caller may dedupe against it.
      const folded = FoldCache.make<Loaded>(maximumCachedRuns)

      /**
       * One entry by the sequence it committed at.
       *
       * The fold keeps identities and sequences rather than payloads, so the
       * paths that must report an admitted notification read it back here.
       */
      const entryAt = (
        runId: JournalEvent.RunId,
        seq: number
      ): Effect.Effect<Option.Option<JournalEvent.Entry>, Journal.JournalError> =>
        Effect.map(
          journal.entries({
            runId,
            ...(seq === 0 ? {} : { after: JournalEvent.Seq.make(seq - 1) }),
            limit: 1
          }),
          (page) => {
            const found = page.entries[0]
            return found !== undefined && found.seq === seq ? Option.some(found) : Option.none()
          }
        )

      const admittedAt = (
        runId: JournalEvent.RunId,
        seq: number
      ): Effect.Effect<Option.Option<NotificationEvent.Admitted>, Journal.JournalError> =>
        Effect.map(entryAt(runId, seq), (entry) => {
          if (Option.isNone(entry)) return Option.none()
          const decoded = NotificationEvent.fromEntry(entry.value)
          if (Option.isNone(decoded) || !NotificationEvent.isAdmitted(decoded.value)) return Option.none()
          freeze(decoded.value.notification)
          return Option.some(decoded.value)
        })

      const promotedAt = (
        runId: JournalEvent.RunId,
        seq: number
      ): Effect.Effect<Option.Option<NotificationEvent.Promoted>, Journal.JournalError> =>
        Effect.map(entryAt(runId, seq), (entry) => {
          if (Option.isNone(entry)) return Option.none()
          const decoded = NotificationEvent.fromEntry(entry.value)
          if (Option.isNone(decoded) || !NotificationEvent.isPromoted(decoded.value)) return Option.none()
          return Option.some(decoded.value)
        })

      const load = (runId: JournalEvent.RunId): Effect.Effect<Loaded, Journal.JournalError> =>
        Effect.gen(function*() {
          const base: Loaded = folded.get(runId) ?? {
            state: NotificationState.empty(capacity),
            admissions: HashMap.empty(),
            promotions: HashMap.empty(),
            cursor: undefined
          }
          const fresh: Array<JournalEvent.Entry> = []
          let after = base.cursor === undefined ? undefined : JournalEvent.Seq.make(base.cursor)
          while (true) {
            // `after` is an exact-optional property upstream, so an explicit
            // `undefined` is not the same as an absent key.
            const page = yield* journal.entries({
              runId,
              eventTypes: [NotificationEvent.AdmittedEventType, NotificationEvent.PromotedEventType],
              ...(after === undefined ? {} : { after }),
              limit: 512
            })
            fresh.push(...page.entries)
            if (!page.hasMore || page.entries.length === 0) break
            after = page.entries.at(-1)!.seq
          }
          if (fresh.length === 0) return base

          let state = base.state
          let cursor = base.cursor
          // Persistent maps: one event adds a node and leaves the fold the
          // previous load published untouched, where copying both maps would
          // cost the run's whole history on every event and make a long run's
          // folding quadratic in its own admissions.
          let admissions = base.admissions
          let promotions = base.promotions
          for (const entry of fresh) {
            cursor = entry.seq
            const decoded = NotificationEvent.fromEntry(entry)
            if (Option.isNone(decoded)) continue
            const event = decoded.value
            if (NotificationEvent.isAdmitted(event)) {
              freeze(event.notification)
              admissions = HashMap.set(admissions, event.notification.id, {
                fingerprint: event.fingerprint,
                decision: event.decision,
                seq: entry.seq
              })
              state = NotificationState.applyAdmission(state, event.notification, entry.seq, event.decision)
            } else {
              promotions = HashMap.set(promotions, drainKey(event.targetLineageId, event.boundary), entry.seq)
              state = NotificationState.applyPromoted(state, event.ids)
            }
          }

          const loaded: Loaded = { state, admissions, promotions, cursor }
          yield* journal.whenCommitted(Effect.sync(() => folded.put(runId, loaded)))
          return loaded
        })

      /**
       * One conditional admission: the duplicate check, the capacity guard,
       * and the admission record, decided and written inside ONE journal
       * write transaction.
       *
       * This is the queue's conditional insert, the same read-guarded write
       * the journal itself uses for its dedupe and fence conditions: the
       * guard's reads and the insert share one serialized write transaction,
       * and the durable writer replays the whole body when a concurrent
       * writer commits between them. A decision a stale fold produced can
       * therefore never commit — the replay re-folds against the committed
       * state and a queue that filled meanwhile refuses — however many
       * processes share the database. The process-local `operations`
       * semaphore orders this layer's own fibers only; it is not what
       * enforces capacity across processes.
       */
      const admitInTransaction = (
        runId: JournalEvent.RunId,
        admitted: NotificationModel.Notification,
        admittedFingerprint: string
      ): Effect.Effect<AdmissionReceipt, Journal.JournalError | NotificationError> =>
        Effect.gen(function*() {
          const loaded = yield* load(runId)
          const prior = Option.getOrUndefined(HashMap.get(loaded.admissions, admitted.id))
          if (prior !== undefined) {
            // Legacy rows have no fingerprint; only their persisted content is
            // available for comparison, and the fold keeps identities rather
            // than payloads, so the original is read back at its sequence.
            // New rows settle on the fingerprint alone and read nothing.
            let same = prior.fingerprint === admittedFingerprint
            if (prior.fingerprint === undefined) {
              const original = yield* admittedAt(runId, prior.seq)
              if (Option.isNone(original)) {
                return yield* new NotificationError({
                  code: "notification_unavailable",
                  notificationId: admitted.id,
                  message: `The admission for notification ${admitted.id} is no longer readable`
                })
              }
              same = canonical(original.value.notification) === canonical(admitted)
            }
            if (!same) {
              return yield* new NotificationError({
                code: "notification_id_reused",
                notificationId: admitted.id,
                message: `Notification id ${admitted.id} was already admitted with different content`
              })
            }
            return {
              notificationId: admitted.id,
              decision: prior.decision,
              seq: prior.seq,
              duplicate: true
            }
          }

          const admission = NotificationState.admit(
            loaded.state,
            admitted,
            loaded.cursor === undefined ? 0 : loaded.cursor + 1
          )
          if (admission.decision === "rejected-full") {
            // Nothing is journaled. A rejection recorded as an admission
            // would match on every later attempt and burn the id forever,
            // so the queue refuses in the receipt alone and the caller may
            // admit again once a boundary has drained.
            return {
              notificationId: admitted.id,
              decision: admission.decision,
              seq: undefined,
              duplicate: false
            }
          }

          const receipt = yield* journal.emitDurableUnfenced(
            new JournalEvent.Input({
              runId,
              sourceId: admissionSource(admitted.id),
              sourceSeq: JournalEvent.SourceSeq.make(0),
              // The sequence is derived from the notification's own id, so
              // a collision IS this admission observed twice. Comparing
              // bytes instead would fail the second writer over `decision`,
              // a field neither caller supplied and each derives from the
              // fill level it happened to load at.
              dedupe: "identity",
              eventType: NotificationEvent.AdmittedEventType,
              payload: { notification: admitted, decision: admission.decision, fingerprint: admittedFingerprint }
            })
          )
          const committed = Option.getOrUndefined(HashMap.get((yield* load(runId)).admissions, admitted.id))
          if (committed === undefined) {
            // Only reachable when the emit deduped against an entry this
            // queue did not write, so nothing was committed and there is
            // no admission to report.
            return yield* new NotificationError({
              code: "notification_id_reused",
              notificationId: admitted.id,
              message: `The journal identity for notification ${admitted.id} holds an event this queue did not write`
            })
          }
          return {
            notificationId: admitted.id,
            decision: committed.decision,
            seq: committed.seq,
            duplicate: receipt._tag === "Duplicate"
          }
        })

      return make({
        admit: Effect.fn("NotificationQueue.admit")((rawRunId, notification) =>
          Effect.gen(function*() {
            const admitted = yield* validated(notification)
            const admittedFingerprint = yield* fingerprint(admitted)
            return yield* journal.transact(
              operations.withPermits(1)(
                admitInTransaction(JournalEvent.RunId.make(rawRunId), admitted, admittedFingerprint)
              )
            )
          })
        ),
        drain: Effect.fn("NotificationQueue.drain")((input) =>
          journal.transact(
            operations.withPermits(1)(Effect.gen(function*() {
              const runId = JournalEvent.RunId.make(input.runId)
              const key = drainKey(input.targetLineageId, input.boundary)
              const loaded = yield* load(runId)
              // A replay reports what the committed record delivered, read
              // back from the journal: the fold holds the identities, not the
              // notifications, so a run's drained payloads are not retained.
              const delivered = (
                record: NotificationEvent.Promoted,
                admissions: HashMap.HashMap<string, Committed>
              ): Effect.Effect<
                ReadonlyArray<NotificationModel.Notification>,
                Journal.JournalError | NotificationError
              > =>
                Effect.forEach(record.ids, (id) =>
                  Effect.gen(function*() {
                    const committed = HashMap.get(admissions, id)
                    const event = Option.isNone(committed)
                      ? Option.none<NotificationEvent.Admitted>()
                      : yield* admittedAt(runId, committed.value.seq)
                    // A committed drain promises this exact delivery. Missing or
                    // corrupt payloads cannot become a successful partial replay.
                    if (Option.isNone(event)) {
                      return yield* new NotificationError({
                        code: "notification_unavailable",
                        notificationId: id,
                        message: `The delivered notification ${id} is no longer readable`
                      })
                    }
                    return event.value.notification
                  }))

              const replayed = (seq: number, admissions: HashMap.HashMap<string, Committed>) =>
                Effect.gen(function*() {
                  const record = yield* promotedAt(runId, seq)
                  if (Option.isNone(record)) {
                    return yield* new NotificationError({
                      code: "notification_unavailable",
                      message: `The drain record for boundary ${input.boundary} is no longer readable`
                    })
                  }
                  return {
                    notifications: yield* delivered(record.value, admissions),
                    boundary: input.boundary,
                    duplicate: true
                  }
                })

              const prior = HashMap.get(loaded.promotions, key)
              if (Option.isSome(prior)) return yield* replayed(prior.value, loaded.admissions)

              const cutoff = input.cutoffSeq ?? loaded.cursor ?? 0
              const steers = NotificationState.promoteSteers(loaded.state, cutoff, input.targetLineageId)
              const queued = input.wouldIdle && steers.promoted.length === 0
                ? NotificationState.promoteQueued(steers.state, input.targetLineageId)
                : { state: steers.state, promoted: [] }
              const promoted = [...steers.promoted, ...queued.promoted].map((item) => item.notification)
              const receipt = yield* journal.emitDurableUnfenced(
                new JournalEvent.Input({
                  runId,
                  sourceId: drainSource(input.targetLineageId, input.boundary),
                  sourceSeq: JournalEvent.SourceSeq.make(0),
                  // The identity is the drain: this lineage closing this
                  // boundary. Two processes that both reach it have observed one
                  // event, and the first record committed is the delivery.
                  dedupe: "identity",
                  eventType: NotificationEvent.PromotedEventType,
                  payload: {
                    boundary: input.boundary,
                    targetLineageId: input.targetLineageId,
                    ids: promoted.map((notification) => notification.id)
                  }
                })
              )
              const settled = yield* load(runId)
              const committed = HashMap.get(settled.promotions, key)
              if (Option.isNone(committed)) {
                return yield* new NotificationError({
                  code: "notification_unavailable",
                  message: `The journal identity for boundary ${input.boundary} holds an event this queue did not write`
                })
              }
              // An accepted emit wrote THIS drain, so the promoted set is the
              // one already in hand and no read-back is owed.
              if (receipt._tag === "Accepted") {
                return { notifications: promoted, boundary: input.boundary, duplicate: false }
              }
              return yield* replayed(committed.value, settled.admissions)
            }))
          )
        ),
        pending: Effect.fn("NotificationQueue.pending")((rawRunId) =>
          Effect.map(
            load(JournalEvent.RunId.make(rawRunId)),
            // The fold `load` already performs: admissions add, promotions
            // remove. Read outside the operations semaphore, because a count
            // taken while a boundary drains is a count taken at some instant
            // either side of it, and blocking a supervisor behind a turn
            // boundary would be the worse answer.
            (loaded) => loaded.state.items.map((item) => item.notification)
          )
        )
      })
    })
  )

/**
 * Journal-backed production layer at the default capacity.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<NotificationQueue, never, Journal.Journal> = layerWith()
