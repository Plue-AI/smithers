import { Data } from "effect"
import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import type { HomeViewProps } from "@smthrs/rpc/HomeCard"
import { HomeCardSchema } from "@smthrs/rpc/HomeCard"
import type { LiveTopics } from "../useTopic"
import { TodoStateSchema } from "@smthrs/rpc/CardPrimitives"
import { randomUuid } from "../../runtime/RandomUuid"
import type { SeamFetch } from "./SeamContext"

export class HomeViewFailure extends Data.TaggedError("HomeViewFailure")<{ readonly sentence: "Invalid Home view" | "Invalid Home menu" | `Home view: ${number}` }> {
  override get message() { return this.sentence }
}

/** Private main-conversation preferences; shared Home facts never contain these. */
export function createHomeViewSeam(options: {
  readonly live?: LiveTopics
  readonly serializeView?: (work: () => Promise<void>) => Promise<void>
  readonly http: SeamFetch
  readonly owner: () => string | undefined
  readonly subscribeOwner: (notify: () => void) => () => void
  readonly report: (error: unknown) => void
}) {
  type Row = { id: string; view: HomeViewProps["view"] }
  const rows = createCollection(localOnlyCollectionOptions<Row, string>({
    id: `home-view-${randomUuid()}`, getKey: row => row.id,
    initialData: [{ id: "main", view: { maximized: false } }]
  }))
  rows.preload()
  let disposed = false
  let generation = 0
  let readGeneration = 0
  let owner = options.owner()
  let pending = Promise.resolve()
  let timer: ReturnType<typeof setTimeout> | undefined
  let lookTimer: ReturnType<typeof setTimeout> | undefined
  let stopHome: (() => void) | undefined
  let mergeSequence = 0
  const cancelLook = () => { if (lookTimer !== undefined) clearTimeout(lookTimer); lookTimer = undefined }
  const scheduleLook = () => {
    if (disposed || !get().on_screen || mergeSequence <= (get().last_seen_seq ?? 0) || lookTimer !== undefined) return
    const seen = mergeSequence
    lookTimer = setTimeout(() => {
      lookTimer = undefined
      if (!disposed && get().on_screen) onView({ last_seen_seq: seen })
    }, 2000)
  }
  const observeHome = () => {
    const parsed = HomeCardSchema.safeParse(options.live?.getSnapshot("home")?.data)
    if (!parsed.success || parsed.data.merge_history === undefined) return
    mergeSequence = Math.max(0, ...parsed.data.merge_history.map(merge => merge.seq))
    scheduleLook()
  }
  let stopOwner: (() => void) | undefined
  const listeners = new Set<() => void>()
  const get = () => rows.get("main")!.view
  const publish = (view: HomeViewProps["view"]) => {
    rows.update("main", draft => { draft.view = view })
    for (const notify of listeners) notify()
  }
  const valid = (revision: number, principal: string | undefined) => !disposed && revision === generation && principal !== undefined && principal === options.owner()
  const request = async (init?: RequestInit): Promise<Record<string, unknown>> => {
    const response = await options.http("/api/conversations/main/view-state", { credentials: "same-origin", ...init })
    if (!response.ok) throw new HomeViewFailure({ sentence: `Home view: ${response.status}` })
    const body: unknown = await response.json()
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new HomeViewFailure({ sentence: "Invalid Home view" })
    return body as Record<string, unknown>
  }
  const apply = (body: Record<string, unknown>) => {
    const home = body.home && typeof body.home === "object" ? body.home as Record<string, unknown> : {}
    const parsed = TodoStateSchema.safeParse(home.filter)
    const menu = typeof home.menu === "number" && Number.isSafeInteger(home.menu) && home.menu > 0 ? home.menu : undefined
    const lastSeen = typeof body.last_seen_seq === "number" && Number.isSafeInteger(body.last_seen_seq) && body.last_seen_seq >= 0 ? body.last_seen_seq : 0
    publish({ ...get(), filter: parsed.success ? parsed.data : undefined, menu, last_seen_seq: lastSeen })
    scheduleLook()
  }
  const read = async () => {
    const revision = generation, principal = owner, reading = ++readGeneration
    if (!valid(revision, principal)) return
    try { const body = await request(); if (valid(revision, principal) && reading === readGeneration) apply(body) }
    catch (error) { if (valid(revision, principal)) options.report(error) }
  }
  const poll = () => {
    timer = setTimeout(() => {
      timer = undefined
      void read().finally(() => { if (!disposed && listeners.size) poll() })
    }, 2000)
  }
  const changeOwner = () => {
    const next = options.owner()
    if (next === owner) return
    cancelLook()
    owner = next; ++generation; ++readGeneration
    pending = Promise.resolve()
    publish({ maximized: false })
    void read()
  }
  const subscribe = (notify: () => void) => {
    listeners.add(notify)
    if (listeners.size === 1 && !disposed) {
      stopOwner = options.subscribeOwner(changeOwner)
      stopHome = options.live?.subscribe("home", observeHome)
      observeHome(); changeOwner(); void read(); poll()
    }
    return () => {
      listeners.delete(notify)
      if (!listeners.size) {
        cancelLook(); stopHome?.(); stopHome = undefined
        ++generation; stopOwner?.(); stopOwner = undefined
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
      }
    }
  }
  const onView: HomeViewProps["onView"] = patch => {
    // Visibility is tab-local. Persist preferences only after the server commits them.
    if (patch.on_screen !== undefined) {
      publish({ ...get(), on_screen: patch.on_screen })
      if (patch.on_screen) scheduleLook(); else cancelLook()
    }
    if (!("filter" in patch) && !("menu" in patch) && patch.last_seen_seq === undefined) return
    if (patch.last_seen_seq !== undefined && (!Number.isSafeInteger(patch.last_seen_seq) || patch.last_seen_seq < 0)) throw new Error("Invalid Home last look")
    const changes: Record<string, unknown> = {}
    if ("filter" in patch) changes.filter = patch.filter === undefined ? null : TodoStateSchema.parse(patch.filter)
    if ("menu" in patch) {
      if (patch.menu !== undefined && (!Number.isSafeInteger(patch.menu) || patch.menu <= 0)) throw new HomeViewFailure({ sentence: "Invalid Home menu" })
      changes.menu = patch.menu ?? null
    }
    const revision = generation, principal = owner
    pending = pending.then(() => (options.serializeView ?? (work => work()))(async () => {
      if (!valid(revision, principal)) return
      const body = await request()
      if (!valid(revision, principal)) return
      // Queued prompts are read-only; the API refuses a browser-supplied queue.
      const { queue: _queue, instructions: _instructions, ...saved } = body
      const home = saved.home && typeof saved.home === "object" ? saved.home as Record<string, unknown> : {}
      ++readGeneration
      const result = await request({ method: "PUT", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...saved, ...(patch.last_seen_seq === undefined ? {} : { last_seen_seq: Math.max(typeof saved.last_seen_seq === "number" ? saved.last_seen_seq : 0, patch.last_seen_seq) }), home: { ...home, ...changes } }) })
      if (valid(revision, principal)) apply(result)
    })).catch(error => { if (valid(revision, principal)) options.report(error) })
  }
  const dispose = () => {
    disposed = true; ++generation; stopOwner?.(); stopHome?.(); cancelLook()
    if (timer !== undefined) clearTimeout(timer)
    listeners.clear(); rows.cleanup()
  }
  return { get, subscribe, onView, read, dispose }
}
export type HomeViewSeam = ReturnType<typeof createHomeViewSeam>
