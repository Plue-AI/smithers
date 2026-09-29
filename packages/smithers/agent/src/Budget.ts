/**
 * What a run may spend across its model calls, and what happens when it has
 * spent it.
 *
 * Two ceilings already existed and neither is this one. `Sandbox.Limits` bounds
 * one cell's own execution, and `Agent.Options.maxFrames` bounds one loop's
 * turns. Both are per call. Nothing accumulated what a run had spent across its
 * steps, so `Envelope.budget` — the tokens and milliseconds a control plane
 * APPROVED for a plan — bound nothing at all: a plan could be admitted for a
 * thousand tokens and spend a million.
 *
 * Old smithers spelled this `<Aspects tokenBudget latencySlo>` and enforced it
 * at dispatch, from usage accumulated over the run. This is the same rule at
 * the same place: the enforcement point is the model boundary in
 * {@link module:FlowEngineLike}, which every model call in the composition
 * passes through, so a budget cannot be evaded by a step that assembles its own
 * loop.
 *
 * Its accounting and admission rules are:
 *
 * - **The accumulator is per run, keyed by the model step's content key, and
 *   projected from the journal.** Every call writes a {@link usageEvent}
 *   record and the run's first question writes a {@link budgetStartedEvent}
 *   record on the journal's DURABLE channel. A skip-remaining refusal writes a
 *   {@link budgetLatchedEvent} record there too. A budget entering a run folds
 *   all three back before it decides anything. This is what makes a budget survive
 *   a restart: the engine resumes a run from its recorded NODE results and
 *   never re-enters a settled step's body, so memory-only usage would hand a
 *   resumed run a second token allowance and a memory-only clock would re-arm
 *   its latency allowance. Keying by the content key is the other half: a
 *   replayed call and its own recovered record are the same key, so it counts
 *   once. Keying the accumulator itself by execution id is the third: one
 *   layer built at composition level serves every run the engine drives, and a
 *   single shared tally would spend run A's tokens out of run B's allowance.
 * - **The accounting fails closed.** A budget whose record could not be
 *   written, whose ledger could not be read or decoded, or whose ledger is
 *   longer than one recovery reads raises {@link AccountingUnavailable}
 *   instead of answering. Every one of those is a run that would come back
 *   from a restart with an allowance it has already spent, and the difference
 *   between a budget and a decoration is that it refuses rather than guesses.
 *   Only the {@link budgetWarningEvent} record is allowed to be lost: nothing
 *   reads it back, so losing one costs a line in an operator view and no
 *   decision.
 * - **Admission reserves a soft forecast.** Before dispatch, `reserve` counts
 *   actual spend plus all in-flight estimates, using the largest observed
 *   call. Before a positive cost is known, one call holds the whole allowance.
 *   Zero refuses new calls unless `warn` explicitly permits them. Scope exit
 *   releases reservations; recorded usage replaces the estimate. `check` only
 *   previews admission and must not be used as a concurrency guard.
 *
 * A forecast is not a provider billing cap: admitted calls may cost more than
 * estimated, including the first call. One shared Budget instance coordinates
 * concurrent calls of each run; independent instances are not a distributed
 * quota service. Durable execution ownership must prevent multiple hosts from
 * dispatching the same run concurrently.
 *
 * `onExceeded` is the composition's choice of what that means: `fail` reports a
 * typed {@link BudgetExceeded}, `warn` journals and proceeds,
 * `skip-remaining` latches, so every later call in the run is refused without
 * asking a provider anything, and `park` refuses the call without latching so
 * the host can suspend the run until an operator approves a raised ceiling
 * ({@link raise}, {@link raisedBy}).
 *
 * @since 0.1.0
 */

import type * as ControlSchema from "@smthrs/control/ControlSchema"
import { digest } from "@smthrs/core/Digest"
import { FlowRuntime } from "@smthrs/flow"
import type * as RetryPolicy from "@smthrs/flow/RetryPolicy"
import type * as HarnessError from "@smthrs/harness/HarnessError"
import { Journal, JournalEvent } from "@smthrs/journal"
import type * as ModelEvent from "@smthrs/model/ModelEvent"
import { BudgetOnExceeded } from "@smthrs/registry/Descriptor"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import { failureJson } from "./internal/FailureJson.ts"
import type * as RunawayGuard from "./RunawayGuard.ts"

/**
 * What a composition wants done when a budget runs out.
 *
 * @category models
 * @since 0.1.0
 */
export const OnExceeded = BudgetOnExceeded

/**
 * What a composition wants done when a budget runs out.
 *
 * @category models
 * @since 0.1.0
 */
export type OnExceeded = typeof OnExceeded.Type

/**
 * The soft token admission ceiling for one run, and what exceeding it means.
 * Actual provider charges can exceed their pre-dispatch forecasts.
 *
 * @category models
 * @since 0.1.0
 */
export interface TokenBudget {
  /** Non-negative safe integer; omit the whole token policy for no ceiling. */
  readonly max: number
  readonly onExceeded?: OnExceeded | undefined
}

/**
 * The active-time ceiling for one run, and what exceeding it means.
 *
 * It bounds when a call may START, not how long one may take: a call already
 * in flight is the provider's clock, and cutting it off is
 * `Agent.Options.modelCallMs`, which exists and is a different budget.
 * Its zero is the run's first budget question and is durable, so a park or
 * process restart does not grant the run the whole interval again. Time the
 * run spends suspended, waiting on an approval, a question, or a budget raise,
 * is not active time: {@link Service.suspend} and {@link Service.resume}
 * record those spans durably and the ceiling subtracts them (#2120).
 *
 * @category models
 * @since 0.1.0
 */
export interface LatencyBudget {
  /** Finite, non-negative milliseconds; fractional durations are allowed. */
  readonly maxMillis: number
  readonly onExceeded?: OnExceeded | undefined
}

/**
 * Relative charges for uncached input, cached input and output tokens.
 * @category schemas
 * @since 0.1.0
 */
export const TokenWeights = Schema.Struct({
  input: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  cachedInput: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  output: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
})

/** Per-model token charges keyed by canonical model ID.
 * @category models
 * @since 0.1.0
 */
export type Weights = Readonly<Record<string, typeof TokenWeights.Type>>

/**
 * Everything one composition declares about spending.
 *
 * An empty policy is a real policy: it accumulates usage and refuses nothing,
 * which is what a run wants when the numbers are for reporting.
 *
 * @category models
 * @since 0.1.0
 */
export interface Policy {
  readonly weights?: Weights | undefined
  readonly tokens?: TokenBudget | undefined
  readonly latency?: LatencyBudget | undefined
  /**
   * Tokens per UTC day across every run recorded in the {@link Options.ledger}.
   * A crossed cap always fails; it is a tripwire, never a park or a skip.
   */
  readonly daily?: DailyBudget | undefined
}

/**
 * The per-UTC-day token ceiling across runs.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface DailyBudget {
  /** Positive safe integer. */
  readonly max: number
}

/**
 * One charged model step as a {@link Ledger} keeps it.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface LedgerEntry {
  /** The UTC day, `YYYY-MM-DD`, the step was charged on. */
  readonly day: string
  readonly runId: string
  readonly stepKey: string
  readonly spent: number
}

/**
 * Durable spend that outlives one run and one process: what a per-day cap sums,
 * and what a run without a journal recovers its own spend from.
 *
 * `record` is idempotent in `(runId, stepKey)`; the first entry wins.
 *
 * @category services
 * @since 1.0.0-rc.1
 */
export interface Ledger {
  readonly total: (day: string) => Effect.Effect<number, unknown>
  readonly record: (entry: LedgerEntry) => Effect.Effect<void, unknown>
  readonly run: (runId: string) => Effect.Effect<ReadonlyMap<string, number>, unknown>
}

/**
 * An in-process {@link Ledger}, for tests and hosts with no durable store.
 *
 * @category constructors
 * @since 1.0.0-rc.1
 */
export const memoryLedger = (): Ledger => {
  const entries = new Map<string, LedgerEntry>()
  const id = (runId: string, stepKey: string) => JSON.stringify([runId, stepKey])
  return {
    total: (day) =>
      Effect.sync(() => {
        let sum = 0
        for (const entry of entries.values()) if (entry.day === day) sum += entry.spent
        return sum
      }),
    record: (entry) =>
      Effect.sync(() => {
        const key = id(entry.runId, entry.stepKey)
        if (!entries.has(key)) entries.set(key, entry)
      }),
    run: (runId) =>
      Effect.sync(() =>
        new Map(
          [...entries.values()].filter((entry) => entry.runId === runId).map((entry) => [entry.stepKey, entry.spent])
        )
      )
  }
}

