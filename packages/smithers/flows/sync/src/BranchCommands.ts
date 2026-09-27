/**
 * Idempotent admission of collaborative commands onto a branch document.
 *
 * Three different things look identical from the server's side — an optimistic
 * client re-sending after a timeout, a reconnecting client flushing its
 * outbox, and two people pressing the same button at once — and all three must
 * produce exactly one durable command. The client-minted `commandId` is the
 * idempotency key for all three.
 *
 * The exactly-once constraint is durable, not process-local: every append
 * carries the producer identity `(branch run, commandSourceId(commandId),
 * commandSourceSeq)`, which the journal enforces inside its own write
 * transaction. Two independently constructed servers that race the same
 * command therefore collide in the journal — one appends, the other receives
 * a duplicate receipt or an idempotency conflict and resolves the canonical
 * sequence by replaying the branch (audit finding F-14). The in-memory
 * ledger, permit, and replay cursor are a fast path only: they answer known
 * duplicates without a journal write and keep a restarted server from
 * re-executing history, but correctness never depends on them.
 *
 * @since 0.1.0
 */

import { Journal } from "@smthrs/journal"
import * as JournalEvent from "@smthrs/journal/JournalEvent"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as RcMap from "effect/RcMap"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import {
  type BranchId,
  branchRunId,
  CommandEvent,
  type CommandId,
  CommandReceipt,
  commandSourceId,
  commandSourceSeq,
  CommandSubmission,
  SubmitRequest
} from "./BranchProtocol.ts"
import { maximumBranchTtlMs } from "./BranchRpcs.ts"
import * as BranchShare from "./BranchShare.ts"
import * as Admission from "./internal/Admission.ts"
import { causeCode } from "./internal/CauseText.ts"
import { journalErrorCode } from "./internal/JournalErrorCode.ts"
import { positiveInt } from "./internal/PolicyOptions.ts"
import { SyncError } from "./SyncError.ts"
import * as SyncProtocol from "./SyncProtocol.ts"

/**
 * Branch command admission operations.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  readonly submit: (request: SubmitRequest) => Effect.Effect<CommandReceipt, SyncError>
}

/**
 * The branch command ledger.
 *
 * @category services
 * @since 0.1.0
 */
export class BranchCommands extends Context.Service<BranchCommands, Service>()("@smthrs/sync/BranchCommands") {}

/**
 * Constructs a command ledger that admits nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  BranchCommands.of({
    submit: () => Effect.fail(new SyncError({ code: "closed", message: "Branch commands are unavailable" })),
    ...overrides
  })

/**
 * Provides a command ledger that admits nothing.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop: Layer.Layer<BranchCommands> = Layer.succeed(BranchCommands, makeNoop())

/**
 * Projects a journal write failure onto the sync boundary.
 *
 * The public `message` is a constant and the `cause` names the failure's type
 * only. A branch writer may hold nothing but a share link, and the journal's
 * own message is the SQLite driver's, which carries SQL text, table and column
 * names, and constraint identifiers. The CODE is a different question from the
 * message: a journal code this boundary also declares crosses as that code, so
 * a writer whose commit was lost to a closing journal is told that rather than
 * being told nothing.
 */
const journalFailure = (cause: unknown): SyncError =>
  new SyncError({
    code: journalErrorCode(cause),
    message: "Branch journal write failed",
    cause: causeCode(cause)
  })

/** How many entries one rehydration page reads. */
const pageSize = 256

