/** Implementations behind the burndown monitor. */
import { Journal } from "@smthrs/flows"
import { Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import { appendFile, mkdir, readFile, realpath } from "node:fs/promises"
import { isAbsolute, join, relative } from "node:path"
import { promisify } from "node:util"
import { Diagnose, Inspect, Report } from "./loop.ts"

const run = promisify(execFile)
const timeout = 15_000

const localEnvironment = () => {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "NO_COLOR", "USER", "LOGNAME"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  return env
}

/** The watched checkout owns CLI source; PATH never selects a Smithers observer. */
const runWatchedCli = async (hostRoot: string, args: Array<string>, timeoutMs: number) => {
  if ("bun" in process.versions) throw new Error("Monitor inspection requires Node")
  const root = await realpath(hostRoot)
  const entry = await realpath(join(root, "packages", "smithers", "bin", "smithers.mjs"))
  const inside = relative(root, entry)
  if (inside === ".." || inside.startsWith("../") || isAbsolute(inside)) {
    throw new Error("Watched CLI must remain inside the watched checkout")
  }
  return run(process.execPath, [entry, ...args, "--root", root], {
    env: localEnvironment(),
    cwd: root,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 8 << 20
  })
}

const metadata = (value: unknown) =>
  typeof value === "string" ? String(Journal.Redaction.redactDiagnostic(value)).slice(0, 200) : undefined

const clean = (value: string) => String(Journal.Redaction.redactDiagnostic(value)).replace(/[\s\p{Cc}]+/gu, " ").trim()

/** Inspect only the requested run in the watched host's database. */
export const inspectRun = async (runId: string, hostRoot: string, timeoutMs = timeout): Promise<{
  state: "live" | "terminal" | "unknown"
  evidence: string
  healthy: boolean
  status?: string | undefined
}> => {
  if (!runId || runId.startsWith("-") || /[\s\p{Cc}]/u.test(runId)) {
    return { state: "unknown", healthy: false, evidence: "## run (unknown)\nInvalid run identity." }
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    return { state: "unknown", healthy: false, evidence: "## run (unknown)\nInvalid inspection timeout." }
  }
  try {
    const { stdout } = await runWatchedCli(hostRoot, ["runs", "inspect", runId, "--json"], timeoutMs)
    const value = JSON.parse(stdout)
    const row = value?.position?.runId === runId ? value : undefined
    const status = row?.status
    const state = ["completed", "failed", "cancelled"].includes(status)
      ? "terminal"
      : ["pending", "accepted", "running", "suspended", "parked", "waiting-approval"].includes(status)
      ? "live"
      : "unknown"
    return {
      state,
      status: typeof status === "string" ? status : undefined,
      healthy: state !== "unknown" && status !== "failed" && status !== "cancelled",
      evidence: `## root row (${state}; not lineage status)\n${
        JSON.stringify(
          Journal.Redaction.redactDiagnostic({
            runId,
            status,
            host: metadata(row?.host),
            flowId: metadata(row?.executionFlow),
            waitingReason: metadata(row?.waitingReason)
          })
        )
      }`
    }
  } catch {
    // CLI diagnostics can contain credentials; retain the failure without echoing them.
    return { state: "unknown", healthy: false, evidence: "## run (unknown)\nInspection failed or timed out." }
  }
}

type RecordValue = Record<string, unknown>
const record = (value: unknown): RecordValue =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as RecordValue : {}
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : undefined
const array = (value: unknown): ReadonlyArray<unknown> => Array.isArray(value) ? value : []
const identifier = (value: unknown) =>
  typeof value === "string" && /^(?:run-\d+|[a-f0-9]{40,64})$/.test(value) ? value : "[redacted identity]"
const knownStatus = (value: unknown) =>
  [
      "pending",
      "accepted",
      "running",
      "suspended",
      "parked",
      "waiting",
      "waiting-approval",
      "completed",
      "succeeded",
      "failed",
      "cancelled",
      "ready",
      "closed",
      "blocked",
      "limited"
    ].includes(String(value))
    ? value
    : "unknown"

/** Only measured counts and typed outcome identities leave the journal boundary. */
const receipt = (value: unknown) => {
  const row = record(value)
  const counts: RecordValue = {}
  for (const key of ["ready", "quarantined", "inFlight", "landed", "finished", "commits"]) {
    if (Array.isArray(row[key])) counts[key] = row[key].length
    else if (finite(row[key]) !== undefined) counts[key] = row[key]
  }
  if (row.status !== undefined) counts.status = knownStatus(row.status)
  if (Array.isArray(row.finished)) counts.workerOutcomes = row.finished.map((item) => knownStatus(record(item).status))
  if (row.done !== undefined) counts.done = row.done === true
  if (finite(row.wakeAt) !== undefined) counts.wakeAt = row.wakeAt
  if (finite(row.round) !== undefined) counts.round = row.round
  if (finite(record(row.options).tickMinutes) !== undefined) counts.tickMinutes = record(row.options).tickMinutes
  if (row.next !== undefined) counts.next = receipt(row.next)
  if (Array.isArray(row.ready)) counts.readyOutcomes = row.ready.map((item) => receipt(record(item).result))
  if (Array.isArray(row.commits)) counts.commitIds = row.commits.map((item) => identifier(record(item).commit))
  return counts
}

const settlementStatus = (outcome: unknown) =>
  outcome === "built" || outcome === "clean"
    ? "completed"
    : outcome === "failed"
    ? "failed"
    : outcome === "skipped"
    ? "skipped"
    : outcome === "deferred"
    ? "pending"
    : "unknown"

const unhealthyReceipt = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.some(unhealthyReceipt)
  const item = record(value)
  return typeof item.quarantined === "number" && item.quarantined > 0 ||
    item.status !== undefined &&
      ["blocked", "failed", "limited", "cancelled", "unknown"].includes(String(item.status)) ||
    array(item.workerOutcomes).some((status) =>
      ["blocked", "failed", "limited", "cancelled", "unknown"].includes(String(status))
    ) ||
    Object.values(item).some((child) => typeof child === "object" && child !== null && unhealthyReceipt(child))
}

