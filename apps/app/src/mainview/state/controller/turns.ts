import { releaseInterruptedApproval } from "../ApprovalRecovery"
import { lostActRefusal } from "../BrowserWriteFailure"
import type { CommandOutcome } from "../../flows/Commands"
import { parseSubmit } from "../../flows/registry"
import type { Card } from "../AppState"
import { isCurrentApprovalAnswer, prepareApprovalAnswer } from "../ApprovalAnswerState"
import { parseApprovalActionId } from "../ApprovalReference"
import { identityProviderFor } from "../IdentityProvider"
import type { ControllerContext } from "./context"
import type { FailureController } from "./failures"
import { latestOrdinal } from "./spokenLines"

export interface TurnControllerDependencies {
  readonly settleTurnBilling: () => void
  /** The next transcript ordinal, so a refusal card lands at the end of the conversation. */
  readonly nextOrdinal: () => number
  readonly surfaceCommandFailure: FailureController["surfaceCommandFailure"]
  readonly forwardApprovalDecision: (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied",
    answer?: unknown
  ) => Promise<void>
  /** A decision clicked on the workspace approvals inbox, bound to its run and request. */
  readonly forwardInboxApprovalDecision: (
    cardId: string,
    requestId: string,
    decision: "approved" | "denied",
    runId?: string,
    answer?: unknown
  ) => Promise<void>
}

export interface TurnController {
  readonly subscribeToAgent: () => void
  readonly send: (text: string, admission?: { readonly turnId: string; readonly owner: string | null | undefined }, draftCurrent?: () => boolean) => Promise<boolean> | void
  readonly reset: () => void
  readonly stop: () => void
  readonly decideApproval: (id: string, decision: "approved" | "denied", answer?: unknown, question?: string) => void
  readonly retryLastTurn: () => string | void
}

/** Browser doors only. Model and tool execution belong to the host dispatcher. */
export const createTurnController = (ctx: ControllerContext, dependencies: TurnControllerDependencies): TurnController => {
  const { store } = ctx
  const { surfaceCommandFailure, forwardApprovalDecision, forwardInboxApprovalDecision } = dependencies
  const ownershipCurrent = (generation: number) => !ctx.disposed && ctx.accountEpoch === generation
  const missAsFailure = (name: string, outcome: CommandOutcome): CommandOutcome => outcome.status === "unknown-command"
    ? { status: "failed", error: `There is no /${name} flow. Type / to see everything Smithers can do.` }
    : outcome
  const send: TurnController["send"] = (text, admission, capturedDraft) => {
    if (ctx.disposed || (admission && ctx.accountOwner() !== admission.owner)) return
    const parsed = parseSubmit(text, ctx.commands.all())
    if (parsed.kind === "empty") return
    if (parsed.kind === "prompt") {
      // The installed composer uses createSharedPrompts. A runtime without
      // conversation admission must never fall back to browser execution.
      if (store.collections.identitySessions.get("identity")?.state === "signed-out") {
        // The gate names this origin's sign-in door and never clears the draft, so a refused receipt is reported, not thrown at the composer.
        return store.dispatch({ type: "chat.sign-in.required", actor: "system", provider: identityProviderFor(ctx.services), draft: text }).isPersisted.promise
          .then(() => false, error => { ctx.failures.report("turn.sign-in", error); return false })
      }
      void ctx.withToast("chat.unavailable", "Chat", "Chat", async () => { throw new Error("Conversation unavailable") })
      return Promise.resolve(false)
    }
    const generation = ctx.accountEpoch
    const draftCurrent = capturedDraft ?? store.captureComposerDraft(text)
    if (draftCurrent()) store.dispatch({ type: "composer.changed", actor: "user", draft: "" })
    const before = latestOrdinal(store.collections)
    void ctx.commands.run(parsed.name, parsed.kind === "command" ? parsed.args : undefined).then(outcome => {
      if (ownershipCurrent(generation)) surfaceCommandFailure(parsed.name, missAsFailure(parsed.name, outcome), before)
    })
  }
  const reset = () => {
    if (ctx.disposed) return
    ctx.stopWorkflowPumps()
    store.dispatch({ type: "conversation.reset", actor: "user" })
  }
  const approvalFailed = (cardId: string, error: unknown, generation: number, target?: { requestId: string; runId?: string }): void => {
    ctx.failures.report("approval.forward", error, cardId)
    if (!ownershipCurrent(generation)) return
    void releaseInterruptedApproval(store, store.collections.cards.get(cardId), lostActRefusal(error), target)
      .catch(failure => ctx.failures.report("approval.forward", failure, cardId))
  }

  const commitApprovalDecision = (id: string, decision: "approved" | "denied", answer?: unknown): void => {
    if (ctx.disposed) return
    const generation = ctx.accountEpoch
    const rowTarget = parseApprovalActionId(id)
    if (rowTarget !== undefined) {
      void forwardInboxApprovalDecision(rowTarget.cardId, rowTarget.requestId, decision, rowTarget.runId, answer).catch(error => approvalFailed(rowTarget.cardId, error, generation, rowTarget))
      return
    }
    /*
     * Legacy inbox actions used `inboxCardId:requestId`; they resolve only
     * when that request ID belongs to exactly one row: the gate's own approval card may never have landed in
     * this transcript, so the row forwards through the inbox card, which
     * carries the submit-ready envelope the gateway published.
     */
    const separator = id.indexOf(":")
    if (separator > 0) {
      const inboxCardId = id.slice(0, separator)
      const requestId = id.slice(separator + 1)
      const inbox = store.collections.cards.get(inboxCardId)
      if (inbox?.kind === "approvals-inbox") {
        void forwardInboxApprovalDecision(inboxCardId, requestId, decision, undefined, answer).catch(error => approvalFailed(inboxCardId, error, generation, { requestId }))
        return
      }
    }
    const displayed = store.collections.cards.get(id)
    const card = store.approvalRequest(id)
    if (card?.kind !== "approval" || displayed?.kind !== "approval" || displayed.status === "acted") return
    if (displayed.payload.pending === true || displayed.payload.decision !== undefined) return
    const { runId, requestId, approval } = card.payload
    if (runId === undefined || requestId === undefined || approval === undefined) {
      // A card without a run identity has no backend to decide against —
      // say so honestly instead of fake-freezing it.
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id,
        message: "This approval is not linked to a run, so there is nothing to send the decision to."
      })
      return
    }
    const pending = store.dispatch({ type: "card.approval.decision.pending", actor: "user", id })
    void pending.isPersisted.promise.then(() => ownershipCurrent(generation) ? forwardApprovalDecision(card, decision, answer) : undefined).catch(error => approvalFailed(id, error, generation))
  }

  const decideApproval = (id: string, decision: "approved" | "denied", answer?: unknown, question?: string): void => {
    if (ctx.disposed) return
    if (answer === undefined) { commitApprovalDecision(id, decision); return }
    const input = prepareApprovalAnswer(store, id, answer, question)
    if (input === undefined || decision !== "approved") return
    const generation = ctx.accountEpoch
    // An answer is never sent before its human input has a durable receipt.
    const receipt = store.dispatch({ type: "approval.answer.changed", actor: "user", ...input })
    void receipt.isPersisted.promise.then(() => {
      if (!ownershipCurrent(generation) || !isCurrentApprovalAnswer(store.collections.runtimeApprovals.get(input.id), input)) return
      commitApprovalDecision(id, decision, answer)
    }).catch(error => approvalFailed(id, error, generation))
  }

  return { subscribeToAgent: () => {}, send, reset, stop: () => {}, decideApproval, retryLastTurn: () => "Conversation unavailable" }
}
