import { NodeServices } from "@effect/platform-node"
import { Crypto, Effect, Exit, FileSystem, Path } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { type PlanningWikiProvider, staleWikiNotes, wikiMemory } from "../coding/planning-memory.ts"
import { CodingError } from "../coding/schema.ts"
import { cloudWikiBody, reviewCounts } from "../coding/wiki-refresh.ts"
import { operations } from "../wiki/operations.ts"
import type { PageSpec } from "../wiki/schema.ts"

const run = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))
const exit = <A, E>(effect: Effect.Effect<A, E, Crypto.Crypto | FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(NodeServices.layer)))
const spec: PageSpec = {
  id: "runtime",
  title: "Runtime",
  purpose: "Runtime contracts",
  kind: "current",
  document: "RUNTIME.md",
  inputs: ["runtime.ts"],
  related: []
}

const repository = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coding-wiki-memory-")))
  await writeFile(join(root, "RUNTIME.md"), "# Runtime\n\nThe runtime starts once.\n")
  await writeFile(join(root, "runtime.ts"), "export const start = () => 1\n")
  const digest = async () =>
    (await Effect.runPromise(
      operations({ root, output: join(root, "..", "unused") }).collect(spec)
        .pipe(Effect.provide(NodeServices.layer))
    )).inputDigest
  return { root, digest }
}

const authored = {
  pageID: "page-retry",
  slug: "retry-policy",
  revision: 3,
  title: "Retries",
  markdown: "Decision: exponential backoff.",
  digest: "0590d40eefc0d1d5a9a5c8d407e4acfcb1cae6de15729033c56dc64ddb9abe47"
}
const edited = {
  pageID: "page-fixed",
  slug: "fixed-policy",
  revision: 7,
  title: "Fixed retries",
  markdown: "Decision: retryFixed(5000).",
  digest: "0b2889240d13d49add99a1daef222ddce288814a94826dbce1fbf456f03adc6b"
}
const input = { prompt: "Retry failed webhook deliveries", feedback: "" }
const options = { repositoryPath: "/unused", pages: [], implementation: "coding/implementation", checks: [] }
const fixture = (selected = ["retry-policy", "fixed-policy"]) => {
  const reads: string[] = []
  const requests: unknown[] = []
  const provider: { -readonly [K in keyof PlanningWikiProvider]: PlanningWikiProvider[K] } = {
    authorize: () => Effect.void,
    select: (request) => {
      requests.push(request)
      return Effect.succeed(selected.map((slug) => ({ slug })))
    },
    read: (slug) => {
      reads.push(slug)
      return Effect.succeed(slug === "retry-policy" ? authored : edited)
    }
  }
  return { provider, reads, requests, run: () => run(wikiMemory({ ...options, wikiProvider: provider }, input)) }
}

test("authorized authored-only planning captures exact revision digests without a generated inventory", async () => {
  const f = fixture()
  const memory = await f.run()
  assert.deepEqual(f.requests, [{ prompt: "Retry failed webhook deliveries", kinds: ["wiki"] }])
  assert.deepEqual(memory.pages.map((p) => p.citation), [
    {
      pageID: "page-retry",
      slug: "retry-policy",
      revision: 3,
      digest: "0590d40eefc0d1d5a9a5c8d407e4acfcb1cae6de15729033c56dc64ddb9abe47"
    },
    {
      pageID: "page-fixed",
      slug: "fixed-policy",
      revision: 7,
      digest: "0b2889240d13d49add99a1daef222ddce288814a94826dbce1fbf456f03adc6b"
    }
  ])
  assert.deepEqual(memory.pages.map((p) => p.body), ["Decision: exponential backoff.", "Decision: retryFixed(5000)."])
})

test("selector exclusions are never read and duplicates are cited once", async () => {
  const f = fixture(["retry-policy", "retry-policy"])
  assert.equal((await f.run()).pages.length, 1)
  assert.deepEqual(f.reads, ["retry-policy"])
})

test("read captures the edited revision rather than the selection's earlier identity", async () => {
  const f = fixture(["retry-policy"])
  f.provider.read = () => Effect.succeed({ ...edited, pageID: "page-retry", slug: "retry-policy", revision: 4 })
  const memory = await f.run()
  assert.equal(memory.pages[0]?.citation.revision, 4)
  assert.equal(memory.pages[0]?.body, "Decision: retryFixed(5000).")
  assert.equal(memory.pages[0]?.citation.digest, "0b2889240d13d49add99a1daef222ddce288814a94826dbce1fbf456f03adc6b")
})

