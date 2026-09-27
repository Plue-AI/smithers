/**
 * The `smithers-migrate` executable, spawned as a process.
 *
 * `npx @smthrs/migrate` is the first command an operator types, and everything
 * it does before and after the flow — parsing thirteen flags plus the four
 * verification overrides, mapping a refusal onto an exit code, printing the
 * summary a person reads — runs nowhere else. A test that calls `Command.run`
 * in process proves the migration and not the tool.
 *
 * These cases need no model: `plan` never reaches an agent step, and a refused
 * gate stops before the first unit.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { copyFixture, hashTree, runBin } from "../fixtures/helpers.ts"

const expectSuccessfulPlan = (
  result: ReturnType<typeof runBin>,
  root: string,
  before: ReadonlyMap<string, string>
): void => {
  expect(result.status, result.stderr).toBe(0)
  // TypeScript 7.0.2's synchronous API inherits compiler stderr, then closes
  // its pipes and sends SIGTERM in API.close(). On Linux that successful
  // syntax-session shutdown can print this exact line. Keep the allowance
  // local to successful plans; every other diagnostic and error exit stays
  // visible, and verify the complete persisted result and original sources.
  expect(result.stderr).toMatch(process.platform === "linux" ? /^(?:context canceled\r?\n)*$/ : /^$/)
  const report = JSON.parse(readFileSync(join(root, ".out", "report.json"), "utf8")) as {
    mode: string
    exitCode: number
    units: Array<{ id: string; status: string }>
  }
  expect(report).toMatchObject({ mode: "plan", exitCode: 0 })
  expect(report.units.map(({ id, status }) => ({ id, status }))).toEqual([
    { id: "dependencies", status: "planned" },
    { id: "workflow:simple-workflow", status: "planned" },
    { id: "project", status: "planned" }
  ])
  const after = hashTree(root)
  for (const [path, digest] of before) expect([path, after.get(path)]).toEqual([path, digest])
  expect([...after.keys()].filter((path) => !before.has(path)).every((path) => path.startsWith(".out/"))).toBe(true)
}

describe("smithers-migrate", () => {
  it("plans a project, writes the report where it was asked to, and changes nothing else", () => {
    const root = copyFixture("jsx-single")
    const before = hashTree(root)

    const result = runBin(["--root", root, "--report-dir", ".out"])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain("smthrs migrate plan:")
    expect(result.stdout).toContain("Units: 3 planned, 0 migrated, 0 failed, 0 blocked.")
    expect(result.stdout).toContain(join(root, ".out", "report.md"))
    expect(existsSync(join(root, ".out", "report.md"))).toBe(true)
    // Planning writes the report and nothing else. Every source is untouched.
    const after = hashTree(root)
    for (const [path, digest] of before) expect([path, after.get(path)]).toEqual([path, digest])
    expect([...after.keys()].filter((path) => !before.has(path)).every((path) => path.startsWith(".out/"))).toBe(true)
  })

  it("prints the release version, not a placeholder", () => {
    const result = runBin(["--version"])

    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toContain("1.0.0-rc.1")
    expect(result.stdout).not.toContain("0.1.0")
  })

  it("renders a machine-readable report when it is asked for one", () => {
    const root = copyFixture("jsx-single")

    const result = runBin(["--root", root, "--report-dir", ".out", "--json"])

    expect(result.status).toBe(0)
    const report = JSON.parse(result.stdout) as { mode: string; units: ReadonlyArray<{ id: string }> }
    expect(report.mode).toBe("plan")
    expect(report.units.map((unit) => unit.id)).toEqual([
      "dependencies",
      "workflow:simple-workflow",
      "project"
    ])
  })

  it("parks a keyless apply at the run-state safety gate without writes", () => {
    const root = copyFixture("persisted-db")
    const before = hashTree(root)

    const result = runBin(["--root", root, "--apply", "--report-dir", ".out"], {
      ...process.env,
      AI_GATEWAY_API_KEY: undefined
    })

    expect(result.status).toBe(3)
    expect(result.stderr).toContain("smthrs migrate:")
    expect(result.stderr).not.toContain("AI_GATEWAY_API_KEY")
    expect(hashTree(root)).toEqual(before)
  })

  it("takes the verification commands the operator names, and knows the ones it does not have", () => {
    const root = copyFixture("jsx-single")
    const before = hashTree(root)

    // A project whose real typecheck is not the one the manifests imply has no
    // other way to be migrated: every unit is verified with these lines, and
    // the agent's shell is granted exactly them.
    const taken = runBin([
      "--root",
      root,
      "--report-dir",
      ".out",
      "--verify-install",
      "make deps",
      "--verify-format",
      "make fmt",
      "--verify-typecheck",
      "make check",
      "--verify-typecheck",
      "tsc -p tsconfig.build.json --noEmit",
      "--verify-test",
      "make test"
    ])
    expectSuccessfulPlan(taken, root, before)

    // One empty value is how the live end-to-end test says "run no typecheck",
    // which is the shape a project whose 1.0 dependencies are unpublished needs.
    const none = runBin(["--root", root, "--report-dir", ".out", "--verify-typecheck", ""])
    expectSuccessfulPlan(none, root, before)

    const unknown = runBin(["--root", root, "--verify-everything", "make"])
    expect(unknown.status).not.toBe(0)
    expect(`${unknown.stdout}${unknown.stderr}`).toContain("verify-everything")
  })
})
