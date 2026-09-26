/**
 * The full benchmark's running scoreboard, and the checkpoint that appends to
 * its progress log.
 *
 *   node fullbench-report.mjs [--checkpoint] [--manifest f] [--dataset f]
 *                             [--sample f] [--out dir] [--now ms] [--free-mib n]
 *   node fullbench-report.mjs --spend-cents [--manifest f]
 *
 * Everything here is read off `fullbench/manifest.jsonl` and the dataset. It
 * never reads the evaluator's own report files, never re-grades anything, and
 * has no state of its own: running it twice over the same ledger produces the
 * same bytes, which is what makes `fixtures/check-fullbench-report.mjs` able to
 * pin it.
 *
 * Four things it computes that are worth stating outright:
 *
 * - **The resolve rate carries a 95% Wilson interval.** At 25 of 500 graded, 8
 *   resolved is a rate somewhere between 17% and 52%, and a checkpoint that
 *   prints "32%" without that width invites a conclusion the sample cannot
 *   support. Wilson rather than the normal approximation because the interval
 *   has to behave at 0 and at small n, which is exactly where the early
 *   checkpoints are.
 * - **The projected finish comes in two numbers, both labelled.** "Observed" is
 *   the wall clock the ledger actually spans divided by what completed in it,
 *   so it includes every hour the driver was stopped, paused or waiting on
 *   disk. "Modelled" is the mean instance wall divided by the concurrency,
 *   which is what the run would do if nothing ever stopped it. The truth is
 *   between them and the report does not pretend to pick.
 * - **Both denominators travel together.** `lib/excluded.mjs` names the
 *   instances whose verdicts are statements about the grading environment
 *   rather than about a harness. This is a scoreboard over the same ledgers
 *   `compare-runs.mjs` reads, so it obeys the same rule they do: the rate is
 *   over the scored population and every sentence carrying it also carries the
 *   raw count. When a population excludes nothing the numbers are identical and
 *   the report reads exactly as it did before.
 * - **The prefix is a random sample.** Instances run in the seeded draw order,
 *   so the first *k* graded are a uniform draw from the 500 and extrapolating
 *   from them is sound. In dataset order it would not be — the first 231 rows
 *   are django — and the extrapolation lines say which order produced them.
 *
 * `--now` and `--free-mib` exist so the fixture can pin an ETA and a disk
 * figure. Without them this reads the wall clock and shells out to
 * `lib/disk-free.sh`, which is fine here: this is a rig script, not repository
 * code, and the ambient-clock rule the packages follow is about the harness.
 */
import { execFileSync } from "node:child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { denominatorLabel, denominators, renderExclusions } from "./lib/excluded.mjs"
import { formatMoney as money } from "./lib/format-money.mjs"
import { read, readRows } from "./lib/fullbench-manifest.mjs"
import { usd } from "./prices.ts"

const rigRoot = import.meta.dirname

// A grade can carry the cost when the ran row did not. It describes the same
// attempt, while pulled and subsequent ran rows start new attempts.
const costAttempts = (rows) => {
  const attempts = []
  const current = new Map()
  for (const row of rows) {
    if (row.kind !== "instance") continue
    if (row.state === "pulled") current.delete(row.id)
    if (row.state !== "ran" && row.state !== "graded") continue
    if (row.state === "ran" || !current.has(row.id)) {
      const attempt = { ...row }
      attempts.push(attempt)
      current.set(row.id, attempt)
    } else if (row.cost !== undefined) {
      current.get(row.id).cost = row.cost
    }
  }
  return attempts
}

/**
 * All attempts' spend, retaining unknown costs instead of treating them as zero.
 *
 * @category conversions
 * @since 0.1.0
 */
export const spendByInstance = (ledger) => {
  let dollars = 0
  let unknownAttempts = 0
  for (const { cost } of costAttempts(ledger.rows)) {
    if (cost?.unknown === true || !Number.isFinite(cost?.usd) || cost.usd < 0) unknownAttempts += 1
    else dollars += cost.usd
  }
  // Round only after summing: many sub-cent attempts are still real spend.
  return { cents: Math.round(dollars * 100), unknownAttempts }
}

