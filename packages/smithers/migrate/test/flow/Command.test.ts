/**
 * The entry point's contract: what the flags decode to, what the exit code
 * says, what a person reads, and the one property `scan` mode has to have —
 * it changes nothing.
 *
 * @since 0.1.0
 */
import { describe, expect, it } from "@effect/vitest"
import * as Command from "@smthrs/migrate/flow/Command"
import * as Options from "@smthrs/migrate/flow/Options"
import { MigrateError } from "@smthrs/migrate/MigrateError"
import * as Report from "@smthrs/migrate/Report"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { mkdirSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { copyFixture, hashTree, nodeLayer } from "../fixtures/helpers.ts"

const flags = (overrides: Partial<Command.Flags> = {}): Command.Flags => ({
  root: undefined,
  scan: false,
  apply: false,
  seat: undefined,
  allowUnsafe: undefined,
  acknowledgeRunState: false,
  allowNoVcs: false,
  keepOldSources: false,
  unit: undefined,
  maxRepairRounds: undefined,
  reportDir: undefined,
  flowsDir: undefined,
  verifyInstall: undefined,
  verifyFormat: undefined,
  verifyTypecheck: undefined,
  verifyTest: undefined,
  ...overrides
})

const decode = Schema.decodeUnknownSync(Options.MigrateOptions)

describe("Command.optionsOf", () => {
  it("plans by default, in the directory the operator is standing in", () => {
    const options = Command.optionsOf(flags(), "/work/project")

    expect(options.mode).toBe("plan")
    expect(options.root).toBe(resolve("/work/project"))
    expect(options.seat).toBeUndefined()
    expect(Options.reportDir(options)).toBe(".smithers-migrate")
    expect(Options.flowsDir(options)).toBe("flows")
    expect(Options.maxRepairRounds(options)).toBe(3)
  })

  it("resolves an explicit relative root at the command seam", () => {
    expect(Command.optionsOf(flags({ root: "." }), "/ignored").root).toBe(resolve("."))
    expect(Command.optionsOf(flags({ root: "../old" }), "/ignored").root).toBe(resolve("../old"))
    expect(Command.optionsOf(flags({ root: "project" }), "project").root).toBe(resolve("project"))
  })

  it("obeys the safer of two contradictory modes", () => {
    expect(Command.optionsOf(flags({ scan: true, apply: true }), "/work").mode).toBe("scan")
    expect(Command.optionsOf(flags({ apply: true }), "/work").mode).toBe("apply")
  })

  it("reads a waiver list, and reads `all` as the whole waiver", () => {
    expect(Command.optionsOf(flags({ allowUnsafe: "UI, Worktree" }), "/w").allowUnsafe).toEqual(["UI", "Worktree"])
    expect(Command.optionsOf(flags({ allowUnsafe: "all" }), "/w").allowUnsafe).toBe("all")
    expect(Command.optionsOf(flags({ allowUnsafe: "" }), "/w").allowUnsafe).toEqual([])
  })

  it("carries every remaining flag onto the flow's payload", () => {
    const options = Command.optionsOf(
      flags({
        root: "/elsewhere",
        apply: true,
        seat: "anthropic:some-model",
        acknowledgeRunState: true,
        allowNoVcs: true,
        keepOldSources: true,
        unit: "dependencies,workflow:simple-workflow",
        maxRepairRounds: 1,
        reportDir: ".out",
        flowsDir: "src/flows"
      }),
      "/ignored"
    )

    expect(options).toEqual({
      root: resolve("/elsewhere"),
      mode: "apply",
      seat: "anthropic:some-model",
      acknowledgeRunState: true,
      allowNoVcs: true,
      keepOldSources: true,
      units: ["dependencies", "workflow:simple-workflow"],
      maxRepairRounds: 1,
      reportDir: ".out",
      layout: { flowsDir: "src/flows" }
    })
    // The payload has to survive the journal, so it has to decode.
    expect(decode(options)).toEqual(options)
    expect(Options.reportDir(options)).toBe(".out")
    expect(Options.flowsDir(options)).toBe("src/flows")
    expect(Options.maxRepairRounds(options)).toBe(1)
  })

  it("refuses a mode the flow does not have", () => {
    expect(() => decode({ root: "/w", mode: "fix" })).toThrow()
  })
})

const reportWith = (
  mode: Report.Mode,
  units: ReadonlyArray<Partial<Report.UnitReport>>,
  options: Report.FinalizeOptions = {}
): Report.MigrationReport => {
  const base = Report.empty("/work", mode, "2026-08-29T00:00:00.000Z")
  const withUnits = units.reduce(
    (report, unit) =>
      Report.withUnit(report, {
        id: "unit",
        kind: "workflow",
        sources: [],
        targets: [],
        status: "planned",
        changedFiles: [],
        decisions: [],
        unresolved: [],
        unsupported: [],
        repairRounds: 0,
        durationMs: 0,
        ...unit
      }),
    base
  )
  return Report.finalize(withUnits, options)
}

describe("Command.optionsOf verification overrides", () => {
  it("carries every override onto the payload, and says nothing when the operator named none", () => {
    expect(Command.optionsOf(flags(), "/work").commands).toBeUndefined()

    const options = Command.optionsOf(
      flags({
        verifyInstall: "make deps",
        verifyFormat: "make fmt",
        verifyTypecheck: ["make check", "tsc -p tsconfig.build.json --noEmit"],
        verifyTest: "make test"
      }),
      "/work"
    )

    expect(options.commands).toEqual({
      install: "make deps",
      format: "make fmt",
      typecheck: ["make check", "tsc -p tsconfig.build.json --noEmit"],
      test: "make test"
    })
    // And it decodes, because it is the flow's payload rather than an argument
    // to a function.
    expect(decode(options).commands?.typecheck).toEqual(["make check", "tsc -p tsconfig.build.json --noEmit"])
  })

  it("reads one empty value as `run no typecheck at all`", () => {
    // The difference matters: a project that typechecks through its test
    // command has to be able to say so, and an absent flag has to stay absent
    // rather than mean the same thing.
    expect(Command.optionsOf(flags({ verifyTypecheck: [""] }), "/work").commands).toEqual({ typecheck: [] })
    expect(Command.optionsOf(flags({ verifyTypecheck: [] }), "/work").commands).toBeUndefined()
  })
})

describe("Command.optionsOf state paths", () => {
  it("carries the three state paths from the environment onto the payload, and nothing else from it", () => {
    const options = Command.optionsOf(flags(), "/work", {
      SMITHERS_HOME: "/srv/smithers",
      HOME: "/home/op",
      TMPDIR: "/tmp/t/",
      ANTHROPIC_API_KEY: "sk-secret",
      OPENAI_API_KEY: ""
    })

    expect(options.state).toEqual({ smithersHome: "/srv/smithers", home: "/home/op", tmpdir: "/tmp/t/" })
    expect(JSON.stringify(options)).not.toContain("sk-secret")
    expect(decode(options)).toEqual(options)
    expect(Command.optionsOf(flags(), "/work").state).toBeUndefined()
    expect(Command.optionsOf(flags(), "/work", { HOME: "" }).state).toBeUndefined()
    expect(Options.scanEnvironment(options.state)).toEqual({
      SMITHERS_HOME: "/srv/smithers",
      HOME: "/home/op",
      TMPDIR: "/tmp/t/"
    })
    expect(Options.scanEnvironment({ tmpdir: "/tmp/t" })).toEqual({ TMPDIR: "/tmp/t/" })
    expect(Options.scanEnvironment(undefined)).toEqual({})
  })

  it.effect("reaches the survey's scan, so global state and gateway state are found by the run itself", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const home = copyFixture("jsx-single")
      mkdirSync(join(home, "smithers-gateway"), { recursive: true })
      // A gateway state file that names this project: 0.x run state outside
      // the tree, which only the environment can point the scan at.
      writeFileSync(join(home, "smithers-gateway", "gateway.json"), JSON.stringify({ workspace: root }))
      const options = Command.optionsOf(flags({ root }), root, {
        SMITHERS_HOME: join(home, ".smithers-home"),
        HOME: home,
        TMPDIR: `${home}/`
      })

      const surveyed = yield* Command.survey(options).pipe(Effect.provide(nodeLayer))

      expect(surveyed.scan.detection.globalState).toEqual([
        join(home, ".smithers-home"),
        `${home}/.smithers`,
        `${home}/smithers-gateway`
      ])
      expect(surveyed.scan.runState.gatewayState).toEqual([join(home, "smithers-gateway", "gateway.json")])
      expect(surveyed.scan.runState.verdict).toBe("blocked")
      // Without the state the same project scans clean.
      const bare = yield* Command.survey(Command.optionsOf(flags({ root }), root)).pipe(Effect.provide(nodeLayer))
      expect(bare.scan.runState.gatewayState).toEqual([])
      expect(bare.scan.detection.globalState).toEqual([])
    }))
})

