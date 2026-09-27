import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { staleWikiNotes, wikiMemory } from "../coding/planning-memory.ts"
import { cloudWikiBody, reviewCounts } from "../coding/wiki-refresh.ts"
import { operations } from "../wiki/operations.ts"
import type { PageSpec } from "../wiki/schema.ts"

const run = <A, E>(effect: Effect.Effect<A, E, never>) => Effect.runPromise(effect)
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

test("a stack request plans only with supplied wiki pages whose inputs still hash to its source", async () => {
  const { root, digest } = await repository()
  try {
    const options = { repositoryPath: root, pages: [spec], implementation: "coding/implementation", checks: [] }
    const page = {
      id: "runtime",
      title: "Runtime",
      kind: "current" as const,
      body: "The runtime starts once.",
      inputDigest: await digest()
    }
    const input = (wiki: unknown) => ({ prompt: "Fix start", feedback: "", wiki } as never)
    const memory = (wiki: unknown) => run(wikiMemory(options, input(wiki)).pipe(Effect.provide(NodeServices.layer)))

    const fresh = await memory({ sourceRevision: "main@abc", pages: [page, { ...page, id: "unknown" }] })
    assert.deepEqual(
      fresh?.pages.map((entry) => entry.id),
      ["runtime"],
      "a page outside this host's catalog is never used"
    )
    assert.equal(fresh?.sourceRevision, "main@abc")
    assert.equal(await memory(null), undefined, "null: the stack has no published wiki yet")
    assert.equal(
      await memory(undefined),
      undefined,
      "without a supplied wiki a host with no local snapshot plans without one"
    )

    const note = {
      id: "runtime",
      title: "Runtime",
      kind: "current" as const,
      markdown: page.body,
      sourceRevision: "main@abc",
      inputDigest: page.inputDigest
    }
    assert.deepEqual(await run(staleWikiNotes(options, [note]).pipe(Effect.provide(NodeServices.layer))), [])

    await writeFile(join(root, "runtime.ts"), "export const start = () => 2\n")
    assert.equal(
      await memory({ sourceRevision: "main@abc", pages: [page] }),
      undefined,
      "a page whose source moved is stale"
    )
    assert.deepEqual(await run(staleWikiNotes(options, [note]).pipe(Effect.provide(NodeServices.layer))), ["runtime"])

    // A forged digest for other text still has to match this host's own spec and source.
    const forged = { ...page, inputDigest: await digest(), body: "Anything." }
    const other = { ...options, pages: [{ ...spec, purpose: "Something else" }] }
    assert.equal(
      await run(
        wikiMemory(other, input({ sourceRevision: "x", pages: [forged] })).pipe(Effect.provide(NodeServices.layer))
      ),
      undefined
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
