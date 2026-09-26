/**
 * Replays `lib/repl-evidence.mjs` over synthesised journals.
 *
 * The REPL A/B report claims that a persistent realm was actually used as one —
 * that cells reused names their predecessors bound, that printing carried the
 * context, that nothing was filed, and that no run lost track of what it had
 * read. Every one of those claims is a count this module takes off a journal,
 * and a miscount would read as evidence, so each definition is pinned here
 * against events whose every field is known.
 *
 * What is pinned:
 *
 * - **a carry is a name an earlier cell bound and this one did not**. A cell
 *   that redeclares the name is reading its own value, so it counts as a
 *   rebinding and never as a carry, and the depth is measured from the frame
 *   that bound the name rather than from the previous frame.
 * - **identifiers inside strings, template literals, comments and regular
 *   expressions are not identifiers**. A `bash` script that mentions a variable
 *   name is data, and counting it would manufacture carries out of shell
 *   commands.
 * - **a top-level binding starts at column 0**. A `const` inside a callback is
 *   not a name the next cell inherits, and destructuring patterns bind every
 *   name in the pattern.
 * - **filing is read off the durable transition**, so a `continue` carrying
 *   state or context is counted whatever the cell's source looked like.
 * - **a repeat is one call signature settled in two different frames**, never
 *   twice inside one, and two spellings of one input are one signature. It is
 *   split by flow, because re-issuing a check after an edit is rule 7 being
 *   obeyed while re-issuing a read is the note-taking failure, and a count that
 *   added them would report the contract working as a defect.
 * - **a ReferenceError is the realm failing to hold a name**, told apart from
 *   every other throw.
 * - **a guarded completion is structural**. `ctx.done` behind an `if` test, an
 *   `else`, a `&&` or a `?` is guarded; the same text inside a string or a
 *   comment is not, and an `if` block that closed before the completion does not
 *   reach it. The reading can miss a real guard and cannot invent one.
 * - **a call-free final frame is the see-then-attest shape**, and it is defined
 *   the same way on both surfaces, because a filing cell has no `ctx.done` to
 *   read and a last frame that called nothing is the same fact either way.
 * - **a re-print is a line the frame before it already delivered**. Twenty
 *   characters or more, trimmed, and against the immediately preceding frame
 *   only, because that buffer is exactly what this turn was handed.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { completions, declared, masked, readAll, readRun, referenced, strip, totals } from "../lib/repl-evidence.mjs"

const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-repl-"))

/** Writes one journal database out of a list of `[type, payload]` events. */
const journal = (name, events) => {
  const directory = join(temporary, name)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, "engine.db")
  const database = new DatabaseSync(path)
  database.exec(
    "create table flows_journal_events ("
      + " run_id text not null, seq integer not null, event_id text not null unique,"
      + " source_id text not null, source_seq integer not null, emitted_at_ms integer not null,"
      + " event_type text not null, payload_json text not null, meta_json text not null,"
      + " primary key (run_id, seq))"
  )
  const insert = database.prepare(
    "insert into flows_journal_events"
      + " (run_id, seq, event_id, source_id, source_seq, emitted_at_ms, event_type, payload_json, meta_json)"
      + " values (?, ?, ?, ?, ?, ?, ?, ?, ?)"
  )
  events.forEach(([type, payload], index) => {
    insert.run("run-1", index, `e${index}`, "agent", index, 1000 + index, type, JSON.stringify(payload), "{}")
  })
  database.close()
  return path
}

// A journal from the waves that had a surface to choose names the one it ran
// under; one written since names none, and reads as the realm.
const armed = (cellMode) => [
  "control.agent.discipline-armed",
  cellMode === undefined ? {} : { cellMode }
]
const opened = () => ["control.agent.turn-opened", { seat: "openai:gpt-5.6-sol" }]
const produced = (text) => ["control.agent.cell-produced", { language: "javascript", digest: `d${text.length}`, text }]
const printed = (text) => ["control.agent.cell-printed", { cell: "d", text }]
const call = (flowName, input) => [
  ["control.agent.cell-call-started", { flowName, input }],
  ["control.agent.cell-call-settled", { flowName, outcome: "success", value: { exitCode: 0 } }]
]
const continued = (state = null, context = []) => [
  "control.agent.transition-applied",
  { transition: { _tag: "continue", state, context } }
]
const raised = (name, message) => ["control.agent.cell-settled", { outcome: { _tag: "raised", name, message } }]
const completed = (output = "green") => [
  "control.agent.transition-applied",
  { transition: { _tag: "complete", state: null, output } }
]

