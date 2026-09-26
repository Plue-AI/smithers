/**
 * Replays `n-way.mjs` over four synthesised ledgers.
 *
 * The n-column scoreboard is `three-way.mjs` with the arity taken out, so it
 * inherits that reader's two ways of being wrong and adds one of its own:
 *
 * - **recovered is not gained.** An instance the baseline resolved, some wave
 *   since dropped, and the last wave holds again is a recovery. An instance no
 *   wave before the last ever resolved is a gain. Counting the first as the
 *   second is how a wave that undid a regression gets reported as progress.
 * - **still lost is about the last wave only.** With four columns there is more
 *   than one way for an instance to have been lost in between, and none of them
 *   is the question: what the next report has to answer for is what the
 *   baseline resolved and the newest wave does not.
 * - **every column is that wave's own fold.** The dollars are every attempt,
 *   the wall clocks are the two `compare-runs.mjs` labels, and the baseline
 *   column reads identically no matter which wave it was computed against —
 *   which is the check that the columns are one rule applied n times.
 * - **an excluded instance is in no movement row and in every printed
 *   denominator**, exactly as the three-column reader has it.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { EXCLUDED } from "../lib/excluded.mjs"
import { nWay, render } from "../n-way.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-n-way-"))

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

const wave = (name, verdicts, usd) => ({
  name,
  path: ledger(join(temporary, `${name}.jsonl`), [
    { kind: "header", at: 0, runId: name },
    ...Object.entries(verdicts).flatMap(([id, verdict]) => graded(id, verdict, cost(usd)))
  ])
})

try {
  // recovered: resolved, lost in the middle, resolved again by the last wave.
  // stillLost: resolved by the baseline and by nothing since.
  // gained:    unresolved until the last wave.
  // steady:    resolved throughout.
  // lateLoss:  resolved by the baseline and by r91, lost from r92 onward — a
  //            regression that is still-lost and was never recovered.
  const waves = [
    wave("r90", {
      "a__recovered-1": "resolved",
      "b__stilllost-2": "resolved",
      "c__gained-3": "unresolved",
      "d__steady-4": "resolved",
      "e__lateloss-5": "resolved"
    }, 1),
    wave("r91", {
      "a__recovered-1": "empty patch",
      "b__stilllost-2": "unresolved",
      "c__gained-3": "unresolved",
      "d__steady-4": "resolved",
      "e__lateloss-5": "resolved"
    }, 2),
    wave("r92", {
      "a__recovered-1": "unresolved",
      "b__stilllost-2": "unresolved",
      "c__gained-3": "unresolved",
      "d__steady-4": "resolved",
      "e__lateloss-5": "unresolved"
    }, 0.5),
    wave("r93", {
      "a__recovered-1": "resolved",
      "b__stilllost-2": "unresolved",
      "c__gained-3": "resolved",
      "d__steady-4": "resolved",
      "e__lateloss-5": "unresolved"
    }, 0.25)
  ]

  const summary = nWay(waves)
  assert.equal(summary.population, 5)
  assert.equal(summary.comparedCount, 5)
  assert.equal(summary.pending, 0)
  assert.deepEqual(summary.waves.map((one) => one.name), ["r90", "r91", "r92", "r93"])

  assert.deepEqual(summary.recovered, ["a__recovered-1"])
  assert.deepEqual(
    summary.stillLost,
    ["b__stilllost-2", "e__lateloss-5"],
    "still lost is about the last wave, whichever wave dropped it"
  )
  assert.deepEqual(summary.gained, ["c__gained-3"])
  assert.equal(
    summary.recovered.filter((id) => summary.gained.includes(id)).length,
    0,
    "a recovery is an instance the baseline already resolved, so it is never a gain"
  )

  // Four columns, four ledgers' own totals.
  assert.deepEqual(
    Object.fromEntries(Object.entries(summary.totals).map(([name, one]) => [name, one.resolved])),
    { r90: 4, r91: 2, r92: 1, r93: 3 }
  )
  assert.deepEqual(
    Object.fromEntries(Object.entries(summary.totals).map(([name, one]) => [name, one.usd])),
    { r90: 5, r91: 10, r92: 2.5, r93: 1.25 }
  )
  assert.equal(summary.scoredCount, 5)
  assert.deepEqual(summary.excluded, [])
  assert.deepEqual(summary.rawTotals, summary.totals)

  // Two waves is the smallest table, and it reads the same way.
  const pair = nWay([waves[0], waves[3]])
  assert.deepEqual(pair.recovered, [], "with no middle column nothing can have been dropped and regained")
  assert.deepEqual(pair.stillLost, ["b__stilllost-2", "e__lateloss-5"])
  assert.deepEqual(pair.gained, ["c__gained-3"])

  // A crashed attempt's dollars belong in that wave's column.
  const retried = {
    name: "r93",
    path: ledger(join(temporary, "r93-retried.jsonl"), [
      { kind: "header", at: 0, runId: "r93" },
      instance("b__stilllost-2", "ran", { wallSeconds: 10, cost: { usd: 3, frames: 1, spanMillis: 1000 } }),
      ...graded("a__recovered-1", "resolved", cost(0.25)),
      ...graded("b__stilllost-2", "unresolved", cost(0.25)),
      ...graded("c__gained-3", "resolved", cost(0.25)),
      ...graded("d__steady-4", "resolved", cost(0.25)),
      ...graded("e__lateloss-5", "unresolved", cost(0.25))
    ])
  }
  assert.equal(
    nWay([...waves.slice(0, 3), retried]).totals.r93.usd,
    4.25,
    "the crashed attempt's dollars belong in the last column"
  )

  // A partial last wave leaves its own cells blank and borrows no verdict.
  const partial = nWay([...waves.slice(0, 3), {
    name: "r93",
    path: ledger(join(temporary, "r93-partial.jsonl"), [
      { kind: "header", at: 0, runId: "r93" },
      ...graded("a__recovered-1", "resolved", cost(0.25))
    ])
  }])
  assert.equal(partial.comparedCount, 1)
  assert.equal(partial.pending, 4)
  assert.deepEqual(partial.stillLost, [], "an instance this wave has not run is not lost")
  assert.match(render(partial), /not re-run yet/)

  // -------------------------------------------------------------------------
  // An excluded instance, in no movement row and in both denominators.
  // -------------------------------------------------------------------------
  const [excludedId, excludedEntry] = [...EXCLUDED.entries()][0]
  const scopedWave = (name, verdicts, usd) => ({
    name,
    path: ledger(join(temporary, `scoped-${name}.jsonl`), [
      { kind: "header", at: 0, runId: name },
      ...graded("a__recovered-1", verdicts[0], cost(usd)),
      ...graded(excludedId, verdicts[1], cost(usd))
    ])
  })
  const scoped = nWay([
    scopedWave("r90", ["resolved", "resolved"], 1),
    scopedWave("r91", ["empty patch", "unresolved"], 1),
    scopedWave("r92", ["resolved", "unresolved"], 1),
    scopedWave("r93", ["resolved", "unresolved"], 1)
  ])
  assert.equal(scoped.comparedCount, 2)
  assert.equal(scoped.scoredCount, 1)
  assert.deepEqual(scoped.excluded.map((row) => row.id), [excludedId])
  assert.deepEqual(scoped.recovered, ["a__recovered-1"])
  assert.deepEqual(scoped.stillLost, [], "a verdict the grading environment decided is not a regression")
  assert.equal(scoped.totals.r93.instances, 1)
  assert.equal(scoped.rawTotals.r93.instances, 2)

  const scopedMarkdown = render(scoped)
  assert.match(scopedMarkdown, /Scored: 1 of 2 run/)
  assert.match(scopedMarkdown, /\| resolved \| 1\/1 \| 0\/1 \| 1\/1 \| 1\/1 \|/)
  assert.match(scopedMarkdown, /\| resolved \(raw\) \| 2\/2 \| 0\/2 \| 1\/2 \| 1\/2 \|/)
  assert.match(scopedMarkdown, /Excluded from the scoreboard, by name/)
  assert.ok(scopedMarkdown.includes(excludedEntry.cause), "the documented cause is printed")
  assert.ok(scopedMarkdown.includes(`| ${excludedId} **excluded** |`), "the per-instance row is marked")

  // -------------------------------------------------------------------------
  // The command line writes both artifacts and names every ledger.
  // -------------------------------------------------------------------------
  const out = join(temporary, "out")
  mkdirSync(out, { recursive: true })
  const run = spawnSync(process.execPath, [
    join(root, "n-way.mjs"),
    ...waves.flatMap((one) => ["--wave", `${one.name}=${one.path}`]),
    "--out",
    out
  ], { encoding: "utf8" })
  assert.equal(run.status, 0, run.stderr)
  assert.match(run.stdout, /resolved 4 -> 2 -> 1 -> 3/)
  assert.match(run.stdout, /5 scored of 5 run of 5/)
  const markdown = readFileSync(join(out, "n-way.md"), "utf8")
  assert.match(markdown, /# 4 ledgers, one population/)
  assert.match(markdown, /\| \| r90 \| r91 \| r92 \| r93 \|/)
  assert.match(markdown, /recovered \(1\): a__recovered-1/)
  assert.match(markdown, /still lost \(2\): b__stilllost-2, e__lateloss-5/)
  assert.equal(JSON.parse(readFileSync(join(out, "n-way.json"), "utf8")).comparedCount, 5)

  const single = spawnSync(process.execPath, [
    join(root, "n-way.mjs"),
    "--wave",
    `r90=${waves[0].path}`
  ], { encoding: "utf8" })
  assert.equal(single.status, 2)
  assert.match(single.stderr, /at least two --wave/)

  const malformed = spawnSync(process.execPath, [join(root, "n-way.mjs"), "--wave", "r90"], { encoding: "utf8" })
  assert.equal(malformed.status, 2)
  assert.match(malformed.stderr, /--wave takes name=path/)

  console.log(
    "check-n-way: a recovery is told from a gain, still-lost is about the newest wave, every column is"
      + " that wave's own fold, and an exclusion is in no movement row and in both denominators."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
