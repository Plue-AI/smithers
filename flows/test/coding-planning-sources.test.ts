import { NodeServices } from "@effect/platform-node"
import { Action, Flow } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import { Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as MemoryStore from "../../packages/smithers/agent/memory/src/MemoryStore.ts"
import * as TestMemory from "../../packages/smithers/agent/memory/src/test/TestMemory.ts"
import * as Jj from "../../packages/smithers/flows/jj/src/Jj.ts"
import { namespace as learningNamespace } from "../coding/learnings.ts"
import { NativeCoding } from "../coding/native.ts"
import { gather } from "../coding/planning-memory.ts"
import {
  collectSources,
  extractPaths,
  maxSourceBytes,
  maxSources,
  maxSourcesBytes,
  reader as sourceReader,
  readmePaths,
  staleSources
} from "../coding/planning-sources.ts"
import { PlanningContext, planningPrompt, ReviewRequest } from "../coding/planning.ts"
import { CodingError } from "../coding/schema.ts"
import { operations as wikiOperations } from "../wiki/operations.ts"
import type { PageSpec } from "../wiki/schema.ts"

const run = <A>(effect: Effect.Effect<A, never, import("effect/FileSystem").FileSystem | import("effect/Path").Path>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeServices.layer)))

test("request paths are extracted from prose without swallowing URLs or abbreviations", () => {
  assert.deepEqual(
    extractPaths(
      "Add a Purpose section to the README.md. Preserve the existing title.",
      "See docs/specs/product.md and src/a/b.ts (e.g. the loader), i.e. not https://example.com/README.md or www.example.com/x.md.",
      "Mention README.md again, plus a trailing one: notes/plan.md."
    ),
    ["README.md", "docs/specs/product.md", "src/a/b.ts", "notes/plan.md"]
  )
  // Prose that merely contains a dot is not a repository path.
  assert.deepEqual(extractPaths("Use e.g. etc. i.e. vs. Mr. Node.js and next.js here."), [])
  // Private, runtime and escaping trees are never planning evidence.
  assert.deepEqual(
    extractPaths("Read .git/config, .jj/repo.toml, node_modules/x/index.js, ../secret.ts and /etc/passwd.ts"),
    []
  )
  assert.deepEqual(extractPaths("Look at `flows/coding/planning.ts`, then [the spec](docs/design.md)."), [
    "flows/coding/planning.ts",
    "docs/design.md"
  ])
})

test("attached sources are capped per file and in total, and absences are named", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planning-sources-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  await writeFile(join(root, "README.md"), "# Canary\n\nAn introduction.\n")
  await writeFile(join(root, "big.md"), "a".repeat(maxSourceBytes + 4096))
  await mkdir(join(root, "docs"))
  await writeFile(join(root, "docs/one.md"), "b".repeat(maxSourceBytes))
  await writeFile(join(root, "docs/two.md"), "c".repeat(maxSourceBytes))
  await writeFile(join(root, "docs/three.md"), "d".repeat(maxSourceBytes))
  await writeFile(join(root, "docs/four.md"), "e".repeat(maxSourceBytes))
  await writeFile(join(root, "docs/five.md"), "f".repeat(maxSourceBytes))
  await writeFile(join(root, "binary.md"), "text\0more\n")
  await symlink("/etc/hosts", join(root, "escape.md"))

  const reader = await run(sourceReader(root))
  assert.deepEqual(await run(readmePaths(reader)), ["README.md"])

  const readme = await run(
    collectSources(reader, ["README.md", "docs/absent.md", "docs/absent.md", "binary.md", "escape.md"])
  )
  assert.equal(readme.sources.length, 1)
  assert.equal(readme.sources[0]!.path, "README.md")
  assert.equal(readme.sources[0]!.text, "# Canary\n\nAn introduction.\n")
  assert.equal(readme.sources[0]!.truncated, false)
  assert.match(readme.sources[0]!.digest, /^[0-9a-f]{64}$/)
  // A path that exists but is not bounded readable text is neither evidence
  // nor a stated absence; only a path with no file is reported missing.
  assert.deepEqual(readme.missing, ["docs/absent.md"])

  const truncated = await run(collectSources(reader, ["big.md"]))
  assert.equal(truncated.sources[0]!.truncated, true)
  assert.equal(truncated.sources[0]!.text.length, maxSourceBytes)
  // The digest identifies the WHOLE file, so a later edit past the cap shows.
  assert.notEqual(truncated.sources[0]!.digest, truncated.sources[0]!.text)

  const budget = await run(
    collectSources(reader, ["docs/one.md", "docs/two.md", "docs/three.md", "docs/four.md", "docs/five.md"])
  )
  assert.equal(budget.sources.length, 5)
  assert.equal(budget.sources.reduce((total, source) => total + Buffer.byteLength(source.text), 0), maxSourcesBytes)
  assert.deepEqual(budget.sources.map((source) => source.truncated), [false, false, false, false, true])
  assert.equal(budget.sources[4]!.text, "")
  assert.ok(budget.sources.length <= maxSources)
})