const utcDay = (millis: number): string => new Date(millis).toISOString().slice(0, 10)

/**
 * Invalid spending policy or accounting bounds, rejected when the budget is
 * built, before a model can be dispatched. Omit a ceiling to leave it unbounded;
 * `NaN`, infinity, negative limits, and unknown exceeded policies are not opt-outs.
 *
 * @category errors
 * @since 1.0.0-rc.0
 */
export class ConfigurationError extends Schema.TaggedError<ConfigurationError>()(
  "flows/agent/BudgetConfigurationError",
  { message: Schema.String }
) {}

/**
 * A run that would exceed what it was approved for.
 *
 * `used` is actual spend, `reserved` the forecast held by other in-flight
 * calls, `max` the soft admission ceiling, and `next` the refused call's
 * forecast. The largest observed call sets forecasts; before a positive cost
 * is known, one call reserves the full token allowance.
 *
 * @category errors
 * @since 0.1.0
 */
export class BudgetExceeded extends Schema.TaggedError<BudgetExceeded>()(
  "flows/agent/BudgetExceeded",
  {
    scope: Schema.Literals(["tokens", "latency", "daily"]),
    onExceeded: OnExceeded,
    used: Schema.Number,
    /** Forecast held by other in-flight calls; absent on older encoded errors. */
    reserved: Schema.optional(Schema.Number),
    max: Schema.Number,
    next: Schema.Number,
    message: Schema.String
  }
) {}

/**
 * The tag {@link Skipped} carries on the wire.
 *
 * @category errors
 * @since 0.1.0
 */
export const skippedTag = "flows/agent/Skipped"

/**
 * A model call refused because the run's budget already latched.
 *
 * `skip-remaining` is not the same verdict as `fail`. `fail` reports the call
 * that would have overspent; `skip-remaining` reports every call after it,
 * including calls in steps that had nothing to do with the overspend. An
 * operator reading a run needs to tell the step that broke the budget from the
 * steps the broken budget skipped, and a supervisor needs to know that no
 * retry can change the answer: the latch is permanent for the run.
 *
 * The failure carries the {@link BudgetExceeded} it latched on, so the numbers
 * are the same ones the first refusal reported.
 *
 * @category errors
 * @since 0.1.0
 */
export class Skipped extends Schema.TaggedError<Skipped>()(
  skippedTag,
  {
    budget: BudgetExceeded,
    message: Schema.String
  }
) {}

/**
 * The budget could not account a run, so it will not say what the run may
 * spend.
 *
 * A budget is a projection of a durable ledger, and every way that ledger can
 * be unavailable is a way a resumed run gets its allowance back: a usage
 * record that was not written, a ledger that could not be read, a ledger
 * longer than one recovery reads. None of them is a smaller number — they are
 * an UNKNOWN number, and answering "proceed" to an unknown is how a run that
 * has spent its whole envelope keeps spending.
 *
 * So the seam fails instead. `phase` says which half broke: `record` is the
 * write after a call the accumulator counted, `recover` is the read a run
 * makes before its first decision. A usage `record` failure is worth retrying:
 * the model step it accounts is sealed, so a re-dispatch replays the recorded
 * answer and writes the record again rather than paying a provider twice. A
 * clock-zero `record` failure happens before the call and retries the write.
 * `cause` preserves the encodable shape of the underlying storage failure so
 * an operator keeps its tag, code, and fields alongside the human summary.
 *
 * @category errors
 * @since 0.1.0
 */
export class AccountingUnavailable extends Schema.TaggedError<AccountingUnavailable>()(
  "flows/agent/BudgetAccountingUnavailable",
  {
    phase: Schema.Literals(["record", "recover"]),
    /** The run whose ledger is unavailable. */
    runId: Schema.String,
    message: Schema.String,
    /**
     * The encodable storage or codec failure that made the ledger unavailable.
     *
     * @since 1.0.0-rc.0
     */
    cause: Schema.optional(Schema.Unknown)
  }
) {}

/**
 * The error tags no retry can turn into a success.
 *
 * A {@link Skipped} step is a verdict, not a transient failure: the latch is
 * set for the rest of the run, so a re-dispatch spends an attempt to be
 * refused identically without asking a provider anything.
 *
 * @category errors
 * @since 0.1.0
 */
export const nonRetryableTags: ReadonlyArray<string> = [skippedTag]

/**
 * Adds {@link nonRetryableTags} to a retry policy.
 *
 * A composition that retries model-backed steps builds its policy through
 * this. `RetryPolicy` classifies by tag, and a policy that does not name
 * {@link Skipped} re-dispatches every skipped step through its whole ladder.
 *
 * @example
 * ```ts
 * import * as Budget from "@smthrs/agent/Budget"
 * import { RetryPolicy } from "@smthrs/flow"
 *
 * const policy = Budget.neverRetrySkipped(RetryPolicy.defaultRetryPolicy)
 * ```
 *
 * @category errors
 * @since 0.1.0
 */
export const neverRetrySkipped = (policy: RetryPolicy.RetryPolicy): RetryPolicy.RetryPolicy => ({
  ...policy,
  nonRetryable: [
    ...(policy.nonRetryable ?? []),
    ...nonRetryableTags.filter((tag) => !(policy.nonRetryable ?? []).includes(tag))
  ]
})

/**
 * What one run has spent so far.
 *
 * @category models
 * @since 0.1.0
 */
export interface Usage {
  readonly tokens: number
  /** Charged sealed steps and unsealed invocations, each counted exactly once. */
  readonly calls: number
  /** The largest single call, which is what the next one is projected to cost. */
  readonly largestCall: number
}

/**
 * The answer to "may this call be made".
 *
 * @category models
 * @since 0.1.0
 */
export type Verdict =
  | { readonly _tag: "proceed" }
  | { readonly _tag: "warn"; readonly exceeded: BudgetExceeded }
  | {
    readonly _tag: "refuse"
    /** The ceiling and the numbers that broke it. */
    readonly exceeded: BudgetExceeded
    /**
     * The error the caller raises. It is {@link Skipped} once the run has
     * latched and the {@link BudgetExceeded} itself otherwise, so the step
     * that broke the budget and the steps the broken budget skipped report
     * different failures.
     */
    readonly failure: BudgetExceeded | Skipped
  }

/**
 * The budget a composition enforces.
 *
 * @category services
 * @since 0.1.0
 */
export interface Service {
  /**
   * Decides whether the model call keyed by `stepKey` may be made.
   *
   * The key is what makes a verdict attributable, and attribution is the whole
   * difference between a budget and a trap on a resumed run. A run resumes by
   * re-executing its frames, so it asks this again for every model step it has
   * already paid for — and those steps replay from the journal without asking a
   * provider anything. A projection that adds the next call's estimate to a
   * ledger that already holds this very step refuses a call that costs zero,
   * and a run killed after its last model call comes back dead on arrival.
   *
   * So a step the ledger has already counted proceeds, whatever the ceiling
   * says. `undefined` is the honest answer for a caller with no key, and it
   * gets the projection, because a call the ledger cannot recognize is a call
   * the run has not made.
   */
  readonly check: (stepKey: string | undefined) => Effect.Effect<Verdict, AccountingUnavailable>
  /**
   * Atomically admits a sealed step and reserves its forecast until the
   * current scope closes. Use this at dispatch; `check` is advisory only.
   * `record` reconciles the forecast with actual usage. Duplicate keys share
   * one reservation, assuming the engine deduplicates their provider work.
   * One Budget instance must serve all concurrent calls of a run.
   */
  readonly reserve: (stepKey: string) => Effect.Effect<Verdict, AccountingUnavailable, Scope.Scope>
  /**
   * Accounts finite, non-negative usage, idempotently in its step key. A
   * failed/uncommitted write remains pending and retryable; new uncounted
   * steps fail closed until it commits. Retries must supply the same cost.
   */
  readonly record: (
    stepKey: string,
    usage: ModelEvent.Usage,
    modelId?: string
  ) => Effect.Effect<void, AccountingUnavailable>
  /** What the CURRENT run has spent. Outside a run, what the caller recorded. */
  readonly usage: Effect.Effect<Usage, AccountingUnavailable>
  /**
   * What one named run has spent, whether or not this process is driving it.
   *
   * A budget accounts per run, so a composition-level service holds many
   * tallies and `usage` alone cannot name which. A run this process is driving
   * answers from its live accumulator; any other run answers from the durable
   * usage records it left, which is how a supervisor reads the spend of a run
   * that is parked, finished, or owned by another host.
   * {@link module:Budget.looseRunId} names the tally of calls recorded outside
   * any run.
   */
  readonly usageOf: (runId: string) => Effect.Effect<Usage, AccountingUnavailable>
  /**
   * Records that the CURRENT run suspended now, so the time until it resumes
   * is not charged to its latency ceiling. A run already suspended keeps its
   * earlier start.
   */
  readonly suspend: Effect.Effect<void, AccountingUnavailable>
  /**
   * Records that the CURRENT run is executing again, closing its open
   * suspension at `at` (now when omitted). Admission closes one too, because a
   * run making a model call is executing. A host that could not record the
   * resume retries it with the instant the run actually resumed, and does no
   * work until it succeeds: until then the span stays open, and the work would
   * be subtracted as parked time.
   */
  readonly resume: (at?: number) => Effect.Effect<void, AccountingUnavailable>
}

