/**
 * The assertions `fullbench-dryrun.sh` ends with.
 *
 *   node fixtures/check-dryrun.mjs <dry-run temp dir>
 *
 * The dry run is a shell script because killing a process tree, pulling an
 * image and holding a lock are shell; what those four phases proved is a
 * question about ledgers, and that is this. Everything here reads files the
 * driver and the stubs wrote — nothing re-runs, and nothing is inferred from a
 * script's own exit status alone.
 */
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { read } from "../lib/fullbench-manifest.mjs"
import { usd } from "../prices.ts"

const [, , temporary] = process.argv
if (temporary === undefined) {
  console.error("usage: node fixtures/check-dryrun.mjs <dry-run temp dir>")
  process.exit(2)
}

const fb = join(temporary, "fullbench")
const text = (path) => readFileSync(path, "utf8")
const lines = (path) => text(path).split("\n").filter((line) => line !== "")

const [first, second, third, fourth] = lines(join(temporary, "roles.txt"))
const ledger = lines(join(temporary, "ledger.txt"))
const ledgerAtKill = lines(join(temporary, "ledger-after-kill.txt"))
const count = (list, prefix) => list.filter((line) => line === prefix).length

// ---------------------------------------------------------------------------
// Phase A: two in flight, never more, and a real extraction
// ---------------------------------------------------------------------------
assert.ok(
  !ledgerAtKill.some((line) => line.startsWith("T ")),
  "the first two instances met at the rendezvous, so the driver really ran two at once"
)
let live = 0
let peak = 0
for (const line of ledgerAtKill) {
  if (line.startsWith("S ")) {
    live += 1
    peak = Math.max(peak, live)
  }
  if (line.startsWith("E ")) live -= 1
}
assert.equal(peak, 2, `exactly two instances in flight at the peak, saw ${peak}`)
assert.ok(
  ledgerAtKill.some((line) => line.startsWith(`X ${first} `)),
  "the first drawn instance really extracted a testbed out of its image"
)
const extracted = Number(ledgerAtKill.find((line) => line.startsWith(`X ${first} `)).split(" ")[2])
assert.ok(extracted > 10, `the extraction copied a tree, not a file (${extracted} entries)`)

// ---------------------------------------------------------------------------
// Phase A's kill: what the ledger said the moment the driver died
// ---------------------------------------------------------------------------
const atKill = read(join(temporary, "manifest-after-kill.jsonl"))
assert.equal(atKill.states.get(first).state, "cleaned")
assert.equal(atKill.states.get(first).verdict, "resolved")
assert.equal(atKill.states.get(second).state, "cleaned")
assert.equal(atKill.states.get(second).verdict, "empty patch")
assert.equal(
  atKill.states.get(third).state,
  "pulled",
  "the instance the kill interrupted never reached a verdict"
)
assert.equal(atKill.states.get(third).verdict, undefined)
assert.equal(atKill.states.get(fourth), undefined, "the session limit held: the fourth never started")

const remainingAtKill = lines(join(temporary, "remaining-after-kill.txt"))
assert.deepEqual(
  remainingAtKill,
  [third, fourth],
  "resume re-runs the interrupted instance and skips the two that were graded"
)

// ---------------------------------------------------------------------------
// Phase B: the resume ran exactly what was left, and nothing else
// ---------------------------------------------------------------------------
assert.equal(count(ledger, `S ${first}`), 1, "a graded instance is never re-run")
assert.equal(count(ledger, `S ${second}`), 1, "a graded instance is never re-run")
assert.equal(count(ledger, `S ${third}`), 2, "the interrupted instance ran again, from the top")
assert.equal(count(ledger, `E ${third}`), 1, "and only the second attempt finished")
assert.equal(count(ledger, `S ${fourth}`), 0, "the disk gate and the budget stopped the fourth")

// The evaluator was invoked for the two non-empty patches and for neither the
// empty one nor the instance that never ran.
assert.equal(count(ledger, `G ${first}`), 1)
assert.equal(count(ledger, `G ${second}`), 0, "an empty patch is not sent to the evaluator")
assert.equal(count(ledger, `G ${third}`), 1)

