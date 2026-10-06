import type { LiveTopics } from "../useTopic"
import { z } from "zod"
import { nextEgressCursor as nextBranchCursor } from "./EgressSeam"
import { ActorSchema } from "@smthrs/rpc/CardPrimitives"
import type { TerminalCard } from "@smthrs/rpc/TerminalCard"
import type { TerminalStream } from "@smthrs/ui/adapters/terminal"
import type { CloudTerminalClient } from "../CloudTerminalClient"

// T-APP-12: serialized branch metadata only; stream callbacks never cross this decoder.
const TerminalMetadata = z.object({ id: z.string().min(1), title: z.string(), owner: ActorSchema,
  agents: z.array(ActorSchema), watchers: z.array(ActorSchema), command: z.string().optional(), frozen: z.boolean() })
const BranchTerminals = z.object({ terminals: z.array(TerminalMetadata),
  rebase: z.object({ state: z.enum(["pending", "rebasing", "conflict"]) }).optional() })

export function terminalModel(data: unknown, branch: string, id: string, viewer: string | undefined): TerminalCard | undefined {
  if (!viewer) return
  const decoded = BranchTerminals.safeParse(data)
  if (!decoded.success) return
  const terminal = decoded.data.terminals.find(row => row.id === id)
  if (!terminal) return
  const owner = terminal.owner
  // Coding/reviewer sessions are never writable, including when acting for the viewer.
  const viewer_is_owner = owner.kind === "person" ? owner.login === viewer
    : owner.kind === "agent" && owner.agent !== "coding" && owner.agent !== "reviewer" && owner.for_member?.login === viewer
  return { ...terminal, branch, viewer_is_owner, frozen: terminal.frozen || decoded.data.rebase?.state === "rebasing" }
}

/** Supplied only by the production provider after T-TRM-01 isolation/authority checks. */
export interface TerminalCardSource {
  readonly branch: (id: string) => string | undefined
  readonly repo: string
  readonly viewer: () => string | undefined
  readonly available: () => boolean
  readonly subscribe?: (listener: () => void) => () => void
}

/** Uses the existing byte client; rechecks authority even for callbacks retained by the emulator. */
export function createTerminalBinding(options: {
  repo: string; branch: string; id: string; client: CloudTerminalClient
  viewer: () => string | undefined; available: () => boolean; metadata: () => unknown
}) {
  const model = () => options.available() ? terminalModel(options.metadata(), options.branch, options.id, options.viewer()) : undefined
  const writable = () => { const value = model(); return value?.viewer_is_owner && !value.frozen }
  const stream: TerminalStream = write => {
    if (!model()) return
    return options.client.attach(options.repo, options.id, { onOutput: data => { if (model()) write(data) } })
  }
  return { model, stream,
    input: (data: string) => { if (writable()) options.client.input(options.id, data) },
    resize: ({ cols, rows }: { cols: number; rows: number }) => { if (writable()) options.client.resize(options.id, cols, rows) } }
}

/** Discover registered sessions through the existing branch-topic client. No terminal socket is opened here. */
export function createTerminalSource(options: {
  repo: () => string
  viewer: () => string | undefined
  subscribeViewer?: (listener: () => void) => () => void
  live: LiveTopics
  knownBranches?: () => Iterable<string>
  http: (path: string, init?: RequestInit) => Promise<Response>
}) {
  const listeners = new Set<() => void>()
  const branches = new Map<string, () => void>()
  let disposed = false
  let revision = 0
  let reading: Promise<void> | undefined
  const notify = () => { for (const listener of listeners) listener() }
  const observe = (id: string) => {
    if (!disposed && !branches.has(id)) branches.set(id, options.live.subscribe(`branch:${id}`, notify))
  }
  const read = (): Promise<void> => {
    if (disposed || !options.viewer()) return Promise.resolve()
    if (reading) return reading
    const viewer = options.viewer()
    const request = ++revision
    reading = (async () => {
      try {
        const seen = new Set<string>()
        let cursor: string | null = ""
        while (cursor !== null && !seen.has(cursor) && !disposed && revision === request && options.viewer() === viewer) {
          seen.add(cursor)
          const response = await options.http(`/api/branches${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`, { credentials: "same-origin" })
          const decoded = response.ok ? z.array(z.union([
            z.object({ id: z.string().min(1) }), z.object({ name: z.string().min(1) })
          ])).safeParse(await response.json()) : undefined
          if (disposed || revision !== request || options.viewer() !== viewer || !decoded?.success) return
          for (const branch of decoded.data) observe("id" in branch ? branch.id : branch.name)
          cursor = nextBranchCursor(response.headers.get("link"), "/branches")
        }
      } catch { /* Missing branch authority exposes no terminal. The command door reports its refusal. */ }
      finally { if (request === revision) { reading = undefined; notify() } }
    })()
    return reading
  }
  const stopViewer = options.subscribeViewer?.(() => {
    ++revision; reading = undefined
    for (const stop of branches.values()) stop()
    branches.clear()
    notify()
    if (listeners.size) void read()
  })
  const source: TerminalCardSource = {
    get repo() { return options.repo() }, viewer: options.viewer,
    available: () => !disposed && options.viewer() !== undefined,
    branch: id => {
      if (disposed || !options.viewer()) return undefined
      for (const branch of new Set([...branches.keys(), ...options.knownBranches?.() ?? []])) {
        const snapshot = options.live.getSnapshot(`branch:${branch}`)
        if (!snapshot?.error && terminalModel(snapshot?.data, branch, id, options.viewer())) return branch
      }
      return undefined
    },
    subscribe: listener => {
      listeners.add(listener)
      void read()
      return () => { listeners.delete(listener) }
    }
  }
  return { source, read, observe, dispose: () => {
    disposed = true
    ++revision
    stopViewer?.()
    for (const stop of branches.values()) stop()
    branches.clear(); listeners.clear()
  } }
}
