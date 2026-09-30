/**
 * The assertions `codex-backfill-dryrun.sh` ends with.
 *
 *   node fixtures/check-codex-backfill.mjs <dry-run temp dir>
 *
 * The dry run is a shell script because killing a process tree, pulling an image
 * and holding a semaphore slot are shell; what those seven phases proved is a
 * question about ledgers, and that is this. Everything here reads files the
 * script and the stubs wrote — nothing re-runs, and nothing is inferred from an
 * exit status alone.
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { readRows } from "../lib/fullbench-manifest.mjs"

const [, , temporary] = process.argv
if (temporary === undefined) {
  console.error("usage: node fixtures/check-codex-backfill.mjs <dry-run temp dir>")
  process.exit(2)
}

const fb = join(temporary, "fullbench")
const fbc = join(fb, "codex")
const text = (path) => readFileSync(path, "utf8")
const lines = (path) => text(path).split("\n").filter((line) => line !== "")
const count = (list, line) => list.filter((entry) => entry === line).length

const one = "stubcodex__one"
const two = "stubcodex__two"
const three = "stubcodex__three"
const four = "stubcodex__four"
const five = "stubcodex__five"
const absent = "stubcodex__absent"

const ledger = lines(join(temporary, "ledger.txt"))
const rowsOf = (path) => readRows(path).rows.filter((row) => row.kind === "instance")
const rows = rowsOf(join(fb, "codex-manifest.jsonl"))
// The ledger is append-only, so one instance has several rows and the newest is
// its standing. Reading the first would read a `started` row's empty columns.
const lastIn = (list, id, state) => {
  const matching = list.filter((row) => row.id === id && (state === undefined || row.state === state))
  return matching[matching.length - 1]
}
const last = (id, state) => lastIn(rows, id, state)

// ---------------------------------------------------------------------------
// Phase A: a logged-out rig costs nothing
// ---------------------------------------------------------------------------
assert.equal(text(join(temporary, "phase-a.exit")).trim(), "1", "a logged-out rig fails")
assert.match(
  text(join(temporary, "phase-a.log")),
  /requested Codex auth is unavailable \(api-key, home /u,
  "and says which auth mode and home it checked"
)
assert.equal(
  rowsOf(join(temporary, "manifest-after-auth-failure.jsonl")).length,
  0,
  "nothing was claimed, pulled or written before the auth check"
)

// ---------------------------------------------------------------------------
// Phase B: two slots, never three, and the third really waited
// ---------------------------------------------------------------------------
assert.ok(
  !ledger.some((line) => line.startsWith("T ")),
  "the first two instances met at the rendezvous, so two really ran at once"
)
// Live instances are tracked as a set of ids rather than a counter: an instance
// killed mid-run never writes its `E`, and a counter would carry that missing
// close forward and read every later instance as one more than it was. A retry
// re-adds an id already in the set, which is exactly the truth — the attempt it
// replaced is gone.
const liveIds = new Set()
let peak = 0
for (const line of ledger) {
  const [mark, id] = line.split(" ")
  if (mark === "S") {
    liveIds.add(id)
    peak = Math.max(peak, liveIds.size)
  }
  if (mark === "E") liveIds.delete(id)
}
assert.equal(peak, 2, `the semaphore held two instances in flight at the peak, saw ${peak}`)
assert.ok(
  ledger.indexOf(`S ${three}`) > ledger.indexOf(`E ${one}`),
  "the third instance started only after a slot came free"
)
assert.match(
  text(join(temporary, "phase-b-three.log")),
  /waiting for one of 2 docker slots/u,
  "and it said so rather than sitting silent"
)

// ---------------------------------------------------------------------------
// Phase C: what the ledger said the moment the third was killed
// ---------------------------------------------------------------------------
const atKill = rowsOf(join(temporary, "manifest-after-kill.jsonl"))
const killedRows = atKill.filter((row) => row.id === three)
assert.equal(killedRows.length, 1, "the interrupted instance left exactly one row")
assert.equal(killedRows[0].state, "started")
assert.equal(killedRows[0].verdict, undefined, "an interrupted instance has no verdict")
assert.equal(lastIn(atKill, one)?.verdict, "resolved")
assert.deepEqual(
  lines(join(temporary, "remaining-after-kill.txt")),
  [two, three, four, five],
  "the queue owes the instance still in flight, the interrupted one, and the two never started"
)
// The one still in flight is owed, and it is also claimed: a second invocation
// naming it refuses instead of paying a second agent to write the same patch.
assert.equal(text(join(temporary, "phase-c-double.exit")).trim(), "3")
assert.match(text(join(temporary, "phase-c-double.log")), /already claimed by live pid \d+/u)
assert.equal(count(ledger, `S ${two}`), 1, "and the refused invocation started no agent")

// ---------------------------------------------------------------------------
// Phase D: the retry runs from the top; a paid instance is a no-op
// ---------------------------------------------------------------------------
assert.equal(count(ledger, `S ${three}`), 2, "the interrupted instance ran again, from the top")
assert.equal(count(ledger, `E ${three}`), 1, "and only the second attempt finished")
assert.equal(count(ledger, `S ${one}`), 1, "an instance with a verdict is never run twice")
assert.equal(text(join(temporary, "phase-d-one.exit")).trim(), "0", "and the no-op exits 0")
assert.match(text(join(temporary, "phase-d-one.log")), /already has a codex verdict \(resolved\)/u)

// ---------------------------------------------------------------------------
// The verdicts, and the columns each row carries
// ---------------------------------------------------------------------------
assert.equal(last(one, "graded").verdict, "resolved")
assert.equal(last(two, "graded").verdict, "empty patch")
assert.equal(last(three, "graded").verdict, "resolved")
assert.equal(count(ledger, `G ${two}`), 0, "an empty patch is not sent to the evaluator")
assert.equal(count(ledger, `G ${one}`), 1)

for (const id of [one, three]) {
  const row = last(id, "graded")
  assert.ok(row.patchBytes > 0, `${id} recorded its patch size`)
  assert.equal(row.tokens, 12345, `${id} read the CLI footer's token total`)
  assert.equal(row.agentSeconds, 7, `${id} recorded the agent's own wall clock`)
  assert.ok(typeof row.wallSeconds === "number", `${id} recorded the instance's wall clock`)
  assert.ok(row.runStartedAt > 0 && row.runEndedAt >= row.runStartedAt, `${id} stamped its run`)
  assert.ok(row.startedAt > 0 && row.gradedAt >= row.startedAt, `${id} stamped its verdict`)
  assert.equal(row.index, "r90c")
  assert.equal(row.runId, "fullbench-codex")
}
assert.equal(last(two, "graded").patchBytes, 0)

// Our own verdict travels with every row, and the instance our grading could not
// complete is flagged rather than dropped: the two harnesses have to be measured
// over the same set of instances or neither rate means anything.
assert.equal(last(one, "graded").flowsVerdict, "resolved")
assert.equal(last(one, "graded").flowsEvalError, 0)
assert.equal(last(four, "graded").flowsVerdict, "eval error")
assert.equal(last(four, "graded").flowsEvalError, 1)
assert.match(text(join(temporary, "table.txt")), /stubcodex__four\teval error\t.*flagged/u)
assert.match(text(join(temporary, "status.txt")), /5 of 5 instances back filled, 0 left, 1 flagged/u)

// ---------------------------------------------------------------------------
// Phase E: the disk gate logged its wait, failed the instance, and never pulled
// ---------------------------------------------------------------------------
assert.equal(text(join(temporary, "phase-e.exit")).trim(), "1")
const failed = rows.filter((row) => row.id === four && row.state === "failed")
assert.equal(failed.length, 1)
assert.match(failed[0].reason, /disk gate timed out before the pull/u)
assert.equal(failed[0].verdict, undefined, "a failure carries no verdict, so it is retried")
const waits = lines(join(fbc, "waits.jsonl")).map((line) => JSON.parse(line))
assert.ok(waits.length > 0, "the gate wrote a row for the wait it made")
for (const wait of waits) {
  assert.equal(wait.kind, "wait")
  assert.equal(wait.id, four)
  assert.equal(wait.phase, "pull")
  assert.equal(wait.freeMiB, 1000)
  assert.equal(wait.neededMiB, 8192)
}
assert.match(
  text(join(temporary, "images-after-disk-gate.txt")),
  /busybox absent/u,
  "the gate stopped the instance before it pulled"
)

// ---------------------------------------------------------------------------
// Phase F: a failed instance is retried, and a stale report is not inherited
// ---------------------------------------------------------------------------
assert.equal(count(ledger, `S ${four}`), 1, "the instance the gate stopped ran on the retry")
assert.equal(
  last(four, "graded").verdict,
  "eval error",
  "a retry re-grades from scratch instead of inheriting the dead attempt's `resolved`"
)
assert.ok(
  !existsSync(join(fbc, "reports", `${four}.json`)),
  "and no report is archived for an attempt that was never graded"
)

// ---------------------------------------------------------------------------
// Phase G: what it refuses, and an empty queue
// ---------------------------------------------------------------------------
assert.equal(text(join(temporary, "phase-g-absent.exit")).trim(), "1")
assert.match(text(join(temporary, "phase-g-absent.log")), /never graded it/u)
assert.equal(
  text(join(temporary, "phase-g-pulled.exit")).trim(),
  "1",
  "an instance the benchmark started but never graded is not in the population"
)
assert.equal(rows.filter((row) => row.id === absent).length, 0, "and it wrote no row")

// The bare loop, over the one instance no `--one` ever named. `--one` is how a
// pipeline drives this, but the loop is how an operator does, and an untested
// loop over a list is where a shell script quietly runs its whole queue as one
// argument.
assert.equal(text(join(temporary, "phase-g-loop.exit")).trim(), "0")
assert.match(text(join(temporary, "phase-g-loop.log")), /1 instances to back fill/u)
assert.match(text(join(temporary, "phase-g-loop.log")), /done: 0 of 1 instances did not reach a verdict/u)
assert.equal(count(ledger, `S ${five}`), 1, "the loop ran the instance it was owed")
assert.equal(last(five, "graded").verdict, "unresolved")

assert.equal(text(join(temporary, "phase-g-all.exit")).trim(), "0")
assert.match(text(join(temporary, "phase-g-all.log")), /nothing left/u)

// ---------------------------------------------------------------------------
// The archive, and docker at the end
// ---------------------------------------------------------------------------
for (const id of [one, two, three, four, five]) {
  assert.ok(existsSync(join(fbc, "patches", `${id}.patch`)), `${id} archived its patch`)
  assert.ok(existsSync(join(fbc, "timings", `${id}.json`)), `${id} archived its timings`)
  assert.ok(existsSync(join(fbc, "logs", `${id}.run.log`)), `${id} archived its transcript`)
}
assert.ok(existsSync(join(fbc, "reports", `${one}.json`)), "the evaluator's own report is kept")
assert.ok(!existsSync(join(fbc, "reports", `${two}.json`)), "an empty patch has no evaluator report")

const images = text(join(temporary, "images-final.txt"))
assert.match(images, /busybox absent/u, "an unpinned instance's image is deleted")
assert.match(images, /hello-world absent/u, "an unpinned instance's image is deleted")
assert.match(images, /alpine present/u, "a pinned instance's image survives the whole backfill")
assert.equal(last(three, "graded").imageState, "kept")
assert.equal(last(one, "graded").imageState, "deleted")

console.log(
  "check-codex-backfill.mjs: a logged-out rig refused, two slots and never three, a kill"
    + " mid-instance left an unpaid row, the retry ran it from the top, a paid instance was a"
    + " no-op, the disk gate stopped a pull, a stale verdict was refused, and every image but"
    + " the pinned one is gone."
)
