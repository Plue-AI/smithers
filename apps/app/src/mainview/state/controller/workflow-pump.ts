import { approvalCardIdFor, runScopeFromCard, sameRunScope, type RunScope } from "../RunReference"
import type { ProjectionCursor } from "@smthrs/gateway/GatewaySchema"
import type { Card } from "../AppState"
import type { ControllerContext } from "./context"
import type { ApprovalRow, RunStatus, RunSummaryRow } from "./gateway"
import { Schema } from "effect"
import { ControlFacts } from "@smthrs/control"
import { questionOf } from "../../cards/ApprovalQuestion"
import { engineProjectionPending } from "../../cards/EngineTrace"
import { reconcileRunApprovals } from "./approval-reconciliation"
import { runFailureOf, stampOf } from "../RunFailure"
import { AppEventIntegrityError } from "../AppEventStream"
import { changedRuntimeRunObservation, RuntimeProjectionIntegrityError, runtimeRunKey, runtimeScopeOf } from "../RuntimeProjection"
import type { RuntimeRun, RuntimeRunObservation } from "../RuntimeProjection"
import { canonicalEventValue } from "../EventValue"
import { pendingWorkflowLaunch } from "../WorkflowLaunch"
import type { FlowDurationsReader } from "./flowDurations"
import { recordedRunBinding, RUN_BOX_GONE } from "../RepoContext"

export interface WorkflowPumpController {
  /** `observeOnce` reads a settled run's summary and journal one more time. */
  readonly pumpWorkflowRun: (cardId: string, observeOnce?: boolean) => Promise<void>
  readonly stopWatchingRun: (cardId: string, reason?: string) => string | void
  readonly retryRunWatch: (cardId: string) => string | void
  readonly resumeWorkflowRuns: () => void
  readonly stopWorkflowPumps: () => void
}

/** How a run card reads each rc.0 run status. */
const PHASE_OF_STATUS: Readonly<Record<RunStatus, Extract<Card, { kind: "run-trace" }>["payload"]["phase"]>> = {
  accepted: "running",
  running: "running",
  parked: "running",
  "waiting-approval": "waiting-approval",
  completed: "completed",
  failed: "failed",
  cancelled: "cancelled"
}

const TERMINAL_PHASES: ReadonlySet<string> = new Set(["completed", "failed", "cancelled"])
const isGuardIncident = Schema.is(ControlFacts.GuardIncident)

/**
 * How many journal pages one pump cycle reads.
 *
 * A `run-events` snapshot is a bounded PAGE, not the whole journal: the
 * gateway answers at most its page ceiling and a cursor to continue from. A
 * cycle therefore keeps asking until a page comes back short, which is how a
 * run that journaled more than one page still reaches the card. The cap keeps
 * one cycle bounded; a cycle that stops on it leaves the journal revision
 * unacknowledged so the next cycle continues from the same cursor.
 */
const JOURNAL_PAGES_PER_CYCLE = 16

/**
 * How many rows make a page worth continuing from.
 *
 * The gateway does not put its page ceiling on the wire, so a reader tells a
 * full page from a complete one by size. A steady pump reads a handful of
 * events per cycle and stops after one call; a card catching up on a long run
 * reads a page far above this and asks for the next one.
 */
const JOURNAL_PAGE_LOOKS_FULL = 256

