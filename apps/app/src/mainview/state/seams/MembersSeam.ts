import { MembersCardSchema, type MembersCard } from "@smthrs/rpc/MembersCard"
import type { CardCommandInput } from "@smthrs/rpc/CardAction"
import type { LiveChannel } from "../../runtime/LiveChannel"
import { InstallErrorSchema, type InstallError } from "./InstallModel"
import { randomUuid } from "../../runtime/RandomUuid"

// T-ACC-02 owns the shared validator; replace this boundary validator when it is exported.
export const validMemberLogin = (login: string) => /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i.test(login)
export interface MembersSnapshot { readonly model?: MembersCard; readonly error?: InstallError }
export interface MembersSnapshots {
  readonly get: () => MembersSnapshot
  readonly subscribe: (listener: () => void) => () => void
}
export const membersUnavailable: InstallError = { class: "infra", code: "unavailable", message: "Members unavailable" }

/** External-store lifecycle owns reads; mounting a React component creates no domain effect. */
export function createMembersSeam(options: {
  readonly http?: (path: string, init?: RequestInit) => Promise<Response>
  readonly live?: Pick<LiveChannel, "subscribe" | "getSnapshot">
  /** Composition supplies this only after the required production providers and joint checks pass. */
  readonly ready?: boolean
}) {
  let snapshot: MembersSnapshot = {}
  let generation = 0
  let disposed = false
  let stop: (() => void) | undefined
  const listeners = new Set<() => void>()
  const publish = (next: MembersSnapshot) => { snapshot = next; for (const listener of listeners) listener() }
  const snapshots: MembersSnapshots = { get: () => snapshot, subscribe: listener => {
    listeners.add(listener); return () => { listeners.delete(listener) }
  } }
  const read = async () => {
    if (disposed) return membersUnavailable
    if (!options.ready || !options.http || !options.live) { publish({ error: membersUnavailable }); return membersUnavailable }
    const revision = ++generation
    try {
      const response = await options.http("/api/members", { credentials: "same-origin" })
      const body: unknown = await response.json()
      if (revision !== generation) return
      if (!response.ok) {
        const parsed = InstallErrorSchema.safeParse(body)
        const error = parsed.success ? parsed.data : membersUnavailable
        publish({ ...(error.class === "permission" || error.class === "never" ? {} : snapshot), error })
        return error
      }
      const parsed = MembersCardSchema.safeParse(body)
      if (!parsed.success) { publish({ ...snapshot, error: membersUnavailable }); return membersUnavailable }
      publish({ model: parsed.data })
    } catch {
      if (revision === generation) publish({ ...snapshot, error: membersUnavailable })
      return membersUnavailable
    }
  }
  const mutate = async <Tag extends "members.add" | "members.role" | "members.remove">(tag: Tag, input: CardCommandInput[Tag]) => {
    if (disposed) return membersUnavailable
    if (!options.ready || !options.http || !options.live) { publish({ error: membersUnavailable }); return membersUnavailable }
    if (!validMemberLogin(input.login)) return { class: "user", code: "invalid_login", message: "Enter a GitHub username" } as const
    if (tag === "members.role" && "role" in input && input.role === "owner") return { class: "permission", code: "owner_immutable", message: "Owner cannot be changed" } as const
    const path = tag === "members.add" ? "/api/members" : `/api/members/${encodeURIComponent(input.login)}`
    try {
      const response = await options.http(path, { credentials: "same-origin",
        method: tag === "members.add" ? "POST" : tag === "members.role" ? "PATCH" : "DELETE",
        headers: { "Content-Type": "application/json", "Idempotency-Key": randomUuid() },
        ...(tag === "members.remove" ? {} : { body: JSON.stringify(tag === "members.add" ? { login: input.login } : { role: "role" in input ? input.role : undefined }) }) })
      if (disposed) return
      if (!response.ok) {
        const parsed = InstallErrorSchema.safeParse(await response.json())
        if (disposed) return
        const error = parsed.success ? parsed.data : membersUnavailable
        if (error.class === "permission" || error.class === "never") ++generation
        publish({ ...(error.class === "permission" || error.class === "never" ? {} : snapshot), error }); return error
      }
      // Server-seeded roles and post-commit rows only; a mutation never appends optimistically.
      return await read()
    } catch { if (!disposed) publish({ ...snapshot, error: membersUnavailable }); return membersUnavailable }
  }
  const start = () => {
    if (disposed || stop) return
    if (!options.ready || !options.http || !options.live) { publish({ error: membersUnavailable }); return }
    stop = options.live.subscribe("members", () => { void read() })
    void read()
  }
  const dispose = () => { disposed = true; ++generation; stop?.(); stop = undefined; listeners.clear() }
  return { snapshots, start, read, mutate, dispose }
}
