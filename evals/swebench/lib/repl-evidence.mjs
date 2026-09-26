/**
 * Reads an arm's journals for what a persistent realm actually did.
 *
 *   node lib/repl-evidence.mjs <journals-dir> [--json] [--instance <id>]
 *
 * Every run holds one QuickJS realm for its whole life. The surface that
 * preceded it — one async function per frame, filing JSON into `state` and
 * projecting a `context` by hand — was deleted on 2026-08-24, and the waves
 * that ran under it are still on disk. This reads both, off the runs' own
 * journals, because the comparison between them is the record of why the
 * deletion happened:
 *
 * | metric | the question it settles |
 * | --- | --- |
 * | `carriedFrames` / `carriedReferences` | did cells actually reuse bindings from earlier cells, or was every cell self-contained? |
 * | `prints` | how much a frame said to its successor, in bytes and lines |
 * | `filing` | did the realm arm ever file state or project context — the surface it is supposed to have removed |
 * | `repeats` | the note-taking failure: did a run re-issue a call it had already settled, which is a run that lost track of what it had read |
 * | `referenceErrors` | the other note-taking failure: did a cell name something the realm was not holding |
 * | `guardedCompletions` / `callFreeFinalFrame` | did a run finish behind a check in the frame that ran it, or in a later frame that watched nothing |
 * | `rePrintFrames` | the print channel's own note-taking failure: did a frame print a line the frame before it had already printed |
 *
 * Both surfaces are read by the same code, and the two that are defined for
 * both are the ones the comparison rested on: `carried*` and `repeats`. The
 * other two are one-sided by construction and say so rather than pretending
 * otherwise.
 *
 * **`prints` is the realm's.** `CellTurn` emits `control.agent.cell-printed`
 * only where a realm ran, because the filing surface had no print channel to
 * journal — its cells had no `console`, and what one said to its successor was
 * the `context` it returned. A filing wave's zero here is structural, and the
 * quantity to read against it is `projectedContext`.
 *
 * **`filedState` and `projectedContext` are the filing surface's own.** Nothing
 * writes them now — the fields survive on the transition schema for decoding
 * alone — so a non-zero count in a journal is a journal from before the
 * deletion.
 *
 * `carried*` is defined identically for both and is the honest control: a
 * filing cell's names vanish at its return, so a filing run that scores a carry
 * has a model *writing* as though the name survived, which is a different fact
 * from a realm that made it survive. Reading both is how the realm's effect is
 * told from the model's habit.
 *
 * Four definitions carry the weight, and each is deliberately conservative —
 * every one of them can undercount the realm's benefit and none can invent it.
 *
 * **A top-level binding** is a `const`/`let`/`var`/`function`/`class`
 * declaration whose keyword starts at column 0 of a cell's source. Column 0 is
 * the whole rule: it is the top level of a script, and a declaration indented
 * inside a block or a callback is not a name the next cell inherits. Object and
 * array destructuring patterns are read, so `const { matches } = found` binds
 * `matches`. A name declared at column 0 inside a template literal or a comment
 * would be counted, and that is the known bound; it can only add names that a
 * later cell then has to mention by hand to be counted as carried.
 *
 * **A carried reference** is an identifier token in cell N that a *strictly
 * earlier* cell of the same run bound at its top level, and that cell N does not
 * itself declare. That last clause is what makes the metric about the realm and
 * not about a habit of reusing names: a cell that writes `const hits = ...`
 * again has rebound the name and reads its own value, so it is counted as a
 * rebinding rather than as a carry. Identifiers inside string literals,
 * template literals, regular expressions and comments are stripped before the
 * scan — a `bash` script mentioning `hits` is data — and every JavaScript
 * keyword, global and contract binding (`ctx`, `console`) is excluded.
 *
 * `carriedFrames` counts the frames that carried at least one such name and
 * `carriedDepth` is how many frames back the furthest carry reached, which is
 * the difference between a realm used as one-frame scratch and a realm used as
 * a run's memory.
 *
 * **Filing** is read off the durable transition, not off the source: a
 * `control.agent.transition-applied` whose `continue` carries a non-null
 * `state` or a non-empty `context`. Nothing writes either now, so a non-zero
 * count here says the journal is from before the deletion, and a zero says the
 * surface really is gone rather than merely undocumented.
 *
 * **A repeat** is one (flow, input) signature settled in two or more *different*
 * frames of one run. The signature is the canonical rendering of the pair, the
 * same one `lib/journal-facts.mjs` uses, so two spellings of one input collapse
 * to one signature. Re-issuing inside a single frame is never a repeat: a cell
 * that runs the same check before and after its edit is the contract working.
 *
 * Across frames, a repeat is three different things depending on the flow, and
 * conflating them would report the contract being obeyed as a defect. The split
 * is by flow, and the flow lists are the only benchmark-agnostic fact involved —
 * what a flow does to the tree:
 *
 * - `repeats.information` — `read`, `grep`, `glob`, `ls`. These return bytes of
 *   a tree they do not change, so a second issue in a later frame returns what
 *   the first one did. **This is the note-taking failure**, and it is the only
 *   class that is one: a run re-reading what it was already handed has lost
 *   track of what it had read. Both surfaces are supposed to prevent it — filing
 *   through `state` and `recall`, REPL through the variable — so it is defined
 *   identically for both and is the arm-versus-arm number.
 * - `repeats.check` — `bash`, `test`. Rule 7 *requires* re-issuing the exact
 *   verification pair after an edit, so a repeat here is the contract being
 *   followed. Counted, never charged.
 * - `repeats.edit` — `edit`, `write`, `apply_patch`. Re-applying an identical
 *   hunk in a later frame is a run that either lost its own edit or forgot
 *   making it. Rarer than the other two and worth its own row.
 *
 * A flow outside all three lists is counted under `other`, so a catalog change
 * shows up as an unclassified row rather than silently landing in the number the
 * A/B turns on.
 *
 * @since 0.1.0
 */
import { existsSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"

/**
 * Names a cell may use that no earlier cell bound.
 *
 * The contract's own bindings plus every JavaScript keyword, literal and
 * standard global a cell can legally mention. A name in here is never counted
 * as carried, whatever an earlier cell declared: shadowing a global is a
 * mistake the metric should not reward.
 */
const ambient = new Set([
  "ctx",
  "console",
  "await",
  "async",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "export",
  "extends",
  "finally",
  "for",
  "function",
  "if",
  "import",
  "in",
  "instanceof",
  "let",
  "new",
  "of",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
  "true",
  "false",
  "null",
  "undefined",
  "NaN",
  "Infinity",
  "Array",
  "BigInt",
  "Boolean",
  "Date",
  "Error",
  "JSON",
  "Map",
  "Math",
  "Number",
  "Object",
  "Promise",
  "RegExp",
  "Set",
  "String",
  "Symbol",
  "TypeError",
  "WeakMap",
  "WeakSet",
  "globalThis",
  "isNaN",
  "parseFloat",
  "parseInt",
  "structuredClone"
])

/**
 * The half-open spans of cell source that are not code: comments, strings,
 * template literals and regular expression literals.
 *
 * A single left-to-right scan rather than a parse, because the input is one
 * model-authored script and the failure mode of a parse — a syntax error the
 * realm accepted — would drop a whole cell from the count.
 *
 * Two readers want this scan and want different things back from it. `strip`
 * wants the code with each span collapsed, because it counts identifiers and
 * only needs the tokens on either side of a literal to stay apart. `masked`
 * wants the code with each span blanked in place, because it walks brace and
 * paren structure by index and a collapse would move every position after the
 * first string. Sharing the scan is what keeps the two readings the same
 * reading.
 */
const literalSpans = (text) => {
  const spans = []
  let index = 0
  // A `/` opens a regular expression only where a value may begin. Tracking the
  // last significant character is enough to tell that from division, and being
  // wrong costs at most one stripped operand.
  let previous = ""
  while (index < text.length) {
    const char = text[index]
    const next = text[index + 1]
    if (char === "/" && next === "/") {
      const start = index
      while (index < text.length && text[index] !== "\n") index += 1
      spans.push([start, index])
      continue
    }
    if (char === "/" && next === "*") {
      const start = index
      index += 2
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1
      index += 2
      spans.push([start, Math.min(index, text.length)])
      continue
    }
    if (char === "\"" || char === "'" || char === "`") {
      const start = index
      const quote = char
      index += 1
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2
          continue
        }
        if (text[index] === quote) {
          index += 1
          break
        }
        index += 1
      }
      spans.push([start, Math.min(index, text.length)])
      previous = "x"
      continue
    }
    if (char === "/" && (previous === "" || "=(,:[!&|?{};+-*%<>~^".includes(previous))) {
      const start = index
      index += 1
      let inClass = false
      while (index < text.length) {
        if (text[index] === "\\") {
          index += 2
          continue
        }
        if (text[index] === "[") inClass = true
        else if (text[index] === "]") inClass = false
        else if (text[index] === "/" && !inClass) {
          index += 1
          break
        } else if (text[index] === "\n") break
        index += 1
      }
      spans.push([start, Math.min(index, text.length)])
      previous = "x"
      continue
    }
    if (!/\s/.test(char)) previous = char
    index += 1
  }
  return spans
}

