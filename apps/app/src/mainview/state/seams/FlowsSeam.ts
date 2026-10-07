import { FlowCardSchema, type FlowCard } from "@smthrs/rpc/FlowCard"
import { z } from "zod"
import type { LiveChannel } from "../../runtime/LiveChannel"

/** The install's flow catalog (GET /api/flows, T-APP-05). A failed read keeps the last catalog and says so. */
export interface FlowsSnapshot { readonly flows?: ReadonlyArray<FlowCard>; readonly error?: string }
export interface FlowsSnapshots {
  readonly get: () => FlowsSnapshot
  readonly subscribe: (listener: () => void, name?: string) => () => void
}
export const flowsUnavailable = "Flows unavailable"

const FlowCatalogSchema = z.array(FlowCardSchema)

/** External-store lifecycle owns reads: the first subscriber reads the catalog, and the `flows` topic rereads it. */
export function createFlowsSeam(options: {
  readonly http: (path: string, init?: RequestInit) => Promise<Response>
  readonly live?: Pick<LiveChannel, "subscribe">
}) {
  let snapshot: FlowsSnapshot = {}
  let generation = 0
  let disposed = false
  let stop: (() => void) | undefined
  const listeners = new Map<() => void, string | undefined>()
  const publish = (next: FlowsSnapshot) => { snapshot = next; for (const listener of listeners.keys()) listener() }
  /** Named system flows are served separately and never enter the repository list. */
  const read = async (name?: string): Promise<ReadonlyArray<FlowCard> | undefined> => {
    if (disposed) return undefined
    const revision = ++generation
    try {
      const response = await options.http("/api/flows", { credentials: "same-origin" })
      const parsed = response.ok ? FlowCatalogSchema.safeParse(await response.json()) : undefined
      if (disposed || revision !== generation) return undefined
      if (parsed?.success !== true) { publish({ ...snapshot, error: flowsUnavailable }); return undefined }
      const requested = new Set([...listeners.values(), name].filter((value): value is string => value !== undefined))
      const named = await Promise.all([...requested].filter(value => !parsed.data.some(card => card.name === value)).map(async value => {
        try {
          const response = await options.http(`/api/flows/${encodeURIComponent(value)}`, { credentials: "same-origin" })
          const card = response.ok ? FlowCardSchema.safeParse(await response.json()) : undefined
          return card?.success && card.data.name === value ? card.data : undefined
        } catch { return undefined }
      }))
      if (disposed || revision !== generation) return undefined
      const resolved = named.filter((card): card is FlowCard => card !== undefined)
      const retained = snapshot.flows?.filter(card => card.system && !requested.has(card.name) && !parsed.data.some(row => row.name === card.name)) ?? []
      publish({ flows: [...parsed.data, ...resolved, ...retained] })
      return name === undefined ? parsed.data : [...parsed.data, ...resolved.filter(card => card.name === name)]
    } catch {
      if (!disposed && revision === generation) publish({ ...snapshot, error: flowsUnavailable })
      return undefined
    }
  }
  const snapshots: FlowsSnapshots = { get: () => snapshot, subscribe: (listener, name) => {
    listeners.set(listener, name)
    if (!disposed && stop === undefined) stop = options.live?.subscribe("flows", () => { void read() }) ?? (() => {})
    if (!disposed && (snapshot.flows === undefined || (name !== undefined && !snapshot.flows.some(card => card.name === name)))) void read()
    return () => { listeners.delete(listener) }
  } }
  const dispose = () => { disposed = true; ++generation; stop?.(); listeners.clear() }
  return { snapshots, read, dispose }
}