test("verification re-reads attached text and the stated absences", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planning-stale-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  await writeFile(join(root, "README.md"), "# Canary\n")
  const reader = await run(sourceReader(root))
  const collected = await run(collectSources(reader, ["README.md", "docs/absent.md"]))
  assert.deepEqual(await run(staleSources(reader, collected)), [])
  await writeFile(join(root, "README.md"), "# Canary\n\n## Purpose\n")
  assert.deepEqual(await run(staleSources(reader, collected)), ["README.md"])
  await writeFile(join(root, "README.md"), "# Canary\n")
  await mkdir(join(root, "docs"))
  await writeFile(join(root, "docs/absent.md"), "it exists now\n")
  assert.deepEqual(await run(staleSources(reader, collected)), ["docs/absent.md"])
})

test("the review payload carries the README text the planner used to ask for", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planning-payload-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  const body = "# canary-sandbox\n\nAn existing introduction.\n"
  await writeFile(join(root, "README.md"), body)
  const input = { prompt: "Add a Purpose section to the README.md", feedback: "" }
  const reader = await run(sourceReader(root))
  const collected = await run(
    collectSources(reader, [...extractPaths(input.prompt), ...(await run(readmePaths(reader)))])
  )
  const revision = {
    changeId: "native-1",
    commitId: "commit-1",
    treeId: "tree-1",
    operationId: "operation",
    parentCommitIds: []
  }
  const context = Schema.decodeUnknownSync(PlanningContext)({
    head: revision,
    history: [{ ...revision, description: "✨ feat: seed" }],
    memory: [],
    memoryRevision: "sha256:memory",
    implementation: "coding/atoms",
    implementationDigest: "sha256:implementation",
    checks: ["fast", "slow"].map((tier) => ({
      id: tier,
      target: `//:${tier}`,
      flow: `checks/${tier}`,
      flowDigest: `sha256:${tier}`,
      tier,
      required: true
    })),
    ...collected
  })
  assert.deepEqual(context.sources?.map((source) => source.path), ["README.md"])
  assert.deepEqual(context.missing, [])
  const payload = Schema.encodeUnknownSync(ReviewRequest.payloadSchema)({ input, context })
  const prompt = planningPrompt(payload)
  assert.ok(prompt.includes(JSON.stringify(body).slice(1, -1)))
  assert.ok(prompt.includes("README.md"))
  t.diagnostic("The planner is handed the current README instead of parking the run on a clarification.")
})

