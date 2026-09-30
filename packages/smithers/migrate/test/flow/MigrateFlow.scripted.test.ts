/**
 * `apply` end to end, with the model scripted and everything else real.
 *
 * The composition here is the production one: the kernel-guarded filesystem
 * over a pinned root, the grant store that denies run-state writes, the
 * capability envelope, the sandbox, the checkpoint, the verification, the
 * deterministic checks, and the archive. The one seam replaced is the seat, so
 * the test runs in CI with no key and still proves the machinery — the agent
 * writes through the `write` flow it was offered, exactly as a real one does.
 *
 * The rewrite it writes is `test/fixtures/jsx-single.migrated`, the committed
 * hand-written 1.0 output the deterministic checks already run against.
 *
 * @since 0.1.0
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import * as Checkpoint from "@smthrs/migrate/flow/Checkpoint"
import * as Command from "@smthrs/migrate/flow/Command"
import * as Layers from "@smthrs/migrate/flow/Layers"
import * as Lock from "@smthrs/migrate/flow/Lock"
import * as MigrateFlow from "@smthrs/migrate/flow/MigrateFlow"
import * as Transform from "@smthrs/migrate/flow/Transform"
import * as Effect from "effect/Effect"
import { execFileSync, spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { copyFixture, fixture, hashTree, nativeHelperAvailable } from "../fixtures/helpers.ts"

const golden = readFileSync(
  join(fixture("jsx-single.migrated"), "flows", "simple-workflow", "flow.ts"),
  "utf8"
)

/** A git checkout with one commit, so the checkpoint has a real ref to take. */
const committed = (root: string): void => {
  const git = (...args: ReadonlyArray<string>): void => {
    execFileSync("git", [...args], {
      cwd: root,
      stdio: "ignore",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "fixture",
        GIT_AUTHOR_EMAIL: "fixture@local",
        GIT_COMMITTER_NAME: "fixture",
        GIT_COMMITTER_EMAIL: "fixture@local"
      }
    })
  }
  git("init", "-q")
  git("add", "-A")
  git("commit", "-q", "-m", "fixture")
}

const options = (root: string, overrides: Partial<Command.MigrateOptions> = {}): Command.MigrateOptions => ({
  root,
  mode: "apply",
  // The project's own typecheck and tests still name the 0.x API, so a run
  // that used them would be measuring the fixture rather than the migration.
  // Overrides exist precisely so the tool never invents a command.
  commands: { typecheck: [], test: "node -e \"process.exit(0)\"" },
  ...overrides
})

/**
 * The scripted migration: the workflow unit writes the known-good flow through
 * the `write` flow it was offered; every other unit answers with an empty
 * result. Both answers are `UnitResult`s the declared schema accepts.
 */
const script = (root: string, written: Array<string>): Layers.Script => (asked) => {
  const unit = /# Unit `([^`]+)`/.exec(asked)?.[1] ?? "unknown"
  const result = {
    unit,
    changedFiles: unit === "workflow:simple-workflow" ? ["flows/simple-workflow/flow.ts"] : [],
    decisions: [],
    unresolved: [],
    unsupported: [],
    notes: "scripted"
  }
  if (unit !== "workflow:simple-workflow") return Layers.done(result)
  written.push(unit)
  // Relative to the project root, which is the workspace the kernel pinned:
  // the agent never sees, and never needs, an absolute path.
  return [
    `await ctx.call("write", { path: "flows/simple-workflow/flow.ts", content: ${JSON.stringify(golden)} })`,
    Layers.done(result)
  ].join("\n")
}

const apply = (
  root: string,
  overrides: Partial<Command.MigrateOptions> = {},
  scripted?: (root: string, written: Array<string>) => Layers.Script
) =>
  Effect.gen(function*() {
    const written: Array<string> = []
    const chosen = options(root, overrides)
    const surveyed = yield* Command.survey(chosen).pipe(
      Effect.provide(Layers.layerNodeScanned({ root, evaluator: ScriptedJudge.layer }))
    )
    const report = yield* Command.run(chosen).pipe(
      Effect.provide(Layers.layerScripted({
        root,
        commands: surveyed.commands,
        // The same list `Layers.layerNodeScanned` gives a real run, so the
        // grant rules a scripted test exercises are the production ones rather
        // than a broader stand-in.
        runStatePaths: Transform.runStatePaths(surveyed.scan),
        script: (scripted ?? script)(root, written)
      }))
    )
    return { report, written }
  })

/** The unchanged half of a script: every unit but the workflow answers empty. */
const emptyAnswer = (unit: string): string =>
  Layers.done({ unit, changedFiles: [], decisions: [], unresolved: [], unsupported: [], notes: "" })

const unitOf = (asked: string): string => /# Unit `([^`]+)`/.exec(asked)?.[1] ?? "unknown"

