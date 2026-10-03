import { describe, expect, test } from "bun:test"
import type { ChangedFile } from "../src/walkthrough/changedFileSchema.ts"
import { renderOverviewChart } from "../src/walkthrough/renderOverviewChart.ts"
import { walkthroughCss } from "../src/walkthrough/walkthroughCss.ts"

function file(path: string, insertions: number, deletions: number): ChangedFile {
  return { path, status: "modified", insertions, deletions, diff: "", reviewed: true, excludeReason: "" }
}

function rowsOf(html: string): string[] {
  return html.split("<div class=\"chart-row\"").slice(1)
}

function rowWidth(row: string): number {
  const widths = [...row.matchAll(/width:([\d.]+)%/g)].map((match) => Number(match[1]!))
  return widths.reduce((sum, width) => sum + width, 0)
}

function chartTrackGapPx(): number {
  const trackRule = walkthroughCss.match(/\.chart-track\s*\{([^}]*)\}/)?.[1]!
  if (trackRule === undefined) throw new Error("Missing .chart-track CSS rule")
  const gap = trackRule.match(/\bgap:\s*([\d.]+)px/)
  return gap ? Number(gap[1]!) : 0
}

function renderedRowWidthPx(row: string, trackWidthPx: number): number {
  const segmentCount = [...row.matchAll(/width:[\d.]+%/g)].length
  return (rowWidth(row) / 100) * trackWidthPx + Math.max(segmentCount - 1, 0) * chartTrackGapPx()
}

describe("renderOverviewChart", () => {
  test("renders one HTML row per area, biggest churn first, with counts", () => {
    const html = renderOverviewChart([
      file("apps/web/src/a.ts", 10, 2),
      file("apps/web/src/b.ts", 5, 1),
      file("packages/x/y.ts", 100, 50),
      file("README.md", 1, 0)
    ])
    expect(html).not.toContain("<svg")
    const rows = rowsOf(html)
    expect(rows.length).toBe(3) // packages/x, apps/web, (root)
    expect(rows[0]!).toContain("packages/x")
    expect(rows[1]!).toContain("apps/web")
    expect(rows[2]!).toContain("(root)")
    expect(rows[0]!).toContain("+100 −50")
    expect(rows[1]!).toContain("+15 −3")
    expect(rows[0]!).toContain("1 file")
    expect(rows[1]!).toContain("2 files")
  })

  test("bar widths are monotonically non-increasing in row order", () => {
    const html = renderOverviewChart([
      file("packages/big/a.ts", 9000, 1000),
      file("apps/mid/b.ts", 400, 100),
      file("scripts/small.ts", 9, 1)
    ])
    const widths = rowsOf(html).map(rowWidth)
    expect(widths.length).toBe(3)
    for (let i = 1; i < widths.length; i += 1) {
      expect(widths[i]).toBeLessThanOrEqual(widths[i - 1]!)
    }
    // Dominant area fills the track; the sqrt scale keeps the smallest area
    // clearly visible (a linear scale would give it 0.1%).
    expect(widths[0]!).toBeGreaterThan(95)
    expect(widths[2]!).toBeGreaterThan(1)
  })

  test("keeps minimum-size segments within the rendered track width", () => {
    const trackWidthPx = 100
    const mostlyAdditions = rowsOf(renderOverviewChart([file("src/add.ts", 9990, 10)]))[0]!
    expect(mostlyAdditions).toContain("class=\"chart-add\" style=\"width:98.5%\"")
    expect(mostlyAdditions).toContain("class=\"chart-del\" style=\"width:1.5%\"")
    expect(renderedRowWidthPx(mostlyAdditions, trackWidthPx)).toBeLessThanOrEqual(trackWidthPx)

    const mostlyDeletions = rowsOf(renderOverviewChart([file("src/delete.ts", 10, 9990)]))[0]!
    expect(mostlyDeletions).toContain("class=\"chart-add\" style=\"width:1.5%\"")
    expect(mostlyDeletions).toContain("class=\"chart-del\" style=\"width:98.5%\"")
    expect(renderedRowWidthPx(mostlyDeletions, trackWidthPx)).toBeLessThanOrEqual(trackWidthPx)
  })

  test("collapses overflow areas into a truthful +N more row", () => {
    const files: ChangedFile[] = []
    for (let i = 0; i < 15; i += 1) files.push(file(`area${String(i).padStart(2, "0")}/f.ts`, 15 - i, 0))
    const html = renderOverviewChart(files)
    const rows = rowsOf(html)
    expect(rows.length).toBe(12)
    expect(rows[11]!).toContain("more areas")
  })

  test("empty change set renders nothing", () => {
    expect(renderOverviewChart([])).toBe("")
  })
})
