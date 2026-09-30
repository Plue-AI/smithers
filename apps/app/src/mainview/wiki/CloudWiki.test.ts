import { describe, expect, test } from "bun:test"
import { Effect, Stream } from "effect"
import * as Y from "yjs"
import {
  CloudWikiTransport,
  decodeWikiState,
  editWikiState,
  encodeWikiState,
  makeCloudWikiTransport,
  mergeWikiState,
  wikiContentPath,
  wikiFolderOf,
  wikiPagePath,
  wikiStateContains
} from "./CloudWiki"

import nativeDeletion from "./fixtures/yrs-deletion-ack.json"

const stateOf = (text: string) => {
  const doc = new Y.Doc()
  doc.getText("markdown").insert(0, text)
  const state = encodeWikiState(Y.encodeStateAsUpdate(doc))
  doc.destroy()
  return state
}

describe("Plue Wiki Yjs-v1 contract", () => {
  test("independent edits merge without duplicating the causal seed, including Unicode boundaries", () => {
    const initial = stateOf("# Page\n\nA 🌱 tree.")
    const left = editWikiState(initial, "# Page\n\nA 🌳 tree.", 101)
    const right = editWikiState(initial, "# Page\n\nA 🌱 tree.\n\nNext", 102)
    expect(mergeWikiState(initial, left.update, right.update).body).toBe("# Page\n\nA 🌳 tree.\n\nNext")
    expect(mergeWikiState(initial, right.update, left.update, left.update)).toEqual(
      mergeWikiState(initial, left.update, right.update)
    )
    const next = editWikiState(left.state, "# Page\n\nA 🌳 trees.", 101)
    expect(mergeWikiState(initial, next.update, left.update, right.update).body).toBe("# Page\n\nA 🌳 trees.\n\nNext")
    expect(Y.decodeStateVector(Y.encodeStateVectorFromUpdate(decodeWikiState(next.state))).size).toBe(2)
  })

  test("actual Yrs 0.27.4 deletion acknowledgements contain the submitted delta before and after a concurrent insertion", () => {
    // Captured by Plue's real native FFI with Yjs 13.6.32, 2026-09-09.
    expect(wikiStateContains(nativeDeletion.bootstrap.state, nativeDeletion.submittedDeletionDelta)).toBe(false)
    expect(wikiStateContains(nativeDeletion.acceptedDocument.state, nativeDeletion.submittedDeletionDelta)).toBe(true)
    expect(wikiStateContains(nativeDeletion.concurrentLaterDocument.state, nativeDeletion.submittedDeletionDelta)).toBe(
      true
    )
    expect(mergeWikiState(nativeDeletion.acceptedDocument.state).body).toBe(nativeDeletion.acceptedDocument.markdown)
  })

  test("UTF-8 Markdown and binary delta limits are enforced before a local edit is queued", () => {
    expect(() => editWikiState(stateOf("small"), "🌱".repeat(262145))).toThrow("1 MiB of Markdown")
    expect(() => wikiPagePath("owner/..", "home")).toThrow()
    expect(() => wikiPagePath("owner/repo", "../secret")).toThrow()
  })

  test("the existing proxy receives bounded SSE chunks and per-page replay identity", async () => {
    const frames = [
      ": connected\n\nevent: wiki.up",
      "date\nid: 7\ndata: {\"id\":7,\"page_id\":42,\"revision\":7,\"deleted\":false,\"slug\":\"new-name\"}\n\n"
    ]
    let request = ""
    const transport = makeCloudWikiTransport({
      baseUrl: "https://smithers.test",
      http: async (url) => {
        request = url
        return new Response(
          new ReadableStream({
            start(controller) {
              frames.forEach((frame) => controller.enqueue(new TextEncoder().encode(frame)))
              controller.close()
            }
          }),
          { headers: { "content-type": "text/event-stream" } }
        )
      }
    })
    const events = await Effect.runPromise(Stream.runCollect(transport.revisions("owner/repo", "old-name", 42, 6, "private")))
    expect(request).toContain("/api/repos/owner/repo/wiki/old-name/stream?page_id=42&after=6&visibility=private")
    expect(events).toEqual([{ id: 7, page_id: 42, revision: 7, deleted: false, slug: "new-name" }])
  })

  test("mismatched revision identity and revoked access fail instead of advancing the cursor", async () => {
    for (
      const frame of [
        "event: wiki.update\nid: 8\ndata: {\"id\":7,\"page_id\":42,\"revision\":7,\"deleted\":false,\"slug\":\"home\"}\n\n",
        "event: revoked\ndata: {}\n\n"
      ]
    ) {
      const transport = makeCloudWikiTransport({
        baseUrl: "",
        http: async () =>
          new Response(frame, {
            headers: { "content-type": "text/event-stream" }
          })
      })
      const result = await Effect.runPromise(
        Effect.result(Stream.runCollect(transport.revisions("owner/repo", "home", 42, 6, "public")))
      )
      expect(result._tag).toBe("Failure")
    }
  })
})

