/**
 * Replays `three-way.mjs` over three synthesised ledgers.
 *
 * The three-column scoreboard exists because a second re-run has two questions
 * to answer at once, and each has a way of being answered wrongly that would
 * look like data:
 *
 * - **recovered is not gained.** An instance the baseline resolved, the middle
 *   wave dropped and this one holds again is a recovery. An instance no wave
 *   before this one ever resolved is a gain. Counting the first as the second
 *   is how a surgery that merely undid a regression gets reported as progress.
 * - **still lost is not newly lost.** An instance the baseline resolved and
 *   neither re-run does is a regression this wave did not fix; one the middle
 *   wave resolved and this one does not is a regression this wave introduced.
 *   They belong in different rows because they call for different work.
 * - **the middle column is the middle ledger's own fold**, not a re-derivation:
 *   its dollars are every attempt, exactly as `compare-runs.mjs` counts them.
 * - **an excluded instance is in none of the four movement rows and in every
 *   printed denominator.** A verdict a grading environment decided is not a
 *   recovery, a gain, a still-lost or a newly-lost — and hiding it would be
 *   worse than counting it, so the raw totals sit under the scored ones and the
 *   per-instance row stays and is marked.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { EXCLUDED } from "../lib/excluded.mjs"
import { render, threeWay } from "../three-way.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-three-way-"))

const ledger = (path, rows) => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return path
}

const instance = (id, state, extra = {}) => ({ kind: "instance", id, state, at: 1, ...extra })

const graded = (id, verdict, { usd, frames, wallSeconds, agentSeconds }) => [
  instance(id, "pulled"),
  instance(id, "ran", { wallSeconds, cost: { usd, frames, spanMillis: agentSeconds * 1000 } }),
  instance(id, "graded", { verdict }),
  instance(id, "cleaned")
]

const cost = (usd) => ({ usd, frames: 4, wallSeconds: 100, agentSeconds: 90 })

try {
  // recovered: resolved, lost, resolved again.
  // stillLost:  resolved, lost, lost.
  // newlyLost:  unresolved, resolved, unresolved.
  // gained:     unresolved, unresolved, resolved.
  // steady:     resolved throughout.
  const baselinePath = ledger(join(temporary, "r90.jsonl"), [
    { kind: "header", at: 0, runId: "fullbench" },
    ...graded("a__recovered-1", "resolved", cost(1)),
    ...graded("b__stilllost-2", "resolved", cost(1)),
    ...graded("c__newlylost-3", "unresolved", cost(1)),
    ...graded("d__gained-4", "unresolved", cost(1)),
    ...graded("e__steady-5", "resolved", cost(1))
  ])
  const firstPath = ledger(join(temporary, "r91.jsonl"), [
    { kind: "header", at: 0, runId: "rerun-r91" },
    ...graded("a__recovered-1", "empty patch", cost(2)),
    ...graded("b__stilllost-2", "unresolved", cost(2)),
    ...graded("c__newlylost-3", "resolved", cost(2)),
    ...graded("d__gained-4", "unresolved", cost(2)),
    ...graded("e__steady-5", "resolved", cost(2))
  ])
  const secondPath = ledger(join(temporary, "r92.jsonl"), [
    { kind: "header", at: 0, runId: "rerun-r92" },
    ...graded("a__recovered-1", "resolved", cost(0.5)),
    ...graded("b__stilllost-2", "unresolved", cost(0.5)),
    ...graded("c__newlylost-3", "unresolved", cost(0.5)),
    ...graded("d__gained-4", "resolved", cost(0.5)),
    ...graded("e__steady-5", "resolved", cost(0.5))
  ])

  const summary = threeWay({ baselinePath, firstPath, secondPath })

  assert.equal(summary.population, 5)
  assert.equal(summary.comparedCount, 5)
  assert.equal(summary.pending, 0)

  // The four movements, each in its own row and none in another's.
  assert.deepEqual(summary.recovered, ["a__recovered-1"])
  assert.deepEqual(summary.stillLost, ["b__stilllost-2"])
  assert.deepEqual(summary.newlyLost, ["c__newlylost-3"])
  // Disjoint by construction: a recovery is an instance the baseline already
  // resolved, so it can never also be a gain over the baseline.
  assert.deepEqual(summary.gainedOverBaseline, ["d__gained-4"])

  // The three columns are three ledgers' own totals.
  assert.equal(summary.totals.baseline.resolved, 3)
  assert.equal(summary.totals.first.resolved, 2)
  assert.equal(summary.totals.second.resolved, 3)
  assert.equal(summary.totals.baseline.usd, 5)
  assert.equal(summary.totals.first.usd, 10)
  assert.equal(summary.totals.second.usd, 2.5)
  // Nothing here is excluded, so the scored and raw rows are the same fold.
  assert.equal(summary.scoredCount, 5)
  assert.deepEqual(summary.excluded, [])
  assert.deepEqual(summary.rawTotals, summary.totals)

  // The middle column is a fold of every attempt, like the outer two. A crash
  // that was replaced still burned tokens, and the invoice says so.
  const retriedPath = ledger(join(temporary, "r91-retried.jsonl"), [
    { kind: "header", at: 0, runId: "rerun-r91" },
    ...graded("a__recovered-1", "empty patch", cost(2)),
    instance("b__stilllost-2", "ran", { wallSeconds: 10, cost: { usd: 3, frames: 1, spanMillis: 1000 } }),
    ...graded("b__stilllost-2", "unresolved", cost(2)),
    ...graded("c__newlylost-3", "resolved", cost(2)),
    ...graded("d__gained-4", "unresolved", cost(2)),
    ...graded("e__steady-5", "resolved", cost(2))
  ])
  assert.equal(
    threeWay({ baselinePath, firstPath: retriedPath, secondPath }).totals.first.usd,
    13,
    "the crashed attempt's dollars belong in the middle column"
  )

  // The middle column uses the same attempt projection: an enriching grade is
  // not a second bill, and an unknown cost stays unknown in every column that
  // reads it rather than printing as $0.00.
  const enrichedPath = ledger(join(temporary, "r91-enriched.jsonl"), [
    { kind: "header", at: 0, runId: "rerun-r91" },
    ...graded("a__recovered-1", "empty patch", cost(2)),
    instance("b__stilllost-2", "ran", { wallSeconds: 10, cost: { usd: 2, frames: 1, spanMillis: 1000 } }),
    instance("b__stilllost-2", "graded", { verdict: "unresolved", cost: { usd: 2 } }),
    instance("c__newlylost-3", "ran", { cost: { usd: null, unknown: true } }),
    instance("c__newlylost-3", "graded", { verdict: "resolved" }),
    ...graded("d__gained-4", "unresolved", cost(2)),
    ...graded("e__steady-5", "resolved", cost(2))
  ])
  const enriched = threeWay({ baselinePath, firstPath: enrichedPath, secondPath })
  assert.equal(enriched.totals.first.usd, null, "an unknown attempt cost leaves the column's total unknown")
  assert.equal(enriched.rows.find((row) => row.id === "b__stilllost-2").first.usd, 2, "one attempt, one bill")
  assert.equal(enriched.rows.find((row) => row.id === "c__newlylost-3").first.usd, null)
  assert.match(render(enriched), /\| total cost \| \$5\.00 \| unknown \| \$2\.50 \|/)

  // A partial second wave leaves its own rows blank and never borrows the
  // middle wave's verdict for them.
  const partialPath = ledger(join(temporary, "r92-partial.jsonl"), [
    { kind: "header", at: 0, runId: "rerun-r92" },
    ...graded("a__recovered-1", "resolved", cost(0.5))
  ])
  const partial = threeWay({ baselinePath, firstPath, secondPath: partialPath })
  assert.equal(partial.comparedCount, 1)
  assert.equal(partial.pending, 4)
  assert.deepEqual(partial.recovered, ["a__recovered-1"])
  assert.deepEqual(partial.stillLost, [], "an instance this wave has not run is not lost")
  assert.match(render(partial), /not re-run/)

  // -------------------------------------------------------------------------
  // An excluded instance, in no movement row and in both denominators.
  // -------------------------------------------------------------------------
  const [excludedId, excludedEntry] = [...EXCLUDED.entries()][0]
  const withExclusion = (path, verdicts) =>
    ledger(join(temporary, path), [
      { kind: "header", at: 0, runId: path },
      ...graded("a__recovered-1", verdicts[0], cost(1)),
      ...graded(excludedId, verdicts[1], cost(1))
    ])
  // The excluded row would otherwise read as "still lost": resolved by the
  // baseline, unresolved by both re-runs. That is the exact shape the r92
  // report's `psf/requests` pair has, and the exact shape it is not.
  const scoped = threeWay({
    baselinePath: withExclusion("scoped-r90.jsonl", ["resolved", "resolved"]),
    firstPath: withExclusion("scoped-r91.jsonl", ["empty patch", "unresolved"]),
    secondPath: withExclusion("scoped-r92.jsonl", ["resolved", "unresolved"])
  })
  assert.equal(scoped.comparedCount, 2)
  assert.equal(scoped.scoredCount, 1)
  assert.deepEqual(scoped.excluded.map((row) => row.id), [excludedId])
  assert.deepEqual(scoped.recovered, ["a__recovered-1"])
  assert.deepEqual(scoped.stillLost, [], "a verdict the grading environment decided is not a regression")
  assert.equal(scoped.totals.second.instances, 1)
  assert.equal(scoped.rawTotals.second.instances, 2)
  assert.equal(scoped.totals.baseline.resolved, 1)
  assert.equal(scoped.rawTotals.baseline.resolved, 2)

  const scopedMarkdown = render(scoped)
  assert.match(scopedMarkdown, /Scored: 1 of 2 run/)
  assert.match(scopedMarkdown, /\| resolved \| 1\/1 \| 0\/1 \| 1\/1 \|/)
  assert.match(scopedMarkdown, /\| resolved \(raw\) \| 2\/2 \| 0\/2 \| 1\/2 \|/)
  assert.match(scopedMarkdown, /\| total cost \(raw\) \| \$2\.00 \| \$2\.00 \| \$2\.00 \|/)
  assert.match(scopedMarkdown, /Excluded from the scoreboard, by name/)
  assert.ok(scopedMarkdown.includes(excludedEntry.cause), "the documented cause is printed")
  assert.ok(scopedMarkdown.includes(`| ${excludedId} **excluded** |`), "the per-instance row is marked")

  // -------------------------------------------------------------------------
  // The command line writes both artifacts and names all three ledgers.
  // -------------------------------------------------------------------------
  const out = join(temporary, "out")
  writeFileSync(join(temporary, ".keep"), "")
  spawnSync("mkdir", ["-p", out])
  const run = spawnSync(process.execPath, [
    join(root, "three-way.mjs"),
    "--baseline",
    baselinePath,
    "--first",
    firstPath,
    "--second",
    secondPath,
    "--out",
    out,
    "--baseline-name",
    "r90",
    "--first-name",
    "r91",
    "--second-name",
    "r92"
  ], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /resolved 3 -> 2 -> 3/)
  assert.match(run.stdout, /5 scored of 5 run of 5/)
  const markdown = readFileSync(join(out, "three-way.md"), "utf8")
  assert.match(markdown, /\| \| r90 \| r91 \| r92 \|/)
  assert.match(markdown, /recovered \(1\): a__recovered-1/)
  assert.match(markdown, /still lost \(1\): b__stilllost-2/)
  assert.match(markdown, /newly lost \(1\): c__newlylost-3/)
  assert.equal(JSON.parse(readFileSync(join(out, "three-way.json"), "utf8")).comparedCount, 5)

  const missing = spawnSync(process.execPath, [join(root, "three-way.mjs"), "--baseline", baselinePath], {
    encoding: "utf8"
  })
  assert.equal(missing.status, 2)
  assert.match(missing.stderr, /--first is required/)

  console.log(
    "check-three-way: a recovery is told from a gain, a regression this wave did not fix from one it"
      + " introduced, the middle column is the middle ledger's own fold, and an exclusion is in no movement"
      + " row and in both denominators."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