test("invalid identity or content digest excludes both bytes and citation", async () => {
  for (
    const patch of [{ markdown: "Forged" }, { slug: "other" }, { revision: 0 }, { pageID: "" }, { digest: "invalid" }]
  ) {
    const f = fixture(["retry-policy"])
    f.provider.read = () => Effect.succeed({ ...authored, ...patch })
    assert.deepEqual((await f.run()).pages, [])
  }
})

test("missing providers, unavailable authority and API failures refuse rather than use supplied or pointer bytes", async () => {
  const missing = await exit(wikiMemory(options, input))
  assert.equal(Exit.isFailure(missing), true)
  for (const code of ["unavailable", "isolation_required"] as const) {
    const f = fixture()
    f.provider.authorize = () => Effect.fail(new CodingError({ code, message: "Fixture refusal" }))
    assert.equal(
      Exit.isFailure(await exit(wikiMemory({ ...options, wikiProvider: f.provider, wikiOutput: "/pointer" }, input))),
      true
    )
    assert.deepEqual(f.reads, [])
    assert.deepEqual(f.requests, [])
  }
  const f = fixture()
  f.provider.read = () => Effect.fail(new CodingError({ code: "unavailable", message: "Read denied" }))
  assert.equal(Exit.isFailure(await exit(wikiMemory({ ...options, wikiProvider: f.provider }, input))), true)
  const { pages: _, ...unpinned } = options
  assert.equal(Exit.isFailure(await exit(wikiMemory({ ...unpinned, wikiProvider: f.provider }, input))), true)
})

test("an authorized empty vault is valid even when the stack has no published wiki", async () => {
  const f = fixture([])
  const memory = await run(wikiMemory({ ...options, wikiProvider: f.provider }, { ...input, wiki: null }))
  assert.deepEqual(memory.pages, [])
})

test("API generated pages retain source freshness checks; authored pages do not require them", async () => {
  const { root, digest } = await repository()
  try {
    const f = fixture(["retry-policy"])
    const inputDigest = await digest()
    f.provider.read = () =>
      Effect.succeed({ ...authored, generated: { id: "runtime", inputDigest, sourceRevision: "main@abc" } })
    const opts = { ...options, repositoryPath: root, pages: [spec], wikiProvider: f.provider }
    const memory = () => run(wikiMemory(opts, input).pipe(Effect.provide(NodeServices.layer)))
    assert.equal((await memory()).pages.length, 1)
    await writeFile(join(root, "runtime.ts"), "export const start = () => 2\n")
    assert.deepEqual((await memory()).pages, [])
    f.provider.read = () => Effect.succeed(authored)
    assert.equal((await memory()).pages.length, 1)
    assert.deepEqual(
      await run(
        staleWikiNotes(opts, [{
          id: "page-retry",
          title: "Retries",
          kind: "current",
          markdown: authored.markdown,
          sourceRevision: "wiki:page-retry:3",
          inputDigest: authored.digest,
          generated: false
        }]).pipe(Effect.provide(NodeServices.layer))
      ),
      []
    )
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("cloud wiki bodies link pages by slug and preserve exact source citations", () => {
  const titles = new Map([["runtime", "Runtime"], ["flows", "Flows"]])
  const body =
    "See [Flows](./flows.md) · [Gone](./gone.md)\n\n[runtime.ts:1](../sources/runtime.ts#L1)\n\n- [runtime.ts](../sources/runtime.ts) — `abc`\n"
  assert.equal(
    cloudWikiBody(body, titles),
    "See [[generated-flows|Flows]] · [Gone](./gone.md)\n\n[runtime.ts:1](../sources/runtime.ts#L1)\n\n- [runtime.ts](../sources/runtime.ts) — `abc`\n"
  )
})

test("the refresh reports pages reviewed cold apart from pages that reused an earlier review", () => {
  const attempt = { executionId: "wiki-1", nodeId: "review", attempt: 1 }
  assert.deepEqual(
    reviewCounts([
      { verification: {} },
      { verification: { provenance: { reusedFrom: null } } },
      { verification: { provenance: { reusedFrom: attempt } } }
    ]),
    { cold: 2, reused: 1 }
  )
})
