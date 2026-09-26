/**
 * Reports a best-of-n matrix: reliability, best-of-n, and selector quality.
 *
 *   node matrix-report.mjs --prefix w12 [--count 5]
 *
 * Reads the official evaluator's own reports — one per round per side, plus one
 * for the selected patches — and the selection rationales the selector wrote
 * before any of them existed. Writes `matrix-report.json` and
 * `matrix-report.md`.
 *
 * Four things it reports, and the disclosure each one owes:
 *
 * 1. **The reliability matrix.** Every instance's n verdicts on each side. It is
 *    the number the single-attempt waves could not produce: a wave that resolves
 *    four of five once has said nothing about whether it resolves them again.
 * 2. **Best-of-n, both sides.** The two are *not* computed the same way and the
 *    report says so on every line that carries them. The flows column is the
 *    verdict of the patch its own journal-only selector chose before grading —
 *    a number the harness could produce in production. The codex column is the
 *    best verdict any of the n earned — `resolved` whenever one of them did —
 *    which is an **oracle**: it is chosen by the grader, no codex run could pick
 *    it, and it is an upper bound on what a codex best-of-n would score.
 *    Reporting them side by side without that sentence would be claiming a win
 *    the measurement does not support.
 * 3. **Selector quality.** Of the instances where at least one flows run
 *    resolved, how often the selector picked a resolving run. This is the flows
 *    column's own oracle gap: `hit` where the selector matched what an oracle
 *    would have taken, `miss` where a resolving patch was available and the
 *    selector took another.
 * 4. **Single attempt.** The r1 column on both sides, which is the same
 *    measurement waves 3 to 11 reported, so the matrix can be read against them.
 *
 * Nothing here spends tokens or needs docker: it is a projection of artifacts a
 * matrix already produced.
 *
 * @since 0.1.0
 */
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))

