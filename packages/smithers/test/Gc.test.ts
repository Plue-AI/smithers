/**
 * `smthrs gc`: the duration an operator types, and the databases the sweep
 * runs against.
 *
 * The retention operation itself is tested in `@smthrs/engine-store`; what is
 * pinned here is that a project's two databases are both swept, that a project
 * which has never run anything is a no-op rather than an error, and that the
 * lineage guard the facade delegates to holds over a real `.flows` — a settled
 * child under a parked parent is what `agent/await` still reads out of a run
 * row, and collecting it is data loss the operator did not ask for.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as ExecutionSnapshot from "@smthrs/registry/ExecutionSnapshot"
import { Cause, Effect, Exit, Layer } from "effect"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterEach, describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as Gc from "../src/Gc.ts"

const staged: Array<string> = []

const project = (...files: ReadonlyArray<string>): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-gc-"))
  staged.push(root)
  mkdirSync(join(root, ".flows"), { recursive: true })
  for (const file of files) {
    const database = new DatabaseSync(join(root, ".flows", file))
    database.close()
  }
  return root
}

/**
 * A project whose `.flows/engine.db` carries the run rows and the spawn edges
 * a real engine writes: the two tables the lineage guard walks.
 */
const engineProject = (
  runs: ReadonlyArray<{ readonly runId: string; readonly status: string; readonly finishedAtMs: number | null }>,
  edges: ReadonlyArray<readonly [child: string, parent: string]>
): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-gc-lineage-"))
  staged.push(root)
  mkdirSync(join(root, ".flows"), { recursive: true })
  const database = new DatabaseSync(join(root, ".flows", "engine.db"))
  // The 1.0 marker table: `NodeDatabase.layer` refuses to open a file that
  // holds tables and no `flows_migrations`, which is how a 0.x `smithers.db`
  // is told apart from this one.
  database.exec(`CREATE TABLE flows_migrations (
    namespace TEXT NOT NULL,
    id INTEGER NOT NULL,
    name TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL,
    PRIMARY KEY (namespace, id)
  )`)
  database.exec(`CREATE TABLE flows_runs (
    run_id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    parent_run_id TEXT REFERENCES flows_runs(run_id)
  )`)
  // No foreign key, exactly as the engine declares it: the two tables live in
  // different migration lanes, and the trigger is what keeps edges from
  // outliving their runs.
  database.exec(`CREATE TABLE flows_run_parents (
    child_id TEXT NOT NULL,
    parent_id TEXT NOT NULL,
    seq BIGINT NOT NULL,
    PRIMARY KEY (child_id, parent_id)
  )`)
  database.exec(`CREATE TRIGGER flows_run_parents_gc
    AFTER DELETE ON flows_runs
    BEGIN
      DELETE FROM flows_run_parents
      WHERE child_id = OLD.run_id OR parent_id = OLD.run_id;
    END`)
  for (const run of runs) {
    database
      .prepare("INSERT INTO flows_runs (run_id, status, created_at_ms, finished_at_ms) VALUES (?, ?, ?, ?)")
      .run(run.runId, run.status, 1, run.finishedAtMs)
  }
  for (const [child, parent] of edges) {
    database.prepare("INSERT INTO flows_run_parents (child_id, parent_id, seq) VALUES (?, ?, 0)").run(child, parent)
  }
  database.close()
  return root
}