// ---------------------------------------------------------------------------
// strip: an identifier inside data is not an identifier.
// ---------------------------------------------------------------------------
{
  assert.equal(strip("const a = 1 // hits\n").includes("hits"), false, "a line comment is not code")
  assert.equal(strip("const a = 1 /* hits */\n").includes("hits"), false, "a block comment is not code")
  assert.equal(strip("ctx.call('bash', {command: 'grep hits'})").includes("hits"), false, "a string is not code")
  assert.equal(strip("ctx.call(`run ${x} hits`)").includes("hits"), false, "a template literal is not code")
  assert.equal(strip("const r = /hits/g").includes("hits"), false, "a regular expression is not code")
  assert.equal(strip("const q = total / hits").includes("hits"), true, "division is not a regular expression")
  assert.equal(strip("const s = \"a\\\"hits\"").includes("hits"), false, "an escaped quote does not end a string")
}

// ---------------------------------------------------------------------------
// referenced: a member access and an object key are not names.
// ---------------------------------------------------------------------------
{
  assert.deepEqual([...referenced("hits.matches")], ["hits"], "a property is not a name")
  assert.deepEqual([...referenced("hits?.matches")], ["hits"], "optional chaining is the same shape")
  assert.deepEqual([...referenced("ctx.call(\"read\", { path: hit })")].sort(), ["ctx", "hit"], "a key is not a name")
  assert.deepEqual([...referenced("({ found })")], ["found"], "shorthand really does reference the binding")
  assert.deepEqual([...referenced("a ? b : c")].sort(), ["a", "b", "c"], "a ternary is not an object literal")
}

// ---------------------------------------------------------------------------
// declared: column 0, and every name in a pattern.
// ---------------------------------------------------------------------------
{
  assert.deepEqual([...declared("const hits = 1\n")], ["hits"])
  assert.deepEqual([...declared("  const inner = 1\n")], [], "an indented declaration is not top level")
  assert.deepEqual(
    [...declared("const { matches, files } = found\n")].sort(),
    ["files", "matches"],
    "object destructuring binds every name"
  )
  assert.deepEqual([...declared("const [head, tail] = list\n")].sort(), ["head", "tail"])
  assert.deepEqual([...declared("function widen(value) { return value }\n")], ["widen"])
  assert.deepEqual([...declared("async function probe() {}\n")], ["probe"])
  assert.deepEqual([...declared("class Card {}\n")], ["Card"])
  assert.deepEqual([...declared("const ctx = 1\n")], [], "an ambient name is never a binding")
  assert.deepEqual(
    [...declared("const region = await ctx.call(\"read\", { path: hit.file })\n")],
    ["region"],
    "the initialiser is not part of the pattern"
  )
}

// ---------------------------------------------------------------------------
// A carry is a name an earlier cell bound and this one did not.
// ---------------------------------------------------------------------------
{
  const path = journal("carry", [
    armed("repl"),
    opened(),
    produced("const hits = await ctx.call(\"grep\", {})\nconsole.log(hits)\n"),
    printed("[]"),
    continued(),
    opened(),
    produced("const region = hits.matches[0]\nconsole.log(region)\n"),
    printed("x"),
    continued(),
    opened(),
    produced("console.log(hits, region)\n"),
    printed("y"),
    continued()
  ])
  const run = readRun(path)
  assert.equal(run.mode, "repl")
  assert.equal(run.frames, 3)
  assert.equal(run.cells, 3)
  assert.equal(run.carriedFrames, 2, "frames two and three each reach back")
  assert.equal(run.carriedReferences, 3, "region in three, hits in two and three")
  assert.equal(run.carriedDepth, 2, "the last frame reaches back to the first")
  assert.deepEqual(run.carriedNames, ["hits", "region"])
  assert.equal(run.bindings, 2)
  assert.equal(run.printedFrames, 3)
  assert.equal(run.silentFrames, 0)
}