/** Inspect the selected root's public journal, including its durable flow descendants. */
export const inspectProgress = async (runId: string, hostRoot: string, timeoutMs = timeout): Promise<{
  healthy: boolean
  evidence: string
  state: "live" | "terminal" | "unknown"
  status?: string | undefined
}> => {
  const unknown = {
    state: "unknown" as const,
    healthy: false,
    evidence: "## durable progress (unknown)\nInspection failed, missing or incomplete."
  }
  if (
    !runId || runId.startsWith("-") || /[\s\p{Cc}]/u.test(runId) || !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 || timeoutMs > 2_147_483_647
  ) return unknown
  try {
    const native = await inspectRun(runId, hostRoot, timeoutMs)
    if (native.state === "unknown") return unknown
    const { stdout } = await runWatchedCli(hostRoot, ["runs", "logs", runId, "--limit", "10000", "--json"], timeoutMs)
    const parsed: unknown = JSON.parse(stdout)
    const data = record(parsed)
    const keys = Object.keys(data).filter((key) => /^\d+$/.test(key)).toSorted((a, b) => Number(a) - Number(b))
    const frames = (Array.isArray(parsed) ? parsed : keys.map((key) => data[key])).map(record)
    if (
      frames.length === 0 ||
      frames.some((frame) =>
        frame.runId !== runId || typeof frame.kind !== "string" || finite(frame.sequence) === undefined
      )
    ) return unknown
    const frameWindowIncomplete = frames.length >= 10000
    const observations = new Map<string, RecordValue>()
    const completions = new Set<string>()
    for (const frame of frames) {
      const envelope = record(frame.payload)
      const observation = record(record(record(envelope.payload).executionFact).observation)
      if (
        frame.kind === "control.engine.event" && typeof envelope.executionId === "string" &&
        observation.executionId === envelope.executionId
      ) {
        observations.set(envelope.executionId, observation)
        const result = record(record(envelope.payload).state).result
        const terminal = record(result)
        if (terminal._tag === "Complete" && record(terminal.exit)._tag === "Success") {
          completions.add(envelope.executionId)
        } else completions.delete(envelope.executionId)
      }
    }
    const selected = new Set([runId])
    for (let size = -1; size !== selected.size;) {
      size = selected.size
      for (const [id, row] of observations) {
        if (typeof row.parentRunId === "string" && selected.has(row.parentRunId)) selected.add(id)
      }
    }
    const roundEntries = [...observations.entries()].filter(([id, row]) =>
      selected.has(id) && typeof row.flowName === "string" && row.flowName.endsWith("burndown/round")
    )
    const frontier = roundEntries.toSorted((a, b) =>
      (finite(b[1].roundOrdinal) ?? -1) - (finite(a[1].roundOrdinal) ?? -1) ||
      (finite(b[1].createdAtMs) ?? 0) - (finite(a[1].createdAtMs) ?? 0)
    )[0]?.[0] ?? runId
    const current = new Set([frontier])
    const referenced = new Set([frontier])
    let truncatedLaunch = false
    const launchNodes = new Set<string>()
    const launchStarts = new Map<string, number>()
    const launchedWorkers = new Map<string, Array<string>>()
    const ownedLaunchWorkers = new Set<string>()
    const incompleteLaunches = new Set<string>()
    // Detached workers are relevant only when the current round explicitly owns them.
    for (const frame of frames) {
      const envelope = record(frame.payload)
      if (frame.kind !== "control.engine.event" || envelope.executionId !== frontier) {
        continue
      }
      const payload = record(envelope.payload)
      if (
        envelope.eventType === "flows.engine.node-scheduled" && payload.action === "burndown/launch" &&
        typeof payload.nodeId === "string"
      ) {
        launchNodes.add(payload.nodeId)
        const at = finite(envelope.emittedAtMs) ?? finite(frame.occurredAt)
        if (at !== undefined) {
          launchStarts.set(payload.nodeId, Math.min(launchStarts.get(payload.nodeId) ?? at, at))
        }
        launchedWorkers.delete(payload.nodeId)
        incompleteLaunches.delete(payload.nodeId)
      }
      if (
        envelope.eventType === "flows.engine.node-settled" && typeof payload.nodeId === "string" &&
        (launchNodes.has(payload.nodeId) || payload.action === "burndown/launch") &&
        settlementStatus(payload.outcome) === "completed"
      ) {
        const result = record(payload.result)
        incompleteLaunches.delete(payload.nodeId)
        try {
          if (result.truncated === true) {
            truncatedLaunch = true
            const start = launchStarts.get(payload.nodeId)
            const end = finite(envelope.emittedAtMs) ?? finite(frame.occurredAt)
            if (start === undefined || end === undefined || end < start) {
              throw new Error("Missing launch window")
            }
            const owned = [...observations.entries()].filter(([, row]) =>
              row.parentRunId === frontier &&
              row.parentPolicy === "detach" && typeof row.flowName === "string" &&
              row.flowName.endsWith("burndown/worker") &&
              finite(row.createdAtMs) !== undefined && Number(row.createdAtMs) >= start &&
              Number(row.createdAtMs) <= end
            ).map(([id]) =>
              id
            )
            if (owned.length === 0) throw new Error("Missing launch children")
            for (const worker of owned) ownedLaunchWorkers.add(worker)
            launchedWorkers.set(payload.nodeId, owned)
            continue
          }
          if (typeof result.preview !== "string") throw new Error("Missing launch receipt")
          const launched: unknown = JSON.parse(result.preview)
          if (
            !Array.isArray(launched) || launched.some((item) => typeof record(item).executionId !== "string")
          ) throw new Error("Invalid launch receipt")
          const workers = launched.map((item) => String(record(item).executionId))
          for (const worker of workers) ownedLaunchWorkers.add(worker)
          launchedWorkers.set(payload.nodeId, workers)
        } catch {
          incompleteLaunches.add(payload.nodeId)
        }
      }
      const state = record(record(record(envelope.payload).state).payload)
      for (const item of array(state.inFlight)) {
        const worker = record(item).executionId
        if (typeof worker === "string") {
          referenced.add(worker)
          if (observations.has(worker)) current.add(worker)
        }
      }
    }
    for (const worker of ownedLaunchWorkers) {
      referenced.add(worker)
      if (observations.has(worker)) current.add(worker)
    }
    for (const [nodeId, workers] of launchedWorkers) {
      for (const worker of workers) {
        if (observations.has(worker)) current.add(worker)
        else incompleteLaunches.add(nodeId)
      }
    }
    for (let size = -1; size !== current.size;) {
      size = current.size
      for (const [id, row] of observations) {
        if (row.parentPolicy !== "detach" && typeof row.parentRunId === "string" && current.has(row.parentRunId)) {
          current.add(id)
        }
      }
    }
    const executions = new Map<string, RecordValue>()
    const actions = new Map<string, RecordValue>()
    const receipts = new Map<string, RecordValue>()
    const incomplete = new Set<string>()
    const informationalPreviews = new Set<string>()
    let latestProgressAt: number | undefined
    let latestObservationAt: number | undefined
    let partial = frameWindowIncomplete || incompleteLaunches.size > 0 || [...referenced].some((id) =>
      !observations.has(id)
    ) || frames.some((frame) => {
      const id = String(record(frame.payload).executionId)
      return frame.kind === "control.engine.projection-gap" &&
        (id === runId || current.has(id) || referenced.has(id) || truncatedLaunch && !observations.has(id))
    })
    for (const frame of frames) {
      const envelope = record(frame.payload)
      const id = envelope.executionId
      if (frame.kind !== "control.engine.event" || typeof id !== "string" || !current.has(id)) {
        continue
      }
      const payload = record(envelope.payload)
      const at = finite(envelope.emittedAtMs) ?? finite(frame.occurredAt)
      const eventType = envelope.eventType
      if (eventType === "flows.engine.run-decision") {
        const row = record(record(payload.executionFact).observation)
        if (row.executionId === id) {
          executions.set(id, {
            executionId: identifier(id),
            flow: typeof row.flowName === "string" &&
                (row.flowName === "burndown" || row.flowName.endsWith("/burndown") ||
                  row.flowName.endsWith("burndown/round") || row.flowName.endsWith("burndown/worker"))
              ? row.flowName.endsWith("burndown/round")
                ? "burndown/round"
                : row.flowName.endsWith("burndown/worker")
                ? "burndown/worker"
                : "burndown"
              : "wrapper",
            roundOrdinal: finite(row.roundOrdinal),
            status: knownStatus(row.status),
            observedAt: at,
            waiting: {
              reason: ["timer", "event", "approval"].includes(String(record(row.waiting).reason))
                ? record(row.waiting).reason
                : undefined,
              wakeAt: finite(record(row.waiting).wakeAtMs)
            }
          })
          latestObservationAt = Math.max(latestObservationAt ?? 0, at ?? 0)
        }
        const state = record(record(payload.state).payload)
        const summary = receipt(state)
        if (Object.keys(summary).length > 0) {
          receipts.set(`${id}:state`, { executionId: identifier(id), at, source: "round state", ...summary })
        }
      }
      const action = payload.action
      if (
        (eventType === "flows.engine.node-scheduled" || eventType === "flows.engine.node-settled") &&
        typeof payload.nodeId === "string"
      ) {
        const key = `${id}:${payload.nodeId}`
        if (eventType === "flows.engine.node-scheduled") {
          incomplete.delete(key)
          informationalPreviews.delete(key)
          receipts.delete(key)
        }
        if (
          typeof action === "string" &&
          [
            "burndown/observe",
            "burndown/launch",
            "burndown/land",
            "burndown/settle",
            "burndown/worker",
            "burndown/run-agent",
            "burndown/pace",
            "system/sleep"
          ]
            .includes(action)
        ) {
          actions.set(key, {
            executionId: identifier(id),
            action,
            status: eventType === "flows.engine.node-scheduled"
              ? "running"
              : settlementStatus(payload.outcome),
            at
          })
          latestProgressAt = Math.max(latestProgressAt ?? 0, at ?? 0)
        }
        if (eventType === "flows.engine.node-settled" && actions.has(key)) {
          actions.set(key, { ...actions.get(key), status: settlementStatus(payload.outcome), at })
          latestProgressAt = Math.max(latestProgressAt ?? 0, at ?? 0)
          const result = record(payload.result)
          incomplete.delete(key)
          informationalPreviews.delete(key)
          receipts.delete(key)
          const needsResult =
            ["burndown/observe", "burndown/land", "burndown/settle", "burndown/run-agent", "burndown/worker"].includes(
              String(actions.get(key)?.action)
            ) && actions.get(key)?.status === "completed"
          const informational = ["burndown/observe", "burndown/settle"].includes(String(actions.get(key)?.action))
          if (needsResult && result.truncated === true && informational) {
            informationalPreviews.add(key)
          }
          if (needsResult && (typeof result.preview !== "string" || result.truncated === true && !informational)) {
            incomplete.add(key)
          }
          if (typeof result.preview === "string" && result.truncated !== true) {
            try {
              const summary = receipt(JSON.parse(result.preview))
              if (needsResult && Object.keys(summary).length === 0) {
                incomplete.add(key)
              }
              if (Object.keys(summary).length > 0) {
                receipts.set(key, { executionId: identifier(id), at, source: actions.get(key)?.action, ...summary })
              }
            } catch {
              if (needsResult) {
                incomplete.add(key)
              }
            }
          }
        }
      }
    }
    const roundState = receipts.get(`${frontier}:state`)
    const fullRoundCounts = roundState !== undefined &&
      ["ready", "quarantined", "inFlight", "landed"].every((key) => finite(roundState[key]) !== undefined)
    if (!fullRoundCounts) { for (const key of informationalPreviews) incomplete.add(key) }
    partial ||= incomplete.size > 0
    const failed = [...executions.values(), ...actions.values()].some((item) =>
      ["failed", "cancelled", "unknown"].includes(String(item.status))
    )
    const blocked = [...receipts.values()].some(unhealthyReceipt)
    const tickMinutes = [...receipts.values()].map((item) =>
      finite(item.tickMinutes) ?? finite(record(item.next).tickMinutes)
    ).find((value) => value !== undefined && value > 0)
    const overdue = [...executions.values()].some((item) => {
      const waiting = record(item.waiting)
      const wakeAt = finite(waiting.wakeAt)
      return waiting.reason === "timer" && wakeAt !== undefined && Date.now() > wakeAt + (tickMinutes ?? 10) * 120_000
    })
    const waiting = [...executions.values()].some((item) =>
      ["timer", "event", "approval"].includes(String(record(item.waiting).reason))
    )
    const pendingUnknown = [...actions.values()].some((item) => item.status === "pending") && !waiting
    const frontierStatus = String(executions.get(frontier)?.status ?? "unknown")
    const completed = frontierStatus === "completed" && (completions.has(frontier) ||
      [...receipts.entries()].some(([key, item]) => key.startsWith(`${frontier}:`) && item.done === true))
    const lineageState: "live" | "terminal" | "unknown" = partial
      ? "unknown"
      : ["failed", "cancelled"].includes(frontierStatus) || completed
      ? "terminal"
      : ["pending", "accepted", "running", "suspended", "parked", "waiting-approval"].includes(frontierStatus)
      ? "live"
      : "unknown"
    const unresolvedSkipped = !completed &&
      [...actions.values()].some((item) => item.status === "skipped")
    const summary = {
      runId: clean(runId),
      lineageState,
      frontierStatus,
      observedAt: Date.now(),
      latestProgressAt,
      latestObservationAt,
      partial,
      frontier: identifier(frontier),
      overdue,
      pendingUnknown,
      unresolvedSkipped,
      incompleteActions: [...incomplete].map((key) => actions.get(key)?.action),
      informationalPreviewsOmitted: [...informationalPreviews].map((key) => actions.get(key)?.action),
      executions: [...executions.values()],
      actions: [...actions.values()],
      receipts: [...receipts.values()],
      interpretation:
        "Running actions can take longer than the round interval. Old wrapper timestamps and zero agent turns do not prove a stall. Missing cadence or outcome evidence is unknown; no cancellation or relaunch is authorized."
    }
    const evidence = JSON.stringify(summary)
    if (evidence.length > 24000) {
      return {
        state: "unknown",
        healthy: false,
        evidence: "## durable progress (partial)\nSummary exceeds evidence bound; inspect selected run read-only."
      }
    }
    return {
      state: lineageState,
      status: frontierStatus,
      healthy: lineageState !== "unknown" && !partial &&
        [...executions.values()].some((item) => item.flow !== "wrapper") &&
        actions.size > 0 &&
        !failed && !blocked && !overdue && !pendingUnknown && !unresolvedSkipped,
      evidence: `## durable progress${partial ? " (partial)" : ""}\n${evidence}`
    }
  } catch {
    return unknown
  }
}

