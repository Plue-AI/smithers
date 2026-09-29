/**
 * The step that decides what a unit's rewrite was worth, on its own.
 *
 * The scripted apply proves the whole graph; these prove the three things that
 * are hard to reach from the outside: an exception between the checkpoint and
 * the unit report, a postcondition a content check cannot express, and a
 * duration measured from the right moment.
 *
 * @since 0.1.0
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Checkpoint from "@smthrs/migrate/flow/Checkpoint"
import * as MigrateFlow from "@smthrs/migrate/flow/MigrateFlow"
import type * as Options from "@smthrs/migrate/flow/Options"
import type * as Transform from "@smthrs/migrate/flow/Transform"
import * as Verify from "@smthrs/migrate/flow/Verify"
import * as Report from "@smthrs/migrate/Report"
import * as Scan from "@smthrs/migrate/Scan"
import * as Clock from "effect/Clock"
import * as Effect from "effect/Effect"
import { TestClock } from "effect/testing"
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { copyFixture, fixture, hashTree } from "../fixtures/helpers.ts"

const golden = readFileSync(
  join(fixture("jsx-single.migrated"), "flows", "simple-workflow", "flow.ts"),
  "utf8"
)

const platform = NodeServices.layer

const options = (root: string, overrides: Partial<Options.MigrateOptions> = {}): Options.MigrateOptions => ({
  root,
  mode: "apply",
  commands: { typecheck: [], test: "node -e \"process.exit(0)\"" },
  ...overrides
})

/**
 * The real plan-time outlines of a real fixture, one per unit, over the same
 * scan the survey makes: the operator's command overrides reach the outline,
 * so the final verification `finish` runs uses them and not the manifest's.
 */
const outlines = (
  root: string,
  chosen: Options.MigrateOptions
): Effect.Effect<ReadonlyArray<Transform.UnitOutline>, never, never> =>
  MigrateFlow.scan(chosen).pipe(
    Effect.map((scanned) => MigrateFlow.outlines(scanned, chosen)),
    Effect.orDie,
    Effect.provide(platform)
  )

const outlineOf = (
  root: string,
  chosen: Options.MigrateOptions,
  id: string
): Effect.Effect<Transform.UnitOutline, never, never> =>
  Effect.map(outlines(root, chosen), (all) => all.find((outline) => outline.id === id)!)

/** The checkpoint's file set: every source and every target, as the unit flow declares it. */
const owned = (outline: Transform.UnitOutline): ReadonlyArray<string> =>
  [...new Set([...outline.sources, ...outline.targets])].sort()

/** Everything outside the tool's own directory, which is where the backup lives. */
const project = (hashes: ReadonlyMap<string, string>): ReadonlyMap<string, string> =>
  new Map([...hashes].filter(([path]) => !path.startsWith(".smithers-migrate/")))

/** A legacy workflow without project commands or configuration. */
const bareWorkflow = (): string => {
  const root = copyFixture("jsx-single")
  for (const entry of readdirSync(root)) {
    if (entry !== "simple-workflow.jsx") rmSync(join(root, entry), { recursive: true, force: true })
  }
  return root
}

/** A verification every command of which passed, so `finish` reaches its checks. */
const passing: Report.VerificationResult = {
  install: { command: "", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "", skipped: "not needed here" },
  format: { command: "", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "", skipped: "not needed here" },
  typecheck: [],
  tests: { command: "", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "", skipped: "not needed here" },
  discovery: { command: "discovery flows", exitCode: 0, durationMs: 0, stdoutTail: "", stderrTail: "" }
}

const answered = (unit: string, changedFiles: ReadonlyArray<string>) => ({
  unit,
  changedFiles,
  decisions: [],
  unresolved: [],
  unsupported: [],
  notes: ""
})