describe("Command.isMigrateError", () => {
  it("accepts the package's own error and refuses an object that merely carries its tag", () => {
    expect(Command.isMigrateError(new MigrateError({ code: "io", message: "real" }))).toBe(true)
    // A forged tag on a plain object, on a class with the same tag, and on
    // an instance whose fields no longer decode: none is an operator message.
    expect(Command.isMigrateError({ _tag: "@smthrs/migrate/MigrateError", code: "io", message: "forged" })).toBe(false)
    class Impostor {
      readonly _tag = "@smthrs/migrate/MigrateError"
      readonly code = "run-state-blocked"
      readonly message = "forged"
    }
    expect(Command.isMigrateError(new Impostor())).toBe(false)
    const tampered = new MigrateError({ code: "io", message: "real" })
    ;(tampered as { code: string }).code = "not-a-code"
    expect(Command.isMigrateError(tampered)).toBe(false)
    expect(Command.isMigrateError(null)).toBe(false)
    expect(Command.isMigrateError("@smthrs/migrate/MigrateError")).toBe(false)
  })
})

describe("Command.exitCode", () => {
  it("is 0 when every unit finished", () => {
    expect(Command.exitCode(reportWith("apply", [{ id: "a", status: "migrated" }]))).toBe(0)
  })

  it("is 1 when a unit failed and was restored", () => {
    expect(Command.exitCode(reportWith("apply", [{ id: "a", status: "failed" }]))).toBe(1)
  })

  it("is 3 when a unit is blocked and the operator has a decision to make", () => {
    expect(
      Command.exitCode(reportWith("apply", [{
        id: "a",
        status: "blocked",
        unsupported: [{ construct: "UI", reason: "no counterpart", file: "a.tsx", line: 1, closest: "none" }]
      }]))
    ).toBe(3)
  })

  it("never parks a plan: planning is reading, and reading cannot be refused", () => {
    expect(Command.exitCode(reportWith("plan", [{ id: "a", status: "blocked" }]))).toBe(0)
  })
})