export const createWorkflowPumpController = (
  ctx: ControllerContext,
  nextTranscriptOrdinal: () => number,
  /* A settled run added a sample to its flow's history; the prediction the
   * next plan card draws is read once, here, and never inside this loop. */
  readFlowDurations?: FlowDurationsReader
): WorkflowPumpController => {
  const { store, gateway, unref, workflowPollMs, services } = ctx
  /*
   * Workflows in the conversation ("make me a workflow").
   *
   * Every act routes through the box's flow seam: provision-or-resume the
   * box's coding host for a loaded repo (the loaded set is the universe),
   * then the host's own procedures. A run renders as an embedded run card (THE EMBED
   * LAW) whose pump re-reads the `run-summary`, `transcript`, and `approvals`
   * projections. Summary and transcript rows replace their current answer;
   * the journal appends the suffix after the card's retained position.
   */
  const RUN_POLL_MS = workflowPollMs
  /*
   * The generous bound. A run the workspace never finishes is a real state,
   * and polling it until the tab closes is neither honest nor kind to the
   * workspace. After this long with no progress the card says so and the pump
   * stops; stop/retry are the human's next acts, both registered commands.
   */
  const RUN_QUIET_AFTER_MS = services.workflowQuietMs ?? 10 * 60 * 1000

  type JournalAnswer = Awaited<ReturnType<typeof gateway.runEvents>>
  type JournalRow = Extract<JournalAnswer, { status: "ok" }>["value"][number]
  type JournalPages =
    | { readonly status: "ok"; readonly value: ReadonlyArray<JournalRow>; readonly complete: boolean }
    | { readonly status: "error"; readonly message: string; readonly complete: boolean }

  /**
   * One cycle's journal suffix, read as pages.
   *
   * `run-events` answers a bounded page and the cursor it reached, so a single
   * call is the suffix only when the page came back short. A failed page keeps
   * whatever earlier pages read and leaves the cycle incomplete, so the next
   * one retries from the same cursor rather than skipping the gap.
   */
  const readJournalPages = async (
    repo: string,
    runId: string,
    binding: Parameters<typeof gateway.runEvents>[2],
    from: ProjectionCursor | undefined
  ): Promise<JournalPages> => {
    const rows: Array<JournalRow> = []
    let cursor = from
    for (let page = 0; page < JOURNAL_PAGES_PER_CYCLE; page += 1) {
      const answer = await gateway.runEvents(repo, runId, binding, cursor)
      if (answer.status !== "ok") {
        return rows.length === 0
          ? { status: "error", message: answer.message, complete: false }
          : { status: "ok", value: rows, complete: false }
      }
      rows.push(...answer.value)
      if (answer.value.length < JOURNAL_PAGE_LOOKS_FULL) return { status: "ok", value: rows, complete: true }
      // Older hosts omit cursor metadata. Advance from their recorded rows
      // before requesting another page; rereading a full prefix would append
      // it repeatedly and falsely report conflicting history.
      if (answer.cursor !== undefined) cursor = answer.cursor
      else {
        const last = answer.value.at(-1)!
        let offset = 0
        for (let i = answer.value.length - 2; i >= 0 && answer.value[i]?.sequence === last.sequence; i--) offset++
        if (cursor?.value === last.sequence) offset += cursor.offset + 1
        cursor = { selector: { _tag: "run-events", runId }, projection: "run-events", runId, value: last.sequence, offset }
      }
    }
    return { status: "ok", value: rows, complete: false }
  }

  const liveRunCards = (): Array<Extract<Card, { kind: "run-trace" }>> =>
    [...store.collections.cards.values()].filter(
      (card) =>
        card.kind === "run-trace" && card.runtimeView?.revision === undefined &&
        !pendingWorkflowLaunch(card) &&
        (card.payload.phase === "launching" ||
          card.payload.phase === "running" ||
          card.payload.phase === "waiting-approval" ||
          card.payload.phase === "reconnecting" ||
          (TERMINAL_PHASES.has(card.payload.phase) &&
            (engineProjectionPending(card.payload.events) ||
              store.committedRuntimeRun(runtimeRunKey(card.payload))?.journalPending === true)))
    ) as Array<Extract<Card, { kind: "run-trace" }>>

  const pokeableWait = (cardId: string, ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        ctx.pumpPokes.delete(cardId)
        resolve()
      }, ms)
      unref(timer)
      ctx.pumpPokes.set(cardId, () => {
        clearTimeout(timer)
        ctx.pumpPokes.delete(cardId)
        resolve()
      })
    })

  const patchRunCard = (
    cardId: string,
    patch: Partial<Extract<Card, { kind: "run-trace" }>["payload"]>
  ): void => {
    const card = store.collections.cards.get(cardId)
    if (ctx.disposed || card === undefined || card.kind !== "run-trace" || card.runtimeView?.revision !== undefined) return
    // Execution comes from the gateway observation. Watcher state is local
    // evidence and must not overwrite a run verdict or fan out to card copies.
    const state = patch.phase === "reconnecting" || patch.phase === "quiet" || patch.phase === "stopped" ? patch.phase : "connected"
    const scope = runtimeScopeOf(card)
    if (scope === undefined) return
    const observer: NonNullable<RuntimeRun["observer"]> = { state, ...(patch.observationError === undefined ? {} : { error: patch.observationError }), ...(patch.quietForMs === undefined ? {} : { quietForMs: patch.quietForMs }) }
    if (canonicalEventValue(store.committedRuntimeRun(runtimeRunKey(scope))?.observer) === canonicalEventValue(observer)) return
    store.dispatch({ type: "gateway.run.observer.changed", actor: "system", scope, observer })
  }

  /**
   * What the run has done since the card last looked, in words.
   *
   * The summary counts every fact a human asked about — turns, calls, edits —
   * so the line is computed from the counters rather than from a vocabulary of
   * event names this app would have to keep in step with the engine's.
   */
  const progressWords = (row: RunSummaryRow, previous: RunSummaryRow | undefined): string | undefined => {
    if (previous !== undefined && row.turns === previous.turns && row.calls === previous.calls) return undefined
    if (row.calls === 0 && row.turns === 0) return undefined
    return `${row.turns} ${row.turns === 1 ? "turn" : "turns"} · ${row.calls} ${
      row.calls === 1 ? "call" : "calls"
    }${row.callsFailed > 0 ? ` (${row.callsFailed} refused)` : ""}`
  }

  /** The approval cards a run is waiting on, bound to the existing round trip. */
  const upsertRunApprovals = async (runId: string, repo: string, workspaceId: string, rows: ReadonlyArray<ApprovalRow>, current: () => boolean): Promise<number> => {
    if (!current()) return 0
    await reconcileRunApprovals(store, { repo, runId, workspaceId }, rows)
    if (!current()) return 0
    let found = 0
    for (const approval of rows) {
      if (approval.runId !== runId || approval.status !== "pending") continue
      found += 1
      const id = approvalCardIdFor(store, { repo, runId, workspaceId }, approval.requestId)
      if (store.approvalRequest(id) !== undefined && store.collections.cards.get(id) !== undefined) continue
      const card: Card = {
        id,
        kind: "approval",
        title: approval.title,
        status: "active",
        createdAt: Date.now(),
        ordinal: nextTranscriptOrdinal(),
        payload: {
          capability: approval.title,
          runId,
          requestId: approval.requestId,
          // The submit-ready envelope the gateway published: the decision goes
          // back with it unchanged, so no client reconstructs authority.
          approval: approval.payload as Record<string, unknown>,
          ...(questionOf(approval) === undefined ? {} : { question: questionOf(approval)! }),
          repo, gatewayBindingVersion: 1, workspaceId
        }
      }
      if (!current()) return 0
      store.dispatch({ type: "card.upsert", actor: "system", card })
    }
    return found
  }

  /** A gate this run is still parked on, as the transcript itself holds it. */
  const runAwaitsApproval = (scope: RunScope): boolean =>
    [...store.collections.cards.values()].some(
      (entry) => {
        if (entry.kind !== "approval" || entry.payload.runId !== scope.runId || entry.payload.decision !== undefined) return false
        const recorded = runScopeFromCard(store, entry, scope.runId)
        return recorded !== undefined && sameRunScope(recorded, scope)
      }
    )

  /*
   * The run pump: re-read the run's summary until it settles. Consecutive
   * failures flip the card to the honest reconnecting state, and a store that
   * refuses a write stops it on the card; the pump never stops silently. Its
   * callers do not await it, so it never rejects either.
   */
  const pumpWorkflowRun = async (cardId: string, observeOnce = false): Promise<void> => {
    if (ctx.disposed || ctx.runPumps.has(cardId)) return
    const epoch = ctx.accountEpoch
    const pump = { stopped: false }
    ctx.runPumps.set(cardId, pump)
    const ownsPump = (): boolean => !ctx.disposed && ctx.accountEpoch === epoch && !pump.stopped && ctx.runPumps.get(cardId) === pump
    let failures = 0
    /** A gate the run announced whose approval row is not in hand yet. */
    let approvalPending = false
    /** When this run last actually moved — the clock behind the quiet bound. */
    let lastProgressAt = Date.now()
    /** The last summary read, so a repeated answer does not read as movement. */
    let previous: RunSummaryRow | undefined
    let journalCursor: ProjectionCursor | undefined
    let journalRevision: string | undefined
    let transcriptRevision: string | undefined
    let wasFollowing = false
    let retainedJournal: Extract<Card, { kind: "run-trace" }>["payload"]["events"]
    // A capped page can leave a verified prefix before a later page refuses.
    // Keep retrying that cursor; a first-page refusal has no prefix to protect.
    let incompleteJournalRetry = false
    /*
     * Evidence read this cycle could not be applied. Conflicting recorded
     * history stops watching and keeps the last verified evidence. A receipt
     * this browser failed to save is retried like an unreadable summary, and
     * counts toward the quiet bound. `true` means this pump is done.
     */
    const applyFailed = (error: unknown): boolean => {
      if (!ownsPump()) return true
      ctx.failures.report("run.pump", error, cardId)
      if (error instanceof RuntimeProjectionIntegrityError || (error instanceof AppEventIntegrityError && error.reason === "event")) {
        patchRunCard(cardId, { observationError: "The workspace returned conflicting recorded history. The last verified evidence was preserved.", phase: "stopped" })
        return true
      }
      failures += 1
      patchRunCard(cardId, { observationError: "This browser did not save the run's latest evidence. Retrying.", phase: "reconnecting" })
      return false
    }
    try {
      for (;;) {
        if (!ownsPump()) return
        const card = store.collections.cards.get(cardId)
        if (ctx.disposed || card === undefined || card.kind !== "run-trace" || card.runtimeView?.revision !== undefined) return
        if (pendingWorkflowLaunch(card)) return
        if (card.payload.authoring !== undefined && card.payload.runId === "") return
        const alreadyTerminal = TERMINAL_PHASES.has(card.payload.phase)
        const projectionPending = engineProjectionPending(card.payload.events)
        const journalPending = store.committedRuntimeRun(runtimeRunKey(card.payload))?.journalPending === true
        if (
          (alreadyTerminal && !observeOnce && !projectionPending && !journalPending) ||
          card.payload.phase === "no-capacity" ||
          card.payload.phase === "quiet" ||
          card.payload.phase === "stopped"
        ) {
          return
        }
        observeOnce = false
        /*
         * Nothing has moved for a very long time. Say so and stop — an
         * endlessly reconnecting or endlessly "running" card that nobody can
         * act on is the silent stall in a different costume.
         */
        const quietFor = Date.now() - lastProgressAt
        if (quietFor >= RUN_QUIET_AFTER_MS && (card.payload.statusRollup === undefined || failures > 0 || projectionPending || journalPending)) {
          patchRunCard(cardId, alreadyTerminal
            ? { observationError: "The run has settled, but its recorded engine evidence has not finished synchronizing." }
            : { phase: "quiet", quietForMs: quietFor })
          return
        }
        const { repo, runId, workspaceId } = card.payload
        if (workspaceId === undefined) {
          // A settled verdict stays; only the evidence it can no longer reach is said.
          patchRunCard(cardId, alreadyTerminal ? { observationError: RUN_BOX_GONE } : { phase: "stopped", observationError: RUN_BOX_GONE })
          return
        }
        const binding = { workspaceId }
        // A resume or an explicit inspection may supply a new full prefix.
        // Recover its position from the tail, without scanning old history.
        const normalized = store.committedRuntimeRun(runtimeRunKey(card.payload))
        if (normalized?.events !== retainedJournal) {
          const previousLength = retainedJournal?.length ?? 0
          const previousCursor = journalCursor
          retainedJournal = normalized?.events
          const sequence = retainedJournal?.at(-1)?.sequence
          journalCursor = undefined
          if (typeof sequence === "number" && retainedJournal !== undefined) {
            let offset = 0
            for (let i = retainedJournal.length - 2; i >= 0 && retainedJournal[i]?.sequence === sequence; i--) offset++
            journalCursor = {
              selector: { _tag: "run-events", runId }, projection: "run-events", runId,
              value: sequence, offset
            }
          }
          // Store validation can copy an unchanged prefix during another
          // card update. Its position still acknowledges the same revision.
          if (previousLength !== (retainedJournal?.length ?? 0) ||
            previousCursor?.value !== journalCursor?.value || previousCursor?.offset !== journalCursor?.offset) {
            journalRevision = undefined
          }
        }

        const summary = await gateway.run(repo, runId, binding)
        if (!ownsPump()) return
        if (summary.status !== "ok" || summary.value === undefined) {
          failures += 1
          if (failures >= 2 && !pump.stopped) {
            if (alreadyTerminal) {
              patchRunCard(cardId, { observationError: "The run has settled, but its latest engine evidence could not be read." })
              return
            }
            patchRunCard(cardId, { phase: "reconnecting" })
          }
          await pokeableWait(cardId, RUN_POLL_MS)
          continue
        }
        failures = 0
        const row = summary.value
        const revision = summary.cursor?.projection === "run-summary" && summary.cursor.runId === runId
          ? `${summary.cursor.value}:${summary.cursor.offset}`
          : undefined
        const words = progressWords(row, previous)
        const newSteps = words === undefined || card.payload.steps.includes(words) ? [] : [words]

        if (row.status === "waiting-approval" || row.waitingReason === "approval") approvalPending = true
        if (approvalPending || runAwaitsApproval(card.payload)) {
          const approvals = await gateway.approvals(repo, runId, binding)
          if (!ownsPump()) return
          // Keep asking until the gate is actually in hand: a parked run can
          // be readable a beat before its approval row is.
          if (approvals.status === "ok") {
            let found: number
            try {
              found = await upsertRunApprovals(runId, repo, workspaceId, approvals.value, ownsPump)
              if (!ownsPump()) return
            } catch (error) {
              if (applyFailed(error)) return
              await pokeableWait(cardId, RUN_POLL_MS)
              continue
            }
            if (found > 0) approvalPending = false
          }
        }

        /*
         * Lane runs — the card's transcript follows the live run while the
         * human asked it to (`runs.logs --follow`): changed revisions re-read
         * the projection and replace the rows, bound to the pump
         * the card already pays for. Unfollowing stops the merge, and a
         * terminal run keeps its last transcript standing.
         */
        let transcriptObservation: RuntimeRunObservation["transcript"]
        let transcriptCursor: ProjectionCursor | undefined
        let transcriptRead = false
        if (card.payload.follow === true && (!wasFollowing || revision === undefined || revision !== transcriptRevision)) {
          const transcript = await gateway.transcript(repo, runId, binding)
          if (!ownsPump()) return
          if (transcript.status === "ok") {
            transcriptObservation = [...transcript.value]
            transcriptCursor = transcript.cursor
            transcriptRead = true
          }
        }

        wasFollowing = card.payload.follow === true

        /*
         * Keep the journal prefix on the card and request only its suffix.
         * A failed read does not acknowledge the summary revision, so the
         * next cycle retries even when the run has not moved again.
         */
        let journalObservation: RuntimeRunObservation["journal"]
        let journalRead = false
        let journalAdvanced = false
        let journalComplete: boolean | undefined
        let eventReadError: string | undefined
        // A native projection can append after its control verdict settled,
        // without changing the summary cursor. Its own marker closes this read.
        if (revision === undefined || revision !== journalRevision || projectionPending || journalPending) {
          const journal = await readJournalPages(repo, runId, binding, journalCursor)
          journalComplete = journal.complete
          if (!ownsPump()) return
          const current = store.committedRuntimeRun(runtimeRunKey(card.payload))
          // An inspection that won this race already replaced our prefix.
          // Reconcile its cursor next cycle instead of appending twice.
          if (journal.status === "ok" && current?.events === retainedJournal) {
            journalObservation = { mode: journalCursor === undefined ? "full" : "suffix", after: journalCursor, events: [...journal.value] }
            if (journal.value.length > 0 && !journal.complete) incompleteJournalRetry = true
            // Empty journals and a first sequence-zero event share cursor
            // 0:0. Keep reading until at least one row establishes a prefix.
            // A cycle that stopped on its page budget has not read the whole
            // suffix, so it must not acknowledge the revision: the next cycle
            // continues from the same cursor.
            journalRead = journal.complete
            journalAdvanced = journal.value.length > 0
          } else if (journal.status !== "ok") eventReadError = journal.message
        }
        try {
          const committed = store.committedRuntimeRun(runtimeRunKey(card.payload))
          // Another local observer can commit while this read is in flight.
          // Retry that race from its applied cursor, not as an upstream conflict.
          if (committed?.revision !== normalized?.revision) {
            // The read still saw the run move (a cancel landing, say); the
            // lost write race must not let the quiet bound call it stalled.
            if (previous === undefined || row.status !== previous.status) lastProgressAt = Date.now()
            observeOnce = true
            await pokeableWait(cardId, RUN_POLL_MS)
            continue
          }
          const complete: RuntimeRunObservation = {
            scope: { repo, runId, workspaceId }, summary: row, summaryCursor: summary.cursor,
            ...(journalComplete === undefined ? {} : { journalComplete }),
            ...(transcriptObservation === undefined ? {} : { transcript: transcriptObservation, transcriptCursor }),
            ...(journalObservation === undefined ? {} : { journal: { mode: "full", events: journalObservation.mode === "full" ? journalObservation.events : [...(committed?.events ?? []), ...journalObservation.events] } })
          }
          const observation = changedRuntimeRunObservation(committed, complete, Date.now())
          // Accepted commands remain immutable facts. An idle transport read
          // enters no command at all; meaningful reads retain only new evidence.
          if (observation !== undefined) {
            const live = store.collections.runtimeRuns.get(runtimeRunKey(card.payload))
            let prepared: RuntimeRunObservation | undefined
            try {
              prepared = changedRuntimeRunObservation(live, complete, Date.now())
            } catch (error) {
              if (!(error instanceof RuntimeProjectionIntegrityError) || live?.revision === committed?.revision) throw error
              observeOnce = true
              await pokeableWait(cardId, RUN_POLL_MS)
              continue
            }
            // If identical evidence is merely optimistic, a small truthful
            // summary receipt still waits behind it and propagates its failure.
            await store.dispatch({ type: "gateway.run.observed", actor: "system", observation: prepared ?? {
              scope: complete.scope, summary: row, summaryCursor: summary.cursor
            } }).isPersisted.promise
          }
        } catch (error) {
          if (applyFailed(error)) return
          await pokeableWait(cardId, RUN_POLL_MS)
          continue
        }
        if (!ownsPump()) return
        // A transport response is not an applied cursor. Advance acknowledgments
        // only after persistence, including a validated read that changed nothing.
        if (transcriptRead) transcriptRevision = revision
        if (journalRead) {
          const applied = store.committedRuntimeRun(runtimeRunKey(card.payload))
          retainedJournal = applied?.events
          journalCursor = applied?.cursor
          journalRevision = journalCursor === undefined ? undefined : revision
        }
        // Only a nonempty, prefix-matched suffix assigns events. A higher
        // offset at the same sequence is also actual observation progress.
        if (journalAdvanced) lastProgressAt = Date.now()
        if (card.payload.authoring !== undefined) void ctx.observeFlowAuthoring(cardId)

        const phase = PHASE_OF_STATUS[row.status]
        if (TERMINAL_PHASES.has(phase)) {
          if (eventReadError !== undefined) patchRunCard(cardId, {
            observationError: `The run has settled, but its recorded engine evidence could not be read: ${eventReadError}`
          })
          if (!ownsPump()) return
          // A transcript line is a committed transition, so it frames the
          // failure from the same flow id and journalled code the card renders
          // from, read back from the evidence this cycle just persisted.
          if (!alreadyTerminal && !(phase === "completed" && row.flowId === "repository/setup")) store.dispatch({ type: "message.appended", actor: "system", text: phase === "completed" ? row.verdict : phase === "cancelled"
            ? "The run was cancelled." : `The run failed: ${runFailureOf({ workflow: row.flowId, error: row.verdict, events: store.committedRuntimeRun(runtimeRunKey(card.payload))?.events,
              failure: stampOf(row) }).message}` })
          // A refused evidence read is a terminal observation failure for this
          // watcher. Keep the real run phase and the error on the card, then
          // stop; retry is the explicit act that asks the gateway again. The
          // old `journalPending || ...` condition kept polling forever when a
          // native projection marker was present but its journal endpoint was
          // unavailable.
          if ((eventReadError === undefined || incompleteJournalRetry) && (
            journalComplete === false ||
            store.committedRuntimeRun(runtimeRunKey(card.payload))?.journalPending === true ||
            engineProjectionPending(store.committedRuntimeRun(runtimeRunKey(card.payload))?.events)
          )) {
            previous = row
            await pokeableWait(cardId, RUN_POLL_MS)
            continue
          }
          void readFlowDurations?.(repo, row.flowId, binding)
          return
        }
        // Movement uses recorded counters and appended events, never a successful
        // transport response by itself. Unchanged polling cannot postpone quiet.
        if (newSteps.length > 0 || journalAdvanced || previous === undefined || row.status !== previous.status) lastProgressAt = Date.now()
        previous = row
        await pokeableWait(cardId, RUN_POLL_MS)
      }
    } catch (error) {
      if (!ownsPump()) return
      ctx.failures.report("run.pump", error, cardId)
      /*
       * The store refused a transition outright (a lost owner, a privacy
       * retirement, a projection it would not apply). Nothing this pump does
       * next can land, so it stops and the card says why; "Check again" is the
       * next act. A store refusing even that has its own failure surface.
       */
      if (ownsPump()) {
        try { patchRunCard(cardId, { observationError: "This browser did not save the run's latest evidence.", phase: "stopped" }) } catch {}
      }
    } finally {
      /*
       * Only tear down THIS pump's registrations. "Stop watching" then "Check
       * again" can start a successor while this one is still unwinding its
       * last await, and an unconditional delete here would strip the live pump
       * out of the registry.
       */
      if (ctx.runPumps.get(cardId) === pump) {
        ctx.pumpPokes.delete(cardId)
        ctx.runPumps.delete(cardId)
      }
    }
  }

  /*
   * The two acts a quiet run offers, both registered commands so the card's
   * buttons dispatch through the one path everything else does.
   */
  const runCardFor = (cardId: string): Extract<Card, { kind: "run-trace" }> | undefined => {
    const card = store.collections.cards.get(cardId)
    return card?.kind === "run-trace" && card.runtimeView?.revision === undefined ? card : undefined
  }

  /**
   * The undecided request a budget or time guard parked the run on, if any.
   * A projection that cannot be read leaves the run to the cancel.
   */
  const guardGate = async (repo: string, runId: string, binding: { readonly workspaceId: string }): Promise<ApprovalRow | undefined> => {
    const gates = await gateway.approvals(repo, runId, binding)
    return gates.status === "ok"
      ? [...gates.value].reverse().find(row => row.status === "pending" && isGuardIncident((row.request as { readonly incident?: unknown } | null)?.incident))
      : undefined
  }

  /**
   * Stop watching, and stop the run.
   *
   * The old seam relayed no cancel, so it could only stop watching and had to
   * say so. This one does: the gateway's `Cancel` is durable and cross-process,
   * so the card can honestly say the run was stopped.
   */
  const stopWatchingRun = (cardId: string, reason?: string): string | void => {
    const card = runCardFor(cardId)
    if (card === undefined) return "That isn't a run card."
    const pump = ctx.runPumps.get(cardId)
    if (pump !== undefined) pump.stopped = true
    ctx.runPumps.delete(cardId)
    ctx.pumpPokes.get(cardId)?.()
    const binding = recordedRunBinding(card.payload)
    if ("error" in binding) {
      patchRunCard(cardId, { phase: "stopped", observationError: binding.error })
      return binding.error
    }
    const { repo, runId } = card.payload
    void guardGate(repo, runId, binding).then(async (gate) => {
      // A run a budget or time limit parked stops by denying the guard's own
      // request: the decision is durable and the run settles from it as
      // stopped. Any other run is cancelled.
      const stopped = gate === undefined
        ? await gateway.cancel(repo, runId, reason, binding)
        : await gateway.submitApproval(repo, gate.payload, "deny", binding)
      if (ctx.disposed) return
      if (stopped.status !== "ok") {
        patchRunCard(cardId, { phase: "stopped", observationError: stopped.message })
        return
      }
      // A cancel receipt records accepted intent. Read the resulting gateway
      // lifecycle before rendering a terminal execution outcome.
      patchRunCard(cardId, { phase: "running" })
      await pumpWorkflowRun(cardId, true)
    }).catch(error => ctx.failures.report("run.cancel", error, cardId))
    return undefined
  }

  const retryRunWatch = (cardId: string): string | void => {
    const card = runCardFor(cardId)
    if (card === undefined) return "That isn't a run card."
    if (card.payload.authoring !== undefined && card.payload.runId === "") {
      ctx.resumeFlowAuthoring(cardId)
      return
    }
    store.dispatch({ type: "gateway.run.observer.changed", actor: "system", scope: runtimeScopeOf(card)!, observer: { state: "connected", action: "retry" } })
    void pumpWorkflowRun(cardId, true)
    return undefined
  }

  /** Boot reconciliation: a live run card's pump resumes. */
  const resumeWorkflowRuns = (): void => {
    const epoch = ctx.accountEpoch
    const current = (): boolean => !ctx.disposed && ctx.accountEpoch === epoch
    if (!current()) return
    ctx.resumeFlowAuthoring()
    for (const card of liveRunCards()) void pumpWorkflowRun(card.id)
    // Inbox-only and already-settled runs may have no live pump. A previous
    // client could have committed the decision before its answer was lost.
    const scopes: RunScope[] = []
    for (const card of store.collections.cards.values()) {
      if (card.runtimeView?.revision !== undefined) continue
      const runIds = card.kind === "approval" && card.payload.chain !== true && card.payload.decision === undefined && card.payload.runId !== undefined
        ? [card.payload.runId]
        : card.kind === "approvals-inbox" ? card.payload.approvals.filter((row) => row.decision === undefined).map((row) => row.runId) : []
      for (const runId of runIds) {
        const scope = runScopeFromCard(store, card, runId)
        if (scope !== undefined && !scopes.some((prior) => sameRunScope(prior, scope))) scopes.push(scope)
      }
    }
    // A run recorded with no box has none to ask; its card refuses a decision with that sentence.
    for (const scope of scopes) if (scope.workspaceId !== undefined) void gateway.approvals(scope.repo, scope.runId, { workspaceId: scope.workspaceId }).then(async result => {
      if (!current()) return
      if (result.status === "ok") await reconcileRunApprovals(store, scope, result.value)
      else ctx.failures.report("approval.reconcile", result.message, scope.runId)
    }).catch(error => { if (current()) ctx.failures.report("approval.reconcile", error, scope.runId) })
  }
  ctx.resumeWorkflowRuns = resumeWorkflowRuns

  const stopWorkflowPumps = (): void => {
    for (const pump of ctx.runPumps.values()) pump.stopped = true
    ctx.runPumps.clear()
    ctx.pumpPokes.clear()
  }
  ctx.stopWorkflowPumps = stopWorkflowPumps
  return {
    pumpWorkflowRun,
    stopWatchingRun,
    retryRunWatch,
    resumeWorkflowRuns,
    stopWorkflowPumps
  }
}
