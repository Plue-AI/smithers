import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { operations } from "../wiki/operations.ts"

const platform = process.versions.bun ? (await import("@effect/platform-bun/BunServices")).layer : NodeServices.layer

test(
  "install wiki inventories collect a newly merged export without changing the declaration",
  { timeout: 120000 },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "wiki-install-"))
    const root = join(directory, "repo")
    t.after(() => rm(directory, { recursive: true, force: true }))
    await mkdir(root)
    await mkdir(join(root, "api"))
    await writeFile(join(root, "api/server.ts"), "export function startServer() {}\n")
    const spec = {
      id: "package-api",
      title: "api",
      purpose: "Describe the code with source citations",
      kind: "current" as const,
      document: "",
      sourceDirectory: "api",
      inputs: [],
      related: []
    }
    const ops = operations({ root, output: join(directory, "wiki") })
    const collect = () => Effect.runPromise(ops.collect(spec).pipe(Effect.provide(platform)))
    const first = await collect()
    assert.equal(
      first.markdown,
      "# api\n\n## api/server.ts\n\n- `export function startServer() {}` [api/server.ts:1](../sources/api/server.ts#L1)\n"
    )
    await writeFile(join(root, "api/health.ts"), "export function healthCheck() {}\n")
    await writeFile(join(root, "api/.env"), "SECRET=never-capture\n")
    const merged = await collect()
    assert.deepEqual(merged.sources.map((source) => source.path), ["api/health.ts", "api/server.ts"])
    assert.equal(
      merged.markdown,
      "# api\n\n## api/health.ts\n\n- `export function healthCheck() {}` [api/health.ts:1](../sources/api/health.ts#L1)\n\n## api/server.ts\n\n- `export function startServer() {}` [api/server.ts:1](../sources/api/server.ts#L1)\n"
    )
    assert.notEqual(merged.inputDigest, first.inputDigest)

    const reviewed = {
      evidence: merged,
      reviewer: "fixture-reviewer",
      review: {
        sections: [
          {
            id: "section-1",
            verdict: "supported" as const,
            explanation: "The package exports these functions",
            citations: [{ path: "api/server.ts", line: 1, quote: "export function startServer() {}" }]
          },
          {
            id: "section-2",
            verdict: "supported" as const,
            explanation: "The health function is exported",
            citations: [{ path: "api/health.ts", line: 1, quote: "export function healthCheck() {}" }]
          },
          {
            id: "section-3",
            verdict: "supported" as const,
            explanation: "The server function is exported",
            citations: [{ path: "api/server.ts", line: 1, quote: "export function startServer() {}" }]
          }
        ]
      }
    }
    await Effect.runPromise(ops.write([reviewed], "verified").pipe(Effect.provide(platform)))
    assert.deepEqual(await Effect.runPromise(ops.check([spec], true).pipe(Effect.provide(platform))), {
      pages: 1,
      verification: "verified"
    })
    await symlink(tmpdir(), join(root, "api/escape"))
    await assert.rejects(collect(), /symlink/)
  }
)

test("a generated page writes no section for a source with no line to cite", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wiki-install-"))
  const root = join(directory, "repo")
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(join(root, "api"), { recursive: true })
  await writeFile(join(root, "api/server.ts"), "export function startServer() {}\n")
  await writeFile(join(root, "api/empty.ts"), "")
  await writeFile(join(root, "api/blank.md"), "\n  \r\n")
  const spec = {
    id: "package-api",
    title: "api",
    purpose: "Describe the code with source citations",
    kind: "current" as const,
    document: "",
    sourceDirectory: "api",
    inputs: [],
    related: []
  }
  const ops = operations({ root, output: join(directory, "wiki") })
  const evidence = await Effect.runPromise(ops.collect(spec).pipe(Effect.provide(platform)))
  // Still captured, so an edit to either refreshes the page.
  assert.deepEqual(evidence.sources.map((source) => source.path), ["api/blank.md", "api/empty.ts", "api/server.ts"])
  assert.equal(
    evidence.markdown,
    "# api\n\n## api/server.ts\n\n- `export function startServer() {}` [api/server.ts:1](../sources/api/server.ts#L1)\n"
  )
})