describe("MigrateFlow.postconditions", () => {
  it.effect("refuses a workflow unit that produced no flow, and accepts the one that did", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const outline = yield* outlineOf(root, options(root), "workflow:simple-workflow")

      const missing = yield* MigrateFlow.postconditions(root, outline)
      expect(missing.find((check) => check.name === "the unit wrote the flow it was planned for")?.ok).toBe(false)

      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), "export default 1\n")

      const written = yield* MigrateFlow.postconditions(root, outline)
      expect(written.every((check) => check.ok)).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("keeps 0.x packages valid through dependencies, then requires their removal in project", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const dependencies = yield* outlineOf(root, options(root), "dependencies")
      const project = yield* outlineOf(root, options(root), "project")

      const dependenciesBefore = yield* MigrateFlow.postconditions(root, dependencies)
      expect(dependenciesBefore.find((check) => check.name === "no manifest declares a 0.x package"))
        .toBeUndefined()
      expect(
        dependenciesBefore.find((check) => check.name === "effect is pinned to the version this release ships")?.ok
      )
        .toBe(false)
      const projectBefore = yield* MigrateFlow.postconditions(root, project)
      expect(projectBefore.find((check) => check.name === "no manifest declares a 0.x package")?.findings[0]?.message)
        .toContain("smthrs")

      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>
      }
      manifest.dependencies["effect"] = "4.0.0-rc.115"
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)

      const dependenciesAfter = yield* MigrateFlow.postconditions(root, dependencies)
      expect(dependenciesAfter.every((check) => check.ok)).toBe(true)

      delete manifest.dependencies["smthrs"]
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      const projectAfter = yield* MigrateFlow.postconditions(root, project)
      expect(projectAfter.find((check) => check.name === "no manifest declares a 0.x package")?.ok).toBe(true)
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a unit that deleted the files its checks read, rather than passing on their absence", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const dependencies = yield* outlineOf(root, options(root), "dependencies")
      const project = yield* outlineOf(root, options(root), "project")
      // A manifest, a tsconfig, and the ignore file, all gone. The checks
      // that read them used to skip a missing file and pass.
      rmSync(join(root, "package.json"))
      rmSync(join(root, "tsconfig.json"))
      rmSync(join(root, ".gitignore"), { force: true })

      const byName = (
        checks: ReadonlyArray<{ name: string; ok: boolean; findings: ReadonlyArray<{ message: string }> }>
      ) => new Map(checks.map((check) => [check.name, check] as const))
      const dependenciesChecks = byName(yield* MigrateFlow.postconditions(root, dependencies))
      expect(dependenciesChecks.get("every manifest the unit owns still exists")?.ok).toBe(false)
      expect(dependenciesChecks.get("every manifest the unit owns still exists")?.findings[0]?.message)
        .toContain("manifest was deleted")

      const projectChecks = byName(yield* MigrateFlow.postconditions(root, project))
      expect(projectChecks.get("every manifest the unit owns still exists")?.ok).toBe(false)
      expect(
        projectChecks.get("no tsconfig configures the 0.x JSX runtime")?.findings.map((finding) => finding.message)
      )
        .toEqual(["the TypeScript configuration was deleted; a unit may rewrite it and may never remove it"])
      expect(projectChecks.get("the ignore file covers the 1.0 runtime state")?.findings[0]?.message)
        .toContain("there is no .gitignore")
    }).pipe(Effect.provide(platform)))

  it.effect("refuses a tsconfig that still configures the JSX runtime, and an ignore file without `.flows/`", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const outline = yield* outlineOf(root, options(root), "project")
      writeFileSync(join(root, ".gitignore"), "node_modules\n")

      const before = yield* MigrateFlow.postconditions(root, outline)
      const jsx = before.find((check) => check.name === "no tsconfig configures the 0.x JSX runtime")
      expect(jsx?.findings.map((finding) => finding.message)).toEqual([
        "compilerOptions.jsx still points at the 0.x JSX runtime",
        "compilerOptions.jsxImportSource still points at the 0.x JSX runtime"
      ])
      expect(before.find((check) => check.name === "the ignore file covers the 1.0 runtime state")?.ok).toBe(false)

      writeFileSync(join(root, ".gitignore"), "node_modules\n.flows/\n")
      writeFileSync(
        join(root, "tsconfig.json"),
        `${JSON.stringify({ compilerOptions: { strict: true } }, null, 2)}\n`
      )

      const after = yield* MigrateFlow.postconditions(root, outline)
      expect(after.find((check) => check.name === "no tsconfig configures the 0.x JSX runtime")?.ok).toBe(true)
      expect(after.find((check) => check.name === "the ignore file covers the 1.0 runtime state")?.ok).toBe(true)
    }).pipe(Effect.provide(platform)))
})

