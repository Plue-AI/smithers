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
    await waitFor(() => typeof resolve === "function")
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


test("a Home poll waits for a held menu write and cannot replace its committed state", async () => {
  let saved: Record<string, unknown> = { home: { filter: "queued", menu: null }, last_seen_seq: 12 }
  let releaseWrite!: () => void
  let writing = false, reads = 0
  const errors: unknown[] = []
  const seam = createHomeViewSeam({ owner: () => "Ben", subscribeOwner: () => () => {}, report: error => errors.push(error),
    http: async (_path, init) => {
      if (init?.method === "PUT") {
        writing = true
        await new Promise<void>(resolve => { releaseWrite = resolve })
        saved = JSON.parse(init.body as string)
      } else reads++
      return Response.json(saved)
    } })
  try {
    await seam.read()
    seam.onView({ menu: 3 })
    await waitFor(() => writing)
    const beforePoll = reads
    const poll = seam.read()
    await Bun.sleep(20)
    expect(reads).toBe(beforePoll)
    expect(seam.get().menu).toBeUndefined()
    releaseWrite()
    await poll
    expect(reads).toBe(beforePoll + 1)
    expect(seam.get()).toMatchObject({ filter: "queued", menu: 3, last_seen_seq: 12 })
    expect(saved).toEqual({ home: { filter: "queued", menu: 3 }, last_seen_seq: 12 })
    expect(errors).toEqual([])
  } finally { releaseWrite?.(); seam.dispose() }
})


test("a visible Home advances the new member's look after an account change", async () => {
  const { fixtures } = await import("@smthrs/rpc/fixtures/Home")
  let owner = "Ben", changed = () => {}
  const views: Record<string, Record<string, unknown>> = { Ben: { last_seen_seq: 25 }, Alice: { last_seen_seq: 0 } }
  const writes: unknown[] = []
  const seam = createHomeViewSeam({ owner: () => owner, subscribeOwner: notify => { changed = notify; return () => {} }, report: error => { throw error },
    live: { subscribe: () => () => {}, getSnapshot: () => ({ topic: "home", data: { ...fixtures.fresh.model, merge_history: [{ n: 8, seq: 19 }] } }) },
    http: async (_path, init) => {
      if (init?.method === "PUT") { views[owner] = JSON.parse(init.body as string); writes.push({ owner, body: views[owner] }) }
      return Response.json(views[owner])
    } })
  const stop = seam.subscribe(() => {})
  try {
    await waitFor(() => seam.get().last_seen_seq === 25)
    seam.onView({ on_screen: true })
    owner = "Alice"; changed()
    await waitFor(() => seam.get().last_seen_seq === 0)
    expect(seam.get().on_screen).toBe(true)
    await Bun.sleep(1900)
    expect(writes).toEqual([])
    await waitFor(() => writes.length === 1, 1000)
    expect(writes).toEqual([{ owner: "Alice", body: { last_seen_seq: 19, home: {} } }])
    expect(views.Ben).toEqual({ last_seen_seq: 25 })
  } finally { stop(); seam.dispose() }
})