/**
 * Receipts one branch keeps in memory before the oldest are evicted.
 *
 * The ledger is a fast path: it answers a known duplicate without a journal
 * write, and losing an entry costs a round trip, never correctness, because
 * the journal's own producer identity is the durable exactly-once constraint
 * and returns a `Duplicate` receipt for a command already admitted. Retaining
 * one receipt per command forever meant a process serving a hundred branches
 * of a hundred thousand commands held ten million of them, so the fast path
 * is bounded and the durable path is what makes it safe to bound.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultLedgerCapacity = 4096

/**
 * Inclusive UTF-8 JSON submission ceiling. The separate sync entry ceiling
 * leaves room for the durable envelope around every admitted command.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultMaxCommandBytes = 1024 * 1024

/**
 * Milliseconds a branch may have no active submissions before its in-memory state is
 * dropped.
 *
 * The receipt ledger is bounded per branch; this bounds the branches. A
 * dropped branch re-hydrates on its next submission exactly as it does after
 * a restart, so eviction costs a journal read, never correctness. The default
 * is the longest lifetime a branch capability may carry, so a branch is only
 * dropped once every capability minted at its last touch can have expired.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultBranchIdleMs = maximumBranchTtlMs

/**
 * Entries one branch's first-touch hydration reads before it stops.
 *
 * Hydration is the only full history read that ever sat on the WRITE path: the
 * first submission a process makes to a branch paged that branch's whole
 * durable log, 256 entries at a time, while holding the branch's admission
 * permit, before its own append was attempted. A hundred-thousand-entry branch
 * therefore charged its next writer four hundred journal reads for a fast path
 * that keeps four thousand receipts.
 *
 * The budget defaults to {@link defaultLedgerCapacity} because hydration
 * cannot seed more receipts than the ledger holds: everything a longer walk
 * records displaces something the same walk already recorded. What the extra
 * reads buy is a FRESHER selection — the tail of history rather than its head
 * — and the price is an unbounded wait on somebody's write. This trades that
 * back: the walk stops, the cursor stays where it stopped, and a later replay
 * continues forward from there.
 *
 * A branch longer than the budget starts with a partly cold fast path and
 * nothing else. Correctness never rested on the ledger: the journal's producer
 * identity is the durable exactly-once constraint, an exact retry receives a
 * `Duplicate` receipt carrying the canonical sequence, and an
 * `idempotency_conflict` is resolved by a read of the whole history that the
 * ledger's own bound already made necessary.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const defaultHydrationLimit = defaultLedgerCapacity

/**
 * Admission policy.
 *
 * The default caps one encoded command submission at 1 MiB, one branch's
 * in-memory receipt ledger at {@link defaultLedgerCapacity} commands, and one
 * branch's first-touch hydration at {@link defaultHydrationLimit} entries.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Largest encoded journal entry followers accept. Defaults to
   * {@link SyncProtocol.defaultMaxFrameBytes}. Configure the server and client
   * with the same or a larger ceiling. Admission reserves the full durable
   * envelope, including generated sequence and timestamp fields, before writing.
   */
  readonly maxFrameBytes?: number | undefined
  /**
   * Largest encoded command submission admitted, in bytes. Defaults to
   * {@link defaultMaxCommandBytes}.
   */
  readonly maxCommandBytes?: number | undefined
  /**
   * Receipts one branch keeps in memory before the oldest are evicted.
   * Defaults to {@link defaultLedgerCapacity}.
   */
  readonly ledgerCapacity?: number | undefined
  /**
   * Entries one branch's first-touch hydration reads before it stops.
   * Defaults to {@link defaultHydrationLimit}.
   */
  readonly hydrationLimit?: number | undefined
  /**
   * Milliseconds a branch may have no active submissions before its in-memory state is
   * dropped. Defaults to {@link defaultBranchIdleMs}.
   */
  readonly branchIdleMs?: number | undefined
}

/** Everything one process holds for one branch. */
interface BranchState {
  // One permit PER BRANCH. A single process-wide permit serialized admission
  // across every branch the process served, so one branch's first-touch
  // history replay blocked every other branch's writes.
  readonly permit: Semaphore.Semaphore
  receipts: Map<CommandId, CommandReceipt>
  cursor: JournalEvent.Seq | undefined
  hydrated: boolean
}