test("300-entry install repository publishes overview and architecture summaries and refreshes after a merge", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wiki-install-large-"))
  const root = join(directory, "repo"), output = join(directory, "wiki")
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(root)
  for (let i = 0; i < 300; i++) {
    await writeFile(join(root, `source-${String(i).padStart(3, "0")}.ts`), `export const source${i} = ${i}\n`)
  }
  const specs = ["overview", "architecture"].map((id) => ({
    id,
    title: id,
    purpose: "Summarize repository sources",
    kind: "current" as const,
    document: "",
    sourceDirectory: ".",
    inputs: [],
    related: []
  }))
  const ops = operations({ root, output })
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      import("effect/FileSystem").FileSystem | import("effect/Path").Path | import("effect/Crypto").Crypto
    >
  ) => Effect.runPromise(effect.pipe(Effect.provide(platform)))
  const pages = await Promise.all(specs.map((spec) => run(ops.collect(spec))))
  for (const page of pages) {
    assert.ok(page.sources.length > 0 && page.sources.length <= 32)
    assert.match(page.markdown, /Source summary/)
    assert.ok(page.sources.some((source) => source.path === "source-000.ts"))
    assert.ok(page.sources.some((source) => source.path === "source-299.ts"))
    assert.ok(page.sources.every((source) => page.markdown.includes(source.path)))
    assert.deepEqual(await run(ops.collect(page.spec)), page)
  }
  await run(ops.write(pages.map((evidence) => ({ evidence, review: null, reviewer: null })), "preview"))
  assert.deepEqual(await run(ops.check(specs)), { pages: 2, verification: "unreviewed" })
  const snapshot = JSON.parse(await readFile(join(output, "current.json"), "utf8"))
  assert.deepEqual(snapshot.pages.map((page: { slug: string }) => page.slug), [
    "generated-overview",
    "generated-architecture"
  ])
  await writeFile(join(root, "source-300.ts"), "export const added = true\n")
  await assert.rejects(run(ops.check(specs)), /changed|stale/i)
  assert.notEqual((await run(ops.collect(specs[0]!))).inputDigest, pages[0]!.inputDigest)
  // The public CLI must also execute the generated inventory through the real
  // engine and publish both pages, rather than only testing the collector.
  await mkdir(join(root, ".smithers"))
  await writeFile(join(root, ".smithers/coding-project.json"), JSON.stringify({ pages: specs }))
  const cli = fileURLToPath(new URL("../wiki/main.ts", import.meta.url))
  const generated = spawnSync("node", [cli, "--root", root, "--run", "wiki-large-install"], {
    encoding: "utf8",
    timeout: 180_000
  })
  assert.equal(generated.status, 0, generated.stderr + generated.stdout)
  assert.match(generated.stdout, /"pages":\s*2/)
  assert.match(generated.stdout, /"verification":\s*"unreviewed"/)
  const checked = spawnSync("node", [cli, "--root", root, "--check"], { encoding: "utf8", timeout: 180_000 })
  assert.equal(checked.status, 0, checked.stderr)
  assert.deepEqual(JSON.parse(checked.stdout), { pages: 2, verification: "unreviewed" })
})

test("generated summaries keep complete files within the byte budget and retain private path refusal", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "wiki-install-budget-")), root = join(directory, "repo")
  t.after(() => rm(directory, { recursive: true, force: true }))
  await mkdir(root)
  await writeFile(join(root, "large.ts"), "export const large = '" + "x".repeat(40_000) + "'\n")
  await writeFile(join(root, "small.ts"), "export const small = 1\n")
  await writeFile(join(root, ".env"), "SECRET=never-capture\n")
  const spec = {
    id: "overview",
    title: "Overview",
    purpose: "Summarize sources",
    kind: "current" as const,
    document: "",
    sourceDirectory: ".",
    inputs: [],
    related: []
  }
  const ops = operations({ root, output: join(directory, "wiki") })
  const collect = () => Effect.runPromise(ops.collect(spec).pipe(Effect.provide(platform)))
  const evidence = await collect()
  assert.deepEqual(evidence.sources.map((source) => source.path), ["small.ts"])
  assert.equal(evidence.sources[0]!.text, "export const small = 1\n")
  assert.match(evidence.markdown, /Source summary/)
  assert.doesNotMatch(JSON.stringify(evidence), /SECRET/)
  await symlink(join(root, ".env"), join(root, "leak.ts"))
  await assert.rejects(collect(), /Private\/runtime path/)
})
