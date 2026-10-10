/**
 * Every fault case belongs to exactly one tier (#3459).
 *
 * The release gate's "Exclusive fault matrix" runs `//packages/smithers:faults`
 * and scheduled reliability runs `//packages/smithers:faultsLong` nightly. A
 * case moved out of one and into neither would leave the matrix silently
 * smaller, and a case in both would run twice and cost the release gate an
 * hour. The two targets, the two Vitest configs that select files, and the Go
 * case table must agree on one tier per case.
 */
import { readdirSync, readFileSync } from "node:fs"
import { join, matchesGlob, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import long from "../vitest.faults-long.config.ts"
import release from "../vitest.faults.config.ts"
import { goFaultCases, goFaultCasesFor, requiredFaultSiblings } from "./faults/harness/goFaultCases.ts"

const root = fileURLToPath(new URL("../../../", import.meta.url))
const pkg = join(root, "packages/smithers")

const walk = (dir: string): Array<string> =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)]
  )
const faultCases = walk(join(pkg, "test/faults"))
  .map((file) => relative(pkg, file))
  .filter((file) => file.endsWith(".test.ts"))

const selects = (config: typeof release, file: string): boolean =>
  (config.test?.include ?? []).some((pattern) => matchesGlob(file, pattern)) &&
  !(config.test?.exclude ?? []).some((pattern) => matchesGlob(file, pattern))

interface IndexedInput {
  readonly kind: string
  readonly pattern?: string
  readonly path?: string
  readonly exclude?: ReadonlyArray<string>
}
interface IndexedTarget {
  readonly label: string
  readonly rule: string
  readonly exclusive?: boolean
  readonly inputs: ReadonlyArray<IndexedInput>
  readonly dependencies: ReadonlyArray<string>
}
const index = JSON.parse(readFileSync(join(root, ".smithers/target-index.json"), "utf8")) as Array<IndexedTarget>
const target = (label: string): IndexedTarget => {
  const found = index.find((entry) => entry.label === label)
  expect(found, `${label} is not in the target index`).toBeDefined()
  return found!
}
const keys = (indexed: IndexedTarget, file: string): boolean =>
  indexed.inputs.some((input) =>
    input.kind === "glob" && matchesGlob(file, input.pattern!) &&
    !(input.exclude ?? []).some((pattern) => matchesGlob(file, pattern))
  )

describe("fault tiers", () => {
  const faults = target("//packages/smithers:faults")
  const faultsLong = target("//packages/smithers:faultsLong")

  it("declares the long tier as its own exclusive target with its own config", () => {
    for (const tier of [faults, faultsLong]) {
      expect(tier.rule).toBe("Vitest")
      expect(tier.exclusive).toBe(true)
    }
    expect(faults.inputs).toContainEqual({ kind: "file", path: "packages/smithers/vitest.faults.config.ts" })
    expect(faultsLong.inputs).toContainEqual({ kind: "file", path: "packages/smithers/vitest.faults-long.config.ts" })
  })

  it("runs every fault case file in exactly one tier", () => {
    expect(faultCases.length).toBeGreaterThan(20)
    for (const file of faultCases) {
      const tiers = [selects(release, file) && "release", selects(long, file) && "long"].filter(Boolean)
      expect(tiers, `${file} must run in exactly one tier`).toHaveLength(1)
      // The target keys on the files its config runs, so a cached tier never
      // passes over a case it did not run.
      const keyed = [
        keys(faults, `packages/smithers/${file}`) && "release",
        keys(faultsLong, `packages/smithers/${file}`) && "long"
      ].filter(Boolean)
      expect(keyed, `${file} is keyed by the wrong tier`).toEqual(tiers)
    }
  })

  it("puts each required TypeScript sibling in its declared tier", () => {
    for (const [file, tier] of Object.entries(requiredFaultSiblings)) {
      expect(faultCases).toContain(`test/faults/${file}`)
      expect(selects(tier === "long" ? long : release, `test/faults/${file}`), file).toBe(true)
    }
  })

  it("runs every Go case in exactly one tier", () => {
    const ids = goFaultCases.map((entry) => `${entry.file}#${entry.name ?? "*"}`)
    expect(new Set(ids).size, "a Go case is listed twice").toBe(ids.length)
    for (const host of ["linux", "reference"]) {
      const inRelease = goFaultCasesFor("release", host)
      const inLong = goFaultCasesFor("long", host)
      expect(inRelease.filter((entry) => inLong.includes(entry))).toEqual([])
      expect([...inRelease, ...inLong].length)
        .toBe(goFaultCases.filter((entry) => entry.host === "any" || host === "reference").length)
    }
    // The tier files register exactly their tier, so a case's tier field is
    // the only place it is assigned.
    expect(readFileSync(join(pkg, "test/faults/durability-required.test.ts"), "utf8"))
      .toMatch(/registerGoFaultCases\("release"\)/)
    expect(readFileSync(join(pkg, "test/faults/long/durability-long.test.ts"), "utf8"))
      .toMatch(/registerGoFaultCases\("long"\)/)
  })

  it("keeps the hour-scale cases out of the release gate", () => {
    const tierOf = (file: string, name: string | null) =>
      goFaultCases.find((entry) => entry.file === file && entry.name === name)?.tier
    expect(tierOf("internal/compose/todo_live_pause_fault_test.go", "TestTodoStartPauseResumeCrashThroughRoutes"))
      .toBe("long")
    expect(tierOf("internal/compose/github_outbound_kill_test.go", null)).toBe("long")
    expect(tierOf("internal/compose/rebase_fault_test.go", "TestRebaseCrashThroughDispatcher")).toBe("long")
    expect(tierOf("internal/machined/fault_test.go", null)).toBe("long")
    expect(requiredFaultSiblings["long/case40-host-kill-todo-run.test.ts"]).toBe("long")
    // The reference-bundle case refuses in seconds off the reference host.
    expect(tierOf("internal/compose/rebase_fault_test.go", "TestRebaseFaultRootInputsValidatedBeforeUse"))
      .toBe("release")
    const minutes = (go: string) => go.endsWith("h") ? Number(go.slice(0, -1)) * 60 : Number(go.slice(0, -1))
    for (const entry of goFaultCasesFor("release", "linux")) {
      if (entry.name === "TestRebaseFaultRootInputsValidatedBeforeUse") continue
      expect(minutes(entry.budget.go), `${entry.name ?? entry.file} is budgeted beyond the release tier`)
        .toBeLessThanOrEqual(5)
    }
  })

  it("builds the programs each tier's cases start", () => {
    // Both tiers kill a private PostgreSQL cluster (the route case and
    // case40's K5); only the long tier drives installs and the K7 daemon.
    for (const tier of [faults, faultsLong]) {
      expect(tier.dependencies).toContain("//packages/smithers:faultPostgresDatabase")
      expect(tier.dependencies).toContain("//packages/smithers:faultPostgresPrograms")
    }
    expect(faultsLong.dependencies).toContain("//packages/smithers:faultNative")
    expect(faults.dependencies).not.toContain("//packages/smithers:faultNative")
  })
})
