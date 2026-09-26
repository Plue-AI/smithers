/**
 * Replays the two-arm scoreboard over synthesised ledgers.
 *
 * The superset claim — flows resolves everything codex resolves, and possibly
 * more — is a four-cell table, and the two ways to get it wrong are both about
 * what counts as a verdict:
 *
 * - **`eval error` is not a loss.** The evaluator never ran the patch, so an
 *   instance carrying one belongs outside the table, named, on whichever side it
 *   happened. Counting it as unresolved manufactures a codex-only or a
 *   flows-only cell out of a docker fault.
 * - **`empty patch` is a loss.** The agent finished and changed nothing, and no
 *   container was ever needed to know that.
 *
 * Also pinned: the coverage line is stated before any rate, and the claim is
 * marked provisional whenever either arm is missing gradings — an incomplete arm
 * with a good rate is the easiest wrong conclusion in the whole rig.
 *
 * And the exclusion rule, which is the newest way to get the table wrong: an
 * instance `lib/excluded.mjs` names leaves the table for *both* arms, the raw
 * table is computed beside the scored one, and both denominators appear in
 * every rate. An exclusion that moved one cell and not the other would be
 * tuning rather than scoping, so the fixture puts a real excluded id on each
 * side of the table in turn and checks the raw column still holds it.
 *
 * Spends nothing, needs no docker, needs no dataset.
 */
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { compareArms, readVerdict, render } from "../compare-arms.mjs"
import { EXCLUDED } from "../lib/excluded.mjs"

const root = resolve(import.meta.dirname, "..")
const temporary = mkdtempSync(join(tmpdir(), "flows-swebench-arms-"))

const jsonl = (path, rows) => {
  writeFileSync(path, `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`)
  return path
}

const flowsRows = (id, verdict) => [
  { kind: "instance", id, state: "pulled", at: 1 },
  { kind: "instance", id, state: "graded", at: 2, verdict },
  { kind: "instance", id, state: "cleaned", at: 3 }
]

const codexRow = (id, verdict) => ({ kind: "instance", id, state: "graded", at: 2, verdict })