/**
 * The 95% Wilson score interval for `successes` out of `total`.
 *
 * @category conversions
 * @since 0.1.0
 */
export const wilson = (successes, total, z = 1.959963984540054) => {
  if (total === 0) return { low: 0, high: 1, point: 0 }
  const p = successes / total
  const denominator = 1 + (z * z) / total
  const centre = (p + (z * z) / (2 * total)) / denominator
  const half = (z * Math.sqrt((p * (1 - p)) / total + (z * z) / (4 * total * total))) / denominator
  return { point: p, low: Math.max(0, centre - half), high: Math.min(1, centre + half) }
}

const percent = (value) => `${(value * 100).toFixed(1)}%`

const duration = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace(".000", "") : "—")

/**
 * Everything the report says, as data.
 *
 * @category conversions
 * @since 0.1.0
 */
export const summarise = (options) => {
  const manifest = read(options.manifest)
  const dataset = options.dataset !== undefined && existsSync(options.dataset)
    ? JSON.parse(readFileSync(options.dataset, "utf8"))
    : []
  const repoOf = new Map(dataset.map((row) => [row.instance_id, row.repo]))
  const total = options.total ?? (dataset.length || 500)
  // The subject of record is the first session's; every operating setting is
  // the session in effect now. A benchmark resumed with a different
  // concurrency or a different budget must report the one it is running under,
  // and a benchmark resumed onto a different *subject* is two measurements and
  // must say so rather than average them — the same `agreement` reading the
  // scorecard prints for a wave.
  const first = manifest.headers[0] ?? {}
  const latest = manifest.headers[manifest.headers.length - 1] ?? {}
  const header = {
    ...latest,
    subject: first.subject,
    subjectSource: first.subjectSource,
    head: first.head
  }
  const differing = manifest.headers.filter((entry) => entry.subject !== first.subject)
  const subjectAgreement = differing.length === 0
    ? "one subject"
    : `MISMATCH: ${differing.length} of ${manifest.headers.length} sessions ran a different subject `
      + `(${[...new Set(differing.map((entry) => entry.subject))].join(", ")})`

  const instances = []
  for (const state of manifest.states.values()) {
    instances.push(state)
  }
  instances.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))

  const graded = instances.filter((state) => state.verdict !== undefined)
  const resolved = graded.filter((state) => state.verdict === "resolved")
  const unresolved = graded.filter((state) => state.verdict === "unresolved")
  const empty = graded.filter((state) => state.verdict === "empty patch")
  const evalErrors = graded.filter((state) => state.verdict === "eval error")
  const failed = instances.filter((state) => state.state === "failed")
  const inFlight = instances.filter((state) => state.state === "pulled" || state.state === "ran")

  // Money is counted off **every attempt**, not off the folded state. A `pulled`
  // row opens a fresh attempt and replaces the dead one's columns — which is
  // right for a verdict and wrong for a bill — so an instance that crashed after
  // its model calls and re-ran would otherwise have its first attempt's tokens
  // vanish from the total the budget gate reads, and a benchmark that crashes
  // often could spend past its cap without ever tripping it.
  const attempts = costAttempts(manifest.rows)
  const spend = spendByInstance(manifest)
  const spentUsd = spend.unknownAttempts === 0 ? spend.cents / 100 : null
  const meanUsd = attempts.length === 0 || spentUsd === null ? undefined : spentUsd / attempts.length
  const tokens = attempts.reduce((sum, row) => ({
    inputTokens: sum.inputTokens + (row.cost?.usage?.inputTokens ?? 0),
    cachedInputTokens: sum.cachedInputTokens + (row.cost?.usage?.cachedInputTokens ?? 0),
    outputTokens: sum.outputTokens + (row.cost?.usage?.outputTokens ?? 0),
    reasoningTokens: sum.reasoningTokens + (row.cost?.usage?.reasoningTokens ?? 0)
  }), { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningTokens: 0 })
  // Attempts that were paid for and then replaced by a re-run. Nothing else in
  // the report shows them, and they are the difference between what the
  // scoreboard graded and what the card was charged.
  const retried = attempts.length - new Set(attempts.map((row) => row.id)).size

  const walls = instances.filter((state) => typeof state.wallSeconds === "number")
    .map((state) => state.wallSeconds)
  const wallTotal = walls.reduce((sum, value) => sum + value, 0)
  const meanWall = walls.length === 0 ? undefined : wallTotal / walls.length

  const rate = wilson(resolved.length, graded.length)
  // The scored population, which is the graded one minus whatever
  // `lib/excluded.mjs` names. This report is a scoreboard over the same ledgers
  // `compare-runs.mjs` and `compare-arms.mjs` read, so it obeys the same rule
  // they do: an instance whose verdict is a statement about the grading
  // environment is outside every rate, and both denominators are printed.
  // Nothing already here is re-derived — every existing number is the raw one
  // and now says so — because the raw count is half of what has to be printed.
  const scoring = denominators(graded.map((state) => state.id))
  const scoredResolved = resolved.filter((state) => !scoring.excluded.some((row) => row.id === state.id))
  const scoredRate = wilson(scoredResolved.length, scoring.scored)
  const remaining = total - graded.length
  const jobs = header.jobs ?? 2

  // The span is the **whole** ledger's, from the first session's header: the
  // observed throughput is defined as everything that happened divided by
  // everything that completed, stops and pauses included. Measuring from the
  // latest session's header while dividing by every instance ever graded is
  // what makes a benchmark resumed at instance 300 report that it will finish
  // in forty seconds.
  const firstAt = first.at ?? (instances[0]?.at ?? options.now)
  const lastAt = instances.length === 0 ? options.now : Math.max(...instances.map((state) => state.at ?? 0))
  const elapsedSeconds = Math.max(0, (lastAt - firstAt) / 1000)
  const observedPerInstance = graded.length === 0 ? undefined : elapsedSeconds / graded.length
  const modelledPerInstance = meanWall === undefined ? undefined : meanWall / jobs

  const repos = new Map()
  for (const state of graded) {
    const repo = repoOf.get(state.id) ?? "unknown"
    const entry = repos.get(repo) ?? { repo, graded: 0, resolved: 0 }
    entry.graded += 1
    if (state.verdict === "resolved") entry.resolved += 1
    repos.set(repo, entry)
  }

  const pinned = (header.pinnedImages ?? "").split(" ").filter((id) => id !== "")
  const pinnedRows = pinned.map((id) => ({
    id,
    repo: repoOf.get(id) ?? "unknown",
    verdict: manifest.states.get(id)?.verdict ?? "not run",
    usd: manifest.states.get(id)?.cost?.usd ?? null
  }))
  const pinnedGraded = pinnedRows.filter((state) =>
    state.verdict === "resolved" || state.verdict === "unresolved" || state.verdict === "empty patch" ||
    state.verdict === "eval error"
  )
  const pinnedResolved = pinnedRows.filter((state) => state.verdict === "resolved")

  const waits = readRows(join(dirname(options.manifest), "waits.jsonl"))
  const waitRows = waits.rows.filter((waitRow) => waitRow.kind === "wait")

  return {
    header,
    subjectAgreement,
    total,
    graded: graded.length,
    resolved: resolved.length,
    unresolved: unresolved.length,
    emptyPatch: empty.length,
    evalErrors: evalErrors.length,
    failed: failed.length,
    inFlight: inFlight.length,
    remaining,
    rate,
    scoredGraded: scoring.scored,
    scoredResolved: scoredResolved.length,
    scoredRate,
    excluded: scoring.excluded,
    rateExcludingRigFaults: evalErrors.length === 0
      ? undefined
      : wilson(resolved.length, graded.length - evalErrors.length),
    spentUsd,
    unknownAttempts: spend.unknownAttempts,
    meanUsd,
    projectedUsd: meanUsd === undefined ? undefined : meanUsd * total,
    attempts: attempts.length,
    retried,
    tokens,
    wallTotalSeconds: wallTotal,
    meanWallSeconds: meanWall,
    elapsedSeconds,
    observedPerInstance,
    modelledPerInstance,
    etaObserved: observedPerInstance === undefined ? undefined : options.now + observedPerInstance * remaining * 1000,
    etaModelled: modelledPerInstance === undefined ? undefined : options.now + modelledPerInstance * remaining * 1000,
    repos: [...repos.values()].sort((a, b) => b.graded - a.graded || (a.repo < b.repo ? -1 : 1)),
    pinnedRows,
    pinnedGraded: pinnedGraded.length,
    pinnedResolved: pinnedResolved.length,
    waits: waitRows.length,
    waitSeconds: waitRows.length === 0 ? 0 : Math.max(...waitRows.map((waitRow) => waitRow.waitedSeconds ?? 0)),
    torn: manifest.torn,
    // Interior lines that do not parse. A record torn by a kill becomes one of
    // these the moment the next append closes it, so a reader that drops them
    // silently is a reader that hides the crash and the row it cost.
    malformed: manifest.malformed,
    notes: manifest.notes,
    sessions: manifest.headers.length,
    freeMiB: options.freeMiB,
    paused: options.paused,
    now: options.now
  }
}

