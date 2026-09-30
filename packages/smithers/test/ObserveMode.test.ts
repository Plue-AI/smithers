/**
 * Observing verbs open existing stores read-only: they migrate nothing, start
 * no recovery, and answer while another process holds the writer.
 */
import { NodeCrypto, NodeServices } from "@effect/platform-node"
import { Control } from "@smthrs/control"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Context, Effect, Exit, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, readdir, realpath, rm, unlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { fileURLToPath } from "node:url"
import { afterAll, describe, expect, it, vi } from "vitest"
import * as NodeControl from "../src/NodeControl.ts"

const directories: Array<string> = []
afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

const scriptedHost = fileURLToPath(new URL("./fixtures/scripted-native-host.ts", import.meta.url))
const executable = fileURLToPath(new URL("../src/bin.ts", import.meta.url))

const run = (root: string, args: ReadonlyArray<string>, env: Readonly<Record<string, string>> = {}) =>
  new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--no-warnings", "--import", scriptedHost, executable, ...args, "--root", root, "--json"],
      { cwd: root, env: { ...process.env, SMITHERS_REMOTE: "", SMITHERS_BACKEND: "sqlite", ...env } }
    )
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => (stdout += chunk))
    child.stderr.on("data", (chunk) => (stderr += chunk))
    const timeout = setTimeout(() => child.kill("SIGKILL"), 120_000)
    child.once("error", reject)
    child.once("close", (code) => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
  })

const open = (root: string, kind: "engine" | "control") => new DatabaseSync(join(root, ".flows", `${kind}.db`))

const edit = (root: string, kind: "engine" | "control", body: (db: DatabaseSync) => void) => {
  const db = open(root, kind)
  try {
    body(db)
  } finally {
    db.close()
  }
}

/** A migrated project holding one parked run with two journal events. */
const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smthrs-observe-")))
  directories.push(root)
  await Effect.runPromise(Effect.void.pipe(
    Effect.provide(NodeRuntime.storage(join(root, ".flows", "engine.db"), root)),
    Effect.provide(NodeServices.layer),
    Effect.provide(NodeCrypto.layer)
  ))
  await Effect.runPromise(Effect.void.pipe(Effect.provide(NodeControl.engineDurable(root).runtime)))
  const state = { version: 1, flowName: "agent/run", payload: { runId: "run-1", planId: "plan-1" } }
  edit(root, "engine", (db) => {
    db.prepare("INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1','suspended',0,?)")
      .run(JSON.stringify(state))
  })
  edit(root, "control", (db) => {
    db.prepare(
      "INSERT INTO control_plans(plan_id,card_json,decoded_input_json,decision) VALUES('plan-1','{}','{}','approved')"
    ).run()
    db.prepare("INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1','suspended',0,?)").run(
      JSON.stringify({
        runId: "run-1",
        flowId: "fixture",
        planId: "plan-1",
        planDigest: "digest",
        status: "parked",
        createdAt: 0,
        updatedAt: 0
      })
    )
    const insert = db.prepare(
      "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('run-1',?,?,'fixture',?,0,'example.output',?,'{}')"
    )
    insert.run(1, "one", 1, JSON.stringify({ value: 1 }))
    insert.run(2, "two", 2, JSON.stringify({ value: 2 }))
  })
  return root
}

/** Every schema object and every row count, for proving a command wrote nothing. */
const snapshot = (root: string) =>
  Object.fromEntries((["control", "engine"] as const).map((kind) => {
    const db = open(root, kind)
    try {
      const objects = db.prepare("SELECT type, name FROM sqlite_master ORDER BY type, name").all() as Array<
        { type: string; name: string }
      >
      const counts = objects.filter((object) => object.type === "table").map((table) => [
        table.name,
        (db.prepare(`SELECT count(*) AS n FROM "${table.name}"`).get() as { n: number }).n
      ])
      return [kind, { objects, counts }]
    } finally {
      db.close()
    }
  }))

/** Holds both stores' writer, as a live host mid-transaction does. */
const holdWriters = <A>(root: string, body: () => Promise<A>): Promise<A> => {
  const writers = (["control", "engine"] as const).map((kind) => open(root, kind))
  for (const writer of writers) writer.exec("BEGIN IMMEDIATE")
  return body().finally(() => {
    for (const writer of writers) {
      writer.exec("ROLLBACK")
      writer.close()
    }
  })
}

const ledger = (root: string) => {
  const db = open(root, "control")
  try {
    return (db.prepare("SELECT count(*) AS n FROM flows_migrations").get() as { n: number }).n
  } finally {
    db.close()
  }
}

