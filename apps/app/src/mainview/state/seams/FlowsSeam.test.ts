import { expect, test } from "bun:test"
import { createFlowsSeam } from "./FlowsSeam"

const todo = { name: "todo", system: false, source: { builtin: true as const }, versions: [] }
const merge = { name: "merge", system: true, source: { builtin: true as const }, versions: [] }

test("named system cards publish without entering the repository list and survive refresh", async () => {
  const seam = createFlowsSeam({ http: async path => Response.json(path === "/api/flows" ? [todo] : merge) })
  expect(await seam.read("merge")).toEqual([todo, merge])
  expect(seam.snapshots.get().flows).toEqual([todo, merge])
  expect(await seam.read()).toEqual([todo])
  expect(seam.snapshots.get().flows).toEqual([todo, merge])
  seam.dispose()
})

test("late named response cannot replace a newer list or publish after disposal", async () => {
  for (const dispose of [false, true]) {
    let answer!: (response: Response) => void
    const pending = new Promise<Response>(resolve => { answer = resolve })
    const seam = createFlowsSeam({ http: async path => path === "/api/flows" ? Response.json([todo]) : pending })
    await seam.read()
    const named = seam.read("merge")
    // Let the named HTTP read start before advancing the catalog generation.
    await new Promise(resolve => setTimeout(resolve, 0))
    if (dispose) seam.dispose()
    else await seam.read()
    answer(Response.json(merge))
    expect(await named).toBeUndefined()
    expect(seam.snapshots.get().flows).toEqual([todo])
    seam.dispose()
  }
})

test("unknown and mismatched named flows do not enter the mounted catalog", async () => {
  for (const response of [() => Response.json({}, { status: 404 }), () => Response.json(merge)]) {
    const seam = createFlowsSeam({ http: async path => path === "/api/flows" ? Response.json([todo]) : response() })
    expect(await seam.read("missing")).toEqual([todo])
    expect(seam.snapshots.get().flows).toEqual([todo])
    seam.dispose()
  }
})

test("restored named-card subscription resolves the system endpoint again on live hints", async () => {
  const reads: string[] = []
  let refresh!: () => void
  let nextPublish!: () => void
  const seam = createFlowsSeam({
    http: async path => { reads.push(path); return Response.json(path === "/api/flows" ? [todo] : merge) },
    live: { subscribe: (_topic, listener) => { refresh = listener; return () => {} } }
  })
  let published = new Promise<void>(resolve => { nextPublish = resolve })
  const unsubscribe = seam.snapshots.subscribe(() => nextPublish(), "merge")
  await published
  expect(seam.snapshots.get().flows).toEqual([todo, merge])
  expect(reads).toEqual(["/api/flows", "/api/flows/merge"])
  published = new Promise<void>(resolve => { nextPublish = resolve })
  refresh()
  await published
  expect(reads).toEqual(["/api/flows", "/api/flows/merge", "/api/flows", "/api/flows/merge"])
  expect(seam.snapshots.get().flows).toEqual([todo, merge])
  unsubscribe()
  seam.dispose()
})