/**
 * An apply journey whose agent writes through the kernel-guarded filesystem,
 * which needs the native helper; see {@link nativeHelperAvailable}.
 */
const guarded = it.effect.skipIf(!nativeHelperAvailable)

describe("the native filesystem helper", () => {
  // Every journey below that writes through the agent is skipped without the
  // helper. CI builds it, so there a skip would hide the whole apply suite.
  it.skipIf(process.env.CI === undefined)("is present wherever CI runs this suite", () => {
    expect(nativeHelperAvailable).toBe(true)
  })
})

describe("apply over a single-file JSX project", () => {
  guarded("applies in a linked Git worktree with a native checkpoint", () =>
    Effect.gen(function*() {
      const main = copyFixture("jsx-single")
      committed(main)
      const linked = mkdtempSync(join(tmpdir(), "migrate-linked-worktree-"))
      try {
        execFileSync("git", ["worktree", "add", "--detach", linked, "HEAD"], { cwd: main, stdio: "ignore" })
        expect(statSync(join(linked, ".git")).isFile()).toBe(true)

        const { report } = yield* apply(linked)

        const checkpoint = report.units.find((unit) => unit.id === "workflow:simple-workflow")?.checkpoint
        expect(checkpoint?.vcs).toBe("git")
        expect(checkpoint?.ref).toContain("refs/smithers-migrate/")
        expect(
          execFileSync("git", ["rev-parse", "--verify", checkpoint!.ref], { cwd: linked, encoding: "utf8" })
            .trim()
        ).toMatch(/^[a-f0-9]{40,64}$/)
        expect(readFileSync(join(linked, "flows", "simple-workflow", "flow.ts"), "utf8")).toBe(golden)
      } finally {
        execFileSync("git", ["worktree", "remove", "--force", linked], { cwd: main, stdio: "ignore" })
        rmSync(linked, { recursive: true, force: true })
      }
    }))

  guarded(
    "migrates the workflow, checkpoints it, verifies it, and archives the old source",
    () =>
      Effect.gen(function*() {
        const root = copyFixture("jsx-single")
        committed(root)

        const { report, written } = yield* apply(root)

        expect(written).toEqual(["workflow:simple-workflow"])
        expect(report.mode).toBe("apply")
        const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
        expect(workflow?.status).toBe("migrated")
        // A checkpoint is a real git ref, and the report tells the operator how
        // to get back to it.
        expect(workflow?.checkpoint?.vcs).toBe("git")
        expect(workflow?.checkpoint?.ref).toContain("refs/smithers-migrate/")
        expect(workflow?.checkpoint?.restore).toContain("git checkout")
        expect(workflow?.verification?.discovery?.exitCode).toBe(0)

        // The rewrite is on disk and the old source is not.
        expect(readFileSync(join(root, "flows", "simple-workflow", "flow.ts"), "utf8")).toBe(golden)
        expect(existsSync(join(root, "simple-workflow.jsx"))).toBe(false)
        expect(
          existsSync(join(root, ".smithers-migrate", "archive", "simple-workflow.jsx"))
        ).toBe(true)
        // And the report is where the skill tells the operator to look.
        expect(existsSync(join(root, ".smithers-migrate", "report.md"))).toBe(true)
        expect(existsSync(join(root, MigrateFlow.unitArtifact(options(root), "workflow:simple-workflow")))).toBe(true)
      })
  )

  it.effect("skips the discovery check on the unit that writes no flow", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)

      const { report } = yield* apply(root)

      const dependencies = report.units.find((unit) => unit.id === "dependencies")
      expect(dependencies?.verification?.discovery?.skipped).toContain("writes no flow")
      const project = report.units.find((unit) => unit.id === "project")
      expect(project?.verification?.discovery?.skipped).toBeUndefined()
    }))

  it.effect("judges every step, taught to call jev", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)
      const asked: Array<string> = []

      yield* apply(root, {}, (root, written) => {
        const inner = script(root, written)
        return (text) => {
          asked.push(text)
          return inner(text)
        }
      })

      expect(asked.length).toBeGreaterThan(0)
      expect(asked.every((text) => text.includes(`await ctx.call("jev", {`))).toBe(true)
    }))

  guarded("keeps the old sources when the operator asks it to", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)

      yield* apply(root, { keepOldSources: true })

      expect(existsSync(join(root, "simple-workflow.jsx"))).toBe(true)
      expect(existsSync(join(root, "flows", "simple-workflow", "flow.ts"))).toBe(true)
    }))

  it.effect("is idempotent: a second run over the migrated tree changes no source", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)
      yield* apply(root)
      const after = hashTree(root)

      yield* apply(root)

      const again = hashTree(root)
      const sources = [...again.keys()].filter((path) =>
        !path.startsWith(".smithers-migrate/") && !path.startsWith(".git/")
      )
      for (const path of sources) {
        expect([path, again.get(path)]).toEqual([path, after.get(path)])
      }
    }))

  guarded("fails the unit that writes a file it does not own, and names every one", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)
      const before = hashTree(root)

      // Both writes are inside the agent's filesystem grant and neither is run
      // state, so nothing refuses them while they happen. The unit declares
      // neither, and the checkpoint's whole-tree manifest is what finds them:
      // the report is derived from the tree, never from what the unit said.
      const meddling = (_root: string, written: Array<string>): Layers.Script => (asked) => {
        const unit = unitOf(asked)
        if (unit !== "workflow:simple-workflow") return emptyAnswer(unit)
        written.push(unit)
        return [
          `await ctx.call("write", { path: "flows/simple-workflow/flow.ts", content: ${JSON.stringify(golden)} })`,
          `await ctx.call("write", { path: "tests/simple-workflow.test.ts", content: "made the tests pass" })`,
          `await ctx.call("write", { path: "scratch/notes.md", content: "notes" })`,
          Layers.done({
            unit,
            changedFiles: ["flows/simple-workflow/flow.ts"],
            decisions: [],
            unresolved: [],
            unsupported: [],
            notes: "scripted"
          })
        ].join("\n")
      }

      const { report } = yield* apply(root, {}, meddling)

      const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
      expect(workflow?.status).toBe("failed")
      const outside = workflow?.unresolved.filter((entry) => entry.construct === "no write outside the unit's file set")
      expect(outside?.map((entry) => entry.file).sort()).toEqual(["scratch/notes.md", "tests/simple-workflow.test.ts"])
      // A file it added can be put back exactly, by removing it. A file it
      // modified cannot — the checkpoint copied the unit's own files aside and
      // nothing else — so the report names the path and the way back.
      expect(existsSync(join(root, "scratch", "notes.md"))).toBe(false)
      expect(outside?.find((entry) => entry.file === "tests/simple-workflow.test.ts")?.reason)
        .toContain(workflow?.checkpoint?.restore ?? "impossible")
      // The unit itself is back where it started.
      const after = hashTree(root)
      expect(after.get("simple-workflow.jsx")).toBe(before.get("simple-workflow.jsx"))
      expect(existsSync(join(root, "flows", "simple-workflow", "flow.ts"))).toBe(false)
    }))

  guarded(
    "reports every rollback loss when verification fails before the outside-write check",
    () =>
      Effect.gen(function*() {
        const root = copyFixture("jsx-single")
        committed(root)

        const meddling = (_root: string, written: Array<string>): Layers.Script => (asked) => {
          const unit = unitOf(asked)
          if (unit !== "workflow:simple-workflow") return emptyAnswer(unit)
          written.push(unit)
          return [
            `await ctx.call("write", { path: "flows/simple-workflow/flow.ts", content: ${JSON.stringify(golden)} })`,
            `await ctx.call("write", { path: "tests/simple-workflow.test.ts", content: "changed outside the unit" })`,
            `await ctx.call("write", { path: "scratch/operator-note.md", content: "created while migration ran" })`,
            Layers.done({
              unit,
              changedFiles: ["flows/simple-workflow/flow.ts"],
              decisions: [],
              unresolved: [],
              unsupported: [],
              notes: "scripted"
            })
          ].join("\n")
        }

        const { report } = yield* apply(
          root,
          { maxRepairRounds: 0, commands: { typecheck: [], test: "node -e \"process.exit(1)\"" } },
          meddling
        )

        const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
        expect(workflow?.status).toBe("failed")
        const outside = workflow?.unresolved.filter((entry) =>
          entry.construct === "no write outside the unit's file set"
        )
        expect(outside?.map((entry) => entry.file).sort()).toEqual([
          "scratch/operator-note.md",
          "tests/simple-workflow.test.ts"
        ])
        const unrestored = workflow?.unresolved.find((entry) =>
          entry.construct === "rollback could not restore a file" && entry.file === "tests/simple-workflow.test.ts"
        )
        expect(unrestored?.suggestion).toContain(workflow?.checkpoint?.restore ?? "missing restore command")
        const deleted = workflow?.unresolved.find((entry) =>
          entry.construct === "rollback deleted a post-checkpoint file" && entry.file === "scratch/operator-note.md"
        )
        expect(deleted?.reason).toContain("recovery copy")
        expect(deleted?.suggestion).toContain("Copy")
        expect(existsSync(join(root, "scratch", "operator-note.md"))).toBe(false)
      })
  )

  it.effect("leaves a target that existed before the migration byte for byte when the unit fails", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      // The operator already has a file at the path the unit is going to
      // write. It is user data, and a failed unit owes it back exactly.
      const theirs = "// the operator's own flow, written before the migration\n"
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), theirs)
      committed(root)
      const before = hashTree(root)

      const { report } = yield* apply(
        root,
        { maxRepairRounds: 0, commands: { typecheck: [], test: "node -e \"process.exit(1)\"" } }
      )

      const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
      expect(workflow?.status).toBe("failed")
      expect(readFileSync(join(root, "flows", "simple-workflow", "flow.ts"), "utf8")).toBe(theirs)
      expect(hashTree(root).get("flows/simple-workflow/flow.ts")).toBe(before.get("flows/simple-workflow/flow.ts"))
      expect(hashTree(root).get("simple-workflow.jsx")).toBe(before.get("simple-workflow.jsx"))
      // A restored target is a restore, not a deletion with a recovery copy.
      expect(workflow?.unresolved.some((entry) => entry.construct === "rollback deleted a post-checkpoint file"))
        .toBe(false)
      expect(workflow?.unresolved.some((entry) => entry.construct === "rollback could not restore a file"))
        .toBe(false)
    }))

  guarded("fails the unit that smuggles a write into a path named like a lockfile", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)

      // An install rewrites the project's lockfile, so a lockfile is the one
      // write no unit declares and none is blamed for. That exemption is a
      // path, not a name: `src/pnpm-lock.yaml` is a file the agent invented in
      // a directory an install never writes, and it is an out-of-unit write
      // like any other.
      const smuggling = (_root: string, written: Array<string>): Layers.Script => (asked) => {
        const unit = unitOf(asked)
        if (unit !== "workflow:simple-workflow") return emptyAnswer(unit)
        written.push(unit)
        return [
          `await ctx.call("write", { path: "flows/simple-workflow/flow.ts", content: ${JSON.stringify(golden)} })`,
          `await ctx.call("write", { path: "src/pnpm-lock.yaml", content: "lockfileVersion: 9" })`,
          `await ctx.call("write", { path: "pnpm-lock.yaml", content: "lockfileVersion: 9" })`,
          Layers.done({
            unit,
            changedFiles: ["flows/simple-workflow/flow.ts"],
            decisions: [],
            unresolved: [],
            unsupported: [],
            notes: "scripted"
          })
        ].join("\n")
      }

      const { report } = yield* apply(root, {}, smuggling)

      const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
      expect(workflow?.status).toBe("failed")
      const outside = workflow?.unresolved.filter((entry) => entry.construct === "no write outside the unit's file set")
      // The nested one by name, and only it: the root lockfile is what an
      // install legitimately rewrites.
      expect(outside?.map((entry) => entry.file)).toEqual(["src/pnpm-lock.yaml"])
      expect(existsSync(join(root, "src", "pnpm-lock.yaml"))).toBe(false)
    }))

  guarded(
    "allows a root lockfile write while retaining it in the unit's changed-file report",
    () =>
      Effect.gen(function*() {
        // This independent successful apply has its own finite test budget.
        // The root lockfile is exempt from refusal and retained in the report.
        const installed = copyFixture("jsx-single")
        committed(installed)
        const installing = (_root: string, written: Array<string>): Layers.Script => (asked) => {
          const unit = unitOf(asked)
          if (unit !== "workflow:simple-workflow") return emptyAnswer(unit)
          written.push(unit)
          return [
            `await ctx.call("write", { path: "flows/simple-workflow/flow.ts", content: ${JSON.stringify(golden)} })`,
            `await ctx.call("write", { path: "pnpm-lock.yaml", content: "lockfileVersion: 9" })`,
            Layers.done({
              unit,
              changedFiles: ["flows/simple-workflow/flow.ts"],
              decisions: [],
              unresolved: [],
              unsupported: [],
              notes: "scripted"
            })
          ].join("\n")
        }

        const migrated = (yield* apply(installed, {}, installing)).report.units
          .find((unit) => unit.id === "workflow:simple-workflow")
        expect(migrated?.status).toBe("migrated")
        expect(migrated?.changedFiles.map((file) => file.path)).toContain("pnpm-lock.yaml")
      })
  )

  it.effect("never calls a unit that changed nothing migrated", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)
      const before = hashTree(root)

      // Every unit answers with an empty result, which is what an agent that
      // gave up looks like. The content checks read the files a unit changed,
      // so with nothing changed they all pass; what refuses the unit is the
      // project's own state — no flow to discover, and no flow at the path the
      // unit was planned for.
      const { report } = yield* apply(root, {}, () => (asked) => emptyAnswer(unitOf(asked)))

      const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
      expect(workflow?.status).toBe("failed")
      expect(workflow?.verification?.discovery?.exitCode).toBe(1)
      expect(report.units.every((unit) => unit.status !== "migrated" || unit.changedFiles.length > 0)).toBe(true)
      // Every source is where it was: a failed unit is restored, and a unit
      // that migrated nothing archived nothing.
      expect(hashTree(root).get("simple-workflow.jsx")).toBe(before.get("simple-workflow.jsx"))
    }))

  guarded("shows a repair round the sources as the round before it left them", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)
      const prompts: Array<string> = []
      const marker = "// the first round rewrote this line"

      // The tests fail every round, so the unit always reaches a repair round.
      // The first round edits one of its own sources; the second has to be
      // shown that edit, or it is being asked to diagnose a failure it cannot
      // see the cause of.
      const editing = (_root: string, written: Array<string>): Layers.Script => (asked) => {
        const unit = unitOf(asked)
        if (unit !== "workflow:simple-workflow") return emptyAnswer(unit)
        prompts.push(asked)
        written.push(unit)
        return [
          `await ctx.call("write", { path: "simple-workflow.jsx", content: ${JSON.stringify(`${marker}\n`)} })`,
          Layers.done({
            unit,
            changedFiles: ["simple-workflow.jsx"],
            decisions: [],
            unresolved: [],
            unsupported: [],
            notes: "scripted"
          })
        ].join("\n")
      }

      yield* apply(
        root,
        { maxRepairRounds: 1, commands: { typecheck: [], test: "node -e \"process.exit(1)\"" } },
        editing
      )

      expect(prompts).toHaveLength(2)
      expect(prompts[0]).toContain("<Workflow")
      expect(prompts[0]).not.toContain(marker)
      expect(prompts[1]).toContain(marker)
      expect(prompts[1]).toContain("Repair round 1")
    }))

  it.effect("refuses a project under no version control until the operator accepts a file copy", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const before = hashTree(root)

      const failure = yield* Effect.flip(apply(root))

      expect(failure.code).toBe("no-vcs")
      expect(failure.message).toContain("--allow-no-vcs")
      // Refusing is refusing: the checkpoint is the first thing a unit does,
      // so nothing has been written when it says no.
      expect(hashTree(root)).toEqual(before)
    }))

  guarded(
    "records a unit its own tooling could not finish, and carries on with the next",
    () =>
      Effect.gen(function*() {
        const root = copyFixture("jsx-single")
        committed(root)
        // The archive directory is a file, so the workflow unit's archive cannot
        // create its first parent and fails with the tool's own `io` error
        // after the rewrite verified. That error used to end the run and lose
        // every finished unit; now it is the unit's recorded outcome.
        mkdirSync(join(root, ".smithers-migrate"), { recursive: true })
        writeFileSync(join(root, ".smithers-migrate", "archive"), "in the way\n")
        const before = hashTree(root)

        const { report } = yield* apply(root)

        expect(report.exitCode).toBe(1)
        const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
        expect(workflow?.status).toBe("failed")
        const recorded = workflow?.unresolved.find((entry) => entry.construct === "the unit could not finish")
        expect(recorded?.reason).toMatch(/^io: could not create/)
        expect(recorded?.suggestion).toContain("--unit workflow:simple-workflow")
        // The unit that archives nothing finished, and the one after the failure ran.
        expect(report.units.find((unit) => unit.id === "dependencies")?.status).toBe("migrated")
        expect(report.units.map((unit) => unit.id)).toEqual(["dependencies", "workflow:simple-workflow", "project"])
        // The failed unit's files are as the checkpoint found them.
        expect(hashTree(root).get("simple-workflow.jsx")).toBe(before.get("simple-workflow.jsx"))
        expect(existsSync(join(root, "flows", "simple-workflow", "flow.ts"))).toBe(false)
        expect(existsSync(join(root, ".smithers-migrate", "report.md"))).toBe(true)
      })
  )

  guarded("accepts a file copy as the checkpoint when the operator says so", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")

      const { report } = yield* apply(root, { allowNoVcs: true })

      const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
      expect(workflow?.checkpoint?.vcs).toBe("none")
      expect(existsSync(join(root, "flows", "simple-workflow", "flow.ts"))).toBe(true)
      expect(
        existsSync(join(root, ".smithers-migrate", "backup", "workflow", "simple-workflow", "simple-workflow.jsx"))
      ).toBe(true)
    }))
})