try {
  // What each verdict means, stated once.
  assert.deepEqual(readVerdict("resolved"), { graded: true, resolved: true, verdict: "resolved" })
  assert.deepEqual(readVerdict("unresolved"), { graded: true, resolved: false, verdict: "unresolved" })
  assert.deepEqual(readVerdict("empty patch"), { graded: true, resolved: false, verdict: "empty patch" })
  assert.equal(readVerdict("eval error").graded, false)
  assert.equal(readVerdict(undefined).graded, false)
  assert.equal(readVerdict(undefined).verdict, "not run")

  const flows = jsonl(join(temporary, "flows.jsonl"), [
    { kind: "header", at: 0, runId: "fullbench" },
    ...flowsRows("both__x-1", "resolved"),
    ...flowsRows("flowsonly__x-2", "resolved"),
    ...flowsRows("codexonly__x-3", "unresolved"),
    ...flowsRows("neither__x-4", "unresolved"),
    ...flowsRows("empty__x-5", "empty patch"),
    // Our own grading errored: outside the table, on our side.
    ...flowsRows("ourfault__x-6", "eval error"),
    // Their grading errored: outside the table, on theirs.
    ...flowsRows("theirfault__x-7", "resolved"),
    // Never back filled at all.
    ...flowsRows("notrun__x-8", "resolved"),
    // An instance the benchmark started and never graded is not in the
    // population at all — there is no flows verdict to compare against.
    { kind: "instance", id: "unfinished__x-9", state: "pulled", at: 1 }
  ])
  const codex = jsonl(join(temporary, "codex.jsonl"), [
    codexRow("both__x-1", "resolved"),
    codexRow("flowsonly__x-2", "unresolved"),
    codexRow("codexonly__x-3", "resolved"),
    codexRow("neither__x-4", "unresolved"),
    codexRow("empty__x-5", "resolved"),
    codexRow("ourfault__x-6", "resolved"),
    codexRow("theirfault__x-7", "eval error")
  ])

  const summary = compareArms({ manifestPath: flows, codexManifestPath: codex })
  assert.equal(summary.population, 8, "an instance the benchmark never graded entered the population")
  assert.equal(summary.gradedBoth, 5)
  // Nothing here is on the exclusion list, so scored and raw agree exactly —
  // which is the state every population outside `psf/requests` is in.
  assert.equal(summary.scoredPopulation, 8)
  assert.equal(summary.scoredBoth, 5)
  assert.deepEqual(summary.excluded, [])
  assert.deepEqual(summary.rawAgreement, summary.agreement)
  assert.deepEqual(summary.agreement.both, ["both__x-1"])
  assert.deepEqual(summary.agreement.flowsOnly, ["flowsonly__x-2"])
  assert.deepEqual(summary.agreement.codexOnly, ["codexonly__x-3", "empty__x-5"])
  assert.deepEqual(summary.agreement.neither, ["neither__x-4"])

  // The three instances outside the table are named, with the side they failed on.
  assert.deepEqual(summary.ungraded.flows, [{ id: "ourfault__x-6", verdict: "eval error" }])
  assert.deepEqual(summary.ungraded.codex, [
    { id: "theirfault__x-7", verdict: "eval error" },
    { id: "notrun__x-8", verdict: "not run" }
  ])
  // An `eval error` on our side did not become a codex-only win, and one on
  // theirs did not become a flows-only win.
  assert.ok(!summary.agreement.codexOnly.includes("ourfault__x-6"))
  assert.ok(!summary.agreement.flowsOnly.includes("theirfault__x-7"))

  assert.equal(summary.coverage.flows, 7)
  assert.equal(summary.coverage.codex, 6)
  assert.equal(summary.superset.met, false)
  assert.equal(summary.superset.provisional, true)

  const markdown = render(summary)
  assert.match(markdown, /Population: 8 scored of 8 run/)
  assert.match(markdown, /Graded by both arms: 5 scored of 5 run\./)
  assert.match(markdown, /Fails on the graded subset/)
  assert.match(markdown, /provisional in both directions/)
  assert.match(markdown, /\| ourfault__x-6 \| flows \| eval error \|/)
  assert.match(markdown, /\| notrun__x-8 \| codex \| not run \|/)

  // A complete pair where flows contains codex: the goal holds, unqualified.
  const cleanCodex = jsonl(join(temporary, "codex-clean.jsonl"), [
    codexRow("both__x-1", "resolved"),
    codexRow("flowsonly__x-2", "unresolved"),
    codexRow("codexonly__x-3", "unresolved"),
    codexRow("neither__x-4", "unresolved"),
    codexRow("empty__x-5", "unresolved"),
    codexRow("ourfault__x-6", "unresolved"),
    codexRow("theirfault__x-7", "resolved"),
    codexRow("notrun__x-8", "resolved")
  ])
  const cleanFlows = jsonl(join(temporary, "flows-clean.jsonl"), [
    ...flowsRows("both__x-1", "resolved"),
    ...flowsRows("flowsonly__x-2", "resolved"),
    ...flowsRows("codexonly__x-3", "unresolved"),
    ...flowsRows("neither__x-4", "unresolved"),
    ...flowsRows("empty__x-5", "unresolved"),
    ...flowsRows("ourfault__x-6", "resolved"),
    ...flowsRows("theirfault__x-7", "resolved"),
    ...flowsRows("notrun__x-8", "resolved")
  ])
  const clean = compareArms({ manifestPath: cleanFlows, codexManifestPath: cleanCodex })
  assert.equal(clean.gradedBoth, 8)
  assert.equal(clean.superset.met, true)
  assert.equal(clean.superset.provisional, false)
  assert.match(render(clean), /Holds on the graded subset/)
  assert.ok(!render(clean).includes("provisional"))

  // -----------------------------------------------------------------------
  // The exclusion, with a real name from `lib/excluded.mjs`, on each side.
  // -----------------------------------------------------------------------
  const [excludedId, excludedEntry] = [...EXCLUDED.entries()][0]
  assert.ok(typeof excludedEntry.cause === "string" && excludedEntry.cause.length > 40, "an exclusion needs a cause")

  // The excluded instance resolves for codex and not for flows: without the
  // exclusion it is a codex-only cell, which is the cell the superset goal
  // turns on.
  const excludedFlows = jsonl(join(temporary, "flows-excluded.jsonl"), [
    ...flowsRows("both__x-1", "resolved"),
    ...flowsRows(excludedId, "unresolved")
  ])
  const excludedCodex = jsonl(join(temporary, "codex-excluded.jsonl"), [
    codexRow("both__x-1", "resolved"),
    codexRow(excludedId, "resolved")
  ])
  const scoped = compareArms({ manifestPath: excludedFlows, codexManifestPath: excludedCodex })
  assert.equal(scoped.population, 2)
  assert.equal(scoped.scoredPopulation, 1)
  assert.equal(scoped.gradedBoth, 2)
  assert.equal(scoped.scoredBoth, 1)
  assert.deepEqual(scoped.excluded.map((row) => row.id), [excludedId])
  // Gone from the scored table, still counted in the raw one. Both are on the
  // record, so nothing is hidden by the exclusion.
  assert.deepEqual(scoped.agreement.codexOnly, [])
  assert.deepEqual(scoped.rawAgreement.codexOnly, [excludedId])
  assert.equal(scoped.superset.met, true)

  const scopedMarkdown = render(scoped)
  assert.match(scopedMarkdown, /Population: 1 scored of 2 run/)
  assert.match(scopedMarkdown, /Graded by both arms: 1 scored of 2 run\./)
  assert.match(scopedMarkdown, /Excluded from the scoreboard, by name/)
  assert.ok(scopedMarkdown.includes(excludedEntry.cause), "the documented cause is printed")
  assert.ok(scopedMarkdown.includes(`| ${excludedId} **excluded** |`), "the per-instance row is marked")
  // The raw column is still there and still says 1, which is what makes this
  // scoping rather than deletion.
  assert.match(scopedMarkdown, /\| \*\*codex only\*\* \| 0 \| 1 \|/)

  // The mirror case: the same id resolving for flows and not codex. It leaves
  // the flows-only cell by exactly the same rule.
  const mirrored = compareArms({
    manifestPath: jsonl(join(temporary, "flows-mirror.jsonl"), [
      ...flowsRows("both__x-1", "resolved"),
      ...flowsRows(excludedId, "resolved")
    ]),
    codexManifestPath: jsonl(join(temporary, "codex-mirror.jsonl"), [
      codexRow("both__x-1", "resolved"),
      codexRow(excludedId, "unresolved")
    ])
  })
  assert.deepEqual(mirrored.agreement.flowsOnly, [])
  assert.deepEqual(mirrored.rawAgreement.flowsOnly, [excludedId])

  // -----------------------------------------------------------------------
  // The CLI writes both artifacts, and twice over one pair is the same bytes.
  // -----------------------------------------------------------------------
  const out = join(temporary, "out")
  mkdirSync(out, { recursive: true })
  const run = () =>
    spawnSync(process.execPath, [
      join(root, "compare-arms.mjs"),
      "--manifest",
      flows,
      "--codex-manifest",
      codex,
      "--out",
      out
    ], { encoding: "utf8" })
  const first = run()
  assert.equal(first.status, 0, first.stderr)
  assert.match(first.stdout, /both 1, flows-only 1, codex-only 2, neither 1/)
  assert.match(first.stdout, /8 scored of 8 run/)
  const once = readFileSync(join(out, "arms.md"), "utf8")
  assert.equal(once, (run(), readFileSync(join(out, "arms.md"), "utf8")))

  const missing = spawnSync(process.execPath, [
    join(root, "compare-arms.mjs"),
    "--manifest",
    join(temporary, "nope.jsonl")
  ], { encoding: "utf8" })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /no flows ledger/)

  console.log(
    "check-compare-arms: an eval error is never a loss, an empty patch always is, coverage precedes the rate,"
      + " and an exclusion leaves both arms with both denominators printed."
  )
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
