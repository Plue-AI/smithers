import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Flow } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { findPlanningWikiReview } from "../coding/planning-wiki.ts"
import { PlanningContext } from "../coding/planning.ts"
import { Receipt, WikiError } from "../wiki/schema.ts"

const config = {
  mode: "verified" as const,
  pages: [{
    id: "page",
    title: "Page",
    purpose: "Read",
    kind: "current" as const,
    document: "page.md",
    inputs: [],
    related: []
  }],
  reviewer: "reviewer",
  scopeDigest: "current-scope",
  output: "/wiki"
}
const resultSchema = Schema.toCodecJson(
  Flow.Result({
    success: Schema.Struct({ scopeDigest: Schema.String, wikiRunId: Schema.String, receipt: Receipt }),
    error: WikiError
  })
)
const row = (id: string, scope = config.scopeDigest): RunStore.RunRow => ({
  runId: id,
  status: "completed",
  createdAtMs: 1,
  startedAtMs: 1,
  finishedAtMs: 2,
  owner: null,
  heartbeatAtMs: null,
  claim: null,
  claimedAtMs: null,
  parentRunId: null,
  cancelRequestedAtMs: null,
  stateJson: JSON.stringify({
    version: 1,
    flowName: "coding/RefreshWiki",
    payload: {},
    result: Schema.encodeSync(resultSchema)(
      new Flow.Complete({
        exit: Exit.succeed({
          scopeDigest: scope,
          wikiRunId: `wiki-${id}`,
          receipt: {
            schemaVersion: 1,
            sourceRevision: "sha256:source",
            inputDigest: "source",
            output: config.output,
            pages: 1,
            verification: "verified"
          }
        })
      })
    )
  })
})
const missing = (id: string) =>
  new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: `Collected ${id}`, cause: { runId: id } })
const lookup = (rows: readonly RunStore.RunRow[], collected = new Set<string>()) => {
  const byId = new Map(rows.map((r) => [r.runId, r]))
  const reads: string[] = [], windows: number[] = []
  const catalog: RunCatalogRead.Service = {
    // Mirrors the real filtered SQL ordering that caused the original bug.
    listRuns: (options) =>
      Effect.succeed({
        source: "0".repeat(32),
        revision: 1,
        cursor: null,
        runs: rows.filter((r) => JSON.parse(r.stateJson).flowName === "coding/RefreshWiki").slice(
          0,
          options?.limit ?? 20
        ).map((r) => ({
          _tag: "Observed" as const,
          runId: r.runId,
          source: "0".repeat(32),
          revision: 1,
          status: r.status,
          flowName: "coding/RefreshWiki",
          createdAtMs: r.createdAtMs,
          startedAtMs: r.startedAtMs,
          finishedAtMs: r.finishedAtMs,
          parentRunId: null,
          lineageId: r.runId,
          roundOrdinal: 0,
          cancellation: { requestedAtMs: null, acknowledgement: null },
          waiting: null
        }))
      }),
    // Existing listRunIds selects the latest insertion window, oldest first.
    listRunIds: (options) =>
      Effect.sync(() => {
        windows.push(options?.limit ?? 0)
        return rows.slice(-(options?.limit ?? 10000)).map((r) => r.runId)
      })
  }
  return {
    reads,
    windows,
    run: () =>
      Effect.runPromise(
        findPlanningWikiReview(config).pipe(
          Effect.provideService(RunCatalogRead.RunCatalogRead, catalog),
          Effect.provide(RunStore.layerNoop({
            get: (id) =>
              Effect.suspend(() => {
                reads.push(id)
                if (collected.has(id)) return Effect.fail(missing(id))
                return Effect.succeed(byId.get(id) ?? { ...row(id), stateJson: "{}" })
              })
          }))
        )
      )
  }
}
test("planning wiki finds the latest compatible review beyond the first twenty refreshes", async () => {
  const rows = Array.from({ length: 30 }, (_, i) => row(`refresh-${i}`, i >= 28 ? config.scopeDigest : "older-policy"))
  const f = lookup(rows)
  assert.equal(await f.run(), "wiki-refresh-29")
  assert.deepEqual(f.windows, [256], "use the existing bounded newest insertion window")
  assert.ok(f.reads.length <= 2, "newest valid candidate avoids reading older full run states")
})
test("a collected oldest child does not hide a newer compatible review", async () => {
  const f = lookup([row("old-collected"), row("new-live")], new Set(["wiki-old-collected"]))
  assert.equal(await f.run(), "wiki-new-live")
})
test("a collected newest child or parent is skipped within the bounded window", async () => {
  const f = lookup(
    [row("old-live"), row("new-collected"), row("parent-collected")],
    new Set(["wiki-new-collected", "parent-collected"])
  )
  assert.equal(await f.run(), "wiki-old-live")
  assert.deepEqual(f.reads, ["parent-collected", "new-collected", "wiki-new-collected", "old-live", "wiki-old-live"])
})

test("unrelated recent runs can cause an explicit bounded reuse miss", async () => {
  const unrelated = Array.from(
    { length: 300 },
    (_, i) => ({
      ...row(`unrelated-${i}`),
      stateJson: JSON.stringify({ version: 1, flowName: "another/Flow", payload: {} })
    })
  )
  const f = lookup([row("older-wiki"), ...unrelated])
  assert.equal(await f.run(), null)
  assert.deepEqual(f.windows, [256])
  assert.equal(f.reads.length, 256)
  assert.ok(!f.reads.includes("older-wiki"), "a bounded miss does not trigger an unbounded scan")
})

test("parked planning context without citations still decodes with captured memory", () => {
  const revision = { changeId: "change", commitId: "commit", treeId: "tree", operationId: "op", parentCommitIds: [] }
  const context = {
    head: revision,
    history: [{ ...revision, description: "Captured" }],
    memory: [{
      id: "legacy",
      title: "Legacy",
      kind: "intent",
      markdown: "Captured decision",
      sourceRevision: "main@old",
      inputDigest: "old-input"
    }],
    memoryRevision: "captured",
    implementation: "implementation",
    implementationDigest: "digest",
    checks: [{ id: "fast", target: "fast", flow: "fast", flowDigest: "digest", tier: "fast", required: true }, {
      id: "slow",
      target: "slow",
      flow: "slow",
      flowDigest: "digest",
      tier: "slow",
      required: true
    }]
  }
  const decoded = Schema.decodeUnknownSync(PlanningContext)(context)
  assert.deepEqual(decoded, context)
  assert.equal(decoded.wikiCitations, undefined)
})
