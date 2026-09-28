import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { pathToFileURL } from "node:url"
import * as Detect from "../src/Detect.ts"
import * as RunState from "../src/RunState.ts"
import { copyFixture, fixture, hashTree, nodeLayer } from "./fixtures/helpers.ts"

const buildDb = async (root: string, now: number): Promise<void> => {
  const module = await import(pathToFileURL(join(fixture("persisted-db"), "make-db.mjs")).href) as {
    build: (target: string, now: number) => string
  }
  module.build(root, now)
}

const now = 1_780_000_000_000

const report = (root: string, options: RunState.Options = {}) =>
  Effect.gen(function*() {
    const detection = yield* Detect.scan(root)
    return yield* RunState.scan(root, detection, { now, ...options })
  }).pipe(Effect.provide(nodeLayer))

describe("RunState.scan", () => {
  it.effect("reports clean when a project has no database and no state", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const result = yield* report(root)

      expect(result.verdict).toBe("clean")
      expect(result.databases).toEqual([])
      expect(result.instructions).toEqual([])
    }))

  it.effect("reports history-only for a database with tables and no rows, and for an empty database file", () =>
    Effect.gen(function*() {
      // A 0.x database is an archive-only file whatever it holds: a 1.0
      // runtime cannot read it, so the operator decides its fate even when
      // every table is empty. A zero-byte file at the conventional path is
      // the same decision.
      const empty = copyFixture("jsx-single")
      mkdirSync(join(empty, ".smithers"), { recursive: true })
      writeFileSync(join(empty, ".smithers", "smithers.db"), "")
      const zeroBytes = yield* report(empty)
      expect(zeroBytes.verdict).toBe("history-only")
      expect(zeroBytes.databases.map((database) => database.readable)).toEqual([true])
      expect(zeroBytes.instructions).toEqual([RunState.instructionText.archive])

      const schemaOnly = copyFixture("jsx-single")
      mkdirSync(join(schemaOnly, ".smithers"), { recursive: true })
      const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"))
      const database = new DatabaseSync(join(schemaOnly, ".smithers", "smithers.db"))
      database.exec(readFileSync(join(fixture("persisted-db"), "old-schema.sql"), "utf8"))
      database.close()
      const noRows = yield* report(schemaOnly)
      expect(noRows.databases[0]?.runsByStatus).toEqual([])
      expect(noRows.databases[0]?.tables).toContain("_smithers_runs")
      expect(noRows.verdict).toBe("history-only")
    }))

  it.effect("reports history-only for execution logs with no database", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const result = yield* report(root)

      expect(result.verdict).toBe("history-only")
      // The mirror file is run state too: it names the sessions a run mirrored
      // to, and a 1.0 runtime never reads it.
      expect(result.stateDirs.map((entry) => entry.path)).toEqual([
        ".smithers/executions",
        ".smithers/workflows/run-1783757199651.log",
        ".smithers/claude-mirror-subscriptions.json"
      ])
      expect(result.stateDirs[0]?.files).toBe(1)
      // A loose `run-*.log` beside the workflows is run state too, and it is
      // the one 0.x leaves outside every state directory.
      expect(result.stateDirs[1]?.bytes).toBeGreaterThan(0)
      expect(result.stateDirs[2]?.bytes).toBeGreaterThan(0)
      expect(result.instructions).toEqual([RunState.instructionText.archive])
    }))

  it.effect("blocks on a live run and a parked run, with instructions in order", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      yield* Effect.promise(() => buildDb(root, now))
      const result = yield* report(root)

      expect(result.verdict).toBe("blocked")
      const database = result.databases[0]
      expect(database?.path).toBe(".smithers/smithers.db")
      expect(database?.readable).toBe(true)
      expect(database?.tables).toEqual([
        "_smithers_attempts",
        "_smithers_events",
        "_smithers_nodes",
        "_smithers_runs",
        "_smithers_schema_migrations"
      ])
      expect(database?.migrations).toEqual({ count: 3, maxId: "0025_snapshot_contents" })
      expect(database?.runsByStatus).toEqual([
        { status: "failed", count: 1 },
        { status: "finished", count: 1 },
        { status: "running", count: 1 },
        { status: "waiting-quota", count: 1 }
      ])
      expect(database?.live.map((row) => row.runId)).toEqual(["run-live"])
      expect(database?.parked.map((row) => row.runId)).toEqual(["run-parked"])
      expect(database?.parked[0]?.status).toBe("waiting-quota")
      expect(result.instructions).toEqual([
        RunState.instructionText.live,
        RunState.instructionText.parked,
        RunState.instructionText.archive
      ])
    }))

  it.effect("moves the live run to parked once its heartbeat falls outside the window", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      yield* Effect.promise(() => buildDb(root, now))
      const result = yield* report(root, { now: now + 11 * 60 * 1000 })

      expect(result.databases[0]?.live).toEqual([])
      expect(result.databases[0]?.parked.map((row) => row.runId)).toEqual(["run-live", "run-parked"])
      expect(result.instructions).toEqual([
        RunState.instructionText.parked,
        RunState.instructionText.archive
      ])
    }))

  it.effect("keeps a cancellation request active through the heartbeat boundary until its terminal receipt exists", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      yield* Effect.promise(() => buildDb(root, now))
      const path = join(root, ".smithers", "smithers.db")
      const { DatabaseSync } = yield* Effect.promise(() => import("node:sqlite"))
      const writable = new DatabaseSync(path)
      try {
        writable.prepare("UPDATE _smithers_runs SET cancel_requested_at_ms = ? WHERE run_id = ?")
          .run(now, "run-live")
      } finally {
        writable.close()
      }
      const before = hashTree(root)
      const atDeadline = RunState.readDatabase(
        path,
        ".smithers/smithers.db",
        [],
        now + RunState.defaultLiveWindowMs,
        RunState.defaultLiveWindowMs
      )
      expect(atDeadline.live.map((row) => row.runId)).toEqual(["run-live"])
      expect(atDeadline.live[0]?.cancelRequestedAtMs).toBe(now)
      expect(atDeadline.parked.map((row) => row.runId)).toEqual(["run-parked"])

      const afterDeadline = RunState.readDatabase(
        path,
        ".smithers/smithers.db",
        [],
        now + RunState.defaultLiveWindowMs + 1,
        RunState.defaultLiveWindowMs
      )
      expect(afterDeadline.live).toEqual([])
      expect(afterDeadline.parked.map((row) => row.runId)).toEqual(["run-live", "run-parked"])
      expect(hashTree(root)).toEqual(before)

      const complete = new DatabaseSync(path)
      try {
        complete.prepare("UPDATE _smithers_runs SET status = ? WHERE run_id = ?").run("cancelled", "run-live")
      } finally {
        complete.close()
      }
      const terminal = RunState.readDatabase(path, ".smithers/smithers.db", [], now + 1, RunState.defaultLiveWindowMs)
      expect(terminal.live).toEqual([])
      expect(terminal.parked.map((row) => row.runId)).toEqual(["run-parked"])
      expect(terminal.runsByStatus).toContainEqual({ status: "cancelled", count: 1 })
    }))

  it.effect("leaves every byte of the project unchanged", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      yield* Effect.promise(() => buildDb(root, now))
      const before = hashTree(root)

      yield* report(root)

      expect(Object.fromEntries(hashTree(root))).toEqual(Object.fromEntries(before))
    }))

  it.effect("blocks on a Postgres backend without connecting to it", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      writeFileSync(
        join(root, ".smithers", "smithers.config.ts"),
        "export const backend = \"postgres\";\n\nexport default { backend };\n"
      )
      const result = yield* report(root)

      expect(result.verdict).toBe("blocked")
      expect(result.postgres?.sources.map((entry) => entry.file)).toEqual([".smithers/smithers.config.ts"])
      expect(result.instructions).toContain(RunState.instructionText.backend)
    }))

  it.effect("blocks on SMITHERS_BACKEND=pglite in a dotenv file", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      writeFileSync(join(root, ".env"), "SMITHERS_BACKEND=pglite\n")
      const result = yield* report(root)

      expect(result.pglite?.sources[0]?.file).toBe(".env")
      expect(result.verdict).toBe("blocked")
    }))

  it.effect("blocks on a PGlite data directory", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      mkdirSync(join(root, ".smithers", "pg"), { recursive: true })
      writeFileSync(join(root, ".smithers", "pg", "PG_VERSION"), "16\n")
      const result = yield* report(root)

      expect(result.pglite?.sources[0]?.file).toBe(".smithers/pg/PG_VERSION")
      expect(result.verdict).toBe("blocked")
    }))

  it.effect("blocks on a database it cannot open", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      writeFileSync(join(root, "smithers.db"), "this is not a database")
      const result = yield* report(root)

      const broken = result.databases.find((database) => database.path === "smithers.db")
      expect(broken?.readable).toBe(false)
      expect(broken?.unreadableReason).toBeDefined()
      expect(result.verdict).toBe("blocked")
      expect(result.instructions.some((line) => line.includes("could not be opened read only"))).toBe(true)
    }))

  it.effect("blocks on a gateway state file that names this workspace", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      const temporary = copyFixture("jsx-single")
      mkdirSync(join(temporary, "smithers-gateway"), { recursive: true })
      writeFileSync(
        join(temporary, "smithers-gateway", "gateway.json"),
        JSON.stringify({ workspace: root, port: 7331 })
      )
      const result = yield* report(root, { tmpdir: temporary })

      expect(result.gatewayState).toHaveLength(1)
      expect(result.verdict).toBe("blocked")
      expect(result.instructions.some((line) => line.includes("smithers down"))).toBe(true)
    }))

  for (const position of ["value", "key"] as const) {
    it.effect(`blocks on a JSON-escaped workspace path in a gateway ${position}`, () =>
      Effect.gen(function*() {
        const root = copyFixture("jsx-single")
        const temporary = copyFixture("jsx-single")
        const directory = join(temporary, "smithers-gateway")
        mkdirSync(directory, { recursive: true })
        const escaped = root.split("").map((unit) => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")
        writeFileSync(
          join(directory, "gateway.json"),
          position === "value"
            ? `{"workspaces":[null,123,{"path":"${escaped}"}]}`
            : `{"workspaces":{"${escaped}":true}}`
        )
        writeFileSync(join(directory, "unrelated.json"), "{\"other\":[null,123,\"another workspace\"]}")
        writeFileSync(join(directory, "invalid.json"), "{invalid")
        const result = yield* report(root, { tmpdir: temporary })

        expect(result.gatewayState).toEqual([join(directory, "gateway.json")])
        expect(result.verdict).toBe("blocked")
      }))
  }

  for (const directory of ["C:\\state\\smithers-gateway", "\\\\server\\share\\smithers-gateway"]) {
    it.effect(`protects a native Windows gateway directory ${directory} and its descendants`, () =>
      Effect.gen(function*() {
        const result = yield* report(copyFixture("jsx-single"))
        expect(RunState.roots({
          ...result,
          gatewayState: [`${directory}\\gateway.json`, `${directory}\\nested\\another.json`]
        })).toEqual([directory])
      }))
  }

  it.effect("finds a database named by a dbPath literal in project source", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      yield* Effect.promise(() => buildDb(root, now))
      writeFileSync(join(root, "smithers.db"), "")
      const result = yield* report(root)

      expect(result.databases.map((database) => database.path)).toEqual([".smithers/smithers.db", "smithers.db"])
    }))

  it.effect("records a database that resolves outside the project as external, and blocks on it", () =>
    Effect.gen(function*() {
      // Every consumer of a `DatabaseFinding.path` joins it onto the root: the
      // deny rule, the checkpoint digest, the membership walk, and the archive
      // refusal. An absolute or `../` spelling fed to any of them watches
      // nothing while the report claims the project is protected, so the scan
      // records it apart and blocks instead.
      const root = copyFixture("jsx-single")
      // The external databases live in a directory this test allocates, never
      // at a fixed path beside `root` that another process may own.
      const externalDir = mkdtempSync(join(tmpdir(), "smithers-migrate-external-"))
      const outside = join(externalDir, "outside.db")
      const absolute = join(externalDir, "absolute.db")
      const outsideDeclared = relative(root, outside)
      for (const path of [outside, absolute]) {
        expect(path.startsWith(`${externalDir}/`)).toBe(true)
        expect(path.startsWith(`${root}/`)).toBe(false)
      }
      expect(outsideDeclared.startsWith("../")).toBe(true)
      writeFileSync(outside, "")
      writeFileSync(join(root, ".env"), `SMITHERS_DB=${outsideDeclared}\n`)
      writeFileSync(
        join(root, "smithers.config.ts"),
        `export default { dbPath: ${JSON.stringify(absolute)} }\n`
      )
      writeFileSync(absolute, "")

      try {
        const result = yield* report(root)

        expect(result.external.map((entry) => entry.declared).sort()).toEqual([
          outsideDeclared,
          absolute
        ].sort())
        for (const entry of result.external) {
          expect(entry.resolved.startsWith(`${root}/`)).toBe(false)
        }
        // Nothing outside the root reaches a consumer that would join it back on.
        for (const database of result.databases) {
          expect(database.path.startsWith("/")).toBe(false)
          expect(database.path.includes("..")).toBe(false)
        }
        for (const walked of RunState.roots(result)) {
          expect(walked.startsWith("/")).toBe(false)
          expect(walked.includes("..")).toBe(false)
        }
        expect(result.verdict).toBe("blocked")
      } finally {
        rmSync(externalDir, { recursive: true, force: true })
      }
    }))
})