describe("observing verbs", { timeout: 240_000 }, () => {
  it("approvals list reads an older control schema without migrating it while the writer is held", async () => {
    const root = await fixture()
    edit(root, "control", (db) => {
      // A control.db written before the history rung: no table, no ledger row.
      db.exec("DROP TABLE smthrs_history_applied")
      db.exec("DELETE FROM flows_migrations WHERE name LIKE '%applied_audits'")
    })
    const before = ledger(root)
    const result = await holdWriters(root, () => run(root, ["approvals", "list"]))
    expect(result.code, result.stdout + result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual([])
    expect(ledger(root)).toBe(before)
    edit(root, "control", (db) => {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'smthrs_history_applied'").get())
        .toBeUndefined()
    })
  })

  it("runs list, show and logs answer from both stores and write nothing while the writer is held", async () => {
    const root = await fixture()
    const before = snapshot(root)
    const files = (await readdir(join(root, ".flows"))).sort()
    const [listed, shown, logs] = await holdWriters(root, () =>
      Promise.all([
        run(root, ["runs", "list"]),
        run(root, ["runs", "show", "run-1"]),
        run(root, ["runs", "logs", "run-1"])
      ]))
    expect(listed.code, listed.stdout + listed.stderr).toBe(0)
    expect(JSON.parse(listed.stdout)).toMatchObject({ _tag: "runs", items: [{ runId: "run-1", status: "parked" }] })
    expect(shown.code, shown.stdout + shown.stderr).toBe(0)
    expect(JSON.parse(shown.stdout)).toMatchObject({ runId: "run-1", status: "parked" })
    expect(logs.code, logs.stdout + logs.stderr).toBe(0)
    expect(JSON.parse(logs.stdout).map((event: { sequence: number }) => event.sequence)).toEqual([1, 2])
    expect(snapshot(root)).toEqual(before)
    expect((await readdir(join(root, ".flows"))).sort()).toEqual(files)
  })
})

/** Every observing verb, each over the one parked run. */
const verbs = [
  ["runs", "list"],
  ["runs", "count"],
  ["runs", "show", "run-1"],
  ["runs", "devtools", "run-1"],
  ["runs", "logs", "run-1"],
  ["approvals", "list"]
] as const

/** The refusal an observing verb answers over a store it cannot read. */
const refusesOlderStore = (
  result: { code: number | null; stdout: string; stderr: string },
  verb: ReadonlyArray<string>,
  root: string
) => {
  expect(result.code, result.stdout + result.stderr).toBe(1)
  const refusal = JSON.parse(result.stdout) as { code: string; message: string }
  expect(refusal).toEqual({
    code: "store_schema_older",
    message: `${verb.slice(0, 2).join(" ")} cannot read the store at ${
      join(root, ".flows")
    }: an older smthrs wrote it. Run smthrs serve to migrate it.`
  })
}

describe("observing verbs over an older store", { timeout: 240_000 }, () => {
  // Each store predates something some verbs read: control.db lacks its runs'
  // state column, then its journal table; engine.db lacks its runs table. A
  // verb that reads what is missing refuses typed; every other verb still
  // reads the older schema as found. Neither changes the store.
  it.each(
    [
      ["control", "ALTER TABLE flows_runs RENAME COLUMN state_json TO state_json_before", ["logs"]],
      ["control", "ALTER TABLE flows_journal_events RENAME TO flows_journal_events_before", []],
      ["engine", "ALTER TABLE flows_runs RENAME TO flows_runs_before", ["logs"]]
    ] as const
  )("%s.db after `%s`: readers refuse, %j still answer", async (kind, statement, answering) => {
    const root = await fixture()
    edit(root, kind, (db) => db.exec(statement))
    const before = snapshot(root)
    // One at a time: concurrent read-only opens of a quiescent WAL store race (#3170).
    for (const verb of verbs) {
      const result = await run(root, verb)
      if ((answering as ReadonlyArray<string>).includes(verb[1])) {
        expect(result.code, `${verb.join(" ")}: ${result.stdout}${result.stderr}`).toBe(0)
      } else refusesOlderStore(result, verb, root)
    }
    expect(snapshot(root)).toEqual(before)
  })
})

/** Runs `body` against the observing host over `root`, in this process. */
const observe = <A, E>(root: string, body: (control: Control.Service) => Effect.Effect<A, E>) =>
  Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
    const context = yield* Layer.build(NodeControl.layerObserve({ root }))
    return yield* body(Context.get(context, Control.Control))
  })))

describe("observing host", { timeout: 120_000 }, () => {
  it("answers from control.db alone when the project has no engine.db", async () => {
    const root = await fixture()
    for (const suffix of ["", "-wal", "-shm"]) await unlink(join(root, ".flows", `engine.db${suffix}`)).catch(() => {})
    const exit = await observe(root, (control) => control.list({ _tag: "runs", filters: { runId: "run-1" } }))
    expect(exit).toMatchObject({ _tag: "Success", value: { items: [{ runId: "run-1", status: "parked" }] } })
    expect(await readdir(join(root, ".flows"))).not.toContain("engine.db")
  })

  it("changes nothing when asked to cancel", async () => {
    const root = await fixture()
    const before = snapshot(root)
    const exit = await observe(root, (control) => control.cancel({ runId: "run-1", idempotencyKey: "observe-cancel" }))
    expect(Exit.isFailure(exit)).toBe(true)
    expect(snapshot(root)).toEqual(before)
  })
})

