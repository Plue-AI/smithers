import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { createServer } from "node:http"
import { test } from "node:test"
import { wikiMemory } from "../coding/planning-memory.ts"
import { relayWikiProvider } from "../coding/planning-wiki-provider.ts"

const digest = "0590d40eefc0d1d5a9a5c8d407e4acfcb1cae6de15729033c56dc64ddb9abe47"
test("planning captures the authorized relay response, including an edit after selection", async () => {
  const requests: string[] = []
  const server = createServer((request, response) => {
    requests.push(request.url!)
    assert.equal(request.headers.authorization, "Bearer run-only")
    response.setHeader("Content-Type", "application/json")
    response.end(
      JSON.stringify({
        id: 42,
        slug: "decisions/retries",
        revision: 7,
        title: "Retries",
        body: "Decision: exponential backoff.",
        content_digest: digest,
        generated: null
      })
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  try {
    const address = server.address() as { port: number }
    const provider = relayWikiProvider({
      relayURL: `http://127.0.0.1:${address.port}`,
      owner: "owner",
      repository: "repo",
      runCredential: "run-only",
      authorize: () => Effect.void,
      select: (request) => {
        assert.deepEqual(request, { prompt: "Retry deliveries", kinds: ["wiki"] })
        return Effect.succeed([{ slug: "decisions/retries" }])
      }
    })
    const result = await Effect.runPromise(
      wikiMemory({
        repositoryPath: "/unused",
        pages: [],
        implementation: "coding/implementation",
        checks: [],
        wikiProvider: provider
      }, { prompt: "Retry deliveries", feedback: "" }).pipe(Effect.provide(NodeServices.layer))
    )
    assert.deepEqual(result.pages.map((page) => page.citation), [{
      pageID: "42",
      slug: "decisions/retries",
      revision: 7,
      digest
    }])
    assert.equal(result.pages[0]!.body, "Decision: exponential backoff.")
    assert.deepEqual(requests, ["/api/repos/owner/repo/wiki/decisions%2Fretries"])
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
})

test("relay refuses failed reads, malformed data, generated pages and redirects without leaking credentials", async () => {
  for (
    const response of [
      new Response("{}", { status: 403 }),
      new Response("{}"),
      Response.json({
        id: 42,
        slug: "generated-runtime",
        revision: 1,
        title: "Runtime",
        body: "stale",
        content_digest: digest
      })
    ]
  ) {
    const provider = relayWikiProvider({
      relayURL: "http://relay.test",
      owner: "owner",
      repository: "repo",
      runCredential: "run-only",
      authorize: () => Effect.void,
      select: () => Effect.succeed([]),
      fetch: async (_url, init) => {
        assert.equal(init?.redirect, "error")
        return response
      }
    })
    const result = await Effect.runPromise(Effect.result(provider.read("generated-runtime")))
    assert.equal(result._tag, "Failure")
  }
})

test("invalid relay bindings and traversal never open transport or selector", async () => {
  let calls = 0
  const make = (relayURL: string, runCredential = "run-only") =>
    relayWikiProvider({
      relayURL,
      runCredential,
      owner: "owner",
      repository: "repo",
      authorize: () => Effect.void,
      select: () => {
        calls++
        return Effect.succeed([])
      },
      fetch: async () => {
        calls++
        return new Response("{}")
      }
    })
  for (
    const provider of [
      make("https://person:secret@relay.test"),
      make("file:///tmp/wiki"),
      make("http://relay.test", "")
    ]
  ) {
    assert.equal((await Effect.runPromise(Effect.result(provider.authorize())))._tag, "Failure")
    assert.equal(
      (await Effect.runPromise(Effect.result(provider.select({ prompt: "Retry", kinds: ["wiki"] }))))._tag,
      "Failure"
    )
  }
  assert.equal((await Effect.runPromise(Effect.result(make("http://relay.test").read("../secrets"))))._tag, "Failure")
  assert.equal(calls, 0)
})

test("relay passes revision-bound generated inputs to machine freshness checks", async () => {
  const generated = {
    id: "runtime",
    inputDigest: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceRevision: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  }
  const provider = relayWikiProvider({
    relayURL: "http://relay.test",
    owner: "owner",
    repository: "repo",
    runCredential: "run-only",
    authorize: () => Effect.void,
    select: () => Effect.succeed([]),
    fetch: async () =>
      Response.json({
        id: 42,
        slug: "generated-runtime",
        revision: 1,
        title: "Runtime",
        body: "Decision: exponential backoff.",
        content_digest: digest,
        generated
      })
  })
  assert.deepEqual(await Effect.runPromise(provider.read("generated-runtime")), {
    pageID: "42",
    slug: "generated-runtime",
    revision: 1,
    title: "Runtime",
    markdown: "Decision: exponential backoff.",
    digest,
    generated
  })
})

test("a person-edited generated slug is authored without a generated inventory", async () => {
  const provider = relayWikiProvider({
    relayURL: "http://relay.test",
    owner: "owner",
    repository: "repo",
    runCredential: "run-only",
    authorize: () => Effect.void,
    select: () => Effect.succeed([{ slug: "generated-runtime" }]),
    fetch: async () =>
      Response.json({
        id: 42,
        slug: "generated-runtime",
        revision: 7,
        title: "Runtime",
        body: "Decision: exponential backoff.",
        content_digest: digest,
        generated: null
      })
  })
  const result = await Effect.runPromise(
    wikiMemory({
      repositoryPath: "/unused",
      pages: [],
      implementation: "coding/implementation",
      checks: [],
      wikiProvider: provider
    }, { prompt: "Retry deliveries", feedback: "" }).pipe(Effect.provide(NodeServices.layer))
  )
  assert.equal(result.pages[0]!.generated, false)
  assert.deepEqual(result.pages[0]!.citation, { pageID: "42", slug: "generated-runtime", revision: 7, digest })
})
