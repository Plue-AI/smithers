import { MonitorCardSchema, type MonitorCard } from "@smthrs/rpc/RunCard"
import { monitorFromJournal, type JournalRecord } from "@smthrs/gateway/RunTrace"
import { z } from "zod"
import type { LiveChannel } from "../../runtime/LiveChannel"

export interface RunMonitorSnapshot { readonly model?: MonitorCard; readonly error?: string }
export interface RunMonitorSnapshots {
  readonly get: (id: string) => RunMonitorSnapshot
  readonly subscribe: (id: string, notify: () => void) => () => void
}
const TraceResponseSchema = MonitorCardSchema.extend({ archive_replay: z.object({ run_id: z.string().min(1) }).optional() })

// Replay the archive with the existing gateway fold, using only recorded JSON.
// The archive carries the host's canonical run ID because URLs qualify it with
// a workspace ID. Restore the qualified identity after projecting the frame.
const replayArchive = (model: z.infer<typeof TraceResponseSchema>, at: number): MonitorCard => {
  const records: JournalRecord[] = (model.journal ?? []).map(row => ({
    runId: model.archive_replay!.run_id, sequence: row.seq, occurredAt: Date.parse(row.at),
    kind: row.type, payload: JSON.parse(row.text)
  }))
  const frame = monitorFromJournal({ runId: model.archive_replay!.run_id, flowId: model.flow, status: model.state }, records, at)
  const prices = new Map((model.attempts.at(-1)?.steps ?? []).map(step => [step.key, step] as const))
  const steps = frame.attempts[0]!.steps.map(step => {
    const metered = prices.get(step.key)
    return { ...step, ...((step.state === "completed" || step.state === "failed") && metered?.usage ? { usage: metered.usage } : {}) }
  })
  const phases = frame.attempts[0]!.phases
  const flags = model.attempts.at(-1)?.phases.filter(phase => phase.tone === "thrash") ?? []
  for (const flag of flags) {
    const phase = [...phases].reverse().find(phase => phase.title === "Ran checks" || phase.title.startsWith("Ran checks · "))
    if (phase) Object.assign(phase, { tone: "thrash", indicator: flag.indicator })
  }
  const earlier = model.attempts.slice(0, -1)
  const priced = [...earlier.flatMap(attempt => attempt.steps), ...steps]
  return MonitorCardSchema.parse({ ...frame, id: model.id, title: model.title, version: model.version,
    todo: model.todo, branch: model.branch, waits: [...new Map([...frame.waits, ...model.waits].map(wait => [wait.id, wait])).values()], journal: model.journal, replay: model.replay,
    tokens: priced.reduce((sum, step) => sum + (step.usage?.tokens ?? 0), 0),
    cost_usd: priced.reduce((sum, step) => sum + (step.usage?.cost_usd ?? 0), 0),
    attempts: [...earlier, { ...frame.attempts[0], n: model.attempts.at(-1)?.n ?? 1, run_id: model.id, steps, phases }]
  })
}

const unavailable = "Run unavailable"
const empty: RunMonitorSnapshot = {}
const RunTopicSchema = z.object({
  summary: z.object({ runId: z.string().min(1), flowId: z.string().min(1) }),
  steps: z.array(z.unknown()), events: z.array(z.unknown())
})
const RunListSchema = z.array(MonitorCardSchema.pick({ id: true, title: true }))

/** The run:<id> topic's delta is its next page: summary and steps replace the
 * view's, and its journal events extend it (the newest 1000). An unreadable
 * delta throws, so the channel takes a fresh snapshot instead. */
export const projectRunTopic = (previous: unknown, delta: unknown): unknown => {
  const next = RunTopicSchema.parse(delta)
  const prior = RunTopicSchema.safeParse(previous)
  return { ...(delta as Record<string, unknown>), events: [...(prior.success ? prior.data.events : []), ...next.events].slice(-1000) }
}

/** The authenticated run topic is authoritative. HTTP trace reads never launch
 * a flow, retry a step, or evaluate repository presentation code. */