// The storage matrix (`flows/database/scripts/test-matrix.mjs`) provides SMITHERS_TEST_PG_URL.
const postgres = process.env.SMITHERS_HISTORY_TEST_PG_URL || process.env.SMITHERS_TEST_PG_URL

/** A project whose stores are PostgreSQL schemas holding one run, selected for this process. */
const postgresProject = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smthrs-observe-pg-")))
  directories.push(root)
  const prefix = `test_observe_${randomUUID().replaceAll("-", "")}`
  const env = { SMITHERS_POSTGRES_URL: postgres!, SMITHERS_POSTGRES_SCHEMA: prefix, SMITHERS_BACKEND: "postgres" }
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value)
  const database = (kind: string) => NodeDatabase.layer({ filename: join(root, ".flows", `${kind}.db`) })
  const sql = <A, E>(kind: string, body: (sql: SqlClient) => Effect.Effect<A, E>) =>
    Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      return yield* body(Context.get(yield* Layer.build(database(kind)), SqlClient))
    })))
  /** Every table and column of both schemas, for proving a command wrote nothing. */
  const schema = () =>
    sql(
      "control",
      (sql) =>
        sql<{ name: string }>`SELECT table_schema || '.' || table_name || '.' || column_name AS name
          FROM information_schema.columns WHERE table_schema LIKE ${`${prefix}%`} ORDER BY name`
    )
  const cleanup = async () => {
    await sql(
      "control",
      (sql) =>
        Effect.forEach(
          ["engine", "control"],
          (kind) => sql`DROP SCHEMA IF EXISTS ${sql(`${prefix}_${kind}_db`)} CASCADE`
        )
    )
    vi.unstubAllEnvs()
  }
  try {
    await Effect.runPromise(Effect.void.pipe(
      Effect.provide(NodeRuntime.storage(join(root, ".flows", "engine.db"), root)),
      Effect.provide(NodeServices.layer),
      Effect.provide(NodeCrypto.layer)
    ))
    await Effect.runPromise(Effect.void.pipe(Effect.provide(NodeControl.engineDurable(root).runtime)))
    await sql(
      "engine",
      (sql) =>
        sql`INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1','suspended',0,${
          JSON.stringify({ version: 1, flowName: "agent/run", payload: {} })
        })`
    )
    await sql("control", (sql) =>
      Effect.gen(function*() {
        yield* sql`INSERT INTO control_plans(plan_id,card_json,decoded_input_json,decision) VALUES('plan-1','{}','{}','approved')`
        yield* sql`INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1','suspended',0,${
          JSON.stringify({
            runId: "run-1",
            flowId: "fixture",
            planId: "plan-1",
            planDigest: "digest",
            status: "running",
            createdAt: 0,
            updatedAt: 0
          })
        })`
      }))
  } catch (error) {
    await cleanup()
    throw error
  }
  return { root, env, database, sql, schema, cleanup }
}

describe.skipIf(!postgres)("observing host over PostgreSQL", { timeout: 120_000 }, () => {
  it("reads both schemas without creating, migrating or waiting on the writer", async () => {
    const { root, database, schema, cleanup } = await postgresProject()
    try {
      const before = await schema()
      // A peer mid-write holds both schemas' writer lock throughout the read.
      const exit = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const control = Context.get(yield* Layer.build(database("control")), SqlClient)
        const engine = Context.get(yield* Layer.build(database("engine")), SqlClient)
        return yield* control.withTransaction(engine.withTransaction(Effect.gen(function*() {
          yield* control`UPDATE control_plans SET decision = 'approved'`
          yield* engine`UPDATE flows_runs SET status = 'suspended'`
          return yield* Effect.promise(() =>
            observe(root, (observer) => observer.list({ _tag: "runs", filters: { runId: "run-1" } }))
          )
        })))
      })))
      expect(exit).toMatchObject({ _tag: "Success", value: { items: [{ runId: "run-1", status: "parked" }] } })
      expect(await schema()).toEqual(before)
    } finally {
      await cleanup()
    }
  })

  it("refuses typed where an older schema lacks a column a verb reads, and reads the rest as found", async () => {
    const { root, env, sql, schema, cleanup } = await postgresProject()
    try {
      await sql("control", (sql) => sql`ALTER TABLE flows_runs RENAME COLUMN state_json TO state_json_before`)
      const before = await schema()
      const listed = await run(root, ["runs", "list"], env)
      const logs = await run(root, ["runs", "logs", "run-1"], env)
      refusesOlderStore(listed, ["runs", "list"], root)
      expect(logs.code, logs.stdout + logs.stderr).toBe(0)
      expect(JSON.parse(logs.stdout)).toEqual([])
      expect(await schema()).toEqual(before)
    } finally {
      await cleanup()
    }
  })
})