describe("MigrateFlow.finish", () => {
  for (
    const [name, generated, reason] of [
      [
        "object-first legacy factory",
        "import { Flow } from \"@smthrs/flow\"\nexport default Flow.make({ description: \"Real.\", model: \"anthropic:probe\" })\n",
        "Flow.make"
      ],
      [
        "tagged flow without payload",
        "import { Flow } from \"@smthrs/flow\"\nimport { Node } from \"@smthrs/plan\"\nexport default Flow.make(\"simple-workflow\", { description: \"Real.\", body: () => Node.succeed(1) })\n",
        "payload"
      ]
    ] as const
  ) {
    it.effect(`keeps the source when ${name} cannot load without a project typecheck`, () =>
      Effect.gen(function*() {
        const root = bareWorkflow()
        const chosen = options(root, { commands: { typecheck: [] } })
        const scanned = yield* MigrateFlow.scan(chosen)
        const outline = MigrateFlow.outlines(scanned, chosen).find((entry) => entry.id === "workflow:simple-workflow")!
        const source = join(root, "simple-workflow.jsx")
        const original = readFileSync(source, "utf8")
        const checkpoint = yield* Checkpoint.take({
          root,
          unit: outline.id,
          files: owned(outline),
          backupDir: join(root, ".smithers-migrate", "backup"),
          allowNoVcs: true,
          treeExclude: [".smithers-migrate"]
        })
        const target = join(root, "flows", "simple-workflow", "flow.ts")
        mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
        writeFileSync(target, generated)

        const verification = yield* Verify.run({ root, commands: { typecheck: [], flowsDir: "flows" } })
        expect(verification.typecheck).toEqual([])
        expect(Verify.verdict(verification)).toBe("pass")
        const outcome = yield* MigrateFlow.finish({
          options: chosen,
          outline,
          checkpoint,
          runStateRoots: [],
          result: answered(outline.id, ["flows/simple-workflow/flow.ts"]),
          verification,
          repairRounds: 0
        })

        expect(outcome.status).toBe("failed")
        expect(
          outcome.unresolved.find((entry) =>
            entry.construct === "every flow module's descriptor describes the flow it declares"
          )
        )
          .toMatchObject({ file: "flows/simple-workflow/flow.ts", reason: expect.stringContaining(reason) })
        expect(readFileSync(source, "utf8")).toBe(original)
        expect(existsSync(target)).toBe(false)
        expect(existsSync(join(root, ".smithers-migrate", "archive", "simple-workflow.jsx"))).toBe(false)
      }).pipe(Effect.provide(platform)))
  }

  it.effect("archives the source for a tagged flow with a body when no project typecheck is configured", () =>
    Effect.gen(function*() {
      const root = bareWorkflow()
      const chosen = options(root, { commands: { typecheck: [] } })
      const scanned = yield* MigrateFlow.scan(chosen)
      const outline = MigrateFlow.outlines(scanned, chosen).find((entry) => entry.id === "workflow:simple-workflow")!
      const source = join(root, "simple-workflow.jsx")
      const original = readFileSync(source, "utf8")
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: owned(outline),
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      })
      const target = join(root, "flows", "simple-workflow", "flow.ts")
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(target, golden)

      const verification = yield* Verify.run({ root, commands: { typecheck: [], flowsDir: "flows" } })
      expect(Verify.verdict(verification)).toBe("pass")
      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots: [],
        result: answered(outline.id, ["flows/simple-workflow/flow.ts"]),
        verification,
        repairRounds: 0
      })

      expect(outcome.status).toBe("migrated")
      expect(readFileSync(target, "utf8")).toBe(golden)
      expect(existsSync(source)).toBe(false)
      expect(readFileSync(join(root, ".smithers-migrate", "archive", "simple-workflow.jsx"), "utf8"))
        .toBe(original)
    }).pipe(Effect.provide(platform)))

  for (const verification of [passing, null]) {
    it.effect(`restores edits and an unexpected target directory when verification is ${verification === null ? "absent" : "passing"}`, () =>
      Effect.gen(function*() {
        const root = copyFixture("jsx-single")
        const chosen = options(root)
        const outline = {
          ...yield* outlineOf(root, chosen, "workflow:simple-workflow"),
          sources: ["a.txt"],
          targets: ["b.txt"]
        }
        writeFileSync(join(root, "a.txt"), "before\n")
        const checkpoint = yield* Checkpoint.take({
          root,
          unit: outline.id,
          files: owned(outline),
          backupDir: join(root, ".smithers-migrate", "backup"),
          allowNoVcs: true,
          treeExclude: [".smithers-migrate"]
        })
        writeFileSync(join(root, "a.txt"), "after\n")
        mkdirSync(join(root, "b.txt"))
        const settled = yield* Effect.result(MigrateFlow.finish({
          options: chosen,
          outline,
          checkpoint,
          runStateRoots: [],
          result: verification === null ? null : answered(outline.id, ["a.txt", "b.txt"]),
          verification,
          failure: "the agent gave up",
          repairRounds: 0
        }))

        expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("before\n")
        expect(existsSync(join(root, "b.txt"))).toBe(false)
        if (verification === null) {
          expect(settled).toMatchObject({ _tag: "Success", success: { status: "failed" } })
        } else {
          expect(settled).toMatchObject({
            _tag: "Failure",
            failure: { code: "io", message: "could not read b.txt while comparing it to the checkpoint" }
          })
          const pending = JSON.parse(readFileSync(join(root, ".smithers-migrate", "pending-unit.json"), "utf8"))
          expect(pending.rollback.restored).toEqual(["a.txt", "b.txt"])
        }
      }).pipe(Effect.provide(platform)))
  }

  it.effect("keeps executions-only run-state roots narrow beside a pre-existing config file", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      mkdirSync(join(root, ".smithers", "executions"), { recursive: true })
      writeFileSync(join(root, ".smithers", "executions", "before.log"), "existing execution\n")
      writeFileSync(join(root, ".smithers", "smithers.config.ts"), "export default {}\n")
      const chosen = options(root, { acknowledgeRunState: true })
      const scanned = yield* MigrateFlow.scan(chosen)
      const runStateRoots = MigrateFlow.runStateRoots(scanned)
      expect(runStateRoots).toEqual([".smithers/executions"])
      const outline = MigrateFlow.outlines(scanned, chosen).find((entry) => entry.id === "workflow:simple-workflow")!
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: owned(outline),
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        runStateRoots,
        treeExclude: [".smithers-migrate", ".flows"]
      })
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), golden)

      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots,
        result: answered(outline.id, ["flows/simple-workflow/flow.ts"]),
        verification: passing,
        repairRounds: 0
      })

      expect(outcome.unresolved).toEqual([])
      expect(outcome.status).toBe("migrated")
      expect(readFileSync(join(root, ".smithers", "smithers.config.ts"), "utf8")).toBe("export default {}\n")
      expect(readFileSync(join(root, ".smithers", "executions", "before.log"), "utf8")).toBe("existing execution\n")
    }).pipe(Effect.provide(platform)))

  it.effect("reports out-of-set damage even when verification failed before checks ran", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const chosen = options(root)
      const outline = yield* outlineOf(root, chosen, "workflow:simple-workflow")
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: owned(outline),
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      }).pipe(Effect.provide(platform))
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), golden)
      writeFileSync(join(root, "tests", "simple-workflow.test.ts"), "changed outside the unit\n")
      mkdirSync(join(root, "scratch"), { recursive: true })
      writeFileSync(join(root, "scratch", "operator-note.md"), "created while migration ran\n")

      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots: [],
        result: answered(outline.id, ["flows/simple-workflow/flow.ts"]),
        verification: {
          ...passing,
          tests: { command: "test", exitCode: 1, durationMs: 1, stdoutTail: "", stderrTail: "failed" }
        },
        repairRounds: 0
      }).pipe(Effect.provide(platform))

      expect(outcome.status).toBe("failed")
      const outside = outcome.unresolved.filter((entry) => entry.construct === "no write outside the unit's file set")
      expect(outside.map((entry) => entry.file).sort()).toEqual([
        "scratch/operator-note.md",
        "tests/simple-workflow.test.ts"
      ])
      expect(outcome.unresolved.find((entry) => entry.construct === "rollback could not restore a file")?.suggestion)
        .toContain(checkpoint.restore)
      expect(outcome.unresolved.find((entry) => entry.construct === "rollback deleted a post-checkpoint file")?.reason)
        .toContain("recovery copy")
    }).pipe(Effect.provide(platform)))

  it.effect("restores the unit when the archive cannot finish, rather than leaving a half-moved tree", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const chosen = options(root)
      const outline = yield* outlineOf(root, chosen, "workflow:simple-workflow")
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: owned(outline),
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      }).pipe(Effect.provide(platform))
      const before = hashTree(root)

      // The rewrite the unit was asked for: the committed 1.0 output, which
      // passes every deterministic check, so the archive is what fails.
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), golden)
      // And the archive directory, occupied by a file, so the first copy the
      // archive tries to write cannot create its parent.
      mkdirSync(join(root, ".smithers-migrate"), { recursive: true })
      writeFileSync(join(root, ".smithers-migrate", "archive"), "in the way\n")

      const failure = yield* Effect.flip(
        MigrateFlow.finish({
          options: chosen,
          outline,
          checkpoint,
          runStateRoots: [],
          result: answered(outline.id, ["flows/simple-workflow/flow.ts"]),
          verification: passing,
          repairRounds: 0
        }).pipe(Effect.provide(platform))
      )

      expect(failure.code).toBe("io")
      // Every source is back and the rewrite is gone: the failure left the
      // project as the checkpoint found it.
      const after = hashTree(root)
      for (const file of outline.sources) expect([file, after.get(file)]).toEqual([file, before.get(file)])
      expect(existsSync(join(root, "flows", "simple-workflow", "flow.ts"))).toBe(false)
    }))

  it.effect("measures the unit's own time, from its checkpoint", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const chosen = options(root)
      const outline = yield* outlineOf(root, chosen, "workflow:simple-workflow")
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: owned(outline),
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      }).pipe(Effect.provide(platform))

      // A run's earlier units are minutes this unit did not spend.
      yield* TestClock.adjust("7 minutes")

      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots: [],
        result: null,
        verification: null,
        failure: "the agent gave up",
        repairRounds: 3
      }).pipe(Effect.provide(platform))

      expect(outcome.status).toBe("failed")
      expect(outcome.durationMs).toBe(7 * 60_000)
      expect(yield* Clock.currentTimeMillis).toBe(checkpoint.takenAt + 7 * 60_000)
    }))
})