describe("RunState.scan over symbolic links", () => {
  it.effect("records a project-relative dbPath that links outside the project as external, and blocks", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      const externalDir = mkdtempSync(join(tmpdir(), "smithers-migrate-linked-"))
      try {
        writeFileSync(join(externalDir, "old.db"), "")
        symlinkSync(join(externalDir, "old.db"), join(root, "link.db"))
        writeFileSync(join(root, "smithers.config.ts"), `export default { dbPath: "link.db" }\n`)

        const result = yield* report(root)

        expect(result.external).toEqual([{ declared: "link.db", resolved: realpathSync(join(externalDir, "old.db")) }])
        expect(result.databases.map((database) => database.path)).toEqual([])
        expect(result.verdict).toBe("blocked")
      } finally {
        rmSync(externalDir, { recursive: true, force: true })
      }
    }))

  it.effect("records a link that stays inside the project at its target's own path", () =>
    Effect.gen(function*() {
      const root = copyFixture("jsx-single")
      mkdirSync(join(root, "data"))
      writeFileSync(join(root, "data", "real.db"), "")
      symlinkSync(join(root, "data", "real.db"), join(root, "link.db"))
      writeFileSync(join(root, "smithers.config.ts"), `export default { dbPath: "link.db" }\n`)

      const result = yield* report(root)

      expect(result.external).toEqual([])
      expect(result.databases.map((database) => database.path)).toEqual(["data/real.db"])
    }))
})

