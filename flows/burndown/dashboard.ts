import { execFile } from "node:child_process"
import { closeSync, existsSync, openSync, readFileSync, readSync, realpathSync } from "node:fs"
import { open as openFile } from "node:fs/promises"
import { createServer } from "node:http"
import { isAbsolute, join, relative, resolve } from "node:path"
import { DatabaseSync } from "node:sqlite"
import { pathToFileURL } from "node:url"
import { discoverAccounts, readAccounts, type Reading } from "./accounts.ts"
import { slots as paceSlots } from "./pacing.ts"

export interface DashboardOptions {
  hostDir: string
  runId: string
  reportDir: string
  now?: () => number
  loadAccounts?: () => Promise<Array<Reading>>
}

type Json = any

const validKey = (value: unknown): value is string =>
  typeof value === "string" && /^[\w.-]+$/.test(value) && value !== "." && value !== ".."
const issueNumber = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null
const commitSha = (value: unknown): string | null =>
  typeof value === "string" && /^[0-9a-f]{7,64}$/.test(value) ? value : null

/** Observe exactly one watched execution; importing this module starts nothing. */
export function createDashboard(options: DashboardOptions) {
  if (!validKey(options.runId)) throw new Error("Invalid selected run")
  const hostDir = realpathSync(options.hostDir)
  const runId = options.runId
  const opsDir = resolve(options.reportDir)
  const engineDb = join(hostDir, ".flows/engine.db")
  const clock = options.now ?? Date.now
  const timers: Array<ReturnType<typeof setInterval>> = []
  const contained = (root: string, path: string) => {
    const rel = relative(realpathSync(root), realpathSync(path))
    return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)
  }
  const reportsValid = () => {
    try {
      if (!contained(opsDir, join(opsDir, "scope.json"))) return false
      const scope = JSON.parse(readFileSync(join(opsDir, "scope.json"), "utf8"))
      return scope.runId === runId && realpathSync(scope.hostDir) === hostDir
    } catch {
      return false
    }
  }
  const reportText = (path: string) => {
    try {
      return reportsValid() && contained(opsDir, path) ? readText(path) : null
    } catch {
      return null
    }
  }

  const parse = (text: string | null | undefined): Json => {
    try {
      return text ? JSON.parse(text) : null
    } catch {
      return null
    }
  }
  const readText = (path: string): string | null => {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  }
  /** A value refreshed in the background; readers never wait on it. */
  function cached<T>(everyMs: number, load: () => Promise<T>) {
    const box: { value: T | null; error: string | null; at: number } = { value: null, error: null, at: 0 }
    let busy = false
    const tick = async () => {
      if (busy) return
      busy = true
      try {
        box.value = await load()
        box.error = null
      } catch (error) {
        box.value = null
        box.error = String((error as Error).message ?? error).slice(0, 300)
      } finally {
        box.at = Date.now()
        busy = false
      }
    }
    timers.push(setInterval(tick, everyMs).unref())
    void tick()
    return box
  }

  // --- background sources ---------------------------------------------------

  const accounts = options.loadAccounts === undefined
    ? cached(600_000, async () => {
      const { accounts: found } = await discoverAccounts()
      return readAccounts(found)
    })
    : cached(600_000, options.loadAccounts)

  // --- engine.db ------------------------------------------------------------

  const failureCause = (result: Json): string | null => {
    const cause = result?.exit?._tag === "Failure" ? result.exit.cause : null
    if (!Array.isArray(cause)) return null
    const first = cause[0]?.error ?? cause[0]?.defect ?? cause[0]
    return String(first?.message ?? first?._tag ?? JSON.stringify(first)).slice(0, 500)
  }

  function readEngine() {
    if (!existsSync(engineDb)) return null
    if (!contained(hostDir, engineDb)) throw new Error("Selected host database escapes host")
    // SQLite coordinates WAL readers through SHM/read locks; logical data stays read-only.
    const header = Buffer.alloc(20)
    const fd = openSync(engineDb, "r")
    try {
      if (readSync(fd, header, 0, 20, 0) !== 20 || header.subarray(0, 16).toString() !== "SQLite format 3\0") {
        throw new Error("Invalid selected database header")
      }
    } finally {
      closeSync(fd)
    }
    if (![1, 2].includes(header[18]!) || ![1, 2].includes(header[19]!)) {
      throw new Error("Invalid selected database header")
    }
    const db = new DatabaseSync(engineDb, { readOnly: true })
    try {
      // One current committed snapshot for all selected lineage queries; close releases it.
      db.exec("BEGIN")
      const entries = db.prepare(`select * from flows_runs where execution_parent_id = ? and
      (execution_flow = 'burndown' or execution_flow glob '*/burndown')`).all(runId) as Array<Json>
      if (entries.length !== 1) throw new Error("Selected run entry missing or ambiguous")
      const entry = entries[0]!
      if (parse(entry.state_json) === null) throw new Error("Corrupt selected entry state")
      const rounds: Array<Json> = db.prepare(`with recursive owned(run_id) as (
        select run_id from flows_runs where run_id = ?
        union select r.run_id from flows_runs r join owned o on r.execution_parent_id = o.run_id
      ) select run_id, status, round_ordinal,
        waiting_reason, waiting_wake_at_ms, created_at_ms, finished_at_ms, state_json from flows_runs
        where lineage_id = ? and run_id in (select run_id from owned) and (execution_flow = 'burndown/round' or execution_flow glob '*/burndown/round') order by round_ordinal, created_at_ms`)
        .all(
          entry.run_id,
          entry.lineage_id ?? entry.run_id
        ) as Array<
          Json
        >
      if (rounds.length === 0) throw new Error("Selected round missing")
      const attempts = db.prepare(`select outcome_json, finished_at_ms from flows_attempts where run_id = ?
        and state = 'succeeded' and outcome_json is not null and (json_type(outcome_json, '$.capacity') is not null
        or json_type(outcome_json, '$.quarantined') is not null) order by finished_at_ms`)
      const record = (value: Json) => value !== null && typeof value === "object" && !Array.isArray(value)
      const arrayField = (value: Json, field: string, itemValid: (item: Json) => boolean = record) =>
        value[field] === undefined || (Array.isArray(value[field]) && value[field].every(itemValid))
      const keyed = (item: Json) => record(item) && validKey(item.key)
      const assignment = (item: Json) => record(item) && validKey(item.assignment?.key)
      const validRates = (rates: Json) =>
        record(rates) &&
        Object.values(rates).every((windows: Json) =>
          record(windows) && Object.values(windows).every((rate: Json) =>
            record(rate) && Number.isFinite(rate.pointsPerAgentHour) && rate.pointsPerAgentHour > 0 &&
            ["seed", "measured"].includes(rate.source)
          )
        )
      const ordinals = new Set<unknown>()
      const parsedRounds = rounds.map((row) => {
        if (ordinals.has(row.round_ordinal)) throw new Error("Selected round ordinal ambiguous")
        ordinals.add(row.round_ordinal)
        const state = parse(row.state_json)
        if (
          !record(state) || !record(state.payload) ||
          !Number.isSafeInteger(state.payload.round) || state.payload.round < 0 ||
          !arrayField(state.payload, "inFlight", assignment) ||
          !arrayField(state.payload, "quarantined", keyed) ||
          (state.payload.rates !== undefined && !validRates(state.payload.rates))
        ) {
          throw new Error("Corrupt selected round state")
        }
        let observation: Json = null
        let land: Json = null
        for (const a of attempts.all(row.run_id) as Array<Json>) {
          const out = parse(a.outcome_json)
          if (
            !record(out) || !arrayField(out, "finished", keyed) ||
            !arrayField(
              out,
              "capacity",
              (item) =>
                record(item) && typeof item.account === "string" && Number.isSafeInteger(item.slots) && item.slots >= 0
            ) ||
            !arrayField(out, "inFlight", assignment) || !arrayField(out, "quarantined", keyed) ||
            !arrayField(out, "landed", validKey) || !arrayField(out, "candidates") ||
            (out.capacity === undefined && !Array.isArray(out.landed))
          ) throw new Error("Corrupt selected attempt outcome")
          if (out?.capacity !== undefined) observation = { ...out, receiptAt: a.finished_at_ms }
          else if (Array.isArray(out?.landed)) land = { ...out, at: a.finished_at_ms }
        }
        return {
          id: row.run_id,
          status: row.status,
          ordinal: row.round_ordinal,
          waiting: row.waiting_reason,
          wakeAt: row.waiting_wake_at_ms,
          createdAt: row.created_at_ms,
          finishedAt: row.finished_at_ms,
          payload: state?.payload ?? null,
          cause: failureCause(state?.result),
          result: state.result,
          observation,
          land
        }
      })
      const workers = db.prepare(`with recursive owned(run_id) as (
      select run_id from flows_runs where run_id = ?
      union select r.run_id from flows_runs r join owned o on r.execution_parent_id = o.run_id
    ) select r.run_id, r.status, r.created_at_ms, r.finished_at_ms, r.state_json
      from flows_runs r join owned o on r.run_id = o.run_id
      where (r.execution_flow = 'burndown/worker' or r.execution_flow glob '*/burndown/worker') order by r.created_at_ms desc`)
        .all(entry.run_id) as Array<Json>
      return {
        entry: {
          id: entry.run_id,
          status: entry.status,
          runId: entry.execution_parent_id,
          createdAt: entry.created_at_ms,
          cause: failureCause(parse(entry.state_json)?.result)
        },
        rounds: parsedRounds,
        workers: workers.map((w) => {
          const state = parse(w.state_json)
          if (state === null || !validKey(state.payload?.key)) {
            throw new Error("Corrupt selected worker state")
          }
          return {
            id: w.run_id,
            status: w.status,
            createdAt: w.created_at_ms,
            finishedAt: w.finished_at_ms,
            input: state?.payload ?? null,
            result: state?.result ?? null
          }
        })
      }
    } finally {
      db.close()
    }
  }

  // --- snapshot -------------------------------------------------------------

  const logPath = (key: string) => join(opsDir, "runs", key, "agent.log")
  async function tail(path: string, bytes: number): Promise<string> {
    try {
      if (!reportsValid() || !contained(opsDir, path)) return ""
      const handle = await openFile(path, "r")
      try {
        const { size } = await handle.stat()
        const start = Math.max(0, size - bytes)
        const buffer = Buffer.alloc(size - start)
        await handle.read(buffer, 0, buffer.length, start)
        return buffer.toString("utf8")
      } finally {
        await handle.close()
      }
    } catch {
      return ""
    }
  }
  const lastLines = (text: string, n: number) => text.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n)

  async function snapshot() {
    const now = clock()
    const startOfDay = new Date(now).setHours(0, 0, 0, 0)
    let engine: ReturnType<typeof readEngine> = null
    let engineError: string | null = null
    try {
      engine = readEngine()
      if (engine === null) engineError = "Selected host database missing"
    } catch (error) {
      engineError = String((error as Error).message ?? error)
    }
    const rounds = engine?.rounds ?? []
    const latest = rounds.at(-1) ?? null
    const observed = latest?.observation ?? null

    // Assignments seen anywhere: round payloads carry every in-flight worker.
    const assignments = new Map<string, Json>()
    for (const r of rounds) {
      for (const item of r.payload?.inFlight ?? []) {
        assignments.set(item.assignment.key, {
          ...item.assignment,
          executionId: item.executionId,
          startedAt: item.startedAt
        })
      }
    }
    const finished = new Map<string, Json>()
    for (const r of rounds) {
      for (const f of r.observation?.finished ?? []) finished.set(f.key, { ...f, receiptAt: r.observation.receiptAt })
    }
    const landedKeys = new Map<string, number | null>()
    const quarantined = new Map<string, Json>()
    for (const r of rounds) {
      for (const key of r.land?.landed ?? []) {
        landedKeys.set(key, Number.isFinite(r.land.at) ? r.land.at : null)
      }
      for (const q of r.land?.quarantined ?? []) quarantined.set(q.key, { ...q, at: r.land.at })
    }
    const queued = new Set<string>((latest?.payload?.quarantined ?? []).map((q: Json) => q.key))
    const queuedAt = latest?.createdAt

    const rows = new Map<string, Json>()
    for (const w of engine?.workers ?? []) {
      const key = w.input?.key
      if (typeof key !== "string" || rows.has(key)) continue
      rows.set(key, {
        ...assignments.get(key),
        ...w.input,
        execution: w.id,
        execStatus: w.status,
        startedAt: w.createdAt,
        finishedAt: w.finishedAt,
        result: w.result
      })
    }
    for (const [key, a] of assignments) if (!rows.has(key)) rows.set(key, { ...a, execStatus: null })
    const current = new Set([...queued].filter((key) => {
      const worker = rows.get(key)
      return worker === undefined || (!["running", "suspended"].includes(worker.execStatus) &&
        Number.isFinite(queuedAt) && Number.isFinite(worker.startedAt) && queuedAt >= worker.startedAt)
    }))
    const landMatchesExecution = (worker: Json, at: Json) =>
      worker?.execStatus === "completed" && worker.result?.exit?._tag !== "Failure" &&
      Number.isFinite(at) && Number.isFinite(worker.startedAt) && at >= worker.startedAt
    const workers = await Promise.all([...rows.values()].map(async (w) => {
      const value = w.result?.exit?._tag === "Success" ? w.result.exit.value : null
      const candidate = finished.get(w.key)
      const done = !["running", "suspended", "failed", "cancelled"].includes(w.execStatus) &&
          w.result?.exit?._tag !== "Failure" && Number.isFinite(candidate?.receiptAt) &&
          Number.isFinite(w.startedAt) && candidate.receiptAt >= w.startedAt
        ? candidate
        : null
      const reportedStatus = value?.status ?? done?.status
      const receiptStatus = ["ready", "closed", "blocked", "limited", "failed"].includes(reportedStatus)
        ? reportedStatus
        : null
      let status: string = receiptStatus ??
        (w.result?.exit?._tag === "Failure" ? "failed" : w.execStatus === "failed" ?
          "failed" :
          w.execStatus === "cancelled"
          ? "cancelled"
          : w.execStatus === "completed"
          ? "done"
          : w.execStatus === "running" || w.execStatus === "suspended"
          ? "running"
          : "unknown")
      if (landMatchesExecution(w, landedKeys.get(w.key))) status = "landed"
      else if (current.has(w.key)) status = "quarantined"
      const log = await tail(logPath(w.key), 16_384)
      const candidateCommits = value?.commits ?? done?.commits
      return {
        key: w.key,
        repo: typeof w.repo === "string" ? w.repo : null,
        lead: issueNumber(w.lead?.n),
        title: w.lead?.title ?? "",
        extras: (Array.isArray(w.extras) ? w.extras : []).map((e: Json) => issueNumber(e?.n))
          .filter((n: number | null): n is number => n !== null),
        account: w.account,
        model: w.model,
        tool: w.tool,
        placement: w.placement,
        fix: w.fix !== undefined,
        status,
        startedAt: w.startedAt ?? null,
        finishedAt: w.finishedAt ?? null,
        cause: w.result?.exit?._tag === "Failure" ? failureCause(w.result) : null,
        notes: status === "running" ? null : String(value?.notes ?? done?.notes ?? "").slice(-600),
        commits: (Array.isArray(candidateCommits) ? candidateCommits : [])
          .map((commit: Json) => ({ issue: issueNumber(commit?.issue), commit: commitSha(commit?.commit) })),
        tail: lastLines(log, 3)
      }
    }))
    workers.sort((a, b) =>
      Number(b.status === "running") - Number(a.status === "running") ||
      (b.startedAt ?? 0) - (a.startedAt ?? 0)
    )

    // Land reports own keys; only selected worker receipts supply commit identities.
    const landings = [...landedKeys].map(([key, at]) => {
      const w = workers.find((x) => x.key === key) ?? assignments.get(key)
      const issues = [w?.lead, ...(w?.extras ?? [])].map((x: Json) => typeof x === "object" ? x?.n : x)
        .map(issueNumber).filter((n): n is number => n !== null)
      const shas = issues.map((n) => ({
        n,
        sha: landMatchesExecution(rows.get(key), at)
          ? commitSha((Array.isArray(w?.commits) ? w.commits : []).find((c: Json) => c?.issue === n)?.commit)
          : null
      }))
      return { key, repo: w?.repo ?? null, at, shas }
    }).sort((a, b) => (b.at ?? 0) - (a.at ?? 0))
    const scripts: Array<Json> = []

    // Accounts: live usage, the flow's slot ceiling, live in-flight counts.
    const running = workers.filter((w) => w.status === "running")
    const readings: Array<Reading> = accounts.value ?? []
    const capacity = new Map<string, Json>((observed?.capacity ?? []).map((c: Json) => [c.account, c]))
    const accountRows = readings.map((r) => {
      const ids = [r.account.id, ...r.account.aliases]
      const inFlight = running.filter((w) => ids.includes(w.account)).length
      const rates = latest?.payload?.rates?.[r.account.id]
      return {
        id: r.account.id,
        aliases: r.account.aliases,
        tool: r.account.tool,
        email: r.account.email,
        windows: (r.usage?.windows ?? []).map((w) => ({ name: w.name, used: w.used, resetsAt: w.resetsAt })),
        slots: capacity.get(r.account.id)?.slots ?? paceSlots(r, now, rates, inFlight),
        slotsSource: capacity.has(r.account.id) ? "flow" : "local",
        inFlight,
        problem: r.error === null ? (r.usage?.limitReached ? "limit reached" : null) : r.error._tag
      }
    })

    // Timeline: selected execution rounds.
    const series = new Map<number, Json>()
    for (const r of rounds) {
      const round = r.payload?.round ?? r.ordinal
      series.set(round, {
        round,
        at: r.createdAt,
        inFlight: r.observation?.inFlight?.length ?? 0,
        landed: r.land?.landed?.length ?? 0
      })
    }
    const timeline = [...series.values()].sort((a, b) => a.round - b.round).slice(-120)

    // A completed entry can be a handoff. Only the current round's Complete proves success.
    const failed = latest?.status === "failed" || engine?.entry?.status === "failed"
    const cancelled = latest?.status === "cancelled" || engine?.entry?.status === "cancelled"
    const parked = latest !== null && (latest.status === "suspended" || latest.waiting != null)
    const status = latest?.status ?? engine?.entry?.status
    const complete = latest?.result?._tag === "Complete" && latest.result.exit?._tag === "Success"
    const runStatus = engineError !== null ? "unknown" : failed ?
      "failed"
      : cancelled ?
      "cancelled" :
      status === "completed" ?
      complete ? "completed" : "unknown"
      : parked
      ? "parked"
      : status === "running"
      ? "running"
      : "unknown"
    const cause = failed ? latest?.cause ?? engine?.entry?.cause ?? "failed" : engineError
    const monitor = lastLines(reportText(join(opsDir, "monitor.log")) ?? "", 20).reverse().map((line) => {
      const m = /^(\S+) (\S+) (HEALTHY|UNHEALTHY) ?(.*)$/.exec(line)
      const at = m === null ? NaN : Date.parse(m[1]!)
      const valid = m !== null && m[2] === runId && Number.isFinite(at) && at <= now &&
        now - at <= 120_000
      return {
        at: Number.isFinite(at) ? at : null,
        healthy: !valid ? null : m[3] === "UNHEALTHY" ? false : runStatus === "unknown" ?
          null :
          !["failed", "cancelled"].includes(runStatus),
        text: valid ? m[4] : "unknown"
      }
    })
    if (monitor.length === 0) monitor.push({ at: null, healthy: null, text: "unknown" })

    return {
      now,
      run: {
        runId: runId,
        status: runStatus,
        cause,
        round: latest?.payload?.round ?? null,
        wakeAt: parked ? latest?.wakeAt ?? null : null,
        waiting: latest?.waiting ?? null,
        options: latest?.payload?.options ?? null
      },
      counts: {
        open: observed?.openIssues ?? null,
        inFlight: running.length,
        landedToday: [...landedKeys.values()].filter((at) => at !== null && at >= startOfDay).length,
        landedTotal: latest?.payload?.landed ?? landedKeys.size,
        quarantined: current.size,
        failed: workers.filter((w) => w.status === "failed").length,
        rounds: rounds.length,
        candidates: observed?.candidates?.length ?? null
      },
      needsYou: null,
      accounts: accountRows,
      workers,
      landings,
      scripts: scripts.sort((a, b) => b.at - a.at).slice(0, 20),
      quarantined: [...quarantined.values()].map((q) => ({
        key: q.key,
        at: q.at,
        current: current.has(q.key),
        error: String(q.error ?? "").slice(-800)
      })).reverse(),
      monitor,
      timeline,
      sources: {
        reports: { error: reportsValid() ? null : "Selected report scope missing or foreign" },
        accounts: { at: accounts.at, error: accounts.error },
        engine: { error: engineError }
      }
    }
  }

  // --- server ---------------------------------------------------------------

  const server = createServer(async (req, res) => {
    const address = server.address()
    const port = address !== null && typeof address !== "string" ? address.port : null
    if (port === null || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host ?? "")) {
      res.writeHead(403).end("Invalid dashboard host")
      return
    }
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1")
      if (url.pathname === "/api/state") {
        const body = JSON.stringify(await snapshot())
        res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" })
        res.end(body)
      } else if (url.pathname === "/api/log") {
        const key = url.searchParams.get("key") ?? ""
        if (!validKey(key)) {
          res.writeHead(400).end("bad key")
          return
        }
        const state = await snapshot()
        if (!state.workers.some((worker) => worker.key === key)) {
          res.writeHead(404).end("Unknown selected worker")
          return
        }
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" })
        res.end((await tail(logPath(key), 65_536)) || "(no agent.log)")
      } else if (url.pathname === "/") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
        res.end(page)
      } else res.writeHead(404).end("not found")
    } catch (error) {
      res.writeHead(500, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: String((error as Error).message ?? error) }))
    }
  })

  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Burndown</title>
