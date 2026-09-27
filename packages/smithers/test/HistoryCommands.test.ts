import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { forkWorkspaceName } from "@smthrs/time-travel/TimeTravel"
import { Effect } from "effect"
import { Cli } from "incur"
import { execFileSync, spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { afterAll, describe, expect, it } from "vitest"
import { appendHistoryCommands } from "../src/cli/HistoryCommands.ts"
import * as History from "../src/history/History.ts"
import * as Workspace from "../src/history/Workspace.ts"
import * as NodeControl from "../src/NodeControl.ts"

const directories: Array<string> = []
afterAll(async () => {
  await Promise.all(directories.map((directory) => rm(directory, { recursive: true, force: true })))
})

const fixture = async (withJj = false) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "smthrs-history-")))
  directories.push(root)
  if (withJj) execFileSync("jj", ["git", "init", root], { stdio: "ignore" })
  await Effect.runPromise(Effect.void.pipe(
    Effect.provide(NodeRuntime.storage(join(root, ".flows", "engine.db"), root)),
    Effect.provide(NodeServices.layer),
    Effect.provide(NodeCrypto.layer)
  ))
  await Effect.runPromise(Effect.void.pipe(Effect.provide(NodeControl.engineDurable(root).runtime)))
  const engine = new DatabaseSync(join(root, ".flows", "engine.db"))
  const state = { version: 1, flowName: "agent/run", payload: { runId: "run-1", planId: "plan-1" } }
  engine.prepare("INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1','suspended',0,?)").run(
    JSON.stringify(state)
  )
  const insert = engine.prepare(
    "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('run-1',?,?, 'fixture',?,0,?,?,?)"
  )
  insert.run(
    1,
    "one",
    1,
    "flows.engine.run-decision",
    JSON.stringify({ state, decision: "created" }),
    JSON.stringify({ lineageId: "fixture/root" })
  )
  insert.run(
    2,
    "two",
    2,
    "example.output",
    JSON.stringify({ value: "saved" }),
    JSON.stringify({ lineageId: "fixture/root" })
  )
  engine.close()
  const control = new DatabaseSync(join(root, ".flows", "control.db"))
  control.prepare(
    "INSERT INTO control_plans(plan_id,card_json,decoded_input_json,decision) VALUES('plan-1','{}','{}','approved')"
  ).run()
  const summary = {
    runId: "run-1",
    flowId: "fixture",
    planId: "plan-1",
    planDigest: "digest",
    status: "parked",
    createdAt: 0,
    updatedAt: 0
  }
  control.prepare("INSERT INTO flows_runs(run_id,status,created_at_ms,state_json) VALUES('run-1','suspended',0,?)").run(
    JSON.stringify(summary)
  )
  control.close()
  return root
}

const serve = async (root: string, args: Array<string>) => {
  let output = ""
  let exitCode = 0
  await appendHistoryCommands(Cli.create("runs"), { environment: {} }).serve([...args, "--root", root, "--json"], {
    stdout: (text) => {
      output += text
    },
    exit: (code) => {
      exitCode = code
    }
  })
  return { output, exitCode }
}

const editDatabase = (root: string, kind: "engine" | "control", edit: (db: DatabaseSync) => void) => {
  const db = new DatabaseSync(join(root, ".flows", `${kind}.db`))
  try {
    edit(db)
  } finally {
    db.close()
  }
}

const addOutputs = (root: string, last: number) => {
  editDatabase(root, "engine", (db) => {
    const insert = db.prepare(
      "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('run-1',?,?,'fixture',?,0,'example.output',?,?)"
    )
    db.exec("BEGIN")
    for (let seq = 3; seq <= last; seq++) {
      insert.run(
        seq,
        `event-${seq}`,
        seq,
        JSON.stringify({ value: seq }),
        JSON.stringify({ lineageId: "fixture/root" })
      )
    }
    db.exec("COMMIT")
  })
}