/**
 * Strips comments, strings, template literals and regular expressions from cell
 * source, leaving code whose identifiers are identifiers.
 *
 * Each construct is replaced by a space so tokens on either side stay apart.
 */
export const strip = (text) => {
  let out = ""
  let at = 0
  for (const [start, end] of literalSpans(text)) {
    out += text.slice(at, start) + " "
    at = end
  }
  return out + text.slice(at)
}

/**
 * The same scan, blanked in place: every character of every literal, comment and
 * regular expression becomes a space, and the source keeps its length, its line
 * breaks and every other index.
 *
 * This is what a structural reader needs. `completions` decides whether a
 * `ctx.done` sits behind a check by walking back through braces and parentheses
 * from the position it was found at, and a `{` inside a shell script in a
 * template literal would derail that walk. Newlines inside a span survive
 * because a statement's extent is read off them.
 *
 * @category conversions
 * @since 0.1.0
 */
export const masked = (text) => {
  let out = ""
  let at = 0
  for (const [start, end] of literalSpans(text)) {
    out += text.slice(at, start)
    for (let index = start; index < end; index += 1) out += text[index] === "\n" ? "\n" : " "
    at = end
  }
  return out + text.slice(at)
}

const identifierPattern = /[A-Za-z_$][A-Za-z0-9_$]*/g

/**
 * Whether the `{` or the `ctx.done` at `at` is the body of an `if` test.
 *
 * Reads backwards, structurally: skip whitespace, expect a `)`, walk to the `(`
 * it closes counting depth, skip whitespace again, and require the word `if`.
 * Nothing here is a regular expression over the whole prefix, because a greedy
 * `if\s*\([\s\S]*\)` matches any earlier `if` in the cell and would call every
 * completion after the first one guarded.
 */
const behindIfTest = (code, at) => {
  let index = at - 1
  while (index >= 0 && /\s/.test(code[index])) index -= 1
  if (index < 0 || code[index] !== ")") return false
  let depth = 0
  for (; index >= 0; index -= 1) {
    if (code[index] === ")") depth += 1
    else if (code[index] === "(") {
      depth -= 1
      if (depth === 0) break
    }
  }
  if (index < 0) return false
  index -= 1
  while (index >= 0 && /\s/.test(code[index])) index -= 1
  if (index < 1 || code.slice(index - 1, index + 1) !== "if") return false
  return !/[A-Za-z0-9_$.]/.test(code[index - 2] ?? " ")
}

