import { Schema } from "effect"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import test from "node:test"
import type { Reading } from "../accounts.ts"
import { Assignment } from "../schema.ts"

// Refuse to import the old executable: import previously launched a real dashboard.
async function dashboardModule() {
  const source = readFileSync(new URL("../dashboard.ts", import.meta.url), "utf8")
  assert.match(
    source,
    /export (?:async )?function createDashboard/,
    "dashboard needs an import-safe explicit observation boundary"
  )
  return import("../dashboard.ts")
}

test("dashboard exposes an import-safe explicitly selected observation boundary", async () => {
  const module = await dashboardModule()
  assert.equal(typeof module.createDashboard, "function")
})

import { createHash } from "node:crypto"
import { createServer, request } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { runInNewContext } from "node:vm"

const now = Date.parse("2026-09-30T12:00:00Z")
function fixture() {
  const directory = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "dashboard-fixture-"))
  const hostDir = join(directory, "host-a")
  const otherHost = join(directory, "host-b")
  const reportDir = join(hostDir, ".flows/burndown/run-selected")
  for (const host of [hostDir, otherHost]) mkdirSync(join(host, ".flows"), { recursive: true })
  mkdirSync(reportDir, { recursive: true })
  const database = (host: string) => {
    const db = new DatabaseSync(join(host, ".flows/engine.db"))
    db.exec(`CREATE TABLE flows_runs(run_id TEXT PRIMARY KEY, status TEXT, execution_flow TEXT,
      execution_parent_id TEXT, lineage_id TEXT, round_ordinal INTEGER, waiting_reason TEXT,
      waiting_wake_at_ms INTEGER, created_at_ms INTEGER, finished_at_ms INTEGER, state_json TEXT);
      CREATE TABLE flows_attempts(run_id TEXT, state TEXT, outcome_json TEXT, finished_at_ms INTEGER);`)
    return db
  }
  const db = database(hostDir)
  const insert = (
    id: string,
    flow: string,
    parent: string,
    lineage: string,
    status = "running",
    payload: unknown = {}
  ) => {
    db.prepare("INSERT INTO flows_runs VALUES(?,?,?,?,?,1,NULL,NULL,?,NULL,?)")
      .run(id, status, flow, parent, lineage, now - 5000, JSON.stringify({ payload }))
  }
  insert("entry-selected", "burndown", "run-selected", "lineage-selected")
  insert("round-selected", "burndown/round", "entry-selected", "lineage-selected", "running", {
    round: 1,
    landed: 0,
    inFlight: []
  })
  insert("worker-selected", "burndown/worker", "round-selected", "unrelated-worker-lineage", "running", {
    key: "selected-key",
    repo: "smithersai/smithers",
    lead: { n: 2948 },
    extras: []
  })
  insert("entry-newer", "burndown", "run-newer", "lineage-newer")
  insert("round-newer", "burndown/round", "entry-newer", "lineage-newer", "running", { round: 99 })
  insert("worker-foreign", "burndown/worker", "round-newer", "lineage-newer", "running", {
    key: "foreign-key"
  })
  db.close()
  const foreign = database(otherHost)
  foreign.prepare("INSERT INTO flows_runs VALUES(?,?,?,?,?,1,NULL,NULL,?,NULL,?)")
    .run("wrong-host", "failed", "burndown", "run-selected", "wrong-host", now, "{}")
  foreign.close()
  writeFileSync(join(reportDir, "scope.json"), JSON.stringify({ hostDir, runId: "run-selected" }))
  const monitor = (text: string) => writeFileSync(join(reportDir, "monitor.log"), text)
  monitor(`${new Date(now).toISOString()} run-selected HEALTHY selected host verified\n`)
  return {
    directory,
    hostDir,
    otherHost,
    reportDir,
    monitor,
    cleanup: () => rmSync(directory, { recursive: true, force: true })
  }
}
const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
async function dashboard(f: ReturnType<typeof fixture>) {
  const { createDashboard } = await dashboardModule()
  return createDashboard({
    hostDir: f.hostDir,
    runId: "run-selected",
    reportDir: f.reportDir,
    now: () => now,
    loadAccounts: async () => []
  })
}

test("selected host/run lineage isolates workers and renders the existing panel without store writes", async () => {
  const f = fixture()
  let d: Awaited<ReturnType<typeof dashboard>> | undefined
  try {
    const hashes = [f.hostDir, f.otherHost].map((host) => hash(join(host, ".flows/engine.db")))
    d = await dashboard(f)
    const { serveDashboard } = await dashboardModule()
    const url = await serveDashboard(d, 0)
    mkdirSync(join(f.reportDir, "runs/selected-key"), { recursive: true })
    writeFileSync(join(f.reportDir, "runs/selected-key/agent.log"), "selected worker log")
    mkdirSync(join(f.reportDir, "runs/foreign-key"), { recursive: true })
    writeFileSync(join(f.reportDir, "runs/foreign-key/agent.log"), "foreign worker secret")
    const response = await fetch(`${url}/api/state`)
    assert.equal(response.status, 200)
    const state = await response.json()
    assert.equal(state.run.runId, "run-selected")
    assert.equal(state.run.round, 1)
    assert.deepEqual(state.workers.map((w: { key: string }) => w.key), ["selected-key"])
    assert.equal(state.monitor[0].healthy, true)
    assert.equal(state.monitor[0].text, "selected host verified")
    assert.equal(await (await fetch(`${url}/api/log?key=selected-key`)).text(), "selected worker log")
    assert.notEqual(await (await fetch(`${url}/api/log?key=foreign-key`)).text(), "foreign worker secret")
    assert.equal((await fetch(`${url}/api/log?key=..%2Fsecret`)).status, 400)
    const html = await (await fetch(url)).text()
    for (const panel of ["Workers", "Monitor", "Rounds", "Merge queue"]) assert.ok(html.includes(panel))
    // Execute the actual response's renderer against a tiny DOM boundary.
    const elements = new Map<string, { innerHTML: string; textContent: string }>()
    const document = {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "" })
        return elements.get(id)
      },
      querySelectorAll: () => [],
      addEventListener: () => {}
    }
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!.replace(/poll\(\);setInterval\(poll,5000\)/, "")
    runInNewContext(`${script}\nrender(state)`, { document, state, Date, fetch })
    assert.equal(elements.get("runid")!.textContent, "run-selected")
    assert.ok(elements.get("workers")!.innerHTML.includes("selected-key"))
    assert.ok(!elements.get("workers")!.innerHTML.includes("foreign-key"))
    assert.deepEqual([f.hostDir, f.otherHost].map((host) => hash(join(host, ".flows/engine.db"))), hashes)
  } finally {
    await d?.close()
    f.cleanup()
  }
})