const flag = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`)
  return index < 0 ? fallback : process.argv[index + 1] ?? fallback
}

const options = {
  prefix: flag("prefix", ""),
  count: Number(flag("count", "5")),
  reports: resolve(here, flag("reports", ".")),
  selected: resolve(here, flag("selected", "selected")),
  patches: resolve(here, flag("patches", "patches")),
  patchesCodex: resolve(here, flag("patches-codex", "patches-codex")),
  sample: resolve(here, flag("sample", "sample.json")),
  out: resolve(here, flag("out", "."))
}
const instancesFlag = flag("instances", "")

if (options.prefix === "") {
  console.error("matrix-report.mjs: --prefix names the run ids grade-matrix.sh wrote")
  process.exit(2)
}
if (!Number.isInteger(options.count) || options.count < 1) {
  console.error("matrix-report.mjs: --count must be a positive integer")
  process.exit(2)
}

const readJson = (path, fallback) => {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return fallback
  }
}

const instances = instancesFlag !== ""
  ? instancesFlag.split(",").map((id) => id.trim()).filter((id) => id !== "")
  : (readJson(options.sample, { instances: [] }).instances ?? []).slice(0, Number(flag("sample-count", "5")))

if (instances.length === 0) {
  console.error("matrix-report.mjs: no instances — pass --instances or bootstrap the sample")
  process.exit(2)
}

/**
 * One evaluator report, read as a verdict per instance.
 *
 * A report that is not there is `not graded`, which is not the same as an empty
 * patch: the first says nobody asked, the second says the run produced nothing.
 */
const verdictsOf = (model, runId) => {
  const path = join(options.reports, `${model}.${runId}.json`)
  if (!existsSync(path)) return undefined
  const report = readJson(path, undefined)
  if (report === undefined) return undefined
  const verdicts = {}
  for (const id of report.resolved_ids ?? []) verdicts[id] = "resolved"
  for (const id of report.unresolved_ids ?? []) verdicts[id] = "unresolved"
  for (const id of report.empty_patch_ids ?? []) verdicts[id] = "empty patch"
  for (const id of report.error_ids ?? []) verdicts[id] = "eval error"
  return verdicts
}

const rounds = Array.from({ length: options.count }, (unused, index) => `r${index + 1}`)
const flowsRounds = rounds.map((round) => verdictsOf("flows-cell-harness", `${options.prefix}-flows-${round}`))
const codexRounds = rounds.map((round) => verdictsOf("codex-cli", `${options.prefix}-codex-${round}`))
const selectedVerdicts = verdictsOf("flows-cell-harness", `${options.prefix}-selected`)

const bytesOf = (path) => existsSync(path) ? statSync(path).size : 0

const cell = (report, id) => report === undefined ? "not graded" : report[id] ?? "not graded"

/**
 * Verdicts from best to worst, for the one column that is allowed to pick.
 *
 * The codex best-of-n column is an oracle: it reports what the best of the n
 * runs did. Reading only "did any resolve" and falling back to r1 otherwise
 * would print `empty` for a side whose other four rounds all produced a real
 * patch, which understates the baseline in the harness's favour on the line
 * that compares them. The oracle takes the best verdict any round earned.
 */
const verdictRank = ["resolved", "unresolved", "empty patch", "eval error", "not graded"]
const best = (verdicts) =>
  verdicts.reduce(
    (kept, verdict) => verdictRank.indexOf(verdict) < verdictRank.indexOf(kept) ? verdict : kept,
    "not graded"
  )

const rows = instances.map((id) => {
  const rationale = readJson(join(options.selected, `${id}.rationale.json`), undefined)
  const flows = flowsRounds.map((report) => cell(report, id))
  const codex = codexRounds.map((report) => cell(report, id))
  const anyFlowsResolved = flows.some((verdict) => verdict === "resolved")
  const selectedIndex = rationale?.selected
  const selectedRound = selectedIndex === undefined ? -1 : Number(selectedIndex.slice(1)) - 1
  const selectedRoundVerdict = selectedRound >= 0 && selectedRound < flows.length ? flows[selectedRound] : "not graded"
  const selectedVerdict = cell(selectedVerdicts, id)

  return {
    instance: id,
    flows,
    codex,
    singleAttempt: { flows: flows[0] ?? "not graded", codex: codex[0] ?? "not graded" },
    reliability: {
      flows: flows.filter((verdict) => verdict === "resolved").length,
      codex: codex.filter((verdict) => verdict === "resolved").length,
      of: options.count
    },
    selection: rationale === undefined ? undefined : {
      index: selectedIndex,
      runId: rationale.selectedRunId,
      score: rationale.candidates?.[0]?.score ?? null,
      candidates: rationale.candidates?.length ?? 0,
      // The chosen patch, graded twice: once in its own round and once in the
      // selected set. They must agree, and a report that finds they do not is
      // reading a patch that changed between the two gradings.
      roundVerdict: selectedRoundVerdict,
      agrees: selectedRoundVerdict === selectedVerdict || selectedRoundVerdict === "not graded"
    },
    bestOfN: {
      // The flows side is the verdict of the patch the harness's own selector
      // chose from journals alone. It is producible in production.
      flows: selectedVerdict,
      // The codex side is an oracle: the grader picks the best of the n after
      // grading them all. No codex run could make this choice.
      codexOracle: best(codex),
      codexOracleIsGenerous: true
    },
    selectorQuality: !anyFlowsResolved
      ? "n/a"
      : selectedVerdict === "resolved"
      ? "hit"
      : "miss",
    patchBytes: {
      flows: rounds.map((round) => bytesOf(join(options.patches, `${id}-${round}.patch`))),
      codex: rounds.map((round) => bytesOf(join(options.patchesCodex, `${id}-${round}.patch`))),
      selected: bytesOf(join(options.selected, `${id}.patch`))
    }
  }
})

const count = (predicate) => rows.filter(predicate).length
const totals = {
  instances: rows.length,
  runsPerInstance: options.count,
  singleAttempt: {
    flows: count((row) => row.singleAttempt.flows === "resolved"),
    codex: count((row) => row.singleAttempt.codex === "resolved")
  },
  bestOfN: {
    flowsSelected: count((row) => row.bestOfN.flows === "resolved"),
    codexOracle: count((row) => row.bestOfN.codexOracle === "resolved"),
    // The same oracle applied to the flows side, so the selector's cost is
    // visible as a number rather than only per instance.
    flowsOracle: count((row) => row.flows.some((verdict) => verdict === "resolved"))
  },
  reliability: {
    flowsResolvedRuns: rows.reduce((total, row) => total + row.reliability.flows, 0),
    codexResolvedRuns: rows.reduce((total, row) => total + row.reliability.codex, 0),
    runs: rows.length * options.count
  },
  selector: {
    hits: count((row) => row.selectorQuality === "hit"),
    misses: count((row) => row.selectorQuality === "miss"),
    notApplicable: count((row) => row.selectorQuality === "n/a"),
    disagreements: count((row) => row.selection !== undefined && !row.selection.agrees)
  }
}

const report = {
  prefix: options.prefix,
  generatedAt: null,
  runsPerInstance: options.count,
  instances,
  disclosure: {
    flowsBestOfN:
      "the verdict of the patch select-candidate.mjs chose from journals and patches alone, before grading; producible in production",
    codexBestOfN:
      "ORACLE, MORE GENEROUS: resolved when any of the n codex runs resolved. The grader makes this choice after grading; no codex run could make it. It is an upper bound on a codex best-of-n, not a measured one.",
    comparability:
      "the two best-of-n columns are not the same measurement and a comparison between them favours codex by exactly the selector's miss rate"
  },
  totals,
  rows
}

writeFileSync(join(options.out, "matrix-report.json"), `${JSON.stringify(report, null, 2)}\n`)

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const short = (verdict) =>
  verdict === "resolved"
    ? "RESOLVED"
    : verdict === "unresolved"
    ? "unresolved"
    : verdict === "empty patch"
    ? "empty"
    : verdict === "eval error"
    ? "eval error"
    : "—"

const lines = []
lines.push(`# Best-of-${options.count} matrix — \`${options.prefix}\``)
lines.push("")
lines.push(
  `${rows.length} instances, ${options.count} runs per instance per harness, `
    + `${totals.reliability.runs} runs a side.`
)
lines.push("")
lines.push("## Disclosure")
lines.push("")
lines.push(`- **flows best-of-${options.count}** — ${report.disclosure.flowsBestOfN}.`)
lines.push(`- **codex best-of-${options.count}** — ${report.disclosure.codexBestOfN}`)
lines.push(`- ${report.disclosure.comparability}.`)
lines.push("")
lines.push("## Reliability")
lines.push("")
lines.push(`| instance | ${rounds.map((round) => `flows ${round}`).join(" | ")} | flows n/${options.count} |`)
lines.push(`| --- | ${rounds.map(() => "---").join(" | ")} | --- |`)
for (const row of rows) {
  lines.push(
    `| \`${row.instance}\` | ${row.flows.map(short).join(" | ")} | ${row.reliability.flows}/${options.count} |`
  )
}
lines.push("")
lines.push(`| instance | ${rounds.map((round) => `codex ${round}`).join(" | ")} | codex n/${options.count} |`)
lines.push(`| --- | ${rounds.map(() => "---").join(" | ")} | --- |`)
for (const row of rows) {
  lines.push(
    `| \`${row.instance}\` | ${row.codex.map(short).join(" | ")} | ${row.reliability.codex}/${options.count} |`
  )
}
lines.push("")
lines.push("## Best-of-n, single attempt, and the selector")
lines.push("")
lines.push(
  `| instance | flows r1 | codex r1 | flows best-of-${options.count} (selected) `
    + `| codex best-of-${options.count} (ORACLE) | selected run | selector |`
)
lines.push("| --- | --- | --- | --- | --- | --- | --- |")
for (const row of rows) {
  lines.push(
    `| \`${row.instance}\` | ${short(row.singleAttempt.flows)} | ${short(row.singleAttempt.codex)} `
      + `| ${short(row.bestOfN.flows)} | ${short(row.bestOfN.codexOracle)} `
      + `| ${row.selection === undefined ? "—" : `${row.selection.index} (${row.selection.score}/4)`} `
      + `| ${row.selectorQuality} |`
  )
}
lines.push("")
lines.push("## Totals")
lines.push("")
lines.push(
  `- single attempt (r1): flows ${totals.singleAttempt.flows}/${rows.length}, codex ${totals.singleAttempt.codex}/${rows.length}`
)
lines.push(
  `- best-of-${options.count}: flows ${totals.bestOfN.flowsSelected}/${rows.length} (selected, pre-grading) `
    + `vs codex ${totals.bestOfN.codexOracle}/${rows.length} (ORACLE, more generous)`
)
lines.push(
  totals.bestOfN.flowsOracle === totals.bestOfN.flowsSelected
    ? `- the same oracle on the flows side would also be ${totals.bestOfN.flowsOracle}/${rows.length}, `
      + "so the selector cost nothing on this sample"
    : `- the same oracle on the flows side would be ${totals.bestOfN.flowsOracle}/${rows.length}; `
      + `the ${totals.bestOfN.flowsOracle - totals.bestOfN.flowsSelected} it gives up is the selector's cost`
)
lines.push(
  `- run-level reliability: flows ${totals.reliability.flowsResolvedRuns}/${totals.reliability.runs} runs resolved, `
    + `codex ${totals.reliability.codexResolvedRuns}/${totals.reliability.runs}`
)
lines.push(
  `- selector: ${totals.selector.hits} hit, ${totals.selector.misses} miss, `
    + `${totals.selector.notApplicable} with nothing to hit`
)
if (totals.selector.disagreements > 0) {
  lines.push(
    `- **${totals.selector.disagreements} instance(s) graded the selected patch differently from its own round** — `
      + "the same bytes were graded twice and disagreed, which is a rig fault, not a result"
  )
}
lines.push("")

writeFileSync(join(options.out, "matrix-report.md"), `${lines.join("\n")}\n`)
console.log(lines.join("\n"))