export const captureEvidence = (label: string, args: Array<string>, hostRoot: string) =>
  run("pgrep", args, { env: localEnvironment(), cwd: hostRoot, timeout, killSignal: "SIGKILL", maxBuffer: 8 << 20 })
    .then(
      ({ stdout }) => ({
        failed: false,
        evidence: `## ${label}\n${String(Journal.Redaction.redactDiagnostic(stdout)).slice(-6000)}`
      }),
      (error: { code?: number }) =>
        error.code === 1
          ? { failed: false, evidence: `## ${label}\n(none)` }
          : { failed: true, evidence: `## ${label} (failed)\nInspection failed or timed out.` }
    )

const text = (label: string, path: string) =>
  readFile(path, "utf8").then(
    (body) => `## ${label}\n${String(Journal.Redaction.redactDiagnostic(body)).slice(-6000)}`,
    () => `## ${label}\n(absent)`
  )

/** Retain the health receipt before deciding whether another round is needed. */
export const reportRun = async ({ runId, hostRoot, reportRoot, verdict, inspectedHealthy }: {
  runId: string
  hostRoot: string
  reportRoot: string
  verdict: { healthy: boolean; findings: ReadonlyArray<string>; actions: ReadonlyArray<string> }
  inspectedHealthy: boolean
}): Promise<boolean> => {
  const inspection = await inspectProgress(runId, hostRoot)
  const healthy = inspection.healthy && inspectedHealthy && verdict.healthy
  const findings = inspection.state === "unknown"
    ? ["Run inspection unknown", ...verdict.findings]
    : verdict.findings
  const line = `${new Date().toISOString()} ${clean(runId).replaceAll(" ", "_")} ${healthy ? "HEALTHY" : "UNHEALTHY"} ${
    findings.map(clean).join(" | ")
  }${verdict.actions.length === 0 ? "" : ` => ${verdict.actions.map(clean).join(" | ")}`}\n`
  await mkdir(reportRoot, { recursive: true })
  await appendFile(join(reportRoot, "monitor.log"), line)
  if (!healthy) {
    await run("osascript", [
      "-e",
      `display notification ${JSON.stringify(clean(findings[0] ?? "unhealthy"))} with title "Burndown unhealthy"`
    ], { env: localEnvironment(), timeout, killSignal: "SIGKILL" }).catch(() => undefined)
  }
  // Unknown evidence retries; it never claims that the run settled.
  return inspection.state !== "terminal"
}

export const layer = Layer.mergeAll(
  Inspect.toLayer(({ runId, hostRoot, reportRoot }) =>
    Effect.tryPromise({
      try: async () => {
        const inspection = await inspectRun(runId, hostRoot)
        const [progress, dispatchers] = await Promise.all([
          inspectProgress(runId, hostRoot),
          captureEvidence("other dispatchers", ["-fl", "dispatch.py"], hostRoot)
        ])
        const evidence = (await Promise.all([
          Promise.resolve(inspection.evidence),
          Promise.resolve(progress.evidence),
          text("supplemental status note (not authoritative)", join(reportRoot, "status.txt")),
          text("needs you", join(reportRoot, "NEEDS-YOU.md")),
          Promise.resolve(dispatchers.evidence)
        ])).join("\n\n")
        return { healthy: progress.healthy && !dispatchers.failed, now: Date.now(), evidence }
      },
      catch: () => "Monitor inspection failed"
    }), { implementationVersion: "burndown/monitor/inspect/v6" }),
  Diagnose.layer,
  Report.toLayer(
    (payload) =>
      Effect.tryPromise({ try: () => reportRun(payload), catch: () => "Monitor report could not be retained" }),
    {
      implementationVersion: "burndown/monitor/report/v6"
    }
  )
)