/** Whether the `{` at `at` opens an `else` branch. */
const behindElse = (code, at) => {
  let index = at - 1
  while (index >= 0 && /\s/.test(code[index])) index -= 1
  if (index < 3 || code.slice(index - 3, index + 1) !== "else") return false
  return !/[A-Za-z0-9_$.]/.test(code[index - 4] ?? " ")
}

/**
 * Every `ctx.done` and `ctx.park` a cell contains, and whether each one is
 * behind a check.
 *
 * The contract as of `c23c21e4f` teaches completion as a guard —
 * `if (after.exitCode === 0) ctx.done(...)` — because a completion now takes
 * effect where it is called, so a cell can run its verification and finish on
 * the result in one frame. Before that a cell could only finish by ending, and
 * the shape it produced was see-then-attest: one frame that ran the check, and
 * a second, call-free frame that declared the outcome. This is the reader that
 * tells the two apart.
 *
 * **Guarded** is structural, not textual. A completion counts as guarded when
 * it sits directly behind an `if` test (`if (ok) ctx.done(...)`), inside a block
 * that an `if` test or an `else` opens, or after a `&&` or `?` that short-circuits
 * on a value. Every one of those is read by walking back from the completion
 * through balanced parentheses and braces of `masked` source, so a `{` in a
 * heredoc and an `if` in a comment are not structure.
 *
 * Conservative in the one direction that matters: it can call a real guard
 * unguarded — a completion behind an early `return`, or one whose check is a
 * `throw` above it — and it cannot invent a guard out of a cell that has none,
 * because every path to `true` requires an `if`, an `else`, a `&&` or a `?`
 * lexically dominating the call in code the realm actually ran.
 *
 * **REPL-only by construction.** A filing cell has no `ctx.done`: it finishes by
 * returning `{ _tag: "done" }`, so this reads zero over the filing arm and the
 * quantity to read against it is `callFreeFinalFrame`, which is defined for both.
 *
 * @category conversions
 * @since 0.1.0
 */