/** The ledger over an already-validated policy. */
const makeWith = (
  resolved: {
    readonly maxCommandBytes: number
    readonly maxFrameBytes: number
    readonly ledgerCapacity: number
    readonly hydrationLimit: number
    readonly branchIdleMs: number
  }
): Effect.Effect<Service, never, Journal.Journal | BranchShare.BranchShare | Scope.Scope> =>
  Effect.gen(
    function*() {
      const journal = yield* Journal.Journal
      const share = yield* BranchShare.BranchShare
      const { branchIdleMs, hydrationLimit, ledgerCapacity, maxCommandBytes, maxFrameBytes } = resolved
      // Active submissions share one state; its idle lifetime starts at release.
      const branches = yield* RcMap.make({
        idleTimeToLive: branchIdleMs,
        lookup: (_branchId: BranchId) =>
          Effect.sync((): BranchState => ({
            permit: Semaphore.makeUnsafe(1),
            receipts: new Map(),
            cursor: undefined,
            hydrated: false
          }))
      })

      /**
       * Records one receipt, evicting the branch's oldest once the branch is
       * at capacity. `Map` iterates in insertion order, so the first key is
       * the least recently recorded one; re-recording a known command
       * refreshes it in place rather than growing the branch.
       */
      const recordIn = (branch: Map<CommandId, CommandReceipt>, receipt: CommandReceipt): void => {
        branch.delete(receipt.commandId)
        branch.set(receipt.commandId, receipt)
        for (const oldest of branch.keys()) {
          if (branch.size <= ledgerCapacity) break
          branch.delete(oldest)
        }
      }

      const duplicateOf = (known: CommandReceipt): CommandReceipt =>
        new CommandReceipt({
          branchId: known.branchId,
          commandId: known.commandId,
          status: "duplicate",
          seq: known.seq
        })

      /**
       * Pages a branch's journal forward from `from`, handing each entry to
       * `visit` along with the command identity it carries, if any, and
       * stopping once it has visited `budget` entries. Admission already
       * decoded every command payload in full, so the identity is read off
       * that decoded command rather than decoded a second time.
       *
       * The budget is entries VISITED, not pages read, so a caller names a
       * bound in the unit its own memory is measured in.
       * `Number.POSITIVE_INFINITY` is the unbounded walk the recovery reads
       * take: they answer a question about the whole durable history, and a
       * bounded answer to that question is a wrong one.
       */
      const walk = (
        branchId: BranchId,
        from: JournalEvent.Seq | undefined,
        budget: number,
        visit: (entry: JournalEvent.Entry, commandId: CommandId | undefined) => void
      ): Effect.Effect<void, SyncError> =>
        Effect.gen(function*() {
          const runId = branchRunId(branchId)
          let after = from
          let hasMore = true
          let remaining = budget
          while (hasMore && remaining > 0) {
            const page = yield* journal.entries({
              runId,
              ...(after === undefined ? {} : { after }),
              limit: Math.min(pageSize, remaining)
            }).pipe(Effect.mapError(journalFailure))
            const admitted = yield* Admission.withCommands(page.entries, runId, after ?? -1)
            for (const { command, entry } of admitted) {
              after = entry.seq
              remaining -= 1
              visit(entry, command?.commandId)
            }
            // An empty page ends the walk whatever the page claims, the same
            // guard `SyncServer.tail` carries: `after` cannot move, so the
            // next read is byte-identical and the loop would never terminate
            // — while holding this branch's admission permit.
            if (page.entries.length === 0) return
            hasMore = page.hasMore
          }
        })

      /**
       * Replays the branch journal forward from the last replayed sequence into
       * the ledger. Used once on first touch, so a process that restarts
       * mid-collaboration still recognises every command it already admitted,
       * and again after an admission conflict, to read the command another
       * writer admitted after this process last looked.
       *
       * The staged cursor tracks each visited entry. A successful bounded walk
       * commits exactly where it stopped, so the next replay resumes there.
       * Failure or interruption discards the staged cursor and receipts together.
       */
      const replay = (branchId: BranchId, state: BranchState, budget: number): Effect.Effect<void, SyncError> =>
        Effect.gen(function*() {
          // Stage at most ledgerCapacity receipts. A malformed later page or an
          // interruption must leave both the ledger and replay cursor untouched.
          const staged = new Map(state.receipts)
          let position = state.cursor
          yield* walk(branchId, position, budget, (entry, commandId) => {
            position = entry.seq
            if (commandId !== undefined) {
              recordIn(staged, new CommandReceipt({ branchId, commandId, status: "admitted", seq: entry.seq }))
            }
          })
          state.cursor = position
          state.receipts = staged
        })

      /**
       * The sequence one command was admitted at, read from the branch's whole
       * durable history rather than from the ledger.
       *
       * The ledger is BOUNDED, so the receipt for a command admitted far
       * enough back has been evicted, and a forward replay from the ledger's
       * own cursor can never bring it back — the entry is below that cursor.
       * The durable log still holds it, and this is the read that says so.
       * Neither the cursor nor the ledger moves: this answers one question
       * about history and leaves the fast path exactly as it found it.
       */
      const admittedSeq = (
        branchId: BranchId,
        commandId: CommandId
      ): Effect.Effect<JournalEvent.Seq | undefined, SyncError> =>
        Effect.gen(function*() {
          let found: JournalEvent.Seq | undefined
          yield* walk(branchId, undefined, Number.POSITIVE_INFINITY, (entry, admitted) => {
            if (admitted === commandId) found = entry.seq
          })
          return found
        })

      /**
       * Seeds the branch's fast path ONCE, from its durable history, within
       * the configured budget (see {@link defaultHydrationLimit}).
       *
       * It runs on the write path, inside the branch's admission permit, so
       * the budget is what keeps the length of a branch's history out of the
       * latency of the next submission to it. The branch is marked hydrated
       * whether or not the walk reached the tail, because the point of the
       * budget is that no submission pays for the rest: what the walk did not
       * reach is answered by the journal, and by the unbounded replay
       * {@link lostRace} runs when the journal reports a conflict.
       */
      const hydrate = (branchId: BranchId, state: BranchState): Effect.Effect<void, SyncError> =>
        Effect.gen(function*() {
          if (state.hydrated) return
          yield* replay(branchId, state, hydrationLimit)
          state.hydrated = true
        })

      /**
       * The losing side of a cross-server admission race: the journal refused
       * this append because another writer already holds the command's producer
       * identity with different content — same `commandId`, different
       * participant or arguments. The original admission is durable, so
       * replaying the branch forward must surface it; a replay that does not is
       * a journal whose conflict report and entries disagree, and that failure
       * is reported honestly instead of being masked as a duplicate.
       *
       * Two reads, because the ledger is bounded and the answer must not be.
       * The forward replay picks up an admission another writer landed after
       * this process last looked. A command this process admitted itself and
       * has since evicted is BELOW that cursor, so only a read of the whole
       * history finds it — and without one, bounding the ledger turned an
       * ordinary duplicate into a report that the journal contradicts itself.
       */
      const lostRace = (
        submission: CommandSubmission,
        state: BranchState,
        cause: Journal.JournalError
      ): Effect.Effect<CommandReceipt, SyncError> =>
        Effect.gen(function*() {
          // Unbounded, unlike hydration: this is the recovery read, and the
          // sequence it is looking for may sit anywhere in the history.
          yield* replay(submission.branchId, state, Number.POSITIVE_INFINITY)
          const known = state.receipts.get(submission.commandId)
          if (known !== undefined) return duplicateOf(known)
          // A branch still under the ledger's capacity has never evicted
          // anything, and `replay` has just read this branch to its tail, so a
          // command missing from the ledger is missing from the journal too.
          // Reading the whole history to confirm that would let one small
          // request cost one full log scan.
          const mayHaveEvicted = state.receipts.size >= ledgerCapacity
          const seq = mayHaveEvicted
            ? yield* admittedSeq(submission.branchId, submission.commandId)
            : undefined
          if (seq === undefined) return yield* Effect.fail(journalFailure(cause))
          return new CommandReceipt({
            branchId: submission.branchId,
            commandId: submission.commandId,
            status: "duplicate",
            seq
          })
        })

      const journalInput = (submission: CommandSubmission): JournalEvent.Input =>
        new JournalEvent.Input({
          runId: branchRunId(submission.branchId),
          sourceId: commandSourceId(submission.commandId),
          sourceSeq: commandSourceSeq,
          eventType: CommandEvent,
          payload: {
            branchId: submission.branchId,
            commandId: submission.commandId,
            participantId: submission.participantId,
            name: submission.name,
            args: submission.args,
            target: submission.target
          },
          meta: null
        })

      const admit = (request: SubmitRequest, state: BranchState): Effect.Effect<CommandReceipt, SyncError> =>
        Effect.gen(function*() {
          const submission = request.submission
          yield* hydrate(submission.branchId, state)
          const known = state.receipts.get(submission.commandId)
          if (known !== undefined) return duplicateOf(known)
          // Unfenced: the sync command journal is a multi-writer admission
          // log — participants own no branch run, and command admissions are
          // first-writer-wins on the command id.
          const receipt = yield* journal.emitDurableUnfenced(
            journalInput(submission)
          ).pipe(
            // A `Duplicate` receipt is another writer landing the identical
            // submission first: the journal deduplicated durably and returned
            // the canonical sequence the original append committed at.
            Effect.map((accepted) =>
              new CommandReceipt({
                branchId: submission.branchId,
                commandId: submission.commandId,
                status: accepted._tag === "Duplicate" ? "duplicate" : "admitted",
                seq: accepted.seq
              })
            ),
            Effect.catch((cause) =>
              cause.code === "idempotency_conflict"
                ? lostRace(submission, state, cause)
                : Effect.fail(journalFailure(cause))
            )
          )
          recordIn(
            state.receipts,
            new CommandReceipt({
              branchId: submission.branchId,
              commandId: submission.commandId,
              status: "admitted",
              seq: receipt.seq
            })
          )
          return receipt
        })

      const submit = Effect.fn("BranchCommands.submit")(function*(supplied: SubmitRequest) {
        const decoded = yield* Admission.decode(SubmitRequest, supplied, "invalid_request")
        // Freeze the authorized submission across asynchronous signature verification.
        const request = { capability: decoded.capability, submission: { ...decoded.submission } }
        yield* Effect.annotateCurrentSpan({
          branchId: request.submission.branchId,
          commandId: request.submission.commandId,
          participantId: request.submission.participantId
        })
        yield* share.verify(request.capability, { branchId: request.submission.branchId, access: "write" })
        const bytes = SyncProtocol.encodedByteLength(request.submission)
        if (bytes > maxCommandBytes) {
          // Refused BEFORE the append: an oversized command must never reach
          // the journal, and therefore never reaches any follower.
          return yield* Effect.fail(
            new SyncError({
              code: "frame_too_large",
              message: `Encoded command submission of ${bytes} bytes exceeds the ${maxCommandBytes}-byte ceiling`
            })
          )
        }
        const input = journalInput(request.submission)
        // The journal owns these fields. Reserve their largest encoded forms,
        // so acceptance does not depend on wall clock or current history length.
        // Event identity repeats run/source IDs; their escaping and UTF-8 cost
        // must be measured, not replaced by a fixed envelope allowance.
        const entryBytes = SyncProtocol.encodedByteLength({
          ...input,
          seq: Number.MAX_SAFE_INTEGER - 1,
          eventId: JournalEvent.makeEventId(input.runId, input.sourceId, commandSourceSeq),
          emittedAtMs: Number.MAX_VALUE
        })
        if (entryBytes > maxFrameBytes) {
          return yield* Effect.fail(
            new SyncError({
              code: "frame_too_large",
              message:
                `Encoded command journal entry requires up to ${entryBytes} bytes, exceeding the ${maxFrameBytes}-byte frame ceiling`
            })
          )
        }
        // The permit is taken AFTER authorization so an unauthorized caller
        // cannot serialize (and therefore stall) legitimate collaborators,
        // and it is this BRANCH's permit so a slow branch stalls only itself.
        return yield* RcMap.get(branches, request.submission.branchId).pipe(
          Effect.flatMap((state) => state.permit.withPermit(admit(request, state))),
          Effect.scoped
        )
      })

      return BranchCommands.of({ submit })
    }
  )