describe("Command.render", () => {
  it("gives a person the counts, the run state, and where the report is", () => {
    const report = reportWith("apply", [{ id: "workflow:a", status: "migrated" }])
    const text = Command.render(report, "human", "/work/.smithers-migrate")

    expect(text).toContain("smthrs migrate apply: /work")
    expect(text).toContain("1 migrated")
    expect(text).toContain("Run state: clean")
    expect(text).toContain("Report: /work/.smithers-migrate/report.md")
    expect(text).toContain("Exit 0.")
  })

  it("gives a script the report itself, and it round-trips", () => {
    const report = reportWith("plan", [{ id: "workflow:a" }])
    const text = Command.render(report, "json")

    expect(Schema.decodeUnknownSync(Report.MigrationReport)(JSON.parse(text))).toEqual(report)
  })

  it("shows operator-owned run-state instructions and bounds the human follow-up list", () => {
    const base = Report.empty("/work", "apply", "2026-08-29T00:00:00.000Z")
    const instructions = Array.from({ length: 12 }, (_, index) => `Decision ${index + 1}`)
    const report = Report.finalize(
      new Report.MigrationReport({
        ...base,
        runState: { ...base.runState, verdict: "history-only", instructions }
      })
    )
    const text = Command.render(report, "human")
    expect(text).toContain("Run state: history-only.")
    expect(text).toContain("Run state the operator owns:\n  - Decision 1")
    expect(text).toContain("Must be settled by a person (12):")
    const followUps = text.slice(text.indexOf("Must be settled by a person"))
    expect(followUps).toContain("  - Decision 10")
    expect(followUps).not.toContain("  - Decision 11")
    expect(text).toContain("... and 2 more in the report")
    expect(text).toContain("Exit 3.")
    expect(text).not.toContain("Report:")
  })

  it("does not claim a report was written in scan mode even when given a report path", () => {
    const report = reportWith("scan", [])
    const text = Command.render(report, "human", "/work/.smithers-migrate")
    expect(text).toContain("smthrs migrate scan: /work")
    expect(text).toContain("Units: 0 planned, 0 migrated, 0 failed, 0 blocked.")
    expect(text).not.toContain("Report:")
    expect(text).toContain("Exit 0.")
  })
})

describe("Command.survey", () => {
  it.effect("plans the units a project needs, in dependency order, without touching it", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const before = hashTree(root)

      const surveyed = yield* Command.survey(Command.optionsOf(flags({ root }), root)).pipe(
        Effect.provide(nodeLayer)
      )

      expect(surveyed.outlines.map((outline) => outline.id)).toEqual([
        "dependencies",
        "workflow:simple-workflow",
        "project"
      ])
      // Every outline names its sources; none of them carries their text,
      // because the text a unit is shown is captured when that unit starts.
      expect(surveyed.outlines[1]?.sources).toContain("simple-workflow.jsx")
      expect(surveyed.commands.flowsDir).toBe("flows")
      expect(hashTree(root)).toEqual(before)
    }))
})
