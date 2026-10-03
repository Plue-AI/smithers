import { pluralize } from "../text/pluralize.ts"
import type { ChangedFile } from "./changedFileSchema.ts"
import { escapeHtml } from "./escapeHtml.ts"

const MAX_ROWS = 12
const MIN_SEGMENT_PCT = 1.5

const groupedRoots = new Set(["apps", "packages", "examples", "src"])

function areaOf(path: string): string {
  const parts = path.split("/")
  if (parts.length === 1) return "(root)"
  if (parts.length > 2 && groupedRoots.has(parts[0]!)) return `${parts[0]}/${parts[1]}`
  return parts[0]!
}

type AreaEntry = { insertions: number; deletions: number; files: number }

function pct(value: number): string {
  return `${Math.round(value * 100) / 100}%`
}

function barSegments(entry: AreaEntry, maxChurn: number): string {
  const churn = entry.insertions + entry.deletions
  if (churn === 0) return ""
  // sqrt scale so small areas stay visible next to a dominant one.
  const total = Math.sqrt(churn / maxChurn) * 100
  let addPct = (entry.insertions / churn) * total
  let delPct = total - addPct
  if (entry.insertions > 0 && entry.deletions > 0) {
    const minSegmentPct = Math.min(MIN_SEGMENT_PCT, total / 2)
    addPct = Math.min(Math.max(addPct, minSegmentPct), total - minSegmentPct)
    delPct = total - addPct
  } else if (entry.insertions > 0 && addPct < MIN_SEGMENT_PCT) {
    addPct = MIN_SEGMENT_PCT
  } else if (entry.deletions > 0 && delPct < MIN_SEGMENT_PCT) {
    delPct = MIN_SEGMENT_PCT
  }
  const parts: Array<string> = []
  if (entry.insertions > 0) parts.push(`<div class="chart-add" style="width:${pct(addPct)}"></div>`)
  if (entry.deletions > 0) parts.push(`<div class="chart-del" style="width:${pct(delPct)}"></div>`)
  return parts.join("")
}

/**
 * Deterministic change-shape visual for the walkthrough header: one HTML row
 * per workspace area (flex label + counts, then a percentage-width bar split
 * into additions/deletions). Plain divs keep the text legible at any viewport
 * width (no SVG scaling), and a sqrt scale keeps small areas distinguishable
 * next to a dominant one. Areas beyond MAX_ROWS collapse into a truthful
 * "+N more areas" row instead of being dropped. No runtime deps.
 */
export function renderOverviewChart(files: Array<ChangedFile>): string {
  const byArea = new Map<string, AreaEntry>()
  for (const file of files) {
    const area = areaOf(file.path)
    const entry = byArea.get(area) ?? { insertions: 0, deletions: 0, files: 0 }
    entry.insertions += file.insertions
    entry.deletions += file.deletions
    entry.files += 1
    byArea.set(area, entry)
  }
  const sorted = [...byArea.entries()].sort(
    (a, b) => b[1].insertions + b[1].deletions - (a[1].insertions + a[1].deletions) || a[0].localeCompare(b[0])
  )
  if (sorted.length === 0) return ""

  const rows: Array<[string, AreaEntry]> = sorted.slice(0, sorted.length > MAX_ROWS ? MAX_ROWS - 1 : MAX_ROWS)
  const rest = sorted.slice(rows.length)
  if (rest.length > 0) {
    const merged = rest.reduce(
      (acc, [, entry]) => ({
        insertions: acc.insertions + entry.insertions,
        deletions: acc.deletions + entry.deletions,
        files: acc.files + entry.files
      }),
      { insertions: 0, deletions: 0, files: 0 }
    )
    rows.push([`+${pluralize(rest.length, "more area")}`, merged])
  }

  const maxChurn = Math.max(...rows.map(([, entry]) => entry.insertions + entry.deletions), 1)
  const parts: Array<string> = [
    `<div class="overview-chart" role="img" aria-label="Changed lines by area">`,
    `<div class="chart-key" aria-hidden="true"><span class="key-swatch chart-add"></span>added<span class="key-swatch chart-del"></span>removed</div>`
  ]
  for (const [area, entry] of rows) {
    const counts = `+${entry.insertions} −${entry.deletions}`
    parts.push(
      `<div class="chart-row" title="${escapeHtml(area)}: ${counts} across ${
        escapeHtml(pluralize(entry.files, "file"))
      }">`,
      `<span class="chart-label">${escapeHtml(area)} <span class="chart-files">· ${
        escapeHtml(pluralize(entry.files, "file"))
      }</span></span>`,
      `<span class="chart-count">${escapeHtml(counts)}</span>`,
      `<div class="chart-track">${barSegments(entry, maxChurn)}</div>`,
      `</div>`
    )
  }
  parts.push("</div>")
  return parts.join("")
}
