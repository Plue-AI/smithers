import { expect, test } from "bun:test"
import { FLOW_PAGE_CAP, flowPageRequest, TOO_MANY_FLOWS, walkFlowPages, type FlowPageAnswer } from "./FlowPages"

/** A transport double: answers scripted pages by cursor and records every cursor asked. */
const pages = (script: Readonly<Record<string, unknown>>) => {
  const asked: Array<string | undefined> = []
  const read = async (cursor: string | undefined): Promise<FlowPageAnswer<string>> => {
    asked.push(cursor)
    return { ok: true, page: script[cursor ?? ""] }
  }
  return { asked, read }
}

const flow = (flowId: string) => ({ flowId })

test("the first page asks without a cursor and later pages carry it", () => {
  expect(flowPageRequest(undefined)).toEqual({ _tag: "flows" })
  expect(flowPageRequest("c1")).toEqual({ _tag: "flows", cursor: "c1" })
})

test("walks every page until the workspace names no next cursor", async () => {
  const { asked, read } = pages({
    "": { items: [flow("a"), flow("b")], nextCursor: "c1" },
    c1: { items: [flow("c")], nextCursor: "c2" },
    c2: { items: [flow("d")] }
  })
  expect(await walkFlowPages(read, TOO_MANY_FLOWS)).toEqual({ ok: true, items: [flow("a"), flow("b"), flow("c"), flow("d")] })
  expect(asked).toEqual([undefined, "c1", "c2"])
})

test("stops on an empty page, an empty cursor, or a repeated cursor", async () => {
  const empty = pages({ "": { items: [flow("a")], nextCursor: "c1" }, c1: { items: [], nextCursor: "c2" } })
  expect(await walkFlowPages(empty.read, TOO_MANY_FLOWS)).toEqual({ ok: true, items: [flow("a")] })
  expect(empty.asked).toEqual([undefined, "c1"])

  const blank = pages({ "": { items: [flow("a")], nextCursor: "" } })
  expect(await walkFlowPages(blank.read, TOO_MANY_FLOWS)).toEqual({ ok: true, items: [flow("a")] })
  expect(blank.asked).toEqual([undefined])

  const loop = pages({ "": { items: [flow("a")], nextCursor: "c1" }, c1: { items: [flow("b")], nextCursor: "c1" } })
  expect(await walkFlowPages(loop.read, TOO_MANY_FLOWS)).toEqual({ ok: true, items: [flow("a"), flow("b")] })
  expect(loop.asked).toEqual([undefined, "c1"])
})

test("a malformed page reads as empty and drops non-record items", async () => {
  const { read } = pages({ "": { items: [flow("a"), "junk", null, [1]], nextCursor: "c1" }, c1: "not a page" })
  expect(await walkFlowPages(read, TOO_MANY_FLOWS)).toEqual({ ok: true, items: [flow("a")] })
})

test("the transport's refusal comes back unchanged and ends the walk", async () => {
  let reads = 0
  const read = async (cursor: string | undefined): Promise<FlowPageAnswer<{ code: string }>> => {
    reads++
    return cursor === undefined ? { ok: true, page: { items: [flow("a")], nextCursor: "c1" } } : { ok: false, refusal: { code: "down" } }
  }
  expect(await walkFlowPages(read, { code: "too-many" })).toEqual({ ok: false, refusal: { code: "down" } })
  expect(reads).toBe(2)
})

test("refuses past the page cap and reads exactly the cap", async () => {
  let reads = 0
  const read = async (): Promise<FlowPageAnswer<string>> => {
    reads++
    return { ok: true, page: { items: [flow(`f${reads}`)], nextCursor: `c${reads}` } }
  }
  expect(await walkFlowPages(read, TOO_MANY_FLOWS)).toEqual({ ok: false, refusal: TOO_MANY_FLOWS })
  expect(reads).toBe(FLOW_PAGE_CAP)
})

test("stops after the page on which the caller's request went stale", async () => {
  let live = true
  const { asked, read } = pages({
    "": { items: [flow("a")], nextCursor: "c1" },
    c1: { items: [flow("b")], nextCursor: "c2" },
    c2: { items: [flow("c")] }
  })
  const walked = walkFlowPages(async (cursor) => {
    const answer = await read(cursor)
    if (cursor === "c1") live = false
    return answer
  }, TOO_MANY_FLOWS, () => live)
  expect(await walked).toEqual({ ok: true, items: [flow("a"), flow("b")] })
  expect(asked).toEqual([undefined, "c1"])
})
