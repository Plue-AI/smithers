/**
 * The print channel: how a REPL frame's `console.log` calls become the bytes
 * its successor reads.
 *
 * Two jobs live here, and both were priced off the `rerun-r95repl` lane rather
 * than chosen.
 *
 * Every number here is a count of UTF-8 bytes, which is what the frame bound
 * and the retention ceiling both mean by "bytes": the notices this module writes
 * carry a `…`, three bytes wide and one UTF-16 unit, and counting them in units
 * put a frame one byte over its own ceiling.
 *
 * **Sharing the frame budget.** Statements used to cap independently at 4 KiB
 * each, head-first, under a 16 KiB frame bound that almost nobody reached: 197
 * of the lane's 357 printing frames had a statement cut, 191 of those while the
 * frame bound sat mostly unspent, and 3.06 MB went to per-statement caps against
 * 6 frames that ever reached the frame one. Head-first is the part that cost
 * verdicts — `sympy__sympy-13878` fused one `console.log` of 38,928 bytes whose
 * head was a Python deprecation banner, so what it lost was the tail: the result
 * of a three-minute test suite the same frame had just paid for, and the `git
 * diff` that would have shown it the edit was already in the tree. It re-ran
 * that suite four frames later. So the statements of a frame share one budget,
 * each is elided from the middle, and no ceiling moves: 16 KiB was the most a
 * frame could deliver before and it is the most now.
 *
 * **Compacting a printed structure.** A result printed whole is mostly repeated
 * keys — a grep hit names `file`, `line`, `text` once per match — so an array of
 * matches renders as file groups with numbered hits and context; other records
 * render as a table with the union of keys named once. It is keyed on the shape
 * and nothing else — this module knows no flow. Repeated keys save bytes;
 * sparse records with mostly distinct keys can cost more as a table.
 *
 * @since 0.1.0
 * @private
 * @slop
 */

import { isRecord } from "@smthrs/canonical/Record"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import type { Schema } from "effect"
import * as bytes from "./bytes.ts"
import * as elide from "./elide.ts"

/**
 * How many UTF-8 bytes of one frame's whole print buffer reach the next model turn.
 *
 * This is the only ceiling on the channel. A frame's statements *share* it:
 * each is middle-elided to the share it is apportioned, and a statement short
 * of its share hands the remainder back to the statements that are over theirs.
 *
 * They used to cap independently at 4 KiB each, head-first, and the r95repl
 * lane priced that: 197 of its 357 printing frames had a statement cut, 191 of
 * them while this frame budget sat mostly unspent, and 3.06 MB went to
 * per-statement caps against 6 frames that ever reached this one. The
 * `sympy__sympy-13878` run fused one `console.log` of 38,928 bytes; it was
 * shown the first 4,096 and lost the tail, which held the result of a
 * three-minute test suite the frame had already paid for. It ran that suite
 * again four frames later. Sharing the budget shows that frame 16 KiB from both
 * ends instead of 4 KiB from the head, and moves no ceiling: 16 KiB was the
 * most a frame could ever deliver before, and it is the most now.
 *
 * Every elision is from the middle with the dropped byte count stated, because
 * the head and the tail of a log are where it identifies itself, and the notices
 * are reserved out of this budget before any of it is apportioned — so the
 * assembled buffer is bounded outright and nothing has to shorten it a second
 * time. Sized against the `recall` budget it replaces, and delivered once rather
 * than re-rendered every frame.
 *
 * @category constants
 * @since 0.1.0
 */
export const printFrameBytes = 16 * 1024

/**
 * The smallest UTF-8-byte share of {@link printFrameBytes} one print statement is given.
 *
 * A share below this is all notice and no value — a middle elision of 80 bytes
 * says less than the sentence explaining it — so a frame that printed more
 * statements than the budget can floor drops whole statements from the middle
 * and states how many, rather than cutting every one of them to nothing. That
 * is the same shape the frame bound already had, applied a statement at a time
 * so nothing is cut mid-line.
 *
 * It bounds how many statements are *kept*, but it is not a division of the
 * budget: how many a frame can carry is priced off the statements it actually
 * printed, so a statement at or under this size is shown whole and costs only
 * itself. Two hundred eight-byte lines cost eighteen hundred bytes and all two
 * hundred survive; sixty statements of four times this size do not, and whole
 * ones go from the middle rather than every one of them being cut to a notice.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const printStatementFloor = 512

/**
 * How many UTF-8 bytes of one frame's print buffer the host keeps while the cell still runs.
 *
 * {@link printFrameBytes} bounds what the model is shown; this bounds what the
 * host holds to show it from, and the two are different numbers because they
 * answer different questions. A cell printing in a loop hands the host one
 * payload per statement, and every payload is copied out of the sandbox's heap
 * and decoded before anything can judge it surplus, so the frame budget alone
 * bounds the answer while leaving the work unbounded. Sixteen times the frame
 * budget is far past any honest use and still a fixed ceiling: past it the
 * payload is not read at all, and the count of what went unread is stated in the
 * buffer rather than dropped in silence.
 *
 * A statement is held at no more than {@link printFrameBytes} — the two ends of
 * it, with the size it had — because a whole frame's budget is the most any one
 * statement could ever be shown. So this ceiling holds at least sixteen
 * statements whatever a cell prints, and a cell that prints many small values
 * reaches it only after hundreds of them.
 *
 * @category constants
 * @since 0.1.0
 */
