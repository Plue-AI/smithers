import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import * as Inventory from "../src/Inventory.ts"
import * as Report from "../src/Report.ts"
import * as Scan from "../src/Scan.ts"
import { copyFixture, hashTree, nodeLayer } from "./fixtures/helpers.ts"

const generatedAt = "2026-08-28T00:00:00.000Z"

/** The report with the two fields that legitimately differ per run replaced. */
const normalize = (report: Report.MigrationReport, root: string): unknown =>
  JSON.parse(Report.toJson(report).split(root).join("<root>").split(generatedAt).join("<generatedAt>"))

const reportFor = (root: string, mode: Report.Mode = "plan", options: Report.FinalizeOptions = {}) =>
  Effect.gen(function*() {
    const result = yield* Scan.scan(root)
    return Scan.toReport(result, mode, generatedAt, options)
  }).pipe(Effect.provide(nodeLayer))

describe("Scan.scan over jsx-single", () => {
  it.effect("produces the whole report from one read-only pass", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const before = hashTree(root)
      const report = yield* reportFor(root)
      const snapshot = normalize(report, root) as Record<string, never>

      expect(Object.fromEntries(hashTree(root))).toEqual(Object.fromEntries(before))
      expect(snapshot).toMatchObject({
        version: 1,
        mode: "plan",
        exitCode: 0,
        root: "<root>",
        generatedAt: "<generatedAt>",
        runState: { verdict: "clean", instructions: [] },
        project: {
          effectPin: "4.0.0-beta.105",
          workflowFiles: [{ path: "simple-workflow.jsx", kind: "jsx", api: "smthrs" }],
          prompts: [
            { path: "prompts/simple-workflow/research.mdx", classification: "interpolation-only" },
            { path: "prompts/simple-workflow/write.mdx", classification: "interpolation-only" }
          ],
          libs: ["_example-kit.js"],
          tests: ["tests/_setup.ts"]
        }
      })
      expect(report.mapping.map((decision) => `${decision.construct}:${decision.class}`)).toEqual([
        // The research step reads `ctx.input.topic` and the factory declares no
        // `input` schema, so its payload is unresolved. That makes the step a
        // guided decision, and the `<Sequence>` around it one too: a chain
        // cannot be mechanical when one of its links is not.
        "Sequence:guided",
        // One row per construct carries the worst class any occurrence has. The
        // write step is automatic and the research step is guided, and the row
        // has to say guided whichever order the two were read in.
        "Task:guided",
        // The workflow's payload is never declared, so the flow's own payload
        // cannot be derived and the agent writes it under the rule.
        "Workflow:guided",
        "createSmithers:guided",
        "ctx.input:automatic",
        "outputs.<key>:automatic",
        "smithers:guided"
      ])
      expect(report.mapping.find((decision) => decision.construct === "Task")?.reason)
        .toContain("not captured")
      expect(report.units.map((unit) => `${unit.id}:${unit.status}`)).toEqual([
        "dependencies:planned",
        "workflow:simple-workflow:planned",
        "project:planned"
      ])
    }))

  it.effect("produces the same report twice", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const first = yield* reportFor(root)
      const second = yield* reportFor(root)

      expect(normalize(second, root)).toEqual(normalize(first, root))
      expect(Report.toMarkdown(second)).toBe(Report.toMarkdown(first))
    }))
})

describe("Scan.scan over plue-pack", () => {
  it.effect("blocks the UI unit and keeps every other workflow planned", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const report = yield* reportFor(root, "apply")

      expect(report.units.map((unit) => `${unit.id}:${unit.status}`)).toEqual([
        "dependencies:planned",
        "workflow:implement:planned",
        "workflow:pipelines/ci-fast:blocked",
        "workflow:ralph:planned",
        "workflow:release:planned",
        "workflow:review:planned",
        "project:planned"
      ])
      expect(report.exitCode).toBe(3)
      expect(report.unsupported.map((entry) => entry.construct)).toEqual(["UI"])
    }))

  it.effect("records the foreign authoring API as a warning, not as a construct", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const report = yield* reportFor(root)

      expect(report.project.warnings.map((warning) => `${warning.code}:${warning.file}`)).toEqual([
        "unknown-authoring-api:.smithers/workflows/release.tsx"
      ])
      expect(report.inventory.some((row) => row.file.endsWith("release.tsx"))).toBe(false)
    }))

  it.effect("classifies the unbounded loop as guided and says why", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const report = yield* reportFor(root)
      const loop = report.mapping.find((decision) => decision.construct === "Loop")

      expect(loop?.class).toBe("guided")
      expect(loop?.reason).toContain("fuel")
    }))

  it.effect("leaves every byte of the project unchanged", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const before = hashTree(root)
      yield* reportFor(root, "apply")

      expect(Object.fromEntries(hashTree(root))).toEqual(Object.fromEntries(before))
    }))
})

