/**
 * `smthrs doctor`: every check, and the level it reports at.
 *
 * The report is data so its outcome can be pinned without parsing prose. A
 * check that changed level silently is the failure mode this suite exists for:
 * a `warn` that should have been a `fail` sends an operator into a run that
 * cannot start.
 */
import { NodeServices } from "@effect/platform-node"
import { Control as ControlService, ControlSchema } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Cause, Effect, Exit, Layer } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import { cli } from "../src/Command.ts"
import * as Doctor from "../src/Doctor.ts"
import * as Environment from "../src/Environment.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import { packageVersion } from "../src/Version.ts"

const staged: Array<string> = []
let restoreBackend: (() => void) | undefined
const runCommand = Command.runWith(cli, { version: packageVersion })
const commandServices = Layer.mergeAll(TestConsole.layer, Output.layer, NodeControl.layerMemoryRemote)

const pagedControl = (flows: ReadonlyArray<{ readonly flowId: string; readonly description: string }>) =>
  Layer.effect(
    ControlService.Control,
    Effect.gen(function*() {
      const control = yield* ControlService.Control
      return ControlService.make({
        ...control,
        list: (request: ControlSchema.ListRequest) => {
          if (request._tag !== "flows") return control.list(request)
          const offset = request.cursor === undefined ? 0 : Number(request.cursor)
          const limit = request.limit ?? ControlSchema.defaultPageSize
          const end = Math.min(offset + limit, flows.length)
          return Effect.succeed({
            _tag: "flows" as const,
            items: flows.slice(offset, end),
            ...(end < flows.length ? { nextCursor: String(end) } : {})
          })
        }
      })
    })
  ).pipe(Layer.provide(TestControl.layer({ now: () => 0 })))

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-doctor-"))
  staged.push(root)
  mkdirSync(join(root, ".git"))
  return root
}

const check = (report: Doctor.Report, name: string) => report.checks.find((entry) => entry.name === name)

