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

/** The authenticated run topic is authoritative. HTTP trace reads never launch
 * a flow, retry a step, or evaluate repository presentation code. */
export function createRunMonitorSeam(options: {
  readonly http: (path: string, init?: RequestInit) => Promise<Response>
  readonly live?: Pick<LiveChannel, "subscribe" | "getSnapshot">
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
      if (source.success && source.data.summary.runId === id.split(":").at(-1)) {
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
