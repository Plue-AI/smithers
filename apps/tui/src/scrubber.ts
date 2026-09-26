/**
 * The app's run scrubber (`apps/app` `PhaseStrip`) laid out in terminal cells.
 *
 * Phases, milestones, frame lines and notes all come from the shared fold
 * (`@smthrs/gateway/RunTrace`) through `Activity.model`; this module only
 * places them on a grid of columns and maps positions back to journal
 * sequences and transcript steps.
 */
import {
  type FrameLine,
  type Milestone,
  phaseBandGeometry,
  phaseExtent,
  type PhaseId,
  type TraceNote
} from "@smthrs/gateway/RunTrace"
import * as Activity from "./activity.ts"
import type * as Transcript from "./transcript.ts"

type Cell = Extract<Transcript.Item, { kind: "cell" }>

export const phases: Record<PhaseId, string> = {
  researching: "Researching",
  implementing: "Implementing",
  testing: "Testing",
  stuck: "Stuck",
  blocked: "Blocked",
  unrecorded: ""
}

export interface Segment {
  readonly phase: PhaseId
  readonly seq: number
  readonly left: number
  readonly width: number
  /** Empty when the segment is too narrow for its word. */
  readonly label: string
  /** At or before the playhead. */
  readonly reached: boolean
  readonly current: boolean
}

export interface Tick {
  readonly seq: number
  readonly tone: Milestone["tone"]
  /** The column the moment happened at. */
  readonly column: number
  /** Where its label starts, and which label row; the label is empty when there is no room. */
  readonly left: number
  readonly row: number
  readonly label: string
  readonly reached: boolean
}

export interface Layout {
  /** Columns before the track (the pause button), in it, and after it (phase and clock). */
  readonly lead: number
  readonly track: number
  readonly tail: number
  /** Label rows above the mark row. */
  readonly rows: number
  readonly segments: ReadonlyArray<Segment>
  readonly ticks: ReadonlyArray<Tick>
  /** Every recorded sequence and its column, in journal order. */
  readonly positions: ReadonlyArray<{ readonly seq: number; readonly column: number }>
  readonly knob: number
  readonly phase: string
  readonly elapsed: string
}

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), high)

/** `1:08`, `1:02:05`: the app's elapsed clock. */
export const clock = (ms: number): string => {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, "0")
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}

const LABEL_ROWS = 2
const LABEL_MAX = 18

export const layout = (activity: Activity.Activity, width: number, cursor?: number, now = Date.now()): Layout => {
  const model = Activity.model(activity)
  const columns = Math.max(1, Math.floor(width))
  const lead = columns >= 60 ? 10 : columns >= 24 ? 3 : 0
  const tail = columns >= 50 ? 14 : 0
  const track = Math.max(1, columns - lead - tail)
  const extent = phaseExtent(model)
  const axis = extent.end - extent.start
  const records = activity.records
  const columnAt = (at: number | undefined, index: number, count: number): number =>
    axis <= 0 || at === undefined
      ? Math.round((index / Math.max(count - 1, 1)) * (track - 1))
      : clamp(Math.round(((at - extent.start) / axis) * (track - 1)), 0, track - 1)
  const positions = records.map((record, index) => ({
    seq: record.sequence!,
    column: columnAt(record.occurredAt, index, records.length)
  }))
  const reached = (seq: number) => cursor === undefined || seq <= cursor
  const owner = cursor === undefined ? undefined : Activity.owner(model, cursor)
  const here = cursor === undefined
    ? model.bands.at(-1)
    : model.bands.find((band) => band.frames.includes(owner!)) ?? model.bands.findLast((band) => band.seq <= cursor)

  // Every band keeps at least one column while there are columns to give.
  const count = model.bands.length
  const starts = model.bands.map((band, index) =>
    Math.round((phaseBandGeometry(band, extent, index, count).left / 100) * track)
  )
  for (let index = 0; index < count; index++) {
    const floor = index === 0 ? 0 : starts[index - 1]! + 1
    starts[index] = clamp(Math.max(starts[index]!, floor), 0, Math.max(0, track - (count - index)))
  }
  const segments: Array<Segment> = []
  model.bands.forEach((band, index) => {
    const left = index === 0 ? 0 : starts[index]!
    const right = index === count - 1 ? track : starts[index + 1]!
    if (right <= left) return
    const word = phases[band.phase]
    segments.push({
      phase: band.phase,
      seq: band.seq,
      left,
      width: right - left,
      label: word.length + 1 <= right - left ? word : "",
      reached: reached(band.seq),
      current: band === here
    })
  })

  const labelled = track >= 40
  const occupied: Array<Array<readonly [number, number]>> = Array.from({ length: LABEL_ROWS }, () => [])
  let rows = 0
  const ticks = [...model.milestones]
    .filter((milestone) => milestone.label !== "")
    .sort((a, b) => a.seq - b.seq)
    .map((milestone): Tick => {
      const column = columnAt(milestone.at, 0, 1)
      const base = { seq: milestone.seq, tone: milestone.tone, column, reached: reached(milestone.seq) }
      if (!labelled) return { ...base, left: column, row: 0, label: "" }
      const word = milestone.label.length > LABEL_MAX ? `${milestone.label.slice(0, LABEL_MAX - 1)}…` : milestone.label
      const left = clamp(column - Math.floor(word.length / 2), 0, Math.max(0, track - word.length))
      const row = occupied.findIndex((spans) =>
        spans.every(([start, end]) => left > end + 1 || left + word.length + 1 < start)
      )
      if (row < 0) return { ...base, left: column, row: 0, label: "" }
      occupied[row]!.push([left, left + word.length])
      rows = Math.max(rows, row + 1)
      return { ...base, left, row, label: word }
    })

  const at = cursor === undefined ? undefined : positions.findLast((position) => position.seq <= cursor) ?? positions[0]
  const knob = at === undefined ? track - 1 : at.column
  const atMs = cursor === undefined
    ? activity.status === "running" ? now : records.at(-1)?.occurredAt ?? extent.end
    : records.findLast((record) => record.sequence! <= cursor)?.occurredAt ?? extent.start
  const phase = cursor === undefined && activity.status !== "running"
    ? activity.status === "completed" ? "Done" : activity.status === "cancelled" ? "Stopped" : "Failed"
    : here === undefined || here.phase === "unrecorded"
    ? cursor === undefined ? "Running" : "Working"
    : phases[here.phase]
  return {
    lead,
    track,
    tail,
    rows: labelled ? rows : 0,
    segments,
    ticks,
    positions,
    knob,
    phase,
    elapsed: clock(atMs - extent.start)
  }
}

/** The last position recorded at or before a column; the earliest when the column precedes them all. */
export const seqAt = (layout: Layout, column: number): number => {
  let reached: { seq: number; column: number } | undefined
  for (const position of layout.positions) {
    if (position.column <= column && (reached === undefined || position.column >= reached.column)) reached = position
  }
  return (reached ?? layout.positions[0])?.seq ?? 0
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
