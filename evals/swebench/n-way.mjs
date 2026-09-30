/**
 * Any number of ledgers over one population.
 *
 *   node n-way.mjs --wave r90=f --wave r91=f --wave r92=f --wave r93=f [--out dir] [--json]
 *
 * `compare-runs.mjs` answers "did this change help", which is a question about
 * two ledgers, and `three-way.mjs` answers "did the surgery act", which needs
 * the wave in between. A programme measured a fourth time needs neither shape:
 * it needs every wave in one table, because the reason to keep the earlier
 * columns is that a number only means something beside the ones before it — a
 * recovery reads as a win without the middle column, and a cost that halved
 * twice reads as a plateau without the first.
 *
 * So this is `three-way.mjs` with the arity taken out. The first `--wave` is
 * the baseline every other wave is compared against, and every column is
 * `compare-runs.mjs`'s own fold of that wave's ledger: one rule applied as many
 * times as there are waves, rather than one report quoting another. Nothing is
 * recomputed here — not the every-attempt cost rule, not the two labelled wall
 * clocks, not the exclusion.
 *
 * The exclusion rule comes with that fold. Every total is stated twice, scored
 * and raw, because `lib/excluded.mjs` §3 says a rate over a population an
 * exclusion can reach is never printed alone. An excluded instance still shows
 * per instance and still carries its mark; it is outside the totals and outside
 * the movement sets, because a verdict decided by a grading environment is not
 * a verdict any of them is about.
 *
 * Three movement sets, each about the last wave in the list:
 *
 * - **recovered** — the baseline resolved it, at least one wave since did not,
 *   and the last one does.
 * - **still lost** — the baseline resolved it and the last wave does not. This
 *   is the set the next report has to answer for.
 * - **gained** — the baseline did not resolve it and the last wave does.
 *
 * It reads ledgers and nothing else: no evaluator report, no journal, no clock,
 * no network.
 *
 * @since 0.1.0
 */
import { existsSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { compare, money, signed } from "./compare-runs.mjs"
import { isExcluded, renderExclusions } from "./lib/excluded.mjs"

/** How one instance reads in a column, or an em dash where a wave has no row. */
const cell = (facts) => (facts === undefined ? "—" : facts.resolved ? "resolved" : facts.verdict)

/**
 * Folds one baseline and any number of later waves into one row per instance.
 *
 * @category conversions
 * @since 0.1.0
 */
export const nWay = (waves) => {
  const [baseline, ...rest] = waves
  // Every later wave is compared against the same baseline, so each column's
  // `rerun` side is that wave's own fold and the repeated `baseline` side is
  // the same numbers every time — which is the check that the columns are one
  // rule rather than several.
  const comparisons = rest.map((wave) => ({
    wave,
    summary: compare({ baselinePath: baseline.path, rerunPath: wave.path })
  }))
  const last = comparisons[comparisons.length - 1]

  const facts = new Map()
  facts.set(baseline.name, new Map(last.summary.instances.map((row) => [row.id, row.before])))
  for (const one of comparisons) {
    facts.set(one.wave.name, new Map(one.summary.instances.map((row) => [row.id, row.after])))
  }

  const totals = { [baseline.name]: last.summary.totals.scored.baseline }
  const rawTotals = { [baseline.name]: last.summary.totals.compared.baseline }
  for (const one of comparisons) {
    totals[one.wave.name] = one.summary.totals.scored.rerun
    rawTotals[one.wave.name] = one.summary.totals.compared.rerun
  }

  const names = [baseline.name, ...rest.map((one) => one.name)]
  const rows = last.summary.instances.map((row) => ({
    id: row.id,
    pending: row.pending,
    excluded: isExcluded(row.id),
    columns: Object.fromEntries(names.map((name) => [name, facts.get(name)?.get(row.id)])),
    delta: row.delta
  }))

  const isResolved = (name, id) => facts.get(name)?.get(id)?.resolved === true
  const middle = names.slice(1, -1)
  const finalName = names[names.length - 1]
  const done = rows.filter((row) => !row.pending && !row.excluded)
  return {
    waves: waves.map((one) => ({ name: one.name, path: one.path })),
    population: last.summary.population,
    comparedCount: last.summary.comparedCount,
    scoredCount: last.summary.scoredCount,
    pending: last.summary.pending,
    excluded: last.summary.excluded,
    totals,
    rawTotals,
    recovered: done
      .filter((row) =>
        isResolved(baseline.name, row.id) && isResolved(finalName, row.id)
        && middle.some((name) => !isResolved(name, row.id))
      )
      .map((row) => row.id),
    stillLost: done
      .filter((row) => isResolved(baseline.name, row.id) && !isResolved(finalName, row.id))
      .map((row) => row.id),
    gained: done
      .filter((row) => !isResolved(baseline.name, row.id) && isResolved(finalName, row.id))
      .map((row) => row.id),
    rows
  }
}

/**
 * Renders the columns as markdown.
 *
 * @category rendering
 * @since 0.1.0
 */
export const render = (summary) => {
  const names = summary.waves.map((one) => one.name)
  const lines = []
  lines.push(`# ${names.length} ledgers, one population`)
  lines.push("")
  for (const wave of summary.waves) lines.push(`${wave.name}: \`${wave.path}\``)
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
  lines.push(`| | ${names.join(" | ")} |`)
  lines.push(`| --- |${names.map(() => " ---: |").join("")}`)
  const row = (label, of) => lines.push(`| ${label} | ${names.map(of).join(" | ")} |`)
  row("resolved", (name) => `${summary.totals[name].resolved}/${summary.totals[name].instances}`)
  row("resolved (raw)", (name) => `${summary.rawTotals[name].resolved}/${summary.rawTotals[name].instances}`)
  row("total cost", (name) => money(summary.totals[name].usd))
  row("total cost (raw)", (name) => money(summary.rawTotals[name].usd))
  row("agent wall", (name) => `${summary.totals[name].agentSeconds} s`)
  row("instance wall", (name) => `${summary.totals[name].wallSeconds} s`)
  row("frames", (name) => `${summary.totals[name].frames}`)
  lines.push("")
  lines.push(`- recovered (${summary.recovered.length}): ${summary.recovered.join(", ") || "—"}`)
  lines.push(`- still lost (${summary.stillLost.length}): ${summary.stillLost.join(", ") || "—"}`)
  lines.push(`- gained (${summary.gained.length}): ${summary.gained.join(", ") || "—"}`)
  lines.push(...renderExclusions(summary.excluded))
  lines.push("")
  lines.push("## Per instance")
  lines.push("")
  lines.push(
    `| instance | ${names.join(" | ")} | ${names.map((name) => `$ ${name}`).join(" | ")}`
      + ` | Δ$ vs ${names[0]} | frames | agent s |`
  )
  lines.push(`| --- |${names.map(() => " --- |").join("")}${names.map(() => " ---: |").join("")} ---: | ---: | ---: |`)
  for (const one of summary.rows) {
    const columns = names.map((name) => one.columns[name])
    const dollars = columns.map((facts) => (facts === undefined ? "—" : money(facts.usd)))
    lines.push(
      `| ${one.id}${one.excluded ? " **excluded**" : ""}`
        + ` | ${columns.map(cell).join(" | ")}`
        + ` | ${dollars.join(" | ")}`
        + ` | ${one.pending ? "—" : signed(one.delta.usd)}`
        + ` | ${columns.map((facts) => facts?.frames ?? "—").join(" → ")}`
        + ` | ${columns.map((facts) => facts?.agentSeconds ?? "—").join(" → ")} |`
    )
  }
  lines.push("")
  return `${lines.join("\n")}\n`
}

const main = () => {
  const argv = process.argv.slice(2)
  const waves = []
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--wave") continue
    const declaration = argv[index + 1]
    const split = declaration === undefined ? -1 : declaration.indexOf("=")
    if (split <= 0) {
      console.error("n-way.mjs: --wave takes name=path")
      process.exit(2)
    }
    waves.push({ name: declaration.slice(0, split), path: declaration.slice(split + 1) })
  }
  if (waves.length < 2) {
    console.error("n-way.mjs: pass at least two --wave name=path; the first is the baseline")
    process.exit(2)
  }
  for (const wave of waves) {
    if (!existsSync(wave.path)) {
      console.error(`n-way.mjs: no ledger at ${wave.path}`)
      process.exit(1)
    }
  }
  const summary = nWay(waves)
  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(summary, undefined, 2)}\n`)
    return
  }
  const outIndex = argv.indexOf("--out")
  const out = outIndex === -1 ? dirname(waves[waves.length - 1].path) : argv[outIndex + 1]
  writeFileSync(join(out, "n-way.json"), `${JSON.stringify(summary, undefined, 2)}\n`)
  writeFileSync(join(out, "n-way.md"), render(summary))
  const names = summary.waves.map((one) => one.name)
  process.stdout.write(
    `n-way.mjs: ${summary.scoredCount} scored of ${summary.comparedCount} run of ${summary.population}, resolved `
      + `${names.map((name) => summary.totals[name].resolved).join(" -> ")} `
      + `(raw ${names.map((name) => summary.rawTotals[name].resolved).join(" -> ")}), `
      + `cost ${names.map((name) => money(summary.totals[name].usd)).join(" -> ")}\n`
  )
  process.stdout.write(`  wrote ${join(out, "n-way.md")}\n`)
}

if (import.meta.filename === process.argv[1]) main()