const matrixComparison = () => {
  const path = join(rigRoot, "matrix-report.json")
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

/**
 * The markdown scoreboard.
 *
 * @category conversions
 * @since 0.1.0
 */
export const renderReport = (summary) => {
  const lines = []
  lines.push("# SWE-bench Verified — full benchmark", "")
  lines.push(
    "One flows attempt per instance, over all 500 instances of SWE-bench Verified, graded by the",
    "official evaluator one instance at a time. This file is regenerated at every checkpoint;",
    "`fullbench/progress.md` is the append-only log of those checkpoints.",
    ""
  )
  if (summary.paused !== undefined) {
    lines.push(`> **PAUSED** — ${summary.paused}`, "")
  }
  lines.push("## Preconditions", "")
  lines.push("| | |", "| --- | --- |")
  lines.push(`| subject | \`${summary.header.subject ?? "—"}\` (${summary.header.subjectSource ?? "—"}) |`)
  lines.push(`| subject agreement | ${summary.subjectAgreement} |`)
  lines.push(`| HEAD at start | \`${summary.header.head ?? "—"}\` |`)
  lines.push(`| seat | \`${summary.header.seat ?? "—"}\` |`)
  lines.push(`| per-instance budget | ${summary.header.instanceBudgetSeconds ?? "—"} s |`)
  lines.push(`| concurrency | ${summary.header.jobs ?? "—"} |`)
  lines.push(`| disk gate | ${summary.header.minFreeMiB ?? "—"} MiB free before every pull |`)
  lines.push(`| cost budget | ${money(summary.header.budgetUsd)} |`)
  lines.push(`| evaluator run id | \`${summary.header.runId ?? "—"}\` |`)
  lines.push(`| driver sessions | ${summary.sessions} |`)
  lines.push(`| generated | ${iso(summary.now)} |`)
  lines.push("")

  lines.push("## Scoreboard", "")
  lines.push("| | count | of graded |", "| --- | ---: | ---: |")
  const share = (count) => (summary.graded === 0 ? "—" : percent(count / summary.graded))
  lines.push(`| resolved | ${summary.resolved} | ${share(summary.resolved)} |`)
  lines.push(`| unresolved | ${summary.unresolved} | ${share(summary.unresolved)} |`)
  lines.push(`| empty patch | ${summary.emptyPatch} | ${share(summary.emptyPatch)} |`)
  lines.push(`| eval error | ${summary.evalErrors} | ${share(summary.evalErrors)} |`)
  lines.push(`| **graded** | **${summary.graded}** | of ${summary.total} |`)
  if (summary.excluded.length > 0) {
    lines.push(`| **scored** | **${summary.scoredGraded}** | of ${summary.graded} graded |`)
  }
  lines.push(`| failed before a verdict | ${summary.failed} | |`)
  lines.push(`| in flight | ${summary.inFlight} | |`)
  lines.push(`| not started | ${summary.remaining - summary.inFlight - summary.failed} | |`)
  lines.push("")
  lines.push(
    summary.graded === 0
      // A rate over nothing is not 0%, and printing it as one is how a report
      // that has graded nothing gets quoted as having graded a failure.
      ? "**No instance has been graded yet**, so there is no rate to report."
      : summary.excluded.length === 0
      ? `**Resolve rate ${percent(summary.rate.point)}** `
        + `(95% Wilson ${percent(summary.rate.low)}–${percent(summary.rate.high)}, n=${summary.graded}).`
      // Both denominators, in the same sentence, which is the only way this rig
      // states a rate over a population something was excluded from. See
      // `lib/excluded.mjs`.
      : `**Resolve rate ${percent(summary.scoredRate.point)}** over `
        + `${denominatorLabel({ scored: summary.scoredGraded, raw: summary.graded })} `
        + `(95% Wilson ${percent(summary.scoredRate.low)}–${percent(summary.scoredRate.high)}, `
        + `n=${summary.scoredGraded}); over all ${summary.graded} graded, excluded rows included, it is `
        + `${percent(summary.rate.point)} `
        + `(${percent(summary.rate.low)}–${percent(summary.rate.high)}).`
  )
  if (summary.rateExcludingRigFaults !== undefined) {
    lines.push(
      "",
      `Excluding the ${summary.evalErrors} instance(s) the evaluator could not grade — a rig fault, not a`,
      `model result — the rate is ${percent(summary.rateExcludingRigFaults.point)} `
        + `(${percent(summary.rateExcludingRigFaults.low)}–${percent(summary.rateExcludingRigFaults.high)}).`
    )
  }
  lines.push(...renderExclusions(summary.excluded))
  lines.push("")

  lines.push("## Cost and wall clock", "")
  lines.push("| | |", "| --- | ---: |")
  lines.push(`| spent so far | ${money(summary.spentUsd)} |`)
  if (summary.unknownAttempts > 0) lines.push(`| attempts with unknown cost | ${summary.unknownAttempts} |`)
  lines.push(
    `| paid attempts | ${summary.attempts}${
      summary.retried > 0 ? ` (${summary.retried} re-run after a crash, and still on the bill)` : ""
    } |`
  )
  lines.push(`| mean per attempt | ${money(summary.meanUsd)} |`)
  lines.push(`| projected for all ${summary.total} | ${money(summary.projectedUsd)} |`)
  lines.push(`| budget | ${money(summary.header.budgetUsd)} |`)
  lines.push(`| input tokens | ${summary.tokens.inputTokens.toLocaleString("en-US")} |`)
  lines.push(`| cached input tokens | ${summary.tokens.cachedInputTokens.toLocaleString("en-US")} |`)
  lines.push(`| output tokens | ${summary.tokens.outputTokens.toLocaleString("en-US")} |`)
  lines.push(`| agent wall, summed | ${duration(summary.wallTotalSeconds)} |`)
  lines.push(`| mean instance wall | ${duration(summary.meanWallSeconds)} |`)
  lines.push(`| ledger spans | ${duration(summary.elapsedSeconds)} |`)
  lines.push(`| finish, observed throughput | ${iso(summary.etaObserved)} |`)
  lines.push(`| finish, modelled at ${summary.header.jobs ?? 2} in flight | ${iso(summary.etaModelled)} |`)
  lines.push(`| disk free | ${summary.freeMiB === undefined ? "—" : `${summary.freeMiB} MiB`} |`)
  lines.push(`| disk-gate waits | ${summary.waits} (longest ${duration(summary.waitSeconds)}) |`)
  lines.push("")
  lines.push(
    "The observed finish counts every hour the driver was stopped, paused or waiting on disk; the",
    "modelled one counts none of them. Neither is a promise.",
    ""
  )

  lines.push("## Per repository", "")
  lines.push("| repo | graded | resolved | rate |", "| --- | ---: | ---: | ---: |")
  for (const entry of summary.repos) {
    lines.push(
      `| ${entry.repo} | ${entry.graded} | ${entry.resolved} | ${percent(entry.resolved / entry.graded)} |`
    )
  }
  if (summary.repos.length === 0) lines.push("| — | 0 | 0 | — |")
  lines.push("")

  lines.push("## Against the pinned five", "")
  lines.push(
    "The five instances the best-of-5 matrix runs, as this benchmark scored them on its single",
    "attempt. Their images are the ones this driver never deletes.",
    ""
  )
  lines.push("| instance | repo | verdict | cost |", "| --- | --- | --- | ---: |")
  for (const entry of summary.pinnedRows) {
    lines.push(`| ${entry.id} | ${entry.repo} | ${entry.verdict} | ${money(entry.usd ?? undefined)} |`)
  }
  if (summary.pinnedRows.length === 0) lines.push("| — | — | — | — |")
  lines.push("")
  if (summary.pinnedGraded > 0) {
    const pinnedRate = wilson(summary.pinnedResolved, summary.pinnedGraded)
    lines.push(
      `| sample | n | resolved | rate |`,
      `| --- | ---: | ---: | ---: |`,
      `| pinned five, one attempt | ${summary.pinnedGraded} | ${summary.pinnedResolved} | ${
        percent(pinnedRate.point)
      } |`,
      `| all graded, one attempt | ${summary.graded} | ${summary.resolved} | ${percent(summary.rate.point)} |`,
      ...(summary.excluded.length === 0
        ? []
        : [
          `| all scored, one attempt | ${summary.scoredGraded} | ${summary.scoredResolved} `
          + `| ${percent(summary.scoredRate.point)} |`
        ]),
      ""
    )
    lines.push(
      "A five-instance rate has an interval wide enough to contain almost anything; the row is here",
      "so a drive that has been reasoning about those five for eleven waves can see how far they sit",
      "from the full set, not so it can be quoted as a comparison.",
      ""
    )
  }

  const matrix = matrixComparison()
  if (matrix !== undefined) {
    lines.push("## The best-of-5 matrix, for reference", "")
    lines.push(
      "`matrix-report.json` from the wave running beside this one. Its flows best-of-n column is the",
      "selector's pre-grading choice and its codex best-of-n column is an oracle; see README,",
      "\"Best-of-n\". This benchmark's number is one attempt, so it belongs beside the matrix's",
      "single-attempt column and nowhere else.",
      ""
    )
    lines.push("```json", JSON.stringify(matrix.summary ?? matrix, undefined, 2).slice(0, 2000), "```", "")
  }

  if (summary.notes.length > 0) {
    lines.push("## Notes from the driver", "")
    for (const note of summary.notes) {
      lines.push(`- \`${iso(note.at)}\` **${note.note}** — ${JSON.stringify(note)}`)
    }
    lines.push("")
  }
  if (summary.torn > 0) {
    lines.push(
      "> The manifest's last line was torn by a kill and could not be parsed. Every complete row",
      "> before it is intact and this report is built from those; the instance that line belonged to",
      "> re-runs on the next resume.",
      ""
    )
  }
  if (summary.malformed.length > 0) {
    lines.push(
      `> **${summary.malformed.length} manifest line(s) could not be parsed** and are not counted anywhere in`,
      `> this report: ${summary.malformed.map((entry) => `line ${entry.line}`).join(", ")}. A record torn by a`,
      "> kill reads this way once the next append closes it, and so does a hand edit. The bytes are",
      "> still in `manifest.jsonl`; every row before and after them is intact.",
      ""
    )
  }
  return `${lines.join("\n")}\n`
}

/**
 * One row for the append-only checkpoint log.
 *
 * @category conversions
 * @since 0.1.0
 */
export const renderCheckpoint = (summary) => {
  const cells = [
    iso(summary.now),
    `${summary.graded}/${summary.total}`,
    String(summary.resolved),
    `${percent(summary.rate.point)} (${percent(summary.rate.low)}–${percent(summary.rate.high)})`,
    money(summary.meanUsd),
    money(summary.spentUsd),
    money(summary.projectedUsd),
    iso(summary.etaObserved),
    summary.freeMiB === undefined ? "—" : `${summary.freeMiB} MiB`
  ]
  return `| ${cells.join(" | ")} |\n`
}

const CHECKPOINT_HEADER = [
  "# Full benchmark progress",
  "",
  "Append-only. One row per checkpoint, written every N completed instances by `fullbench.sh`.",
  "The rate carries a 95% Wilson interval; the projection assumes the mean cost so far holds for",
  "the rest, and the finish estimate is the observed throughput including every stop and wait.",
  "",
  "| at | graded | resolved | resolve rate (95% CI) | mean $/attempt | spent | projected total | finish (observed) | disk free |",
  "| --- | --- | ---: | --- | ---: | ---: | ---: | --- | ---: |",
  ""
].join("\n")

const optionValue = (argv, flag, fallback) => {
  const index = argv.indexOf(flag)
  return index === -1 ? fallback : argv[index + 1]
}

const main = () => {
  const argv = process.argv.slice(2)
  const manifest = optionValue(argv, "--manifest", join(rigRoot, "fullbench", "manifest.jsonl"))

  if (argv.includes("--spend-cents")) {
    const ledger = read(manifest)
    // Drivers append the current session header before their first budget
    // check. Refuse an unpriced seat here, before any worker can spend money.
    const header = ledger.headers.at(-1)
    if (
      header?.budgetUsd !== undefined && header?.seat !== undefined
      && usd(header.seat, { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }).usd === undefined
    ) {
      console.error(`unpriced seat: ${header.seat}; the dollar budget cannot be enforced`)
      process.stdout.write("unknown-seat\n")
      return
    }
    const spend = spendByInstance(ledger)
    const unknown = spend.unknownAttempts > 0 || ledger.malformed.length > 0 || ledger.torn > 0
    process.stdout.write(`${unknown ? "unknown" : spend.cents}\n`)
    return
  }

  const out = optionValue(argv, "--out", dirname(manifest))
  const dataset = optionValue(argv, "--dataset", join(rigRoot, "swb-verified.json"))
  const nowArgument = optionValue(argv, "--now")
  const now = nowArgument === undefined ? Date.now() : Number(nowArgument)
  const freeArgument = optionValue(argv, "--free-mib")
  let freeMiB = freeArgument === undefined ? undefined : Number(freeArgument)
  if (freeMiB === undefined) {
    try {
      freeMiB = Number(execFileSync(join(rigRoot, "lib", "disk-free.sh"), { encoding: "utf8" }).trim())
    } catch {
      freeMiB = undefined
    }
  }
  const pausedPath = join(out, "PAUSED")
  const paused = existsSync(pausedPath) ? readFileSync(pausedPath, "utf8").trim() : undefined

  const summary = summarise({ manifest, dataset, now, freeMiB, paused })
  writeFileSync(join(out, "report.json"), `${JSON.stringify(summary, undefined, 2)}\n`)
  writeFileSync(join(out, "report.md"), renderReport(summary))

  if (argv.includes("--checkpoint")) {
    const progress = join(out, "progress.md")
    if (!existsSync(progress)) writeFileSync(progress, CHECKPOINT_HEADER)
    appendFileSync(progress, renderCheckpoint(summary))
    if (paused !== undefined) {
      appendFileSync(progress, `\n> **PAUSED** at ${iso(now)} — ${paused}\n\n`)
    }
  }
  process.stdout.write(
    `fullbench-report.mjs: ${summary.graded}/${summary.total} graded, `
      + `${summary.scoredResolved} resolved of ${
        denominatorLabel({ scored: summary.scoredGraded, raw: summary.graded })
      }, `
      + `${money(summary.spentUsd)} spent\n`
  )
}

if (import.meta.filename === process.argv[1]) main()
