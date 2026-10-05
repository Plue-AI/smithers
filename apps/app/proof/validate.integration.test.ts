import { describe, expect, test } from "bun:test"
import { resolve } from "node:path"
import { MOCK_STEPS_PATH, readMockJourneys, readMockSteps } from "./mock-steps.ts"
import { FEATURES_PATH, gitTree, validateRepository, workingTree } from "./validate.ts"

/** The real registry, the real mock and the real repository: no fixtures. */
const root = resolve(import.meta.dir, "../../..")

/** Importing the mock and reading git under agent load takes seconds; the shared 5 s default is too tight. */
const SLOW = 120_000

describe("proofValidate on the repository", () => {
  test("features.json passes against the working tree", async () => {
    const { features, issues } = await validateRepository(root, workingTree(root))
    expect(issues).toEqual([])
    expect(features).toBeGreaterThan(0)
  }, SLOW)

  test("the committed mock-steps.json matches the design mock", async () => {
    expect(readMockSteps(root)).toEqual(await readMockJourneys(root))
  }, SLOW)

  test("every J1 mock step is covered by a J1 feature", async () => {
    const features = JSON.parse(await Bun.file(resolve(root, FEATURES_PATH)).text()) as Array<{ journey: string; mockSteps: string[] }>
    const covered = new Set(features.filter(feature => feature.journey === "J1").flatMap(feature => feature.mockSteps))
    const j1 = readMockSteps(root).find(journey => journey.file === "j1")!
    const missing = j1.steps.map((_, i) => `j1#${i + 1}`).filter(ref => !covered.has(ref))
    expect(missing).toEqual([])
  }, SLOW)

  test("the CLI exits 0 on the working tree and names the feature count", () => {
    const run = Bun.spawnSync(["bun", "apps/app/proof/validate.ts", "--worktree"], { cwd: root })
    expect({ code: run.exitCode, stderr: run.stderr.toString() }).toEqual({ code: 0, stderr: "" })
    expect(run.stdout.toString()).toMatch(/^proofValidate passed at the working tree: \d+ features\.\n$/)
  }, SLOW)

  test("a broken registry reports one schema issue", async () => {
    const tree = workingTree(root)
    const broken = { read: (path: string) => (path === FEATURES_PATH ? JSON.stringify([{ id: "Bad Id" }]) : tree.read(path)) }
    const { issues } = await validateRepository(root, broken)
    expect(issues.map(issue => issue.kind)).toEqual(["schema"])
  }, SLOW)

  test("a registry that is not JSON is reported, not thrown", async () => {
    const tree = workingTree(root)
    const { issues } = await validateRepository(root, { read: path => (path === FEATURES_PATH ? "{" : tree.read(path)) })
    expect(issues.map(issue => issue.kind)).toEqual(["unreadable"])
  }, SLOW)

  test("gitTree reads files at HEAD and refuses paths outside the tree", () => {
    const head = gitTree(root)
    expect(head.read("apps/app/PACKAGE.ts")).toContain("Smithers.Package")
    expect(head.read("apps/app/proof/not-a-file.ts")).toBeUndefined()
    expect(head.read(MOCK_STEPS_PATH.replace(".json", ".missing"))).toBeUndefined()
  }, SLOW)
})
