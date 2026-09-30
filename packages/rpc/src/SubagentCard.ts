/**
 * What a subagent card says, shared by the terminal and browser hosts so both
 * draw the same glyphs, header, activity rows, footer and grid (#2162).
 *
 * Each host adapts its own worker record into {@link Subagent}; every function
 * here is pure and reads the clock only through the `now` it is given.
 *
 * @since 1.0.0
 */

import stringWidth from "string-width"
import { live, type Status } from "./WorkerControls.ts"

/**
 * The color role a host maps onto its own palette.
 * @since 1.0.0
 * @category models
 */
export type Tone = "running" | "waiting" | "done" | "failed" | "stopped"

/**
 * A running glyph's frames, one every {@link frameMs}.
 * @since 1.0.0
 * @category constants
 */
export const frames = ["◐", "◓", "◑", "◒"] as const

/**
 * Milliseconds per spinner frame.
 * @since 1.0.0
 * @category constants
 */
export const frameMs = 150

/**
 * The glyph of a subagent that is not turning.
 * @since 1.0.0
 * @category constants
 */
export const still = "●"

/**
 * The spinner frame at `now`, so every running glyph turns together.
 * @since 1.0.0
 * @category glyphs
 */
export const spinner = (now: number): string => frames[Math.floor(Math.max(0, now) / frameMs) % frames.length]!

/**
 * The one status glyph and tone: live work that is moving spins, held or
 * settled work shows {@link still}.
 * @since 1.0.0
 * @category glyphs
 */
export const glyph = (status: Status, now: number): { readonly glyph: string; readonly tone: Tone } => {
  switch (status) {
    case "running":
      return { glyph: spinner(now), tone: "running" }
    case "requested":
    case "waiting":
      return { glyph: spinner(now), tone: "waiting" }
    case "queued":
    case "parked":
      return { glyph: still, tone: "waiting" }
    case "done":
      return { glyph: still, tone: "done" }
    case "failed":
      return { glyph: still, tone: "failed" }
    case "cancelled":
      return { glyph: still, tone: "stopped" }
  }
}

/**
 * A tool's two verbs: while it runs, and once it has run (success or error).
 * @since 1.0.0
 * @category models
 */
export interface Verb {
  readonly pending: string
  readonly done: string
}

/**
 * One activity entry: a tool call, or a line of the subagent's own text.
 * `target` is what the call acted on (a path, a query, a command).
 * @since 1.0.0
 * @category models
 */
export type Entry =
  | {
    readonly kind: "tool"
    /** The flow or tool name; it picks the default verbs. */
    readonly tool: string
    readonly state: "pending" | "done" | "error"
    readonly target: string
    /** The tool's own verbs, when it reports them; they win over the defaults. */
    readonly verb?: Verb
    readonly added?: number
    readonly removed?: number
    /** A command's exit status; nonzero marks the row failed. */
    readonly exit?: number
  }
  | { readonly kind: "text"; readonly text: string }

/**
 * A file the subagent changed, with its line counts.
 * @since 1.0.0
 * @category models
 */
export interface File {
  readonly path: string
  readonly added: number
  readonly removed: number
}

/**
 * The normalized subagent every host adapts into.
 * @since 1.0.0
 * @category models
 */
export interface Subagent {
  readonly title: string
  readonly status: Status
  /** The short model name (`sol`); absent when unknown. */
  readonly model?: string
  /** Epoch milliseconds the clock starts from. */
  readonly startedAt: number
  /** Epoch milliseconds the subagent settled; the clock stops here. */
  readonly endedAt?: number
  /** Oldest first. */
  readonly entries: ReadonlyArray<Entry>
  /** Changed files; absent or empty draws no files line. */
  readonly files?: ReadonlyArray<File>
}

/**
 * Default verbs for the tools both hosts run.
 * @since 1.0.0
 * @category constants
 */