const defaults = {
  maxCommandBytes: defaultMaxCommandBytes,
  maxFrameBytes: SyncProtocol.defaultMaxFrameBytes,
  ledgerCapacity: defaultLedgerCapacity,
  hydrationLimit: defaultHydrationLimit,
  branchIdleMs: defaultBranchIdleMs
}

/**
 * Constructs the journal-backed branch command ledger under an explicit
 * policy. The caller scope owns cached states and their idle-expiration timers.
 *
 * A submission whose encoded form exceeds the command ceiling is refused with
 * `frame_too_large` before anything is appended, so one oversized `args`
 * cannot enter the branch journal and poison every follower that replays it.
 *
 * First-touch hydration reads at most `hydrationLimit` entries, so the length
 * of a branch's history is not charged to the next writer's latency; see
 * {@link defaultHydrationLimit} for why the fast path may be seeded partially
 * without any effect on what the ledger admits.
 *
 * Every option is validated as a positive safe integer at construction: the
 * TypeScript type says `number`, and `NaN` silently disabled the ceiling it
 * was compared against.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeLiveWith = (
  options: Options = {}
): Effect.Effect<Service, SyncError, Journal.Journal | BranchShare.BranchShare | Scope.Scope> =>
  Effect.flatMap(
    Effect.all({
      maxFrameBytes: positiveInt(
        "BranchCommands.Options.maxFrameBytes",
        options.maxFrameBytes,
        defaults.maxFrameBytes
      ),
      maxCommandBytes: positiveInt(
        "BranchCommands.Options.maxCommandBytes",
        options.maxCommandBytes,
        defaults.maxCommandBytes
      ),
      ledgerCapacity: positiveInt(
        "BranchCommands.Options.ledgerCapacity",
        options.ledgerCapacity,
        defaults.ledgerCapacity
      ),
      hydrationLimit: positiveInt(
        "BranchCommands.Options.hydrationLimit",
        options.hydrationLimit,
        defaults.hydrationLimit
      ),
      branchIdleMs: positiveInt(
        "BranchCommands.Options.branchIdleMs",
        options.branchIdleMs,
        defaults.branchIdleMs
      )
    }),
    makeWith
  )

/**
 * Constructs the journal-backed branch command ledger with default policy.
 * The caller scope owns cached states and their idle-expiration timers.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeLive: Effect.Effect<Service, never, Journal.Journal | BranchShare.BranchShare | Scope.Scope> =
  makeWith(defaults)

/**
 * Provides the journal-backed branch command ledger.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<BranchCommands, never, Journal.Journal | BranchShare.BranchShare> = Layer.effect(
  BranchCommands,
  makeLive
)

/**
 * Provides the journal-backed branch command ledger under an explicit policy.
 * Fails with `invalid_request` when an option is not a positive safe integer.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerWith = (
  options: Options
): Layer.Layer<BranchCommands, SyncError, Journal.Journal | BranchShare.BranchShare> =>
  Layer.effect(BranchCommands, makeLiveWith(options))

/**
 * Builds a submission, filling in the fields a plain command never sets, and
 * refusing a field the schema forbids with a `SyncError` rather than a defect.
 *
 * @category constructors
 * @since 0.1.0
 */
export const submission = (fields: {
  readonly branchId: BranchId
  readonly commandId: CommandId
  readonly participantId: CommandSubmission["participantId"]
  readonly name: string
  readonly args?: string
  readonly target?: string
}): Effect.Effect<CommandSubmission, SyncError> =>
  // Decoded, not constructed: `name` is a `NonEmptyString` the parameter type
  // admits `""` for, and `new CommandSubmission` throws on it. A builder that
  // dies on a caller's argument is the same defect `submit` already refuses
  // typed, one call earlier.
  Admission.decode(CommandSubmission, {
    branchId: fields.branchId,
    commandId: fields.commandId,
    participantId: fields.participantId,
    name: fields.name,
    args: fields.args ?? "",
    target: fields.target ?? ""
  }, "invalid_request")