describe("Scan.scan over persisted-db", () => {
  it.effect("carries the archive instruction into the report and the follow-ups", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const report = yield* reportFor(root, "apply")

      expect(report.runState.verdict).toBe("history-only")
      expect(report.runState.instructions).toHaveLength(1)
      expect(report.followUps[0]?.severity).toBe("must")
      expect(report.followUps[0]?.text).toContain("archive the database")
    }))

  it.effect("refuses to apply while the project still holds 0.x run state", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")

      // A database whose runs have all finished is still run state a 1.0
      // runtime cannot read, so `apply` parks until the operator says what
      // happens to it. `scan` and `plan` report and exit 0.
      expect((yield* reportFor(root, "apply")).exitCode).toBe(3)
      expect((yield* reportFor(root, "plan")).exitCode).toBe(0)
      expect((yield* reportFor(root, "apply", { acknowledgeRunState: true })).exitCode).toBe(0)
    }))

  it.effect("never descends into the executions directory", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const result = yield* Scan.scan(root).pipe(Effect.provide(nodeLayer))

      expect(result.detection.files.filter((file) => file.startsWith(".smithers/executions"))).toEqual([])
      expect(statSync(join(root, ".smithers", "executions")).isDirectory()).toBe(true)
      expect(readdirSync(join(root, ".smithers", "executions"))).toEqual(["run-1783757199651"])
    }))
})

describe("Scan.scan refuses a selection it cannot honour", () => {
  it.effect("names the unknown id and the ids the project does plan, rather than planning nothing and exiting 0", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const failure = yield* Effect.flip(Scan.scan(root, { units: ["workflow:helo", "dependencies"] }))

      expect(failure.code).toBe("unsupported-project")
      expect(failure.message).toContain("\"workflow:helo\"")
      // The ids it does plan, so the operator can read the typo off the
      // refusal instead of guessing at the spelling.
      expect(failure.message).toContain("\"workflow:simple-workflow\"")
      expect(failure.message).toContain("\"dependencies\"")
    }).pipe(Effect.provide(nodeLayer)))

  it.effect("selects the units it was given when every id is one the plan carries", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const result = yield* Scan.scan(root, { units: ["dependencies"] })

      expect(result.units.map((unit) => unit.id)).toEqual(["dependencies"])
    }).pipe(Effect.provide(nodeLayer)))

  it.effect("refuses two workflows whose ids collide, naming both sources", () =>
    Effect.gen(function*() {
      // A pack workflow and a root workflow with the same base name. Both plan
      // as `workflow:simple-workflow` and both target
      // `flows/simple-workflow/flow.ts`, so the second unit's rewrite would
      // overwrite the first one's flow and the report would carry one of the
      // two outcomes.
      const root = copyFixture("jsx-single")
      mkdirSync(join(root, ".smithers", "workflows"), { recursive: true })
      writeFileSync(
        join(root, ".smithers", "workflows", "simple-workflow.tsx"),
        "import { Sequence } from \"smthrs\"\nexport default () => <Sequence />\n"
      )

      const failure = yield* Effect.flip(Scan.scan(root))

      expect(failure.code).toBe("unsupported-project")
      expect(failure.message).toContain("workflow:simple-workflow")
      expect(failure.message).toContain("simple-workflow.jsx")
      expect(failure.message).toContain(".smithers/workflows/simple-workflow.tsx")
    }).pipe(Effect.provide(nodeLayer)))
})

describe("Scan.decisions merges every occurrence of a construct", () => {
  const hit = (construct: string, props: ReadonlyArray<string>): Inventory.InventoryEntry => ({
    file: "flow.tsx",
    line: 1,
    column: 1,
    construct,
    props
  })

  it("keeps the worst class whichever order the hits arrive in", () => {
    // One row stands for every occurrence. A file holding a plain `<Task>` and
    // a `<Task hijack>` has to say `unsafe`, and the answer cannot depend on
    // which of the two the walk read last.
    const hijack = hit("Task", ["id", "hijack"])
    const plain = hit("Task", ["id"])

    const forward = Scan.decisions([hijack, plain])
    const reverse = Scan.decisions([plain, hijack])

    expect(forward).toEqual(reverse)
    expect(forward[0]?.class).toBe("unsafe")
    expect(forward[0]?.occurrences).toBe(2)
    expect(forward[0]?.reason).toContain("hijack")
  })

  it("unions the reasons the occurrences gave", () => {
    const unbounded: Inventory.InventoryEntry = {
      file: "flow.tsx",
      line: 1,
      column: 1,
      construct: "Loop",
      props: ["maxIterations"],
      detail: { maxIterations: "Infinity" }
    }
    const merged = Scan.decisions([hit("Loop", ["continueAsNewEvery"]), unbounded])

    expect(merged[0]?.class).toBe("guided")
    expect(merged[0]?.reason).toContain("maxRounds")
    expect(merged[0]?.reason).toContain("fuel")
    expect(Scan.decisions([unbounded, hit("Loop", ["continueAsNewEvery"])])).toEqual(merged)
  })
})

describe("Scan.toReport carries the operator decisions", () => {
  it.effect("records every subscription agent and pool over plue-pack", () =>
    Effect.gen(function*() {
      const root = copyFixture("plue-pack")
      const report = yield* reportFor(root)
      const agents = report.unresolved.filter((entry) =>
        entry.suggestion.includes("subscription auth through the flows harness")
      )

      // Design 8.4: each one is answered by a person, so each one is an entry
      // that stays unresolved until it is.
      expect(agents.length).toBeGreaterThan(0)
      expect([...new Set(agents.map((entry) => entry.construct))].sort()).toEqual([
        "ClaudeCodeAgent",
        "CodexAgent",
        "OpenCodeAgent"
      ])
      expect(agents.filter((entry) => entry.file === ".smithers/agents.ts").length).toBeGreaterThanOrEqual(3)
      expect(report.followUps.some((followUp) => followUp.text.includes("pools stay pools"))).toBe(true)
    }))

  it.effect("records no decision for a project that uses no subscription agent", () =>
    Effect.gen(function*() {
      const report = yield* reportFor(copyFixture("jsx-single"))

      expect(report.unresolved).toEqual([])
    }))
})
