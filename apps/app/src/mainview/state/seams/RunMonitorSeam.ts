import { MonitorCardSchema, type MonitorCard } from "@smthrs/rpc/RunCard"
import { z } from "zod"
import type { LiveChannel } from "../../runtime/LiveChannel"

export interface RunMonitorSnapshot { readonly model?: MonitorCard; readonly error?: string }
export interface RunMonitorSnapshots {
  readonly get: (id: string) => RunMonitorSnapshot
  readonly subscribe: (id: string, notify: () => void) => () => void
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
  const reads = new Map<string, { at?: number; owner?: string; revision: number; promise: Promise<string | void> }>()
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
        void trace(id, options.view?.(id)?.at).then(error => {
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
  const trace = async (id: string, at?: number): Promise<string | void> => {
    if (disposed || !authorized.has(id) || authorized.get(id) !== options.owner?.()) return unavailable
    const owner = options.owner?.()
    const pending = reads.get(id)
    if (pending && pending.owner === owner && pending.at === at && pending.revision === revisions.get(id)) return pending.promise
    const revision = (revisions.get(id) ?? 0) + 1
    revisions.set(id, revision)
    const path = `/api/runs/${encodeURIComponent(id)}/trace${at === undefined ? "" : `?at=${at}`}`
    const promise = (async (): Promise<string | void> => {
      try {
        const response = await options.http(path, { method: "GET", credentials: "same-origin" })
        const parsed = response.ok ? MonitorCardSchema.safeParse(await response.json()) : undefined
        if (disposed || owner !== options.owner?.() || revisions.get(id) !== revision) return
        if (!parsed?.success || parsed.data.id !== id || parsed.data.journal === undefined || (at !== undefined && parsed.data.replay?.at !== at)) return unavailable
        publish(id, { model: parsed.data })
      } catch { if (!disposed && owner === options.owner?.() && revisions.get(id) === revision) return unavailable }
    })()
    reads.set(id, { at, owner, revision, promise })
    try { return await promise } finally { if (reads.get(id)?.revision === revision) reads.delete(id) }
  }
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