/** The `persisted-db` fixture with its database built, committed, and hashed. */
const withRunState = Effect.gen(function*() {
  const root = copyFixture("persisted-db")
  const module = yield* Effect.promise(() =>
    import(pathToFileURL(join(fixture("persisted-db"), "make-db.mjs")).href) as Promise<{
      build: (target: string, now: number) => string
    }>
  )
  module.build(root, Date.now())
  committed(root)
  const before = hashTree(root)
  return { root, before }
})

/**
 * Every file the fixture holds that the report calls run state: the database,
 * the execution log, the workflow log, and the gateway's subscription file.
 *
 * `.smithers/smithers.config.ts` is deliberately not here. It is 0.x
 * configuration rather than run state, the report lists it under config, and
 * the project unit archives it like any other old source. It happens to share
 * a directory with run state, which is why this list is the paths and not the
 * directory.
 */
const runStateFiles = [
  ".smithers/claude-mirror-subscriptions.json",
  ".smithers/executions/run-1783757199651/stdout.log",
  ".smithers/smithers.db",
  ".smithers/workflows/run-1783757199651.log"
]

describe("apply over a project that still holds run state", () => {
  guarded("migrates it and leaves every run-state byte where it was", () =>
    Effect.gen(function*() {
      const { before, root } = yield* withRunState

      const { report } = yield* apply(root, { acknowledgeRunState: true })

      // The gate let it through, so every unit ran.
      expect(report.units.map((unit) => unit.status)).toEqual(["migrated", "migrated", "migrated"])
      expect(existsSync(join(root, "flows", "simple-workflow", "flow.ts"))).toBe(true)
      const after = hashTree(root)
      for (const file of runStateFiles) {
        expect([file, after.get(file)]).toEqual([file, before.get(file)])
      }
      // The database was really there to be left alone.
      expect(before.has(".smithers/smithers.db")).toBe(true)
    }))

  guarded("fails the unit that adds a file under a run-state root, and restores it", () =>
    Effect.gen(function*() {
      const { before, root } = yield* withRunState

      // The kernel permits this write: `.smithers/scratch.txt` is not one of
      // the paths the rules deny, it merely shares their directory. The
      // digests the checkpoint took are what catch it.
      const meddling = (_root: string, written: Array<string>): Layers.Script => (asked) => {
        const unit = unitOf(asked)
        if (unit !== "workflow:simple-workflow") return emptyAnswer(unit)
        written.push(unit)
        return [
          `await ctx.call("write", { path: "flows/simple-workflow/flow.ts", content: ${JSON.stringify(golden)} })`,
          `await ctx.call("write", { path: ".smithers/scratch.txt", content: "resume this" })`,
          Layers.done({
            unit,
            changedFiles: ["flows/simple-workflow/flow.ts"],
            decisions: [],
            unresolved: [],
            unsupported: [],
            notes: "scripted"
          })
        ].join("\n")
      }

      const { report } = yield* apply(root, { acknowledgeRunState: true }, meddling)

      const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
      expect(workflow?.status).toBe("failed")
      expect(workflow?.unresolved.map((entry) => entry.construct)).toContain("run state is byte-identical")
      expect(workflow?.unresolved.some((entry) => entry.reason.includes("run state was added"))).toBe(true)
      // The rewrite is rolled back with the unit, and the database it sat
      // beside never moved.
      expect(existsSync(join(root, "simple-workflow.jsx"))).toBe(true)
      expect(hashTree(root).get(".smithers/smithers.db")).toBe(before.get(".smithers/smithers.db"))
    }))

  guarded("refuses the agent's own write to the database", () =>
    Effect.gen(function*() {
      const { before, root } = yield* withRunState

      // This one the kernel answers before any check runs: `.smithers/smithers.db`
      // is a denied path, and a configured denial is a veto no envelope and no
      // remembered grant can lift. The cell carries what it was told out in its
      // own answer, because a file it never declared would now fail the unit —
      // which is the point of the out-of-unit check, and was the hole this test
      // used to walk through.
      const meddling = (_root: string, written: Array<string>): Layers.Script => (asked) => {
        const unit = unitOf(asked)
        if (unit !== "workflow:simple-workflow") return emptyAnswer(unit)
        written.push(unit)
        return [
          // A refused call resolves rather than throws, so the answer is a
          // value the cell can put in its report entry.
          `const answered = await ctx.call("write", { path: ".smithers/smithers.db", content: "clobbered" })`,
          `await ctx.call("write", { path: "flows/simple-workflow/flow.ts", content: ${JSON.stringify(golden)} })`,
          `ctx.done(JSON.stringify({`,
          `  unit: ${JSON.stringify("workflow:simple-workflow")},`,
          `  changedFiles: ["flows/simple-workflow/flow.ts"],`,
          `  decisions: [],`,
          `  unresolved: [{`,
          `    construct: "the write the kernel refused",`,
          `    reason: JSON.stringify(answered),`,
          `    file: "simple-workflow.jsx",`,
          `    line: 1,`,
          `    suggestion: "nothing: the refusal is the assertion"`,
          `  }],`,
          `  unsupported: [],`,
          `  notes: "scripted"`,
          `}))`
        ].join("\n")
      }

      const { report } = yield* apply(root, { acknowledgeRunState: true }, meddling)

      const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
      const refused = workflow?.unresolved.find((entry) => entry.construct === "the write the kernel refused")
      const answered = JSON.parse(refused?.reason ?? "{}") as {
        ok: boolean
        error?: { code: string; message: string }
      }
      expect(answered.ok).toBe(false)
      expect(answered.error?.message).toContain(".smithers/smithers.db")
      // The unit still migrated: a refused call is an answer, and the rewrite
      // it went on to make is inside its own file set.
      expect(workflow?.status).toBe("migrated")
      expect(hashTree(root).get(".smithers/smithers.db")).toBe(before.get(".smithers/smithers.db"))
    }))

  guarded(
    "refuses the agent's own read of the database and its listing of the execution logs",
    () =>
      Effect.gen(function*() {
        const { before, root } = yield* withRunState

        // Reading is copying: a database read into a model call has left the
        // machine. The kernel answers before the bytes move, on the exact path
        // and on everything under a run-state root, and the cell carries each
        // answer out in its report so the refusal is the assertion.
        const meddling = (_root: string, written: Array<string>): Layers.Script => (asked) => {
          const unit = unitOf(asked)
          if (unit !== "workflow:simple-workflow") return emptyAnswer(unit)
          written.push(unit)
          return [
            `const read = await ctx.call("read", { path: ".smithers/smithers.db" })`,
            `const listed = await ctx.call("ls", { path: ".smithers/executions" })`,
            `const log = await ctx.call("read", { path: ".smithers/executions/run-1783757199651/stdout.log" })`,
            `const source = await ctx.call("read", { path: "simple-workflow.jsx" })`,
            `await ctx.call("write", { path: "flows/simple-workflow/flow.ts", content: ${JSON.stringify(golden)} })`,
            `ctx.done(JSON.stringify({`,
            `  unit: ${JSON.stringify("workflow:simple-workflow")},`,
            `  changedFiles: ["flows/simple-workflow/flow.ts"],`,
            `  decisions: [],`,
            `  unresolved: [`,
            `    { construct: "read database", reason: JSON.stringify(read), file: "simple-workflow.jsx", line: 1, suggestion: "none" },`,
            `    { construct: "list executions", reason: JSON.stringify(listed), file: "simple-workflow.jsx", line: 1, suggestion: "none" },`,
            `    { construct: "read log", reason: JSON.stringify(log), file: "simple-workflow.jsx", line: 1, suggestion: "none" },`,
            `    { construct: "read source", reason: JSON.stringify(source), file: "simple-workflow.jsx", line: 1, suggestion: "none" }`,
            `  ],`,
            `  unsupported: [],`,
            `  notes: "scripted"`,
            `}))`
          ].join("\n")
        }

        const { report } = yield* apply(root, { acknowledgeRunState: true }, meddling)

        const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
        const answer = (construct: string) =>
          JSON.parse(workflow?.unresolved.find((entry) => entry.construct === construct)?.reason ?? "{}") as {
            ok: boolean
            error?: { message: string }
          }
        expect(answer("read database").ok).toBe(false)
        expect(answer("read database").error?.message).toContain(".smithers/smithers.db")
        expect(answer("list executions").ok).toBe(false)
        expect(answer("read log").ok).toBe(false)
        // A source that merely shares the directory is still the agent's to read:
        // the answer is the file, not a refusal.
        const source = workflow?.unresolved.find((entry) => entry.construct === "read source")?.reason ?? ""
        expect(source).toContain("Workflow")
        expect(source).not.toContain("\"ok\":false")
        expect(workflow?.status).toBe("migrated")
        expect(hashTree(root).get(".smithers/smithers.db")).toBe(before.get(".smithers/smithers.db"))
      })
  )

  guarded("lets a unit rewrite a file at the project root", () =>
    Effect.gen(function*() {
      const { root } = yield* withRunState

      // `package.json` is the dependencies unit's whole job, and its parent
      // directory is the project root. A rule set that grants only `<root>/**`
      // refuses the directory creation `write` does first, so the one file the
      // unit exists to edit is the one file it cannot write.
      const manifest = `{\n  "name": "migrated",\n  "type": "module"\n}\n`
      const rewriting = (_root: string, written: Array<string>): Layers.Script => (asked) => {
        const unit = unitOf(asked)
        if (unit !== "dependencies") return script(root, written)(asked)
        return [
          `await ctx.call("write", { path: "package.json", content: ${JSON.stringify(manifest)} })`,
          Layers.done({
            unit,
            changedFiles: ["package.json"],
            decisions: [],
            unresolved: [],
            unsupported: [],
            notes: "scripted"
          })
        ].join("\n")
      }

      yield* apply(root, { acknowledgeRunState: true, keepOldSources: true }, rewriting)

      expect(readFileSync(join(root, "package.json"), "utf8")).toBe(manifest)
    }))
})