// ---------------------------------------------------------------------------
// The final ledger
// ---------------------------------------------------------------------------
const manifest = read(join(fb, "manifest.jsonl"))
assert.equal(manifest.states.get(first).verdict, "resolved")
assert.equal(manifest.states.get(second).verdict, "empty patch")
assert.equal(manifest.states.get(third).verdict, "unresolved")
assert.equal(manifest.states.get(third).state, "cleaned")
assert.equal(manifest.states.get(fourth).state, "failed")
assert.match(manifest.states.get(fourth).reason, /disk gate timed out before the pull/)

assert.equal(manifest.states.get(first).imageState, "deleted")
assert.equal(manifest.states.get(second).imageState, "deleted")
assert.equal(manifest.states.get(third).imageState, "kept", "a pinned instance's image is never deleted")

// The patch sizes the archive holds, read back off the ledger rather than the
// filesystem, and the cost every journal priced.
assert.ok(manifest.states.get(first).patchBytes > 0)
assert.equal(manifest.states.get(second).patchBytes, 0)
// Two turns of the stub journal's usage, priced at the committed rate card.
const journalUsd =
  usd("openai:gpt-5.6-sol", { inputTokens: 200_000, cachedInputTokens: 100_000, outputTokens: 4000 }).usd
assert.ok(journalUsd > 0)
for (const id of [first, second, third]) {
  assert.ok(
    Math.abs(manifest.states.get(id).cost.usd - journalUsd) < 1e-9,
    `${id} priced its journal at ${manifest.states.get(id).cost.usd}`
  )
  assert.equal(manifest.states.get(id).cost.modelCalls, 2)
}

// Four driver sessions, each with its own header, and the one note the pause
// wrote.
assert.equal(manifest.headers.length, 4, "one header per driver session")
assert.equal(manifest.headers[0].subjectSource, "stubbed")
assert.equal(manifest.headers[0].jobs, 2)
assert.ok(
  manifest.notes.some((note) => note.note === "paused"),
  "the pause is in the ledger, not only in a file"
)

// ---------------------------------------------------------------------------
// The archive: journal, patch and evaluator report, per instance, under
// fullbench/ and out of the shared roots
// ---------------------------------------------------------------------------
for (const id of [first, second, third]) {
  assert.ok(existsSync(join(fb, "patches", `${id}.patch`)), `${id} archived its patch`)
  assert.ok(existsSync(join(fb, "journals", id, "engine.db")), `${id} archived its journal`)
  assert.ok(existsSync(join(fb, "timings", `${id}.json`)), `${id} archived its timings`)
}
assert.ok(existsSync(join(fb, "reports", `${first}.json`)), "the evaluator's own report is kept")
assert.ok(!existsSync(join(fb, "reports", `${second}.json`)), "an empty patch has no evaluator report")

// ---------------------------------------------------------------------------
// Phase D: the disk gate logged every wait
// ---------------------------------------------------------------------------
const waits = lines(join(fb, "waits.jsonl")).map((line) => JSON.parse(line))
assert.ok(waits.length > 0, "the gate wrote a row for the wait it made")
for (const wait of waits) {
  assert.equal(wait.kind, "wait")
  assert.equal(wait.id, fourth)
  assert.equal(wait.phase, "pull")
  assert.equal(wait.freeMiB, 1000)
  assert.equal(wait.neededMiB, 8192)
}
assert.match(text(join(fb, "driver.log")), /disk gate \(pull\): 1000 MiB free, need 8192 MiB/)

// ---------------------------------------------------------------------------
// Phase C: the budget paused it rather than spending on
// ---------------------------------------------------------------------------
assert.equal(text(join(temporary, "phase-c.exit")).trim(), "7", "a paused driver exits 7")
const paused = text(join(fb, "PAUSED"))
// The three priced attempts, rounded to cents after summing as the gate does.
const spent = (Math.round(journalUsd * 3 * 100) / 100).toFixed(2)
assert.ok(paused.includes(`cumulative API cost $${spent} reached the $0.50 budget`), paused)
assert.match(text(join(fb, "progress.md")), /> \*\*PAUSED\*\* at 20/)

