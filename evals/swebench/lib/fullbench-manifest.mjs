/**
 * Reads the full-benchmark manifest into the state it describes.
 *
 * `fullbench/manifest.jsonl` is append-only: every state an instance reaches is
 * a new row rather than an edit, because an edit is not crash-safe and this
 * ledger exists to survive a crash. **The last row for an instance is that
 * instance's state**, and this module is the one place that rule is written.
 *
 * Row kinds:
 *
 * | kind       | what it records                                                     |
 * | ---------- | ------------------------------------------------------------------- |
 * | `header`   | one driver session: the pinned subject, the dataset, the settings    |
 * | `instance` | one instance reaching one state                                      |
 * | `note`     | something the driver wants a reader to see (HEAD drift, a pause)     |
 *
 * The states an instance passes through, in order:
 *
 * | state     | reached when                                                        |
 * | --------- | ------------------------------------------------------------------- |
 * | `pulled`  | the official image is local (pulled, or already cached)              |
 * | `ran`     | the harness finished and the patch is captured                       |
 * | `graded`  | the official evaluator returned a verdict for this instance          |
 * | `cleaned` | the testbed is gone and the image is deleted (or deliberately kept)  |
 * | `failed`  | the pipeline could not reach a verdict; the instance re-runs clean   |
 *
 * `graded` is the resume boundary: a resumed driver skips every instance whose
 * last row is `graded` or `cleaned`, and re-runs everything else from the top.
 *
 * @since 0.1.0
 */
import { readFileSync } from "node:fs"

/** The states that mean an instance is finished and must not be re-run. */
export const DONE_STATES = new Set(["graded", "cleaned"])

/**
 * Parses a JSONL ledger, tolerating the torn last line a hard kill can leave.
 *
 * A row half-written when the process died is not a row, and refusing to read
 * the whole file because of it would turn a recoverable crash into a lost run.
 * Every other malformed line is a defect and is reported.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readRows = (path) => {
  let text
  try {
    text = readFileSync(path, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return { rows: [], torn: 0, malformed: [] }
    throw error
  }
  const lines = text.split("\n")
  // A complete file ends in a newline, so the last element is always "".
  const tail = lines.pop()
  const rows = []
  const malformed = []
  let torn = 0
  for (const [index, line] of lines.entries()) {
    if (line === "") continue
    try {
      rows.push(JSON.parse(line))
    } catch {
      malformed.push({ line: index + 1, text: line })
    }
  }
  if (tail !== "") {
    // The process died mid-write. Readable rows keep their meaning.
    try {
      rows.push(JSON.parse(tail))
    } catch {
      torn = 1
    }
  }
  return { rows, torn, malformed }
}

/**
 * Folds the ledger into one state per instance, plus the session headers.
 *
 * @category conversions
 * @since 0.1.0
 */
export const read = (path) => {
  const { malformed, rows, torn } = readRows(path)
  const headers = []
  const notes = []
  const states = new Map()
  for (const row of rows) {
    if (row.kind === "header") {
      headers.push(row)
      continue
    }
    if (row.kind === "note") {
      notes.push(row)
      continue
    }
    if (row.kind === "instance" && typeof row.id === "string") {
      // Later rows add columns to earlier ones — the patch size is known at
      // `ran` and the verdict at `graded`, and one row per instance has to
      // carry both. `pulled` opens a fresh attempt and therefore *replaces*
      // rather than merges: after a crash the same instance runs again, and a
      // patch size or verdict from the attempt that died must not survive into
      // the attempt that replaced it.
      const previous = row.state === "pulled" ? undefined : states.get(row.id)
      states.set(row.id, previous === undefined ? row : { ...previous, ...row })
    }
  }
  return {
    /**
     * Every parsed row, in the order they were appended.
     *
     * The fold answers "where is this instance now"; money answers "what has
     * been spent", and those are not the same question. An attempt that died
     * after its model calls is replaced in the fold by the attempt that
     * followed it, and the tokens it burned are still on the invoice.
     */
    rows,
    /** The first session's header: the subject of record for the whole run. */
    header: headers[0],
    /** Every session's header, oldest first. One per driver start. */
    headers,
    notes,
    /** Instance id to its merged latest row. */
    states,
    torn,
    malformed,
    rowCount: rows.length
  }
}

/**
 * True when this instance is finished and a resumed driver must skip it.
 *
 * @category predicates
 * @since 0.1.0
 */
export const isDone = (state) => state !== undefined && DONE_STATES.has(state.state)

/**
 * Every billed attempt, in ledger order: the one attempt projection the budget
 * gate, the report and the comparisons all read.
 *
 * A `ran` row opens an attempt, as does a `graded` row with no open attempt (an
 * older grade-only ledger). A `graded` row after `ran` describes the same
 * attempt and can supply its cost; it is never a second bill. `pulled` closes
 * the open attempt, so a crashed attempt a retry replaced stays billed.
 *
 * @category conversions
 * @since 1.0.0
 */
export const costAttempts = (rows) => {
  const attempts = []
  const current = new Map()
  for (const row of rows) {
    if (row.kind !== "instance") continue
    if (row.state === "pulled") current.delete(row.id)
    if (row.state !== "ran" && row.state !== "graded") continue
    if (row.state === "ran" || !current.has(row.id)) {
      const attempt = { ...row }
      attempts.push(attempt)
      current.set(row.id, attempt)
    } else if (row.cost !== undefined) {
      current.get(row.id).cost = row.cost
    }
  }
  return attempts
}

/**
 * True when an attempt's cost is not a known dollar figure. Unknown is never
 * zero: missing, null, invalid or explicitly unknown accounting all count here.
 *
 * @category predicates
 * @since 1.0.0
 */
export const isUnknownCost = (cost) => cost?.unknown === true || !Number.isFinite(cost?.usd) || cost.usd < 0

/**
 * Per instance, the dollars its priced attempts cost and how many of its
 * attempts have unknown cost.
 *
 * @category conversions
 * @since 1.0.0
 */
export const attemptSpend = (ledger) => {
  const spend = new Map()
  for (const { id, cost } of costAttempts(ledger.rows)) {
    const entry = spend.get(id) ?? { usd: 0, unknownAttempts: 0 }
    if (isUnknownCost(cost)) entry.unknownAttempts += 1
    else entry.usd += cost.usd
    spend.set(id, entry)
  }
  return spend
}