// ---------------------------------------------------------------------------
// A redeclared name is a rebinding, never a carry.
// ---------------------------------------------------------------------------
{
  const path = journal("rebind", [
    armed("repl"),
    opened(),
    produced("const hits = 1\n"),
    printed(""),
    continued(),
    opened(),
    produced("const hits = 2\nconsole.log(hits)\n"),
    printed("2"),
    continued()
  ])
  const run = readRun(path)
  assert.equal(run.carriedFrames, 0, "the second cell reads its own binding")
  assert.equal(run.carriedReferences, 0)
  assert.equal(run.rebindings, 1)
  assert.equal(run.silentFrames, 1, "a cell that printed nothing is counted")
  assert.equal(run.elidedFrames, 0, "neither buffer was cut")
}

// ---------------------------------------------------------------------------
// A frame whose prints were cut says so in its own buffer, and is counted.
//
// The channel has had two shapes and both are read by the same code: the first
// cut a statement at 4 KiB from the head and the whole buffer at 16 KiB from the
// middle, the second shares the frame budget across statements, cuts each from
// the middle, and drops whole statements when a frame prints more than the
// budget can floor. A reading of an old lane and a reading of a new one have to
// be the same reading, so every sentence either shape writes is fixed here.
// ---------------------------------------------------------------------------
{
  const path = journal("elided", [
    armed("repl"),
    opened(),
    produced("const a = 1\n"),
    printed("head\n… 12 further print statements were not kept: this frame printed more than the harness holds."),
    continued(),
    opened(),
    produced("const b = 2\n"),
    printed("head\n[… cut …] print less next time, or read the value back from the name it is still bound to\ntail"),
    continued(),
    opened(),
    produced("const c = 3\n"),
    printed("head… [+900b, print a narrower slice of this value; it is still bound in the realm]"),
    continued(),
    opened(),
    produced("const d = 4\n"),
    printed(
      "head\n… 900 of 1000 bytes elided from the middle. print a narrower slice of this value; it is still bound in the realm …\ntail"
    ),
    continued(),
    opened(),
    produced("const e = 5\n"),
    printed(
      "head\n… 8 print statements elided from the middle of this frame; the values are still bound in the realm.\ntail"
    ),
    continued(),
    opened(),
    produced("const f = 6\n"),
    printed("all of it"),
    continued()
  ])
  const run = readRun(path)
  assert.equal(run.elidedFrames, 5, "every sentence either shape of the channel writes is read")
  assert.equal(run.printedFrames, 6)
}

// ---------------------------------------------------------------------------
// A name mentioned only inside a shell command is not a carry.
// ---------------------------------------------------------------------------
{
  const path = journal("data", [
    armed("repl"),
    opened(),
    produced("const hits = 1\n"),
    printed(""),
    continued(),
    opened(),
    produced("await ctx.call(\"bash\", { command: \"echo hits\" })\n"),
    printed(""),
    continued()
  ])
  assert.equal(readRun(path).carriedReferences, 0, "a string mentioning the name is data")
}

// ---------------------------------------------------------------------------
// Filing is read off the transition, and a journal from before the deletion
// still reads as one.
// ---------------------------------------------------------------------------
{
  const path = journal("filing", [
    armed("filing"),
    opened(),
    produced("const found = await ctx.call(\"grep\", {})\nreturn { intent: \"continue\", state: { found } }\n"),
    printed(""),
    continued({ found: 1 }, [{ role: "user", text: "keep going" }]),
    opened(),
    produced("return { intent: \"continue\", state: ctx.state }\n"),
    printed(""),
    continued({ found: 1 })
  ])
  const run = readRun(path)
  assert.equal(run.mode, "filing")
  assert.equal(run.filedState, 2, "both transitions carried state")
  assert.equal(run.projectedContext, 1, "one transition projected context")
}
{
  const path = journal("unfiled", [armed("repl"), opened(), produced("const a = 1\n"), printed("1"), continued()])
  const run = readRun(path)
  assert.equal(run.filedState, 0, "a realm transition files nothing")
  assert.equal(run.projectedContext, 0)
}
{
  // An arming with no surface on it is a journal written since there stopped
  // being two, so it reads as the realm rather than as unknown.
  const path = journal("unarmed", [armed(undefined), opened(), produced("const a = 1\n"), printed("1"), continued()])
  const run = readRun(path)
  assert.equal(run.mode, "repl")
  assert.equal(run.filedState, 0)
}

