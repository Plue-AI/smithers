import { actorSharedState } from "../ActorBindings"
import type { AppStore } from "../AppStore"

/*
 * SAID ONCE, AND SAID FOR THIS ACT.
 *
 * Two surfaces can say the same sentence about one act: the door that refused
 * it (`message.appended` with `spoken: true`, see {@link Message.spoken}) and
 * the surface that reports the act's outcome — a form card's error row, the
 * command failure path. A second identical line reads as a second failure that
 * did not happen, so the reporting surface yields to the door's line.
 *
 * It yields to THAT line and only to that line. What makes a line the door's
 * is the door SAYING so, not its position: comparing against the transcript's
 * tail meant any line appended in between — another actor's, a seam's answer,
 * the next turn — brought the duplicate straight back, and, worse, a SECOND
 * lost act whose sentence happened to already be the tail went silent, which
 * is the fault this rule exists to prevent.
 *
 * The window is one half of telling the lines apart. A door's sentence from
 * minutes ago must not silence the act the person is looking at now, so the
 * caller records the transcript's latest ordinal when the act is admitted and
 * only a line spoken after that point can stand in for it. A caller with no
 * window of its own passes the ordinal as of now, which matches nothing.
 *
 * THE WINDOW ALONE IS NOT ENOUGH, and this is the second defect in this rule.
 * The sentences are a closed table (state/BrowserWriteFailure.ts), so any two
 * acts that overlap in time say the SAME sentence by construction, and both
 * windows are open while either door speaks: the act that surfaces last
 * matched the other act's line and went silent. Two lost acts, two toasts,
 * one line — the same silence, one door over.
 *
 * So a line is claimed, not merely matched: a door's sentence stands in for
 * AT MOST ONE act ({@link claimSpokenLine}). Whichever act reaches it first
 * takes it; the next act with the same sentence in the same window finds it
 * taken and says its own. The count is then exact in both directions — every
 * lost act gets one line, and no act gets two — without the transcript having
 * to carry an act identity it renders nowhere. The failure mode of a surface
 * that forgets to claim is one duplicate line, never silence.
 *
 * EVERY SURFACE THAT YIELDS CLAIMS, out of one set ({@link claimedSpokenLines}).
 * The form card's error row read the sentence without spending it, on the
 * reasoning that reading is not spending — but the row is a word owed to an
 * act, so yielding to a line another act already holds loses that word as
 * surely as swallowing a transcript line does. Driven (R104e part 3): act A
 * takes a door's line in the surfacing path, act B correctly states itself in
 * the transcript, and act B's form card printed nothing. The two surfaces are
 * two halves of one controller and share one claim set.
 */

type Transcript = Pick<AppStore["collections"], "messages">

/** The transcript's high-water mark, recorded before an act so its own lines can be told apart. */
export const latestOrdinal = (collections: Transcript): number => {
  // Message ordinals start at zero; an empty transcript's exclusive boundary
  // must precede its first line, just like AppProjection's ordinal allocator.
  let latest = -1
  for (const message of collections.messages.values()) latest = Math.max(latest, message.ordinal)
  return latest
}

/** Every line a door spoke with this sentence since `since`, oldest first. */
const spokenSince = (collections: Transcript, sentence: string, since: number): ReadonlyArray<{ id: string; ordinal: number }> =>
  [...collections.messages.values()]
    .filter((message) => message.spoken === true && message.ordinal > since && message.text === sentence)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((message) => ({ id: message.id, ordinal: message.ordinal }))

/**
 * The door lines already spent on an act, for one controller.
 *
 * Keyed on the controller's context, so the surfacing path and the form card
 * — and either principal's projection of them (state/ActorBindings.ts) — draw
 * from the same set. The acts that can collide are the acts of one person in
 * one session; nothing here outlives that controller.
 */
export const claimedSpokenLines = (context: object): Set<string> =>
  actorSharedState(context, "spoken-line-claims", () => new Set<string>())

/**
 * Take a door's line for this act, if one is still going spare.
 *
 * `claimed` is the surfacing path's own memory of the lines already spent on
 * an act; the oldest unclaimed line in the window is taken and recorded. A
 * second lost act carrying the same sentence inside the same window therefore
 * finds nothing to yield to and states itself, which is the whole point.
 */
export const claimSpokenLine = (collections: Transcript, sentence: string, since: number, claimed: Set<string>): boolean => {
  for (const line of spokenSince(collections, sentence, since)) {
    if (claimed.has(line.id)) continue
    claimed.add(line.id)
    return true
  }
  return false
}

/**
 * Lines the transcript no longer holds cannot be claimed again, and a session
 * that clears its conversation must not carry their ids forever. Called after
 * each claim, so the set tracks the transcript rather than the run's history.
 */
export const forgetVanishedClaims = (collections: Transcript, claimed: Set<string>): void => {
  if (claimed.size === 0) return
  const present = new Set([...collections.messages.values()].map((message) => message.id))
  for (const id of claimed) if (!present.has(id)) claimed.delete(id)
}
