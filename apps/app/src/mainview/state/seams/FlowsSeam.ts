import { FlowCardSchema, type FlowCard } from "@smthrs/rpc/FlowCard"
import { z } from "zod"
import type { LiveChannel } from "../../runtime/LiveChannel"

/** The install's flow catalog (GET /api/flows, T-APP-05). A failed read keeps the last catalog and says so. */
export interface FlowsSnapshot { readonly flows?: ReadonlyArray<FlowCard>; readonly error?: string }
export interface FlowsSnapshots {
  readonly get: () => FlowsSnapshot
  readonly subscribe: (listener: () => void) => () => void
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
  const listeners = new Set<() => void>()
  const publish = (next: FlowsSnapshot) => { snapshot = next; for (const listener of listeners) listener() }
  /** The served catalog, or undefined when the install did not serve one. */
  const read = async (): Promise<ReadonlyArray<FlowCard> | undefined> => {
    if (disposed) return undefined
    const revision = ++generation
    try {
      const response = await options.http("/api/flows", { credentials: "same-origin" })
      const parsed = response.ok ? FlowCatalogSchema.safeParse(await response.json()) : undefined
      if (disposed || revision !== generation) return snapshot.flows
      if (parsed?.success !== true) { publish({ ...snapshot, error: flowsUnavailable }); return undefined }
      publish({ flows: parsed.data })
      return parsed.data
    } catch {
      if (!disposed && revision === generation) publish({ ...snapshot, error: flowsUnavailable })
      return undefined
    }
  }
  const snapshots: FlowsSnapshots = { get: () => snapshot, subscribe: listener => {
    listeners.add(listener)
    if (!disposed && stop === undefined) {
      stop = options.live?.subscribe("flows", () => { void read() }) ?? (() => {})
      if (snapshot.flows === undefined) void read()
    }
    return () => { listeners.delete(listener) }
  } }
  const dispose = () => { disposed = true; ++generation; stop?.(); listeners.clear() }
  return { snapshots, read, dispose }
}
