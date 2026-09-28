/**
 * Request admission for a Worker route: the bearer check and the capped JSON
 * read `turnResponse` applies before any model call, driven directly.
 */
import { describe, expect, it } from "@effect/vitest"
import { authorized, MAX_BODY_BYTES, readJson } from "../src/http.ts"

const url = "https://app.test/api/turn"

const post = (body: BodyInit | null, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Request(url, { method: "POST", body, headers, ...(body instanceof ReadableStream ? { duplex: "half" } : {}) })

/** A body that declares no length and arrives in `chunks` pieces of `size` bytes. */
const chunked = (chunks: number, size: number): ReadableStream<Uint8Array> => {
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent === chunks) return controller.close()
      sent += 1
      controller.enqueue(new Uint8Array(size).fill(0x20))
    }
  })
}

describe("readJson", () => {
  it("decodes a JSON body", async () => {
    expect(await readJson(post(JSON.stringify({ flow: "chat" })))).toEqual({ ok: true, value: { flow: "chat" } })
  })

  it("accepts media type parameters and any case", async () => {
    const request = post("{}", { "content-type": "Application/JSON; charset=utf-8" })
    expect(await readJson(request)).toEqual({ ok: true, value: {} })
  })

  it("refuses a media type other than application/json, or none", async () => {
    expect(await readJson(post("{}", { "content-type": "text/plain" }))).toMatchObject({ ok: false, status: 415 })
    expect(await readJson(post("{}", {}))).toMatchObject({ ok: false, status: 415 })
  })

  it("refuses a declared length past the cap before reading", async () => {
    const request = post("{}", { "content-type": "application/json", "content-length": String(MAX_BODY_BYTES + 1) })
    expect(await readJson(request)).toMatchObject({ ok: false, status: 413 })
    expect(request.bodyUsed).toBe(false)
  })

  it("refuses an undeclared body once the running total passes the cap", async () => {
    expect(await readJson(post(chunked(3, 32)), 64)).toMatchObject({ ok: false, status: 413 })
    expect(await readJson(post("x".repeat(MAX_BODY_BYTES + 1)))).toMatchObject({ ok: false, status: 413 })
  })

  it("reads a multi-chunk body under the cap", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("{\"a\":"))
        controller.enqueue(new TextEncoder().encode("1}"))
        controller.close()
      }
    })
    expect(await readJson(post(body))).toEqual({ ok: true, value: { a: 1 } })
  })

  it("refuses a missing, unreadable, or non-JSON body", async () => {
    expect(await readJson(post(null))).toMatchObject({ ok: false, status: 400, message: "Expected a JSON body." })
    const broken = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error("connection reset"))
      }
    })
    expect(await readJson(post(broken))).toMatchObject({ ok: false, status: 400 })
    expect(await readJson(post("not json"))).toMatchObject({ ok: false, status: 400 })
  })
})

describe("authorized", () => {
  const bearer = (value?: string) => new Request(url, value === undefined ? {} : { headers: { authorization: value } })

  it("admits only the exact bearer token", () => {
    expect(authorized(bearer("Bearer s3cret"), "s3cret")).toBe(true)
    expect(authorized(bearer(), "s3cret")).toBe(false)
    expect(authorized(bearer("s3cret"), "s3cret")).toBe(false)
    expect(authorized(bearer("Bearer s3cre"), "s3cret")).toBe(false)
    expect(authorized(bearer("Bearer s3creT"), "s3cret")).toBe(false)
  })

  it("fails closed without a token unless local development opts in", () => {
    expect(authorized(bearer("Bearer anything"), undefined)).toBe(false)
    expect(authorized(bearer(), "")).toBe(false)
    expect(authorized(bearer(), undefined, "true")).toBe(false)
    expect(authorized(bearer(), undefined, "1")).toBe(true)
    expect(authorized(bearer(), "s3cret", "1")).toBe(false)
  })
})
