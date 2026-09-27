import { decideApprovalAnswerInput } from "../ApprovalAnswerState"
import { signInByHandoff } from "../IdentityProvider"
import { browserWriteRefusal, lostActRefusal } from "../BrowserWriteFailure"
import { decideFormFieldInput } from "./forms"
import { reserveBrowserCommandGesture } from "../../flows/CommandGesture"
import type { PreparedWikiEdit } from "../../flows/CommandGesture"
import { payloadFor } from "../../flows/SlashPayload"
import { digest } from "@smthrs/core/Digest"
import type { CommandLifecycle, CommandRequest, PendingCommandInput } from "../../flows/CommandLifecycle"
import { canonicalEventValue } from "../EventValue"
import type { ControllerContext } from "./context"
import { INPUT_MODES, type InputMode } from "../InputMode"
import { createPrivacyActions } from "./privacyActions"

const currentHttpCall = (ctx: ControllerContext, call: CommandRequest["httpCall"]): boolean => {
  if (call === undefined) return true
  if (ctx.store.session().turnId !== call.turnId || ctx.store.session().phase !== "responding") return false
  if (call.attemptId === undefined && call.legId === undefined) return true // legacy adapters
  const turn = call.attemptId === undefined ? undefined : ctx.store.collections.httpTurns.get(call.attemptId)
  const leg = call.legId === undefined ? undefined : ctx.store.collections.httpTurnLegs.get(call.legId)
  return turn?.status === "active" && turn.turnId === call.turnId && turn.legId === leg?.id &&
    leg.attemptId === turn.id && leg.status === "tool-executing" && leg.call?.callId === call.callId
}