export const verbs: Readonly<Record<string, Verb>> = {
  read: { pending: "Reading", done: "Read" },
  edit: { pending: "Editing", done: "Edited" },
  write: { pending: "Writing", done: "Wrote" },
  apply_patch: { pending: "Patching", done: "Patched" },
  bash: { pending: "Running", done: "Ran" },
  grep: { pending: "Searching", done: "Searched" },
  glob: { pending: "Finding", done: "Found" },
  ls: { pending: "Listing", done: "Listed" },
  "agent.delegate": { pending: "Delegating", done: "Delegated" },
  "tab.read": { pending: "Checking", done: "Checked" },
  "ui.publish": { pending: "Publishing", done: "Published" }
}

const capital = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`

/**
 * The verbs a tool row uses: the tool's own (capitalized), the default for
 * its name, else `Calling`/`Called` the tool.
 * @since 1.0.0
 * @category activity
 */
export const verb = (tool: string, given?: Verb): Verb =>
  given !== undefined
    ? { pending: capital(given.pending), done: capital(given.done) }
    : verbs[tool] ?? { pending: `Calling ${tool}`, done: `Called ${tool}` }

/**
 * Line counts as a row prints them: ` +18 -4`, ` +44`, ` -3`, or nothing.
 * @since 1.0.0
 * @category activity
 */
export const counts = (added = 0, removed = 0): string =>
  `${added > 0 ? ` +${added}` : ""}${removed > 0 ? ` -${removed}` : ""}`

/**
 * Added and removed lines in a unified diff, headers excluded. Hunk headers
 * delimit content, so a changed line such as `++n;` still counts.
 * @since 1.0.0
 * @category activity
 */
export const diffCounts = (diff: string): { readonly added: number; readonly removed: number } => {
  let added = 0
  let removed = 0
  // Lines still owed to the current hunk, from its `@@ -a,b +c,d @@` header.
  let oldLeft = 0
  let newLeft = 0
  for (const line of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      if (line.startsWith("+")) {
        added++
        newLeft--
        continue
      }
      if (line.startsWith("-")) {
        removed++
        oldLeft--
        continue
      }
      if (line.startsWith(" ") || line === "") {
        oldLeft--
        newLeft--
        continue
      }
      if (line.startsWith("\\")) continue
      oldLeft = 0
      newLeft = 0
    }
    const hunk = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line)
    if (hunk !== null) {
      oldLeft = hunk[1] === undefined ? 1 : Number(hunk[1])
      newLeft = hunk[2] === undefined ? 1 : Number(hunk[2])
      continue
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue
    if (line.startsWith("+")) added++
    else if (line.startsWith("-")) removed++
  }
  return { added, removed }
}

/** The first non-empty line, whitespace collapsed. */
const oneLine = (text: string): string =>
  (text.split("\n").find((line) => line.trim() !== "") ?? "").replace(/\s+/g, " ").trim()

/**
 * One activity row. `text` excludes the branch and the mark so a host can
 * color and clip it; {@link line} joins them.
 * @since 1.0.0
 * @category models
 */
export interface Row {
  readonly branch: "├" | "└"
  readonly text: string
  readonly mark: "" | "✓" | "✗"
  /** `pending` and `text` rows draw dim. */
  readonly state: "pending" | "done" | "error" | "text"
}

/**
 * An entry's words and mark: `Editing x…`, `Edited x +18 -4 ✓`, `Ran cmd ✗`.
 * @since 1.0.0
 * @category activity
 */
export const describe = (entry: Entry): Omit<Row, "branch"> => {
  if (entry.kind === "text") return { text: oneLine(entry.text), mark: "", state: "text" }
  const words = verb(entry.tool, entry.verb)
  const target = oneLine(entry.target)
  const subject = target === "" ? "" : ` ${target}`
  if (entry.state === "pending") return { text: `${words.pending}${subject}…`, mark: "", state: "pending" }
  const state = entry.exit !== undefined && entry.exit !== 0 ? "error" : entry.state
  return {
    text: `${words.done}${subject}${counts(entry.added, entry.removed)}${
      entry.exit === undefined ? "" : `  exit ${entry.exit}`
    }`,
    mark: state === "done" ? "✓" : "✗",
    state
  }
}

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/**
 * Text cut to `width` display columns at a grapheme boundary with a trailing `…`.
 * @since 1.0.0
 * @category layout
 */
export const clip = (text: string, width: number): string => {
  if (width <= 0) return ""
  if (stringWidth(text) <= width) return text
  let prefix = ""
  let used = 0
  for (const { segment } of graphemes.segment(text)) {
    const cells = stringWidth(segment)
    if (used + cells > width - 1) break
    prefix += segment
    used += cells
  }
  return `${prefix}…`
}

/**
 * A row as one line, `├ Read x ✓`; with `width`, the text is clipped so the
 * mark always shows.
 * @since 1.0.0
 * @category activity
 */
export const line = (row: Row, width?: number): string => {
  const mark = row.mark === "" ? "" : ` ${row.mark}`
  const room = width === undefined ? undefined : width - 2 - stringWidth(mark)
  return `${row.branch} ${room === undefined ? row.text : clip(row.text, room)}${mark}`
}

/**
 * Rows a card shows before the rest collapse into `… +N earlier`.
 * @since 1.0.0
 * @category constants
 */
export const visibleRows = 5

/**
 * The activity a card shows.
 * @since 1.0.0
 * @category models
 */
export interface Activity {
  /** Entries hidden above the rows. */
  readonly hidden: number
  /** `… +7 earlier`, or undefined when nothing is hidden. */
  readonly earlier: string | undefined
  readonly rows: ReadonlyArray<Row>
}

/**
 * The last `limit` entries as `├`/`└` rows.
 * @since 1.0.0
 * @category activity
 */
export const activity = (entries: ReadonlyArray<Entry>, limit = visibleRows): Activity => {
  const shown = entries.slice(Math.max(0, entries.length - limit))
  const hidden = entries.length - shown.length
  return {
    hidden,
    earlier: hidden > 0 ? `… +${hidden} earlier` : undefined,
    rows: shown.map((entry, index) => ({ branch: index === shown.length - 1 ? "└" : "├", ...describe(entry) }))
  }
}

/**
 * The files line and, when open, one `├`/`└` row per file.
 * @since 1.0.0
 * @category models
 */
export interface Files {
  /** `▸ 2 files +31 -6`, `▾` when open. */
  readonly line: string
  readonly rows: ReadonlyArray<{ readonly branch: "├" | "└"; readonly text: string }>
}

/**
 * Changed files summed per path in first-seen order; undefined when there are none.
 * @since 1.0.0
 * @category files
 */
export const files = (changes: ReadonlyArray<File> | undefined, open = false): Files | undefined => {
  const byPath = new Map<string, File>()
  for (const change of changes ?? []) {
    const seen = byPath.get(change.path)
    byPath.set(
      change.path,
      seen === undefined ? change : {
        path: change.path,
        added: seen.added + change.added,
        removed: seen.removed + change.removed
      }
    )
  }
  const list = [...byPath.values()]
  if (list.length === 0) return undefined
  const added = list.reduce((sum, each) => sum + each.added, 0)
  const removed = list.reduce((sum, each) => sum + each.removed, 0)
  return {
    line: `${open ? "▾" : "▸"} ${list.length} ${list.length === 1 ? "file" : "files"}${counts(added, removed)}`,
    rows: open
      ? list.map((each, index) => ({
        branch: index === list.length - 1 ? "└" as const : "├" as const,
        text: `${each.path}${counts(each.added, each.removed)}`
      }))
      : []
  }
}

/**
 * Wall time as the footer prints it: `42s`, `1m`, `1m 04s`, `2h`, `2h 05m`.
 * @since 1.0.0
 * @category footer
 */
export const duration = (ms: number): string => {
  const total = Math.floor(Math.max(0, ms) / 1000)
  if (total < 60) return `${total}s`
  const pad = (value: number) => String(value).padStart(2, "0")
  if (total < 3600) {
    const seconds = total % 60
    return `${Math.floor(total / 60)}m${seconds === 0 ? "" : ` ${pad(seconds)}s`}`
  }
  const minutes = Math.floor((total % 3600) / 60)
  return `${Math.floor(total / 3600)}h${minutes === 0 ? "" : ` ${pad(minutes)}m`}`
}

/**
 * The footer: the clock, the model, and a held status word.
 * @since 1.0.0
 * @category models
 */
export interface Footer {
  /** `42s` while live; `Done 1m 04s`, `Failed 1m`, `Stopped 1m 03s` once settled. */
  readonly clock: string
  /** `42s · sol`: the clock and the model. */
  readonly text: string
  /** `waiting`, `queued` or `parked`, drawn right-aligned; empty otherwise. */
  readonly aside: string
}

const settledWord: Partial<Record<Status, string>> = { done: "Done", failed: "Failed", cancelled: "Stopped" }

/**
 * The footer at `now`; a settled subagent's clock stops at `endedAt`.
 * @since 1.0.0
 * @category footer
 */
export const footer = (
  subagent: Pick<Subagent, "status" | "startedAt" | "endedAt" | "model">,
  now: number
): Footer => {
  const elapsed = duration((subagent.endedAt ?? now) - subagent.startedAt)
  const word = settledWord[subagent.status]
  const clock = word === undefined ? elapsed : `${word} ${elapsed}`
  const model = subagent.model ?? ""
  return {
    clock,
    text: model === "" ? clock : `${clock} · ${model}`,
    aside: subagent.status === "waiting" || subagent.status === "queued" || subagent.status === "parked"
      ? subagent.status
      : ""
  }
}

/**
 * Everything one card draws.
 * @since 1.0.0
 * @category models
 */
export interface Card {
  readonly glyph: string
  readonly tone: Tone
  readonly title: string
  readonly activity: Activity
  readonly files: Files | undefined
  readonly footer: Footer
  /** Lines the card needs, for hosts that lay out by rows. */
  readonly height: number
}

/**
 * One subagent's card at `now`; `open` expands the files list.
 * @since 1.0.0
 * @category cards
 */
export const card = (subagent: Subagent, now: number, options: { readonly open?: boolean } = {}): Card => {
  const status = glyph(subagent.status, now)
  const shown = activity(subagent.entries)
  const changed = files(subagent.files, options.open ?? false)
  return {
    glyph: status.glyph,
    tone: status.tone,
    title: subagent.title,
    activity: shown,
    files: changed,
    footer: footer(subagent, now),
    height: 1 + (shown.earlier === undefined ? 0 : 1) + shown.rows.length +
      (changed === undefined ? 0 : 1 + changed.rows.length) + 1
  }
}

/**
 * The batch header above a set of subagents.
 * @since 1.0.0
 * @category models
 */
export interface Header {
  /** The spinner while any subagent is live; empty once all settle. */
  readonly glyph: string
  readonly tone: Tone
  /** `Running 3 subagents`, then `Ran 3 subagents`. */
  readonly text: string
  /** `(1/3)` settled of total while live; empty once all settle. */
  readonly count: string
  /** `✓` when all are done, `✗` when any failed, else `■` when any stopped; empty while live. */
  readonly mark: "" | "✓" | "✗" | "■"
  /** One cell per subagent, settled first. */
  readonly bar: ReadonlyArray<"done" | "pending">
}

/**
 * The progress bar's cell glyph.
 * @since 1.0.0
 * @category constants
 */
export const barGlyph = "▰"

/**
 * The header for a batch's statuses at `now`.
 * @since 1.0.0
 * @category header
 */
export const header = (statuses: ReadonlyArray<Status>, now: number): Header => {
  const total = statuses.length
  const settled = statuses.filter((status) => !live(status)).length
  const noun = total === 1 ? "subagent" : "subagents"
  const bar = statuses.map((_, index) => index < settled ? "done" as const : "pending" as const)
  if (settled < total) {
    return {
      glyph: spinner(now),
      tone: "running",
      text: `Running ${total} ${noun}`,
      count: `(${settled}/${total})`,
      mark: "",
      bar
    }
  }
  const outcome = statuses.includes("failed")
    ? { tone: "failed" as const, mark: "✗" as const }
    : statuses.includes("cancelled")
    ? { tone: "stopped" as const, mark: "■" as const }
    : { tone: "done" as const, mark: "✓" as const }
  return { glyph: "", ...outcome, text: `Ran ${total} ${noun}`, count: "", bar }
}

/**
 * A header as one line without its bar: `◐ Running 3 subagents (1/3)`, `Ran 3 subagents ✓`.
 * @since 1.0.0
 * @category header
 */
export const headerLine = (value: Header): string =>
  [value.glyph, value.text, value.count, value.mark].filter((part) => part !== "").join(" ")

/**
 * How many of a transcript's newest subagent batches show in full; older
 * batches fold into one row that expands on activation.
 * @since 1.0.0
 * @category constants
 */
export const shownBatches = 10

/**
 * The batches that fold into the earlier row: every batch before the newest
 * `shownBatches`, oldest first. Empty while `open` or when none are older.
 * @since 1.0.0
 * @category header
 */
export const earlierBatches = <A>(batches: ReadonlyArray<A>, open = false): ReadonlyArray<A> =>
  open ? [] : batches.slice(0, Math.max(0, batches.length - shownBatches))

/**
 * The folded row's words: `3 earlier subagent batches`.
 * @since 1.0.0
 * @category header
 */
export const earlierLine = (count: number): string => `${count} earlier subagent ${count === 1 ? "batch" : "batches"}`

/**
 * The inline parent row when a background subagent settles: `◉ {title} finished`,
 * `◉ {title} failed` or `◉ {title} stopped`.
 * @since 1.0.0
 * @category cards
 */
export const finished = (
  title: string,
  status: Status = "done"
): { readonly glyph: "◉"; readonly tone: Tone; readonly title: string; readonly line: string } => ({
  glyph: "◉",
  tone: glyph(status, 0).tone,
  title,
  line: `◉ ${title} ${status === "failed" ? "failed" : status === "cancelled" ? "stopped" : "finished"}`
})

/**
 * A toast's words, matching the card: `◐ auth-audit · 42s`, `● docs · Done 1m 04s`.
 * @since 1.0.0
 * @category cards
 */
export const toast = (
  subagent: Pick<Subagent, "title" | "status" | "startedAt" | "endedAt">,
  now: number
): { readonly glyph: string; readonly tone: Tone; readonly text: string; readonly line: string } => {
  const status = glyph(subagent.status, now)
  const text = `${subagent.title} · ${footer(subagent, now).clock}`
  return { glyph: status.glyph, tone: status.tone, text, line: `${status.glyph} ${text}` }
}

/**
 * Grid bounds in columns: a card's minimum width, the most cards per row,
 * and the gap between cards.
 * @since 1.0.0
 * @category constants
 */
export const gridBounds = { min: 34, max: 4, gap: 1 } as const

/**
 * A card's place in the grid.
 * @since 1.0.0
 * @category models
 */
export interface Cell {
  /** Index into the cards laid out. */
  readonly index: number
  readonly row: number
  /** Columns from the grid's left edge. */
  readonly x: number
  readonly width: number
}

/**
 * Cards per row for `count` cards in `width` columns.
 * @since 1.0.0
 * @category layout
 */
export const columns = (width: number, count: number): number =>
  Math.max(1, Math.min(gridBounds.max, count, Math.floor((width + gridBounds.gap) / (gridBounds.min + gridBounds.gap))))

/**
 * `count` cards in rows across `width` columns. Each row fills the width,
 * so a short last row stretches; spare columns go to the leftmost cards.
 * @since 1.0.0
 * @category layout
 */
export const grid = (width: number, count: number): ReadonlyArray<ReadonlyArray<Cell>> => {
  const across = columns(width, count)
  const rows: Array<ReadonlyArray<Cell>> = []
  for (let first = 0; first < count; first += across) {
    const size = Math.min(across, count - first)
    const room = Math.max(0, width - gridBounds.gap * (size - 1))
    const base = Math.floor(room / size)
    const spare = room % size
    const cells: Array<Cell> = []
    let x = 0
    for (let at = 0; at < size; at++) {
      const cellWidth = base + (at < spare ? 1 : 0)
      cells.push({ index: first + at, row: rows.length, x, width: cellWidth })
      x += cellWidth + gridBounds.gap
    }
    rows.push(cells)
  }
  return rows
}

/**
 * Each row's height: its tallest card's, so a row's cards line up.
 * @since 1.0.0
 * @category layout
 */
export const rowHeights = (
  layout: ReadonlyArray<ReadonlyArray<Cell>>,
  heights: ReadonlyArray<number>
): ReadonlyArray<number> => layout.map((row) => Math.max(0, ...row.map((cell) => heights[cell.index] ?? 0)))
