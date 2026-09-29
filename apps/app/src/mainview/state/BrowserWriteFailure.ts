import type { PlueFault } from "@smthrs/rpc/Refusal"
import type { UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { DurableStorageConflictError } from "../chain/DurableCollection"
import { WriterHeldByAnotherTabError, WriterMovedToAnotherTabError } from "./StorageRecoveryContract"

/**
 * Why a durable write this browser attempted did not land.
 *
 * A controller door that REFUSES an edit already owns its sentence. This file
 * is for the other half: an edit the door accepted, whose write to this
 * browser's saved data then FAILED. That half had no vocabulary at all, so it
 * reached the person as a rejected promise — one generic toast, gone after
 * four seconds, while the control that fired it snapped back to the value it
 * already had and the transcript said nothing. The person could not tell a
 * refusal from a lost write, and the only two strings available to describe
 * one were an internal flow id and a storage boundary key.
 *
 * The set is closed and every arm carries its own sentence, so a new way for a
 * write to fail cannot inherit a line that is merely vague, and cannot ship
 * with no line at all: `satisfies Record<BrowserWriteFault, …>` is a compile
 * error until somebody writes the words a person can act on.
 *
 * @since 1.0.0
 * @category models
 */
export type BrowserWriteFault =
  | "writer-moved"
  | "writer-held"
  | "storage-conflict"
  | "storage-full"
  | "storage-unavailable"

/**
 * Every way an act a person made can end without doing what they asked.
 *
 * The five write faults are the ones this browser is answerable for. The other
 * two are not about storage at all, and they are here because they end the
 * same way — the control snaps back to the value it already had — so they need
 * the same vocabulary or they inherit silence:
 *
 * - `app-bug`: this app threw where it had no business throwing. Dressed as a
 *   lost write it becomes retry advice that can never work; left untyped it
 *   became an unhandled rejection, which is a line only a maintainer reads.
 * - `cancelled`: the act was stopped before it finished, by the person or by a
 *   closing controller. Nothing is owed to somebody who already knows.
 *
 * @since 1.0.0
 * @category models
 */
export type LostActFault = BrowserWriteFault | "app-bug" | "cancelled"

/**
 * One row: the seam's copy (fault, sentence, actions) plus whether the
 * sentence is also spoken into the transcript.
 */
export interface LostActCopy extends UserFailureCopy {
  /**
   * Whether this sentence goes where the person is still looking a minute
   * later, and not only on a toast that leaves after four seconds.
   */
  readonly spoken: boolean
}

/*
 * `user` here never means "you did something wrong" — it means the act that
 * clears this is the person's, and naming it is more use to them than an
 * apology. The two faults that nothing they can do would have avoided say so
 * in their own words, per the app's rule that infra never blames the reader.
 */
export const LOST_ACT_COPY = {
  "writer-moved": {
    actions: ["use-here"],
    fault: "user",
    spoken: true,
    sentence: "Smithers moved to another tab of this browser, so that change was not saved. Make it again in that tab, or reload this page to take Smithers back here."
  },
  "writer-held": {
    actions: ["use-here"],
    fault: "user",
    spoken: true,
    sentence: "Smithers is already open in another tab of this browser, so that change was not saved. Use Smithers in that tab, or close it and reload this page, then make the change again."
  },
  "storage-conflict": {
    actions: ["retry"],
    fault: "infra",
    spoken: true,
    sentence: "Another Smithers tab saved over this browser's data first, so that change was not saved. Not your fault. Reload the page to pick up the current state, then make the change again."
  },
  "storage-full": {
    actions: [],
    fault: "user",
    spoken: true,
    sentence: "This browser has no room left for Smithers' saved data, so that change was not saved. Free space for this site in your browser settings, then make the change again."
  },
  "storage-unavailable": {
    actions: ["retry"],
    fault: "infra",
    spoken: true,
    sentence: "This browser did not save that change. Not your fault, and nothing about the change would have avoided it. Make it again; if it fails twice, reload the page."
  },
  /*
   * A bug says so. It does not borrow a storage fault's words, because "free
   * space" and "if it fails twice, reload" are acts that cannot fix code, and
   * it does not claim the change was not saved, because a bug can just as
   * easily run after the bytes landed.
   */
  "app-bug": {
    actions: ["retry"],
    fault: "infra",
    spoken: true,
    sentence: "Smithers hit a bug of its own, so that didn't finish. Not your fault, and nothing about what you did would have avoided it. Reload the page to see where it got to, then make the change again."
  },
  /*
   * A stopped act is the one arm nobody is owed a line for: the person (or the
   * closing tab) is the one who stopped it, and a notice for work that was
   * deliberately thrown away is the silent-lie shape in reverse.
   */
  "cancelled": {
    actions: [],
    fault: "user",
    spoken: false,
    sentence: "That was stopped before it finished, so it may not have run. Make it again if you still want it."
  }
} as const satisfies Record<LostActFault, LostActCopy>

/*
 * The quota rejection is the one failure here that arrives as somebody else's
 * type. Browsers disagree on how to spell it — a named DOMException in Chrome
 * and Safari, a legacy numeric code in older Firefox — so all three spellings
 * are read, and nothing is inferred from the message text.
 */
const quotaExceeded = (error: unknown): boolean => {
  if (typeof error !== "object" || error === null) return false
  const { name, code } = error as { name?: unknown; code?: unknown }
  return name === "QuotaExceededError" || name === "NS_ERROR_DOM_QUOTA_REACHED" || code === 22 || code === 1014
}

/*
 * The recognized half of the classification: a fault this app can name by a
 * type it threw itself, or by the quota spelling the browser used. Never reads
 * the failure's prose. `undefined` means nothing here recognized it, which is
 * a different answer at a write than it is anywhere else.
 */
const writeFault = (error: unknown): BrowserWriteFault | undefined => {
  if (error instanceof WriterMovedToAnotherTabError) return "writer-moved"
  if (error instanceof WriterHeldByAnotherTabError) return "writer-held"
  if (error instanceof DurableStorageConflictError) return "storage-conflict"
  if (quotaExceeded(error)) return "storage-full"
  return undefined
}

/*
 * A stopped act arrives as the signal's own reason: the abort DOMException
 * every browser throws from `throwIfAborted`, read by name rather than by its
 * prose, like the quota spelling above.
 */
const aborted = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { name?: unknown }).name === "AbortError"

