/*
 * `runs.takeover` and `runs.release` (cards/RunTakeover.ts): open the run's
 * box terminal, on the vendor session when the seat is a wrapped CLI, and
 * hand it back. The terminal is the existing box terminal (WorkspaceSeam
 * `openTerminal`), so it renders as the box's card in the chat; the resume
 * and exit lines are typed into that session like any keystrokes.
 */
import { harnessSessionOf, takeoverAct } from "../../cards/RunTakeover"
import type { CommandResult } from "../../flows/Flows"
import { runCardOf } from "../RepoContext"
import type { ControllerContext } from "./context"

export interface TakeoverController {
  readonly takeOver: (runId: string, sourceCard?: string) => Promise<CommandResult>
  readonly release: (runId: string, sourceCard?: string) => Promise<CommandResult>
}

export const createTakeoverController = (
  ctx: ControllerContext,
  deps: {
    readonly openTerminal: (workspaceId?: string) => Promise<string | void | { readonly value: string }>
    readonly input: (sessionId: string, data: string) => void
  }
): TakeoverController => {
  const { store } = ctx
  const cardOf = (runId: string, sourceCard?: string) => {
    const card = runCardOf(store, runId, sourceCard)
    return card === undefined ? `Open the run first (runs.open ${runId}): taking over starts on its card.` : card
  }

  const takeOver = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const card = cardOf(runId, sourceCard)
    if (typeof card === "string") return card
    if ("error" in card) return card.error
    const { workspaceId } = card.payload
    if (workspaceId === undefined) return `Run ${runId} has no box to take over.`
    /*
     * One driver per box terminal: a second take-over would type its resume
     * line into the first one's session. A run that settled while taken over
     * drives nothing, so it does not hold the box.
     */
    const driven = [...store.collections.cards.values()].find((other) =>
      other.kind === "run-trace" && other.payload.workspaceId === workspaceId && takeoverAct(other) === "release")
    if (driven?.kind === "run-trace") return `Run ${driven.payload.runId} is already taken over on this box; release it first.`
    const opened = await deps.openTerminal(workspaceId)
    if (typeof opened === "string") return opened
    if (opened === undefined) return `The terminal on run ${runId}'s box was superseded.`
    const box = store.collections.cards.get(`workspace-${workspaceId}`)
    const terminalSessionId = box?.kind === "workspace" ? box.payload.terminalSessionId : undefined
    if (terminalSessionId === undefined || terminalSessionId === "") return `The terminal on run ${runId}'s box did not open.`
    const harness = harnessSessionOf(card.payload.events ?? [])
    if (harness !== undefined) deps.input(terminalSessionId, `${harness.resume}\r`)
    const now = store.collections.cards.get(card.id)
    if (now?.kind === "run-trace") {
      await store.dispatch({ type: "card.upsert", actor: ctx.commandActor,
        card: { ...now, payload: { ...now.payload, takeover: { terminalSessionId } } } }).isPersisted.promise
    }
    return { value: `take-over run=${runId} terminal=${terminalSessionId}${harness === undefined ? "" : ` session=${harness.sessionId}`}` }
  }

  const release = async (runId: string, sourceCard?: string): Promise<CommandResult> => {
    const card = cardOf(runId, sourceCard)
    if (typeof card === "string") return card
    if ("error" in card) return card.error
    const held = card.payload.takeover
    if (held === undefined) return `Run ${runId} is not taken over.`
    /* Exit only a terminal the box still holds; a destroyed session has nothing to exit, and the field just clears. */
    const box = card.payload.workspaceId === undefined ? undefined : store.collections.cards.get(`workspace-${card.payload.workspaceId}`)
    const live = box?.kind === "workspace" && box.payload.terminalSessionId === held.terminalSessionId
    const harness = harnessSessionOf(card.payload.events ?? [])
    if (harness !== undefined && live) deps.input(held.terminalSessionId, `${harness.exit}\r`)
    /* Replace, never merge: a cleared field must not survive in the JSON journal. */
    const { takeover: _takeover, ...payload } = card.payload
    await store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: { ...card, payload } }).isPersisted.promise
    return { value: `release run=${runId}` }
  }

  return { takeOver, release }
}