test("missing, corrupt and foreign report scope cannot contribute stale status, needs-you or monitor health", async () => {
  const f = fixture()
  const d = await dashboard(f)
  try {
    writeFileSync(join(f.reportDir, "status.txt"), `${new Date(now).toISOString()} round=99 open=900\n`)
    writeFileSync(join(f.reportDir, "NEEDS-YOU.md"), "foreign instructions")
    for (
      const manifest of [
        null,
        "{broken",
        JSON.stringify({ hostDir: f.otherHost, runId: "run-selected" }),
        JSON.stringify({ hostDir: f.hostDir, runId: "run-newer" })
      ]
    ) {
      if (manifest === null) rmSync(join(f.reportDir, "scope.json"))
      else writeFileSync(join(f.reportDir, "scope.json"), manifest)
      const state = await d.snapshot()
      assert.equal(state.needsYou, null)
      assert.ok(state.monitor.every((m: { healthy: boolean | null }) => m.healthy !== true))
      assert.ok(state.timeline.every((r: { round: number }) => r.round !== 99))
      assert.notEqual(state.counts.open, 900)
    }
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("monitor current format requires fresh matching run evidence and never revives an earlier healthy line", async () => {
  const f = fixture()
  const d = await dashboard(f)
  try {
    const fresh = new Date(now).toISOString()
    const old = new Date(now - 120001).toISOString()
    f.monitor(`${new Date(now - 120000).toISOString()} run-selected HEALTHY boundary`)
    assert.equal((await d.snapshot()).monitor[0]?.healthy, true)
    for (
      const line of [
        `${old} run-selected HEALTHY stale`,
        `${new Date(now + 1).toISOString()} run-selected HEALTHY future`,
        `${fresh} run-newer HEALTHY foreign`,
        `${fresh} HEALTHY retired-format`,
        "garbage",
        `${fresh} run-selected UNHEALTHY inspection failed`
      ]
    ) {
      f.monitor(`${fresh} run-selected HEALTHY older\n${line}\n`)
      const state = await d.snapshot()
      assert.notEqual(state.monitor[0]?.healthy, true, line)
    }
    rmSync(join(f.reportDir, "monitor.log"))
    assert.ok((await d.snapshot()).monitor.every((m: { healthy: boolean | null }) => m.healthy !== true))
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("terminal, missing and corrupt engine evidence remains visible instead of selecting another run", async () => {
  const f = fixture()
  const d = await dashboard(f)
  try {
    const update = (status: string, id: string, result?: unknown) => {
      const store = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
      store.prepare("UPDATE flows_runs SET status=? WHERE run_id=?").run(status, id)
      if (result !== undefined) {
        store.prepare("UPDATE flows_runs SET state_json=? WHERE run_id=?")
          .run(JSON.stringify({ payload: { round: 1 }, result }), id)
      }
      store.close()
    }
    update("completed", "entry-selected")
    assert.equal((await d.snapshot()).run.status, "running", "entry completion is handoff to its live round")
    for (const status of ["cancelled", "failed"]) {
      update(status, "round-selected")
      assert.equal((await d.snapshot()).run.status, status)
      assert.equal((await d.snapshot()).monitor[0]?.healthy, false)
    }
    update("completed", "round-selected", { _tag: "Complete", exit: { _tag: "Success", value: {} } })
    assert.equal((await d.snapshot()).run.status, "completed")
    update("completed", "round-selected", { _tag: "Handoff" })
    assert.equal((await d.snapshot()).run.status, "unknown")
    const corrupt = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    corrupt.exec("UPDATE flows_runs SET state_json='{broken' WHERE run_id='entry-selected'")
    corrupt.close()
    assert.equal((await d.snapshot()).run.status, "unknown")
    assert.notEqual((await d.snapshot()).monitor[0]?.healthy, true)
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.exec("DELETE FROM flows_runs WHERE execution_parent_id='run-selected'")
    db.close()
    assert.equal((await d.snapshot()).run.status, "unknown")
    assert.notEqual((await d.snapshot()).monitor[0]?.healthy, true)
    writeFileSync(join(f.hostDir, ".flows/engine.db"), "not sqlite")
    assert.equal((await d.snapshot()).run.status, "unknown")
    rmSync(join(f.hostDir, ".flows/engine.db"))
    assert.equal((await d.snapshot()).run.status, "unknown")
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("port collision rejects rather than attaching to an unrelated existing dashboard", async () => {
  const f = fixture()
  const d = await dashboard(f)
  const blocker = createServer((_req, res) => res.end("foreign dashboard"))
  await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve))
  try {
    const address = blocker.address()
    assert.ok(address && typeof address !== "string")
    const { serveDashboard } = await dashboardModule()
    await assert.rejects(serveDashboard(d, address.port), { code: "EADDRINUSE" })
    assert.equal(await (await fetch(`http://127.0.0.1:${address.port}`)).text(), "foreign dashboard")
  } finally {
    await d.close()
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    f.cleanup()
  }
})

test("foreign same-lineage rounds cannot replace selected ancestry and missing worker execution is unknown", async () => {
  const f = fixture()
  const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  db.prepare("UPDATE flows_runs SET lineage_id='lineage-selected', round_ordinal=99 WHERE run_id='round-newer'").run()
  db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(JSON.stringify({
    payload: {
      round: 1,
      inFlight: [{
        assignment: { key: "missing-key", repo: "smithersai/smithers", lead: { n: 1 }, extras: [] },
        executionId: "missing-execution"
      }]
    }
  }))
  db.close()
  const d = await dashboard(f)
  try {
    const state = await d.snapshot()
    assert.equal(state.run.round, 1)
    assert.equal(state.counts.rounds, 1)
    assert.equal(state.workers.find((w: { key: string }) => w.key === "missing-key")?.status, "unknown")
    assert.equal(state.workers.find((w: { key: string }) => w.key === "selected-key")?.status, "running")
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("corrupt worker evidence cannot leave a healthy run inspection", async () => {
  const f = fixture()
  const d = await dashboard(f)
  try {
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.exec("UPDATE flows_runs SET state_json='{broken' WHERE run_id='worker-selected'")
    db.close()
    const state = await d.snapshot()
    assert.equal(state.run.status, "unknown")
    assert.equal(state.monitor[0]?.healthy, null)
    assert.ok(state.sources.engine.error !== null)
    assert.match(state.sources.engine.error, /Corrupt selected worker/)
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("scope and worker log symlinks cannot escape selected report directory", async () => {
  const f = fixture()
  const d = await dashboard(f)
  try {
    const external = join(f.directory, "external")
    mkdirSync(external)
    writeFileSync(join(external, "secret.log"), "foreign secret")
    mkdirSync(join(f.reportDir, "runs/selected-key"), { recursive: true })
    symlinkSync(join(external, "secret.log"), join(f.reportDir, "runs/selected-key/agent.log"))
    const { serveDashboard } = await dashboardModule()
    const url = await serveDashboard(d, 0)
    assert.notEqual(await (await fetch(`${url}/api/log?key=selected-key`)).text(), "foreign secret")
    writeFileSync(join(external, "scope.json"), JSON.stringify({ hostDir: f.hostDir, runId: "run-selected" }))
    rmSync(join(f.reportDir, "scope.json"))
    symlinkSync(join(external, "scope.json"), join(f.reportDir, "scope.json"))
    const state = await d.snapshot()
    assert.equal(state.monitor[0]?.healthy, null)
    assert.ok(state.sources.reports.error)
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("selected host database symlink cannot read another host and leaves its store unchanged", async () => {
  const f = fixture()
  const d = await dashboard(f)
  try {
    const foreignDatabase = join(f.otherHost, ".flows/engine.db")
    const originalHash = hash(foreignDatabase)
    rmSync(join(f.hostDir, ".flows/engine.db"))
    symlinkSync(foreignDatabase, join(f.hostDir, ".flows/engine.db"))
    const { serveDashboard } = await dashboardModule()
    const url = await serveDashboard(d, 0)
    const response = await fetch(`${url}/api/state`)
    assert.equal(response.status, 200)
    const state = await response.json()
    assert.equal(state.run.runId, "run-selected")
    assert.equal(state.run.status, "unknown")
    assert.equal(state.monitor[0]?.healthy, null)
    assert.deepEqual(state.workers, [])
    assert.match(state.sources.engine.error, /outside|escape|host/i)
    assert.equal(hash(foreignDatabase), originalHash)
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("missing selected round cannot use a newer foreign round as running evidence", async () => {
  const f = fixture()
  const d = await dashboard(f)
  try {
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.exec("DELETE FROM flows_runs WHERE run_id='round-selected'")
    db.close()
    const state = await d.snapshot()
    assert.equal(state.run.status, "unknown")
    assert.equal(state.run.round, null)
    assert.equal(state.monitor[0]?.healthy, null)
    assert.deepEqual(state.workers, [])
    assert.deepEqual(state.timeline, [])
    assert.ok(state.sources.engine.error !== null)
    assert.match(state.sources.engine.error, /Selected round missing/)
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("current round missing observation cannot reuse an earlier round's counts or capacity", async () => {
  const f = fixture()
  const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  db.prepare("INSERT INTO flows_runs VALUES(?,?,?,?,?,0,NULL,NULL,?,NULL,?)").run(
    "round-previous",
    "completed",
    "burndown/round",
    "entry-selected",
    "lineage-selected",
    now - 10000,
    JSON.stringify({ payload: { round: 0 }, result: { _tag: "Handoff" } })
  )
  db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
    "round-previous",
    "succeeded",
    JSON.stringify({ openIssues: 900, candidates: [{ n: 1 }], capacity: [{ account: "fixture-account", slots: 99 }] }),
    now - 9000
  )
  db.close()
  const { createDashboard } = await dashboardModule()
  const d = createDashboard({
    hostDir: f.hostDir,
    runId: "run-selected",
    reportDir: f.reportDir,
    now: () => now,
    loadAccounts: async () => [{
      account: {
        id: "fixture-account",
        tool: "codex",
        email: "fixture@example.test",
        directory: f.directory,
        aliases: []
      },
      usage: { windows: [], limitReached: false },
      error: null,
      observedAt: now
    }]
  })
  try {
    // The first snapshot can race the background account read; wait for its receipt.
    await d.snapshot()
    const state = await d.snapshot()
    assert.equal(state.run.round, 1)
    assert.equal(state.counts.open, null)
    assert.equal(state.counts.candidates, null)
    assert.equal(state.accounts[0]?.slotsSource, "local")
    assert.notEqual(state.accounts[0]?.slots, 99)
  } finally {
    await d.close()
    f.cleanup()
  }
})

async function renderResponse(d: Awaited<ReturnType<typeof dashboard>>, state: unknown) {
  const { serveDashboard } = await dashboardModule()
  const url = await serveDashboard(d, 0)
  const html = await (await fetch(url)).text()
  const elements = new Map<string, { innerHTML: string; textContent: string }>()
  const listeners = new Map<string, (event: unknown) => void>()
  const document = {
    getElementById(id: string) {
      if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "" })
      return elements.get(id)
    },
    querySelectorAll: () => [],
    addEventListener(name: string, listener: (event: unknown) => void) {
      listeners.set(name, listener)
    }
  }
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!.replace(/poll\(\);setInterval\(poll,5000\)/, "")
  runInNewContext(`${script}\nrender(state)`, { document, state, Date, fetch })
  return { html, elements, listeners }
}

test("hostile and non-string worker commit receipts cannot inject or break rendered merge queue", async () => {
  for (
    const commit of [
      "abcdefg\" onclick=\"attack()",
      { forged: true },
      17,
      "ABCDEF1",
      "abc123",
      "a".repeat(65),
      "abcdef1",
      "a".repeat(40)
    ]
  ) {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.prepare("UPDATE flows_runs SET status='completed', state_json=? WHERE run_id='worker-selected'").run(
      JSON.stringify({
        payload: { key: "selected-key", repo: "smithersai/smithers", lead: { n: 2948 }, extras: [] },
        result: { exit: { _tag: "Success", value: { status: "ready", commits: [{ issue: 2948, commit }] } } }
      })
    )
    db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
      "round-selected",
      "succeeded",
      JSON.stringify({ landed: ["selected-key"], quarantined: [] }),
      now
    )
    db.close()
    const d = await dashboard(f)
    try {
      const state = await d.snapshot()
      const valid = typeof commit === "string" && /^[0-9a-f]{7,64}$/.test(commit)
      assert.equal(state.landings[0]?.shas[0]?.sha, valid ? commit : null)
      const rendered = await renderResponse(d, state)
      assert.ok(!rendered.elements.get("queue")!.innerHTML.includes("attack"))
      assert.equal(rendered.elements.get("queue")!.innerHTML.includes("/commit/"), valid)
    } finally {
      await d.close()
      f.cleanup()
    }
  }
})

test("untrusted issue ids and assignment keys never become executable worker markup", async () => {
  const f = fixture()
  const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='worker-selected'").run(
    JSON.stringify({
      payload: {
        key: "selected-key",
        repo: "smithersai/smithers",
        lead: { n: "1\" onclick=\"attack()" },
        extras: [{ n: -1 }, { n: 1.5 }, { n: "42" }, { n: 42 }]
      }
    })
  )
  db.close()
  const d = await dashboard(f)
  try {
    const state = await d.snapshot()
    assert.equal(state.workers[0]?.lead, null)
    assert.deepEqual(state.workers[0]?.extras, [42])
    const rendered = await renderResponse(d, state)
    assert.ok(!rendered.elements.get("workers")!.innerHTML.includes("onclick="))
    assert.ok(!rendered.elements.get("workers")!.innerHTML.includes("attack"))
    assert.ok(rendered.elements.get("workers")!.innerHTML.includes("data-key=\"selected-key\""))
    assert.ok(rendered.listeners.has("click"))
    const corrupt = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    corrupt.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(
      JSON.stringify({ payload: { round: 1, inFlight: [{ assignment: { key: "x');attack();//" } }] } })
    )
    corrupt.close()
    assert.equal((await d.snapshot()).run.status, "unknown")
    assert.deepEqual((await d.snapshot()).workers, [])
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("entry-only cancellation overrides a live round and monitor healthy claim", async () => {
  const f = fixture()
  const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  db.exec("UPDATE flows_runs SET status='cancelled' WHERE run_id='entry-selected'")
  db.close()
  const d = await dashboard(f)
  try {
    const state = await d.snapshot()
    assert.equal(state.run.status, "cancelled")
    assert.equal(state.monitor[0]?.healthy, false)
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("malformed in-flight assignment reports unknown evidence through HTTP rather than a stack trace", async () => {
  const f = fixture()
  const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(
    JSON.stringify({ payload: { round: 1, inFlight: [{}] } })
  )
  db.close()
  const d = await dashboard(f)
  try {
    const { serveDashboard } = await dashboardModule()
    const url = await serveDashboard(d, 0)
    const response = await fetch(`${url}/api/state`)
    assert.equal(response.status, 200)
    const state = await response.json()
    assert.equal(state.run.status, "unknown")
    assert.match(state.sources.engine.error, /Corrupt selected round/)
    assert.equal(state.error, undefined)
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("dashboard refuses dot identities and foreign Host headers", async () => {
  const f = fixture()
  const { createDashboard, serveDashboard } = await dashboardModule()
  for (const runId of [".", ".."]) {
    assert.throws(() => createDashboard({ hostDir: f.hostDir, reportDir: f.reportDir, runId }), /Invalid selected run/)
  }
  const d = await dashboard(f)
  try {
    const url = await serveDashboard(d, 0)
    const responseStatus = (host: string) =>
      new Promise<number | undefined>((resolve, reject) => {
        const req = request(`${url}/api/state`, { headers: { host } }, (response) => {
          response.resume()
          response.once("end", () => resolve(response.statusCode))
        })
        req.once("error", reject)
        req.end()
      })
    for (const host of ["foreign.example", "127.0.0.1:1", "localhost:1"]) {
      assert.equal(await responseStatus(host), 403)
    }
    const port = new URL(url).port
    assert.equal(await responseStatus(`localhost:${port}`), 200)
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("live WAL snapshots observe committed selected state and release readers without logical writes", async () => {
  const f = fixture()
  const database = join(f.hostDir, ".flows/engine.db")
  const writer = new DatabaseSync(database)
  let d: Awaited<ReturnType<typeof dashboard>> | undefined
  try {
    writer.exec("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0")
    const checkpointedDatabase = hash(database)
    writer.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(
      JSON.stringify({ payload: { round: 7, inFlight: [] } })
    )
    writer.exec("UPDATE flows_runs SET status='failed' WHERE run_id='worker-selected'")
    assert.equal(hash(database), checkpointedDatabase, "selected update is committed only in WAL")
    assert.ok(readFileSync(`${database}-wal`).length > 32)
    const before = [hash(database), hash(`${database}-wal`)]
    const foreignBefore = hash(join(f.otherHost, ".flows/engine.db"))
    d = await dashboard(f)
    const { serveDashboard } = await dashboardModule()
    const url = await serveDashboard(d, 0)
    const response = await fetch(`${url}/api/state`)
    assert.equal(response.status, 200)
    const state = await response.json()
    assert.equal(state.sources.engine.error, null)
    assert.equal(state.run.round, 7, "HTTP reads current uncheckpointed selected state")
    assert.deepEqual(state.workers.map((worker: { key: string; status: string }) => [worker.key, worker.status]), [[
      "selected-key",
      "failed"
    ]])
    assert.deepEqual(
      [hash(database), hash(`${database}-wal`)],
      before,
      "reader leaves durable DB and existing WAL unchanged while writer is paused; SHM coordination is allowed"
    )
    assert.equal(hash(join(f.otherHost, ".flows/engine.db")), foreignBefore)
    // The reader connection releases its snapshot before the next writer commit.
    writer.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(
      JSON.stringify({ payload: { round: 8, inFlight: [] } })
    )
    writer.exec("UPDATE flows_runs SET status='completed' WHERE run_id='worker-selected'")
    const afterCommit = [hash(database), hash(`${database}-wal`)]
    const next = await d.snapshot()
    assert.equal(next.run.round, 8, "a later snapshot sees the subsequent writer commit")
    assert.deepEqual(next.workers.map((worker) => [worker.key, worker.status]), [["selected-key", "done"]])
    assert.deepEqual([hash(database), hash(`${database}-wal`)], afterCommit)
    const reader = new DatabaseSync(database, { readOnly: true })
    try {
      assert.throws(() => reader.exec("UPDATE flows_runs SET status='cancelled'"), /readonly|read.only/i)
    } finally {
      reader.close()
    }
    await d.close()
    d = undefined
    writer.exec("UPDATE flows_runs SET status='running' WHERE run_id='worker-selected'")
    assert.equal(
      writer.prepare("SELECT status FROM flows_runs WHERE run_id='worker-selected'").get()?.status,
      "running",
      "writer continues after dashboard and native reader close"
    )
  } finally {
    await d?.close()
    writer.close()
    f.cleanup()
  }
})

test("closed WAL-mode store reads committed state without durable database writes", async () => {
  const f = fixture()
  const database = join(f.hostDir, ".flows/engine.db")
  const writer = new DatabaseSync(database)
  writer.exec("PRAGMA journal_mode=WAL; UPDATE flows_runs SET status='cancelled' WHERE run_id='entry-selected'")
  writer.close()
  const before = hash(database)
  const d = await dashboard(f)
  try {
    const state = await d.snapshot()
    assert.equal(
      state.sources.engine.error,
      null,
      "writable isolated directory supports normal SQLite sidecar coordination"
    )
    assert.equal(state.run.status, "cancelled")
    assert.equal(state.monitor[0]?.healthy, false)
    assert.equal(hash(database), before)
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("unknown engine preserves fresh scoped monitor inspection failure evidence", async () => {
  const f = fixture()
  const d = await dashboard(f)
  try {
    rmSync(join(f.hostDir, ".flows/engine.db"))
    f.monitor(`${new Date(now).toISOString()} run-selected UNHEALTHY run inspection failed: database missing\n`)
    const state = await d.snapshot()
    assert.equal(state.run.status, "unknown")
    assert.equal(state.monitor[0]?.healthy, false)
    assert.equal(state.monitor[0]?.text, "run inspection failed: database missing")
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("hostile round and observation length cannot inject the rendered timeline", async () => {
  for (const hostile of ["round", "inFlight"] as const) {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    if (hostile === "round") {
      db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(
        JSON.stringify({ payload: { round: "<img src=x onerror=attack()>", inFlight: [] } })
      )
    } else {
      db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
        "round-selected",
        "succeeded",
        JSON.stringify({ capacity: [], inFlight: { length: "<img src=x onerror=attack()>" } }),
        now
      )
    }
    db.close()
    const d = await dashboard(f)
    try {
      const state = await d.snapshot()
      assert.equal(state.run.status, "unknown", hostile)
      assert.match(state.sources.engine.error ?? "", /Corrupt selected/)
      assert.deepEqual(state.timeline, [])
      const rendered = await renderResponse(d, state)
      assert.ok(!rendered.elements.get("timeline")!.innerHTML.includes("attack"))
      assert.ok(!rendered.elements.get("timeline")!.innerHTML.includes("<img"))
    } finally {
      await d.close()
      f.cleanup()
    }
  }
})

test("malformed selected outcomes and payload quarantine stay HTTP unknown without stack traces", async () => {
  const cases = [
    ...["finished", "capacity", "quarantined", "inFlight", "landed"].flatMap((field) =>
      [5, null, [null]].map((value) => ({ payload: false, field, value }))
    ),
    ...[5, null, [null]].map((value) => ({ payload: true, field: "quarantined", value }))
  ]
  for (const malformed of cases) {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    if (malformed.payload) {
      db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(
        JSON.stringify({ payload: { round: 1, inFlight: [], quarantined: malformed.value } })
      )
    } else {
      const outcome = malformed.field === "quarantined" || malformed.field === "landed"
        ? { landed: [], quarantined: [], [malformed.field]: malformed.value }
        : { capacity: [], [malformed.field]: malformed.value }
      db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
        "round-selected",
        "succeeded",
        JSON.stringify(outcome),
        now
      )
    }
    db.close()
    const d = await dashboard(f)
    try {
      const { serveDashboard } = await dashboardModule()
      const url = await serveDashboard(d, 0)
      const response = await fetch(`${url}/api/state`)
      const state = await response.json()
      assert.equal(response.status, 200, JSON.stringify(malformed))
      assert.equal(state.run.status, "unknown", JSON.stringify(malformed))
      assert.match(state.sources.engine.error ?? "", /Corrupt selected/)
      assert.equal(state.error, undefined)
      assert.deepEqual(state.timeline, [])
      assert.notEqual(state.monitor[0]?.healthy, true)
    } finally {
      await d.close()
      f.cleanup()
    }
  }
})

test("non-string worker repository and malformed run options cannot break panel rendering", async () => {
  for (const repos of [undefined, 5, [null, "smithersai/smithers"]]) {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(
      JSON.stringify({ payload: { round: 1, options: { repos }, inFlight: [] } })
    )
    db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='worker-selected'").run(
      JSON.stringify({ payload: { key: "selected-key", repo: { forged: true }, lead: { n: 2948 } } })
    )
    db.close()
    const d = await dashboard(f)
    try {
      const state = await d.snapshot()
      assert.equal(state.workers[0]?.repo, null)
      const rendered = await renderResponse(d, state)
      assert.ok(rendered.elements.get("workers")!.innerHTML.includes("selected-key"))
      assert.ok(!rendered.elements.get("workers")!.innerHTML.includes("[object Object]"))
      assert.ok(rendered.elements.get("timeline")!.innerHTML.includes("rounds"))
    } finally {
      await d.close()
      f.cleanup()
    }
  }
})

test("busy selected database reports unknown and recovers after the writer releases its lock", async () => {
  const f = fixture()
  const writer = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  const d = await dashboard(f)
  try {
    writer.exec("BEGIN EXCLUSIVE")
    const state = await d.snapshot()
    assert.equal(state.run.status, "unknown")
    assert.match(state.sources.engine.error ?? "", /busy|locked/i)
    assert.notEqual(state.monitor[0]?.healthy, true)
    writer.exec("ROLLBACK")
    const recovered = await d.snapshot()
    assert.equal(recovered.sources.engine.error, null)
    assert.equal(recovered.run.status, "running")
  } finally {
    writer.close()
    await d.close()
    f.cleanup()
  }
})

test("worker receipts cannot self-report native running or queue landed status", async () => {
  const f = fixture()
  const d = await dashboard(f)
  try {
    for (const status of ["landed", "running", "ready", "closed", "blocked", "limited", "failed"]) {
      const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
      db.prepare("UPDATE flows_runs SET status='completed', state_json=? WHERE run_id='worker-selected'").run(
        JSON.stringify({
          payload: { key: "selected-key", repo: "smithersai/smithers", lead: { n: 2948 } },
          result: { exit: { _tag: "Success", value: { status } } }
        })
      )
      db.close()
      const state = await d.snapshot()
      assert.equal(state.workers[0]?.status, ["landed", "running"].includes(status) ? "done" : status)
      assert.deepEqual(state.landings, [])
    }
  } finally {
    await d.close()
    f.cleanup()
  }
})

function accountReading() {
  return {
    account: {
      id: "fixture-account",
      tool: "claude" as const,
      email: "fixture@example.test",
      directory: "fixture",
      aliases: []
    },
    usage: {
      windows: [{ name: "five_hour" as const, used: 0, resetsAt: now + 3600000, durationHours: 5 }],
      limitReached: false
    },
    error: null,
    observedAt: now
  }
}

test("snapshot failures return completed HTTP error without stack and serve the next request", async () => {
  const f = fixture()
  const readings = [{ account: null }] as unknown as Array<Reading>
  const { createDashboard, serveDashboard } = await dashboardModule()
  const d = createDashboard({
    hostDir: f.hostDir,
    reportDir: f.reportDir,
    runId: "run-selected",
    now: () => now,
    loadAccounts: async () => readings
  })
  try {
    const url = await serveDashboard(d, 0)
    const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1000) })
    const body = await response.json()
    assert.equal(response.status, 500)
    assert.equal(typeof body.error, "string")
    assert.ok(!body.error.includes("\n"))
    assert.ok(!body.error.includes("dashboard.ts"))
    assert.ok(!body.error.includes(" at "))
    readings.splice(0)
    const next = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1000) })
    const recovered = await next.json()
    assert.equal(next.status, 200)
    assert.equal(recovered.run.status, "running")
  } finally {
    d.server.closeAllConnections()
    await d.close()
    f.cleanup()
  }
})

test("hostile selected pacing rates remain engine unknown with real account windows", async () => {
  for (
    const rates of [
      null,
      [],
      5,
      { "fixture-account": null },
      { "fixture-account": [] },
      { "fixture-account": { five_hour: null } },
      { "fixture-account": { five_hour: { pointsPerAgentHour: "2", source: "seed" } } },
      { "fixture-account": { five_hour: { pointsPerAgentHour: -1, source: "seed" } } },
      { "fixture-account": { five_hour: { pointsPerAgentHour: 2, source: "forged" } } }
    ]
  ) {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(
      JSON.stringify({ payload: { round: 1, rates, inFlight: [] } })
    )
    db.close()
    const { createDashboard, serveDashboard } = await dashboardModule()
    const d = createDashboard({
      hostDir: f.hostDir,
      reportDir: f.reportDir,
      runId: "run-selected",
      now: () => now,
      loadAccounts: async () => [accountReading()]
    })
    try {
      const url = await serveDashboard(d, 0)
      const response = await fetch(`${url}/api/state`, { signal: AbortSignal.timeout(1000) })
      const state = await response.json()
      assert.equal(response.status, 200)
      assert.equal(state.accounts.length, 1)
      assert.equal(state.run.status, "unknown", JSON.stringify(rates))
      assert.match(state.sources.engine.error ?? "", /Corrupt selected round/)
    } finally {
      d.server.closeAllConnections()
      await d.close()
      f.cleanup()
    }
  }
})

test("idle windows show no fabricated reset and account errors remain visibly unavailable", async () => {
  const f = fixture()
  const idle = accountReading()
  const readings: Array<Reading> = [{
    ...idle,
    usage: { windows: [{ ...idle.usage.windows[0]!, resetsAt: null }], limitReached: false }
  }]
  const { createDashboard } = await dashboardModule()
  const d = createDashboard({
    hostDir: f.hostDir,
    reportDir: f.reportDir,
    runId: "run-selected",
    now: () => now,
    loadAccounts: async () => readings
  })
  try {
    const state = await d.snapshot()
    const rendered = await renderResponse(d, state)
    const markup = rendered.elements.get("accounts")!.innerHTML
    assert.ok(markup.includes("0%"))
    assert.ok(!markup.includes("↻"))
    assert.ok(!markup.includes("-207"))
    readings.splice(0, 1, {
      ...idle,
      usage: null,
      error: { _tag: "UsageUnavailable", accountId: idle.account.id, message: "fixture failure" }
    })
    const failed = await d.snapshot()
    const html = rendered.html
    const elements = new Map<string, { innerHTML: string; textContent: string }>()
    const document = {
      getElementById(id: string) {
        if (!elements.has(id)) elements.set(id, { innerHTML: "", textContent: "" })
        return elements.get(id)
      },
      querySelectorAll: () => [],
      addEventListener: () => {}
    }
    const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!.replace(/poll\(\);setInterval\(poll,5000\)/, "")
    runInNewContext(`${script}\nrender(state)`, { document, state: failed, Date, fetch })
    const errorMarkup = elements.get("accounts")!.innerHTML
    assert.ok(errorMarkup.includes("UsageUnavailable"))
    assert.ok(errorMarkup.includes("hotrow"))
    assert.ok(!errorMarkup.includes("0%"))
    assert.ok(!errorMarkup.includes("↻"))
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("renderer escapes hostile timeline legend even when called with untrusted state directly", async () => {
  const f = fixture()
  const d = await dashboard(f)
  try {
    const state = await d.snapshot()
    const attack = "<img src=x onerror=attack()>"
    const rendered = await renderResponse(d, { ...state, timeline: [{ round: attack, inFlight: attack, landed: 0 }] })
    const markup = rendered.elements.get("timeline")!.innerHTML
    assert.ok(!markup.includes("<img"))
    assert.ok(markup.includes("&lt;img"))
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("historical quarantine cannot hide a repaired running worker or its account count", async () => {
  for (const current of [false, true]) {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
      "round-selected",
      "succeeded",
      JSON.stringify({ landed: [], quarantined: [{ key: "selected-key", error: "prior repair" }] }),
      now
    )
    db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(
      JSON.stringify({ payload: { round: 1, inFlight: [], quarantined: current ? [{ key: "selected-key" }] : [] } })
    )
    db.prepare("UPDATE flows_runs SET status=?, state_json=? WHERE run_id='worker-selected'").run(
      current ? "completed" : "running",
      JSON.stringify({ payload: { key: "selected-key", account: "fixture-account" } })
    )
    db.close()
    const { createDashboard } = await dashboardModule()
    const d = createDashboard({
      hostDir: f.hostDir,
      reportDir: f.reportDir,
      runId: "run-selected",
      now: () => now,
      loadAccounts: async () => [accountReading()]
    })
    try {
      const state = await d.snapshot()
      assert.equal(state.workers[0]?.status, current ? "quarantined" : "running")
      assert.equal(state.counts.inFlight, current ? 0 : 1)
      assert.equal(state.accounts[0]?.inFlight, current ? 0 : 1)
      assert.equal(state.quarantined[0]?.current, current)
      assert.equal(state.quarantined[0]?.error, "prior repair")
    } finally {
      await d.close()
      f.cleanup()
    }
  }
})

test("valid seed and measured selected rates reach local account capacity", async () => {
  for (const source of ["seed", "measured"]) {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(
      JSON.stringify({
        payload: {
          round: 1,
          rates: {
            "fixture-account": { five_hour: { pointsPerAgentHour: 2, source } }
          },
          inFlight: []
        }
      })
    )
    db.close()
    const { createDashboard } = await dashboardModule()
    const d = createDashboard({
      hostDir: f.hostDir,
      reportDir: f.reportDir,
      runId: "run-selected",
      now: () => now,
      loadAccounts: async () => [accountReading()]
    })
    try {
      const state = await d.snapshot()
      assert.equal(state.sources.engine.error, null)
      assert.equal(state.run.status, "running")
      assert.equal(state.accounts[0]?.slotsSource, "local")
      assert.equal(state.accounts[0]?.slots, 47)
    } finally {
      await d.close()
      f.cleanup()
    }
  }
})

test("earlier finished receipts cannot replace newer live or terminal execution status, notes or commits", async () => {
  for (const status of ["ready", "closed", "failed", "limited", "blocked"]) {
    for (const native of ["running", "suspended", "failed", "cancelled", "completed"]) {
      const f = fixture()
      const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
      db.prepare("INSERT INTO flows_runs VALUES(?,?,?,?,?,0,NULL,NULL,?,NULL,?)").run(
        "round-previous",
        "completed",
        "burndown/round",
        "entry-selected",
        "lineage-selected",
        now - 10000,
        JSON.stringify({ payload: { round: 0, inFlight: [] }, result: { _tag: "Handoff" } })
      )
      db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
        "round-previous",
        "succeeded",
        JSON.stringify({
          capacity: [],
          receiptAt: now,
          finished: [{
            key: "selected-key",
            receiptAt: now,
            status,
            notes: "stale notes",
            commits: [{ issue: 2948, commit: "abcdef1234567" }]
          }]
        }),
        now - 9000
      )
      db.prepare("UPDATE flows_runs SET status=?, state_json=? WHERE run_id='worker-selected'").run(
        native,
        JSON.stringify({
          payload: { key: "selected-key", account: "fixture-account", lead: { n: 2948 } },
          result: native === "failed" ?
            { exit: { _tag: "Failure", cause: [{ error: { message: "replacement failed" } }] } }
            : native === "completed"
            ? { exit: { _tag: "Success", value: {} } }
            : undefined
        })
      )
      db.close()
      const { createDashboard } = await dashboardModule()
      const d = createDashboard({
        hostDir: f.hostDir,
        reportDir: f.reportDir,
        runId: "run-selected",
        now: () => now,
        loadAccounts: async () => [accountReading()]
      })
      try {
        const state = await d.snapshot()
        const live = native === "running" || native === "suspended"
        assert.equal(
          state.workers[0]?.status,
          live ? "running" : native === "completed" ? "done" : native,
          `${status}/${native}`
        )
        assert.equal(state.workers[0]?.notes, live ? null : "")
        assert.deepEqual(state.workers[0]?.commits, [])
        assert.equal(state.counts.failed, native === "failed" ? 1 : 0)
        assert.equal(state.counts.inFlight, live ? 1 : 0)
        assert.equal(state.accounts[0]?.inFlight, live ? 1 : 0)
        assert.equal(state.accounts[0]?.slots, live ? 14 : 15)
      } finally {
        await d.close()
        f.cleanup()
      }
    }
  }
})

for (
  const outcome of [
    ...[null, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1].map((slots) => ({
      capacity: [{ account: "fixture-account", slots }]
    })),
    { quarantined: [{ key: "selected-key", error: "missing landing receipt" }] }
  ]
) {
  test(`invalid capacity or incomplete land receipt stays unknown: ${JSON.stringify(outcome)}`, async () => {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
      "round-selected",
      "succeeded",
      JSON.stringify(outcome),
      now
    )
    db.close()
    const d = await dashboard(f)
    try {
      const state = await d.snapshot()
      assert.equal(state.run.status, "unknown", JSON.stringify(outcome))
      assert.match(state.sources.engine.error ?? "", /Corrupt selected attempt/)
      assert.notEqual(state.monitor[0]?.healthy, true)
    } finally {
      await d.close()
      f.cleanup()
    }
  })
}

test("namespaced selected flows use guarded path suffixes for rounds and workers", async () => {
  const f = fixture()
  const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  db.exec(
    "UPDATE flows_runs SET execution_flow='cloud/burndown' WHERE run_id='entry-selected'; " +
      "UPDATE flows_runs SET execution_flow='cloud/burndown/round' WHERE run_id='round-selected'; " +
      "UPDATE flows_runs SET execution_flow='cloud/burndown/worker' WHERE run_id='worker-selected'"
  )
  db.prepare("INSERT INTO flows_runs VALUES(?,?,?,?,?,99,NULL,NULL,?,NULL,?)").run(
    "near-miss-round",
    "running",
    "notburndown/round",
    "entry-selected",
    "lineage-selected",
    now,
    JSON.stringify({ payload: { round: 99, inFlight: [] } })
  )
  db.prepare("INSERT INTO flows_runs VALUES(?,?,?,?,?,1,NULL,NULL,?,NULL,?)").run(
    "near-miss-worker",
    "running",
    "notburndown/worker",
    "round-selected",
    "worker-lineage",
    now,
    JSON.stringify({ payload: { key: "near-miss-key" } })
  )
  db.close()
  const d = await dashboard(f)
  try {
    const state = await d.snapshot()
    assert.equal(state.sources.engine.error, null)
    assert.equal(state.run.status, "running")
    assert.equal(state.run.round, 1)
    assert.equal(state.counts.rounds, 1)
    assert.deepEqual(state.workers.map((worker) => worker.key), ["selected-key"])
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("valid zero capacity remains authoritative flow capacity rather than local fallback", async () => {
  const f = fixture()
  const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
    "round-selected",
    "succeeded",
    JSON.stringify({ capacity: [{ account: "fixture-account", slots: 0 }] }),
    now
  )
  db.close()
  const { createDashboard } = await dashboardModule()
  const d = createDashboard({
    hostDir: f.hostDir,
    reportDir: f.reportDir,
    runId: "run-selected",
    now: () => now,
    loadAccounts: async () => [accountReading()]
  })
  try {
    const state = await d.snapshot()
    assert.equal(state.sources.engine.error, null)
    assert.equal(state.run.status, "running")
    assert.equal(state.accounts[0]?.slots, 0)
    assert.equal(state.accounts[0]?.slotsSource, "flow")
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("finished receipt association uses persisted time and keeps native failure or cancellation truthful", async () => {
  for (const receiptAt of [null, "future", now - 5001, now - 5000, now - 4000]) {
    for (const native of ["completed", "failed", "cancelled", "running", "suspended"]) {
      const f = fixture()
      const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
      db.prepare("UPDATE flows_runs SET status=? WHERE run_id='worker-selected'").run(native)
      db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
        "round-selected",
        "succeeded",
        JSON.stringify({
          capacity: [],
          receiptAt: now,
          finished: [{
            key: "selected-key",
            receiptAt: now,
            status: "ready",
            notes: "fresh notes",
            commits: [{ issue: 2948, commit: "abcdef1234567" }]
          }]
        }),
        receiptAt
      )
      db.close()
      const d = await dashboard(f)
      try {
        const state = await d.snapshot()
        const fresh = typeof receiptAt === "number" && receiptAt >= now - 5000 && native === "completed"
        const live = native === "running" || native === "suspended"
        assert.equal(
          state.workers[0]?.status,
          fresh ? "ready" : native === "completed" ? "done" : live ? "running" : native
        )
        assert.equal(state.workers[0]?.notes, fresh ? "fresh notes" : live ? null : "")
        assert.deepEqual(state.workers[0]?.commits, fresh ? [{ issue: 2948, commit: "abcdef1234567" }] : [])
        assert.equal(state.counts.failed, native === "failed" ? 1 : 0)
      } finally {
        await d.close()
        f.cleanup()
      }
    }
  }
})

test("uppercase flow suffixes cannot become selected round or worker evidence", async () => {
  const f = fixture()
  const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  db.prepare("INSERT INTO flows_runs VALUES(?,?,?,?,?,99,NULL,NULL,?,NULL,?)").run(
    "uppercase-round",
    "running",
    "cloud/BURNDOWN/ROUND",
    "entry-selected",
    "lineage-selected",
    now,
    JSON.stringify({ payload: { round: 99, inFlight: [] } })
  )
  db.prepare("INSERT INTO flows_runs VALUES(?,?,?,?,?,1,NULL,NULL,?,NULL,?)").run(
    "uppercase-worker",
    "running",
    "cloud/BURNDOWN/WORKER",
    "round-selected",
    "other-lineage",
    now,
    JSON.stringify({ payload: { key: "uppercase-key" } })
  )
  db.close()
  const d = await dashboard(f)
  try {
    const state = await d.snapshot()
    assert.equal(state.run.round, 1)
    assert.equal(state.counts.rounds, 1)
    assert.deepEqual(state.workers.map((worker) => worker.key), ["selected-key"])
  } finally {
    await d.close()
    f.cleanup()
  }
})

for (const ordinal of [1, null]) {
  test(`ambiguous selected round ordinal ${ordinal} stays unknown`, async () => {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.prepare("UPDATE flows_runs SET round_ordinal=? WHERE run_id='round-selected'").run(ordinal)
    db.prepare("INSERT INTO flows_runs VALUES(?,?,?,?,?, ?,NULL,NULL,?,NULL,?)").run(
      "tied-round",
      "running",
      "burndown/round",
      "entry-selected",
      "lineage-selected",
      ordinal,
      now,
      JSON.stringify({ payload: { round: 2, inFlight: [] } })
    )
    db.close()
    const d = await dashboard(f)
    try {
      const state = await d.snapshot()
      assert.equal(state.run.status, "unknown")
      assert.match(state.sources.engine.error ?? "", /ambiguous/i)
      assert.notEqual(state.monitor[0]?.healthy, true)
    } finally {
      await d.close()
      f.cleanup()
    }
  })
}

test("old landing cannot override a newer execution or attach its new commits to historical links", async () => {
  for (const native of ["running", "suspended", "failed", "cancelled", "completed"]) {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.prepare("INSERT INTO flows_runs VALUES(?,?,?,?,?,0,NULL,NULL,?,NULL,?)").run(
      "round-previous",
      "completed",
      "burndown/round",
      "entry-selected",
      "lineage-selected",
      now - 10000,
      JSON.stringify({ payload: { round: 0, inFlight: [] }, result: { _tag: "Handoff" } })
    )
    db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
      "round-previous",
      "succeeded",
      JSON.stringify({ landed: ["selected-key"], quarantined: [] }),
      now - 9000
    )
    db.prepare("UPDATE flows_runs SET status=?, state_json=? WHERE run_id='worker-selected'").run(
      native,
      JSON.stringify({
        payload: {
          key: "selected-key",
          repo: "smithersai/smithers",
          account: "fixture-account",
          lead: { n: 2948 },
          extras: []
        },
        result: native === "failed" ?
          { exit: { _tag: "Failure", cause: [{ error: { message: "replacement failure" } }] } }
          : native === "completed" ?
          {
            exit: {
              _tag: "Success",
              value: {
                status: "ready",
                notes: "replacement ready",
                commits: [{ issue: 2948, commit: "bbbbbbb1234567" }]
              }
            }
          } :
          undefined
      })
    )
    db.close()
    const { createDashboard } = await dashboardModule()
    const d = createDashboard({
      hostDir: f.hostDir,
      reportDir: f.reportDir,
      runId: "run-selected",
      now: () => now,
      loadAccounts: async () => [accountReading()]
    })
    try {
      const state = await d.snapshot()
      const live = native === "running" || native === "suspended"
      assert.equal(state.workers[0]?.status, live ? "running" : native === "completed" ? "ready" : native)
      assert.equal(state.workers[0]?.notes, live ? null : native === "completed" ? "replacement ready" : "")
      assert.equal(state.counts.failed, native === "failed" ? 1 : 0)
      assert.equal(state.counts.inFlight, live ? 1 : 0)
      assert.equal(state.accounts[0]?.inFlight, live ? 1 : 0)
      assert.equal(state.accounts[0]?.slots, live ? 14 : 15)
      assert.equal(state.counts.landedToday, 1, "historical landing count is retained")
      assert.deepEqual(state.landings[0]?.shas, [{ n: 2948, sha: null }])
      assert.deepEqual(
        state.workers[0]?.commits,
        native === "completed" ? [{ issue: 2948, commit: "bbbbbbb1234567" }] : []
      )
    } finally {
      await d.close()
      f.cleanup()
    }
  }
})

test("closed public status is retained from own success and fresh matching finished receipt", async () => {
  for (const source of ["own", "finished"]) {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.prepare("UPDATE flows_runs SET status='completed', state_json=? WHERE run_id='worker-selected'").run(
      JSON.stringify({
        payload: { key: "selected-key" },
        result: {
          exit: { _tag: "Success", value: source === "own" ? { status: "closed", notes: "issue settled" } : {} }
        }
      })
    )
    if (source === "finished") {
      db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
        "round-selected",
        "succeeded",
        JSON.stringify({ capacity: [], finished: [{ key: "selected-key", status: "closed", notes: "issue settled" }] }),
        now
      )
    }
    db.close()
    const d = await dashboard(f)
    try {
      const state = await d.snapshot()
      assert.equal(state.workers[0]?.status, "closed", source)
      assert.equal(state.workers[0]?.notes, "issue settled")
      assert.equal(state.counts.inFlight, 0)
      assert.equal(state.counts.failed, 0)
    } finally {
      await d.close()
      f.cleanup()
    }
  }
})

test("unknown persisted landing time cannot attach status or new commit identities", async () => {
  const f = fixture()
  const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
    "round-selected",
    "succeeded",
    JSON.stringify({ landed: ["selected-key"], quarantined: [] }),
    null
  )
  db.prepare("UPDATE flows_runs SET status='completed', state_json=? WHERE run_id='worker-selected'").run(
    JSON.stringify({
      payload: { key: "selected-key", repo: "smithersai/smithers", lead: { n: 2948 } },
      result: {
        exit: { _tag: "Success", value: { status: "ready", commits: [{ issue: 2948, commit: "bbbbbbb1234567" }] } }
      }
    })
  )
  db.close()
  const d = await dashboard(f)
  try {
    const state = await d.snapshot()
    assert.equal(state.workers[0]?.status, "ready")
    assert.equal(state.landings[0]?.at, null)
    assert.deepEqual(state.landings[0]?.shas, [{ n: 2948, sha: null }])
    assert.equal(state.counts.landedToday, 0)
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("native worker Assignment codec payload is observed through the selected HTTP boundary", async () => {
  const workerSource = readFileSync(new URL("../worker/flow.ts", import.meta.url), "utf8")
  assert.match(workerSource, /payload: Assignment,/, "worker Flow.make publishes the Assignment payload contract")
  const assignment = {
    key: "selected-key",
    repo: "smithersai/smithers",
    lead: { repo: "smithersai/smithers", n: 2948, title: "Native worker" },
    extras: [],
    account: "fixture-account",
    tool: "codex" as const,
    model: "gpt-6.1-sol",
    attempt: 1,
    placement: "local" as const
  }
  // RunDriver encodes this public schema directly into persisted state.payload.
  const payload = Schema.encodeSync(Schema.toCodecJson(Assignment))(assignment)
  assert.deepEqual(payload, assignment)
  const f = fixture()
  const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='worker-selected'").run(JSON.stringify({ payload }))
  db.close()
  const d = await dashboard(f)
  try {
    const { serveDashboard } = await dashboardModule()
    const url = await serveDashboard(d, 0)
    const response = await fetch(`${url}/api/state`)
    const state = await response.json()
    assert.equal(response.status, 200)
    assert.equal(state.sources.engine.error, null)
    assert.equal(state.run.status, "running")
    assert.equal(state.workers[0]?.key, assignment.key)
    assert.equal(state.workers[0]?.repo, assignment.repo)
    assert.equal(state.workers[0]?.lead, assignment.lead.n)
    assert.equal(state.workers[0]?.account, assignment.account)
    assert.equal(state.workers[0]?.model, assignment.model)
    assert.equal(state.workers[0]?.placement, assignment.placement)
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("wrapped worker input is refused rather than retained as a second payload contract", async () => {
  const f = fixture()
  const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
  db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='worker-selected'").run(
    JSON.stringify({ payload: { input: { key: "selected-key" } } })
  )
  db.close()
  const d = await dashboard(f)
  try {
    const state = await d.snapshot()
    assert.equal(state.run.status, "unknown")
    assert.match(state.sources.engine.error ?? "", /Corrupt selected worker/)
    assert.deepEqual(state.workers, [])
    assert.notEqual(state.monitor[0]?.healthy, true)
  } finally {
    await d.close()
    f.cleanup()
  }
})

test("retained round quarantine cannot mask a repair launched after that round began", async () => {
  for (const native of ["running", "suspended", "completed", "failed", "cancelled"]) {
    const f = fixture()
    const db = new DatabaseSync(join(f.hostDir, ".flows/engine.db"))
    db.prepare("UPDATE flows_runs SET state_json=? WHERE run_id='round-selected'").run(
      JSON.stringify({ payload: { round: 1, inFlight: [], quarantined: [{ key: "selected-key" }] } })
    )
    db.prepare("INSERT INTO flows_attempts VALUES(?,?,?,?)").run(
      "round-selected",
      "succeeded",
      JSON.stringify({ landed: [], quarantined: [{ key: "selected-key", error: "retained earlier failure" }] }),
      now - 6000
    )
    db.prepare("UPDATE flows_runs SET status=?, created_at_ms=?, state_json=? WHERE run_id='worker-selected'").run(
      native,
      now - 4000,
      JSON.stringify({ payload: { key: "selected-key", account: "fixture-account" } })
    )
    db.close()
    const { createDashboard } = await dashboardModule()
    const d = createDashboard({
      hostDir: f.hostDir,
      reportDir: f.reportDir,
      runId: "run-selected",
      now: () => now,
      loadAccounts: async () => [accountReading()]
    })
    try {
      const state = await d.snapshot()
      const live = native === "running" || native === "suspended"
      assert.equal(state.workers[0]?.status, live ? "running" : native === "completed" ? "done" : native)
      assert.equal(state.counts.inFlight, live ? 1 : 0)
      assert.equal(state.accounts[0]?.inFlight, live ? 1 : 0)
      assert.equal(state.counts.quarantined, 0)
      assert.equal(state.quarantined[0]?.current, false)
      assert.equal(state.quarantined[0]?.error, "retained earlier failure")
    } finally {
      await d.close()
      f.cleanup()
    }
  }
})
