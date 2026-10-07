import { expect, test } from "bun:test"
import { createHomeViewSeam } from "./HomeViewSeam"
import { waitFor } from "../TestFixtures"

test("Home filters persist through the member API without overwriting conversation preferences or queue", async () => {
  let saved: Record<string, unknown> = { scroll_anchor: "entry-8", last_seen_seq: 12, card_view: { todo: "maximized" }, toasts_hidden: true,
    home: { filter: "queued" }, queue: [{ prompt: "private" }] }
  const writes: unknown[] = [], errors: unknown[] = []
  const seam = createHomeViewSeam({ owner: () => "Ben", subscribeOwner: () => () => {}, report: error => errors.push(error),
    http: async (path, init) => {
      expect(path).toBe("/api/conversations/main/view-state")
      if (init?.method === "PUT") { saved = JSON.parse(init.body as string); writes.push(saved) }
      return Response.json(saved)
    } })
  const stop = seam.subscribe(() => {})
  try {
    await waitFor(() => seam.get().filter === "queued")
    seam.onView({ on_screen: true })
    expect(writes).toEqual([])
    seam.onView({ filter: "working" }); seam.onView({ filter: undefined })
    await waitFor(() => writes.length === 2)
    expect(writes).toEqual([
      { scroll_anchor: "entry-8", last_seen_seq: 12, card_view: { todo: "maximized" }, toasts_hidden: true, home: { filter: "working" } },
      { scroll_anchor: "entry-8", last_seen_seq: 12, card_view: { todo: "maximized" }, toasts_hidden: true, home: { filter: null } }
    ])
    expect(seam.get()).toEqual({ maximized: false, on_screen: true, filter: undefined, menu: undefined, last_seen_seq: 12 })
    expect(errors).toEqual([])
  } finally { stop(); seam.dispose() }
})

test("a changed account discards a delayed read and admits no old-account filter write", async () => {
  let owner: string | undefined = "Ben", changed = () => {}, resolve!: (value: Response) => void
  const errors: unknown[] = [], writes: unknown[] = []
  const seam = createHomeViewSeam({ owner: () => owner, subscribeOwner: notify => { changed = notify; return () => {} }, report: error => errors.push(error),
    http: async (_path, init) => {
      if (init?.method === "PUT") writes.push(init.body)
      if (owner === "Ben") return new Promise<Response>(done => { resolve = done })
      return Response.json({ home: { filter: "in_review" } })
    } })
  const stop = seam.subscribe(() => {})
  try {
    seam.onView({ filter: "queued" })
    owner = "Alice"; changed()
    resolve(Response.json({ home: { filter: "working" } }))
    await waitFor(() => seam.get().filter === "in_review")
    expect(writes).toEqual([])
    owner = undefined; changed()
    expect(seam.get()).toEqual({ maximized: false })
    expect(errors).toEqual([])
  } finally { stop(); seam.dispose() }
})

test("a refused write keeps the committed filter and reports failure", async () => {
  const errors: unknown[] = []
  const seam = createHomeViewSeam({ owner: () => "Ben", subscribeOwner: () => () => {}, report: error => errors.push(error),
    http: async (_path, init) => init?.method === "PUT" ? new Response("", { status: 403 }) : Response.json({ home: { filter: "queued" } }) })
  const stop = seam.subscribe(() => {})
  try {
    await waitFor(() => seam.get().filter === "queued")
    seam.onView({ filter: "working" })
    await waitFor(() => errors.length === 1)
    expect(seam.get().filter).toBe("queued")
    expect(errors[0]).toMatchObject({ _tag: "HomeViewFailure", sentence: "Home view: 403" })
  } finally { stop(); seam.dispose() }
})


test("Home menu persists with the filter, closes durably, and refuses invalid rows", async () => {
  let saved: Record<string, unknown> = { home: { filter: "queued", menu: 8 }, last_seen_seq: 12 }
  const writes: unknown[] = []
  const seam = createHomeViewSeam({ owner: () => "Ben", subscribeOwner: () => () => {}, report: error => { throw error },
    http: async (_path, init) => {
      if (init?.method === "PUT") { saved = JSON.parse(init.body as string); writes.push(saved) }
      return Response.json(saved)
    } })
  const stop = seam.subscribe(() => {})
  try {
    await waitFor(() => seam.get().menu === 8)
    seam.onView({ menu: 9 }); seam.onView({ menu: undefined })
    await waitFor(() => writes.length === 2)
    expect(writes).toEqual([
      { home: { filter: "queued", menu: 9 }, last_seen_seq: 12 },
      { home: { filter: "queued", menu: null }, last_seen_seq: 12 }
    ])
    expect(seam.get().menu).toBeUndefined()
    expect(seam.get().filter).toBe("queued")
    expect(() => seam.onView({ menu: -1 })).toThrow("Invalid Home menu")
  } finally { stop(); seam.dispose() }
})


test("invalid Home responses and menus carry a typed failure", async () => {
  const errors: unknown[] = []
  const seam = createHomeViewSeam({ owner: () => "Ben", subscribeOwner: () => () => {}, report: value => errors.push(value), http: async () => Response.json([]) })
  try {
    await seam.read()
    expect(errors).toEqual([expect.objectContaining({ _tag: "HomeViewFailure", sentence: "Invalid Home view" })])
    try { seam.onView({ menu: 0 }); throw new Error("accepted invalid menu") }
    catch (value) { expect(value).toMatchObject({ _tag: "HomeViewFailure", sentence: "Invalid Home menu" }) }
  } finally { seam.dispose() }
})

test("last look advances only after two seconds visible, cancels on hide, and preserves newer conversation look", async () => {
  const { fixtures } = await import("@smthrs/rpc/fixtures/Home")
  let saved: Record<string, unknown> = { last_seen_seq: 12, home: { filter: "queued" } }
  const writes: Record<string, unknown>[] = []
  const seam = createHomeViewSeam({ owner: () => "Ben", subscribeOwner: () => () => {}, report: error => { throw error },
    live: { subscribe: () => () => {}, getSnapshot: () => ({ topic: "home", data: { ...fixtures.fresh.model, merge_history: [{ n: 8, seq: 19 }] } }) },
    http: async (_path, init) => {
      if (init?.method === "PUT") { saved = JSON.parse(init.body as string); writes.push(saved) }
      return Response.json(saved)
    } })
  const stop = seam.subscribe(() => {})
  try {
    await waitFor(() => seam.get().last_seen_seq === 12)
    seam.onView({ on_screen: true })
    await Bun.sleep(1900)
    expect(writes).toEqual([])
    seam.onView({ on_screen: false })
    await Bun.sleep(150)
    expect(writes).toEqual([])
    seam.onView({ on_screen: true })
    await Bun.sleep(1900)
    expect(writes).toEqual([])
    await waitFor(() => writes.length === 1, 1000)
    expect(writes).toEqual([{ last_seen_seq: 19, home: { filter: "queued" } }])
    expect(seam.get().last_seen_seq).toBe(19)
    saved = { ...saved, last_seen_seq: 25 }
    seam.onView({ last_seen_seq: 20 })
    await waitFor(() => writes.length === 2)
    expect(seam.get().last_seen_seq).toBe(25)
  } finally { stop(); seam.dispose() }
})