export const completions = (text) => {
  const code = masked(text)
  const found = []
  for (const match of code.matchAll(/\bctx\s*\.\s*(done|park)\s*\(/g)) {
    const at = match.index
    let guarded = behindIfTest(code, at)
    if (!guarded) {
      const open = []
      for (let index = 0; index < at; index += 1) {
        if (code[index] === "{") open.push(index)
        else if (code[index] === "}") open.pop()
      }
      guarded = open.some((brace) => behindIfTest(code, brace) || behindElse(code, brace))
    }
    if (!guarded) {
      let index = at - 1
      while (index >= 0 && /\s/.test(code[index])) index -= 1
      guarded = code[index] === "?" || (index >= 1 && code.slice(index - 1, index + 1) === "&&")
    }
    found.push({ kind: match[1], index: at, guarded })
  }
  return found
}

/**
 * The shortest printed line two frames must share for the second to count as a
 * re-print.
 *
 * Twenty characters. Short lines are the channel working: `ok`, a repeated
 * heading, a file name, a `0`. A twenty-character line that a frame prints when
 * the frame before it printed the same line is the model re-deriving what it was
 * already handed, which is the print channel's own version of the note-taking
 * failure `repeats.information` counts for calls. The count is flat across the
 * whole band 16–36 on the r95repl lane (72 down to 66), so nothing turns on the
 * exact number.
 */
const rePrintFloor = 20

/** The lines of one print buffer a re-print may be counted on. */
const printedLines = (text) => text.split("\n").map((line) => line.trim()).filter((line) => line.length >= rePrintFloor)

/**
 * What a repeated call of each flow means, by what the flow does to the tree.
 *
 * @category constants
 * @since 0.1.0
 */
export const flowClass = {
  information: ["read", "grep", "glob", "ls"],
  check: ["bash", "test"],
  edit: ["edit", "write", "apply_patch"]
}

const classOf = (flow) => {
  for (const [name, flows] of Object.entries(flowClass)) if (flows.includes(flow)) return name
  return "other"
}

/**
 * The names a cell declares at the top level of its own script.
 *
 * @category conversions
 * @since 0.1.0
 */
export const declared = (text) => {
  const names = new Set()
  const lines = strip(text).split("\n")
  for (const line of lines) {
    const keyword = /^(?:export\s+)?(?:async\s+)?(const|let|var|function|class)\s+([\s\S]*)$/.exec(line)
    if (keyword === null) continue
    const rest = keyword[2]
    if (keyword[1] === "function" || keyword[1] === "class") {
      const simple = /^\*?\s*([A-Za-z_$][A-Za-z0-9_$]*)/.exec(rest)
      if (simple !== null) names.add(simple[1])
      continue
    }
    // A declaration list is read up to its `=`, which is where the binding
    // pattern ends and the initialiser begins. Multi-line patterns keep only
    // their first line, and losing a name can never manufacture a carry.
    const pattern = rest.split("=")[0]
    for (const match of pattern.matchAll(identifierPattern)) names.add(match[0])
  }
  for (const name of ambient) names.delete(name)
  return names
}

/**
 * Every identifier a cell mentions as a *name*, once each.
 *
 * Two things that look like identifiers are not names, and counting them would
 * manufacture carries out of coincidence:
 *
 * - **a member access.** `hits.matches` mentions `hits`; `matches` is a key of
 *   whatever `hits` is, and an earlier cell that happened to bind a variable
 *   called `matches` has nothing to do with it. Optional chaining is the same
 *   shape and is removed with it.
 * - **an object-literal key.** `{ path: hit.file }` mentions `hit`, not `path`.
 *   Only a key introduced by `{` or `,` is removed, so the shorthand `{ found }`
 *   — which really is a reference to the binding — survives.
 *
 * Both removals can only drop a mention, never add one, so the metric they feed
 * is a floor on how much a run carried.
 *
 * @category conversions
 * @since 0.1.0
 */
export const referenced = (text) => {
  const code = strip(text)
    .replace(/\?\.\s*[A-Za-z_$][A-Za-z0-9_$]*/g, " ")
    .replace(/\.\s*[A-Za-z_$][A-Za-z0-9_$]*/g, " ")
    .replace(/([{,]\s*)[A-Za-z_$][A-Za-z0-9_$]*(\s*:)/g, "$1 $2")
  const names = new Set()
  for (const match of code.matchAll(identifierPattern)) names.add(match[0])
  return names
}

/** A stable, injective rendering of one call's input, as `journal-facts.mjs` spells it. */
const canonical = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
}

/**
 * Reads one run's journal into the realm facts.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readRun = (databasePath) => {
  const database = new DatabaseSync(databasePath, { readOnly: true })
  let rows
  try {
    rows = database.prepare(
      "select seq, event_type, payload_json from flows_journal_events where event_type like 'control.agent.%' order by seq"
    ).all()
  } finally {
    database.close()
  }

  const cells = []
  const prints = []
  const calls = []
  const started = []
  const referenceErrors = []
  let mode
  let filedState = 0
  let projectedContext = 0
  let frame = -1
  let finished

  for (const row of rows) {
    const payload = JSON.parse(row.payload_json)
    switch (row.event_type) {
      case "control.agent.discipline-armed":
        // The arming stopped carrying a surface when there stopped being two
        // of them. A journal that names one is a journal from the waves that
        // had a choice; one that names none ran the realm, which is the only
        // surface there is.
        mode = payload.cellMode ?? "repl"
        break
      case "control.agent.turn-opened":
        frame += 1
        break
      case "control.agent.cell-produced":
        cells.push({ frame, digest: payload.digest, text: payload.text ?? "" })
        break
      case "control.agent.cell-printed":
        prints.push({ frame, cell: payload.cell, text: payload.text ?? "" })
        break
      case "control.agent.cell-call-started":
        started.push(payload.input ?? null)
        break
      case "control.agent.cell-call-settled": {
        // Started and settled are journaled as a pair in order, so the settled
        // event's input is the oldest one still open. This is the same pairing
        // `lib/journal-facts.mjs` makes, and for the same reason: the settled
        // event carries the flow's name and its result but not what it asked.
        const opened = started.length === 0 ? null : started.shift()
        calls.push({
          frame,
          flow: payload.flowName,
          signature: canonical([payload.flowName, opened])
        })
        break
      }
      case "control.agent.cell-settled": {
        const outcome = payload.outcome
        if (outcome?._tag === "raised") {
          const message = `${outcome.name ?? ""} ${outcome.message ?? ""}`
          if (/ReferenceError|is not defined/.test(message)) referenceErrors.push({ frame, message: message.trim() })
        }
        break
      }
      case "control.agent.transition-applied": {
        const transition = payload.transition
        if (transition?._tag === "continue") {
          if (transition.state !== null && transition.state !== undefined) filedState += 1
          if (Array.isArray(transition.context) && transition.context.length > 0) projectedContext += 1
        } else if (transition?._tag !== undefined) finished = { tag: transition._tag, frame }
        break
      }
      default:
        break
    }
  }

  // The carry fold. Bindings accumulate in cell order; a cell is scored against
  // what every cell *before* it left behind, never against its own.
  const bound = new Map()
  let carriedFrames = 0
  let carriedReferences = 0
  let rebindings = 0
  let carriedDepth = 0
  const carriedNames = new Set()
  for (const cell of cells) {
    const own = declared(cell.text)
    const uses = referenced(cell.text)
    let carriedHere = 0
    for (const name of uses) {
      if (own.has(name)) {
        if (bound.has(name)) rebindings += 1
        continue
      }
      const at = bound.get(name)
      if (at === undefined) continue
      carriedHere += 1
      carriedReferences += 1
      carriedNames.add(name)
      carriedDepth = Math.max(carriedDepth, cell.frame - at)
    }
    if (carriedHere > 0) carriedFrames += 1
    for (const name of own) bound.set(name, cell.frame)
  }

  // Repeats: one signature settled in two or more different frames, split by
  // what a second issue of that flow means.
  const frames = new Map()
  for (const call of calls) {
    const seen = frames.get(call.signature) ?? { flow: call.flow, frames: new Set() }
    seen.frames.add(call.frame)
    frames.set(call.signature, seen)
  }
  const repeats = { information: 0, check: 0, edit: 0, other: 0 }
  const repeatCalls = { information: 0, check: 0, edit: 0, other: 0 }
  const repeated = []
  for (const [signature, seen] of frames) {
    if (seen.frames.size < 2) continue
    const kind = classOf(seen.flow)
    repeats[kind] += 1
    repeatCalls[kind] += seen.frames.size - 1
    repeated.push({ kind, flow: seen.flow, frames: [...seen.frames].sort((a, b) => a - b), signature })
  }

  // Completion: how a run finished, and whether the frame that finished it had
  // watched anything. `callFreeFinalFrame` is the one defined for both arms —
  // the last frame of the run issued no call at all, which is the see-then-attest
  // shape whatever surface produced it.
  //
  // Two counts, and they answer different questions. `guardedCompletions` counts
  // the *cells that wrote a completion*, fired or not, because a guard the check
  // declined is the shape being adopted just as much as one that fired: the
  // contract asks for the guard in every cell that could finish. `finished`
  // names the one transition that ended the run, so `finishedGuarded` is about
  // the completion that actually took.
  const callFrames = new Set(calls.map((call) => call.frame))
  const lastFrame = frame
  const callFreeFinalFrame = frame >= 0 && !callFrames.has(lastFrame)
  let guardedCompletions = 0
  let unguardedCompletions = 0
  let inCellCompletions = 0
  const completionFrames = []
  for (const cell of cells) {
    const found = completions(cell.text)
    if (found.length === 0) continue
    const guarded = found.some((one) => one.guarded)
    if (guarded) guardedCompletions += 1
    else unguardedCompletions += 1
    if (callFrames.has(cell.frame)) inCellCompletions += 1
    completionFrames.push({ frame: cell.frame, guarded, withCalls: callFrames.has(cell.frame) })
  }
  const finishing = finished === undefined
    ? undefined
    : completionFrames.find((one) => one.frame === finished.frame)

  // Re-prints: a frame that printed a line the frame before it had already
  // printed, which is the print channel's own note-taking failure. Read against
  // the immediately preceding frame rather than against the whole run, because
  // the preceding frame's buffer is exactly what this turn was handed: repeating
  // it is spending output tokens on bytes already in the context.
  let rePrintFrames = 0
  let previousLines = null
  for (const print of prints) {
    const lines = printedLines(print.text)
    if (previousLines !== null && lines.some((line) => previousLines.has(line))) rePrintFrames += 1
    previousLines = new Set(lines)
  }

  const printed = prints.filter((print) => print.text.length > 0)
  // A frame that printed more than the harness delivers says so in its own
  // buffer, in one of the sentences the sandbox writes. Counting them is how a
  // report can say whether the print channel was ever the binding constraint,
  // rather than assuming a 16 KiB ceiling nobody reached was doing work.
  //
  // Four sentences, because the channel has had two shapes. Under the first, a
  // statement was cut at 4 KiB from the head and the whole buffer at 16 KiB from
  // the middle; under the second the statements share the frame budget, each is
  // cut from the middle, and a frame with more statements than the budget can
  // floor drops whole statements. Every one of them is matched here so a
  // reading of an old lane and a reading of a new one are the same reading.
  const elidedFrames =
    prints.filter((print) =>
      /further print statements were not kept|print less next time|print statements elided from the middle of this frame|bytes elided from the middle|print a narrower slice of this value/
        .test(print.text)
    ).length
  const printBytes = prints.reduce((total, print) => total + print.text.length, 0)
  const printLines = prints.reduce(
    (total, print) => total + (print.text.length === 0 ? 0 : print.text.split("\n").length),
    0
  )

  return {
    mode,
    frames: frame + 1,
    cells: cells.length,
    calls: calls.length,
    bindings: bound.size,
    carriedFrames,
    carriedReferences,
    carriedNames: [...carriedNames].sort(),
    carriedDepth,
    rebindings,
    printedFrames: printed.length,
    silentFrames: prints.length - printed.length,
    elidedFrames,
    rePrintFrames,
    printBytes,
    printLines,
    callFreeFinalFrame,
    guardedCompletions,
    unguardedCompletions,
    inCellCompletions,
    completionFrames,
    finished,
    finishedGuarded: finishing?.guarded ?? false,
    finishedWithCalls: finishing?.withCalls ?? false,
    filedState,
    projectedContext,
    repeats,
    repeatCalls,
    repeated,
    referenceErrors
  }
}

/**
 * Reads every archived journal under one directory.
 *
 * @category conversions
 * @since 0.1.0
 */
export const readAll = (directory) => {
  const runs = {}
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const database = join(directory, entry.name, "engine.db")
    if (!existsSync(database)) continue
    runs[entry.name] = readRun(database)
  }
  return runs
}

