import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

// T-CUT-01's shared ledger replaces a second cut list in follow-up tickets.
const manifest = JSON.parse(readFileSync(new URL("../src/catalog/cuts.json", import.meta.url), "utf8")) as {
  version: number
  rows: Array<{ id: string; disposition: string; flowNames: string[]; cardKinds: string[]; sourcePaths: string[] }>
}
const root = new URL("../../../", import.meta.url)

describe("MVP cut manifest", () => {
  it("records the seven cut kinds without absorbing deferred or replacement kinds", () => {
    expect(manifest.version).toBe(1)
    expect(manifest.rows.flatMap(row => row.cardKinds).sort()).toEqual([
      "admin-health", "agent", "connect", "grant-confirm", "notifications", "registration", "repository-setup"
    ])
    expect(manifest.rows.every(row => row.disposition === "cut")).toBe(true)
    expect(new Set(manifest.rows.map(row => row.id)).size).toBe(manifest.rows.length)
    const names = manifest.rows.flatMap(row => row.flowNames)
    expect(new Set(names).size).toBe(names.length)
    for (const kept of ["issues", "flows", "admin.devtools", "repo.choose", "billing.plans", "notifications.allow"]) {
      expect(names).not.toContain(kept)
    }
  })

  it("has no remaining cut source paths", () => {
    const paths = manifest.rows.flatMap(row => row.sourcePaths)
    expect(paths.length).toBeGreaterThan(0)
    expect(paths.filter(path => existsSync(fileURLToPath(new URL(path, root))))).toEqual([])
  })
})