// ---------------------------------------------------------------------------
// A repeat is one signature settled in two different frames, split by flow.
// ---------------------------------------------------------------------------
{
  const path = journal("repeats", [
    armed("repl"),
    opened(),
    ...call("bash", { command: "pytest -k one", cwd: "/testbed" }),
    ...call("bash", { cwd: "/testbed", command: "pytest -k one" }),
    ...call("read", { path: "a.py" }),
    ...call("edit", { path: "a.py", oldString: "x", newString: "y" }),
    produced("const a = 1\n"),
    printed(""),
    continued(),
    opened(),
    ...call("bash", { command: "pytest -k one", cwd: "/testbed" }),
    ...call("read", { path: "a.py" }),
    ...call("edit", { path: "a.py", oldString: "x", newString: "y" }),
    ...call("grep", { pattern: "z" }),
    produced("const b = 2\n"),
    printed(""),
    continued()
  ])
  const run = readRun(path)
  assert.equal(run.calls, 8)
  assert.equal(
    run.repeats.check,
    1,
    "twice inside one frame is not a repeat; the same check in a later frame is rule 7"
  )
  assert.equal(run.repeats.information, 1, "the re-read is the note-taking failure")
  assert.equal(run.repeats.edit, 1, "the re-applied hunk is its own class")
  assert.equal(run.repeats.other, 0)
  assert.deepEqual(run.repeatCalls, { information: 1, check: 1, edit: 1, other: 0 })
  assert.deepEqual(
    run.repeated.filter((entry) => entry.kind === "information").map((entry) => entry.frames),
    [[0, 1]],
    "a repeat names the frames it spanned"
  )
}
{
  // A flow outside every list lands in `other` rather than in the number the
  // A/B turns on.
  const path = journal("unclassified", [
    armed("repl"),
    opened(),
    ...call("remember", { key: "a" }),
    produced("const a = 1\n"),
    printed(""),
    continued(),
    opened(),
    ...call("remember", { key: "a" }),
    produced("const b = 1\n"),
    printed(""),
    continued()
  ])
  const run = readRun(path)
  assert.equal(run.repeats.other, 1)
  assert.equal(run.repeats.information, 0)
}

// ---------------------------------------------------------------------------
// A ReferenceError is the realm failing to hold a name.
// ---------------------------------------------------------------------------
{
  const path = journal("lost", [
    armed("repl"),
    opened(),
    produced("console.log(region)\n"),
    raised("ReferenceError", "region is not defined"),
    printed(""),
    continued(),
    opened(),
    produced("throw new Error(\"nope\")\n"),
    raised("Error", "nope"),
    printed(""),
    continued()
  ])
  const run = readRun(path)
  assert.equal(run.referenceErrors.length, 1, "only the reference failure counts")
  assert.equal(run.referenceErrors[0].frame, 0)
}

// ---------------------------------------------------------------------------
// masked: the same scan as strip, blanked in place.
// ---------------------------------------------------------------------------
{
  const source = "const s = \"a {\"\nif (ok) { ctx.done({}) }\n"
  assert.equal(masked(source).length, source.length, "every index survives")
  assert.equal(masked(source).includes("{ ctx.done"), true, "code is untouched")
  assert.equal(masked("const s = \"a {\"").includes("{"), false, "a brace inside a string is not structure")
  assert.equal(masked("const s = `a\nb`\nconst t = 1").split("\n").length, 3, "a newline inside a literal survives")
  assert.equal(masked("// if (ok) ctx.done()\nctx.park()").includes("if"), false, "a comment is not structure")
}

