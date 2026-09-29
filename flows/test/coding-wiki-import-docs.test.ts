/**
 * `coding/Wiki` imports the workspace's declared dependency docs after it
 * admits the stack base and before it refreshes the pages, through the
 * `ImportDocs` implementation `wikiRefreshRegistration` wires. A declaration
 * or install fault is `invalid-input`; only a failed fetch is `io`.
 */
import { NodeServices } from "@effect/platform-node"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import { AttemptStore } from "@smthrs/run-store/AttemptStore"
import { RunStore } from "@smthrs/run-store/RunStore"
import { Effect, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { Journal } from "../../packages/smithers/flows/journal/src/Journal.ts"
import { Refreshed } from "../coding/planning-wiki.ts"
import { CreateStackBase, PrepareStackBase } from "../coding/stack.ts"
import { withDependencyPages } from "../coding/wiki-refresh.ts"
import { wikiRefreshRegistration } from "../coding/wiki-route.ts"
import CodingWiki from "../coding/wiki/flow.ts"
import { directory, maxDocBytes } from "../memory/deps.ts"
import { Pool } from "../wiki/reuse.ts"
import { WikiError } from "../wiki/schema.ts"

const tip = "a".repeat(40)
const base = { commitId: tip, ref: `refs/smithers/workspaces/11111111-1111-4111-a111-111111111111/sources/${tip}` }
const target = {
  changeId: "k".repeat(32),
  commitId: tip,
  treeId: "e".repeat(40),
  operationId: "1".repeat(128),
  parentCommitIds: ["b".repeat(40)]
}
const operation = {
  requestId: "22222222-2222-4222-a222-222222222222",
  expectedOperationId: "1".repeat(128),
  target: { ...target, commitId: "b".repeat(40), parentCommitIds: [] },
  operation: "create" as const,
  description: ""
}
const targets = new URL(import.meta.resolve("@smthrs/targets")).href

const repository = async (docs: string) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "coding-wiki-docs-")))
  const lib = join(root, "node_modules", "lib")
  await mkdir(lib, { recursive: true })
  await mkdir(join(root, ".smithers"))
  await writeFile(join(lib, "package.json"), JSON.stringify({ version: "1.0.0" }))
  await writeFile(join(lib, "README.md"), "# lib\n")
  await writeFile(join(lib, "BIG.md"), "x".repeat(maxDocBytes + 1))
  await writeFile(
    join(root, ".smithers", "WORKSPACE.ts"),
    `import { Smithers as S } from ${JSON.stringify(targets)}
export const Workspace = S.Workspace("fixture", {
  repository: "git+https://example.invalid/fixture.git",
  cache: S.Cache({ directory: ".flows" }),
  toolchains: [S.Rust.Toolchain({ workspace: S.file("//Cargo.toml"), channel: "1.91" })],
  docs: ${docs}
})
`
  )
  return root
}

/**
 * Runs `coding/Wiki` on `root` with the stack base and the page refresh
 * stubbed. The stub refresh records whether the imported pages were already
 * on disk when it started, and answers an unreviewed receipt, which the real
 * `ReadPublishedWiki` then refuses.
 */
const refresh = async (root: string) => {
  const steps: Array<string> = []
  const RecordRefresh = Action.make("test/record-refresh", {
    payload: {},
    success: Refreshed,
    error: WikiError,
    nondeterministic: true
  })
  const RefreshStub = Flow.make("coding/RefreshWiki", {
    payload: { pool: Schema.optionalKey(Schema.NullOr(Pool)) },
    success: Refreshed,
    error: WikiError,
    body: () => RecordRefresh.call({})
  })
  const layer = Layer.mergeAll(
    wikiRefreshRegistration({
      repositoryPath: root,
      wikiOutput: join(root, "..", "wiki-out"),
      pages: [],
      reviewer: "r"
    }),
    PrepareStackBase.toLayer(() => Effect.sync(() => (steps.push("admit"), operation))),
    CreateStackBase.toLayer(() => Effect.succeed(target)),
    Interpreter.layer(RefreshStub),
    RecordRefresh.toLayer(() =>
      Effect.promise(async () => {
        const imported = await access(join(root, directory)).then(() => true, () => false)
        steps.push(imported ? "refresh-after-import" : "refresh-without-import")
        return {
          scopeDigest: "s",
          wikiRunId: "run",
          receipt: {
            schemaVersion: 1 as const,
            sourceRevision: tip,
            inputDigest: "i",
            output: "o",
            pages: 0,
            verification: "unreviewed" as const
          }
        }
      })
    )
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(Layer.mergeAll(NodeCrypto.layer, NodeServices.layer)),
    // The published read wants the review stores only after it verifies the
    // receipt, which the stub refresh never lets it do: any use dies here.
    Layer.provide(Layer.mergeAll(Layer.mock(Journal, {}), Layer.mock(RunStore, {}), Layer.mock(AttemptStore, {})))
  )
  const host = ManagedRuntime.make(layer)
  try {
    const exit = await host.runPromise(
      Effect.exit(CodingWiki.execute({ base }, { executionId: `wiki-${Math.random().toString(16).slice(2)}` }))
    )
    return { text: JSON.stringify(exit), failed: exit._tag === "Failure", steps }
  } finally {
    await host.dispose()
  }
}