export function createRunMonitorSeam(options: {
  readonly http: (path: string, init?: RequestInit) => Promise<Response>
  readonly live?: Pick<LiveChannel, "subscribe" | "getSnapshot"> & Partial<Pick<LiveChannel, "registerProjection">>
  readonly owner?: () => string | undefined
  readonly view?: (id: string) => { readonly tab?: string; readonly at?: number } | undefined
}) {
  const refused: RunMonitorSnapshot = { error: unavailable }
  const owners = new Map<string, string | undefined>()
  const rows = new Map<string, RunMonitorSnapshot>()
  const listeners = new Map<string, Set<() => void>>()
  const subscriptions = new Map<string, () => void>()
  const authorized = new Map<string, string | undefined>()
  const revisions = new Map<string, number>()
  const reads = new Map<string, { at?: number; journal: boolean; owner?: string; revision: number; promise: Promise<string | void> }>()
  let disposed = false
  const publish = (id: string, next: RunMonitorSnapshot, owner = options.owner?.()) => {
    if (disposed || owner !== options.owner?.()) return
    owners.set(id, owner)
    rows.set(id, next)
    for (const notify of listeners.get(id) ?? []) notify()
  }
  const observe = (id: string) => {
    if (disposed || subscriptions.has(id)) return
    const owner = options.owner?.()
    const topic = `run:${id}`
    if (!options.live) { publish(id, { error: unavailable }); return }
    const receive = () => {
      if (owner !== options.owner?.()) return
      const value = options.live?.getSnapshot(topic)
      if (!value) return
      if (value.error) { authorized.delete(id); revisions.set(id, (revisions.get(id) ?? 0) + 1); publish(id, { error: unavailable }); return }
      const source = RunTopicSchema.safeParse(value.data)
      if (source.success && (source.data.summary.runId === id || source.data.summary.runId === id.slice(id.indexOf(":") + 1))) {
        authorized.set(id, owner)
        // A live update reads the monitor alone; the journal loads when its
        // tab is open or a replay position is selected.
        const view = options.view?.(id)
        void read(id, view?.at, view?.tab === "journal" || view?.at !== undefined).then(error => {
          if (error) publish(id, { error }, owner)
        })
        return
      }
      const parsed = MonitorCardSchema.safeParse(value.data)
      if (!parsed.success || parsed.data.id !== id) { authorized.delete(id); revisions.set(id, (revisions.get(id) ?? 0) + 1); publish(id, { error: unavailable }); return }
      authorized.set(id, owner)
      const view = options.view?.(id)
      // Keep the selected historical frame while its read is pending. Live
      // snapshots still validate authority, but must not replace replay data.
      if (view?.at === undefined || !snapshots.get(id).model) publish(id, { model: parsed.data })
      if (view?.tab === "journal" || view?.at !== undefined) void trace(id, view.at).then(error => {
        if (error) publish(id, { error }, owner)
      })
    }
    // Each page applies to the view; without a projector every delta would
    // cost a resubscription and a fresh snapshot.
    options.live.registerProjection?.(topic, projectRunTopic)
    subscriptions.set(id, options.live.subscribe(topic, receive))
    if (!rows.has(id) || owners.get(id) === owner) receive()
  }
  const snapshots: RunMonitorSnapshots = {
    get: id => rows.has(id) && owners.get(id) !== options.owner?.() ? refused : rows.get(id) ?? empty,
    subscribe: (id, notify) => {
      const set = listeners.get(id) ?? new Set<() => void>()
      listeners.set(id, set); set.add(notify); observe(id)
      return () => {
        set.delete(notify)
        if (set.size === 0) { revisions.set(id, (revisions.get(id) ?? 0) + 1); subscriptions.get(id)?.(); subscriptions.delete(id) }
      }
    }
  }
  const read = async (id: string, at: number | undefined, journal: boolean): Promise<string | void> => {
    if (disposed || !authorized.has(id) || authorized.get(id) !== options.owner?.()) return unavailable
    const owner = options.owner?.()
    const pending = reads.get(id)
    if (pending && pending.owner === owner && pending.at === at && pending.journal === journal && pending.revision === revisions.get(id)) return pending.promise
    const revision = (revisions.get(id) ?? 0) + 1
    revisions.set(id, revision)
    const path = journal ? `/api/runs/${encodeURIComponent(id)}/trace${at === undefined ? "" : `?at=${at}`}` : `/api/runs/${encodeURIComponent(id)}`
    const promise = (async (): Promise<string | void> => {
      try {
        const response = await options.http(path, { method: "GET", credentials: "same-origin" })
        const parsed = response.ok ? TraceResponseSchema.safeParse(await response.json()) : undefined
        if (disposed || owner !== options.owner?.() || revisions.get(id) !== revision) return
        if (!parsed?.success || parsed.data.id !== id || (journal && parsed.data.journal === undefined) || (at !== undefined && parsed.data.replay?.at !== at)) return unavailable
        publish(id, { model: at !== undefined && parsed.data.archive_replay ? replayArchive(parsed.data, at) : parsed.data })
      } catch { if (!disposed && owner === options.owner?.() && revisions.get(id) === revision) return unavailable }
    })()
    reads.set(id, { at, journal, owner, revision, promise })
    try { return await promise } finally { if (reads.get(id)?.revision === revision) reads.delete(id) }
  }
  /** The journal tab and the replay scrubber: the monitor with its journal. */
  const trace = (id: string, at?: number): Promise<string | void> => read(id, at, true)
  const list = async (): Promise<ReadonlyArray<Pick<MonitorCard, "id" | "title">> | undefined> => {
    if (disposed || !options.live) return undefined
    const owner = options.owner?.()
    try {
      const response = await options.http("/api/runs", { method: "GET", credentials: "same-origin" })
      const parsed = response.ok ? RunListSchema.safeParse(await response.json()) : undefined
      return !disposed && owner === options.owner?.() && parsed?.success ? parsed.data : undefined
    } catch { return undefined }
  }
  const dispose = () => {
    disposed = true
    for (const stop of subscriptions.values()) stop()
    authorized.clear(); subscriptions.clear(); rows.clear(); owners.clear(); listeners.clear(); revisions.clear(); reads.clear()
  }
  return { snapshots, trace, list, dispose }
}