// ---------------------------------------------------------------------------
// completions: guarded is structural, and it cannot be invented.
// ---------------------------------------------------------------------------
{
  const one = (text) => {
    const found = completions(text)
    assert.equal(found.length, 1, `one completion in ${JSON.stringify(text)}`)
    return found[0]
  }
  assert.equal(one("if (after.exitCode === 0) ctx.done({ summary: \"x\" })\n").guarded, true, "a brace-less if guards")
  assert.equal(one("if (ok) {\n  ctx.done({})\n}\n").guarded, true, "an if block guards")
  assert.equal(one("if (a) {\n  log()\n} else {\n  ctx.park({})\n}\n").guarded, true, "an else branch guards")
  assert.equal(one("if (a) {\n  x()\n} else if (b) {\n  ctx.done({})\n}\n").guarded, true, "an else-if guards")
  assert.equal(one("ok && ctx.done({})\n").guarded, true, "a short circuit guards")
  assert.equal(one("ok ? ctx.done({}) : log()\n").guarded, true, "a ternary guards")
  assert.equal(one("ctx.done({ summary: \"all green\" })\n").guarded, false, "a bare completion is nobody's claim")
  assert.equal(
    one("if (a) {\n  log()\n}\nctx.done({})\n").guarded,
    false,
    "an if that closed before the completion does not reach it"
  )
  assert.equal(
    one("// if (ok) ctx.done()\nctx.done({})\n").guarded,
    false,
    "a guard inside a comment is not a guard"
  )
  assert.equal(
    one("const note = \"if (ok) \"\nctx.done({})\n").guarded,
    false,
    "a guard inside a string is not a guard"
  )
  assert.equal(completions("verify(ok)\nctx.done({})\n")[0].guarded, false, "a call is not a test")
  assert.deepEqual(completions("ctx.done({})\nctx.park({})\n").map((one) => one.kind), ["done", "park"])
  assert.deepEqual(completions("ctx.call(\"bash\", {})\n"), [], "an ordinary call is not a completion")
}

// ---------------------------------------------------------------------------
// A completion behind a check in the frame that ran it, against the
// see-then-attest shape: a last frame that called nothing.
// ---------------------------------------------------------------------------
{
  const path = journal("guarded-done", [
    armed("repl"),
    opened(),
    ...call("edit", { path: "a.py" }),
    ...call("bash", { command: "pytest" }),
    produced(
      "const after = await ctx.call(\"bash\", {})\nif (after.exitCode === 0) ctx.done({ summary: \"green\" })\n"
    ),
    printed("green"),
    completed()
  ])
  const run = readRun(path)
  assert.equal(run.guardedCompletions, 1)
  assert.equal(run.unguardedCompletions, 0)
  assert.equal(run.inCellCompletions, 1, "the completing frame watched something")
  assert.equal(run.callFreeFinalFrame, false, "nothing was attested in a frame of its own")
  assert.equal(run.finished.tag, "complete", "and that is the transition the run ended on")
  assert.equal(run.finishedGuarded, true)
  assert.equal(run.finishedWithCalls, true)
}
{
  const path = journal("attested-done", [
    armed("repl"),
    opened(),
    ...call("bash", { command: "pytest" }),
    produced("const after = await ctx.call(\"bash\", {})\nconsole.log(after.exitCode)\n"),
    printed("0"),
    continued(),
    opened(),
    produced("ctx.done({ summary: \"the suite exited 0\" })\n"),
    printed(""),
    completed("the suite exited 0")
  ])
  const run = readRun(path)
  assert.equal(run.guardedCompletions, 0)
  assert.equal(run.unguardedCompletions, 1, "the claim is behind no check")
  assert.equal(run.inCellCompletions, 0, "the completing frame called nothing")
  assert.equal(run.callFreeFinalFrame, true, "which is the shape the count is for")
  assert.equal(run.finishedGuarded, false, "and the completion that took was behind no check")
  assert.equal(run.finishedWithCalls, false)
}
{
  // Defined identically for the filing arm, which has no `ctx.done` at all: a
  // last frame that called nothing is the same shape whatever surface wrote it.
  const path = journal("filing-attest", [
    armed("filing"),
    opened(),
    ...call("bash", { command: "pytest" }),
    produced("return { _tag: \"continue\", state: { checked: true } }\n"),
    continued({ checked: true }),
    opened(),
    produced("return { _tag: \"done\", summary: \"the suite exited 0\" }\n"),
    completed("the suite exited 0")
  ])
  const run = readRun(path)
  assert.equal(run.guardedCompletions, 0, "a filing cell has no ctx.done to guard")
  assert.equal(run.unguardedCompletions, 0)
  assert.equal(run.callFreeFinalFrame, true)
}