describe("RunState.roots", () => {
  it.effect("walks the directory a loose state file lives in, never the file itself", () =>
    Effect.gen(function*() {
      // A file used as a walk root walks nothing, so the sibling `run-*.log`
      // 0.x writes next to an existing one would be invisible to the
      // membership half of the run-state check.
      const root = copyFixture("persisted-db")
      const result = yield* report(root)

      expect(result.stateDirs.map((entry) => [entry.path, entry.kind])).toEqual([
        [".smithers/executions", "directory"],
        [".smithers/workflows/run-1783757199651.log", "file"],
        [".smithers/claude-mirror-subscriptions.json", "file"]
      ])
      // `.smithers` is the parent of the mirror file, and it already covers
      // `.smithers/executions` and `.smithers/workflows`.
      expect(RunState.roots(result)).toEqual([".smithers"])
      for (const entry of RunState.roots(result)) {
        expect(statSync(join(root, ...entry.split("/"))).isDirectory(), entry).toBe(true)
      }
    }))

  it.effect("keeps the parent of a loose log when no state file sits beside it", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      rmSync(join(root, ".smithers", "claude-mirror-subscriptions.json"))
      const result = yield* report(root)

      expect(RunState.roots(result)).toEqual([".smithers/executions", ".smithers/workflows"])
    }))
})

describe("RunState unreadable database", () => {
  it.effect("records an unopenable file rather than failing the scan", () =>
    Effect.gen(function*() {
      const root = copyFixture("persisted-db")
      yield* Effect.promise(() => buildDb(root, now))
      const database = join(root, ".smithers", "smithers.db")
      chmodSync(database, 0o000)
      const result = yield* report(root)
      chmodSync(database, 0o644)

      // Running as root defeats the permission bit; the scan must still be
      // honest either way, so both outcomes are asserted on their own terms.
      const finding = result.databases[0]
      if (finding?.readable === false) {
        expect(result.verdict).toBe("blocked")
        expect(result.instructions.some((line) => line.includes("could not be opened read only"))).toBe(true)
      } else {
        expect(finding?.live.map((row) => row.runId)).toEqual(["run-live"])
      }
    }))
})
