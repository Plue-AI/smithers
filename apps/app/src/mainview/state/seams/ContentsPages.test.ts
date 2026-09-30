import { describe, expect, test } from "bun:test"
import { MAX_CONTENTS_ENTRIES, readContentsPages } from "./ContentsPages"
const COMMIT = "a".repeat(40)

describe("public contents pages", () => {
  test("refuses a directory above the card cap instead of showing a partial listing", async () => {
    const seen: string[] = []
    const result = await readContentsPages(async (url) => {
      seen.push(url)
      const page = seen.length
      return new Response(JSON.stringify(Array.from({ length: 1000 }, (_, index) => ({ name: `file-${page}-${index}`, type: "file" }))), {
        headers: { "X-Next-Cursor": `file-${page}-999`, "X-Contents-Commit": COMMIT }
      })
    }, "/api/repos/a/b/contents")
    expect(result).toEqual({ kind: "error", error: "Directory listing exceeds 10,000 entries." })
    expect(seen).toHaveLength(MAX_CONTENTS_ENTRIES / 1000 + 1)
  })

  test("refuses a repeated cursor", async () => {
    const result = await readContentsPages(async () => new Response("[{}]", { headers: { "X-Next-Cursor": "same", "X-Contents-Commit": COMMIT } }), "/api/repos/a/b/contents")
    expect(result).toEqual({ kind: "error", error: "Directory listing cursor did not advance." })
  })

  test("refuses a moving commit on a later page", async () => {
    let calls = 0
    const requests: string[] = []
    const result = await readContentsPages(async (url) => {
      requests.push(url)
      calls++
      return new Response("[{}]", { headers: {
        "X-Next-Cursor": `path-${calls}`,
        "X-Contents-Commit": calls === 1 ? COMMIT : "b".repeat(40)
      } })
    }, "/api/repos/a/b/contents?ref=main")
    expect(result).toEqual({ kind: "error", error: "Directory changed while listing." })
    expect(calls).toBe(2)
    expect(requests[1]).toBe(`/api/repos/a/b/contents?ref=${COMMIT}&after=path-1`)
  })

  test("returns a later-page HTTP failure without partial data", async () => {
    let calls = 0
    const result = await readContentsPages(async () => {
      calls++
      return calls === 1
        ? new Response("[{\"name\":\"first\"}]", { headers: { "X-Next-Cursor": "first", "X-Contents-Commit": COMMIT } })
        : new Response("{\"message\":\"unavailable\"}", { status: 503 })
    }, "/api/repos/a/b/contents")
    expect(calls).toBe(2)
    expect(result.kind).toBe("response")
    if (result.kind === "response") {
      expect(result.response.status).toBe(503)
      expect(result.body).toBeNull()
    }
  })
})

test.each([
  { length: 40, url: "/contents?ref=main&recursive=false", query: "recursive=false&" },
  { length: 64, url: "/contents?ref=main&recursive=false", query: "recursive=false&" },
  { length: 40, url: "/contents", query: "" },
  { length: 64, url: "/contents", query: "" }
])("aggregates pages pinned to $length characters from $url", async ({ length, url, query }) => {
  const revision = "A".repeat(length)
  const seen: string[] = []
  const last = Response.json([{ name: "second" }], { headers: { "X-Contents-Commit": revision } })
  const result = await readContentsPages(async url => {
    seen.push(url)
    return seen.length === 1 ? Response.json([{ name: "first" }], { headers: { "X-Next-Cursor": "a b/%&c", "X-Contents-Commit": revision } }) : last
  }, url)
  expect(seen).toEqual([url, `/contents?ref=${revision}&${query}after=a+b%2F%25%26c`])
  expect(result).toEqual({ kind: "response", response: last, body: [{ name: "first" }, { name: "second" }] })
  if (result.kind === "response") expect(result.response).toBe(last)
})

test.each([10_000, 10_001])("handles the exact entry boundary at %i rows", async count => {
  const rows = Array.from({ length: count }, (_, index) => ({ name: `file-${index}` }))
  const response = Response.json(rows)
  const result = await readContentsPages(async () => response, "/contents")
  if (count === 10_000) expect(result).toEqual({ kind: "response", response, body: rows })
  else expect(result).toEqual({ kind: "error", error: "Directory listing exceeds 10,000 entries." })
})

test.each([100, 101])("handles %i advertised pages without unbounded requests", async count => {
  let calls = 0
  const result = await readContentsPages(async () => {
    calls++
    return Response.json([{ name: `page-${calls}` }], { headers: {
      "X-Contents-Commit": COMMIT, ...(calls < count ? { "X-Next-Cursor": `cursor-${calls}` } : {})
    } })
  }, "/contents")
  expect(calls).toBe(100)
  if (count === 100) {
    expect(result.kind).toBe("response")
    if (result.kind === "response") expect(result.body).toEqual(Array.from({ length: 100 }, (_, index) => ({ name: `page-${index + 1}` })))
  } else expect(result).toEqual({ kind: "error", error: "Directory listing did not finish." })
})

test.each(["", "a".repeat(39), "g".repeat(40), "a".repeat(65)])("refuses an advertised next page without a valid revision: %s", async revision => {
  let calls = 0
  const result = await readContentsPages(async () => {
    calls++
    return Response.json([{ name: "first" }], { headers: { "X-Next-Cursor": "next", "X-Contents-Commit": revision } })
  }, "/contents")
  expect(result).toEqual({ kind: "error", error: "Directory listing has no revision." })
  expect(calls).toBe(1)
})

test("an empty page cannot advertise progress", async () => {
  expect(await readContentsPages(async () => Response.json([], { headers: { "X-Next-Cursor": "next", "X-Contents-Commit": COMMIT } }), "/contents"))
    .toEqual({ kind: "error", error: "Directory listing cursor did not advance." })
})

test.each(["null", "{}", "not-json"])("a later unreadable page (%s) cannot return partial entries", async body => {
  let calls = 0
  const result = await readContentsPages(async () => {
    calls++
    return calls === 1 ? Response.json([{ name: "first" }], { headers: { "X-Next-Cursor": "next", "X-Contents-Commit": COMMIT } }) : new Response(body)
  }, "/contents")
  expect(result).toEqual({ kind: "error", error: "Directory listing returned an invalid page." })
  expect(calls).toBe(2)
})

test("an initial file response stays intact without requiring directory revision headers", async () => {
  const body = { type: "file", name: "readme.md", content: "aGk=" }
  const response = Response.json(body)
  expect(await readContentsPages(async () => response, "/contents/readme.md")).toEqual({ kind: "response", response, body })
})