// `gather` over a real repository and catalog, with the native adapter and jj
// scripted: `memory` is what chooses the wiki pages and files planning reads.
const DelegateStep = Action.make("planning-test/delegate-step", {
  payload: Executable.Invocation,
  success: Schema.Json
})
const Delegate = Flow.make("planning-test/delegate", {
  payload: Executable.Invocation,
  success: Schema.Json,
  body: (input) => DelegateStep.call(input)
})
const gathering = async (root: string) => {
  const write = (path: string, text: string) => writeFile(join(root, path), text)
  await write("RUNTIME.md", "# Runtime\n\nThe runtime starts once.\n")
  await write("runtime.ts", "export const start = () => 1\n")
  await write("DEPLOY.md", "# Deploy\n\nDeploys ship on Fridays.\n")
  await write("deploy.ts", "export const ship = () => 2\n")
  await write("needed.ts", "export const needed = 3\n")
  await write("other.ts", "export const other = 4\n")
  for (const name of ["implement/atoms", "checks/fast", "checks/slow"]) {
    await mkdir(join(root, "flows", name), { recursive: true })
    await write(
      join("flows", name, "flow.mdx"),
      "---\ndescription: Planning fixture.\nflows: [planning-test/delegate]\ncapabilities: []\n---\nRun.\n"
    )
  }
  const spec = (id: string, title: string): PageSpec => ({
    id,
    title,
    purpose: title,
    kind: "current",
    document: `${id.toUpperCase()}.md`,
    inputs: [`${id}.ts`],
    related: []
  })
  const specs = [spec("runtime", "Runtime"), spec("deploy", "Deploy")]
  const ops = wikiOperations({ root, output: join(root, "..", "unused") })
  const pages = await Effect.runPromise(
    Effect.forEach(specs, (page) =>
      Effect.map(Effect.orDie(ops.collect(page)), (collected) => ({
        id: page.id,
        title: page.title,
        kind: "current" as const,
        body: `${page.title} notes.`,
        inputDigest: collected.inputDigest
      }))).pipe(Effect.provide(NodeServices.layer))
  )
  const executables = await Effect.runPromise(
    Effect.gen(function*() {
      const discovery = yield* Discovery.Discovery
      const found = yield* discovery.scan({ source: "project", root: join(root, "flows"), naming: "path" })
      return yield* Effect.forEach(
        found.entries,
        (descriptor) => Executable.fromDescriptor(descriptor, { delegates: [Delegate] })
      )
    }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provideMerge(NodeServices.layer))))
  )
  const revision = {
    kind: "resolved" as const,
    changeId: "k".repeat(32),
    commitId: "a".repeat(40),
    treeId: "b".repeat(40),
    operationId: "0".repeat(128),
    parentCommitIds: []
  }
  const services = Layer.mergeAll(
    Layer.succeed(NativeCoding, {
      sourcePublication: "cloud",
      read: () =>
        Effect.succeed({
          status: "read" as const,
          operationId: revision.operationId,
          head: revision,
          revisions: [],
          history: [revision]
        }),
      apply: () => Effect.die("planning memory never edits"),
      publishOriginalSource: () => Effect.die("planning memory never publishes")
    }),
    Jj.layerNoop({ snapshot: () => Effect.succeed({ commitId: revision.commitId, changeId: revision.changeId }) }),
    Layer.succeed(Executable.Catalog, { executables, refused: [] }),
    NodeServices.layer
  )
  const options = {
    repositoryPath: root,
    pages: specs,
    implementation: "implement/atoms",
    checks: ["fast", "slow"].map((tier) => ({
      id: tier,
      target: `//:${tier}`,
      flow: `checks/${tier}`,
      tier: tier as "fast" | "slow",
      required: true
    }))
  }
  const input = { prompt: "Make start idempotent", feedback: "", wiki: { sourceRevision: "main@abc", pages } }
  return (
    judge: Layer.Layer<never>,
    memory: Layer.Layer<MemoryStore.MemoryStore> = TestMemory.layer.pipe(Layer.orDie)
  ) =>
    Effect.runPromise(
      Effect.result(gather(options, input).pipe(Effect.provide(Layer.mergeAll(services, judge, memory))))
    )
}

test("gather plans with the wiki pages and files Jev keeps, and nothing it omits", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planning-gather-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  const gathered = await (await gathering(root))(
    // Jev keeps the runtime page and the two files the task needs; it
    // declines every directory and every other candidate.
    Evaluator.layerScripted((request) => {
      const items = (request.state as { readonly items?: ReadonlyArray<{ readonly id?: string }> }).items ?? []
      return Object.fromEntries(
        Object.keys(request.questions).map((id) => {
          const item = items[Number(id.split("_")[1])]
          const kept = id.startsWith("needed_") && ["runtime", "runtime.ts", "needed.ts"].includes(item?.id ?? "")
          return [id, { probability: kept ? 0.9 : 0.05 }]
        })
      )
    }) as Layer.Layer<never>
  )
  assert.equal(gathered._tag, "Success")
  const context = gathered._tag === "Success" ? gathered.success : undefined
  assert.deepEqual(context?.memory.map((note) => [note.id, note.sourceRevision, note.markdown]), [
    ["runtime", "main@abc", "Runtime notes."]
  ])
  assert.deepEqual(context?.sources?.map((source) => source.path).sort(), ["needed.ts", "runtime.ts"])
  assert.deepEqual(context?.checks.map((check) => check.flow), ["checks/fast", "checks/slow"])
})