export const printRetainedBytes = 256 * 1024

/**
 * The fewest records an array needs before it is rendered as a table.
 *
 * Two rows do not repay a header line, and one row is not a table at all.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const tableRows = 3

/**
 * What the model is told when a print was cut: the value is still bound.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const recall = "print a narrower slice of this value; it is still bound in the realm"

/**
 * One `console.log` call, as the host kept it.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export interface Statement {
  /** The head and tail the host kept, in order and possibly the whole thing. */
  readonly text: string
  /** What the statement rendered to before anything was dropped. */
  readonly bytes: number
}

const cell = (value: Schema.Json): string =>
  typeof value === "string" && !value.includes("\n") && !value.includes("|")
    ? value
    : CanonicalJson.stringify(value)

/** A source line, shared by hits and their context. */
type MatchLine = { readonly line: number; readonly text: string }

/** The optional symbol attached to a source hit. */
type MatchSymbol = {
  readonly kind: string
  readonly name: string
  readonly startLine: number
  readonly endLine: number
}

/** The exact match shape; additional data must survive in the generic table. */
type Match = MatchLine & {
  readonly file: string
  readonly before?: ReadonlyArray<MatchLine>
  readonly after?: ReadonlyArray<MatchLine>
  readonly symbol?: MatchSymbol
}

const isMatchLine = (value: Schema.Json): value is MatchLine =>
  isRecord<Schema.Json>(value) && Object.keys(value).length === 2 &&
  Number.isInteger(value.line) && typeof value.text === "string"

const isMatchSymbol = (value: Schema.Json | undefined): value is MatchSymbol =>
  isRecord<Schema.Json>(value) && Object.keys(value).length === 4 &&
  typeof value.kind === "string" && typeof value.name === "string" &&
  Number.isInteger(value.startLine) && Number.isInteger(value.endLine)

const isMatch = (value: Schema.Json): value is Match =>
  isRecord<Schema.Json>(value) &&
  typeof value.file === "string" && Number.isInteger(value.line) && typeof value.text === "string" &&
  Object.keys(value).every((key) => ["file", "line", "text", "before", "after", "symbol"].includes(key)) &&
  (!Object.hasOwn(value, "before") || Array.isArray(value.before) && value.before.every(isMatchLine)) &&
  (!Object.hasOwn(value, "after") || Array.isArray(value.after) && value.after.every(isMatchLine)) &&
  (!Object.hasOwn(value, "symbol") || isMatchSymbol(value.symbol))

/** Renders nonempty match lists in consecutive file groups, using rg's line markers. */
const matchList = (value: Schema.Json): string | undefined => {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isMatch)) return undefined
  const lines: Array<string> = []
  let previousFile: string | undefined
  let previousLine = 0
  for (const match of value) {
    const before = match.before ?? []
    const after = match.after ?? []
    if (match.file !== previousFile) lines.push(match.file)
    else if ((before[0]?.line ?? match.line) > previousLine + 1) lines.push("--")
    for (const context of before) lines.push(`${context.line}-${context.text}`)
    const symbol = match.symbol
    const suffix = symbol === undefined ? "" : `  ‹${symbol.kind} ${symbol.name} ${symbol.startLine}-${symbol.endLine}›`
    lines.push(`${match.line}:${match.text}${suffix}`)
    for (const context of after) lines.push(`${context.line}-${context.text}`)
    previousFile = match.file
    previousLine = after.at(-1)?.line ?? match.line
  }
  return lines.join("\n")
}

