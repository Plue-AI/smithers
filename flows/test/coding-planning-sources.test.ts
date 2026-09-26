import { NodeServices } from "@effect/platform-node"
import { Effect, Schema } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
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
