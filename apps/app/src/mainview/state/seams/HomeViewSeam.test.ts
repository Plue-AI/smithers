import { expect, test } from "bun:test"
import { createHomeViewSeam } from "./HomeViewSeam"
import { waitFor } from "../TestFixtures"

test("reload disposal leaves a stable empty snapshot and ignores late view changes and reads", async () => {
  let resolve!: (response: Response) => void
  let requests = 0, notifications = 0, owners = 0
  const seam = createHomeViewSeam({ owner: () => "Ben", subscribeOwner: () => { owners++; return () => { owners-- } },
    report: error => { throw error }, http: () => { requests++; return new Promise(done => { resolve = done }) } })
  const stop = seam.subscribe(() => { notifications++ })
  expect(owners).toBe(1)
  seam.dispose()
  const empty = seam.get()
  expect(empty).toEqual({ maximized: false })
  expect(seam.get()).toBe(empty)
  seam.onView({ on_screen: true, filter: "working" })
  const stopLate = seam.subscribe(() => { notifications++ })
  resolve(Response.json({ home: { filter: "queued" } }))
  await Promise.resolve(); await Promise.resolve()
  expect(seam.get()).toBe(empty)
  expect(requests).toBe(1)
  expect(notifications).toBe(0)
  expect(owners).toBe(0)
  stopLate(); stop(); seam.dispose()
  expect(owners).toBe(0)
})

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
    expect(seam.get()).toEqual({ maximized: false, on_screen: true, filter: undefined, menu: undefined })
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


test("a disposed Home seam remains readable while the old card unmounts", async () => {
  const requests: string[] = []
  const seam = createHomeViewSeam({ owner: () => "Ben", subscribeOwner: () => () => {}, report: error => { throw error },
    http: async path => { requests.push(path); return Response.json({ home: { filter: "queued" } }) } })
  const stop = seam.subscribe(() => {})
  await waitFor(() => seam.get().filter === "queued")
  stop(); seam.dispose()
  expect(seam.get()).toEqual({ maximized: false })
  const before = requests.length
  seam.onView({ on_screen: true, filter: "working" })
  await seam.read()
  expect(seam.get()).toEqual({ maximized: false })
  expect(requests).toHaveLength(before)
})