<style>
:root{--bg:#fff;--fg:#16181d;--mute:#6b7280;--line:#e5e7eb;--card:#f8f9fb;--bar:#d9dde3;--ok:#1f7a4d;--warn:#b45309;--bad:#c81e1e;--acc:#2563eb;--badbg:#fdecec}
@media (prefers-color-scheme:dark){:root{--bg:#0e1014;--fg:#e6e8ec;--mute:#8b93a1;--line:#252a33;--card:#151920;--bar:#2a303a;--ok:#3fb67a;--warn:#e0a13a;--bad:#f05252;--acc:#6ea0ff;--badbg:#3a1414}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:13px/1.4 system-ui,-apple-system,sans-serif}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
main{padding:12px 16px;max-width:1600px;margin:0 auto}
header{display:flex;gap:12px;align-items:baseline;flex-wrap:wrap}h1{font-size:15px;margin:0}
.mute{color:var(--mute)}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}
.pill{padding:1px 8px;border-radius:9px;font-weight:600;font-size:12px;border:1px solid currentColor}
.s-running,.s-ready,.s-landed,.s-closed,.s-done{color:var(--ok)}.s-parked,.s-blocked,.s-limited,.s-quarantined{color:var(--warn)}
.s-failed,.s-cancelled{color:var(--bad)}.s-completed{color:var(--mute)}
.banner{background:var(--badbg);color:var(--bad);border:2px solid var(--bad);border-radius:6px;padding:8px 12px;margin:10px 0;font-weight:600}
.banner pre{font-weight:400;margin:6px 0 0;white-space:pre-wrap;color:var(--fg)}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;margin:10px 0}
.kpi{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
.kpi b{display:block;font-size:22px;font-variant-numeric:tabular-nums}.kpi span{color:var(--mute);font-size:11px;text-transform:uppercase;letter-spacing:.04em}
.grid{display:grid;grid-template-columns:minmax(0,5fr) minmax(0,7fr);gap:12px}.grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px;margin-top:12px}
@media (max-width:1000px){.grid,.grid3{grid-template-columns:minmax(0,1fr)}}
section{background:var(--card);border:1px solid var(--line);border-radius:6px;padding:8px 10px;min-width:0;overflow-x:auto}
h2{font-size:11px;text-transform:uppercase;letter-spacing:.06em;color:var(--mute);margin:0 0 6px}
table{width:100%;border-collapse:collapse}td,th{padding:3px 6px;border-top:1px solid var(--line);text-align:left;vertical-align:top}
th{border-top:0;color:var(--mute);font-weight:500;font-size:11px}.num{text-align:right;font-variant-numeric:tabular-nums}
.bar{display:flex;align-items:center;gap:6px;white-space:nowrap}.track{flex:1;min-width:60px;height:8px;background:var(--bar);border-radius:4px;overflow:hidden}
.fill{height:100%;background:var(--acc)}.hot .fill{background:var(--bad)}.hot{color:var(--bad);font-weight:600}
tr.hotrow td{background:var(--badbg)}
.log{white-space:pre-wrap;word-break:break-all;color:var(--mute);max-height:4.5em;overflow:hidden;cursor:pointer}
.full{max-height:50vh;overflow:auto;background:var(--bg);border:1px solid var(--line);padding:6px;margin:4px 0;white-space:pre-wrap;word-break:break-all}
.scroll{max-height:420px;overflow:auto}svg{display:block;width:100%;height:90px}
.legend{display:flex;gap:12px;font-size:11px;color:var(--mute)}.sw{display:inline-block;width:10px;height:3px;vertical-align:middle;margin-right:4px}
</style></head><body><main>
<header><h1>Burndown</h1><span id="status"></span><span id="runid" class="mono mute"></span><span id="meta" class="mute"></span><span id="updated" class="mute" style="margin-left:auto"></span></header>
<div id="banners"></div><div class="kpis" id="kpis"></div>
<div class="grid"><section><h2>Accounts</h2><div id="accounts"></div></section>
<section><h2>Workers</h2><div id="workers" class="scroll"></div></section></div>
<div class="grid3"><section><h2>Merge queue</h2><div id="queue" class="scroll"></div></section>
<section><h2>Monitor</h2><div id="monitor" class="scroll"></div></section>
<section><h2>Rounds</h2><div id="timeline"></div></section></div>
</main><script>
const $=(id)=>document.getElementById(id)
const esc=(s)=>String(s??"").replace(/[&<>"']/g,(c)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c])
const dur=(ms)=>{if(ms==null||!isFinite(ms))return"–";const neg=ms<0;ms=Math.abs(ms);const m=Math.floor(ms/6e4),h=Math.floor(m/60),d=Math.floor(h/24);
 const s=d?d+"d"+(h%24)+"h":h?h+"h"+String(m%60).padStart(2,"0")+"m":m+"m";return neg?"-"+s:s}
const time=(t)=>t?new Date(t).toLocaleTimeString([], {hour:"2-digit",minute:"2-digit"}):"–"
const pill=(s)=>'<span class="pill s-'+esc(s)+'">'+esc(s)+'</span>'
const gh=(repo,n)=>typeof repo==="string"&&repo&&Number.isSafeInteger(n)&&n>0?'<a href="https://github.com/'+esc(repo)+'/issues/'+n+'" target="_blank">'+esc(repo.split("/")[1])+'#'+n+'</a>':"–"
const open=new Set()
document.addEventListener("click",(event)=>{const el=event.target.closest?.("[data-key]");if(el)toggle(el.dataset.key)})
async function toggle(key){if(open.has(key))open.delete(key);else open.add(key);await fillLogs()}
async function fillLogs(){for(const el of document.querySelectorAll("[data-full]")){const k=el.dataset.full;
 if(!open.has(k)){el.hidden=true;continue}el.hidden=false;const atEnd=el.scrollTop+el.clientHeight>=el.scrollHeight-4;
 el.textContent=await (await fetch("/api/log?key="+encodeURIComponent(k))).text();if(atEnd)el.scrollTop=el.scrollHeight}}
function render(d){
 const r=d.run;$("status").innerHTML=pill(r.status);$("runid").textContent=r.runId??"no burndown run"
 $("meta").textContent=[r.round!=null?"round "+r.round:"",r.wakeAt?"wakes in "+dur(r.wakeAt-d.now):"",r.waiting&&!r.wakeAt?r.waiting:"",
  r.options?(Array.isArray(r.options.repos)?r.options.repos.filter((repo)=>typeof repo==="string").join(" "):"")+" · max "+r.options.maxAgents+" · "+r.options.placement:""].filter(Boolean).join(" · ")
 $("updated").textContent=time(d.now)
 let b=""
 if(d.needsYou)b+='<div class="banner">NEEDS YOU<pre>'+esc(d.needsYou)+'</pre></div>'
 if(r.status==="failed")b+='<div class="banner">Run failed<pre>'+esc(r.cause)+'</pre></div>'
 for(const [k,v] of Object.entries(d.sources))if(v&&v.error)b+='<div class="banner" style="font-weight:400">'+esc(k)+': '+esc(v.error)+'</div>'
 $("banners").innerHTML=b
 const c=d.counts,k=[["open",c.open],["in flight",c.inFlight],["landed today",c.landedToday],["landed",c.landedTotal],["quarantined",c.quarantined],["failed",c.failed],["rounds",c.rounds],["candidates",c.candidates]]
 $("kpis").innerHTML=k.map(([n,v])=>'<div class="kpi"><b>'+esc(v??"–")+'</b><span>'+n+'</span></div>').join("")
 $("accounts").innerHTML=d.accounts.length?'<table><tr><th>account</th><th>email</th><th>usage</th><th class="num">slots</th><th class="num">run</th></tr>'+
  d.accounts.map((a)=>{const hot=a.windows.some((w)=>w.used>=90)||a.problem;return '<tr class="'+(hot?"hotrow":"")+'"><td class="mono">'+esc(a.id)+
  (a.aliases.length?'<div class="mute">+'+esc(a.aliases.join(" "))+'</div>':"")+'</td><td class="mute">'+esc(a.email)+'</td><td>'+
  (a.problem?'<span class="hot">'+esc(a.problem)+'</span>':"")+a.windows.map((w)=>'<div class="bar '+(w.used>=90?"hot":"")+'" title="'+esc(w.name)+'"><span class="mute" style="width:22px">'+
  ({five_hour:"5h",seven_day:"7d",primary:"win"}[w.name]??esc(w.name))+'</span><span class="track"><span class="fill" style="display:block;width:'+Math.min(100,w.used)+'%"></span></span><span class="num" style="width:34px">'+
  Math.round(w.used)+'%</span><span class="mute" style="width:52px">'+(w.resetsAt==null?"":"↻"+dur(w.resetsAt-d.now))+'</span></div>').join("")+'</td><td class="num">'+esc(a.slots)+
  '</td><td class="num">'+esc(a.inFlight)+'</td></tr>'}).join("")+'</table>':'<span class="mute">reading…</span>'
 $("workers").innerHTML=d.workers.length?'<table><tr><th>key</th><th>issue</th><th>account</th><th class="num">time</th><th>status</th></tr>'+d.workers.map((w)=>
  '<tr><td class="mono">'+esc(w.key)+(w.fix?' <span class="mute">fix</span>':"")+'</td><td title="'+esc(w.title)+'">'+gh(w.repo,w.lead)+(w.extras.length?' <span class="mute">+'+w.extras.map((n)=>gh(w.repo,n)).join(" ")+'</span>':"")+
  '</td><td class="mono">'+esc(w.account)+'<div class="mute">'+esc(w.model)+'</div></td><td class="num">'+dur((w.finishedAt??d.now)-(w.startedAt??d.now))+
  '</td><td>'+pill(w.status)+'</td></tr><tr><td colspan="5"><div class="log mono" data-key="'+esc(w.key)+'">'+esc((w.cause||w.notes&&w.status!=="landed"?[w.cause??"",...w.tail.slice(-1)]:w.tail).filter(Boolean).join("\\n")||"(no log)")+
  '</div><pre class="full mono" data-full="'+esc(w.key)+'" hidden></pre></td></tr>').join("")+'</table>':'<span class="mute">none</span>'
 let q=""
 if(d.quarantined.length)q+='<table><tr><th>quarantined</th><th></th></tr>'+d.quarantined.map((x)=>'<tr><td class="mono '+(x.current?"hot":"")+'">'+esc(x.key)+'<div class="mute">'+time(x.at)+'</div></td><td><div class="log mono" style="max-height:6em">'+esc(x.error.split("\\n").filter(Boolean).slice(-4).join("\\n"))+'</div></td></tr>').join("")+'</table>'
 q+='<table><tr><th>landed</th><th>sha</th><th class="num">at</th></tr>'+(d.landings.length?d.landings.map((l)=>'<tr><td class="mono">'+esc(l.key)+'</td><td class="mono">'+
  (l.shas.map((s)=>s.sha?'<a href="https://github.com/'+esc(l.repo)+'/commit/'+s.sha+'" target="_blank">'+s.sha.slice(0,10)+'</a>':'#'+s.n).join(" ")||"–")+'</td><td class="num">'+time(l.at)+'</td></tr>').join(""):'<tr><td colspan="3" class="mute">none</td></tr>')+'</table>'
 if(d.scripts.length)q+='<div class="mute" style="margin-top:6px">scripts: '+d.scripts.map((s)=>esc(s.key)).join(" ")+'</div>'
 $("queue").innerHTML=q
 $("monitor").innerHTML=d.monitor.length?'<table>'+d.monitor.map((m)=>'<tr><td class="num mute">'+time(m.at)+'</td><td>'+(m.healthy==null?"":pill(m.healthy?"ready":"failed").replace(/>ready</,">ok<").replace(/>failed</,">bad<"))+'</td><td>'+esc(m.text)+'</td></tr>').join("")+'</table>':'<span class="mute">no monitor.log</span>'
 $("timeline").innerHTML=spark(d.timeline)
 fillLogs()}
function spark(t){if(!t.length)return'<span class="mute">no rounds</span>';const W=400,H=90,n=t.length,max=Math.max(1,...t.map((x)=>Math.max(x.inFlight,x.landed))),bw=W/n
 const y=(v)=>H-4-(v/max)*(H-12);const line=t.map((x,i)=>(i?"L":"M")+(i*bw+bw/2).toFixed(1)+","+y(x.inFlight).toFixed(1)).join("")
 const bars=t.map((x,i)=>x.landed?'<rect x="'+(i*bw+1).toFixed(1)+'" y="'+y(x.landed).toFixed(1)+'" width="'+Math.max(1,bw-2).toFixed(1)+'" height="'+(H-4-y(x.landed)).toFixed(1)+'" fill="var(--ok)"><title>round '+esc(x.round)+': landed '+esc(x.landed)+'</title></rect>':"").join("")
 const last=t[n-1];return'<svg viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">'+bars+'<path d="'+line+'" fill="none" stroke="var(--acc)" stroke-width="1.5" vector-effect="non-scaling-stroke"/><circle cx="'+((n-1)*bw+bw/2).toFixed(1)+'" cy="'+y(t[n-1].inFlight).toFixed(1)+'" r="3" fill="var(--acc)"/></svg>'+
 '<div class="legend"><span><i class="sw" style="background:var(--acc)"></i>in flight (now '+esc(last.inFlight)+')</span><span><i class="sw" style="background:var(--ok)"></i>landed</span><span>max '+esc(max)+'</span><span>rounds '+esc(t[0].round)+'–'+esc(last.round)+'</span></div>'}
async function poll(){try{const res=await fetch("/api/state");const d=await res.json();if(d.error)throw new Error(d.error);render(d)}
 catch(e){$("banners").innerHTML='<div class="banner">dashboard: '+esc(e.message)+'</div>'}}
poll();setInterval(poll,5000)
</script></body></html>`

  return {
    server,
    snapshot,
    close: async () => {
      for (const timer of timers) clearInterval(timer)
      if (server.listening) {
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
      }
    }
  }
}

/** Binding failure never opens or adopts an unrelated server. */
export async function serveDashboard(dashboard: ReturnType<typeof createDashboard>, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const failed = (error: Error) => reject(error)
    dashboard.server.once("error", failed)
    dashboard.server.listen(port, "127.0.0.1", () => {
      dashboard.server.removeListener("error", failed)
      const address = dashboard.server.address()
      if (address === null || typeof address === "string") return reject(new Error("Missing dashboard address"))
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let dashboard: ReturnType<typeof createDashboard> | undefined
  try {
    const runId = process.env.BURNDOWN_RUN_ID
    if (runId === undefined) throw new Error("BURNDOWN_RUN_ID is required")
    const hostDir = process.env.BURNDOWN_HOST ?? process.cwd()
    dashboard = createDashboard({
      hostDir,
      runId,
      reportDir: process.env.BURNDOWN_REPORT_DIR ?? join(hostDir, ".flows", "burndown", runId)
    })
    const url = await serveDashboard(dashboard, Number(process.env.BURNDOWN_DASHBOARD_PORT ?? 4777))
    process.stdout.write(`burndown dashboard ${url}\n`)
    if (process.env.BURNDOWN_DASHBOARD_NO_OPEN !== "1") execFile("open", [url], () => undefined)
  } catch (error) {
    await dashboard?.close()
    process.stderr.write(`dashboard: ${String((error as Error).message ?? error)}\n`)
    process.exitCode = 1
  }
}