// ---------------------------------------------------------------------------
// A re-print is a line the frame before it already delivered.
// ---------------------------------------------------------------------------
{
  const long = "def parse(self, table_id=None, names=None, **kwargs):"
  assert.ok(long.length >= 20)
  const path = journal("reprint", [
    armed("repl"),
    opened(),
    produced("console.log(a)\n"),
    printed(`${long}\nok\n`),
    continued(),
    opened(),
    produced("console.log(b)\n"),
    printed(`  ${long}  \nfresh\n`),
    continued(),
    opened(),
    produced("console.log(c)\n"),
    printed("ok\nfresh\n"),
    continued(),
    opened(),
    produced("console.log(d)\n"),
    printed(`${long}\n`),
    continued()
  ])
  const run = readRun(path)
  assert.equal(
    run.rePrintFrames,
    1,
    "only frame two repeats its predecessor: short lines never count, and frame four's"
      + " match is two frames back"
  )
}

// ---------------------------------------------------------------------------
// readAll and totals fold a directory of runs.
// ---------------------------------------------------------------------------
{
  const all = readAll(temporary)
  assert.ok(Object.keys(all).length >= 7, "every synthesised journal is read")
  const sum = totals(all)
  assert.equal(sum.runs, Object.keys(all).length)
  assert.equal(sum.modes.filing, 2)
  assert.ok(sum.modes.repl >= 6)
  assert.equal(sum.guardedCompletions, 1, "one journal completed behind a check")
  assert.equal(sum.unguardedCompletions, 1, "one attested in a frame of its own")
  assert.equal(
    sum.callFreeFinalFrames,
    Object.values(all).filter((run) => run.callFreeFinalFrame).length,
    "the fold counts runs whose last frame called nothing, not frames"
  )
  assert.equal(all["guarded-done"].callFreeFinalFrame, false)
  assert.equal(all["attested-done"].callFreeFinalFrame, true)
  assert.equal(all["filing-attest"].callFreeFinalFrame, true, "the shape is read on either surface")
  assert.equal(sum.rePrintFrames, 1)
  assert.equal(sum.runsWithCarry, 1, "only the carry journal carries")
  assert.equal(sum.runsRereading, 1, "only the repeats journal re-read")
  assert.equal(sum.repeats.information, 1)
  assert.equal(sum.repeats.check, 1)
  assert.equal(sum.repeats.other, 1)
  assert.equal(sum.filedState, 3, "filing is summed across the arm: two filing journals, three filings")
}

// Fullbench publishes a complete archive once, then exposes its journal by
// symlink. The aggregate reader must include it and skip unpublished links.
{
  const linked = join(temporary, "linked")
  mkdirSync(linked)
  const database = journal("archive-source", [])
  symlinkSync(join(database, ".."), join(linked, "archive__1"))
  symlinkSync(join(temporary, "not-published"), join(linked, "pending__1"))
  assert.deepEqual(Object.keys(readAll(linked)), ["archive__1"])
}

rmSync(temporary, { recursive: true, force: true })
console.log(
  "check-repl-evidence: a carried name is told from a redeclared one and from a name inside data,"
    + " a re-read is told from a rule-7 re-check, filing is read off the transition, a guarded"
    + " completion is told from a claim nobody checked, and a re-print is told from a short line."
)