/**
 * Sums the per-run readings into the arm's totals.
 *
 * @category conversions
 * @since 0.1.0
 */
export const totals = (runs) => {
  const sum = {
    runs: 0,
    modes: {},
    frames: 0,
    cells: 0,
    calls: 0,
    bindings: 0,
    carriedFrames: 0,
    carriedReferences: 0,
    carriedDepth: 0,
    rebindings: 0,
    printedFrames: 0,
    silentFrames: 0,
    elidedFrames: 0,
    rePrintFrames: 0,
    printBytes: 0,
    printLines: 0,
    callFreeFinalFrames: 0,
    guardedCompletions: 0,
    unguardedCompletions: 0,
    inCellCompletions: 0,
    finishedGuarded: 0,
    finishedWithCalls: 0,
    filedState: 0,
    projectedContext: 0,
    repeats: { information: 0, check: 0, edit: 0, other: 0 },
    repeatCalls: { information: 0, check: 0, edit: 0, other: 0 },
    referenceErrors: 0,
    runsRereading: 0,
    runsWithCarry: 0
  }
  for (const run of Object.values(runs)) {
    sum.runs += 1
    sum.modes[run.mode ?? "unknown"] = (sum.modes[run.mode ?? "unknown"] ?? 0) + 1
    sum.frames += run.frames
    sum.cells += run.cells
    sum.calls += run.calls
    sum.bindings += run.bindings
    sum.carriedFrames += run.carriedFrames
    sum.carriedReferences += run.carriedReferences
    sum.carriedDepth = Math.max(sum.carriedDepth, run.carriedDepth)
    sum.rebindings += run.rebindings
    sum.printedFrames += run.printedFrames
    sum.silentFrames += run.silentFrames
    sum.elidedFrames += run.elidedFrames
    sum.rePrintFrames += run.rePrintFrames
    sum.printBytes += run.printBytes
    sum.printLines += run.printLines
    if (run.callFreeFinalFrame) sum.callFreeFinalFrames += 1
    sum.guardedCompletions += run.guardedCompletions
    sum.unguardedCompletions += run.unguardedCompletions
    sum.inCellCompletions += run.inCellCompletions
    if (run.finishedGuarded) sum.finishedGuarded += 1
    if (run.finishedWithCalls) sum.finishedWithCalls += 1
    sum.filedState += run.filedState
    sum.projectedContext += run.projectedContext
    for (const kind of Object.keys(sum.repeats)) {
      sum.repeats[kind] += run.repeats[kind]
      sum.repeatCalls[kind] += run.repeatCalls[kind]
    }
    sum.referenceErrors += run.referenceErrors.length
    if (run.repeats.information > 0) sum.runsRereading += 1
    if (run.carriedFrames > 0) sum.runsWithCarry += 1
  }
  return sum
}