/**
 * Renders an array of records as a table, or nothing.
 *
 * Columns are the union of keys in first-seen order. An absent member is an
 * empty cell; explicit null, empty arrays and empty objects stay `null`, `[]`
 * and `{}`. Cells are the string itself where that is unambiguous — no newline,
 * no column separator — and canonical JSON everywhere else. An empty string
 * still looks absent, and a string spelling a JSON literal still looks like
 * that value: this is a log rather than a wire format, so it is not paid for in
 * quoting every cell.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const table = (value: Schema.Json): string | undefined => {
  if (!Array.isArray(value) || value.length < tableRows) return undefined
  if (!value.every(isRecord<Schema.Json>)) return undefined
  const columns = [...new Set(value.flatMap((element) => Object.keys(element)))]
  if (columns.length < 2) return undefined
  const rows = value.map((element) =>
    columns.map((column) => Object.hasOwn(element, column) ? cell(element[column]!) : "").join(" | ")
  )
  return `${columns.join(" | ")}\n${rows.join("\n")}`
}

/**
 * Renders one printed JSON value compactly.
 *
 * A match list becomes numbered source lines; other records become a table.
 * An object with exactly one such member becomes that object's other members
 * as JSON, then the member's name, count and rendered list. An exact failed-call
 * envelope becomes its code, message and optional hint. Everything else is
 * canonical JSON as before.
 *
 * Tables save repeated keys but pay for every column boundary, including
 * absent members. The three-row, two-column floor saves bytes for uniform
 * records; it does not guarantee savings for sparse records. Rendering stays
 * shape-based rather than comparing both encodings.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const render = (value: Schema.Json): string => {
  // A string is itself, which is what `Cell.renderText` promises everywhere
  // else the harness renders a projected value. The prelude sends a primitive
  // string down the `text` side, so this arm answers only for a boxed one.
  if (typeof value === "string") return value
  const flat = matchList(value) ?? table(value)
  if (flat !== undefined) return flat
  if (!isRecord<Schema.Json>(value)) return CanonicalJson.stringify(value)
  const error = value.error
  if (
    Object.keys(value).length === 2 && value.ok === false &&
    isRecord<Schema.Json>(error) &&
    typeof error.code === "string" && typeof error.message === "string" &&
    Object.keys(error).every((key) => key === "code" || key === "message" || key === "hint") &&
    (!Object.hasOwn(error, "hint") || typeof error.hint === "string")
  ) {
    return `failed (${error.code}): ${error.message}${Object.hasOwn(error, "hint") ? ` — hint: ${error.hint}` : ""}`
  }
  const tabled = Object.entries(value).flatMap(([key, member]) => {
    const rendered = matchList(member) ?? table(member)
    return rendered === undefined ? [] : [[key, member as ReadonlyArray<unknown>, rendered] as const]
  })
  if (tabled.length !== 1) return CanonicalJson.stringify(value)
  const [key, member, rendered] = tabled[0]!
  const rest = Object.fromEntries(Object.entries(value).filter(([name]) => name !== key))
  return `${
    Object.keys(rest).length === 0 ? "" : `${CanonicalJson.stringify(rest)}\n`
  }${key} (${member.length}):\n${rendered}`
}

/**
 * Apportions one budget across statements of the given sizes.
 *
 * Short statements take what they need and hand the remainder back, so a frame
 * that printed one long value and three short ones spends the budget on the long
 * one. Allocation runs shortest first, which is what makes the hand-back
 * possible, and the result is in the order the sizes were given.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const shares = (sizes: ReadonlyArray<number>, budget: number): ReadonlyArray<number> => {
  const order = sizes.map((size, index) => ({ size, index })).sort((left, right) =>
    left.size === right.size ? left.index - right.index : left.size - right.size
  )
  const allotted = new Array<number>(sizes.length).fill(0)
  let remaining = budget
  let left = sizes.length
  for (const { index, size } of order) {
    const fair = Math.floor(remaining / left)
    const given = Math.min(size, fair)
    allotted[index] = given
    remaining = remaining - given
    left = left - 1
  }
  return allotted
}

/** The line a frame writes about the statements it dropped whole. */
const droppedNotice = (count: number): string =>
  `… ${count} print statements elided from the middle of this frame; the values are still bound in the realm.`

/** The line a frame writes about the statements the host never copied out. */
const unreadNotice = (count: number): string =>
  `… ${count} further print statements were not kept: this frame printed more than the harness holds.`

/**
 * What keeping one statement costs the budget: its floor, its notice, its newline.
 *
 * A statement at or under {@link printStatementFloor} costs only itself
 * and no notice, because {@link buffer} shows it whole and a whole statement has
 * nothing to say about what it lost. One over the floor is promised the floor,
 * and the notice that shortening it prints is charged with it.
 */