describe("the wiki spaces transport (#1922)", () => {
  const page = { id: 7, slug: "home", title: "Home", revision: 2, author: { id: 1, login: "will" }, created_at: "2026-09-26T00:00:00Z", updated_at: "2026-09-26T00:00:00Z", visibility: "private", path: "Home.md", content_digest: "a".repeat(64) }
  const recorded = () => {
    const requests: Array<{ url: string; method: string; type: string | undefined; body: unknown }> = []
    const transport = makeCloudWikiTransport({ baseUrl: "", http: async (url, init) => {
      const headers = new Headers(init?.headers)
      requests.push({ url, method: init?.method ?? "GET", type: headers.get("content-type") ?? undefined, body: init?.body })
      if (url.includes("/navigation/index")) return Response.json({ pages: [{ ...page, body: "", metadata: { frontmatter: null, aliases: [], tags: ["guide"], headings: ["Home"], links: [{ target: "Guides/Start", heading: "Install", alias: "start", embed: false, page_id: 8 }] }, backlinks: [{ page_id: 8, path: "Guides/Start.md", embed: false }] }], folders: ["Guides"], tags: ["guide"], checkpoint: 12 })
      if (url.includes("/history/7?")) return Response.json([{ page_id: 7, revision: 2, path: "Home.md", title: "Home", content_digest: "a".repeat(64), deleted: false, author: { id: 1, login: "will" }, updated_at: "2026-09-26T00:00:00Z" }])
      if (init?.method === "DELETE") return new Response(null, { status: 204 })
      if (url.includes("per_page=50") && !url.includes("/history/")) return Response.json([page])
      if (url.includes("/document?")) return Response.json({ page: { ...page, body: "# Home" }, state: "", state_vector: "" })
      return Response.json(page)
    } })
    return { requests, transport }
  }

  test("every request carries its space, and the index, history, create, rename, delete and attach routes are the contract's", async () => {
    const { requests, transport } = recorded()
    const run = <A>(effect: Effect.Effect<A, unknown, CloudWikiTransport>) => Effect.runPromise(Effect.provideService(effect, CloudWikiTransport, transport))
    const index = await run(transport.index("owner/repo", "private"))
    expect(index.pages[0]?.backlinks?.[0]).toEqual({ page_id: 8, path: "Guides/Start.md", embed: false })
    expect(index.folders).toEqual(["Guides"])
    expect(index.checkpoint).toBe(12)
    await run(transport.history("owner/repo", "private", 7, 1))
    await run(transport.create("owner/repo", "private", { title: "Home", body: "# Home\n" }))
    await run(transport.patch("owner/repo", "private", "home", { path: "Guides/Home.md", expected_revision: 2 }))
    await run(transport.remove("owner/repo", "private", "home"))
    await run(transport.attach("owner/repo", "public", "logo", { path: "assets/logo.png", mediaType: "image/png", expectedRevision: 0, bytes: new Uint8Array([1, 2, 3]) }))
    await run(transport.list("owner/repo", 1, "public"))
    await run(transport.read("owner/repo", "home", "private"))
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET /api/repos/owner/repo/wiki/navigation/index?visibility=private",
      "GET /api/repos/owner/repo/wiki/history/7?page=1&per_page=50&visibility=private",
      "POST /api/repos/owner/repo/wiki?visibility=private",
      "PATCH /api/repos/owner/repo/wiki/home?visibility=private",
      "DELETE /api/repos/owner/repo/wiki/home?visibility=private",
      "PUT /api/repos/owner/repo/wiki/attachments/logo?path=assets%2Flogo.png&expected_revision=0&visibility=public",
      "GET /api/repos/owner/repo/wiki?page=1&per_page=50&visibility=public",
      "GET /api/repos/owner/repo/wiki/home/document?visibility=private"
    ])
    expect(JSON.parse(String(requests[3]!.body))).toEqual({ path: "Guides/Home.md", expected_revision: 2 })
    expect(requests[5]!.type).toBe("image/png")
    expect(wikiContentPath("owner/repo", "private", 7, 2)).toBe("/repos/owner/repo/wiki/history/7/2/content?visibility=private")
    expect(wikiFolderOf("Guides/Start.md")).toBe("Guides")
    expect(wikiFolderOf("Home.md")).toBe("")
  })

  test("a stale rename or attachment is refused with the 409 the backend answers", async () => {
    const transport = makeCloudWikiTransport({ baseUrl: "", http: async () => Response.json({ message: "revision 1 is not current" }, { status: 409 }) })
    const result = await Effect.runPromise(Effect.result(transport.patch("owner/repo", "public", "home", { path: "Other.md", expected_revision: 1 })))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect((result.failure as { status?: number }).status).toBe(409)
  })
})