/**
 * The {@link Service} tag.
 *
 * @category services
 * @since 0.1.0
 */
export class Budget extends Context.Service<Budget, Service>()("@smthrs/agent/Budget") {}

/**
 * A registered budget park: the wait the run suspends under, and the failure
 * that suspends its frame.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export interface Parked {
  readonly waiting: FlowRuntime.WaitingAnnotation
  readonly failure: HarnessError.HarnessError
}

/**
 * Parks a run whose `park` budget refused a call.
 *
 * The host that owns approvals provides it: it registers the request for a
 * {@link raise}d budget and answers with the {@link Parked} wait. The model
 * boundary declares that wait when the frame suspends, not before, because
 * the run's other fibers re-declare their own waits until then. A composition
 * without it fails the call with the {@link BudgetExceeded}, as `fail` does.
 *
 * @category services
 * @since 1.0.0-rc.1
 */
export class Parking extends Context.Service<Parking, {
  readonly park: (exceeded: BudgetExceeded) => Effect.Effect<Parked, HarnessError.HarnessError>
  /**
   * Whether a {@link RunawayGuard.Timeout} parks the run. When false every
   * timeout keeps its own behavior: an exhausted model call fails the run, and
   * a tool call or cell reports its timeout to the cell.
   */
  readonly guardsTimeouts: boolean
  /**
   * Parks the run on a tripped timeout with its {@link RunawayGuard.incident}
   * facts. A subject the operator already continued asks again under a new
   * request; one the operator stopped fails with {@link RunawayGuard.stopped}.
   */
  readonly trip: (timeout: RunawayGuard.Timeout) => Effect.Effect<Parked, HarnessError.HarnessError>
  /**
   * Admits work on a subject a timeout may have parked: how many times the
   * operator chose Continue for it, the park when its question is still
   * open, or {@link RunawayGuard.stopped} when the operator chose Stop. The
   * decisions are read once per host drive, because a decision only takes
   * effect by driving the run again.
   */
  readonly admit: (
    subject: string
  ) => Effect.Effect<
    { readonly _tag: "proceed"; readonly continued: number } | { readonly _tag: "park"; readonly parked: Parked },
    HarnessError.HarnessError
  >
}>()("@smthrs/agent/Budget/Parking") {}

/**
 * The journal event one allowed-over-budget call writes.
 *
 * @category records
 * @since 0.1.0
 */
export const budgetWarningEvent = "flows.agent.budget-warning.v1"

/**
 * The journal event one accounted model call writes.
 *
 * Unlike {@link budgetWarningEvent}, which is evidence, this record is READ
 * BACK: a budget entering a resumed run projects its accumulator from these
 * records, because the engine resumes from recorded node results and never
 * re-enters a settled step. That is why it goes on the DURABLE channel and the
 * warning does not. The lossy channel is documented as droppable telemetry —
 * `Dropped` receipts and `drop-oldest` evictions are acceptable there — and a
 * dropped record here would silently hand a resumed run a second allowance.
 *
 * The write is unfenced. A budget is a client of the run it accounts for, not
 * its owner, and the record advances nothing. A stable producer identity per
 * step deduplicates retries durably; different usage under that identity is
 * an error. The accumulator counts actual spend immediately but keeps its
 * write pending until the outer transaction commits, so rollback or an
 * interrupted write can never turn a retry into a successful no-op. A
 * composition with no journal at all (the reference memory engine) still
 * accounts within one process and simply recovers nothing across a restart.
 *
 * A write that FAILS is a different thing from a composition that keeps no
 * journal, and it is not ignored: it raises {@link AccountingUnavailable}, so
 * the step that made the call fails rather than the run continuing with spend
 * only this process remembers. The read side fails closed the same way when a
 * current-version record does not decode through {@link UsageRecord}: that is
 * a ledger this budget cannot read, not evidence that the call never happened.
 * If forward-compatible skipping is ever wanted, it must be gated on an
 * explicit version-field mismatch rather than on a failed current-version
 * decode.
 *
 * @category records
 * @since 0.1.0
 */
export const usageEvent = "flows.agent.usage.v1"

/**
 * The payload one {@link usageEvent} record carries.
 *
 * This is the wire format of a DURABLE record read back on resume, so it has
 * an owner on both the write and read side. A record that does not decode is a
 * ledger this budget cannot read rather than a call that never happened, and
 * recovery fails closed instead of handing the run that allowance again.
 *
 * The cost field is `spent` and not `tokens` because the journal REDACTS a
 * field whose name reads as a credential: `@smthrs/journal`'s
 * `Redaction.isSensitiveKey` strips one trailing plural and tests the suffix,
 * so `tokens` canonicalizes to `token` and the production `SqlJournal` writes
 * `"[REDACTED]"` in place of the number. Under the old field name every usage
 * record this module wrote came back unreadable, and the read side dropped it
 * silently, so the durable projection was a no-op wherever a real journal was
 * composed. `spent` names the same number and names no credential. Records
 * written under the old name do not decode; they never carried a readable
 * number either, so nothing is lost by refusing them.
 *
 * @category records
 * @since 1.0.0-rc.0
 */
export const UsageRecord = Schema.Struct({
  stepKey: Schema.String,
  spent: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))
})

/**
 * The journal event one run's latency clock zero is written to.
 *
 * Like {@link usageEvent}, this record is READ BACK on resume. A run whose
 * zero is not recovered re-arms its whole latency allowance on every park,
 * reclaim, or process restart, so the first recovery writes it durably and
 * later recoveries keep the earliest value they find.
 *
 * @category records
 * @since 1.0.0-rc.0
 */
export const budgetStartedEvent = "flows.agent.budget-started.v1"

/**
 * The payload one {@link budgetStartedEvent} record carries.
 *
 * This is a durable wire format owned by both the first writer and every
 * resumed reader. An undecodable current-version payload leaves the latency
 * ledger unknown, so recovery fails closed instead of choosing a new zero.
 *
 * @category records
 * @since 1.0.0-rc.0
 */
export const BudgetStartedRecord = Schema.Struct({
  startedAt: Schema.Finite
})

/**
 * The journal event a run's suspension start is written to.
 *
 * Read back with {@link budgetResumedEvent} on recovery: a run parked in one
 * process and answered in another must not be charged the parked wall time.
 *
 * @category records
 * @since 1.0.0-rc.1
 */
export const budgetSuspendedEvent = "flows.agent.budget-suspended.v1"

/**
 * The journal event that closes a run's open {@link budgetSuspendedEvent}.
 *
 * @category records
 * @since 1.0.0-rc.1
 */
export const budgetResumedEvent = "flows.agent.budget-resumed.v1"

/**
 * The payload {@link budgetSuspendedEvent} and {@link budgetResumedEvent}
 * carry: the wall-clock instant of the transition.
 *
 * @category records
 * @since 1.0.0-rc.1
 */
export const BudgetClockRecord = Schema.Struct({
  at: Schema.Finite
})