/** Every run id left in a project's engine database, sorted. */
const runIdsIn = (root: string, file = "engine.db"): ReadonlyArray<string> => {
  const database = new DatabaseSync(join(root, ".flows", file))
  const rows = database.prepare("SELECT run_id FROM flows_runs ORDER BY run_id").all()
  database.close()
  return rows.map((row) => String(row["run_id"]))
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

describe("the retention window", () => {
  it("parses the durations an operator types", () => {
    expect(Gc.duration("30d")).toBe(30 * 24 * 60 * 60 * 1000)
    expect(Gc.duration("12h")).toBe(12 * 60 * 60 * 1000)
    expect(Gc.duration("90 m")).toBe(90 * 60 * 1000)
    expect(Gc.duration("2w")).toBe(2 * 7 * 24 * 60 * 60 * 1000)
    expect(Gc.duration("45s")).toBe(45_000)
  })

  it("refuses a spelling it cannot read rather than guessing a window", () => {
    for (const value of ["", "forever", "30", "d30", "-1d", "30y", "0s", "0d"]) {
      expect(Gc.duration(value)).toBeUndefined()
    }
    expect(Gc.duration("30d")).toBe(30 * 24 * 60 * 60 * 1000)
  })

  it("keeps a month by default", () => {
    expect(Gc.defaultRetention).toBe("30d")
  })

  it("renders singular and plural database failures", () => {
    expect(Gc.failureMessage([{ database: "control.db", reason: "locked" }])).toContain(
      "could not collect from 1 store:"
    )
    expect(
      Gc.failureMessage([
        { database: "control.db", reason: "locked" },
        { database: "engine.db", reason: "corrupt" }
      ])
    ).toContain("could not collect from 2 stores:")
  })
})

describe("the sweep", () => {
  it("names both of a project's databases, in the order it runs them", () => {
    const root = project("control.db", "engine.db")

    expect(Gc.databases(root)).toEqual([join(root, ".flows", "control.db"), join(root, ".flows", "engine.db")])
  })

  it("names only the databases that exist", () => {
    const root = project("engine.db")

    expect(Gc.databases(root)).toEqual([join(root, ".flows", "engine.db")])
  })

  it("is a no-op on a project that has never run anything", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-gc-empty-"))
    staged.push(root)

    const result = await Effect.runPromise(Gc.sweep(root, { olderThan: "30d", dryRun: true }))

    expect(result).toEqual({ olderThan: "30d", dryRun: true, reports: [], failures: [] })
  })

  it("reports one entry per database", async () => {
    const root = project("control.db", "engine.db")

    const result = await Effect.runPromise(Gc.sweep(root, { olderThan: "1d", dryRun: true }))

    expect(result.reports.map((report) => report.database)).toEqual(Gc.databases(root))
    expect(result.reports.every((report) => report.runs.length === 0)).toBe(true)
  })

  it("aborts before deleting from either database when one cannot participate", async () => {
    // An empty report of an unopenable file is the worst answer available:
    // `gc --dry-run` is trusted to name exactly what a real pass would delete,
    // and "nothing" is indistinguishable from "nothing to do". Probing every
    // file first keeps a bad engine database from deleting the control half of
    // a run.
    const root = engineProject([{ runId: "settled", status: "completed", finishedAtMs: 1 }], [])
    renameSync(join(root, ".flows", "engine.db"), join(root, ".flows", "control.db"))
    mkdirSync(join(root, ".flows", "engine.db"))

    const result = await Effect.runPromise(Gc.sweep(root, { olderThan: "1s", dryRun: false, now: 60_000 }))

    expect(result.failures.map((failure) => failure.database)).toEqual([join(root, ".flows", "engine.db")])
    expect(result.failures[0]!.reason).not.toBe("")
    expect(result.reports).toEqual([])
    expect(runIdsIn(root, "control.db")).toEqual(["settled"])
  })

  it("reports no failure when every database opened", async () => {
    const result = await Effect.runPromise(
      Gc.sweep(project("control.db", "engine.db"), { olderThan: "1d", dryRun: true })
    )

    expect(result.failures).toEqual([])
  })

  it("sweeps both databases after both probes succeed", async () => {
    const root = engineProject([{ runId: "engine-run", status: "completed", finishedAtMs: 1 }], [])
    const control = new DatabaseSync(join(root, ".flows", "control.db"))
    control.exec(`CREATE TABLE flows_migrations (
      namespace TEXT NOT NULL,
      id INTEGER NOT NULL,
      name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL,
      PRIMARY KEY (namespace, id)
    )`)
    control.exec(`CREATE TABLE flows_runs (
      run_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER,
      parent_run_id TEXT REFERENCES flows_runs(run_id)
    )`)
    control.prepare("INSERT INTO flows_runs VALUES (?, ?, ?, ?, ?)").run("control-run", "completed", 1, 1, null)
    control.close()

    const result = await Effect.runPromise(Gc.sweep(root, { olderThan: "1s", dryRun: false, now: 60_000 }))

    expect(result.failures).toEqual([])
    expect(result.reports.map((report) => report.database)).toEqual(Gc.databases(root))
    expect(runIdsIn(root, "control.db")).toEqual([])
    expect(runIdsIn(root)).toEqual([])
  })

  it("keeps a spawned settled child whose parent is still parked", async () => {
    // The child is aged and terminal, so a guard that looked only at status
    // and age would collect it. Its parent is `suspended` — parked on an
    // approval — and reads the child's result out of the run row through
    // `agent/await`, so it stays until the parent settles. The edge is a
    // `flows_run_parents` row with a NULL `parent_run_id`, which is exactly
    // the relation the column-only guard missed.
    const root = engineProject(
      [
        { runId: "parked-parent", status: "suspended", finishedAtMs: null },
        { runId: "settled-child", status: "completed", finishedAtMs: 1 }
      ],
      [["settled-child", "parked-parent"]]
    )

    const result = await Effect.runPromise(Gc.sweep(root, { olderThan: "1s", dryRun: false, now: 60_000 }))

    const engine = result.reports.find((report) => report.database.endsWith("engine.db"))!
    expect(engine.runs).toEqual([])
    expect(runIdsIn(root)).toEqual(["parked-parent", "settled-child"])
  })

  it("collects that child once its parent has settled", async () => {
    const root = engineProject(
      [
        { runId: "settled-parent", status: "completed", finishedAtMs: 1 },
        { runId: "settled-child", status: "completed", finishedAtMs: 1 }
      ],
      [["settled-child", "settled-parent"]]
    )

    const result = await Effect.runPromise(Gc.sweep(root, { olderThan: "1s", dryRun: false, now: 60_000 }))

    const engine = result.reports.find((report) => report.database.endsWith("engine.db"))!
    expect([...engine.runs].sort()).toEqual(["settled-child", "settled-parent"])
    expect(runIdsIn(root)).toEqual([])
  })

  it("refuses a threshold it cannot read", async () => {
    const exit = await Effect.runPromiseExit(Gc.sweep(project(), { olderThan: "forever", dryRun: true }))

    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toContain("--older-than must be a duration")
  })

  it("collects artifact blobs no run references once they are past the grace period", async () => {
    // Retention deletes the attempt and cache rows that were the only roots
    // of a spilled output, and nothing else ever deletes a published blob.
    const root = engineProject([{ runId: "settled", status: "completed", finishedAtMs: 1 }], [])
    const database = new DatabaseSync(join(root, ".flows", "engine.db"))
    database.exec("CREATE TABLE flows_step_cache (key_digest TEXT PRIMARY KEY, meta_json TEXT NOT NULL)")
    database.exec(`CREATE TABLE flows_attempts (
      run_id TEXT NOT NULL,
      step_key_digest TEXT NOT NULL,
      attempt INTEGER NOT NULL,
      checkpoint_json TEXT,
      meta_json TEXT NOT NULL,
      PRIMARY KEY (run_id, step_key_digest, attempt)
    )`)
    database.close()
    const plant = (bytes: string, ageMs: number): string => {
      const digest = createHash("sha256").update(bytes).digest("hex")
      const directory = join(root, ".flows", "objects", digest.slice(0, 2))
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, digest), bytes)
      const seconds = (Date.now() - ageMs) / 1000
      utimesSync(join(directory, digest), seconds, seconds)
      return digest
    }
    const orphaned = plant("orphaned output", 30 * 24 * 60 * 60 * 1000)
    const fresh = plant("fresh output", 0)
    const blob = (digest: string) => join(root, ".flows", "objects", digest.slice(0, 2), digest)

    const planned = await Effect.runPromise(Gc.sweep(root, { olderThan: "1s", dryRun: true, now: 60_000 }))
    expect(planned.failures).toEqual([])
    expect(planned.artifacts?.sweptDigests).toEqual([orphaned])
    expect(planned.artifacts?.dryRun).toBe(true)
    expect(existsSync(blob(orphaned))).toBe(true)

    const swept = await Effect.runPromise(Gc.sweep(root, { olderThan: "1s", dryRun: false, now: 60_000 }))
    expect(swept.failures).toEqual([])
    expect(swept.artifacts?.sweptDigests).toEqual([orphaned])
    expect(swept.artifacts?.keptByGrace).toBe(1)
    expect(existsSync(blob(orphaned))).toBe(false)
    expect(existsSync(blob(fresh))).toBe(true)
  })

  it.each([
    { status: "pending", descendant: false, changedLockfile: false, fresh: false },
    { status: "running", descendant: false, changedLockfile: false, fresh: false },
    { status: "suspended", descendant: false, changedLockfile: false, fresh: false },
    { status: "completed", descendant: "column", changedLockfile: false, fresh: false },
    { status: "completed", descendant: "edge", changedLockfile: false, fresh: false },
    { status: "running", descendant: false, changedLockfile: true, fresh: false },
    { status: "running", descendant: false, changedLockfile: true, fresh: true }
  ])(
    "protects a pinned closure ($status, descendant=$descendant, changedLockfile=$changedLockfile, fresh=$fresh)",
    async ({ status, descendant, changedLockfile, fresh }) => {
      const root = engineProject([], [])
      const engine = new DatabaseSync(join(root, ".flows", "engine.db"))
      engine.exec("CREATE TABLE flows_step_cache (key_digest TEXT PRIMARY KEY, meta_json TEXT NOT NULL)")
      engine.exec(`CREATE TABLE flows_attempts (
      run_id TEXT NOT NULL, step_key_digest TEXT NOT NULL, attempt INTEGER NOT NULL,
      checkpoint_json TEXT, meta_json TEXT NOT NULL,
      PRIMARY KEY (run_id, step_key_digest, attempt)
    )`)
      engine.close()
      const flowDirectory = join(root, "flows", "pinned")
      mkdirSync(flowDirectory, { recursive: true })
      symlinkSync(join(import.meta.dirname, "..", "node_modules"), join(root, "node_modules"), "dir")
      writeFileSync(join(flowDirectory, "value.ts"), "export const value = \"retained implementation\"\n")
      writeFileSync(
        join(flowDirectory, "flow.ts"),
        `
      import { Flow } from "@smthrs/flow"
      import { Node } from "@smthrs/plan"
      import { Schema } from "effect"
      import { value } from "./value.ts"
      export default Flow.make("pinned", {
        description: "Pinned closure fixture.", capabilities: [],
        effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
        payload: {}, success: Schema.String, body: () => Node.succeed(value)
      })
    `
      )
      const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)
      const pinned = await Effect.runPromise(
        Effect.gen(function*() {
          const discovery = yield* Discovery.Discovery
          const found = yield* discovery.scan({ source: "project", root: join(root, "flows"), naming: "path" })
          expect(found.entries).toHaveLength(1)
          const executable = yield* Executable.fromDescriptor(found.entries[0]!, { delegates: [] })
          const snapshots = yield* ExecutionSnapshot.ExecutionSnapshot
          yield* snapshots.pin(executable)
          const digest = Descriptor.executionDigest(executable.descriptor)!
          return { digest, blobs: yield* snapshots.roots([digest]) }
        }).pipe(
          Effect.provide(
            Layer.merge(Discovery.layer, ExecutionSnapshot.layerFileSystem({ root })).pipe(Layer.provide(platform))
          ),
          Effect.provide(platform)
        )
      )
      expect(pinned.blobs).toHaveLength(3) // Entry, imported module, and manifest.
      const agedSeconds = (Date.now() - 30 * 24 * 60 * 60 * 1000) / 1000
      const blobPath = (digest: string) => join(root, ".flows", "objects", digest.slice(0, 2), digest)
      if (!fresh) { for (const digest of pinned.blobs) utimesSync(blobPath(digest), agedSeconds, agedSeconds) }
      if (changedLockfile) writeFileSync(join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")
      if (descendant) {
        const descendants = new DatabaseSync(join(root, ".flows", "engine.db"))
        descendants.prepare("INSERT INTO flows_runs VALUES (?, ?, ?, ?, ?)").run("pinned-run", "completed", 1, 1, null)
        descendants
          .prepare("INSERT INTO flows_runs VALUES (?, ?, ?, ?, ?)")
          .run("live-child", "running", 1, null, descendant === "edge" ? null : "pinned-run")
        if (descendant === "edge") {
          descendants.prepare("INSERT INTO flows_run_parents VALUES (?, ?, 0)").run("live-child", "pinned-run")
        }
        descendants.close()
      }
      const control = new DatabaseSync(join(root, ".flows", "control.db"))
      control.exec(`CREATE TABLE flows_migrations (
      namespace TEXT NOT NULL, id INTEGER NOT NULL, name TEXT NOT NULL,
      applied_at_ms INTEGER NOT NULL, PRIMARY KEY (namespace, id)
    )`)
      control.exec(`CREATE TABLE flows_runs (
      run_id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at_ms INTEGER NOT NULL,
      finished_at_ms INTEGER, parent_run_id TEXT, state_json TEXT NOT NULL
    )`)
      control.exec("CREATE TABLE control_runs (run_id TEXT PRIMARY KEY)")
      control
        .prepare("INSERT INTO flows_runs VALUES (?, ?, ?, ?, ?, ?)")
        .run(
          "pinned-run",
          status,
          1,
          status === "completed" ? 1 : null,
          null,
          JSON.stringify({ executionDigest: pinned.digest })
        )
      control.prepare("INSERT INTO control_runs VALUES (?)").run("pinned-run")
      control.close()

      const protectedPass = await Effect.runPromise(Gc.sweep(root, { olderThan: "1s", dryRun: false, now: 60_000 }))
      expect(protectedPass.failures).toEqual([])
      expect(protectedPass.artifacts?.sweptDigests).toEqual([])
      for (const digest of pinned.blobs) expect(existsSync(blobPath(digest))).toBe(true)
      if (descendant) {
        const repeated = await Effect.runPromise(Gc.sweep(root, { olderThan: "1s", dryRun: false, now: 60_000 }))
        expect(repeated.failures).toEqual([])
        expect(repeated.artifacts?.sweptDigests).toEqual([])
        for (const digest of pinned.blobs) expect(existsSync(blobPath(digest))).toBe(true)
      }

      const settled = new DatabaseSync(join(root, ".flows", "control.db"))
      settled.exec("UPDATE flows_runs SET status = 'completed', finished_at_ms = 1")
      settled.close()
      if (descendant) {
        const descendants = new DatabaseSync(join(root, ".flows", "engine.db"))
        descendants.exec("UPDATE flows_runs SET status = 'completed', finished_at_ms = 1")
        descendants.close()
      }
      const collected = await Effect.runPromise(Gc.sweep(root, { olderThan: "1s", dryRun: false, now: 60_000 }))
      expect(collected.failures).toEqual([])
      expect(collected.artifacts?.sweptDigests.toSorted()).toEqual(fresh ? [] : pinned.blobs.toSorted())
      if (fresh) expect(collected.artifacts?.keptByGrace).toBe(3)
      for (const digest of pinned.blobs) expect(existsSync(blobPath(digest))).toBe(fresh)
    }
  )

  it("reports an artifact pass it could not run as a failure", async () => {
    // The engine database here has no attempt table, so the mark cannot prove
    // which blobs are live. Sweeping anyway would delete live outputs.
    const root = engineProject([{ runId: "settled", status: "completed", finishedAtMs: 1 }], [])
    mkdirSync(join(root, ".flows", "objects"))

    const result = await Effect.runPromise(Gc.sweep(root, { olderThan: "1s", dryRun: true, now: 60_000 }))

    expect(result.failures.map((failure) => failure.database)).toEqual([join(root, ".flows", "objects")])
    expect(result.artifacts).toBeUndefined()
  })
})