describe("MigrateFlow.finish verifies the tree it leaves behind", () => {
  const checkpointed = (root: string, outline: Transform.UnitOutline, runStateRoots: ReadonlyArray<string> = []) =>
    Checkpoint.take({
      root,
      unit: outline.id,
      files: owned(outline),
      backupDir: join(root, ".smithers-migrate", "backup"),
      allowNoVcs: true,
      runStateRoots,
      treeExclude: [".smithers-migrate", ".flows"]
    }).pipe(Effect.provide(platform))

  it.effect("fails a unit whose tests pass before the archive and fail after it, and restores it", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      // A test that passes only while the old source is still there: exactly
      // the tree the pre-archive verification vouched for and nobody keeps.
      const chosen = options(root, {
        commands: {
          typecheck: [],
          test: "node -e \"process.exit(require('node:fs').existsSync('simple-workflow.jsx') ? 0 : 1)\""
        }
      })
      const outline = yield* outlineOf(root, chosen, "workflow:simple-workflow")
      const checkpoint = yield* checkpointed(root, outline)
      const before = hashTree(root)
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), golden)

      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots: [],
        result: answered(outline.id, ["flows/simple-workflow/flow.ts"]),
        verification: passing,
        repairRounds: 0
      }).pipe(Effect.provide(platform))

      expect(outcome.status).toBe("failed")
      // The report carries the final verification, the one that failed.
      expect(outcome.verification?.tests?.exitCode).toBe(1)
      expect(outcome.unresolved.map((entry) => entry.construct)).toContain("the final tree verifies")
      // And the tree is back: every source, no flow, no archive.
      expect(project(hashTree(root))).toEqual(project(before))
      expect(existsSync(join(root, ".smithers-migrate", "archive", "simple-workflow.jsx"))).toBe(false)
    }))

  it.effect("records the verification of the final tree on a unit it calls migrated", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const chosen = options(root, {
        commands: {
          typecheck: [],
          test:
            "node -e \"process.stdout.write(require('node:fs').existsSync('simple-workflow.jsx') ? 'before' : 'after')\""
        }
      })
      const outline = yield* outlineOf(root, chosen, "workflow:simple-workflow")
      const checkpoint = yield* checkpointed(root, outline)
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), golden)

      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots: [],
        result: answered(outline.id, ["flows/simple-workflow/flow.ts"]),
        verification: {
          ...passing,
          tests: { command: "stale", exitCode: 0, durationMs: 0, stdoutTail: "before", stderrTail: "" }
        },
        repairRounds: 0
      }).pipe(Effect.provide(platform))

      expect(outcome.status).toBe("migrated")
      expect(outcome.verification?.tests?.stdoutTail).toBe("after")
      expect(outcome.verification?.discovery?.exitCode).toBe(0)
      expect(existsSync(join(root, "simple-workflow.jsx"))).toBe(false)
      // One entry per path: the archived source appears once, as archived.
      expect(outcome.changedFiles.filter((file) => file.path === "simple-workflow.jsx").map((file) => file.change))
        .toEqual(["archived"])
    }))

  it.effect("fails a unit whose final verification writes outside its file set, and removes the write", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const chosen = options(root, {
        commands: {
          typecheck: [],
          test:
            "node -e \"require('node:fs').mkdirSync('scratch', { recursive: true }); require('node:fs').writeFileSync('scratch/after.txt', 'x')\""
        }
      })
      const outline = yield* outlineOf(root, chosen, "workflow:simple-workflow")
      const checkpoint = yield* checkpointed(root, outline)
      const before = hashTree(root)
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), golden)

      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots: [],
        result: answered(outline.id, ["flows/simple-workflow/flow.ts"]),
        verification: passing,
        repairRounds: 0
      }).pipe(Effect.provide(platform))

      expect(outcome.status).toBe("failed")
      const outside = outcome.unresolved.find((entry) =>
        entry.construct === "no write outside the unit's file set after the archive"
      )
      expect(outside?.file).toBe("scratch/after.txt")
      expect(existsSync(join(root, "scratch", "after.txt"))).toBe(false)
      expect(project(hashTree(root))).toEqual(project(before))
    }))

  it.effect("fails a unit whose final verification writes into 0.x run state", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const chosen = options(root, {
        acknowledgeRunState: true,
        commands: {
          typecheck: [],
          test: "node -e \"require('node:fs').writeFileSync('.smithers/executions/after.log', 'resumed')\""
        }
      })
      const scanned = yield* MigrateFlow.scan(chosen).pipe(Effect.provide(platform))
      const outline = MigrateFlow.outlines(scanned, chosen).find((entry) => entry.id === "workflow:simple-workflow")!
      const checkpoint = yield* checkpointed(root, outline, MigrateFlow.runStateRoots(scanned))
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), golden)

      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots: MigrateFlow.runStateRoots(scanned),
        result: answered(outline.id, ["flows/simple-workflow/flow.ts"]),
        verification: passing,
        repairRounds: 0
      }).pipe(Effect.provide(platform))

      expect(outcome.status).toBe("failed")
      const added = outcome.unresolved.find((entry) => entry.file === ".smithers/executions/after.log")
      expect(added?.construct).toBe("run state is byte-identical")
      expect(added?.reason).toContain("run state was added")
      expect(existsSync(join(root, "simple-workflow.jsx"))).toBe(true)
    }))
})