/**
 * The durable skip-remaining decision, encoded as {@link BudgetExceeded}.
 * Recovery keeps the first decision even if its peer reservations were released
 * without usage. An undecodable record fails accounting closed.
 *
 * @category records
 * @since 1.0.0-rc.0
 */
export const budgetLatchedEvent = "flows.agent.budget-latched.v1"

/** The journal source every record this module writes is attributed to. */
const recordSource = JournalEvent.SourceId.make("/agent/budget")

/**
 * The tokens one model call cost.
 *
 * Providers report either a total or the parts, and some report both. The total
 * wins when it is there, because a provider that publishes one has already
 * decided what counts.
 * Every supplied counter must nevertheless be finite and non-negative. An
 * invalid component yields NaN so neither total precedence nor aggregation
 * can conceal malformed usage; record rejects it and blocks fresh admission.
 *
 * @category accounting
 * @since 0.1.0
 */
export const tokensOf = (usage: ModelEvent.Usage, weights?: typeof TokenWeights.Type): number => {
  const counters = [
    usage.totalTokens,
    usage.inputTokens,
    usage.outputTokens,
    usage.reasoningTokens,
    usage.cachedInputTokens,
    usage.cacheWriteTokens
  ]
  if (counters.some((value) => value !== undefined && (!Number.isFinite(value) || value < 0))) return Number.NaN
  if (weights !== undefined) {
    // Normalized input/output counters already include cached input/reasoning.
    // Missing parts cannot safely be inferred from a provider total.
    if (
      usage.inputTokens === undefined || usage.outputTokens === undefined ||
      (usage.cachedInputTokens ?? 0) > usage.inputTokens
    ) return Number.NaN
    const cached = usage.cachedInputTokens ?? 0
    return (usage.inputTokens - cached) * weights.input + cached * weights.cachedInput +
      usage.outputTokens * weights.output
  }
  return usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) +
      (usage.reasoningTokens ?? 0)
}

interface State {
  readonly tokens: number
  readonly largestCall: number
  readonly counted: ReadonlyMap<string, number>
  readonly latched: BudgetExceeded | undefined
}

const exceeded = (
  scope: "tokens" | "latency" | "daily",
  onExceeded: OnExceeded,
  used: number,
  max: number,
  next: number,
  reserved = 0
): BudgetExceeded =>
  new BudgetExceeded({
    scope,
    onExceeded,
    used,
    reserved,
    max,
    next,
    message: scope === "daily"
      ? `This machine has spent ${used} of its ${max} tokens for the UTC day across all runs, and the next call is projected at ${next}`
      : scope === "tokens"
      ? `The run has spent ${used} of its ${max} approved tokens, has ${reserved} reserved, and the next call is projected at ${next}`
      : `The run has been running for ${used} ms of its ${max} ms budget`
  })

const skippedFor = (failure: BudgetExceeded): Skipped =>
  new Skipped({
    budget: failure,
    message: `The run stopped making model calls after it exceeded its ${failure.scope} budget`
  })

const verdictFor = (failure: BudgetExceeded): Verdict =>
  failure.onExceeded === "warn"
    ? { _tag: "warn", exceeded: failure }
    : {
      _tag: "refuse",
      exceeded: failure,
      failure: failure.onExceeded === "skip-remaining" ? skippedFor(failure) : failure
    }

/**
 * Writes one record for the current run, when the composition has a journal
 * and is inside a run.
 *
 * Both lookups are optional because a budget is as valid on the reference
 * memory engine as on the durable one, and neither absence changes what the
 * budget decides.
 */
const emit = (
  write: (journal: Journal.Service, input: JournalEvent.Input) => Effect.Effect<unknown, unknown>,
  eventType: string,
  payload: unknown
): Effect.Effect<void, unknown> =>
  Effect.gen(function*() {
    const journal = yield* Effect.serviceOption(Journal.Journal)
    const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
    if (Option.isNone(journal) || Option.isNone(instance)) return
    yield* write(
      journal.value,
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(instance.value.executionId),
        sourceId: recordSource,
        eventType,
        payload
      })
    )
  })

/**
 * The failure a broken half of the ledger reports.
 *
 * One sentence per phase rather than a shared one, because the two are
 * different operational facts: a write that failed leaves spend this process
 * knows about and no successor will, and a read that failed leaves a run whose
 * spend nobody knows.
 */
const unavailable = (
  phase: "record" | "recover",
  runId: string,
  detail: string,
  cause?: unknown
): AccountingUnavailable =>
  new AccountingUnavailable({
    phase,
    runId,
    message: phase === "record"
      ? `The budget could not durably record run ${runId}'s ledger, so a resumed run could be given that allowance again: ${detail}`
      : `The budget could not read run ${runId}'s ledger, so it cannot say what allowance is left: ${detail}`,
    // The package's one failure serializer, so a live `JournalError` keeps its
    // tag, code, and fields through the accounting error's encoder, a nested
    // native `Error` keeps its message, and a cyclic or BigInt-bearing cause
    // falls back to text rather than throwing "the error could not be printed"
    // over "the ledger could not be written".
    ...(cause === undefined ? {} : { cause: failureJson(cause) })
  })

/**
 * Writes one warning record on the journal's lossy channel, when the
 * composition has a journal and is inside a run.
 *
 * Both lookups are optional because a budget is as valid on the reference
 * memory engine as on the durable one, and neither absence changes what the
 * budget decides. The channel is the lossy one because a warning IS telemetry:
 * nothing reads it back, and a dropped one costs a line in an operator view.
 */
const journalWarning = (payload: Record<string, unknown>): Effect.Effect<void> =>
  emit((journal, input) => journal.emitLossy(input), budgetWarningEvent, payload).pipe(Effect.ignore)

/**
 * Writes one usage record on the journal's DURABLE channel.
 *
 * See {@link usageEvent} for why this record cannot travel on the lossy
 * channel and why the durable write is unfenced.
 */
const journalUsage = (
  runId: string,
  payload: typeof UsageRecord.Encoded,
  committed: Effect.Effect<void>
): Effect.Effect<void, AccountingUnavailable> =>
  Effect.gen(function*() {
    const journal = yield* Effect.serviceOption(Journal.Journal)
    if (runId === looseRunId || Option.isNone(journal)) return yield* committed
    yield* journal.value.emitDurableUnfenced(
      new JournalEvent.Input({
        runId: JournalEvent.RunId.make(runId),
        // One durable identity per model step, including commit-then-interrupt
        // retries. Hash the JSON string encoding so identifiers stay bounded
        // and distinct even for long keys or unpaired UTF-16 surrogates.
        sourceId: JournalEvent.SourceId.make(`${recordSource}/usage/${digest(JSON.stringify(payload.stepKey))}`),
        sourceSeq: JournalEvent.SourceSeq.make(0),
        eventType: usageEvent,
        payload
      })
    )
    const observable = yield* journal.value.whenCommitted(committed)
    if (!observable) {
      return yield* Effect.fail(new Error("usage was written inside an unmanaged transaction"))
    }
  }).pipe(
    Effect.mapError((cause) => unavailable("record", runId, String(cause), cause))
  )

/**
 * Writes one latency clock zero on the journal's DURABLE channel.
 *
 * See {@link budgetStartedEvent} for why a fresh process must recover this
 * value instead of starting the whole latency allowance again.
 */
const journalBudgetStarted = (
  runId: string,
  payload: typeof BudgetStartedRecord.Encoded
): Effect.Effect<void, AccountingUnavailable> =>
  emit((journal, input) => journal.emitDurableUnfenced(input), budgetStartedEvent, payload).pipe(
    Effect.mapError((cause) => unavailable("record", runId, String(cause), cause))
  )

/** How many journal entries one recovery read asks for at a time. */
const recoveryPageSize = 500

/**
 * How many journal entries one recovery reads before it gives up.
 *
 * A recovery pages to the END of the run's journal; this is not a stopping
 * point, it is the point at which the budget declares the ledger unreadable
 * and fails. The difference matters: a bound that stopped early would return a
 * PARTIAL ledger indistinguishable from a complete one, and hand a long run
 * back the allowance the entries past the bound describe. A million entries is
 * far past any run a budget guards, so reaching it is a broken journal rather
 * than a busy one.
 *
 * @category constructors
 * @since 0.1.0
 */
export const defaultRecoveryEntries = 1_000_000