describe("history boundaries and refusal postconditions", () => {
  it("reads every event across page boundaries with an inclusive resource limit", async () => {
    const root = await fixture()
    addOutputs(root, 503)
    const result = await History.read(root, "run-1", { limit: 503 }, true)
    expect(result.position.frame).toEqual({ lineageId: "fixture/root", seq: 503 })
    expect(result.entryCount).toBe(503)
    expect(result.events?.map((event) => event.seq)).toEqual(Array.from({ length: 503 }, (_, index) => index + 1))
    expect(result.eventTypes).toEqual({ "flows.engine.run-decision": 1, "example.output": 502 })
    expect(result.state).toEqual({ version: 1, flowName: "agent/run", payload: { runId: "run-1", planId: "plan-1" } })
    await expect(History.read(root, "run-1", { limit: 502 }, false)).rejects.toThrow("exceeds --limit 502")
  })

  it("pages the entire rewind suffix and rejects one event beyond its limit", async () => {
    const root = await fixture()
    addOutputs(root, 503)
    const before = await readFile(join(root, ".flows", "engine.db"))
    const result = await History.preview(root, "run-1", { sequence: 1, limit: 502 })
    expect(result).toMatchObject({ entriesToArchive: 502, active: false, effects: [], blockedEffects: [] })
    await expect(History.preview(root, "run-1", { sequence: 1, limit: 501 })).rejects.toThrow("suffix exceeds --limit")
    expect(await readFile(join(root, ".flows", "engine.db"))).toEqual(before)
  })

  it("requires an addressable lineage and never silently selects a different one", async () => {
    const root = await fixture()
    await expect(History.read(root, "run-1", { sequence: 2, lineage: "different" }, false)).rejects.toThrow("no frame")
    await expect(History.read(root, "run-1", { lineage: "different" }, false)).rejects.toThrow("no addressable")
    editDatabase(root, "engine", (db) => db.exec("UPDATE flows_journal_events SET meta_json='null'"))
    await expect(History.read(root, "run-1", {}, false)).rejects.toThrow("no addressable")
    editDatabase(root, "engine", (db) => db.exec("DELETE FROM flows_journal_events"))
    await expect(History.read(root, "run-1", {}, true)).rejects.toThrow("no addressable")
    expect(await History.read(root, "run-1", { sequence: 0, lineage: "explicit" }, true)).toMatchObject({
      position: { frame: { seq: 0, lineageId: "explicit" } },
      entryCount: 0,
      events: [],
      sealed: []
    })
  })

  it("refuses a missing engine database and remote environment without creating local state", async () => {
    const root = await fixture()
    await rm(join(root, ".flows"), { recursive: true })
    await expect(History.read(root, "run-1", {}, false)).rejects.toThrow("No execution history")
    expect(() => History.localRoot({ root }, { SMITHERS_REMOTE: "https://example.invalid" })).toThrow(
      "--remote is not supported"
    )
    await expect(History.reconcile(root)).resolves.toBeUndefined()
    await expect(readFile(join(root, ".flows", "engine.db"))).rejects.toMatchObject({ code: "ENOENT" })
  })

  it.each(["owner", "claim"])(
    "reports a live %s and retains irreversible boundaries in the preview",
    async (active) => {
      const root = await fixture()
      editDatabase(root, "engine", (db) => {
        db.exec(
          active === "owner"
            ? "UPDATE flows_runs SET status='running',owner_host_id='fixture',owner_pid=1,owner_nonce='owner',heartbeat_at_ms=0"
            : "UPDATE flows_runs SET claim_host_id='fixture',claim_pid=1,claim_nonce='claim',claimed_at_ms=0"
        )
        const insert = db.prepare(
          "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('run-1',?,?,'fixture',?,0,'flows.time-travel.effect-boundary',?,?)"
        )
        for (const [index, tier] of ["sealed", "irreversible"].entries()) {
          const seq = index + 3
          insert.run(
            seq,
            `effect-${seq}`,
            seq,
            JSON.stringify({
              version: 1,
              effect: {
                id: `effect-${seq}`,
                kind: "fixture",
                tier,
                status: "intended",
                runId: "run-1",
                lineageId: "fixture/root"
              }
            }),
            JSON.stringify({ lineageId: "fixture/root" })
          )
        }
      })
      const result = await History.preview(root, "run-1", { sequence: 1 })
      expect(result.active).toBe(true)
      expect(result.effects.map((effect) => effect.tier)).toEqual(["sealed", "irreversible"])
      expect(result.blockedEffects.map((effect) => effect.id)).toEqual(["effect-4"])
      expect(result.entriesToArchive).toBe(3)
    }
  )

  it.each([
    ["missing run", "DELETE FROM flows_runs WHERE run_id='run-1'", "No control-plane run"],
    [
      "running",
      "UPDATE flows_runs SET status='running',owner_host_id='fixture',owner_pid=1,owner_nonce='owner',heartbeat_at_ms=0",
      "active or claimed"
    ],
    [
      "claimed",
      "UPDATE flows_runs SET claim_host_id='fixture',claim_pid=1,claim_nonce='claim',claimed_at_ms=0",
      "active or claimed"
    ],
    ["missing plan identity", "UPDATE flows_runs SET state_json='{}'", "no approved public CLI plan"],
    ["unapproved plan", "UPDATE control_plans SET decision='rejected'", "plan is not approved"],
    ["absent plan", "DELETE FROM control_plans", "plan is not approved"]
  ])("refuses history mutation with %s and releases its transaction", async (_name, sql, message) => {
    const root = await fixture()
    editDatabase(root, "control", (db) => db.exec(sql))
    const before = await readFile(join(root, ".flows", "engine.db"))
    await expect(History.mutate(root, "run-1", { sequence: 1 }, "rewind")).rejects.toThrow(message)
    expect(await readFile(join(root, ".flows", "engine.db"))).toEqual(before)
    editDatabase(root, "control", (db) => {
      // A second writer can acquire the lock after refusal; no audit was committed.
      db.exec("BEGIN IMMEDIATE")
      expect(db.prepare("SELECT 1 FROM smthrs_history_applied").get()).toBeUndefined()
      db.exec("ROLLBACK")
    })
  })

  it("refuses a standalone fork and a missing control database before creating recovery state", async () => {
    const root = await fixture()
    editDatabase(
      root,
      "engine",
      (db) => db.exec("UPDATE flows_runs SET state_json=json_set(state_json,'$.flowName','standalone')")
    )
    await expect(History.mutate(root, "run-1", { sequence: 1 }, "fork")).rejects.toThrow("not a public agent flow")
    await rm(join(root, ".flows", "control.db"))
    await expect(History.mutate(root, "run-1", { sequence: 1 }, "rewind")).rejects.toThrow("approved control plan")
    await expect(History.reconcile(root)).resolves.toBeUndefined()
    editDatabase(root, "engine", (db) => {
      expect(db.prepare("SELECT 1 FROM sqlite_master WHERE name='flows_time_travel_audits'").get()).toBeUndefined()
    })
  })

  it("refuses an unlinked fork and a missing retained worktree", async () => {
    const root = await fixture()
    editDatabase(root, "engine", (db) => {
      db.exec("CREATE TABLE flows_time_travel_edges(child_run_id TEXT,parent_run_id TEXT,kind TEXT)")
      db.exec("INSERT INTO flows_time_travel_edges VALUES('run-1','standalone','fork')")
    })
    await expect(History.mutate(root, "run-1", { sequence: 1 }, "rewind")).rejects.toThrow(
      "needs history reconciliation"
    )
    await expect(History.prepare(root, "run-1")).rejects.toThrow("has not been linked")
    editDatabase(root, "engine", (db) => {
      db.exec("CREATE TABLE smthrs_history_workspaces(run_id TEXT PRIMARY KEY,workspace TEXT)")
      db.prepare("INSERT INTO smthrs_history_workspaces VALUES('run-1',?)").run(join(root, "missing-worktree"))
    })
    await expect(History.prepare(root, "run-1")).rejects.toThrow("workspace no longer exists")
  })

  it("rolls back all control reconciliation when a later audit is still actively claimed", async () => {
    const root = await fixture()
    editDatabase(root, "engine", (db) => {
      db.exec("CREATE TABLE flows_time_travel_audits(id TEXT,run_id TEXT,status TEXT)")
      db.exec(
        "INSERT INTO flows_time_travel_audits VALUES('completed','absent','completed'),('blocked','run-1','completed')"
      )
    })
    editDatabase(
      root,
      "control",
      (db) => db.exec("UPDATE flows_runs SET claim_host_id='fixture',claim_pid=1,claim_nonce='claim',claimed_at_ms=0")
    )
    await expect(History.reconcile(root)).rejects.toThrow("active or claimed")
    editDatabase(root, "control", (db) => {
      expect(db.prepare("SELECT 1 FROM smthrs_history_applied").get()).toBeUndefined()
      expect(db.prepare("SELECT claim_nonce FROM flows_runs WHERE run_id='run-1'").get()?.claim_nonce).toBe("claim")
      db.exec("UPDATE flows_runs SET claim_host_id=NULL,claim_pid=NULL,claim_nonce=NULL,claimed_at_ms=NULL")
    })
    await History.reconcile(root)
    editDatabase(root, "control", (db) => {
      expect(db.prepare("SELECT audit_id FROM smthrs_history_applied ORDER BY audit_id").all()).toEqual([
        { audit_id: "blocked" },
        { audit_id: "completed" }
      ])
      expect(db.prepare("SELECT waiting_reason FROM flows_runs WHERE run_id='run-1'").get()?.waiting_reason).toBe(
        "history"
      )
    })
  })

  it("does not execute a fork whose workspace link survived a rolled-back control reconciliation", async () => {
    const root = await fixture()
    const workspace = join(root, ".flows", "forks", forkWorkspaceName("child"))
    await mkdir(join(workspace, ".jj"), { recursive: true })
    editDatabase(root, "engine", (db) => {
      db.exec("CREATE TABLE flows_time_travel_edges(child_run_id TEXT,parent_run_id TEXT,kind TEXT)")
      db.exec("INSERT INTO flows_time_travel_edges VALUES('child','run-1','fork'),('unfinished','run-1','fork')")
      db.exec(
        "INSERT INTO flows_runs(run_id,status,created_at_ms,parent_run_id,state_json) VALUES('child','suspended',0,'run-1','{\"flowName\":\"agent/run\"}')"
      )
      db.exec(
        "INSERT INTO flows_runs(run_id,status,created_at_ms,parent_run_id,state_json) VALUES('grandchild','pending',0,'child','{}')"
      )
    })
    await expect(History.reconcile(root)).rejects.toThrow("no retained workspace")
    editDatabase(root, "control", (db) => {
      expect(db.prepare("SELECT 1 FROM flows_runs WHERE run_id='child'").get()).toBeUndefined()
    })
    // engine.db and control.db cannot commit atomically. A surviving route is
    // only a location; it does not prove the public control identity committed.
    expect(await Workspace.workspaceFor(root, "child")).toBe(workspace)
    expect(await Workspace.canExecute(root, workspace, "child")).toBe(false)
    expect(await Workspace.canExecute(root, workspace, "grandchild")).toBe(false)
    editDatabase(root, "engine", (db) => db.exec("DELETE FROM flows_time_travel_edges WHERE child_run_id='unfinished'"))
    await History.reconcile(root)
    expect(await Workspace.canExecute(root, workspace, "child")).toBe(true)
    expect(await Workspace.canExecute(root, workspace, "grandchild")).toBe(true)
    await rm(join(root, ".flows", "control.db"))
    expect(await Workspace.canExecute(root, workspace, "child")).toBe(false)
    expect(await Workspace.canExecute(root, workspace, "grandchild")).toBe(false)
  })

  it.each(["workspace", "absent", "active", "standalone"])("keeps an invalid fork unlinked (%s)", async (problem) => {
    const root = await fixture()
    editDatabase(root, "engine", (db) => {
      db.exec("CREATE TABLE flows_time_travel_edges(child_run_id TEXT,parent_run_id TEXT,kind TEXT)")
      db.exec("INSERT INTO flows_time_travel_edges VALUES('child','run-1','fork')")
      if (problem !== "absent") {
        db.prepare(
          "INSERT INTO flows_runs(run_id,status,created_at_ms,parent_run_id,state_json) VALUES('child','pending',0,'run-1',?)"
        )
          .run(JSON.stringify({ flowName: problem === "standalone" ? "standalone" : "agent/run" }))
      }
      if (problem === "active") {
        db.exec(
          "UPDATE flows_runs SET status='running',owner_host_id='fixture',owner_pid=1,owner_nonce='owner',heartbeat_at_ms=0 WHERE run_id='child'"
        )
      }
    })
    if (problem !== "workspace") {
      await mkdir(join(root, ".flows", "forks", forkWorkspaceName("child"), ".jj"), { recursive: true })
    }
    await expect(History.reconcile(root)).rejects.toThrow(
      problem === "workspace"
        ? "no retained workspace"
        : problem === "standalone"
        ? "not a public agent flow"
        : "absent or already active"
    )
    editDatabase(root, "control", (db) => {
      expect(db.prepare("SELECT 1 FROM flows_runs WHERE run_id='child'").get()).toBeUndefined()
      expect(db.prepare("SELECT 1 FROM smthrs_history_applied").get()).toBeUndefined()
    })
    expect(await Workspace.workspaceFor(root, "child")).toBeUndefined()
  })

  it("owns the applied-audit table through the control migration ledger, including pre-history databases", async () => {
    const root = await fixture()
    const ledger = (db: DatabaseSync) =>
      db.prepare("SELECT name FROM flows_migrations WHERE name LIKE '%applied_audits'").all().map((row) => row.name)
    editDatabase(root, "control", (db) => {
      expect(ledger(db)).toHaveLength(1)
      // A control.db written before the history rung: no table, no ledger row.
      db.exec("DROP TABLE smthrs_history_applied")
      db.exec("DELETE FROM flows_migrations WHERE name LIKE '%applied_audits'")
    })
    editDatabase(root, "engine", (db) => {
      db.exec("CREATE TABLE flows_time_travel_audits(id TEXT,run_id TEXT,status TEXT)")
      db.exec("INSERT INTO flows_time_travel_audits VALUES('audit-1','run-1','completed')")
    })
    await History.reconcile(root)
    editDatabase(root, "control", (db) => {
      expect(ledger(db)).toHaveLength(1)
      expect(db.prepare("SELECT audit_id FROM smthrs_history_applied").all()).toEqual([{ audit_id: "audit-1" }])
    })
  })
})