describe("apply under the canonical project's lock", () => {
  // Each recovery journey performs up to three refused launches and one
  // complete apply through real filesystem/process services. Its finite
  // budget covers all four attempts; individual apply tests retain 60 s.
  for (const originalReport of [".smithers-migrate", "audit/original"]) {
    guarded(
      `preserves the pending checkpoint in ${originalReport} through retries and resumes after recovery`,
      () =>
        Effect.gen(function*() {
          const root = copyFixture("jsx-single")
          committed(root)
          const source = join(root, "simple-workflow.jsx")
          const original = readFileSync(source, "utf8")
          const held = yield* Lock.acquire({ root, reportDir: originalReport }).pipe(Effect.provide(NodeServices.layer))
          const backupDir = join(root, originalReport, "backup")
          const checkpoint = yield* Checkpoint.take({
            root,
            unit: "workflow:simple-workflow",
            files: ["simple-workflow.jsx"],
            backupDir,
            allowNoVcs: false,
            treeExclude: [originalReport, ".smithers-migrate"]
          }).pipe(Effect.provide(NodeServices.layer))
          writeFileSync(source, `${original}\n// interrupted conversion\n`)
          yield* Lock.release(held).pipe(Effect.provide(NodeServices.layer))
          const before = hashTree(root)
          for (const retryReport of new Set([originalReport, ".smithers-migrate", "audit/retry"])) {
            const refused = yield* Effect.flip(apply(root, { reportDir: retryReport }))
            expect(refused.code).toBe("checkpoint-failed")
            expect(refused.message).toContain(`${originalReport}/pending-unit.json`)
            expect(hashTree(root)).toEqual(before)
          }
          yield* Checkpoint.restore(root, checkpoint, ["simple-workflow.jsx"]).pipe(Effect.provide(NodeServices.layer))
          expect(readFileSync(source, "utf8")).toBe(original)
          yield* Checkpoint.clearPending(backupDir, checkpoint).pipe(Effect.provide(NodeServices.layer))
          const { report } = yield* apply(root, { reportDir: originalReport })
          expect(report.units.every((unit) => unit.status === "migrated")).toBe(true)
          expect(existsSync(join(root, originalReport, "pending-unit.json"))).toBe(false)
        }),
      180_000
    )
  }

  it.effect("refuses to start while another apply holds the lock, and leaves the project alone", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)
      // Held by this process, which is alive: exactly what a concurrent apply
      // in another process looks like to the lock.
      const held = yield* Lock.acquire({ root, reportDir: ".smithers-migrate" }).pipe(
        Effect.provide(NodeServices.layer)
      )

      const failure = yield* Effect.flip(apply(root, { reportDir: "audit" }))

      expect(failure.code).toBe("apply-in-progress")
      expect(failure.message).toContain(`pid ${process.pid}`)
      // Nothing ran: no pending marker, no backups, the source untouched.
      expect(existsSync(join(root, ".smithers-migrate", "pending-unit.json"))).toBe(false)
      expect(existsSync(join(root, ".smithers-migrate", "backup"))).toBe(false)
      expect(existsSync(join(root, "audit"))).toBe(false)
      expect(existsSync(join(root, "simple-workflow.jsx"))).toBe(true)

      yield* Lock.release(held).pipe(Effect.provide(NodeServices.layer))
    }))

  guarded(
    "takes over a dead run's lock, notes it in the report, and gives the lock back",
    () =>
      Effect.gen(function*() {
        const root = copyFixture("jsx-single")
        committed(root)
        // A lock whose pid is gone: a process that really ran and really exited.
        const pid = spawnSync(process.execPath, ["-e", ""]).pid
        mkdirSync(join(root, ".smithers-migrate"), { recursive: true })
        writeFileSync(
          join(root, ".smithers-migrate", "apply.lock"),
          `${JSON.stringify({ pid, startedAt: "2026-01-01T00:00:00.000Z", root, reportDir: "previous-report" })}\n`
        )

        const { report } = yield* apply(root, { reportDir: "audit" })

        expect(report.units.every((unit) => unit.status === "migrated")).toBe(true)
        const note = report.followUps.find((entry) => entry.severity === "info" && entry.text.includes(String(pid)))
        expect(note?.text).toContain("took over the lock")
        expect(note?.text).toContain("previous-report/pending-unit.json")
        // The report on disk carries the note, and the run gave the lock back.
        expect(readFileSync(join(root, "audit", "report.json"), "utf8")).toContain("took over the lock")
        expect(existsSync(join(root, ".smithers-migrate", "apply.lock"))).toBe(false)
        expect(existsSync(join(root, ".smithers-migrate", "apply.lock.sqlite"))).toBe(true)
      })
  )
})