test("gather fails unavailable when Jev cannot judge, never planning with the wiki and files dropped", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planning-gather-unjudged-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  const attempt = await gathering(root)
  const down = Layer.succeed(Evaluator.Evaluator)(Evaluator.Evaluator.of({
    evaluate: () => Effect.fail(new Evaluator.EvaluatorError({ code: "unreachable", message: "gateway down" }))
  })) as Layer.Layer<never>
  for (const [judge, reason] of [[down, "(unreachable: "], [Layer.empty, "(unconfigured: "]] as const) {
    const gathered = await attempt(judge)
    assert.equal(gathered._tag, "Failure")
    const error = gathered._tag === "Failure" ? gathered.failure : undefined
    assert.ok(error instanceof CodingError)
    assert.equal(error.code, "unavailable")
    assert.ok(error.message.includes(reason), error.message)
  }
})

const keepNothing = Evaluator.layerScripted((request) =>
  Object.fromEntries(Object.keys(request.questions).map((id) => [id, { probability: 0.05 }]))
) as Layer.Layer<never>

test("gather plans with accepted coding learnings only, and they change the memory revision", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planning-gather-learnings-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  const attempt = await gathering(root)
  const seeded = (notes: ReadonlyArray<readonly [string, "pending" | "accepted" | "rejected"]>) =>
    Layer.effectDiscard(Effect.gen(function*() {
      const store = yield* MemoryStore.MemoryStore
      for (const [id, status] of notes) {
        yield* store.putNote({
          namespace: learningNamespace,
          id,
          text: `lesson ${id}`,
          tags: [],
          provenance: {},
          status
        })
      }
      // A note outside the coding namespace never reaches planning.
      yield* store.putNote({ namespace: "user:cli", id: "other", text: "other", tags: [], provenance: {} })
    })).pipe(Layer.provideMerge(TestMemory.layer), Layer.orDie)
  const none = await attempt(keepNothing, seeded([["pending", "pending"], ["rejected", "rejected"]]))
  const some = await attempt(keepNothing, seeded([["pending", "pending"], ["accepted", "accepted"]]))
  assert.equal(none._tag, "Success")
  assert.equal(some._tag, "Success")
  if (none._tag !== "Success" || some._tag !== "Success") return
  assert.equal("learnings" in none.success, false)
  assert.deepEqual(some.success.learnings, [{ id: "accepted", text: "lesson accepted" }])
  assert.notEqual(some.success.memoryRevision, none.success.memoryRevision)
  assert.ok(planningPrompt({ context: some.success }).includes("lesson accepted"))
})

test("gather keeps the newest accepted learnings within the memory budget", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planning-gather-learning-budget-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  const attempt = await gathering(root)
  const many = Layer.effectDiscard(Effect.gen(function*() {
    const store = yield* MemoryStore.MemoryStore
    for (let index = 0; index < 25; index++) {
      yield* store.putNote({
        namespace: learningNamespace,
        id: `lesson-${String(index).padStart(2, "0")}`,
        text: "x".repeat(4_000),
        tags: [],
        provenance: {}
      })
    }
  })).pipe(Layer.provideMerge(TestMemory.layer), Layer.orDie)
  const gathered = await attempt(keepNothing, many)
  assert.equal(gathered._tag, "Success")
  const ids = gathered._tag === "Success" ? gathered.success.learnings?.map((learning) => learning.id) ?? [] : []
  // 48 KiB default budget holds eleven 4 KB notes: the newest, oldest first.
  assert.ok(ids.length > 0 && ids.length < 20, String(ids.length))
  assert.deepEqual(
    ids,
    Array.from({ length: ids.length }, (_, i) => `lesson-${String(25 - ids.length + i).padStart(2, "0")}`)
  )
})

test("gather fails unavailable when accepted learnings cannot be read", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "planning-gather-learning-down-"))
  t.after(() => rm(root, { force: true, recursive: true }))
  const gathered = await (await gathering(root))(keepNothing, MemoryStore.layerNoop())
  assert.equal(gathered._tag, "Failure")
  const error = gathered._tag === "Failure" ? gathered.failure : undefined
  assert.ok(error instanceof CodingError)
  assert.equal(error.code, "unavailable")
  assert.match(error.message, /learnings are unreadable: listNotes is unavailable/)
})