interface RecoveredLedger {
  readonly usage: ReadonlyMap<string, number>
  readonly startedAt: number | undefined
  readonly latched: BudgetExceeded | undefined
  /** Closed suspension spans, summed. */
  readonly suspendedMillis: number
  /** The start of a suspension no resume has closed. */
  readonly suspendedSince: number | undefined
}

/**
 * Reads back the usage, latency zero, and skip-remaining decision one run recorded.
 *
 * Returns calls keyed by step, so the caller folds them through the same
 * accumulator a live call goes through and the dedupe applies to both. The
 * earliest clock zero wins, making a duplicate write harmless without letting
 * a later incarnation move the allowance forward.
 *
 * A composition with no journal recovers nothing, because it never recorded
 * anything and there is nothing to be wrong about. Every OTHER absence fails:
 * a journal that cannot be flushed or read, and a journal longer than
 * `entryLimit`, are runs whose spend or clock zero is unknown rather than zero.
 */
const recoverUsage = (
  runId: string,
  entryLimit: number
): Effect.Effect<RecoveredLedger, AccountingUnavailable> =>
  Effect.gen(function*() {
    const recovered = new Map<string, number>()
    let startedAt = Number.POSITIVE_INFINITY
    let latched: BudgetExceeded | undefined
    let suspendedMillis = 0
    let suspendedSince: number | undefined
    const journal = yield* Effect.serviceOption(Journal.Journal)
    if (Option.isNone(journal)) {
      return { usage: recovered, startedAt: undefined, latched: undefined, suspendedMillis, suspendedSince }
    }
    // Recovery flushes and reads committed history. Running it while holding
    // a write transaction can deadlock its lossy writer or recover a clock
    // zero that is later rolled back. Refuse before either operation.
    let outsideTransaction = false
    yield* journal.value.whenCommitted(Effect.sync(() => {
      outsideTransaction = true
    }))
    if (!outsideTransaction) {
      return yield* Effect.fail(unavailable("recover", runId, "budget recovery must run outside a journal transaction"))
    }
    const id = JournalEvent.RunId.make(runId)
    const unreadable = (cause: unknown) => unavailable("recover", runId, String(cause), cause)
    const undecodable = (entry: JournalEvent.Entry, record: string) =>
      unavailable(
        "recover",
        runId,
        `its ${record} record at seq ${entry.seq} from ${entry.sourceId} does not decode`
      )
    // Flushed first, and the flush failure is the read's failure: entries the
    // journal is still holding are entries this run spent.
    yield* journal.value.flush.pipe(Effect.mapError(unreadable))
    let after: JournalEvent.Seq | undefined
    let scanned = 0
    for (;;) {
      const read = yield* journal.value.entries(
        after === undefined
          ? { runId: id, limit: recoveryPageSize }
          : { runId: id, after, limit: recoveryPageSize }
      ).pipe(Effect.mapError(unreadable))
      for (const entry of read.entries) {
        if (entry.eventType === usageEvent) {
          const payload = yield* Schema.decodeUnknownEffect(UsageRecord)(entry.payload).pipe(
            Effect.mapError(() => undecodable(entry, "usage"))
          )
          const previous = recovered.get(payload.stepKey)
          if (previous !== undefined && previous !== payload.spent) {
            return yield* Effect.fail(unavailable("recover", runId, "its usage records disagree about one model step"))
          }
          recovered.set(payload.stepKey, payload.spent)
        } else if (entry.eventType === budgetStartedEvent) {
          const payload = yield* Schema.decodeUnknownEffect(BudgetStartedRecord)(entry.payload).pipe(
            Effect.mapError(() => undecodable(entry, "budget-started"))
          )
          startedAt = Math.min(startedAt, payload.startedAt)
        } else if (entry.eventType === budgetLatchedEvent) {
          const payload = yield* Schema.decodeUnknownEffect(BudgetExceeded)(entry.payload).pipe(
            Effect.mapError(() => undecodable(entry, "budget-latched"))
          )
          if (payload.onExceeded !== "skip-remaining") {
            return yield* Effect.fail(undecodable(entry, "budget-latched"))
          }
          latched ??= payload
        } else if (entry.eventType === budgetSuspendedEvent || entry.eventType === budgetResumedEvent) {
          const { at } = yield* Schema.decodeUnknownEffect(BudgetClockRecord)(entry.payload).pipe(
            Effect.mapError(() => undecodable(entry, entry.eventType))
          )
          // The same fold the live account applies, in journal order.
          if (entry.eventType === budgetSuspendedEvent) suspendedSince ??= at
          else if (suspendedSince !== undefined) {
            suspendedMillis += Math.max(0, at - suspendedSince)
            suspendedSince = undefined
          }
        }
      }
      scanned += read.entries.length
      const last = read.entries.at(-1)
      if (!read.hasMore || last === undefined) {
        return {
          usage: recovered,
          startedAt: startedAt === Number.POSITIVE_INFINITY ? undefined : startedAt,
          latched,
          suspendedMillis,
          suspendedSince
        }
      }
      if (scanned >= entryLimit) {
        return yield* Effect.fail(
          unavailable(
            "recover",
            runId,
            `its journal holds more than the ${entryLimit} entries one recovery reads`
          )
        )
      }
      after = last.seq
    }
  })

/**
 * One run's accounting.
 *
 * The budget holds one of these per execution id rather than one per instance.
 * A composition provides `Budget` where it provides its engine — above every
 * run, not inside one — so a single accumulator would spend run A's tokens out
 * of run B's allowance, and `startedAt` captured at layer build would put a
 * latency budget's clock at process start.
 */
interface RunAccount {
  /** The latency zero, replaced once when recovery finds its earlier durable value. */
  startedAt: number
  /** Closed suspension spans, summed; subtracted from the latency clock. */
  suspendedMillis: number
  /** The start of the open suspension, if the run is suspended. */
  suspendedSince: number | undefined
  readonly state: Ref.Ref<State>
  /** Actual spend whose journal write has not yet been confirmed committed. */
  readonly pending: Map<string, AccountingUnavailable>
  /** Operations holding this account cannot race its eviction/replacement. */
  users: number
  /** Memory-only accounts cannot be reconstructed after eviction. */
  evictable: boolean
  readonly admission: Semaphore.Semaphore
  readonly reservations: Map<string, { holders: number }>
  /**
   * Serializes the one-time recovery.
   *
   * A semaphore rather than a flag: a run whose first two model calls are
   * concurrent must not have one of them decide against an accumulator the
   * other is still filling.
   */
  readonly recovery: Semaphore.Semaphore
  recovered: boolean
}

/**
 * The run id {@link Service.usageOf} answers about calls recorded outside any
 * run under.
 *
 * A budget accounts by execution id, and a caller with no run — a unit test, a
 * composition measuring before it executes anything — still has to account
 * somewhere. Its tally is held apart from the run map, so no bound evicts it.
 *
 * @category accounting
 * @since 0.1.0
 */
export const looseRunId = ""

/**
 * How many runs' tallies one budget keeps in memory by default.
 *
 * The accumulator has to be held between one run's model calls, and a run
 * publishes no "I am finished" the budget could listen for: `FlowInstance`'s
 * scope closes at the end of every NODE dispatch, not at the end of the run,
 * so it cannot be the lifetime. The bound is what keeps a control plane that
 * drives runs for weeks from holding one tally per run it ever drove. It is
 * an upper bound, not permission to forget spend: active operations,
 * uncommitted usage, and memory-only accounts cannot be evicted. If all slots
 * are pinned, admission fails with AccountingUnavailable. An evicted durable
 * account recovers its spend, original latency zero, and latch from the journal.
 *
 * @category constructors
 * @since 0.1.0
 */
export const defaultMaxRuns = 256

/**
 * What a composition can tune about one budget instance.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** Positive safe integer; defaults to {@link defaultMaxRuns}. */
  readonly maxRuns?: number | undefined
  /**
   * How many journal entries one recovery reads before it fails closed.
   * Positive safe integer; defaults to {@link defaultRecoveryEntries}.
   */
  readonly recoveryEntries?: number | undefined
  /** Required by `policy.daily`; also where a run without a journal recovers its spend. */
  readonly ledger?: Ledger | undefined
}

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))
const PositiveInteger = Schema.Int.check(Schema.isGreaterThan(0))
const Configuration = Schema.Struct({
  policy: Schema.Struct({
    weights: Schema.optional(Schema.Record(Schema.String, TokenWeights)),
    tokens: Schema.optional(Schema.Struct({
      max: NonNegativeInteger,
      onExceeded: Schema.optional(OnExceeded)
    })),
    latency: Schema.optional(Schema.Struct({
      maxMillis: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
      onExceeded: Schema.optional(OnExceeded)
    })),
    daily: Schema.optional(Schema.Struct({ max: PositiveInteger }))
  }),
  options: Schema.Struct({
    maxRuns: Schema.optional(PositiveInteger),
    recoveryEntries: Schema.optional(PositiveInteger),
    ledger: Schema.optional(Schema.Any)
  })
})

