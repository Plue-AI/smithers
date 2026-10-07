import { NodeServices } from "@effect/platform-node"
import { Effect, Exit } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { wikiMemory } from "../coding/planning-memory.ts"
import { boundRelayWikiProvider } from "../coding/planning-wiki-provider.ts"
import { loadProject } from "../coding/project-config.ts"

// Literal fixtures (T-FLW-10, C-J8-04): bodies, revisions and SHA-256 digests.
const retryBody = "Webhook retries use `retry()` with exponential backoff."
const retryDigest = "0314a7d6edf2ad4b7057d059f7dfdf17df0ab800ec24b502f02ecb38c1bbed22"
const releaseBody = "Releases ship on Tuesdays."
const releaseDigest = "23a9b3561adda1dffe7def42f87d882b7cf5e65f7dfaa9ca599df819ea5ad96f"
const options = { repositoryPath: "/unused", pages: [], implementation: "coding/implementation", checks: [] }
const input = { prompt: "Retry failed webhook deliveries", feedback: "" }

const bodyOf = (request: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let text = ""
    request.on("data", (chunk) => text += chunk)
    request.on("end", () => resolve(text))
  })

const serve = async (
  handle: (method: string, url: string, body: string) => { status?: number; json: unknown }
) => {
  const requests: Array<{ method: string; url: string; authorization: string | undefined; body: string }> = []
  const server = createServer(async (request, response) => {
    const body = await bodyOf(request)
    requests.push({ method: request.method!, url: request.url!, authorization: request.headers.authorization, body })
    const answer = handle(request.method!, request.url!, body)
    response.statusCode = answer.status ?? 200
    response.setHeader("Content-Type", "application/json")
    response.end(JSON.stringify(answer.json))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as { port: number }).port
  return {
    apiBaseUrl: `http://127.0.0.1:${port}/api`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

const page = (slug: string, revision: number, body: string, digest: string) => ({
  id: slug === "retry-policy" ? 42 : 43,
  slug,
  revision,
  title: slug,
  body,
  content_digest: digest,
  generated: null
})

test("the bound provider selects through the host API and cites only the selected page", async () => {
  const relay = await serve((method, url) => {
    if (method === "POST" && url === "/api/repos/owner/repo/wiki/selection") {
      return { json: { pages: [{ slug: "retry-policy", revision: 3, reason: "Retry decision" }], model: "owner-fast" } }
    }
    if (url === "/api/repos/owner/repo/wiki/retry-policy") return { json: page("retry-policy", 3, retryBody, retryDigest) }
    return { status: 404, json: {} }
  })
  try {
    const provider = boundRelayWikiProvider({
      apiBaseUrl: relay.apiBaseUrl,
      repositorySlug: "owner/repo",
      runCredential: "run-only",
      isolated: true
    })
    const result = await Effect.runPromise(
      wikiMemory({ ...options, wikiProvider: provider }, input).pipe(Effect.provide(NodeServices.layer))
    )
    assert.deepEqual(result.pages.map((page) => page.citation), [
      { slug: "retry-policy", pageID: "42", revision: 3, digest: retryDigest }
    ])
    assert.equal(result.pages[0]!.body, retryBody)
    // The selector received the TODO's prompt; the rejected page was never read.
    assert.deepEqual(relay.requests.map(({ method, url }) => `${method} ${url}`), [
      "POST /api/repos/owner/repo/wiki/selection",
      "GET /api/repos/owner/repo/wiki/retry-policy"
    ])
    assert.deepEqual(JSON.parse(relay.requests[0]!.body), { prompt: "Retry failed webhook deliveries" })
    assert.ok(relay.requests.every(({ authorization }) => authorization === "Bearer run-only"))
  } finally {
    await relay.close()
  }
})

test("a page edited between selection and read is cited at the revision the read returned", async () => {
  const relay = await serve((method, url) => {
    if (method === "POST") {
      return {
        json: {
          pages: [
            { slug: "retry-policy", revision: 3, reason: "Retry decision" },
            { slug: "release-process", revision: 2, reason: "Unrelated" }
          ],
          model: "owner-fast"
        }
      }
    }
    if (url.endsWith("/retry-policy")) return { json: page("retry-policy", 4, retryBody, retryDigest) }
    // A body that does not hash to its digest is dropped and not cited.
    return { json: page("release-process", 2, releaseBody, retryDigest) }
  })
  try {
    const provider = boundRelayWikiProvider({
      apiBaseUrl: relay.apiBaseUrl,
      repositorySlug: "owner/repo",
      runCredential: "run-only",
      isolated: true
    })
    const result = await Effect.runPromise(
      wikiMemory({ ...options, wikiProvider: provider }, input).pipe(Effect.provide(NodeServices.layer))
    )
    assert.deepEqual(result.pages.map((page) => page.citation), [
      { slug: "retry-policy", pageID: "42", revision: 4, digest: retryDigest }
    ])
    assert.notEqual(releaseDigest, retryDigest)
  } finally {
    await relay.close()
  }
})

test("a process runtime refuses with isolation_required before any host API call", async () => {
  let calls = 0
  const provider = boundRelayWikiProvider({
    apiBaseUrl: "http://relay.test/api",
    repositorySlug: "owner/repo",
    runCredential: "run-only",
    isolated: false,
    fetch: async () => {
      calls++
      return Response.json({})
    }
  })
  const result = await Effect.runPromiseExit(
    wikiMemory({ ...options, wikiProvider: provider }, input).pipe(Effect.provide(NodeServices.layer))
  )
  assert.ok(Exit.isFailure(result))
  assert.match(JSON.stringify(result.cause), /isolation_required/)
  assert.equal(calls, 0)
})

test("refused, malformed or foreign selections refuse planning, never an empty vault", async () => {
  for (
    const [status, json] of [
      [404, {}],
      [503, { class: "infra", code: "unavailable" }],
      [200, { pages: [] }],
      [200, { pages: [{ slug: "retry-policy", revision: 0, reason: "x" }], model: "owner-fast" }],
      [200, { pages: [{ slug: "", revision: 3, reason: "x" }], model: "owner-fast" }],
      [200, { pages: [{ slug: "a", revision: 3, reason: "x" }, { slug: "a", revision: 3, reason: "x" }], model: "m" }],
      [200, { pages: "retry-policy", model: "owner-fast" }]
    ] as const
  ) {
    const reads: string[] = []
    const provider = boundRelayWikiProvider({
      apiBaseUrl: "http://relay.test/api",
      repositorySlug: "owner/repo",
      runCredential: "run-only",
      isolated: true,
      fetch: async (url, init) => {
        reads.push(`${init?.method ?? "GET"} ${new URL(String(url)).pathname}`)
        assert.equal(init?.redirect, "error")
        return Response.json(json, { status })
      }
    })
    const result = await Effect.runPromiseExit(
      wikiMemory({ ...options, wikiProvider: provider }, input).pipe(Effect.provide(NodeServices.layer))
    )
    assert.ok(Exit.isFailure(result), JSON.stringify(json))
    assert.match(JSON.stringify(result.cause), /unavailable/)
    assert.deepEqual(reads, ["POST /api/repos/owner/repo/wiki/selection"])
  }
})

test("an invalid binding or a non-wiki request never opens the selector", async () => {
  let calls = 0
  const make = (repositorySlug: string, runCredential = "run-only") =>
    boundRelayWikiProvider({
      apiBaseUrl: "http://relay.test/api",
      repositorySlug,
      runCredential,
      isolated: true,
      fetch: async () => {
        calls++
        return Response.json({ pages: [], model: "owner-fast" })
      }
    })
  for (const provider of [make("owner/repo/extra"), make("owner"), make("owner/repo", " ")]) {
    const exit = await Effect.runPromiseExit(provider.select({ prompt: "Retry", kinds: ["wiki"] }))
    assert.ok(Exit.isFailure(exit))
  }
  const valid = make("owner/repo")
  for (const request of [{ prompt: " ", kinds: ["wiki"] as const }, { prompt: "Retry", kinds: ["file"] as never }]) {
    assert.ok(Exit.isFailure(await Effect.runPromiseExit(valid.select(request))))
  }
  assert.equal(calls, 0)
})

test("the delivered project configuration turns citations on, but never binds a provider", async () => {
  const root = await mkdtemp(join(tmpdir(), "wiki-citations-"))
  try {
    await writeFile(join(root, "project.json"), JSON.stringify({ wikiCitations: true, checks: [] }))
    const project = await Effect.runPromise(loadProject(root, "project.json").pipe(Effect.provide(NodeServices.layer)))
    assert.equal(project.wikiCitations, true)
    assert.equal(Object.hasOwn(project, "wikiProvider"), false)
    await writeFile(join(root, "project.json"), JSON.stringify({ wikiCitations: true, wikiProvider: {} }))
    const refused = await Effect.runPromiseExit(
      loadProject(root, "project.json").pipe(Effect.provide(NodeServices.layer))
    )
    assert.ok(Exit.isFailure(refused))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