test("coding/Wiki imports the declared docs, pinned, after admitting the base and before refreshing", async (t) => {
  const root = await repository(`{ lib: S.Docs.Package("lib") }`)
  t.after(() => rm(root, { recursive: true, force: true }))
  const { text, failed, steps } = await refresh(root)
  assert.deepEqual(steps, ["admit", "refresh-after-import"])
  assert.equal(await readFile(join(root, directory, "lib", "README.md"), "utf8"), "# lib\n")
  assert.equal(JSON.parse(await readFile(join(root, directory, "lib", "source.json"), "utf8")).pin, "lib@1.0.0")
  // The import passed; the stub's unreviewed receipt is what the published read refuses.
  assert.ok(failed)
  assert.doesNotMatch(text, /Dependency docs were not imported/)
  assert.match(text, /did not verify every page/)
})

for (
  const [label, docs, code] of [
    ["an uninstalled package", `{ gone: S.Docs.Package("absent") }`, "invalid-input"],
    ["an oversize file", `{ lib: S.Docs.Package("lib", { files: ["BIG.md"] }) }`, "invalid-input"],
    ["a file the package lacks", `{ lib: S.Docs.Package("lib", { files: ["NOPE.md"] }) }`, "invalid-input"],
    [
      "a forged declaration",
      `{ x: { _tag: "DocsPackage", package: "../..", files: ["a.md"] } as never }`,
      "invalid-input"
    ],
    ["a workspace that does not load", `(() => { throw new Error("broken") })()`, "invalid-input"],
    ["an unreachable URL", `{ guide: S.Docs.Url("https://127.0.0.1:1/guide.md", { sha256: "0".repeat(64) }) }`, "io"]
  ] as const
) {
  test(`coding/Wiki refuses ${label} as ${code} before refreshing`, async (t) => {
    const root = await repository(docs)
    t.after(() => rm(root, { recursive: true, force: true }))
    const { text, failed, steps } = await refresh(root)
    assert.ok(failed)
    assert.deepEqual(steps, ["admit"])
    assert.match(text, /Dependency docs were not imported/)
    assert.match(text, new RegExp(`"code":"${code}"`))
  })
}

test("dependency pages publish first, and a colliding id or more than 30 pages is refused", async () => {
  const page = (id: string) => ({
    id,
    title: id,
    kind: "current" as const,
    body: "# " + id,
    inputDigest: "i",
    contentDigest: "c",
    reviewDigest: "r",
    sources: []
  })
  const dep = {
    id: "dep-lib-readme-md",
    title: "deps/lib/README.md",
    body: "# lib",
    inputDigest: "p",
    contentDigest: "c"
  }
  const pages = await Effect.runPromise(withDependencyPages([page("start-here")], [dep]))
  assert.deepEqual(pages.map((page) => [page.id, page.reviewDigest]), [["dep-lib-readme-md", null], [
    "start-here",
    "r"
  ]])
  const collided = await Effect.runPromise(Effect.flip(withDependencyPages([page("dep-lib-readme-md")], [dep])))
  assert.match(collided.message, /collides/)
  const many = Array.from({ length: 30 }, (_, i) => page(`page-${i}`))
  const over = await Effect.runPromise(Effect.flip(withDependencyPages(many, [dep])))
  assert.equal(over.code, "invalid-input")
  assert.match(over.message, /30 pages and 1 dependency pages exceed 30/)
})