/**
 * Builds a budget over one policy.
 *
 * One instance serves a whole composition: the accumulator is keyed by
 * execution id, so a layer built once above an engine accounts every run it
 * drives separately. Validates and snapshots the configuration at acquisition;
 * subsequent mutations of the caller's objects cannot change enforcement.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (
  declaredPolicy: Policy,
  declaredOptions: Options = {}
): Effect.Effect<Service, ConfigurationError> =>
  Effect.gen(function*() {
    const { options, policy } = yield* Schema.decodeUnknownEffect(Configuration, { onExcessProperty: "error" })({
      policy: declaredPolicy,
      options: declaredOptions
    }).pipe(
      Effect.mapError((cause) => new ConfigurationError({ message: `Invalid budget configuration: ${cause.message}` }))
    )
    const spendLedger = declaredOptions.ledger
    if (policy.daily !== undefined && spendLedger === undefined) {
      return yield* Effect.fail(
        new ConfigurationError({ message: "Invalid budget configuration: a daily cap needs a ledger" })
      )
    }
    const maxRuns = options.maxRuns ?? defaultMaxRuns
    const recoveryEntries = options.recoveryEntries ?? defaultRecoveryEntries
    const accounts = new Map<string, RunAccount>()
    const registry = yield* Semaphore.make(1)

    const newAccount = Effect.gen(function*() {
      const startedAt = yield* Clock.currentTimeMillis
      const state = yield* Ref.make<State>({
        tokens: 0,
        largestCall: 0,
        counted: new Map<string, number>(),
        latched: undefined
      })
      const recovery = yield* Semaphore.make(1)
      const admission = yield* Semaphore.make(1)
      return {
        startedAt,
        suspendedMillis: 0,
        suspendedSince: undefined,
        state,
        recovery,
        admission,
        reservations: new Map(),
        recovered: false,
        pending: new Map(),
        users: 0,
        evictable: false
      } satisfies RunAccount
    })

    // The loose account exists from construction so a caller outside a run —
    // a unit test, a composition that accounts before it executes anything —
    // starts its latency clock where the budget was built. It is held apart
    // from the run map so it is never the entry a bound evicts.
    const loose = yield* newAccount

    /**
     * This run's accounting, created on the run's first question.
     *
     * Creation runs under a permit so two concurrent first calls of one run
     * cannot build two accumulators and each decide against half the spend.
     * A `Map` iterates in insertion order, so re-inserting on every touch
     * makes the first key the least recently used one.
     */
    const accountFor = (runId: string): Effect.Effect<RunAccount, AccountingUnavailable> =>
      registry.withPermits(1)(Effect.suspend(() => {
        const existing = accounts.get(runId)
        if (existing !== undefined) {
          accounts.delete(runId)
          accounts.set(runId, existing)
          existing.users++
          return Effect.succeed(existing)
        }
        return Effect.flatMap(newAccount, (created) => {
          // Evicted before the insert, so the map never exceeds the bound.
          for (const [oldest, account] of accounts) {
            if (accounts.size < maxRuns) break
            if (account.users > 0 || account.pending.size > 0 || !account.evictable) continue
            accounts.delete(oldest)
          }
          if (accounts.size >= maxRuns) {
            return Effect.fail(
              unavailable(
                "recover",
                runId,
                "all cached accounts are active, uncommitted, or memory-only; none can be evicted safely"
              )
            )
          }
          accounts.set(runId, created)
          created.users++
          return Effect.succeed(created)
        })
      }))

    /**
     * Folds one call into a run's accumulator, at most once per step key.
     *
     * Answers whether this call was new, so a caller that also has to write the
     * call down does so exactly when the accumulator took it. Recovery holds
     * the recovery permit. Live writes normally hold admission; an existing
     * transaction can account synchronously without waiting on another writer.
     */
    const account = (
      run: RunAccount,
      runId: string,
      stepKey: string,
      spent: number,
      pending?: AccountingUnavailable
    ): Effect.Effect<boolean, AccountingUnavailable> =>
      Ref.modify(run.state, (current): readonly [Result.Result<boolean, AccountingUnavailable>, State] => {
        const previous = current.counted.get(stepKey)
        if (previous !== undefined) {
          const conflict = previous === spent
            ? undefined
            : unavailable("record", runId, "a model step was recorded with conflicting usage")
          if (pending !== undefined && conflict !== undefined) run.pending.set(stepKey, conflict)
          return [
            conflict === undefined
              ? Result.succeed(false)
              : Result.fail(conflict),
            current
          ]
        }
        const counted = new Map(current.counted)
        counted.set(stepKey, spent)
        // Publish the actual cost and its pending durability in the same
        // synchronous transition. A concurrent check cannot see only one.
        if (pending !== undefined) run.pending.set(stepKey, pending)
        return [
          Result.succeed(true),
          {
            ...current,
            tokens: current.tokens + spent,
            largestCall: Math.max(current.largestCall, spent),
            counted
          }
        ] as const
      }).pipe(Effect.flatMap(Effect.fromResult))

    /** Recovers one run's earlier spend, latency zero, and latch before its first decision. */
    const ensureRecovered = (run: RunAccount, runId: string): Effect.Effect<void, AccountingUnavailable> =>
      run.recovery.withPermits(1)(
        Effect.suspend(() => {
          if (run.recovered) return Effect.void
          return recoverUsage(runId, recoveryEntries).pipe(
            Effect.flatMap((ledger) =>
              Effect.gen(function*() {
                if (ledger.startedAt === undefined) {
                  const payload = yield* Schema.encodeEffect(BudgetStartedRecord)({
                    startedAt: run.startedAt
                  }).pipe(
                    Effect.mapError((cause) =>
                      unavailable("record", runId, "its latency clock zero does not encode", cause)
                    )
                  )
                  yield* journalBudgetStarted(runId, payload)
                } else {
                  run.startedAt = ledger.startedAt
                }
                run.suspendedMillis = ledger.suspendedMillis
                run.suspendedSince = ledger.suspendedSince
                yield* Effect.forEach(
                  ledger.usage,
                  ([stepKey, spent]) => account(run, runId, stepKey, spent),
                  { discard: true }
                )
                if (spendLedger !== undefined) {
                  const held = yield* spendLedger.run(runId).pipe(
                    Effect.mapError((cause) => unavailable("recover", runId, String(cause), cause))
                  )
                  yield* Effect.forEach(held, ([stepKey, spent]) => account(run, runId, stepKey, spent), {
                    discard: true
                  })
                }
                yield* Ref.update(run.state, (current) => ({ ...current, latched: ledger.latched }))
                run.evictable = spendLedger !== undefined || Option.isSome(yield* Effect.serviceOption(Journal.Journal))
              })
            ),
            Effect.andThen(Effect.sync(() => {
              run.recovered = true
            }))
          )
        })
      )

    /**
     * This run's accumulator, with everything it recorded before folded in,
     * and the id it is accounted under.
     *
     * The id travels with the account because the write side needs it: a
     * record that cannot be written names the run whose ledger is now short.
     */
    const acquireAccount = Effect.gen(function*() {
      const instance = yield* Effect.serviceOption(FlowRuntime.FlowInstance)
      if (Option.isNone(instance)) return { run: loose, runId: looseRunId }
      const runId = instance.value.executionId
      const run = yield* accountFor(runId)
      return { run, runId }
    })

    const withRecovered = <A, E, R>(
      use: (run: RunAccount, runId: string) => Effect.Effect<A, E, R>,
      pendingStepKey?: string
    ): Effect.Effect<A, E | AccountingUnavailable, R> =>
      Effect.acquireUseRelease(
        acquireAccount,
        ({ run, runId }) =>
          (runId === looseRunId ? Effect.void : ensureRecovered(run, runId)).pipe(
            Effect.onError(() =>
              Effect.sync(() => {
                if (pendingStepKey !== undefined) {
                  run.pending.set(
                    pendingStepKey,
                    unavailable("record", runId, "a paid step's initial recovery did not complete")
                  )
                }
              })
            ),
            Effect.andThen(use(run, runId))
          ),
        ({ run, runId }) =>
          Effect.sync(() => {
            if (runId !== looseRunId) run.users--
          })
      )

    /** Applies one exceeded budget: latch, journal, or simply report. */
    const settle = (
      run: RunAccount,
      runId: string,
      failure: BudgetExceeded
    ): Effect.Effect<Verdict, AccountingUnavailable> =>
      Effect.gen(function*() {
        if (failure.onExceeded === "skip-remaining") {
          // The refusal can outlive the reservation that triggered it. Commit
          // its ledger record before publishing the latch or returning a verdict.
          yield* Effect.gen(function*() {
            const journal = yield* Effect.serviceOption(Journal.Journal)
            if (runId !== looseRunId && Option.isSome(journal)) {
              let outsideTransaction = false
              yield* journal.value.whenCommitted(Effect.sync(() => {
                outsideTransaction = true
              }))
              if (!outsideTransaction) {
                return yield* Effect.fail(
                  unavailable("record", runId, "a budget latch must be recorded outside a journal transaction")
                )
              }
              const payload = Schema.encodeSync(BudgetExceeded)(failure)
              yield* emit(
                (journal, input) => journal.emitDurableUnfenced(input),
                budgetLatchedEvent,
                payload
              ).pipe(Effect.mapError((cause) => unavailable("record", runId, String(cause), cause)))
            }
            yield* Ref.update(run.state, (current) => ({ ...current, latched: failure }))
          }).pipe(Effect.uninterruptible)
        }
        if (failure.onExceeded === "warn") {
          yield* journalWarning({
            scope: failure.scope,
            used: failure.used,
            reserved: failure.reserved,
            max: failure.max,
            next: failure.next
          })
        }
        return verdictFor(failure)
      })

    /**
     * Opens or closes one run's suspension span, durably before in memory, so
     * a recovered ledger never holds less suspension than the live one used.
     * Redundant transitions write nothing.
     */
    const transition = (
      run: RunAccount,
      runId: string,
      to: "suspend" | "resume",
      at: number
    ): Effect.Effect<void, AccountingUnavailable> =>
      Effect.gen(function*() {
        if ((to === "suspend") === (run.suspendedSince !== undefined)) return
        if (runId !== looseRunId) {
          const payload = yield* Schema.encodeEffect(BudgetClockRecord)({ at }).pipe(
            Effect.mapError((cause) => unavailable("record", runId, "its suspension record does not encode", cause))
          )
          yield* emit(
            (journal, input) => journal.emitDurableUnfenced(input),
            to === "suspend" ? budgetSuspendedEvent : budgetResumedEvent,
            payload
          ).pipe(Effect.mapError((cause) => unavailable("record", runId, String(cause), cause)))
        }
        if (to === "suspend") {
          run.suspendedSince = at
        } else if (run.suspendedSince !== undefined) {
          run.suspendedMillis += Math.max(0, at - run.suspendedSince)
          run.suspendedSince = undefined
        }
      }).pipe(Effect.uninterruptible)

    const checkAccount = (
      run: RunAccount,
      runId: string,
      stepKey: string | undefined,
      reserving: boolean
    ): Effect.Effect<Verdict, AccountingUnavailable> =>
      Effect.gen(function*() {
        const current = yield* Ref.get(run.state)
        // A step the ledger already holds is a step this run already paid for,
        // so the call about to be made is its replay and costs nothing. Every
        // ceiling below projects the NEXT call's cost onto the ledger, and
        // projecting it onto a ledger that already counts this step refuses a
        // call for spend the refusal is itself double-counting. It is checked
        // ahead of the latch for the same reason: `skip-remaining` stops the
        // calls a run has not made, not the ones it is replaying.
        if (stepKey !== undefined && (current.counted.has(stepKey) || run.pending.has(stepKey))) {
          return { _tag: "proceed" }
        }
        const pending = run.pending.values().next().value
        if (pending !== undefined) return yield* Effect.fail(pending)
        if (stepKey !== undefined && run.reservations.has(stepKey)) return { _tag: "proceed" }
        const now = yield* Clock.currentTimeMillis
        if (current.latched !== undefined) return verdictFor(current.latched)
        // A run asking to call a model is executing, whatever it recorded.
        yield* transition(run, runId, "resume", now)
        const latency = policy.latency
        const active = now - run.startedAt - run.suspendedMillis
        if (latency !== undefined && active > latency.maxMillis) {
          return yield* settle(
            run,
            runId,
            exceeded(
              "latency",
              latency.onExceeded ?? "fail",
              active,
              latency.maxMillis,
              0
            )
          )
        }
        const tokens = policy.tokens
        const daily = policy.daily
        if (daily !== undefined && spendLedger !== undefined) {
          const used = yield* spendLedger.total(utcDay(now)).pipe(
            Effect.mapError((cause) => unavailable("recover", runId, String(cause), cause))
          )
          const projected = current.largestCall
          if (used + projected > daily.max || used >= daily.max) {
            return yield* settle(run, runId, exceeded("daily", "fail", used, daily.max, projected))
          }
        }
        // Before any positive cost is known, hold the whole token allowance
        // for one call. A zero-cost forecast must not admit unbounded fanout.
        const forecast = current.largestCall || tokens?.max || 0
        let reserved = 0
        for (const key of run.reservations.keys()) {
          if (!current.counted.has(key)) reserved += forecast
        }
        const next = reserving || run.reservations.size > 0 ? forecast : current.largestCall
        if (tokens !== undefined && (tokens.max === 0 || current.tokens + reserved + next > tokens.max)) {
          return yield* settle(
            run,
            runId,
            exceeded(
              "tokens",
              tokens.onExceeded ?? "fail",
              current.tokens,
              tokens.max,
              next,
              reserved
            )
          )
        }
        return { _tag: "proceed" }
      })

    const check = (stepKey: string | undefined): Effect.Effect<Verdict, AccountingUnavailable> =>
      withRecovered((run, runId) => run.admission.withPermits(1)(checkAccount(run, runId, stepKey, false)))

    const reserve = (stepKey: string): Effect.Effect<Verdict, AccountingUnavailable, Scope.Scope> =>
      withRecovered((run, runId) =>
        run.admission.withPermits(1)(Effect.uninterruptibleMask((restore) =>
          Effect.gen(function*() {
            const verdict = yield* restore(checkAccount(run, runId, stepKey, true))
            if (verdict._tag === "refuse") return verdict
            const current = yield* Ref.get(run.state)
            if (current.counted.has(stepKey)) return verdict
            // Each scope owns a holder, not a captured predecessor. Closing one
            // duplicate's scope cannot release another still-live duplicate.
            const scope = yield* Scope.Scope
            const reservation = run.reservations.get(stepKey) ?? { holders: 0 }
            reservation.holders++
            run.reservations.set(stepKey, reservation)
            run.users++
            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => {
                reservation.holders--
                if (reservation.holders === 0) run.reservations.delete(stepKey)
                run.users--
              })
            )
            return verdict
          })
        ))
      )

    const summarize = (current: State): Usage => ({
      tokens: current.tokens,
      calls: current.counted.size,
      largestCall: current.largestCall
    })

    return Budget.of({
      check,
      reserve,
      record: (stepKey, usage, modelId) =>
        withRecovered((run, runId) =>
          Effect.gen(function*() {
            const spent = tokensOf(usage, modelId === undefined ? undefined : policy.weights?.[modelId])
            // A malformed cost must not poison the numeric accumulator. Keep the
            // ledger unavailable until that step supplies a valid record.
            const payload = yield* Schema.encodeEffect(UsageRecord)({ stepKey, spent }).pipe(
              Effect.mapError((cause) => unavailable("record", runId, "its usage record does not encode", cause)),
              Effect.tapError((failure) =>
                Effect.sync(() => {
                  run.pending.set(stepKey, failure)
                })
              )
            )
            let entered = false
            const write = Effect.uninterruptibleMask((restore) =>
              Effect.gen(function*() {
                entered = true
                const pending = run.pending.get(stepKey) ??
                  unavailable("record", runId, "a paid model step has uncommitted usage")
                const counted = yield* account(run, runId, stepKey, spent, pending)
                if (!counted && !run.pending.has(stepKey)) return
                if (spendLedger !== undefined) {
                  const now = yield* Clock.currentTimeMillis
                  yield* restore(spendLedger.record({ day: utcDay(now), runId, stepKey, spent })).pipe(
                    Effect.mapError((cause) => unavailable("record", runId, String(cause), cause))
                  )
                }
                yield* restore(journalUsage(
                  runId,
                  payload,
                  Effect.sync(() => {
                    if (run.pending.get(stepKey) === pending) run.pending.delete(stepKey)
                  })
                ))
              })
            )
            return yield* Effect.gen(function*() {
              const journal = yield* Effect.serviceOption(Journal.Journal)
              let outsideTransaction = true
              if (runId !== looseRunId && Option.isSome(journal)) {
                outsideTransaction = false
                yield* journal.value.whenCommitted(Effect.sync(() => {
                  outsideTransaction = true
                }))
              }
              // A transaction already owns its writer. Waiting for admission
              // could invert that lock against another record waiting to write.
              // Its usage remains pending until the existing commit callback.
              if (!outsideTransaction) return yield* write
              // Keep admission behind a live write, but allow a queued paid
              // record to be cancelled before it gets the permit.
              return yield* run.admission.withPermits(1)(write)
            }).pipe(Effect.onError(() =>
              Effect.gen(function*() {
                if (entered) return
                const pending = run.pending.get(stepKey) ??
                  unavailable("record", runId, "a paid model step could not enter usage accounting")
                // Cancellation must retain the known cost as well as its key.
                // This synchronous transition also detects conflicting retries.
                yield* account(run, runId, stepKey, spent, pending).pipe(Effect.ignore)
              })
            ))
          }), stepKey),
      usage: withRecovered((run) => Effect.map(Ref.get(run.state), summarize)),
      suspend: withRecovered((run, runId) =>
        run.admission.withPermits(1)(
          Effect.flatMap(Clock.currentTimeMillis, (now) => transition(run, runId, "suspend", now))
        )
      ),
      resume: (at) =>
        withRecovered((run, runId) =>
          run.admission.withPermits(1)(
            Effect.flatMap(Clock.currentTimeMillis, (now) => transition(run, runId, "resume", at ?? now))
          )
        ),
      usageOf: (runId) =>
        Effect.suspend(() => {
          const live = runId === looseRunId ? loose : accounts.get(runId)
          // A run this process is driving answers from the accumulator its own
          // calls are folded into. Reading its records instead would report a
          // call the journal has not flushed yet as unspent.
          if (live !== undefined) {
            return Effect.acquireUseRelease(
              Effect.sync(() => {
                live.users++
              }),
              () =>
                (runId === looseRunId ? Effect.void : ensureRecovered(live, runId)).pipe(
                  Effect.andThen(Ref.get(live.state)),
                  Effect.map(summarize)
                ),
              () =>
                Effect.sync(() => {
                  live.users--
                })
            )
          }
          // No accumulator, so no caching either: answering about an arbitrary
          // run must not leave one tally per run the process was ever asked
          // about.
          return Effect.map(recoverUsage(runId, recoveryEntries), (ledger) => {
            let tokens = 0
            let largestCall = 0
            for (const spent of ledger.usage.values()) {
              tokens += spent
              largestCall = Math.max(largestCall, spent)
            }
            return { tokens, calls: ledger.usage.size, largestCall }
          })
        })
    })
  })

