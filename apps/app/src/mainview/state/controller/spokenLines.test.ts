import { expect, test } from "bun:test"
import type { AppStore } from "../AppStore"
import { claimSpokenLine, claimedSpokenLines, forgetVanishedClaims, latestOrdinal } from "./spokenLines"

/*
 * THE RULE'S OWN UNIT, away from any door, and this is where the overlap
 * clause is established: a door's line is SPENT when an act takes it, so it
 * stands in for at most one act. `latestOrdinal` bounds the window,
 * `claimSpokenLine` spends a line, `forgetVanishedClaims` lets a cleared
 * transcript go. Every surface that yields to a door's line — the surfacing
 * path and the form card's error row — spends out of one set
 * (`claimedSpokenLines`), which is why neither can take the other's line.
 */

type Line = { readonly id: string; readonly ordinal: number; readonly text: string; readonly spoken?: true }

const transcript = (...lines: ReadonlyArray<Line>): Pick<AppStore["collections"], "messages"> =>
  ({ messages: { values: () => lines.values() } }) as unknown as Pick<AppStore["collections"], "messages">

const SAID = "This browser has no room left."

test("the high-water mark is the transcript's largest ordinal, and -1 when it is empty", () => {
  expect(latestOrdinal(transcript())).toBe(-1)
  expect(latestOrdinal(transcript({ id: "first", ordinal: 0, text: SAID }))).toBe(0)
  expect(latestOrdinal(transcript(
    { id: "a", ordinal: 4, text: SAID },
    { id: "b", ordinal: 2, text: SAID }
  ))).toBe(4)
})

test("the first spoken line is claimable only by an act admitted before ordinal zero", () => {
  const first = transcript({ id: "first", ordinal: 0, text: SAID, spoken: true })
  const claimed = new Set<string>()
  const beforeFirst = latestOrdinal(transcript())
  expect(claimSpokenLine(first, SAID, beforeFirst, claimed)).toBe(true)
  expect([...claimed]).toEqual(["first"])
  expect(claimSpokenLine(first, SAID, beforeFirst, claimed)).toBe(false)
  expect(claimSpokenLine(first, SAID, latestOrdinal(first), new Set())).toBe(false)
})

test("spoken claims are scoped to their controller context", () => {
  const alice = {}, bob = {}
  const aliceClaims = claimedSpokenLines(alice)
  const bobClaims = claimedSpokenLines(bob)
  aliceClaims.add("first")
  expect(claimedSpokenLines(alice)).toBe(aliceClaims)
  expect([...bobClaims]).toEqual([])
  expect(bobClaims).not.toBe(aliceClaims)
})

test("only a door's own line, inside the window, carrying this sentence, can stand in for an act", () => {
  const lines = transcript(
    { id: "old", ordinal: 1, text: SAID, spoken: true },
    { id: "unspoken", ordinal: 3, text: SAID },
    { id: "other", ordinal: 4, text: "Something else.", spoken: true }
  )
  expect(claimSpokenLine(lines, SAID, 2, new Set())).toBe(false)
  // The same line, one ordinal earlier in the window, is the act's to take.
  expect(claimSpokenLine(lines, SAID, 0, new Set())).toBe(true)
})

test("a door's line is spent on one act: the next act with the same sentence says its own", () => {
  const lines = transcript({ id: "said", ordinal: 2, text: SAID, spoken: true })
  const claimed = new Set<string>()
  expect(claimSpokenLine(lines, SAID, 1, claimed)).toBe(true)
  expect(claimed.has("said")).toBe(true)
  // The second lost act inside the same window. This is R104d's counterexample.
  expect(claimSpokenLine(lines, SAID, 1, claimed)).toBe(false)
})

test("two doors that both spoke give two acts one line each, in ordinal order", () => {
  const lines = transcript(
    { id: "second", ordinal: 5, text: SAID, spoken: true },
    { id: "first", ordinal: 3, text: SAID, spoken: true }
  )
  const claimed = new Set<string>()
  expect(claimSpokenLine(lines, SAID, 2, claimed)).toBe(true)
  expect(claimSpokenLine(lines, SAID, 2, claimed)).toBe(true)
  expect([...claimed].sort()).toEqual(["first", "second"])
  expect(claimSpokenLine(lines, SAID, 2, claimed)).toBe(false)
})

test("a claim on a line the transcript no longer holds is forgotten", () => {
  const claimed = new Set(["gone", "kept"])
  forgetVanishedClaims(transcript({ id: "kept", ordinal: 1, text: SAID, spoken: true }), claimed)
  expect([...claimed]).toEqual(["kept"])
  // A cleared conversation leaves nothing to remember.
  forgetVanishedClaims(transcript(), claimed)
  expect([...claimed]).toEqual([])
})
