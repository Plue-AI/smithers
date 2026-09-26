/**
 * Replays `compare-runs.mjs` over two synthesised ledgers.
 *
 * The comparison is the thing the whole re-run exists to produce, and it is
 * arithmetic over two JSONL files — so it is checked here rather than trusted
 * once, with real numbers, at the end of a run that cost real money.
 *
 * What is pinned:
 *
 * - **the population is the baseline's**, so a re-run cannot be scored against a
 *   set the baseline never met;
 * - **a partial re-run compares like with like** — totals cover the instances
 *   both ledgers finished, and the baseline's own numbers over that same subset
 *   sit beside them;
 * - **cost is every attempt**, including the one a crash replaced, because that
 *   is what the invoice says;
 * - **a lost verdict is reported as lost**, whatever the totals do;
 * - **an excluded instance leaves the totals, the criteria and the moved-verdict
 *   sets, and never leaves the report** — it keeps its per-instance row, it is
 *   marked, its documented cause is printed, and every number carries the scored
 *   denominator and the raw one together;
 * - and the program's success criteria are answered `pending` until the whole
 *   population is in, rather than declared met by a favourable prefix — all six
 *   of them together, aggregate and per-instance alike — while a counterexample
 *   a prefix has already witnessed is reported on the spot.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { compare, render, spendByInstance } from "../compare-runs.mjs"
import { EXCLUDED } from "../lib/excluded.mjs"
import { read } from "../lib/fullbench-manifest.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-compare-"))

const ledger = (path, rows) => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return path
}

const instance = (id, state, extra = {}) => ({ kind: "instance", id, state, at: 1, ...extra })

const graded = (id, verdict, { usd, frames, wallSeconds, agentSeconds }) => [
  instance(id, "pulled"),
  instance(id, "ran", {
    wallSeconds,
    cost: { usd, frames, spanMillis: agentSeconds * 1000 }
  }),
  instance(id, "graded", { verdict }),
  instance(id, "cleaned")
]

try {
  // -----------------------------------------------------------------------
  // A complete re-run: one gained, one lost, one unchanged and cheaper.
  // -----------------------------------------------------------------------
  const baselinePath = ledger(join(temporary, "baseline.jsonl"), [
    { kind: "header", at: 0, runId: "fullbench" },
    ...graded("a__a-1", "resolved", { usd: 2, frames: 20, wallSeconds: 400, agentSeconds: 380 }),
    ...graded("b__b-2", "unresolved", { usd: 1, frames: 10, wallSeconds: 200, agentSeconds: 180 }),
    ...graded("c__c-3", "resolved", { usd: 0.5, frames: 5, wallSeconds: 100, agentSeconds: 90 })
  ])
  const rerunPath = ledger(join(temporary, "rerun.jsonl"), [
    { kind: "header", at: 0, runId: "rerun-r91" },
    ...graded("a__a-1", "unresolved", { usd: 0.5, frames: 4, wallSeconds: 120, agentSeconds: 110 }),
    ...graded("b__b-2", "resolved", { usd: 0.25, frames: 3, wallSeconds: 90, agentSeconds: 80 }),
    ...graded("c__c-3", "resolved", { usd: 0.25, frames: 2, wallSeconds: 60, agentSeconds: 50 })
  ])

  const summary = compare({ baselinePath, rerunPath })
  assert.equal(summary.population, 3)
  assert.equal(summary.comparedCount, 3)
  assert.equal(summary.pending, 0)
  assert.deepEqual(summary.gained, ["b__b-2"])
  assert.deepEqual(summary.lost, ["a__a-1"])

  assert.equal(summary.totals.compared.baseline.resolved, 2)
  assert.equal(summary.totals.compared.rerun.resolved, 2)
  assert.equal(summary.totals.compared.baseline.usd, 3.5)
  assert.equal(summary.totals.compared.rerun.usd, 1)
  assert.equal(summary.totals.compared.baseline.agentSeconds, 650)
  assert.equal(summary.totals.compared.rerun.agentSeconds, 240)
  assert.equal(summary.totals.compared.baseline.frames, 35)
  assert.equal(summary.totals.compared.rerun.frames, 9)
  // Nothing here is excluded, so scored and raw are the same fold — the state
  // every population outside `psf/requests` is in.
  assert.equal(summary.scoredCount, 3)
  assert.deepEqual(summary.excluded, [])
  assert.deepEqual(summary.totals.scored, summary.totals.compared)

  // A cheaper, faster run that lost a verdict has still lost it, and the
  // criteria say so.
  assert.equal(summary.criteria.noRegression.met, false)
  assert.deepEqual(summary.criteria.noRegression.lost, ["a__a-1"])
  assert.equal(summary.criteria.totalUsd.met, true)
  assert.equal(summary.criteria.resolved.met, false, "2 resolved cannot meet a target of 33")
  assert.equal(summary.criteria.perInstanceUsd.met, true)
  assert.equal(summary.criteria.perInstanceFrames.met, true)

  const a = summary.instances.find((row) => row.id === "a__a-1")
  assert.equal(a.moved, "lost")
  assert.equal(a.delta.usd, -1.5)
  assert.equal(a.delta.frames, -16)
  assert.equal(a.delta.agentSeconds, -270)

  // -----------------------------------------------------------------------
  // A partial re-run compares like with like.
  // -----------------------------------------------------------------------
  const partialPath = ledger(join(temporary, "partial.jsonl"), [
    ...graded("c__c-3", "resolved", { usd: 0.25, frames: 2, wallSeconds: 60, agentSeconds: 50 })
  ])
  const partial = compare({ baselinePath, rerunPath: partialPath })
  assert.equal(partial.comparedCount, 1)
  assert.equal(partial.pending, 2)
  // The compared baseline is c__c-3 alone, not all three.
  assert.equal(partial.totals.compared.baseline.usd, 0.5)
  assert.equal(partial.totals.compared.baseline.instances, 1)
  // The whole baseline is still reported, and is still all three.
  assert.equal(partial.totals.wholeBaseline.instances, 3)
  assert.equal(partial.totals.wholeBaseline.usd, 3.5)
  // The population-wide criteria cannot be met by a prefix. Every one of them,
  // not only the aggregates: a prefix with no instance over budget, no instance
  // over the frame ceiling and no verdict lost has witnessed nothing about the
  // two instances still to run, so all six are pending together.
  assert.equal(partial.criteria.complete, false)
  assert.equal(partial.criteria.resolved.met, undefined)
  assert.equal(partial.criteria.totalUsd.met, undefined)
  assert.equal(partial.criteria.wallMinutes.met, undefined)
  assert.equal(partial.criteria.perInstanceUsd.met, undefined, "a clean prefix answered the per-instance budget")
  assert.equal(partial.criteria.perInstanceFrames.met, undefined, "a clean prefix answered the frame ceiling")
  assert.equal(partial.criteria.noRegression.met, undefined, "a clean prefix answered the superset rule")
  const rendered = render(partial)
  assert.match(rendered, /2 not re-run yet/)
  assert.match(rendered, /\| pending \|/)
  assert.match(rendered, /a__a-1 \| resolved \| not re-run/)
  // Six criteria, six pending marks, no `yes` anywhere in the table.
  assert.equal(rendered.match(/\| pending \|/g).length, 6)
  assert.ok(!/\| yes \|/.test(rendered), "an outstanding population printed a criterion as met")

  // A counterexample, though, is permanent: a dollar spent, a frame taken and a
  // verdict lost cannot be taken back by the instances still to run, so each is
  // reported the moment it is witnessed rather than held until the last one.
  const witnessedPath = ledger(join(temporary, "witnessed.jsonl"), [
    ...graded("a__a-1", "unresolved", { usd: 22, frames: 40, wallSeconds: 9000, agentSeconds: 8000 })
  ])
  const witnessed = compare({ baselinePath, rerunPath: witnessedPath })
  assert.equal(witnessed.pending, 2)
  assert.equal(witnessed.criteria.complete, false)
  assert.equal(witnessed.criteria.totalUsd.met, false, "$22 of a $15 budget is already spent")
  assert.equal(witnessed.criteria.wallMinutes.met, false, "150 min of a 120 min budget is already gone")
  assert.deepEqual(witnessed.criteria.perInstanceUsd.over, ["a__a-1"])
  assert.equal(witnessed.criteria.perInstanceUsd.met, false)
  assert.deepEqual(witnessed.criteria.perInstanceFrames.over, ["a__a-1"])
  assert.equal(witnessed.criteria.perInstanceFrames.met, false)
  assert.deepEqual(witnessed.criteria.noRegression.lost, ["a__a-1"])
  assert.equal(witnessed.criteria.noRegression.met, false)
  // A resolved count is the one criterion a prefix cannot fail: the instances
  // still to run can only add to it.
  assert.equal(witnessed.criteria.resolved.met, undefined)
  const witnessedMarkdown = render(witnessed)
  assert.equal(witnessedMarkdown.match(/\| NO \|/g).length, 5)

  // -----------------------------------------------------------------------
  // A complete, clean population answers `true` — the same criteria, settled.
  // -----------------------------------------------------------------------
  const cleanPath = ledger(join(temporary, "clean.jsonl"), [
    ...graded("a__a-1", "resolved", { usd: 0.5, frames: 4, wallSeconds: 120, agentSeconds: 110 }),
    ...graded("b__b-2", "unresolved", { usd: 0.25, frames: 3, wallSeconds: 90, agentSeconds: 80 }),
    ...graded("c__c-3", "resolved", { usd: 0.25, frames: 2, wallSeconds: 60, agentSeconds: 50 })
  ])
  const clean = compare({ baselinePath, rerunPath: cleanPath })
  assert.equal(clean.pending, 0)
  assert.equal(clean.criteria.complete, true)
  assert.equal(clean.criteria.totalUsd.met, true)
  assert.equal(clean.criteria.wallMinutes.met, true)
  assert.equal(clean.criteria.perInstanceUsd.met, true)
  assert.equal(clean.criteria.perInstanceFrames.met, true)
  assert.equal(clean.criteria.noRegression.met, true)
  assert.equal(clean.criteria.resolved.met, false, "2 resolved cannot meet a target of 33")

  // -----------------------------------------------------------------------
  // Cost is every attempt, not the surviving one.
  // -----------------------------------------------------------------------
  const crashedPath = ledger(join(temporary, "crashed.jsonl"), [
    instance("c__c-3", "pulled"),
    instance("c__c-3", "ran", { wallSeconds: 300, cost: { usd: 1.75, frames: 12, spanMillis: 280_000 } }),
    instance("c__c-3", "failed", { reason: "killed" }),
    // The attempt that replaced it. `pulled` resets the fold's columns; the
    // dollars the dead attempt burned are still on the invoice.
    ...graded("c__c-3", "resolved", { usd: 0.25, frames: 2, wallSeconds: 60, agentSeconds: 50 })
  ])
  assert.equal(spendByInstance(read(crashedPath)).get("c__c-3"), 2)
  const crashed = compare({ baselinePath, rerunPath: crashedPath })
  assert.equal(crashed.totals.compared.rerun.usd, 2, "the replaced attempt's dollars were dropped")
  assert.equal(crashed.totals.compared.rerun.frames, 2, "the fold, not the sum, answers frames")

  // -----------------------------------------------------------------------
  // A re-run with an instance the baseline never had is ignored, not counted.
  // -----------------------------------------------------------------------
  const strayPath = ledger(join(temporary, "stray.jsonl"), [
    ...graded("c__c-3", "resolved", { usd: 0.25, frames: 2, wallSeconds: 60, agentSeconds: 50 }),
    ...graded("z__z-9", "resolved", { usd: 0.1, frames: 1, wallSeconds: 30, agentSeconds: 20 })
  ])
  const stray = compare({ baselinePath, rerunPath: strayPath })
  assert.equal(stray.comparedCount, 1)
  assert.equal(stray.totals.compared.rerun.usd, 0.25, "an instance outside the population was scored")
  assert.ok(!stray.instances.some((row) => row.id === "z__z-9"))

  // -----------------------------------------------------------------------
  // An excluded instance, with a real name and its documented cause.
  // -----------------------------------------------------------------------
  const [excludedId, excludedEntry] = [...EXCLUDED.entries()][0]
  const scopedBaseline = ledger(join(temporary, "scoped-baseline.jsonl"), [
    { kind: "header", at: 0, runId: "fullbench" },
    ...graded("a__a-1", "resolved", { usd: 2, frames: 20, wallSeconds: 400, agentSeconds: 380 }),
    ...graded(excludedId, "resolved", { usd: 1, frames: 4, wallSeconds: 100, agentSeconds: 90 })
  ])
  const scopedRerun = ledger(join(temporary, "scoped-rerun.jsonl"), [
    { kind: "header", at: 0, runId: "rerun" },
    ...graded("a__a-1", "resolved", { usd: 0.5, frames: 4, wallSeconds: 120, agentSeconds: 110 }),
    // The row the grading environment decided. Without the exclusion this is a
    // lost verdict and a failed `noRegression` criterion.
    ...graded(excludedId, "unresolved", { usd: 0.25, frames: 3, wallSeconds: 90, agentSeconds: 80 })
  ])
  const scoped = compare({ baselinePath: scopedBaseline, rerunPath: scopedRerun })
  assert.equal(scoped.comparedCount, 2)
  assert.equal(scoped.scoredCount, 1)
  assert.deepEqual(scoped.excluded.map((row) => row.id), [excludedId])
  // Out of the totals and out of the moved-verdict sets...
  assert.deepEqual(scoped.lost, [])
  assert.equal(scoped.criteria.noRegression.met, true)
  assert.equal(scoped.totals.scored.rerun.instances, 1)
  assert.equal(scoped.totals.scored.rerun.usd, 0.5)
  // ...and still in the raw fold, which is printed beside it every time.
  assert.equal(scoped.totals.compared.rerun.instances, 2)
  assert.equal(scoped.totals.compared.rerun.usd, 0.75)
  assert.equal(scoped.criteria.resolved.actual, 1)
  assert.equal(scoped.criteria.resolved.of, 1)
  assert.equal(scoped.criteria.resolved.raw, 1)
  assert.equal(scoped.criteria.resolved.ofRaw, 2)
  assert.equal(scoped.criteria.totalUsd.actual, 0.5)
  assert.equal(scoped.criteria.totalUsd.raw, 0.75)

  const scopedMarkdown = render(scoped)
  assert.match(scopedMarkdown, /1 scored of 2 run/)
  assert.match(scopedMarkdown, /Excluded from the scoreboard, by name/)
  assert.ok(scopedMarkdown.includes(excludedEntry.cause), "the documented cause is printed")
  assert.ok(scopedMarkdown.includes(excludedEntry.reportedIn), "the report the cause came from is named")
  assert.ok(scopedMarkdown.includes(`| ${excludedId} **excluded** |`), "the per-instance row is marked")
  assert.match(scopedMarkdown, /The same fold over every compared instance, exclusions included/)
  assert.match(scopedMarkdown, /\(raw 1\/2\)/)

  // -----------------------------------------------------------------------
  // The CLI writes both artifacts and is a pure function of its inputs.
  // -----------------------------------------------------------------------
  const out = join(temporary, "out")
  spawnSync("mkdir", ["-p", out])
  const run = () =>
    spawnSync(process.execPath, [
      join(root, "compare-runs.mjs"),
      "--baseline",
      baselinePath,
      "--rerun",
      rerunPath,
      "--out",
      out
    ], { encoding: "utf8" })
  const first = run()
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /resolved 2 -> 2/)
  assert.match(first.stdout, /scored 3 of 3 run/)
  assert.match(first.stdout, /cost \$3\.50 -> \$1\.00/)
  const once = readFileSync(join(out, "compare.md"), "utf8")
  const twice = (run(), readFileSync(join(out, "compare.md"), "utf8"))
  assert.equal(once, twice, "two runs over one pair of ledgers did not produce the same bytes")
  assert.match(once, /\| resolved \| 2\/3 \| 2\/3 \| \+0 \|/)
  assert.match(once, /a__a-1 \*\*-\*\*/)
  assert.match(once, /b__b-2 \*\*\+\*\*/)

  // A missing baseline is a refusal, not an empty report.
  const missing = spawnSync(process.execPath, [
    join(root, "compare-runs.mjs"),
    "--baseline",
    join(temporary, "nope.jsonl")
  ], { encoding: "utf8" })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no baseline ledger/)

  console.log(
    "check-compare-runs: the comparison is like-for-like, counts every attempt's dollars, reports a lost verdict,"
      + " and prints both denominators around every exclusion."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