describe("MigrateFlow.finish, after the archive has moved the tree", () => {
  it.effect("puts every archived source back when a postcondition fails after the archive", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const chosen = options(root)
      const outline = yield* outlineOf(root, chosen, "workflow:simple-workflow")
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: owned(outline),
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      }).pipe(Effect.provide(platform))
      const before = hashTree(root)

      // The agent answered without writing the flow it was planned for. Every
      // content check reads the files a unit changed, so with nothing changed
      // they all pass vacuously and the unit reaches the archive; the archive
      // moves every source aside; and the postcondition is what refuses it.
      // That is a failure *after* the tree has been moved, which is the arm no
      // restore that was computed before the archive can cover.
      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots: [],
        result: answered(outline.id, []),
        verification: passing,
        repairRounds: 0
      }).pipe(Effect.provide(platform))

      expect(outcome.status).toBe("failed")
      expect(outcome.unresolved.map((entry) => entry.construct))
        .toContain("the unit wrote the flow it was planned for")
      // Byte for byte, in both directions: nothing moved, nothing rewritten,
      // and nothing left behind.
      expect(project(hashTree(root))).toEqual(project(before))
      for (const source of outline.sources) expect([source, existsSync(join(root, source))]).toEqual([source, true])
      // And the archive copies of a unit that was put back are gone with it:
      // an archive is the record of a migration that happened.
      expect([...hashTree(root).keys()].filter((path) => path.startsWith(".smithers-migrate/archive/"))).toEqual([])
    }))

  it.effect("keeps a current UI dependency and import when finishing a mixed 0.x project", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>
      }
      manifest.dependencies["@smthrs/ui"] = "1.0.0-rc.1"
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      const uiImport = "import { Button } from \"@smthrs/ui\"\nexport { Button }\n"
      writeFileSync(join(root, "current-ui.ts"), uiImport)

      const chosen = options(root)
      const scanned = yield* MigrateFlow.scan(chosen).pipe(Effect.provide(platform))
      expect(scanned.detection.manifests.find((entry) => entry.kind === "root")?.oldPackages.map((entry) => entry.name))
        .toEqual(["smthrs"])
      expect(scanned.detection.imports.some((entry) => entry.specifier === "@smthrs/ui")).toBe(false)
      const outline = MigrateFlow.outlines(scanned, chosen).find((entry) => entry.id === "project")!
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), golden)
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: owned(outline),
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      }).pipe(Effect.provide(platform))
      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots: [],
        result: answered(outline.id, []),
        verification: passing,
        repairRounds: 0
      }).pipe(Effect.provide(platform))

      expect(outcome.status).toBe("migrated")
      const after = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>
      }
      expect(after.dependencies["@smthrs/ui"]).toBe("1.0.0-rc.1")
      expect(after.dependencies["smthrs"]).toBeUndefined()
      expect(readFileSync(join(root, "current-ui.ts"), "utf8")).toBe(uiImport)
    }))

  it.effect("removes the tsconfig paths key its own postcondition would refuse", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      // The verifier's repro: a project inside the old monorepo, which depends
      // on the facade by its bare directory name and maps that name in its
      // tsconfig. `Detect.isOldSpecifier` calls the key old because the
      // manifest declares the facade, so the postcondition refuses it; the
      // rewrite has to remove the same key, or the unit deterministically
      // fails a check the tool itself was supposed to satisfy.
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
        dependencies: Record<string, string>
      }
      manifest.dependencies["smithers"] = "file:../../smithers"
      writeFileSync(join(root, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`)
      const tsconfig = {
        compilerOptions: {
          strict: true,
          jsx: "react-jsx",
          jsxImportSource: "smthrs",
          paths: {
            "smithers": ["../../smithers/index.js"],
            "smithers/*": ["../../smithers/*"],
            "@app/*": ["./src/*"]
          }
        }
      }
      writeFileSync(join(root, "tsconfig.json"), `${JSON.stringify(tsconfig, null, 2)}\n`)

      const chosen = options(root)
      const outline = yield* outlineOf(root, chosen, "project")
      expect(outline.specifiers.localFacade).toBe(true)
      // The project unit verifies the final tree, discovery included, so the
      // flow the workflow unit would have written is already there.
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), golden)
      const checkpoint = yield* Checkpoint.take({
        root,
        unit: outline.id,
        files: owned(outline),
        backupDir: join(root, ".smithers-migrate", "backup"),
        allowNoVcs: true,
        treeExclude: [".smithers-migrate"]
      }).pipe(Effect.provide(platform))

      const outcome = yield* MigrateFlow.finish({
        options: chosen,
        outline,
        checkpoint,
        runStateRoots: [],
        result: answered(outline.id, []),
        verification: passing,
        repairRounds: 0
      }).pipe(Effect.provide(platform))

      expect(outcome.unresolved.map((entry) => entry.reason)).toEqual([])
      expect(outcome.status).toBe("migrated")
      const rewritten = JSON.parse(readFileSync(join(root, "tsconfig.json"), "utf8")) as {
        compilerOptions: { paths: Record<string, unknown> }
      }
      expect(rewritten.compilerOptions.paths).toEqual({ "@app/*": ["./src/*"] })
    }))
})