const price = (statement: Statement): number =>
  Math.min(statement.bytes, printStatementFloor) +
  (statement.bytes > printStatementFloor ? elide.noticeCost(statement.bytes, recall) : 0) + 1

/**
 * How many of *these* statements a budget can keep at the floor, head first.
 *
 * A count of the statements in hand rather than a constant, because what a
 * statement costs is what it is. Taken as `printFrameBytes / printStatementFloor`
 * it was 32 whatever a frame printed, so a frame of two hundred eight-byte lines
 * dropped a hundred and sixty-eight of them while fifteen of its sixteen
 * kilobytes went unspent — the failure the shared budget exists to end,
 * reintroduced one level up. Two hundred lines that cost nine bytes each cost
 * eighteen hundred, and the budget keeps every one of them.
 *
 * The walk takes the head, then the tail, then the head again, which is the
 * order {@link buffer} assembles them in, so a budget that affords an odd number
 * spends the odd one on the earlier statement.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const capacity = (statements: ReadonlyArray<Statement>, budget: number): number => {
  let left = budget
  let kept = 0
  while (kept < statements.length) {
    const statement = kept % 2 === 0 ? statements[kept / 2]! : statements[statements.length - 1 - (kept - 1) / 2]!
    const cost = price(statement)
    if (cost > left) break
    left = left - cost
    kept = kept + 1
  }
  return kept
}

/**
 * Assembles what a frame printed, bounded by {@link printFrameBytes}.
 *
 * `unread` is the count of statements the host stopped copying out of the realm
 * because the frame had already handed over more than it holds. It is stated
 * rather than dropped, because a buffer that simply stopped reads as a cell that
 * simply stopped printing.
 *
 * The bound holds by construction rather than by a second pass over the result,
 * because a second pass would cut a notice in half and that is the one thing a
 * bound may not do. {@link capacity} charges every kept statement the floor it is
 * promised, the notice it would print and its newline; what survives that walk is
 * therefore affordable, and the apportionment below spends only what the walk
 * left. A statement at or under the floor is shown whole and reserves no notice
 * at all — reserving one apiece is what left a frame of short lines nothing to
 * spend on the lines themselves.
 *
 * @since 0.1.0
 * @private
 * @slop
 */
export const buffer = (statements: ReadonlyArray<Statement>, unread: number): string => {
  if (statements.length === 0 && unread === 0) return ""
  // The count-lines come out of the budget before the statements are counted,
  // and the drop line only where there is a drop — so it is priced by asking
  // twice, rather than by charging every frame for a line most never print.
  const overhead = unread === 0 ? 0 : bytes.size(unreadNotice(unread)) + 1
  const roomy = capacity(statements, printFrameBytes - overhead)
  const affordable = roomy === statements.length
    ? roomy
    : capacity(statements, printFrameBytes - overhead - bytes.size(droppedNotice(statements.length)) - 1)
  // More statements than the budget can floor: whole statements go from the
  // middle, counted, rather than every one of them being cut to a notice.
  const head = Math.ceil(affordable / 2)
  const kept = statements.length === affordable
    ? statements
    : [...statements.slice(0, head), ...statements.slice(statements.length - Math.floor(affordable / 2))]
  const dropped = statements.length - kept.length
  const notices = [
    ...(dropped === 0 ? [] : [droppedNotice(dropped)]),
    ...(unread === 0 ? [] : [unreadNotice(unread)])
  ]
  // What the budget cannot spend on values: the count-lines, the newline between
  // every pair, and one elision notice for each statement the floor does not
  // cover whole.
  const sizes = kept.map((statement) => statement.bytes)
  const reserve = kept.reduce(
    (sum, statement) => sum + (statement.bytes > printStatementFloor ? elide.noticeCost(statement.bytes, recall) : 0),
    0
  ) +
    notices.reduce((sum, line) => sum + bytes.size(line), 0) +
    Math.max(0, kept.length + notices.length - 1)
  const allotted = shares(sizes, Math.max(0, printFrameBytes - reserve))
  const lines = kept.map((statement, index) =>
    elide.middleFrom(statement.text, statement.bytes, allotted[index]!, recall)
  )
  return [
    ...lines.slice(0, dropped === 0 ? lines.length : head),
    ...(dropped === 0 ? [] : [notices[0]!, ...lines.slice(head)]),
    ...(unread === 0 ? [] : [notices[notices.length - 1]!])
  ].join("\n")
}