describe("durable history CLI", () => {
  it.skipIf(spawnSync("jj", ["--version"], { stdio: "ignore" }).status !== 0)(
    "rewinds stored evidence and leaves both stores consistently parked",
    async () => {
      const root = await fixture(true)
      const result = await History.mutate(root, "run-1", { sequence: 1 }, "rewind")
      expect(result).toHaveProperty("auditId")
      const engine = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
      const control = new DatabaseSync(join(root, ".flows", "control.db"), { readOnly: true })
      expect(engine.prepare("SELECT count(*) AS n FROM flows_time_travel_archive WHERE run_id='run-1'").get()!.n).toBe(
        1
      )
      expect(
        engine.prepare(
          "SELECT count(*) AS n FROM flows_journal_events WHERE run_id='run-1' AND event_type='example.output'"
        ).get()!.n
      ).toBe(0)
      expect(engine.prepare("SELECT status FROM flows_runs WHERE run_id='run-1'").get()!.status).toBe("suspended")
      expect(
        JSON.parse(String(control.prepare("SELECT state_json FROM flows_runs WHERE run_id='run-1'").get()!.state_json))
          .status
      ).toBe("parked")
      expect(await Workspace.canExecute(root, root, "run-1")).toBe(true)
      engine.close()
      control.close()
    }
  )

  it.skipIf(spawnSync("jj", ["--version"], { stdio: "ignore" }).status !== 0)(
    "restores a bookmark moved during the run with rewind --whole-repo",
    async () => {
      const root = await fixture(true)
      const jj = (...args: Array<string>) =>
        execFileSync("jj", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
      // A bookmark on a closed change, so it does not follow later working-copy captures.
      jj("commit", "--message=base")
      jj("bookmark", "create", "release", "-r", "@-")
      const before = jj("log", "--no-graph", "-r", "release", "-T", "commit_id")
      const operationId = jj("op", "log", "-n1", "--no-graph", "-T", "id")
      const commitId = jj("log", `--at-op=${operationId}`, "-r", "@", "--no-graph", "-T", "commit_id")
      const meta = JSON.stringify({ lineageId: "fixture/root" })
      editDatabase(root, "engine", (db) => {
        const insert = db.prepare(
          "INSERT INTO flows_journal_events(run_id,seq,event_id,source_id,source_seq,emitted_at_ms,event_type,payload_json,meta_json) VALUES('run-1',?,?,'fixture',?,0,?,?,?)"
        )
        insert.run(
          3,
          "snapshot",
          3,
          "flows.engine.snapshot-identified",
          JSON.stringify({ snapshotId: commitId, operationId }),
          meta
        )
        insert.run(
          4,
          "effect",
          4,
          "flows.time-travel.effect-boundary",
          JSON.stringify({
            version: 1,
            effect: {
              id: "move",
              kind: "jj",
              tier: "compensable",
              status: "succeeded",
              runId: "run-1",
              lineageId: "fixture/root",
              durableBoundary: true,
              providerStream: false
            }
          }),
          meta
        )
      })
      jj("bookmark", "set", "release", "-r", "root()", "--allow-backwards")

      const result = await serve(root, ["rewind", "run-1", "--at", "3", "--yes", "--whole-repo"])

      expect(result.exitCode).toBe(0)
      expect(jj("log", "--no-graph", "-r", "release", "-T", "commit_id")).toBe(before)
    }
  )

  it("replays real stored evidence without modifying the database or building recovery", async () => {
    const root = await fixture()
    const before = await readFile(join(root, ".flows", "engine.db"))
    const result = await History.read(root, "run-1", { sequence: 1 }, true)
    expect(result.position.frame).toEqual({ lineageId: "fixture/root", seq: 1 })
    expect(result.entryCount).toBe(1)
    expect(result.state).toMatchObject({ flowName: "agent/run" })
    expect(await readFile(join(root, ".flows", "engine.db"))).toEqual(before)
    const db = new DatabaseSync(join(root, ".flows", "engine.db"), { readOnly: true })
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='flows_time_travel_audits'").get()).toBeUndefined()
    db.close()
  })

  it("rejects absent frames and bounded reads", async () => {
    const root = await fixture()
    await expect(History.read(root, "run-1", { sequence: 99 }, false)).rejects.toThrow("no frame")
    await expect(History.read(root, "run-1", { limit: 1 }, false)).rejects.toThrow("exceeds")
    expect((await History.read(root, "run-1", { sequence: 0 }, false)).entryCount).toBe(0)
  })

  it("previews a suffix and requires explicit confirmation before rewind", async () => {
    const root = await fixture()
    const preview = await serve(root, ["rewind", "run-1", "--at", "1", "--preview"])
    expect(preview.exitCode).toBe(0)
    expect(preview.output).toContain("\"entriesToArchive\": 1")
    const refused = await serve(root, ["rewind", "run-1", "--at", "1"])
    expect(refused.exitCode).toBe(2)
    expect(refused.output).toContain("--yes")
    expect((await History.read(root, "run-1", {}, true)).entryCount).toBe(2)
  })

  it("keeps remote requests from creating local state", async () => {
    const root = join(tmpdir(), `missing-history-${Date.now()}`)
    const result = await serve(root, ["inspect", "run-1", "--remote", "https://example.invalid"])
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("--remote is not supported")
    await expect(realpath(root)).rejects.toMatchObject({ code: "ENOENT" })
    expect(() => History.localRoot({ root }, { SMITHERS_REMOTE: "" })).toThrow("is not an accessible directory")
    const local = await mkdtemp(join(tmpdir(), "local-history-"))
    directories.push(local)
    expect(History.localRoot({ root: local }, { SMITHERS_REMOTE: "" })).toBe(local)
  })

  it("blocks restart after a committed rewind until control reconciliation has completed", async () => {
    const root = await fixture()
    const engine = new DatabaseSync(join(root, ".flows", "engine.db"))
    engine.exec("CREATE TABLE flows_time_travel_audits(id TEXT,run_id TEXT,status TEXT)")
    engine.exec("INSERT INTO flows_time_travel_audits VALUES('audit','run-1','completed')")
    const control = new DatabaseSync(join(root, ".flows", "control.db"))
    control.exec(
      "UPDATE flows_runs SET status='completed',state_json=json_set(state_json,'$.status','completed') WHERE run_id='run-1'"
    )
    expect(await Workspace.canExecute(root, root, "run-1")).toBe(false)
    await History.reconcile(root)
    expect(await Workspace.canExecute(root, root, "run-1")).toBe(true)
    expect(
      JSON.parse(String(control.prepare("SELECT state_json FROM flows_runs WHERE run_id='run-1'").get()!.state_json))
        .status
    ).toBe("parked")
    await History.reconcile(root)
    expect(control.prepare("SELECT count(*) AS n FROM smthrs_history_applied").get()!.n).toBe(1)
    control.close()
    engine.close()
  })

  it("denies an unlinked fork and routes linked children and nested runs to their worktree", async () => {
    const root = await fixture()
    const db = new DatabaseSync(join(root, ".flows", "engine.db"))
    db.exec("CREATE TABLE flows_time_travel_edges(child_run_id TEXT, parent_run_id TEXT, kind TEXT)")
    db.exec(
      "INSERT INTO flows_runs(run_id,status,created_at_ms,parent_run_id,state_json) VALUES('child','pending',0,'run-1','{}')"
    )
    db.exec(
      "INSERT INTO flows_runs(run_id,status,created_at_ms,parent_run_id,state_json) VALUES('grandchild','pending',0,'child','{}')"
    )
    db.exec("INSERT INTO flows_time_travel_edges VALUES('child','run-1','fork')")
    expect(await Workspace.canExecute(root, root, "child")).toBe(false)
    db.exec("CREATE TABLE smthrs_history_workspaces(run_id TEXT, workspace TEXT)")
    db.prepare("INSERT INTO smthrs_history_workspaces VALUES('child',?)").run(join(root, "branch"))
    expect(await Workspace.canExecute(root, root, "grandchild")).toBe(false)
    expect(await Workspace.canExecute(root, join(root, "branch"), "grandchild")).toBe(false)
    editDatabase(root, "control", (control) => {
      control.exec(
        "INSERT INTO flows_runs(run_id,status,created_at_ms,parent_run_id,state_json) VALUES('child','suspended',0,'run-1','{}')"
      )
    })
    expect(await Workspace.canExecute(root, join(root, "branch"), "grandchild")).toBe(true)
    expect(await Workspace.canExecute(root, join(root, "branch"), "run-1")).toBe(false)
    db.close()
  })

  it.skipIf(spawnSync("jj", ["--version"], { stdio: "ignore" }).status !== 0)(
    "forks into a retained workspace with an independent control identity",
    async () => {
      const root = await fixture(true)
      const result = await History.mutate(root, "run-1", { sequence: 1 }, "fork")
      expect(result).toHaveProperty("workspace")
      const child = result.runId
      const workspace = (await History.prepare(root, child)).executionRoot
      expect(execFileSync("jj", ["--repository", workspace, "workspace", "root"], { encoding: "utf8" }).trim()).toBe(
        workspace
      )
      const control = new DatabaseSync(join(root, ".flows", "control.db"), { readOnly: true })
      const childRow = control.prepare("SELECT state_json,parent_run_id FROM flows_runs WHERE run_id=?").get(child)!
      expect(JSON.parse(String(childRow.state_json))).toMatchObject({
        runId: child,
        planId: "plan-1",
        status: "parked"
      })
      expect(childRow.parent_run_id).toBe("run-1")
      expect(
        JSON.parse(String(control.prepare("SELECT state_json FROM flows_runs WHERE run_id='run-1'").get()!.state_json))
          .runId
      ).toBe("run-1")
      expect(await Workspace.canExecute(root, root, child)).toBe(false)
      expect(await Workspace.canExecute(root, workspace, child)).toBe(true)
      control.close()
    }
  )
})
