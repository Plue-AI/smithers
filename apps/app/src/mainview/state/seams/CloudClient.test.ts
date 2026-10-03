import { describe, expect, test } from "bun:test"
import { NOTHING_ANSWERED } from "@smthrs/rpc/RefusalCopy"
import { cloudFailure, createCloudClient } from "./CloudClient"

describe("cloud transport", () => {
  test("uses the injected transport and preserves response headers for pagination", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const client = createCloudClient({
      baseUrl: "https://app.example",
      http: async (path, init) => {
        calls.push({ path, init })
        return Response.json({ items: [1] }, { headers: { link: "next" }, status: 201 })
      }
    })
    const read = await client.get("/repos")
    expect(read).toMatchObject({ body: { items: [1] }, status: 201 })
    if ("error" in read) throw new Error(read.error)
    expect(read.response.headers.get("link")).toBe("next")
    await client.send("POST", "/repos", { name: "sample" })
    await client.send("POST", "/todos", { title: "x" }, "the TODO", undefined, { "idempotency-key": "k-1" })
    await client.send("DELETE", "/repos/1")
    expect(calls).toEqual([
      { path: "https://app.example/api/repos", init: undefined },
      {
        path: "https://app.example/api/repos",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{\"name\":\"sample\"}"
        }
      },
      {
        path: "https://app.example/api/todos",
        init: {
          method: "POST",
          headers: { "content-type": "application/json", "idempotency-key": "k-1" },
          body: "{\"title\":\"x\"}"
        }
      },
      { path: "https://app.example/api/repos/1", init: { method: "DELETE" } }
    ])
  })

  test("preserves a refusal's code, status, and retry instruction together; its words reach the person only when they can act on them", async () => {
    const starting = await cloudFailure(
      Response.json({ code: "guest_not_ready", message: "Guest is starting" }, {
        status: 503,
        headers: { "retry-after": "3" }
      }),
      "fallback"
    )
    /* A wait-class refusal: the person reads the context and the verdict, never the server's words. */
    expect(starting.error).not.toContain("Guest is starting")
    expect(
      await cloudFailure(
        Response.json({ code: "guest_not_ready", message: "Guest is starting" }, {
          status: 503,
          headers: { "retry-after": "3" }
        }),
        "fallback"
      )
    ).toEqual({
      error: "fallback. Not ready yet — nothing is wrong.",
      code: "guest_not_ready",
      status: 503,
      retryAfterSeconds: 3,
      /* …and the verdict, which none of the four facts above could supply. */
      refusal: {
        code: "guest_not_ready",
        rawCode: "guest_not_ready",
        fault: "wait",
        message: "fallback",
        retryAfter: 3,
        status: 503,
        origin: "plue"
      }
    })
    expect(await cloudFailure(Response.json({ error: { message: "x".repeat(300) } }, { status: 409 }), "fallback"))
      .toEqual({
        error: "x".repeat(240),
        code: null,
        status: 409,
        retryAfterSeconds: null,
        refusal: {
          code: null,
          rawCode: null,
          fault: "user",
          message: "x".repeat(240),
          retryAfter: null,
          status: 409,
          origin: "worker"
        }
      })
  })

  test("a full fleet is classified as infra, and an account at its own cap is not", async () => {
    // The Worker passes plue's `code` and `retry_after` through but not its
    // `fault` (apps/server proxies.ts), so both of these arrive with the code
    // and nothing else — and the vendored registry is what keeps them apart.
    const full = await cloudFailure(
      Response.json({ code: "no_capacity", retry_after: 30 }, { status: 503 }),
      "fallback"
    )
    expect(full.refusal.fault).toBe("infra")
    expect(full.refusal.retryAfter).toBe(30)
    const capped = await cloudFailure(Response.json({ code: "quota_exceeded" }, { status: 429 }), "fallback")
    expect(capped.refusal.fault).toBe("user")
  })

  test("distinguishes network failures from HTTP errors without inventing status zero", async () => {
    const client = createCloudClient({
      baseUrl: "",
      http: async () => {
        throw new Error("offline secret-socket-detail")
      }
    })
    /* The thrown text never becomes the sentence a person reads. */
    expect(JSON.stringify(await client.get("/repos"))).not.toContain("secret-socket-detail")
    expect(await client.get("/repos")).toEqual({
      error: `Could not reach Smithers Cloud. ${NOTHING_ANSWERED}`,
      status: null,
      code: null,
      retryAfterSeconds: null,
      /*
       * Nothing answered, so nothing judged the request — which makes it
       * infra-class by construction and certainly not the user's fault. This
       * is the case that used to reach the chat model as a bare string.
       */
      refusal: {
        code: null,
        rawCode: null,
        fault: "infra",
        message: "Could not reach Smithers Cloud.",
        retryAfter: null,
        status: null,
        origin: "client"
      }
    })
    expect(await client.send("POST", "/repos")).toEqual(await client.get("/repos"))
  })

  test("keeps malformed responses out of user-facing messages and supports empty successes", async () => {
    const client = createCloudClient({
      baseUrl: "",
      http: async () => new Response("<html>broken</html>", { status: 502 })
    })
    expect(await client.get("/repos?page=2")).toMatchObject({
      error: "Reading from Smithers Cloud failed (502). Something Smithers depends on failed. Not your doing.",
      status: 502
    })
    expect(await client.get("/repos?page=2", "your repositories")).toMatchObject({
      error: "Reading your repositories failed (502). Something Smithers depends on failed. Not your doing."
    })
    expect(await client.send("POST", "/user/repos", {}, "repository creation")).toMatchObject({
      error: "The request for repository creation failed (502). Something Smithers depends on failed. Not your doing."
    })
    expect(await client.send("POST", "/repos")).toMatchObject({ error: "The request to Smithers Cloud failed (502). Something Smithers depends on failed. Not your doing." })
    const empty = createCloudClient({ baseUrl: "", http: async () => new Response(null, { status: 204 }) })
    expect(await empty.send("DELETE", "/repos/1")).toMatchObject({ body: null, status: 204 })
  })
})


for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
  test(`${method} cancels its pending transport with the caller signal`, async () => {
    const started = Promise.withResolvers<void>()
    const controller = new AbortController()
    let aborted = false
    const client = createCloudClient({ baseUrl: "", http: (_path, init) => {
      started.resolve()
      return new Promise<Response>((resolve, reject) => {
        const timeout = setTimeout(() => resolve(Response.json({ saved: true })), 100)
        init?.signal?.addEventListener("abort", () => {
          aborted = true
          clearTimeout(timeout)
          reject(init.signal?.reason)
        }, { once: true })
      })
    } })
    const pending = client.send(method, "/repos/will/flows", method === "DELETE" ? undefined : { name: "test" }, undefined, controller.signal)
    await started.promise
    controller.abort(new DOMException("Cancelled", "AbortError"))
    const result = await pending
    expect(aborted).toBe(true)
    expect(result).toMatchObject({ refusal: { fault: "infra" } })
  })
}
