/**
 * The sealed plan, and the step that refuses to edit a tree it no longer
 * describes.
 *
 * A unit id survives every edit to what it names, so a gate that compares ids
 * lets an approved plan edit a project that changed underneath it. The seal
 * digests everything the plan says about the tree and every byte of every
 * path it will touch, and the seal step recomputes it from a fresh read
 * immediately before the first checkpoint.
 *
 * @since 0.1.0
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import { describe, expect, it } from "@effect/vitest"
import * as Command from "@smthrs/migrate/flow/Command"
import * as Layers from "@smthrs/migrate/flow/Layers"
import * as MigrateFlow from "@smthrs/migrate/flow/MigrateFlow"
import * as Transform from "@smthrs/migrate/flow/Transform"
import type { MigrateError } from "@smthrs/migrate/MigrateError"
import * as Scan from "@smthrs/migrate/Scan"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { copyFixture, fixture, hashTree, nativeHelperAvailable, nodeLayer } from "../fixtures/helpers.ts"

const golden = readFileSync(join(fixture("jsx-single.migrated"), "flows", "simple-workflow", "flow.ts"), "utf8")

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

const options = (root: string): Command.MigrateOptions => ({
  root,
  mode: "apply",
  commands: { typecheck: [], test: "node -e \"process.exit(0)\"" }
})

const script: Layers.Script = (asked) => {
  const unit = /# Unit `([^`]+)`/.exec(asked)?.[1] ?? "unknown"
  const result = { unit, changedFiles: [] as Array<string>, decisions: [], unresolved: [], unsupported: [], notes: "" }
  if (unit !== "workflow:simple-workflow") return Layers.done(result)
  return [
    `await ctx.call("write", { path: "flows/simple-workflow/flow.ts", content: ${JSON.stringify(golden)} })`,
    Layers.done({ ...result, changedFiles: ["flows/simple-workflow/flow.ts"] })
  ].join("\n")
}

/** Survey, then launch the flow over that survey, on the scripted composition. */
const launch = (root: string, surveyed: Command.Survey) =>
  Command.launch(options(root), surveyed).pipe(
    Effect.provide(Layers.layerScripted({
      root,
      commands: surveyed.commands,
      runStatePaths: Transform.runStatePaths(surveyed.scan),
      script
    }))
  )

const survey = (root: string) => Command.survey(options(root)).pipe(Effect.provide(nodeLayer))

/**
 * An apply journey whose agent writes through the kernel-guarded filesystem,
 * which needs the native helper; see {@link nativeHelperAvailable}.
 */
const guarded = it.effect.skipIf(!nativeHelperAvailable)

/** The package's own error, or a failed assertion naming what arrived instead. */
const migrateError = (failure: unknown): MigrateError => {
  if (!Command.isMigrateError(failure)) throw new Error(`expected a MigrateError, received ${String(failure)}`)
  return failure
}

describe("MigrateFlow.planSeal", () => {
  it.effect("digests the same tree to the same seal, and one changed byte to a different one", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const chosen = options(root)
      const scanned = yield* Scan.scan(root, { flowsDir: "flows" })

      const first = yield* MigrateFlow.planSeal(scanned, chosen)
      const again = yield* MigrateFlow.planSeal(scanned, chosen)
      expect(again).toEqual(first)
      expect(first.digest).toMatch(/^[a-f0-9]{64}$/)
      // Every source and every target the units name, present ones digested
      // and absent ones recorded as absent.
      expect(first.files.find((file) => file.path === "simple-workflow.jsx")?.state).toBe("file")
      expect(first.files.find((file) => file.path === "flows/simple-workflow/flow.ts")).toEqual({
        path: "flows/simple-workflow/flow.ts",
        state: "absent"
      })

      writeFileSync(
        join(root, "simple-workflow.jsx"),
        `${readFileSync(join(root, "simple-workflow.jsx"), "utf8")}// edited\n`
      )
      const edited = yield* MigrateFlow.planSeal(yield* Scan.scan(root, { flowsDir: "flows" }), chosen)
      expect(edited.digest).not.toBe(first.digest)
      expect(MigrateFlow.sealDifferences(first, edited)).toEqual(["simple-workflow.jsx: content changed"])

      // The layout is part of what the plan says, so a different flows
      // directory is a different plan over the same bytes.
      const elsewhere = yield* MigrateFlow.planSeal(
        yield* Scan.scan(root, { flowsDir: "src/flows" }),
        { ...chosen, layout: { flowsDir: "src/flows" } }
      )
      expect(elsewhere.digest).not.toBe(edited.digest)
    }).pipe(Effect.provide(nodeLayer)))

  it("names what changed between two seals, in both directions", () => {
    const planned: MigrateFlow.PlanSeal = {
      digest: "a",
      files: [
        { path: "a.jsx", state: "file", digest: "1" },
        { path: "b.jsx", state: "file", digest: "2" },
        { path: "flows/a/flow.ts", state: "absent" },
        { path: "gone.jsx", state: "file", digest: "3" }
      ]
    }
    const current: MigrateFlow.PlanSeal = {
      digest: "b",
      files: [
        { path: "a.jsx", state: "file", digest: "1" },
        { path: "b.jsx", state: "file", digest: "9" },
        { path: "flows/a/flow.ts", state: "file", digest: "4" },
        { path: "new.jsx", state: "file", digest: "5" }
      ]
    }
    expect(MigrateFlow.sealDifferences(planned, current)).toEqual([
      "b.jsx: content changed",
      "flows/a/flow.ts: was absent, is now file",
      "gone.jsx: no longer part of the plan",
      "new.jsx: newly part of the plan"
    ])
  })
})