/** Command facts contain metadata only. Pending human edits never execute a form submission. */
export const createCommandIntentLifecycle = (ctx: ControllerContext, onAccepted?: (request: CommandRequest) => void,
  setInputMode?: (mode: InputMode) => Promise<void>,
  prepareWikiEdit?: (id: string, body: string) => PreparedWikiEdit | undefined): CommandLifecycle => ({
  before: createPrivacyActions(ctx).before,
  reserveGesture: (request, args, named) => {
    if (ctx.disposed || request.actor !== "user") return undefined
    let name = request.name
    if (name === "form.submit") {
      const id = typeof named?.cardId === "string" ? named.cardId : args?.trim()
      const card = id === undefined ? undefined : ctx.store.collections.cards.get(id)
      if (card?.kind !== "flow-form" || card.payload.via !== "user" || card.payload.submitting || card.status === "acted") return undefined
      name = card.payload.flow
    }
    if (name === "auth.sign-in") {
      if (ctx.services.openExternal !== undefined || !signInByHandoff(ctx.services.bootstrap) || ctx.store.collections.identitySessions.get("identity")?.state !== "signed-out") return undefined
    }
    if (name === "app.download" && (ctx.services.openExternal !== undefined || ctx.services.downloadUrl === null)) return undefined
    if (name === "chat.send" || name === "chat.queue") {
      if (request.name === "form.submit") return { name, composerDraftCurrent: () => false, release: () => {} }
      const text = named === undefined ? args : named.text
      if (typeof text === "string") return { name, composerDraftCurrent: ctx.store.captureComposerDraft(text), release: () => {} }
    }
    if (name === "chat.open") {
      // Prepare the local input during the gesture so immediate typing has a
      // destination. The flow (including microphone capture) still waits for
      // its receipt, and a dismissal while saving cancels that pending open.
      if (ctx.store.session().paletteOpen !== true) ctx.store.dispatch({ type: "palette.toggled", actor: "user", open: true })
      return { name, chatInputCurrent: () => ctx.store.session().paletteOpen === true, release: () => {} }
    }
    if (request.name === "input.mode" && setInputMode !== undefined) {
      const mode = named === undefined ? args?.trim() : named.mode
      if (typeof mode === "string" && INPUT_MODES.includes(mode as InputMode)) {
        // Local keyboard preferences must precede the next key, just like
        // opening Chat. No microphone starts here. The binding consumes this
        // receipt so a delayed command cannot replay an older selection.
        const inputModeChanged = setInputMode(mode as InputMode)
        void inputModeChanged.catch(() => {})
        return { name, inputModeChanged, release: () => {} }
      }
    }
    if (request.name === "wiki.edit" && prepareWikiEdit !== undefined) {
      const parsed = named === undefined ? payloadFor("wiki.edit", args, undefined, new Set()) : { payload: named }
      if (!("error" in parsed) && typeof parsed.payload.documentId === "string" && typeof parsed.payload.body === "string") {
        const edit = prepareWikiEdit(parsed.payload.documentId, parsed.payload.body)
        if (edit !== undefined) return { name, wikiEditPrepared: edit.complete, release: edit.release }
      }
    }
    return reserveBrowserCommandGesture(name)
  },
  accept: async (request, pendingFieldInput) => {
    if (ctx.disposed || request.invocation?.signal?.aborted) return { refusal: "The command's controller or turn is closed.", persistenceFailed: true }
    const privacyRefusal = createPrivacyActions(ctx).refuse(request.actor)
    if (privacyRefusal !== undefined) return { refusal: privacyRefusal, persistenceFailed: true, writeRefused: true }
    const lineage = request.invocation?.lineage
    const epoch = ctx.accountEpoch
    const owner = ctx.accountOwner() ?? null
    if (!currentHttpCall(ctx, request.httpCall)) {
      return { refusal: "This command belongs to a turn that is no longer active." }
    }
    // A form submission is a new gesture, not a replay of the incomplete ask
    // which rendered it. Its outer agent form.submit still owns a stable slot.
    const invocationKey = request.httpCall !== undefined ? digest(canonicalEventValue({ owner, actor: request.actor, httpCall: request.httpCall, name: request.name }))
      : lineage === undefined || request.source === "form" ? undefined : digest(canonicalEventValue({
        owner, actor: request.actor, lineage, slot: {
          chain: request.invocation!.slot.chain, link: request.invocation!.slot.link,
          ordinal: request.invocation!.slot.ordinal, key: request.invocation!.slot.key
        }, name: request.name
      }))
    const attempts = invocationKey === undefined ? [] : [...ctx.store.collections.commandIntents.values()]
      .filter(row => row.invocationKey === invocationKey).sort((a, b) => b.acceptedRevision - a.acceptedRevision)
    const existing = attempts[0]
    if (existing !== undefined && (existing.status !== "settled" || existing.retryable !== true)) return { refusal: existing.status === "accepted"
      ? "This command was already accepted, but its outcome is unknown. Check the result before explicitly trying again."
      : "This command already has a saved outcome. It will not run again from the same execution call." }
    const id = invocationKey === undefined ? `command-${crypto.randomUUID()}` : `command-call-${invocationKey}${attempts.length === 0 ? "" : `-${attempts.length + 1}`}`
    /*
     * Deciding and staging the human's pending edit happens BEFORE any write
     * and cannot fail the way a browser fails: the recovery record is written
     * through `writeEntityRecovery`, which answers `undefined` rather than
     * throwing. A throw from here is this app's own bug, so it is kept out of
     * the write classifier below — dressed as a lost write it would reach the
     * person as retry advice that can never work, and put a false line in
     * their transcript about a write that was never attempted.
     *
     * It is still theirs to hear. Every flow form in the app commits each
     * keystroke through this door, including this card's own setup question,
     * so a throw left to escape took the field back to the value it already
     * had and said nothing at all. It is answered as the programming error it
     * is: its own arm, its own fault class, and a sentence that says so.
     */
    let pendingInput: PendingCommandInput | undefined
    try {
      if (request.actor === "user" && request.name === "form.set" && pendingFieldInput !== undefined && "cardId" in pendingFieldInput) {
        const { cardId, field, value } = pendingFieldInput
        const candidate = ctx.store.collections.cards.get(cardId)
        const decided = decideFormFieldInput(candidate?.kind === "flow-form" ? candidate : undefined, cardId, field, value)
        if (!("error" in decided)) pendingInput = ctx.store.stagePendingCardInput(cardId, decided.card, id, field)
        else {
          const answer = decideApprovalAnswerInput(ctx.store, cardId, field, value)
          if (!("error" in answer)) pendingInput = ctx.store.stagePendingApprovalAnswer(answer, id)
        }
      } else if (request.actor === "user" && request.name === "signup.set" && pendingFieldInput !== undefined) {
        pendingInput = ctx.store.stagePendingSignupInput(pendingFieldInput.field, pendingFieldInput.value, id)
      }
    } catch (error) {
      pendingInput?.clear()
      ctx.failures.report("command.boundary", error, request.name)
      return { refusal: lostActRefusal(error), persistenceFailed: true, writeRefused: true }
    }
    try {
      await ctx.store.dispatch({ type: "command.intent.accepted", actor: request.actor,
        id, name: request.name, source: request.source, invocationKey }).isPersisted.promise
    } catch (error) {
      pendingInput?.clear()
      /*
       * The act reached nothing durable because this BROWSER would not take
       * the write, which is a different thing from the act being refused and
       * a different thing again from a bug. "The command could not be saved"
       * was true and unactionable: it named no cause, no next step, and for
       * two of these faults it left the reader to assume it was theirs.
       */
      return { refusal: browserWriteRefusal(error), persistenceFailed: true, writeRefused: true }
    }
    const clearRetiredInput = (): void => {
      // Navigation fences execution before pagehide, but its accepted private
      // input still belongs to the next page. A refused write above or an
      // account/turn change must continue to discard it.
      if (ctx.services.pageLifetime?.aborted !== true || ctx.accountEpoch !== epoch ||
        request.invocation?.signal?.aborted || !currentHttpCall(ctx, request.httpCall)) pendingInput?.clear()
    }
    const accepted = ctx.store.collections.commandIntents.get(id)
    if (ctx.disposed || ctx.accountEpoch !== epoch || request.invocation?.signal?.aborted || accepted?.status !== "accepted"
      || !currentHttpCall(ctx, request.httpCall)) {
      clearRetiredInput()
      return { refusal: "The command's controller, account, or turn changed before it could start.", persistenceFailed: true }
    }
    onAccepted?.(request)
    return { receipt: { id, actor: request.actor, acceptedRevision: accepted.acceptedRevision }, ...(pendingInput === undefined ? {} : { pendingInput: { clear: clearRetiredInput } }) }
  },
  canExecute: (receipt, request) => {
    const row = ctx.store.collections.commandIntents.get(receipt.id)
    return !ctx.disposed && !request.invocation?.signal?.aborted && row?.status === "accepted"
      && row.acceptedRevision === receipt.acceptedRevision && row.actor === receipt.actor
      && currentHttpCall(ctx, request.httpCall)
  },
  settle: async (receipt, outcome, retryableAuthorization = false) => {
    const accepted = ctx.store.collections.commandIntents.get(receipt.id)
    // Sign-out/reset may deliberately erase its own private acceptance. The
    // durable privacy transaction is the receipt; do not recreate erased metadata.
    if (!ctx.disposed && accepted === undefined) {
      try { await ctx.store.settled?.(); return true } catch { return false }
    }
    if (ctx.disposed || accepted?.status !== "accepted" || accepted.actor !== receipt.actor || accepted.acceptedRevision !== receipt.acceptedRevision) return false
    try {
      await ctx.store.dispatch({ type: "command.intent.settled", actor: receipt.actor, id: receipt.id, outcome: outcome.status,
        ...(retryableAuthorization && outcome.status === "failed" ? { retryable: true } : {}) }).isPersisted.promise
      return ctx.store.collections.commandIntents.get(receipt.id)?.status === "settled"
    } catch { return false }
  }
})
