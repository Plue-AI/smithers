import { z } from "zod"
import { SyncHealthSchema } from "@smthrs/rpc/CardPrimitives"
import { randomUuid } from "../../runtime/RandomUuid"

/**
 * The install's GitHub sync (spec §6.3): GET /api/github/sync is the health Home's `main` row shows, and POST makes
 * every followed `main` due now. A host that serves no sync (no route, or 503 unavailable) has no health here, and the
 * row keeps what its `home` source says. Reads run only while a card subscribes, every `pollMs`.
 */
export const GitHubSyncHealthSchema = z.object({
  state: SyncHealthSchema,
  last_success_at: z.string().nullable(),
  cause: z.enum(["permission", "not_installed"]).optional(),
  retry_at: z.string().optional()
})
export type GitHubSyncHealth = z.infer<typeof GitHubSyncHealthSchema>
export interface GitHubSyncSnapshots {
  readonly get: () => GitHubSyncHealth | undefined
  readonly subscribe: (listener: () => void) => () => void
}
export interface GitHubSyncSeamOptions {
  /** Same-origin fetch of an install API path. Absent, the host serves no sync. */
  readonly http?: (path: string, init?: RequestInit) => Promise<Response>
  readonly pollMs?: number
}

export function createGitHubSyncSeam(options: GitHubSyncSeamOptions) {
  let health: GitHubSyncHealth | undefined
  let generation = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const listeners = new Set<() => void>()
  const publish = (next: GitHubSyncHealth | undefined) => { health = next; for (const listener of listeners) listener() }
  /** A failed request keeps the last health: its age still turns the row stale on the card's clock. */
  const read = async () => {
    if (disposed || !options.http) return
    const revision = ++generation
    try {
      const response = await options.http("/api/github/sync", { credentials: "same-origin" })
      const body: unknown = await response.json().catch(() => undefined)
      if (disposed || revision !== generation) return
      const parsed = GitHubSyncHealthSchema.safeParse(body)
      if (response.ok && parsed.success) publish(parsed.data)
      else if (response.status === 404 || response.status === 503) publish(undefined)
    } catch { /* unreachable: keep the last health */ }
  }
  const poll = () => {
    timer = setTimeout(() => {
      timer = undefined
      if (!disposed && listeners.size) void read().finally(() => { if (!disposed && listeners.size && timer === undefined) poll() })
    }, options.pollMs ?? 10_000)
  }
  const snapshots: GitHubSyncSnapshots = {
    get: () => health,
    subscribe: listener => {
      listeners.add(listener)
      if (listeners.size === 1 && options.http && !disposed) { void read(); poll() }
      return () => {
        listeners.delete(listener)
        if (!listeners.size && timer !== undefined) { clearTimeout(timer); timer = undefined }
      }
    }
  }
  /**
   * `github.retry` on a host that serves the sync: every followed `main` is due now, and the row re-reads. Undefined
   * when this host serves no sync, so the caller takes its other door.
   */
  const retry = async (): Promise<string | { readonly value: string } | undefined> => {
    if (disposed || !options.http || health === undefined) return undefined
    try {
      const response = await options.http("/api/github/sync", { method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUuid() } })
      if (response.status !== 202) return "Sync retry failed"
      void read()
      return { value: "Sync requested" }
    } catch { return "Sync retry failed" }
  }
  const dispose = () => {
    disposed = true; ++generation
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined; listeners.clear()
  }
  return { snapshots, read, retry, dispose }
}
export type GitHubSyncSeam = ReturnType<typeof createGitHubSyncSeam>