describe("the seal step", () => {
  it.effect("refuses an apply whose sources changed after the survey, and touches nothing", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)
      const surveyed = yield* survey(root)
      // The same unit ids, a different file: exactly what an id-only gate
      // waves through. The workflow keeps its JSX, so the plan's units are
      // unchanged and only the bytes differ.
      const source = join(root, "simple-workflow.jsx")
      writeFileSync(source, `${readFileSync(source, "utf8")}// edited by the operator after planning\n`)
      const before = hashTree(root)

      const failure = migrateError(yield* Effect.flip(launch(root, surveyed)))

      expect(failure.code).toBe("stale-plan")
      expect(failure.details).toContain("simple-workflow.jsx: content changed")
      expect(hashTree(root)).toEqual(before)
      expect(existsSync(join(root, "flows"))).toBe(false)
    }))

  it.effect("refuses when a target appeared after the survey", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      committed(root)
      const surveyed = yield* survey(root)
      mkdirSync(join(root, "flows", "simple-workflow"), { recursive: true })
      writeFileSync(join(root, "flows", "simple-workflow", "flow.ts"), "export const theirs = 1\n")

      const failure = migrateError(yield* Effect.flip(launch(root, surveyed)))

      expect(failure.code).toBe("stale-plan")
      expect(failure.details).toContain("flows/simple-workflow/flow.ts: was absent, is now file")
    }))

  guarded(
    "accepts the tree it sealed, and clears the artifacts of an earlier run before the first unit",
    () =>
      Effect.gen(function*() {
        const root = copyFixture("jsx-single")
        committed(root)
        // What a crashed earlier run leaves behind: an artifact for a unit id
        // this run also plans. Read back, it would report that unit as
        // finished by a run that never ran it.
        const stale = join(root, MigrateFlow.unitArtifact(options(root), "workflow:simple-workflow"))
        mkdirSync(join(stale, ".."), { recursive: true })
        writeFileSync(stale, JSON.stringify({ id: "workflow:simple-workflow", status: "migrated" }))
        const surveyed = yield* survey(root)

        const report = yield* launch(root, surveyed)

        const workflow = report.units.find((unit) => unit.id === "workflow:simple-workflow")
        expect(workflow?.status).toBe("migrated")
        expect(workflow?.changedFiles.length).toBeGreaterThan(0)
        // The artifact on disk is this run's: it decodes, and it is the unit's real outcome.
        const recorded = JSON.parse(readFileSync(stale, "utf8")) as { id: string; repairRounds: number }
        expect(recorded.id).toBe("workflow:simple-workflow")
        expect(recorded.repairRounds).toBe(0)
      })
  )
})

describe("unit artifacts", () => {
  const chosen: Command.MigrateOptions = { root: "/w", mode: "apply" }

  it("never give two unit ids one file, however alike they read", () => {
    const ids = ["workflow:a/b", "workflow:a-b", "workflow:a_b", "workflow:A/b", "workflow:a/b/", "project", "Project"]
    const files = ids.map((id) => MigrateFlow.unitArtifact(chosen, id))
    expect(new Set(files.map((file) => file.toLowerCase())).size).toBe(ids.length)
    for (const file of files) expect(file).toMatch(/^\.smithers-migrate\/units\/[A-Za-z0-9._-]+-[a-f0-9]{16}\.json$/)
    expect(MigrateFlow.unitArtifact(chosen, "workflow:a/b")).toContain("workflow-a-b-")
  })

  it.effect("are read back only for the unit they were written for", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const here = options(root)
      const wrong = join(root, MigrateFlow.unitArtifact(here, "workflow:simple-workflow"))
      mkdirSync(join(wrong, ".."), { recursive: true })
      writeFileSync(
        wrong,
        JSON.stringify({
          id: "project",
          kind: "project",
          sources: [],
          targets: [],
          status: "migrated",
          changedFiles: [],
          decisions: [],
          unresolved: [],
          unsupported: [],
          repairRounds: 0,
          durationMs: 0
        })
      )

      const failure = yield* Effect.flip(MigrateFlow.readUnitReport(here, "workflow:simple-workflow"))
      expect(failure.code).toBe("io")
      expect(failure.message).toContain("belongs to unit \"project\"")

      expect(yield* MigrateFlow.readUnitReport(here, "dependencies")).toBeUndefined()

      writeFileSync(wrong, "{ not json")
      const corrupt = yield* Effect.flip(MigrateFlow.readUnitReport(here, "workflow:simple-workflow"))
      expect(corrupt.code).toBe("io")
      expect(corrupt.message).toContain("could not be read back")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("make a unit with no recorded outcome a failed unit, so an incomplete apply exits 1", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const here = options(root)
      const scanned = yield* Scan.scan(root, { flowsDir: "flows" })
      const planned = Scan.toReport(scanned, "apply", "2026-09-01T00:00:00.000Z")

      const report = yield* MigrateFlow.writeReport({
        options: here,
        report: planned,
        unitIds: planned.units.map((unit) => unit.id)
      })

      expect(report.units.map((unit) => unit.status)).toEqual(["failed", "failed", "failed"])
      expect(report.exitCode).toBe(1)
      const missing = report.units[1]?.unresolved[0]
      expect(missing?.construct).toBe("no recorded outcome")
      expect(missing?.suggestion).toContain("--unit workflow:simple-workflow")
      expect(report.followUps.some((entry) => entry.text.includes("workflow:simple-workflow"))).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer)))
})