/**
 * A budget that accounts nothing and refuses nothing.
 *
 * This is an explicit decision to give up plan-envelope spending enforcement,
 * never a production default.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeUnbounded = (): Service =>
  Budget.of({
    check: () => Effect.succeed<Verdict>({ _tag: "proceed" }),
    reserve: () => Effect.succeed<Verdict>({ _tag: "proceed" }),
    record: () => Effect.void,
    usage: Effect.succeed({ tokens: 0, calls: 0, largestCall: 0 }),
    usageOf: () => Effect.succeed({ tokens: 0, calls: 0, largestCall: 0 }),
    suspend: Effect.void,
    resume: () => Effect.void
  })

/**
 * Provides one budget for the composition it is built in.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (policy: Policy, options: Options = {}): Layer.Layer<Budget, ConfigurationError> =>
  Layer.effect(Budget, make(policy, options))

/**
 * Explicitly provides {@link makeUnbounded}.
 *
 * This gives up token, call, and latency ceilings for the composed run.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerUnbounded = (): Layer.Layer<Budget> => Layer.succeed(Budget)(makeUnbounded())

/**
 * Reads the budget a composition explicitly provided.
 *
 * There is deliberately no fallback. Every production composition must bind a
 * policy, normally with {@link layerFromEnvelope}, or explicitly opt into
 * {@link layerUnbounded}.
 *
 * @category accessors
 * @since 0.1.0
 */
