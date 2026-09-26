/**
 * Three ledgers over one population: the baseline, a re-run, and a re-run of
 * the re-run.
 *
 *   node three-way.mjs --baseline f --first f --second f [--out dir] [--json]
 *
 * `compare-runs.mjs` answers "did this change help", which is a question about
 * two ledgers. A programme that has already been measured once asks a different
 * one: a wave lands, its report says what regressed, a surgical change answers
 * that report, and the second wave has to be read against *both* — against the
 * baseline, which is what "did we get back to where we were" means, and against
 * the wave in between, which is what "did the surgery act" means. Reading it
 * against only one of them is how a recovery gets reported as a win, or a
 * remaining regression gets lost behind a large improvement.
 *
 * So this composes `compare-runs.mjs` twice rather than recomputing anything:
 * baseline-against-second and first-against-second, keyed by instance. Every
 * number here comes out of that module's `compare`, and the fold, the
 * every-attempt cost rule and the two labelled wall clocks are all its own.
 * What is added is the shape — three columns instead of two — and the two
 * questions that only exist with three ledgers:
 *
 * **What the middle wave lost and this one got back**, which is the surgery's
 * own scoreboard: an instance the baseline resolved, the first re-run did not,
 * and the second does.
 *
 * **What is still lost**, which is what the next report has to answer for. An
 * instance no wave has resolved since the baseline is not a regression the
 * middle wave introduced; it is one this wave did not fix.
 *
 * The exclusion rule comes with the fold: `compare-runs.mjs` computes the
 * scored totals and the raw ones side by side, so every column here states
 * both. An instance `lib/excluded.mjs` names is still shown per instance and
 * still marked; it is outside the three totals rows and outside the recovered,
 * still-lost, newly-lost and gained sets, because a verdict decided by a
 * grading environment is not a verdict any of those four is about.
 *
 * It reads three ledgers and nothing else: no evaluator report, no journal, no
 * clock, no network.
 *
 * @since 0.1.0
 */
import { existsSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { compare } from "./compare-runs.mjs"
import { isExcluded, renderExclusions } from "./lib/excluded.mjs"

const money = (usd) => `$${usd.toFixed(2)}`
const signed = (value) => `${value < 0 ? "-" : "+"}${Math.abs(value).toFixed(2)}`

/** How one instance reads in a column, or an em dash where a wave has no row. */
const cell = (facts) => (facts === undefined ? "—" : facts.resolved ? "resolved" : facts.verdict)

/**
 * Folds two pairwise comparisons into one row per instance.
 *
 * @category conversions
 * @since 0.1.0
 */
export const threeWay = ({ baselinePath, firstPath, secondPath }) => {
  const againstBaseline = compare({ baselinePath, rerunPath: secondPath })
  const againstFirst = compare({ baselinePath: firstPath, rerunPath: secondPath })

  // The first re-run's own facts are the `before` side of the second
  // comparison, which is the same fold `compare-runs.mjs` applies to every
  // ledger — so the middle column is never derived a second way.
  const middle = new Map(againstFirst.instances.map((row) => [row.id, row.before]))

  const rows = againstBaseline.instances.map((row) => ({
    id: row.id,
    baseline: row.before,
    first: middle.get(row.id),
    second: row.after,
    pending: row.pending,
    delta: row.delta,
    deltaFromFirst: againstFirst.instances.find((one) => one.id === row.id)?.delta
  }))

  const done = rows.filter((row) => !row.pending && row.first !== undefined && !isExcluded(row.id))
  const isResolved = (facts) => facts !== undefined && facts.resolved
  return {
    baselinePath,
    firstPath,
    secondPath,
    population: againstBaseline.population,
    comparedCount: againstBaseline.comparedCount,
    pending: againstBaseline.pending,
    scoredCount: againstBaseline.scoredCount,
    excluded: againstBaseline.excluded,
    totals: {
      baseline: againstBaseline.totals.scored.baseline,
      first: againstFirst.totals.scored.baseline,
      second: againstBaseline.totals.scored.rerun
    },
    rawTotals: {
      baseline: againstBaseline.totals.compared.baseline,
      first: againstFirst.totals.compared.baseline,
      second: againstBaseline.totals.compared.rerun
    },
    // The surgery's own scoreboard: what the middle wave dropped and this one
    // holds again, and what is still on the floor.
    recovered: done
      .filter((row) => isResolved(row.baseline) && !isResolved(row.first) && isResolved(row.second))
      .map((row) => row.id),
    stillLost: done
      .filter((row) => isResolved(row.baseline) && !isResolved(row.second))
      .map((row) => row.id),
    newlyLost: done
      .filter((row) => isResolved(row.first) && !isResolved(row.second) && !isResolved(row.baseline))
      .map((row) => row.id),
    gainedOverBaseline: done
      .filter((row) => !isResolved(row.baseline) && isResolved(row.second))
      .map((row) => row.id),
    rows
  }
}

/**
 * Renders the three columns as markdown.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (summary, names = { baseline: "baseline", first: "first", second: "second" }) => {
  const lines = []
  const { baseline, first, second } = summary.totals
  const raw = summary.rawTotals
  lines.push("# Three ledgers, one population")
  lines.push("")
  lines.push(`${names.baseline}: \`${summary.baselinePath}\``)
  lines.push(`${names.first}: \`${summary.firstPath}\``)
  lines.push(`${names.second}: \`${summary.secondPath}\``)
  lines.push("")
  lines.push(
    `${summary.comparedCount} of ${summary.population} instances compared`
      + (summary.pending > 0 ? `; ${summary.pending} not re-run yet` : "")
  )
  if (summary.excluded.length > 0) {
    lines.push(
      `Scored: ${summary.scoredCount} of ${summary.comparedCount} run.`
        + ` Excluded by name, for every arm and every column:`
        + ` ${summary.excluded.map((row) => row.id).join(", ")}.`
    )
  }
  lines.push("")
  lines.push(`| | ${names.baseline} | ${names.first} | ${names.second} |`)
  lines.push("| --- | ---: | ---: | ---: |")
  lines.push(
    `| resolved | ${baseline.resolved}/${baseline.instances} | ${first.resolved}/${first.instances}`
      + ` | ${second.resolved}/${second.instances} |`
  )
  lines.push(
    `| resolved (raw) | ${raw.baseline.resolved}/${raw.baseline.instances}`
      + ` | ${raw.first.resolved}/${raw.first.instances}`
      + ` | ${raw.second.resolved}/${raw.second.instances} |`
  )
  lines.push(`| total cost | ${money(baseline.usd)} | ${money(first.usd)} | ${money(second.usd)} |`)
  lines.push(
    `| total cost (raw) | ${money(raw.baseline.usd)} | ${money(raw.first.usd)} | ${money(raw.second.usd)} |`
  )
  lines.push(`| agent wall | ${baseline.agentSeconds} s | ${first.agentSeconds} s | ${second.agentSeconds} s |`)
  lines.push(
    `| instance wall | ${baseline.wallSeconds} s | ${first.wallSeconds} s | ${second.wallSeconds} s |`
  )
  lines.push(`| frames | ${baseline.frames} | ${first.frames} | ${second.frames} |`)
  lines.push("")
  lines.push(`- recovered (${summary.recovered.length}): ${summary.recovered.join(", ") || "—"}`)
  lines.push(`- still lost (${summary.stillLost.length}): ${summary.stillLost.join(", ") || "—"}`)
  lines.push(`- newly lost (${summary.newlyLost.length}): ${summary.newlyLost.join(", ") || "—"}`)
  lines.push(
    `- gained over ${names.baseline} (${summary.gainedOverBaseline.length}):`
      + ` ${summary.gainedOverBaseline.join(", ") || "—"}`
  )
  lines.push(...renderExclusions(summary.excluded))
  lines.push("")
  lines.push("## Per instance")
  lines.push("")
  lines.push(
    `| instance | ${names.baseline} | ${names.first} | ${names.second}`
      + ` | $ ${names.baseline} | $ ${names.first} | $ ${names.second} | Δ$ vs ${names.baseline}`
      + ` | frames | agent s |`
  )
  lines.push("| --- | --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |")
  for (const row of summary.rows) {
    if (row.pending || row.first === undefined) {
      lines.push(
        `| ${row.id} | ${cell(row.baseline)} | ${cell(row.first)} | not re-run`
          + ` | ${money(row.baseline.usd)} | ${row.first === undefined ? "—" : money(row.first.usd)}`
          + ` | — | — | — | — |`
      )
      continue
    }
    lines.push(
      `| ${row.id}${isExcluded(row.id) ? " **excluded**" : ""}`
        + ` | ${cell(row.baseline)} | ${cell(row.first)} | ${cell(row.second)}`
        + ` | ${money(row.baseline.usd)} | ${money(row.first.usd)} | ${money(row.second.usd)}`
        + ` | ${signed(row.delta.usd)}`
        + ` | ${row.baseline.frames} → ${row.first.frames} → ${row.second.frames}`
        + ` | ${row.baseline.agentSeconds} → ${row.first.agentSeconds} → ${row.second.agentSeconds} |`
    )
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}

const optionValue = (argv, flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}

const main = () => {
  const argv = process.argv.slice(2)
  const baselinePath = optionValue(argv, "--baseline")
  const firstPath = optionValue(argv, "--first")
  const secondPath = optionValue(argv, "--second")
  for (const [flag, path] of [["--baseline", baselinePath], ["--first", firstPath], ["--second", secondPath]]) {
    if (path === undefined) {
      console.error(`three-way.mjs: ${flag} is required`)
      process.exit(2)
    }
    if (!existsSync(path)) {
      console.error(`three-way.mjs: no ledger at ${path}`)
      process.exit(1)
    }
  }
  const names = {
    baseline: optionValue(argv, "--baseline-name", "baseline"),
    first: optionValue(argv, "--first-name", "first"),
    second: optionValue(argv, "--second-name", "second")
  }
  const summary = threeWay({ baselinePath, firstPath, secondPath })
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`)
    return
  }
  const out = optionValue(argv, "--out", dirname(secondPath))
  writeFileSync(join(out, "three-way.json"), `${JSON.stringify(summary, undefined, 2)}\n`)
  writeFileSync(join(out, "three-way.md"), render(summary, names))
  process.stdout.write(
    `three-way.mjs: ${summary.scoredCount} scored of ${summary.comparedCount} run of ${summary.population}, resolved `
      + `${summary.totals.baseline.resolved} -> ${summary.totals.first.resolved} -> ${summary.totals.second.resolved} `
      + `(raw ${summary.rawTotals.baseline.resolved} -> ${summary.rawTotals.first.resolved} -> `
      + `${summary.rawTotals.second.resolved}), `
      + `cost ${money(summary.totals.baseline.usd)} -> ${money(summary.totals.first.usd)} -> `
      + `${money(summary.totals.second.usd)}\n`
  )
  process.stdout.write(`  wrote ${join(out, "three-way.md")}\n`)
}

if (import.meta.filename === process.argv[1]) main()