/**
 * Classify a thrown durable write. The write is the only thing that ran, so an
 * unrecognized throw is this browser declining to save, under a spelling this
 * app has not met.
 *
 * @since 1.0.0
 * @category constants
 */
export const browserWriteFault = (error: unknown): BrowserWriteFault => writeFault(error) ?? "storage-unavailable"

/**
 * Classify anything thrown out of an act a person made.
 *
 * The difference from `browserWriteFault` is the default, and the default is
 * the whole point: at a write, an unrecognized throw IS the write failing, so
 * it is storage. Anywhere else — a door, a handler, the staging step that runs
 * before a write — an unrecognized throw is this app's own bug, and calling it
 * storage would hand the person retry advice for something no retry fixes.
 *
 * @since 1.0.0
 * @category constants
 */
export const lostActFault = (error: unknown): LostActFault =>
  writeFault(error) ?? (aborted(error) ? "cancelled" : "app-bug")

/**
 * The sentence a person reads for an act that did not do what they asked.
 * Never carries the thrown message, an internal id, or a decode message.
 *
 * @since 1.0.0
 * @category constants
 */
export const lostActRefusal = (error: unknown): string => LOST_ACT_COPY[lostActFault(error)].sentence

/**
 * Whether this app wrote this sentence about an act that reached nothing, and
 * owes it to the person where they are still looking.
 *
 * The sentences are this app's own closed set, so recognizing one is identity
 * against that set, not reading prose: a surface that is handed one of them
 * knows it must speak without every door in between having to carry a flag.
 *
 * @since 1.0.0
 * @category constants
 */
export const spokenLostAct = (sentence: string): boolean =>
  Object.values(LOST_ACT_COPY).some((copy) => copy.spoken && copy.sentence === sentence)

/**
 * The sentence a person reads when a change they made did not reach this
 * browser's saved data. Never carries the thrown message: those name a
 * storage boundary key or a flow id, which is an internal id in front of a
 * person and tells them nothing they can act on.
 *
 * @since 1.0.0
 * @category constants
 */
export const browserWriteRefusal = (error: unknown): string => LOST_ACT_COPY[browserWriteFault(error)].sentence

/**
 * Whose problem a lost write was, for a surface that reports fault classes.
 *
 * @since 1.0.0
 * @category constants
 */
export const browserWriteFaultClass = (error: unknown): PlueFault => LOST_ACT_COPY[browserWriteFault(error)].fault

/** Fault class for any lost act, using the same table as its refusal. */
export const lostActFaultClass = (error: unknown): PlueFault => LOST_ACT_COPY[lostActFault(error)].fault