const main = () => {
  const argv = process.argv.slice(2)
  const directory = argv.find((value) => !value.startsWith("--"))
  if (directory === undefined) {
    console.error("repl-evidence.mjs: usage: node lib/repl-evidence.mjs <journals-dir> [--json] [--instance <id>]")
    process.exit(2)
  }
  const only = argv.includes("--instance") ? argv[argv.indexOf("--instance") + 1] : undefined
  const all = readAll(directory)
  const runs = only === undefined ? all : { [only]: all[only] }
  if (argv.includes("--json")) {
    process.stdout.write(JSON.stringify({ runs, totals: totals(runs) }, undefined, 2) + "\n")
    return
  }
  const sum = totals(runs)
  const rows = Object.entries(runs).map(([id, run]) =>
    [
      id,
      run.mode,
      run.frames,
      run.cells,
      run.bindings,
      run.carriedFrames,
      run.carriedReferences,
      run.carriedDepth,
      run.printBytes,
      run.rePrintFrames,
      run.repeats.information,
      run.repeats.check,
      run.repeats.edit,
      run.guardedCompletions,
      run.unguardedCompletions,
      run.callFreeFinalFrame ? 1 : 0,
      run.filedState
    ].join("\t")
  )
  process.stdout.write(
    "instance\tmode\tframes\tcells\tnames\tcarryFrames\tcarryRefs\tdepth\tprintBytes\treprint"
      + "\treread\trecheck\treedit\tguarded\tunguarded\tattest\tfiled\n"
      + rows.join("\n") + "\n\n" + JSON.stringify(sum, undefined, 2) + "\n"
  )
}

if (import.meta.url === `file://${process.argv[1]}`) main()
