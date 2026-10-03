import { installRequestId } from "../seams/InstallRequestId"
import type { AgentTurnCursor, AgentTurnJournalDelivery, AgentTurnJournalRequest, AgentTurnJournalReply } from "@smthrs/rpc/AgentTurnJournal"
import type { AgentChatMessage, StartAgentTurnRequest, StartAgentTurnResult } from "@smthrs/rpc/NativeAgent"
import type { ActiveTurn, ControllerContext } from "./context"
import type { HttpTurn, HttpTurnLeg } from "../HttpTurn"
import { HttpTurnIntegrityError, httpToolItems, httpToolLegCount } from "../HttpTurn"
import { boundTurnRequest } from "../AgentTurnPolicy"
import { agentFailureText } from "../../flows/agentTools"
import type { AgentCommandDiscovery } from "../../flows/agentTools"
import { agentRefusalText } from "@smthrs/rpc/RefusalCopy"
import { clientRefusal } from "@smthrs/rpc/Refusal"
import { AgentJournalIntegrityError } from "../../runtime/AgentPort"

interface Dependencies {
  readonly ownTurn: (turn: ActiveTurn) => ActiveTurn
  readonly isCurrentTurn: (turn: ActiveTurn) => boolean
  readonly contextMessages: () => ReadonlyArray<AgentChatMessage>
  readonly composeTurn: () => Pick<StartAgentTurnRequest, "context" | "instructions">
  /** Command selection for the turn's message, before its first leg (CommandSelection.ts). */
  readonly select: (turnId: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>
  readonly discover: AgentCommandDiscovery
  readonly settled: () => void
  readonly refused: (turnId: string, result: Extract<StartAgentTurnResult, { status: "error" }>, attemptId?: string) => void | Promise<void>
}

const capability = (): AgentTurnJournalRequest => {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  return { version: 1, legId: installRequestId(), token: [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("") }
}
const sameCursor = (left: AgentTurnCursor | undefined | null, right: AgentTurnCursor | undefined | null): boolean => left === right ||
  (!!left && !!right && left.version === right.version && left.runId === right.runId && left.legId === right.legId &&
    left.batch === right.batch && left.position === right.position && left.hash === right.hash)

/** An effect driver over committed HTTP projections. Replaying their reducer never enters this module. */
export const createHttpTurnDriver = (ctx: ControllerContext, dependencies: Dependencies) => {
  const { store, agent } = ctx
  const journal = agent.journal
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const driving = new Set<string>()
  const recovering = new Set<string>()
  const launchFailures = new Map<string, string>()
  const stopping = new Map<string, Promise<void>>()
  /** Attempts whose durable write failed: no further effects, only a settling interrupt. */
  const poisoned = new Set<string>()
  let pending = Promise.resolve()
  const owned = (attemptId: string): HttpTurn | undefined => {
    if (ctx.disposed) return undefined
    const turn = store.collections.httpTurns.get(attemptId)
    return turn?.status === "active" && ctx.activeTurn?.httpAttemptId === attemptId &&
      dependencies.isCurrentTurn(ctx.activeTurn) ? turn : undefined
  }
  const active = (attemptId: string): HttpTurn | undefined => poisoned.has(attemptId) ? undefined : owned(attemptId)
  const mirror = (turn: HttpTurn): ActiveTurn => dependencies.ownTurn({ id: turn.turnId, httpAttemptId: turn.id,
    receivedText: turn.receivedText, toolLegs: httpToolLegCount(store.collections.httpTurnLegs.values(), turn.id),
    toolItems: httpToolItems(store.collections.httpTurnLegs.values(), turn.id),
    pendingCall: store.collections.httpTurnLegs.get(turn.legId)?.call,
    runLaunch: turn.runLaunch, askClass: turn.askClass, claimBuffer: turn.claimBuffer })
  const clearTimer = (attemptId: string): void => { const timer = timers.get(attemptId); if (timer !== undefined) clearTimeout(timer); timers.delete(attemptId) }
  const finish = (attemptId: string): void => {
    clearTimer(attemptId)
    poisoned.delete(attemptId)
    const turn = store.collections.httpTurns.get(attemptId)
    if (turn !== undefined) journal?.disconnect(turn.turnId)
    if (ctx.activeTurn?.httpAttemptId === attemptId) ctx.activeTurn = undefined
    if (!ctx.disposed) dependencies.settled()
  }
  const interrupt = async (attemptId: string, status: "failed" | "cancelled" | "ambiguous", detail: string, silent = false): Promise<void> => {
    if (!owned(attemptId)) return
    await store.dispatch({ type: "http.turn.interrupted", actor: status === "cancelled" ? "user" : "system", attemptId, status, detail, ...(silent ? { silent: true } : {}) }).isPersisted.promise
    finish(attemptId)
  }
  const schedule = (attemptId: string): void => {
    if (journal === undefined || !active(attemptId) || timers.has(attemptId)) return
    const timer = setTimeout(() => {
      timers.delete(attemptId)
      void catchUp(attemptId).catch(error => ctx.failures.report("http.turn.driver", error)).finally(() => schedule(attemptId))
    }, 1_000)
    timers.set(attemptId, timer); ctx.unref(timer)
  }
  /*
   * A failed durable write stops this attempt's effects: nothing continues
   * from an optimistic projection without its receipt. The attempt then
   * settles honestly; if that write fails too, Stop or a reload settles it.
   */
  const fail = async (attemptId: string): Promise<void> => {
    poisoned.add(attemptId)
    clearTimer(attemptId)
    const turn = ctx.disposed ? undefined : store.collections.httpTurns.get(attemptId)
    if (turn) journal?.disconnect(turn.turnId)
    await interrupt(attemptId, "ambiguous", "This response could not be saved. Its outcome is unknown; it was not restarted.").catch(error => ctx.failures.report("http.turn.driver", error))
  }
  const launch = async (attemptId: string): Promise<void> => {
    const turn = active(attemptId), leg = turn && store.collections.httpTurnLegs.get(turn.legId)
    if (!turn || leg?.status !== "prepared") return
    const cancellation = stopping.get(turn.turnId)
    if (cancellation !== undefined) await cancellation
    if (!active(attemptId)) return
    const items = httpToolItems(store.collections.httpTurnLegs.values(), turn.id)
    const { request } = boundTurnRequest({ runId: turn.turnId, conversationId: store.session().activeBranchId ?? "branch-main", ...dependencies.composeTurn(), messages: [...dependencies.contextMessages(), ...items],
      tools: ctx.commands.toolSpecs(), journal: leg.journal }, items.length + 1)
    schedule(attemptId)
    try {
      const result = await agent.startTurn(request)
      if (!active(attemptId)) {
        if (ctx.disposed) return
        // A cancellation/ownership replacement can precede the host's late
        // acceptance. Disposal deliberately only disconnects for recovery.
        const saved = store.collections.httpTurns.get(attemptId)
        if (!ctx.disposed && result.status === "started" && (!saved || saved.status === "cancelled") && ctx.activeTurn?.id !== turn.turnId) {
          await agent.cancelTurn(turn.turnId)
        }
        return
      }
      if (result.status === "error" && result.refusal !== undefined) {
        if (result.refusal.code === "sign_in_required") {
          try { await dependencies.refused(turn.turnId, result, attemptId); finish(attemptId) }
          catch { await fail(attemptId) }
          return
        }
        const silent = store.collections.identitySessions.get("identity")?.state === "signed-out"
        await interrupt(attemptId, "failed", result.message, silent)
        if (!ctx.disposed) dependencies.refused(turn.turnId, result)
      } else if (result.status === "error") launchFailures.set(leg.id, result.message)
      // A transport error after POST is ambiguous. The read capability, not
      // another POST, establishes what the producer actually accepted.
    } catch { launchFailures.set(leg.id, "The turn connection stopped responding.") }
  }
  const drive = async (attemptId: string): Promise<void> => {
    if (driving.has(attemptId) || !active(attemptId)) return
    driving.add(attemptId)
    try {
      let turn = active(attemptId), leg = turn && store.collections.httpTurnLegs.get(turn.legId)
      if (!turn || !leg) return
      if (leg.status === "tool-ready") {
        await store.dispatch({ type: "http.tool.started", actor: "smithers", attemptId, legId: leg.id }).isPersisted.promise
        turn = active(attemptId)
        if (!turn || store.collections.httpTurnLegs.get(leg.id)?.status !== "tool-executing") return
        const call = leg.call!
        const result = await ctx.commands.executeForAgent({ name: call.name, arguments: call.args,
          httpCall: { turnId: turn.turnId, attemptId, legId: leg.id, callId: call.callId } }, dependencies.discover).catch((error: unknown) =>
          agentFailureText(agentRefusalText(clientRefusal(error))))
        if (!active(attemptId)) return
        await store.dispatch({ type: "http.tool.settled", actor: "smithers", attemptId, legId: leg.id, result }).isPersisted.promise
        turn = active(attemptId); leg = store.collections.httpTurnLegs.get(leg.id)
      }
      if (turn && leg?.status === "tool-settled" && active(attemptId)) {
        const next = capability()
        await store.dispatch({ type: "http.leg.prepared", actor: "system", attemptId, journal: next }).isPersisted.promise
        if (active(attemptId)?.legId !== next.legId) return
        await launch(attemptId)
      }
    } catch (error) { ctx.failures.report("http.turn.driver", error, attemptId); await fail(attemptId) } finally { driving.delete(attemptId) }
  }
  const afterCommit = (attemptId: string): void => {
    if (ctx.disposed) return
    const turn = store.collections.httpTurns.get(attemptId)
    if (!turn) return
    if (turn.status !== "active") { finish(attemptId); return }
    if (!active(attemptId)) return
    // Keep compatibility readers fresh; only the durable rows select work.
    ctx.activeTurn = mirror(turn)
    void drive(attemptId)
  }
  const apply = async (delivery: AgentTurnJournalDelivery): Promise<void> => {
    if (ctx.disposed) return
    const leg = store.collections.httpTurnLegs.get(delivery.cursor.legId)
    if (!leg || !active(leg.attemptId) || active(leg.attemptId)?.legId !== leg.id || delivery.cursor.runId !== leg.turnId) return
    try {
      if (delivery.type === "accepted") {
        await store.dispatch({ type: "http.leg.accepted", actor: "system", attemptId: leg.attemptId, legId: leg.id, cursor: delivery.cursor }).isPersisted.promise
      } else if (delivery.type === "batch") {
        let receipt
        try {
          receipt = store.dispatch({ type: "http.turn.batch.received", actor: "system", attemptId: leg.attemptId, legId: leg.id, batch: delivery.batch })
        } catch (error) {
          if (!(error instanceof HttpTurnIntegrityError)) throw error
          await interrupt(leg.attemptId, "ambiguous", "The saved response failed an integrity check. It was not replayed or restarted.")
          return
        }
        await receipt.isPersisted.promise
        afterCommit(leg.attemptId)
      }
    } catch (error) {
      ctx.failures.report("http.turn.driver", error, leg.attemptId)
      await fail(leg.attemptId)
      throw error
    }
  }
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    const next = pending.then(work)
    pending = next.catch(error => ctx.failures.report("http.turn.driver", error))
    return next
  }
  const applyPage = async (attemptId: string, requested: HttpTurnLeg, reply: AgentTurnJournalReply): Promise<void> => {
    if (!active(attemptId) || active(attemptId)?.legId !== requested.id) return
    if (reply.status === "error") {
      if (reply.code === "storage_failed") return
      if (reply.code !== "not-found" || recovering.has(requested.id) || launchFailures.has(requested.id)) {
        await interrupt(attemptId, "ambiguous", "This turn's saved output is unavailable. Its outcome is unknown; it was not restarted.")
      }
      return
    }
    if (reply.status === "retired") { await interrupt(attemptId, "ambiguous", "This turn's saved output was retired. It was not restarted."); return }
    if (reply.status !== "ok") throw new AgentJournalIntegrityError("Unexpected HTTP journal read response")
    if (reply.after.runId !== requested.turnId || reply.after.legId !== requested.id ||
      (requested.cursor !== undefined && !sameCursor(reply.after, requested.cursor)) ||
      (requested.cursor === undefined && (reply.after.batch !== 0 || reply.after.position !== 0))) throw new AgentJournalIntegrityError("Wrong HTTP replay boundary")
    const last = reply.batches.at(-1)
    const next: AgentTurnCursor = last === undefined ? reply.after : { version: 1, runId: last.runId, legId: last.legId, batch: last.batch, position: last.from + last.frames.length - 1, hash: last.hash }
    if (!sameCursor(next, reply.next) || reply.head.runId !== requested.turnId || reply.head.legId !== requested.id ||
      reply.head.batch < next.batch || reply.head.position < next.position || reply.more !== (reply.head.batch > next.batch) ||
      (!reply.more && !sameCursor(next, reply.head))) throw new AgentJournalIntegrityError("HTTP replay page cursor does not match its batches")
    if (requested.cursor === undefined) await apply({ type: "accepted", cursor: reply.after })
    let cursor = reply.after
    for (const batch of reply.batches) {
      cursor = { version: 1, runId: batch.runId, legId: batch.legId, batch: batch.batch, position: batch.from + batch.frames.length - 1, hash: batch.hash }
      await apply({ type: "batch", batch, cursor })
    }
    if (!sameCursor(cursor, reply.next)) throw new AgentJournalIntegrityError("HTTP replay page cursor does not match its batches")
  }
  const catchUp = async (attemptId: string): Promise<void> => {
    if (!journal) return
    // Exhaust bounded pages, rather than mistaking a full first page for current state.
    for (;;) {
      await pending
      const turn = active(attemptId), leg = turn && store.collections.httpTurnLegs.get(turn.legId)
      if (!turn || !leg || (leg.status !== "prepared" && leg.status !== "streaming")) return
      let reply: AgentTurnJournalReply
      try { reply = await journal.read({ runId: turn.turnId, journal: leg.journal, after: leg.cursor ?? null }) }
      catch (error) {
        if (!(error instanceof AgentJournalIntegrityError)) throw error
        await enqueue(() => interrupt(attemptId, "ambiguous", "The saved response failed an integrity check. It was not replayed or restarted.")
          .catch(() => fail(attemptId)))
        return
      }
      await enqueue(async () => {
        // The initial live stream may have committed while this read was in flight.
        if (!sameCursor(store.collections.httpTurnLegs.get(leg.id)?.cursor, leg.cursor)) return
        try { await applyPage(attemptId, leg, reply) }
        catch (error) {
          if (!(error instanceof AgentJournalIntegrityError)) { await fail(attemptId); throw error }
          await interrupt(attemptId, "ambiguous", "The saved response failed an integrity check. It was not replayed or restarted.").catch(() => fail(attemptId))
        }
      })
      if (reply.status !== "ok" || !reply.more) return
    }
  }
  const subscribe = (): void => {
    const saved = [...store.collections.httpTurns.values()].find(turn => turn.status === "active" && turn.turnId === store.session().turnId)
    if (!journal) {
      if (saved && store.session().phase === "responding") {
        ctx.activeTurn = mirror(saved)
        void interrupt(saved.id, "ambiguous", "This host cannot resume the saved HTTP turn. It was not restarted.").catch(error => ctx.failures.report("http.turn.driver", error))
      }
      return
    }
    ctx.onDispose(journal.subscribe(delivery => enqueue(() => apply(delivery))))
    ctx.onDispose(() => { for (const id of timers.keys()) clearTimer(id); const turn = ctx.activeTurn; if (turn?.httpAttemptId) journal.disconnect(turn.id) })
    if (!saved || store.session().phase !== "responding") return
    ctx.activeTurn = mirror(saved); recovering.add(saved.legId)
    const leg = store.collections.httpTurnLegs.get(saved.legId)
    if (leg?.status === "tool-executing") {
      void interrupt(saved.id, "ambiguous", "A tool was accepted before the app closed, but its result was not saved. Check its result before explicitly trying again.").catch(error => ctx.failures.report("http.turn.driver", error))
    } else {
      void catchUp(saved.id).catch(error => ctx.failures.report("http.turn.driver", error)).finally(() => schedule(saved.id))
      void drive(saved.id)
    }
  }
  const start = (turnId: string, text: string, retry: boolean, actor: "user" | "smithers", preserveDraft = false): Promise<boolean> => {
    if (!journal || ctx.disposed || store.session().phase !== "idle") return Promise.resolve(false)
    const attemptId = installRequestId(), access = capability()
    const receipt = store.dispatch({ type: "http.turn.started", actor, turnId, attemptId, text, retry, journal: access, preserveDraft })
    const turn = store.collections.httpTurns.get(attemptId)
    if (turn === undefined) return Promise.resolve(false)
    const pendingTurn = mirror(turn)
    ctx.activeTurn = pendingTurn
    const admitted = receipt.isPersisted.promise.then(() => true, error => {
      // A rollback must not strand Chat, or clear a newer attempt/account.
      if (ctx.activeTurn === pendingTurn) ctx.activeTurn = undefined
      throw error
    })
    void admitted.then(async () => {
      if (!active(attemptId)) return
      const selection = await dependencies.select(turnId)
      if (!active(attemptId)) return
      if (!selection.ok) return interrupt(attemptId, "failed", selection.message)
      return launch(attemptId)
    }).catch(error => ctx.failures.report("http.turn.driver", error))
    return admitted
  }
  const stop = (): boolean => {
    const attemptId = ctx.activeTurn?.httpAttemptId
    if (!attemptId) return false
    const turn = owned(attemptId)
    const cancelled = interrupt(attemptId, "cancelled", "Stopped the current response.").then(() => {
      if (turn && !ctx.disposed) return agent.cancelTurn(turn.turnId)
    })
    if (turn) {
      stopping.set(turn.turnId, cancelled)
      const remove = () => { if (stopping.get(turn.turnId) === cancelled) stopping.delete(turn.turnId) }
      void cancelled.then(remove, remove)
    } else void cancelled.catch(error => ctx.failures.report("http.turn.driver", error))
    return true
  }
  return { subscribe, start, stop, catchUp }
}
