/**
 * The app's run scrubber (`apps/app` `PhaseStrip`) laid out in terminal cells.
 *
 * Phases, milestones, frame lines and notes all come from the shared fold
 * (`@smthrs/gateway/RunTrace`) through `Activity.model`; this module only
 * places them on a grid of columns and maps positions back to journal
 * sequences and transcript steps.
 */
import type { FrameLine, TraceNote } from "@smthrs/gateway/RunTrace"
import * as Activity from "./activity.ts"
import type * as Transcript from "./transcript.ts"

type Cell = Extract<Transcript.Item, { kind: "cell" }>

/** The selected step, folded only through the inspected journal position. */
export const event = (activity: Activity.Activity, cursor?: number): {
  readonly label: string
  /** A person's stop is faint and a failure is red, as the transcript draws them. */
  readonly tone: "text" | "faint" | "danger"
  readonly index: number
  readonly total: number
} => {
  if (activity.records.length === 0) return { label: "", tone: "text", index: 0, total: 0 }
  const seq = cursor ?? activity.records.at(-1)?.sequence ?? 0
  const records = activity.records.filter((record) => record.sequence! <= seq)
  const model = Activity.model({ ...activity, records })
  const line = model.lines.at(-1)
  const ended = records.at(-1)?.kind
  const label = ended === "control.run.completed" ?
    "Done"
    : ended === "control.run.cancelled" ?
    "Stopped"
    : ended === "control.run.failed" ?
    "Failed"
    : line === undefined ?
    "Working"
    : [line.verb.toLowerCase(), line.subject, outcome(line)].filter(Boolean).join(" ")
  const tone = ended === "control.run.cancelled" ? "faint" : ended === "control.run.failed" ? "danger" : "text"
  return { label, tone, index: Activity.frameAt(activity, seq), total: Activity.openings(activity).length }
}

/**
 * The position a key moves the playhead to: arrows step frame to frame (one
 * numbered step each), brackets step milestone to milestone, Home and End
 * reach the ends. `undefined` when the key does not scrub.
 */
export const key = (activity: Activity.Activity, cursor: number | undefined, name: string): number | undefined => {
  const records = activity.records
  if (records.length === 0) return undefined
  const here = cursor ?? Infinity
  const first = records[0]!.sequence!, last = records.at(-1)!.sequence!
  const frames = Activity.openings(activity)
  const moments = Activity.model(activity).milestones.map((milestone) => milestone.seq).sort((a, b) => a - b)
  switch (name) {
    case "home":
      return first
    case "end":
      return last
    // By frame, not by sequence: from anywhere inside a frame the arrows reach its neighbours.
    case "left":
    case "up":
      return cursor === undefined
        ? frames.at(-1) ?? first
        : frames[Math.max(0, Activity.frameAt(activity, cursor) - 2)] ?? first
    case "right":
    case "down":
      return cursor === undefined ? last : frames[Activity.frameAt(activity, cursor)] ?? last
    case "[":
      return moments.findLast((seq) => seq < here) ?? moments[0] ?? cursor ?? last
    case "]":
      return moments.find((seq) => seq > here) ?? cursor ?? last
    default:
      return undefined
  }
}

const turnOf = (transcript: Transcript.Transcript, cell: Cell): Activity.Activity | undefined => {
  const past = transcript.past ?? []
  return cell.turn === undefined || cell.turn >= past.length ? transcript.activity : past[cell.turn]
}

/** The last cell written in each turn's frame: the one that carries the frame's line. */
const owners = new WeakMap<ReadonlyArray<Transcript.Item>, Map<string, string>>()
const ownerOf = (transcript: Transcript.Transcript, turn: number, frame: number): string | undefined => {
  let map = owners.get(transcript.items)
  if (map === undefined) {
    map = new Map()
    for (const item of transcript.items) {
      if (item.kind === "cell" && item.frame !== undefined) map.set(`${item.turn ?? 0}:${item.frame}`, item.id)
    }
    owners.set(transcript.items, map)
  }
  return map.get(`${turn}:${frame}`)
}

/** Notes that are receipts, not moments: the tree moved, a checkpoint was taken. */
const quiet = new Set(["changed", "checkpoint"])

export interface Step {
  readonly line?: FrameLine
  readonly notes: ReadonlyArray<TraceNote>
}

/** What the shared fold says about the frame a cell was written in. */
export const step = (transcript: Transcript.Transcript, cell: Cell): Step => {
  const activity = turnOf(transcript, cell)
  if (activity === undefined || cell.frame === undefined || cell.frame === 0) return { notes: [] }
  if (ownerOf(transcript, cell.turn ?? 0, cell.frame) !== cell.id) return { notes: [] }
  const model = Activity.model(activity)
  const line = model.lines.find((each) => each.frame === cell.frame)
  const notes = model.notes.filter((note) =>
    !quiet.has(note.title) && Activity.frameAt(activity, note.seq) === cell.frame
  )
  return line === undefined ? { notes } : { line, notes }
}

/** The right-aligned outcome of a step: the call's own result words, or that it failed. */
export const outcome = (line: FrameLine): string => line.failed ? "failed" : line.result

/** The transcript item a journal position happened in: its frame's cell in the current turn. */
export const target = (transcript: Transcript.Transcript, seq: number): string | undefined => {
  const activity = transcript.activity
  if (activity === undefined) return undefined
  const turn = transcript.past?.length ?? 0
  const frame = Activity.frameAt(activity, seq)
  let found: string | undefined
  for (const item of transcript.items) {
    if (item.kind !== "cell" || (item.turn ?? 0) !== turn || item.frame === undefined) continue
    if (item.frame <= frame && frame > 0) found = item.id
  }
  return found
}