afterEach(() => {
  restoreBackend?.()
  restoreBackend = undefined
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

const setBackend = (value: string | undefined): void => {
  const present = Object.hasOwn(process.env, "SMITHERS_BACKEND")
  const previous = process.env["SMITHERS_BACKEND"]
  restoreBackend = () => {
    if (present) process.env["SMITHERS_BACKEND"] = previous
    else delete process.env["SMITHERS_BACKEND"]
  }
  if (value === undefined) delete process.env["SMITHERS_BACKEND"]
  else process.env["SMITHERS_BACKEND"] = value
}

describe("the Node floor", () => {
  it("accepts the supported versions and refuses the ones below the floor", () => {
    expect(Doctor.minimumNode).toBe("26.4.0")
    for (const version of ["26.4.0", "v26.4.1", "26.10.0", "27.0.0"]) {
      expect(Doctor.satisfiesNode(version)).toBe(true)
    }
    for (const version of ["26.3.9", "22.19.0", "24.11.0", "24.18.0", "25.9.0", "20.11.0", "v18.0.0"]) {
      expect(Doctor.satisfiesNode(version)).toBe(false)
    }
    expect(Doctor.satisfiesNode("26", "26.0.1")).toBe(false)
    expect(Doctor.satisfiesNode("26.4.0", "26.5.0")).toBe(false)
    expect(Doctor.satisfiesNode("26.3.0", "20.0.0")).toBe(false)
    expect(Doctor.satisfiesNode("26.4.0", "invalid")).toBe(false)
    for (const version of ["26.4", "26.4.0-rc.1", "26.4.0garbage", "", "9007199254740992.0.0"]) {
      expect(Doctor.satisfiesNode(version)).toBe(false)
    }
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"))
    expect(manifest.engines.node).toBe(Doctor.supportedNodeRange)
  })
})

describe("the report", () => {
  it.each(["24.18.0", "26.3.9"])("explains why Node %s is unsupported", (nodeVersion) => {
    const report = Doctor.inspect({ root: project(), environment: {}, nodeVersion })
    expect(check(report, "node")).toMatchObject({
      level: "fail",
      detail: `v${nodeVersion} is unsupported; use Node 26.4+`
    })
    expect(Doctor.failed(report)).toBe(true)
  })
  it("uses the complete paged catalog for both ls and doctor", async () => {
    const root = project()
    const flows = Array.from({ length: ControlSchema.maxPageSize * 2 + 7 }, (_, index) => ({
      flowId: `project/flow-${String(index).padStart(4, "0")}`,
      description: `flow ${index}`
    }))
    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const beforeList = (yield* TestConsole.logLines).length
        yield* runCommand(["--json", "ls"])
        const afterList = yield* TestConsole.logLines
        const beforeDoctor = afterList.length
        yield* runCommand(["--json", "doctor"])
        const afterDoctor = yield* TestConsole.logLines
        return {
          listed: afterList.slice(beforeList).map(String).join("\n"),
          doctor: afterDoctor.slice(beforeDoctor).map(String).join("\n")
        }
      }).pipe(
        Effect.provide(pagedControl(flows)),
        Effect.provide(Project.layer(root, root)),
        Effect.provide(commandServices),
        Effect.provide(NodeServices.layer)
      )
    )

    const listed = JSON.parse(observed.listed) as { readonly items: ReadonlyArray<unknown> }
    const report = JSON.parse(observed.doctor) as Doctor.Report
    expect(listed.items).toHaveLength(flows.length)
    expect(check(report, "registry")?.detail).toContain(`${flows.length} flows discovered`)
  })

  it("warns when the project has no flows directory", () => {
    const report = Doctor.inspect({ root: project(), environment: {}, nodeVersion: "26.4.0" })

    expect(check(report, "registry")).toMatchObject({ level: "warn" })
    expect(check(report, "registry")?.detail).toContain("smthrs init")
    expect(Doctor.failed(report)).toBe(false)
  })

  it("warns when a flow directory holds no flow body", () => {
    const root = project()
    mkdirSync(join(root, "flows", "empty"), { recursive: true })

    expect(check(Doctor.inspect({ root, environment: {}, nodeVersion: "26.4.0" }), "registry"))
      .toMatchObject({ level: "warn" })
  })

  it("counts discovered flows and the directories it skipped", () => {
    const root = project()
    mkdirSync(join(root, "flows", "review"), { recursive: true })
    mkdirSync(join(root, "flows", "empty"), { recursive: true })
    writeFileSync(join(root, "flows", "review", "flow.mdx"), "# review\n")

    const registry = check(Doctor.inspect({ root, environment: {}, nodeVersion: "26.4.0" }), "registry")

    expect(registry).toMatchObject({ level: "ok" })
    expect(registry?.detail).toContain("1 flows discovered")
    expect(registry?.detail).toContain("1 directories skipped")
  })

  it.each(
    [
      ["a nested flow.ts", ["review", "read-pr", "flow.ts"]],
      ["a nested SKILL.md", ["x", "SKILL.md"]]
    ] as const
  )("recognizes %s using the real discovery file forms", (_label, segments) => {
    const root = project()
    const file = join(root, "flows", ...segments)
    mkdirSync(join(file, ".."), { recursive: true })
    writeFileSync(file, "export default {}\n")

    const registry = check(Doctor.inspect({ root, environment: {}, nodeVersion: "26.4.0" }), "registry")

    expect(registry).toMatchObject({ level: "ok" })
    expect(registry?.detail).toContain("1 flows discovered")
    expect(registry?.detail).not.toContain("discovery finds nothing")
  })

  it("uses the control plane's discovery result when the handler supplies it", () => {
    const root = project()
    const registry = check(
      Doctor.inspect({
        root,
        environment: {},
        nodeVersion: "26.4.0",
        discoveredFlows: [{ flowId: "review/read-pr", description: "Review a pull request" }]
      }),
      "registry"
    )

    expect(registry).toMatchObject({ level: "ok", detail: "1 flows discovered" })
  })

  it("reports the registry's malformed-metadata and unreadable-source warnings", () => {
    const root = project()
    const report = Doctor.inspect({
      root,
      environment: {},
      nodeVersion: "26.4.0",
      discoveredFlows: [{ flowId: "review", description: "Review" }],
      discoveryWarnings: [
        { code: "invalid_metadata", path: `${root}/flows/review/flow.ts`, message: "Invalid metadata" },
        { code: "unreadable", path: `${root}/flows/private/flow.mdx`, message: "Could not inspect source" }
      ]
    })

    expect(check(report, `registry ${root}/flows/review/flow.ts`))
      .toMatchObject({ level: "warn", detail: "invalid_metadata: Invalid metadata" })
    expect(check(report, `registry ${root}/flows/private/flow.mdx`))
      .toMatchObject({ level: "warn", detail: "unreadable: Could not inspect source" })
  })

  it("reports a database that has not been created and one that has", () => {
    const root = project()
    mkdirSync(join(root, ".flows"), { recursive: true })
    const file = join(root, ".flows", "control.db")
    const database = new DatabaseSync(file)
    database.exec("CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY, name TEXT, created_at TEXT)")
    database.exec("INSERT INTO flows_migrations VALUES (1, 'journal/0001', '')")
    database.close()

    const report = Doctor.inspect({ root, environment: {}, nodeVersion: "26.4.0" })

    expect(check(report, `database ${file}`)?.detail).toContain("1 migrations applied")
    expect(check(report, `database ${join(root, ".flows", "engine.db")}`))
      .toMatchObject({ level: "ok", detail: "not created yet" })
  })

  it("reports an empty migration ladder and a database open failure", () => {
    const root = project()
    mkdirSync(join(root, ".flows"), { recursive: true })
    const engine = join(root, ".flows", "engine.db")
    const database = new DatabaseSync(engine)
    database.exec("CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY, name TEXT, created_at TEXT)")
    database.close()
    mkdirSync(join(root, ".flows", "control.db"))

    const report = Doctor.inspect({ root, environment: {}, nodeVersion: "26.4.0" })
    expect(check(report, `database ${engine}`)?.detail).toContain("0 migrations applied, latest none")
    const failed = check(report, `database ${join(root, ".flows", "control.db")}`)
    expect(failed).toMatchObject({ level: "fail" })
    // One sentence, never a stack or an `Error:` prefix.
    expect(failed?.detail).not.toMatch(/^Error|\n/)
    expect(failed?.detail).not.toBe("")
  })

  it("warns about a database that Smithers 1.0 did not create", () => {
    const root = project()
    mkdirSync(join(root, ".flows"), { recursive: true })
    const file = join(root, ".flows", "control.db")
    const database = new DatabaseSync(file)
    database.exec("CREATE TABLE something_else (id INTEGER)")
    database.close()

    expect(check(Doctor.inspect({ root, environment: {}, nodeVersion: "26.4.0" }), `database ${file}`))
      .toMatchObject({ level: "warn" })
  })

  it("fails on a Node below the floor, which stops the next command", () => {
    const report = Doctor.inspect({ root: project(), environment: {}, nodeVersion: "20.11.0" })

    expect(check(report, "node")).toMatchObject({ level: "fail" })
    expect(Doctor.failed(report)).toBe(true)
  })

  it("reports the resolved jj, and the reason it is unusable", () => {
    const usable = Doctor.inspect({
      root: project(),
      environment: {},
      nodeVersion: "26.4.0",
      jj: { path: "/usr/bin/jj", executable: true }
    })
    const broken = Doctor.inspect({
      root: project(),
      environment: {},
      nodeVersion: "26.4.0",
      jj: { path: "jj", executable: false, hint: "No jj on PATH." }
    })
    const absent = Doctor.inspect({
      root: project(),
      environment: {},
      nodeVersion: "26.4.0",
      jj: { path: "jj", executable: false }
    })

    expect(check(usable, "jj")).toMatchObject({ level: "ok", detail: "/usr/bin/jj" })
    expect(check(broken, "jj")).toMatchObject({ level: "warn", detail: "No jj on PATH." })
    expect(check(absent, "jj")).toMatchObject({ level: "warn", detail: "not found" })
  })

  it("distinguishes a missing provider key from one exported empty", () => {
    const none = Doctor.inspect({ root: project(), environment: { OPENAI_API_KEY: "" }, nodeVersion: "26.4.0" })
    const some = Doctor.inspect({
      root: project(),
      environment: { ANTHROPIC_API_KEY: "sk-test", OPENAI_API_KEY: "", SMITHERS_OPENAI_AUTH: "chatgpt" },
      nodeVersion: "26.4.0"
    })

    expect(check(none, "providers")).toMatchObject({ level: "warn" })
    expect(check(none, "providers")?.detail).toContain("OPENAI_API_KEY exported but empty")
    expect(check(some, "providers")).toMatchObject({ level: "ok" })
    expect(check(some, "providers")?.detail).toContain("ANTHROPIC_API_KEY")
    expect(check(some, "providers")?.detail).toContain("ChatGPT session")
  })

  it("fails on an unsupported database backend", () => {
    const report = Doctor.inspect({
      root: project(),
      environment: { SMITHERS_BACKEND: "mysql" },
      nodeVersion: "26.4.0"
    })

    expect(check(report, "backend")).toMatchObject({
      level: "fail",
      detail: Environment.unsupportedBackendMessage
    })
    expect(check(report, "backend")?.detail).toContain("unsupported_database")
    expect(Doctor.failed(report)).toBe(true)
  })

  it("prints the unsupported database report and exits nonzero", async () => {
    const root = project()
    setBackend("mysql")

    const observed = await Effect.runPromise(
      Effect.gen(function*() {
        const before = (yield* TestConsole.logLines).length
        const exit = yield* Effect.exit(runCommand(["--json", "doctor"]))
        const lines = yield* TestConsole.logLines
        return { exit, text: lines.slice(before).map(String).join("\n") }
      }).pipe(
        Effect.provide(TestControl.layer({ now: () => 0 })),
        Effect.provide(Project.layer(root, root)),
        Effect.provide(commandServices),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(Exit.isFailure(observed.exit)).toBe(true)
    const error = Exit.isFailure(observed.exit) ? Cause.squash(observed.exit.cause) : undefined
    expect(error).toBeInstanceOf(CliError.UnsupportedError)
    expect(CliError.exitCode(error as CliError.UnsupportedError)).toBeGreaterThan(0)
    const report = JSON.parse(observed.text) as Doctor.Report
    expect(check(report, "backend")).toMatchObject({ level: "fail" })
    expect(Doctor.failed(report)).toBe(true)
  })

  it("reports Smithers 0.x state, and what its database still holds", () => {
    const root = project()
    writeFileSync(join(root, "smithers.db"), "")
    mkdirSync(join(root, ".smithers"))

    const report = Doctor.inspect({ root, environment: {}, nodeVersion: "26.4.0", cwd: root })
    const legacy = report.checks.filter((entry) => entry.name === "smithers 0.x")

    expect(legacy).toHaveLength(2)
    expect(legacy.every((entry) => entry.level === "warn")).toBe(true)
    expect(legacy.some((entry) => entry.detail.includes("no non-terminal runs"))).toBe(true)
    expect(Doctor.failed(report)).toBe(false)
  })

  it("reports the non-terminal runs held by a legacy database", () => {
    const root = project()
    const database = new DatabaseSync(join(root, "smithers.db"))
    database.exec(`CREATE TABLE _smithers_runs (
      run_id TEXT, workflow_name TEXT, workflow_path TEXT, status TEXT,
      heartbeat_at_ms INTEGER, runtime_owner_id TEXT, parent_run_id TEXT,
      pause_requested_at_ms INTEGER, cancel_requested_at_ms INTEGER
    )`)
    database.exec(
      "INSERT INTO _smithers_runs VALUES ('run-live', 'review', NULL, 'running', NULL, NULL, NULL, NULL, NULL)"
    )
    database.close()

    const report = Doctor.inspect({ root, environment: {}, nodeVersion: "26.4.0", cwd: root })
    expect(report.checks.find((entry) => entry.name === "smithers 0.x")?.detail)
      .toContain("1 non-terminal runs")
  })

  it("uses the ambient environment and Node version when omitted", () => {
    const report = Doctor.inspect({ root: project() })
    expect(check(report, "node")?.detail).toContain(process.versions.node)
  })

  it("renders one line per check", () => {
    const report = Doctor.inspect({ root: "/work", environment: {}, nodeVersion: "20.0.0" })
    const rendered = Doctor.render(report)

    expect(rendered.split("\n")).toHaveLength(report.checks.length + 1)
    expect(rendered).toContain("smthrs doctor: /work")
    expect(rendered).toContain("fail node:")
    expect(rendered).toContain("warn registry:")
    expect(rendered).toContain("ok   state:")
  })
})