export const current: Effect.Effect<Service, never, Budget> = Budget

/**
 * Turns an approved plan envelope into a policy.
 *
 * This is the point of the whole module: `Envelope.budget` is what a control
 * plane approved, and until it becomes a {@link Policy} it is a number in a
 * record that nothing reads. A missing field is not a zero budget — it is no
 * budget at all — so an envelope that approves neither produces an empty policy
 * rather than a run that can spend nothing.
 *
 * The envelope's own `onExceeded` is what was approved, so it wins over
 * `options.onExceeded`, which is the composition's default.
 *
 * @category conversions
 * @since 0.1.0
 */
export const policyFromEnvelope = (
  envelope: ControlSchema.Envelope,
  options: { readonly onExceeded?: OnExceeded | undefined; readonly weights?: Weights | undefined } = {}
): Policy => {
  const onExceeded = envelope.budget.onExceeded ?? options.onExceeded ?? "fail"
  return {
    ...(options.weights === undefined ? {} : { weights: options.weights }),
    ...(envelope.budget.tokens === undefined
      ? {}
      : { tokens: { max: envelope.budget.tokens, onExceeded } }),
    ...(envelope.budget.milliseconds === undefined
      ? {}
      : { latency: { maxMillis: envelope.budget.milliseconds, onExceeded } })
  }
}

/**
 * Provides a budget built from an approved plan envelope.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerFromEnvelope = (
  envelope: ControlSchema.Envelope,
  options: { readonly onExceeded?: OnExceeded | undefined; readonly weights?: Weights | undefined } = {}
): Layer.Layer<Budget, ConfigurationError> => layer(policyFromEnvelope(envelope, options))

/**
 * The budget a parked run asks an operator to approve: the exceeded ceiling
 * raised to cover what the run has spent and holds, the refused call, and one
 * more of its original allowance.
 *
 * The ceiling is proposed rather than chosen at approval because an approval
 * must match the envelope it was requested with; approving this budget is the
 * operator's decision to let the run spend it.
 *
 * @category conversions
 * @since 1.0.0-rc.1
 */
export const raise = (
  budget: ControlSchema.Envelope["budget"],
  exceeded: BudgetExceeded
): ControlSchema.Envelope["budget"] => ({
  ...budget,
  [exceeded.scope === "tokens" ? "tokens" : "milliseconds"]: Math.ceil(
    exceeded.used + (exceeded.reserved ?? 0) + exceeded.next + exceeded.max
  )
})

/**
 * An approved envelope with every approved raise applied: each ceiling is the
 * largest one approved, so a raise never lowers what was already granted.
 *
 * @category conversions
 * @since 1.0.0-rc.1
 */
export const raisedBy = (
  envelope: ControlSchema.Envelope,
  raises: ReadonlyArray<ControlSchema.Envelope["budget"]>
): ControlSchema.Envelope => {
  const largest = (key: "tokens" | "milliseconds"): number | undefined =>
    raises.reduce<number | undefined>(
      (ceiling, raised) =>
        ceiling === undefined || raised[key] === undefined ? ceiling : Math.max(ceiling, raised[key]),
      envelope.budget[key]
    )
  const tokens = largest("tokens")
  const milliseconds = largest("milliseconds")
  return {
    ...envelope,
    budget: {
      ...envelope.budget,
      ...(tokens === undefined ? {} : { tokens }),
      ...(milliseconds === undefined ? {} : { milliseconds })
    }
  }
}
