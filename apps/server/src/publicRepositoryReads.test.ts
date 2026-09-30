import { describe, expect, test } from "bun:test"
import * as Effect from "effect/Effect"
import { transportLayer } from "./Http"
import type { FetchImplementation } from "./Http"
import { cloudReadPath, isPublicRepositoryRead, readPublicRepository } from "./publicRepositoryReads"

/** A reader over one fake Cloud backend; every request it sent is recorded. */
const reader = (answer: (request: Request) => Response | Promise<Response>) => {
  const seen: Array<Request> = []
  const fetchImpl: FetchImplementation = async (input, init) => {
    const request = new Request(input, init)
    seen.push(request)
    return answer(request)
  }
  const read = (url: URL, base: string) =>
    Effect.runPromise(readPublicRepository(url, base).pipe(Effect.provide(transportLayer(fetchImpl))))
  return { read, seen }
}

describe("anonymous repository reads", () => {
  test("admits public document reads and excludes writes, account data, and workspace credentials", () => {
    for (const suffix of ["", "/home", "/contents/src/index.ts", "/topics", "/bookmarks", "/issues", "/issues/1/comments", "/changes", "/changes/count", "/changes/abc/diff"]) {
      expect(isPublicRepositoryRead("GET", `/api/repos/smithersai/smithers${suffix}`)).toBe(true)
    }
    for (const path of ["/api/repos/a/b/stargazers", "/api/user/repos", "/api/billing/balance", "/api/admin/errors", "/api/repos/a/b/workspaces", "/api/repos/a/b/workspaces/1/ssh", "/api/repos/a/b/gateway", "/api/repos/a/b/secrets", "/api/repos/a/../issues"]) {
      expect(isPublicRepositoryRead("GET", path)).toBe(false)
    }
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      expect(isPublicRepositoryRead(method, "/api/repos/a/b/issues")).toBe(false)
    }
  })

  test("checks public visibility on every read without forwarding credentials", async () => {
    let isPublic = true
    const { read, seen } = reader(() =>
      isPublic
        ? Response.json([{ name: "README.md", type: "file" }], { headers: { "cache-control": "public, max-age=300" } })
        : Response.json({ message: "repository not found" }, { status: 404 }))
    const url = new URL("https://app.test/api/repos/smithersai/smithers/contents?ref=main")
    const first = await read(url, "https://cloud.test")
    expect(await first.json()).toEqual([{ name: "README.md", type: "file" }])
    expect(first.headers.get("cache-control")).toBe("private, no-store")
    isPublic = false
    const second = await read(url, "https://cloud.test")
    expect(second.status).toBe(404)
    expect(await second.json()).toEqual({ message: "repository not found" })
    expect(second.headers.get("cache-control")).toBe("private, no-store")
    expect(seen).toHaveLength(2)
    for (const request of seen) {
      expect(request.url).toBe("https://cloud.test/api/repos/smithers-canary/smithers/contents?ref=main")
      expect(request.headers.has("authorization")).toBe(false)
      expect(request.headers.has("cookie")).toBe(false)
    }
  })

  test("a catalog read reaches the Smithers Cloud mirror with the same document path and query", async () => {
    const { read, seen } = reader((request) => Response.json({ name: "src", type: "dir", mirror: new URL(request.url).pathname }))
    const response = await read(new URL("https://app.test/api/repos/smithersai/smithers/contents/src?ref=main&recursive=1"), "https://cloud.test")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ name: "src", type: "dir", mirror: "/api/repos/smithers-canary/smithers/contents/src" })
    expect(seen.map((request) => request.url)).toEqual([
      "https://cloud.test/api/repos/smithers-canary/smithers/contents/src?ref=main&recursive=1"
    ])
    expect(seen[0]?.headers.has("authorization")).toBe(false)
    expect(seen[0]?.headers.has("cookie")).toBe(false)
  })

  test("forwards directory cursors and exposes the next page header", async () => {
    const { read, seen } = reader(() => Response.json([{ name: "README.md", type: "file" }], { headers: { "X-Next-Cursor": "README.md", "X-Contents-Commit": "a".repeat(40) } }))
    const response = await read(new URL("https://app.test/api/repos/smithersai/smithers/contents?after=apps%2Fcli"), "https://cloud.test")
    expect(seen[0]?.url).toBe("https://cloud.test/api/repos/smithers-canary/smithers/contents?after=apps%2Fcli")
    expect(response.headers.get("X-Next-Cursor")).toBe("README.md")
    expect(response.headers.get("X-Contents-Commit")).toBe("a".repeat(40))
  })

  test("the upstream request asks for a manual redirect and a 3xx answer is unavailable", async () => {
    // workerd rejects redirect: "error" before sending anything, which made
    // every production public read a 502; "manual" is the accepted mode.
    let cancelled = false
    const { read, seen } = reader(() => new Response(new ReadableStream({ cancel() { cancelled = true } }), {
      status: 302, headers: { location: "https://elsewhere.test/login" }
    }))
    const response = await read(new URL("https://app.test/api/repos/smithersai/smithers/contents/README.md"), "https://cloud.test")
    expect(seen[0]?.redirect).toBe("manual")
    expect(response.status).toBe(502)
    expect(response.headers.get("location")).toBeNull()
    expect(await response.json()).toEqual({ message: "Repository data is temporarily unavailable." })
    expect(cancelled).toBe(true)
  })

  test("an unreachable backend is the same honest 502, never a thrown error", async () => {
    const { read, seen } = reader(() => {
      throw new Error("offline")
    })
    const response = await read(new URL("https://app.test/api/repos/smithersai/smithers"), "https://cloud.test")
    expect(seen).toHaveLength(1)
    expect(response.status).toBe(502)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(await response.json()).toEqual({ message: "Repository data is temporarily unavailable." })
  })

  test("a repository outside the catalog is read under the name the browser asked for", async () => {
    const { read, seen } = reader(() => Response.json({ message: "repository not found" }, { status: 404 }))
    const response = await read(new URL("https://app.test/api/repos/example/other/issues?state=open"), "https://cloud.test")
    expect(response.status).toBe(404)
    expect(seen.map((request) => request.url)).toEqual(["https://cloud.test/api/repos/example/other/issues?state=open"])
    expect(cloudReadPath("/api/repos/example/other/issues")).toBe("/api/repos/example/other/issues")
    expect(cloudReadPath("/api/repos/smithersai/smithers-docs")).toBe("/api/repos/smithersai/smithers-docs")
    expect(cloudReadPath("/api/user/repos")).toBe("/api/user/repos")
  })

  test("a mixed-case catalog name still reaches the mirror", async () => {
    const { read, seen } = reader(() => Response.json({ full_name: "smithers-canary/smithers" }))
    const response = await read(new URL("https://app.test/api/repos/SmithersAI/Smithers/topics"), "https://cloud.test")
    expect(response.status).toBe(200)
    expect(seen.map((request) => request.url)).toEqual(["https://cloud.test/api/repos/smithers-canary/smithers/topics"])
    expect(cloudReadPath("/api/repos/SMITHERSAI/SMITHERS")).toBe("/api/repos/smithers-canary/smithers")
    expect(cloudReadPath("/api/repos/SmithersAI/Smithers/")).toBe("/api/repos/smithers-canary/smithers/")
  })

  test("preserves Vary and forbids storage even when the upstream answer is successful", async () => {
    for (const cacheControl of ["private", "no-store", "private, no-store", "public, max-age=300"]) {
      const { read } = reader(() =>
        Response.json({ name: "README.md" }, { headers: {
          "cache-control": cacheControl, vary: "Cookie, Accept", "set-cookie": "session=upstream"
        } }))
      const response = await read(new URL("https://app.test/api/repos/owner/repo/contents"), "https://cloud.test")
      expect(response.status).toBe(200)
      expect(response.headers.get("cache-control")).toBe("private, no-store")
      expect(response.headers.get("vary")).toBe("Cookie, Accept")
      expect(response.headers.has("set-cookie")).toBe(false)
      expect(await response.json()).toEqual({ name: "README.md" })
    }
  })

  test("a private repository's refusal is neither converted to data nor made cacheable", async () => {
    const { read } = reader(() => Response.json({ message: "repository not found" }, { status: 404 }))
    const response = await read(new URL("https://app.test/api/repos/owner/private"), "https://cloud.test")
    expect(response.status).toBe(404)
    expect(await response.json()).toEqual({ message: "repository not found" })
    expect(response.headers.get("cache-control")).toBe("private, no-store")
  })

  test("a refusal whose body stream breaks is still forwarded with its status and headers", async () => {
    // The body is handed through untouched; the route that maps it to the
    // app's structured error (index.ts) reads it there, and reads "" on a break.
    const { read } = reader(() => new Response(new ReadableStream({
      start(controller) { controller.error(new Error("upstream error body disconnected")) }
    }), { status: 404, headers: { vary: "Cookie", "set-cookie": "session=upstream" } }))
    const response = await read(new URL("https://app.test/api/repos/owner/repo"), "https://cloud.test")
    expect(response.status).toBe(404)
    expect(response.headers.get("cache-control")).toBe("private, no-store")
    expect(response.headers.get("vary")).toBe("Cookie")
    expect(response.headers.has("set-cookie")).toBe(false)
    await expect(response.text()).rejects.toThrow()
  })
})
