/**
 * Renders the full benchmark's one-screen status.
 *
 *   node lib/fullbench-status.mjs <manifest.jsonl> <dataset.json> <driver> <freeMiB>
 *
 * `fullbench-status.sh` is the entry point; it works out whether a driver is
 * running and what the disk says, and this turns the ledger into the screen.
 * The numbers are the same ones `fullbench-report.mjs` computes — this imports
 * `summarise` and `lib/format-money.mjs` rather than restating them, so the
 * screen and the report can never disagree about a rate, or about a budget the
 * driver spliced through the shell as text.
 */
import { summarise } from "../fullbench-report.mjs"
import { formatMoney as money } from "./format-money.mjs"
import { read } from "./fullbench-manifest.mjs"

const percent = (value) => `${(value * 100).toFixed(1)}%`
const iso = (ms) => (Number.isFinite(ms) ? new Date(ms).toISOString().replace(".000", "") : "—")

const duration = (seconds) => {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—"
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

const bar = (done, total, width = 40) => {
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  return `[${"#".repeat(filled)}${".".repeat(Math.max(0, width - filled))}]`
}

const [, , manifestPath, datasetPath, driver, freeArgument] = process.argv
if (manifestPath === undefined) {
  console.error("usage: node lib/fullbench-status.mjs <manifest.jsonl> <dataset.json> <driver> <freeMiB>")
  process.exit(2)
}
const freeMiB = Number.isFinite(Number(freeArgument)) ? Number(freeArgument) : undefined

const summary = summarise({ manifest: manifestPath, dataset: datasetPath, now: Date.now(), freeMiB })
const manifest = read(manifestPath)
const live = [...manifest.states.values()]
  .filter((state) => state.state === "pulled" || state.state === "ran")
  .map((state) => `${state.id} (${state.state})`)

const out = []
out.push("SWE-bench Verified — full benchmark")
out.push(`  driver     ${driver ?? "unknown"}`)
out.push(`  subject    ${summary.header.subject ?? "—"} (${summary.header.subjectSource ?? "—"})`)
if (summary.subjectAgreement !== "one subject") out.push(`  AGREEMENT  ${summary.subjectAgreement}`)
out.push(
  `  seat       ${summary.header.seat ?? "—"}   jobs ${summary.header.jobs ?? "—"}   `
    + `run id ${summary.header.runId ?? "—"}   sessions ${summary.sessions}`
)
out.push("")
out.push(`  ${bar(summary.graded, summary.total)}  ${summary.graded}/${summary.total} graded`)
out.push(
  `  resolved   ${summary.resolved}   unresolved ${summary.unresolved}   empty ${summary.emptyPatch}   `
    + `eval error ${summary.evalErrors}   failed ${summary.failed}`
)
out.push(
  `  rate       ${percent(summary.rate.point)}  `
    + `(95% Wilson ${percent(summary.rate.low)}–${percent(summary.rate.high)}, n=${summary.graded})`
)
out.push("")
out.push(
  `  spent      ${money(summary.spentUsd)} of ${money(summary.header.budgetUsd)}   `
    + `mean ${money(summary.meanUsd)}/attempt   projected ${money(summary.projectedUsd)}`
    + `${summary.retried > 0 ? `   ${summary.retried} paid re-run(s)` : ""}`
)
out.push(
  `  wall       mean ${duration(summary.meanWallSeconds)}/instance   `
    + `ledger spans ${duration(summary.elapsedSeconds)}`
)
out.push(`  finish     ${iso(summary.etaObserved)} observed   ${iso(summary.etaModelled)} modelled`)
out.push(
  `  disk       ${freeMiB === undefined ? "—" : `${freeMiB} MiB`} free   ${summary.waits} gate waits`
)
out.push("")
out.push(`  in flight  ${live.length === 0 ? "—" : live.join(", ")}`)
if (summary.notes.length > 0) out.push(`  notes      ${summary.notes.length} (see fullbench/report.md)`)
if (summary.torn > 0) {
  out.push("  ledger     the last line was torn by a kill; that instance re-runs on resume")
}
if (summary.malformed.length > 0) {
  out.push(
    `  ledger     ${summary.malformed.length} unparseable line(s); nothing counts them (see fullbench/report.md)`
  )
}
out.push("")
out.push(`  report     ${manifestPath.replace(/manifest\.jsonl$/, "report.md")}`)
out.push(`  progress   ${manifestPath.replace(/manifest\.jsonl$/, "progress.md")}`)
console.log(out.join("\n"))