// ---------------------------------------------------------------------------
// The report and the status screen
// ---------------------------------------------------------------------------
const report = text(join(fb, "report.md"))
assert.match(report, /# SWE-bench Verified — full benchmark/)
assert.match(report, /\| subject agreement \| one subject \|/, "four sessions, one subject")
assert.match(report, /\| cost budget \| \$0\.50 \|/, "the report names the budget in effect, not the first session's")
assert.match(report, /> \*\*PAUSED\*\* — cumulative API cost/)
assert.match(report, /\| \*\*graded\*\* \| \*\*3\*\* \| of 4 \|/)
assert.match(report, /\| resolved \| 1 \| 33\.3% \|/)
const progressRows = text(join(fb, "progress.md")).split("\n").filter((line) => /^\| 20\d\d-/.test(line))
assert.ok(progressRows.length >= 2, `the checkpoint log has rows (${progressRows.length})`)

const status = text(join(temporary, "status.txt"))
assert.match(status, /SWE-bench Verified — full benchmark/)
assert.match(status, /3\/4 graded/)
assert.match(status, /PAUSED/)

// ---------------------------------------------------------------------------
// Docker, at the end
// ---------------------------------------------------------------------------
const images = text(join(temporary, "images-final.txt"))
assert.match(images, /busybox absent/, "an unpinned instance's image is deleted")
assert.match(images, /hello-world absent/, "an unpinned instance's image is deleted")
assert.match(images, /alpine present/, "a pinned instance's image survives the whole benchmark")

// ---------------------------------------------------------------------------
// The second benchmark: the three crash boundaries around a recorded verdict
// ---------------------------------------------------------------------------
const fb2 = join(temporary, "fullbench2")
const [orphan, stale, nopatch] = lines(join(temporary, "roles2.txt"))
const crash = read(join(fb2, "manifest.jsonl"))

// Phase F. The driver was killed on its own and its worker kept running. The
// driver that started next must leave that instance to the worker that owns it:
// a second attempt would be two agents spending on one instance, writing one
// patch path.
assert.equal(
  count(ledger, `S ${orphan}`),
  1,
  "an instance a live worker still owns is never started a second time"
)
assert.match(
  text(join(temporary, "phase-f.log")),
  /is claimed by a worker this driver did not start/,
  "the driver says so rather than silently skipping it"
)
assert.match(
  text(join(temporary, "phase-f.log")),
  /an orphaned worker is still running/,
  "and it recognises the orphan on the way in, before it schedules anything"
)
assert.equal(crash.states.get(orphan).verdict, "resolved", "the orphaned worker finished its own instance")

// Phase H. The attempt that died had already written the evaluator's report for
// this instance, and the official evaluator skips any instance that already has
// one. Unless the re-run deletes it, the driver reads a verdict belonging to a
// patch it never produced: here that stale report says `resolved`, the stub
// evaluator writes nothing (which is what the real one does when it skips), and
// the only honest answer is that this attempt was not graded.
assert.equal(
  crash.states.get(stale).verdict,
  "eval error",
  "a re-run re-grades from scratch instead of inheriting the dead attempt's verdict"
)
assert.ok(
  !existsSync(join(fb2, "reports", `${stale}.json`)),
  "and no report is archived for an attempt that was never graded"
)

// Phase E. A failure after the pull deletes the image. Keeping it costs 2–3 GB
// for the rest of the benchmark, and a handful of those is a disk gate that
// never opens again.
assert.equal(crash.states.get(nopatch).state, "failed")
assert.match(crash.states.get(nopatch).reason, /captured no patch/)
assert.equal(crash.states.get(nopatch).imageState, "deleted")
assert.match(
  text(join(temporary, "images-after-failure.txt")),
  /busybox absent/,
  "an instance that failed after pulling leaves no image behind"
)

// Phase G. An instance killed between its verdict and its `docker rmi` is past
// the resume boundary, so nothing schedules it again — and nothing would ever
// delete its image either. The next driver reconciles it on the way in.
const reconciled = crash.states.get(orphan)
assert.equal(reconciled.state, "cleaned")
assert.equal(reconciled.reconciled, 1)
assert.equal(reconciled.imageState, "deleted")
assert.match(
  text(join(temporary, "images-after-reconcile.txt")),
  /hello-world absent/,
  "the image an interrupted cleanup left behind is deleted by the next driver"
)

console.log(
  "check-dryrun.mjs: two in flight, a kill mid-instance, a clean resume, a logged disk wait,"
    + " a budget pause, an orphaned worker left alone, a stale verdict refused, a failed"
    + " instance's image deleted, an interrupted cleanup reconciled, and every image but the"
    + " pinned one gone."
)
