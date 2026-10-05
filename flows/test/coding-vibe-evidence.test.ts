import { NodeServices } from "@effect/platform-node"
import * as ControlRuntime from "@smthrs/control/ControlRuntime"
import { DurableEngineState } from "@smthrs/engine-store"
import * as RunCatalogRead from "@smthrs/engine-store/RunCatalogRead"
import { Flow } from "@smthrs/flow"
import * as RunStore from "@smthrs/run-store/RunStore"
import { Effect, Exit, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { Poc, type PocResult } from "../coding/poc.ts"
import { PrepareRequest } from "../coding/preparation.ts"
import { Request } from "../coding/request.ts"
import {
  checkInputDigest,
  CodingError,
  type Implementation,
  type Plan,
  RequestResult,
  type Revision
} from "../coding/schema.ts"
import { readVibeRequest } from "../coding/vibe-evidence.ts"

const revision = (name: string, parent?: string): Revision => ({
  changeId: `jj-${name}`,
  commitId: `commit-${name}`,
  treeId: `tree-${name}`,
  operationId: `op-${name}`,
  parentCommitIds: parent ? [`commit-${parent}`] : []
})
const original = revision("original"),
  intermediate = revision("earlier-implementation", "original"),
  final = revision("final", "earlier-implementation")
const input = { prompt: "Finish this request", maxRounds: 2 }
const plan: Plan = {
  prompt: input.prompt,
  memoryRevision: "verified-wiki",
  base: intermediate,
  observedHead: intermediate,
  changes: [{
    id: "last",
    title: "Last change",
    intent: "Finish",
    implementation: "coding/implementation",
    implementationDigest: "0".repeat(64),
    atoms: [{ changeId: null, message: "✨ feat: finish", intent: "finish", reads: [], writes: ["file"] }],
    checks: ["fast", "slow"].map((tier) => ({
      id: tier,
      target: tier,
      flow: `checks/${tier}`,
      flowDigest: "0".repeat(64),
      tier: tier as "fast" | "slow",
      required: true
    }))
  }]
}
const implementation: Implementation = {
  change: "last",
  parent: intermediate,
  atoms: [final],
  head: final,
  reads: [],
  writes: ["file"]
}
const request: typeof RequestResult.Type = {
  plan,
  outcome: {
    status: "validated",
    rounds: 1,
    blocked: null,
    result: {
      status: "validated",
      findings: [],
      changes: [{
        implementation,
        receipts: plan.changes[0]!.checks.map((check) => ({
          change: "last",
          checkId: check.id,
          target: check.target,
          tier: check.tier,
          commitId: final.commitId,
          treeId: final.treeId,
          inputDigest: checkInputDigest(implementation, check),
          status: "passed",
          findings: [],
          evidence: "measured fixture"
        }))
      }]
    }
  }
}
const poc: PocResult = {
  status: "drafted-unvalidated",
  source: original,
  changes: {
    sourceDigest: "digest",
    transactionBase: "base",
    files: [{ path: "file", before: null, after: "poc", beforeDigest: null, afterDigest: "digest" }],
    preview: { mediaType: "text/html", content: "<p>Discarded</p>" }
  },
  findings: ["Learned from POC"],
  feedback: "Replan"
}
const row = (
  runId: string,
  flowName: string,
  payload: unknown,
  result?: unknown,
  parentRunId: string | null = null
): RunStore.RunRow => ({
  runId,
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
    flowName,
    payload,
    ...(result === undefined ? {} : { result }),
    ...(parentRunId === null ? {} : { parentExecutionId: parentRunId })
  })
})
const requestResult = (value: typeof RequestResult.Type) =>
  Schema.encodeSync(Schema.toCodecJson(Flow.Result({ success: Request.successSchema, error: Request.errorSchema })))(
    new Flow.Complete({ exit: Exit.succeed(value) })
  )
const pocResult = (value: PocResult) =>
  Schema.encodeSync(Schema.toCodecJson(Flow.Result({ success: Poc.successSchema, error: Poc.errorSchema })))(
    new Flow.Complete({ exit: Exit.succeed(value) })
  )
const modes = [
  "valid",
  "prepared",
  "prepared-wrong-input",
  "prepared-missing-source",
  "prepared-wrong-parent",
  "two-preparations",
  "forked-root",
  "trampoline-parent",
  "pending",
  "domain-blocked",
  "duplicate-receipt",
  "wrong-input",
  "wrong-wrapper",
  "wrong-control-flow",
  "missing-delegate",
  "wrong-bridge-input",
  "extra-parent",
  "missing-poc",
  "two-pocs",
  "poc-running",
  "poc-mismatch",
  "poc-wrong-parent",
  "collected",
  "oversized",
  "outside-vibe",
  "no-owner"
] as const
for (const mode of modes) {
  test(`vibe evidence: ${mode}`, async () => {
    const program = Effect.gen(function*() {
      const control = yield* ControlRuntime.ControlRuntime, graph = yield* DurableEngineState.DurableEngineState
      const { card } = yield* control.plan({
        flowId: mode === "wrong-control-flow" ? "other" : "coding/request",
        input
      })
      const token = yield* control.lookupApproval(card.approval.target)
      yield* control.resolveApproval(token, "approved", { id: "memory", kind: "test", stampedAt: 0 })
      const launch = yield* control.launch(card.planId, card.digest, card.envelope)
      assert.equal(launch._tag, "Started")
      if (launch._tag !== "Started") throw new Error("fixture must launch")
      const root = launch.run.runId
      const fence = yield* control.claimFence(root)
      assert(fence !== undefined)
      yield* control.writeStatus(root, fence!, mode === "pending" ? "running" : "completed")
      const retained = structuredClone(request)
      if (mode === "duplicate-receipt") {
        ;(retained.outcome.result!.changes[0]!.receipts as unknown[]).push(
          retained.outcome.result!.changes[0]!.receipts[0]
        )
      }
      const rows = new Map([
        [root, row(root, "agent/run", { planId: mode === "wrong-wrapper" ? "wrong" : card.planId })],
        [
          "delegate",
          row(
            "delegate",
            mode === "missing-delegate" ? "unrelated" : "coding/request",
            { input: mode === "wrong-bridge-input" ? { ...input, prompt: "forged" } : input },
            undefined,
            root
          )
        ],
        [
          "request",
          row(
            "request",
            Request._tag,
            mode === "wrong-input" ? { ...input, prompt: "forged" } : input,
            requestResult(
              mode === "domain-blocked"
                ? { ...retained, outcome: { ...retained.outcome, status: "blocked" } }
                : retained
            ),
            "delegate"
          )
        ],
        [
          "poc",
          row(
            "poc",
            Poc._tag,
            { plan: { ...plan, base: original, observedHead: original }, source: original },
            pocResult(mode === "poc-mismatch" ? { ...poc, source: intermediate } : poc),
            mode === "poc-wrong-parent" ? "delegate" : "request"
          )
        ]
      ])
      if (mode === "forked-root") rows.set(root, { ...rows.get(root)!, parentRunId: "old-control-root" })
      if (mode === "trampoline-parent") {
        rows.set("delegate", { ...row("delegate", "coding/request", { input }), parentRunId: root })
      }
      if (mode === "poc-running") {
        rows.set("poc", { ...rows.get("poc")!, status: "running" })
      }
      if (mode === "oversized") {
        rows.set("request", { ...rows.get("request")!, stateJson: " ".repeat(16 * 1024 * 1024 + 1) })
      }
      const prepared = mode.startsWith("prepared") || mode === "two-preparations"
      if (prepared) {
        const { observedHead: _, ...withoutSource } = plan
        const preparedPlan = {
          ...withoutSource,
          base: original,
          ...(mode === "prepared-missing-source" ? {} : { observedHead: original })
        }
        const result = Schema.encodeSync(
          Schema.toCodecJson(Flow.Result({ success: PrepareRequest.successSchema, error: PrepareRequest.errorSchema }))
        )(
          new Flow.Complete({ exit: Exit.succeed(preparedPlan) })
        )
        rows.set(
          "preparation",
          row(
            "preparation",
            PrepareRequest._tag,
            { prompt: mode === "prepared-wrong-input" ? "another request" : input.prompt, feedback: "" },
            result,
            mode === "prepared-wrong-parent" ? "delegate" : "request"
          )
        )
        rows.delete("poc")
        yield* graph.recordRunParent("preparation", mode === "prepared-wrong-parent" ? "delegate" : "request")
      }
      yield* graph.recordRunParent("request", "delegate")
      if (mode !== "trampoline-parent") yield* graph.recordRunParent("delegate", root)
      yield* graph.recordRunParent("poc", mode === "poc-wrong-parent" ? "delegate" : "request")
      if (mode === "extra-parent") yield* graph.recordRunParent("request", root)
      const catalog: RunCatalogRead.Service = {
        listRunIds: () => Effect.die("Vibe must not scan the global run catalog"),
        listRuns: (options) =>
          Effect.sync(() => {
            if (options?.filters?.flowName === PrepareRequest._tag) {
              assert.deepEqual(options, {
                filters: { flowName: PrepareRequest._tag, parentRunId: "request" },
                limit: 2
              })
              return {
                source: "0".repeat(32),
                revision: 1,
                cursor: null,
                runs: (prepared ? mode === "two-preparations" ? ["preparation", "another"] : ["preparation"] : []).map(
                  (runId) => ({
                    _tag: "Observed" as const,
                    runId,
                    source: "0".repeat(32),
                    revision: 1,
                    status: "completed" as const,
                    flowName: PrepareRequest._tag,
                    createdAtMs: 1,
                    startedAtMs: 1,
                    finishedAtMs: 2,
                    parentRunId: "request",
                    lineageId: root,
                    roundOrdinal: 0,
                    cancellation: { requestedAtMs: null, acknowledgement: null },
                    waiting: null
                  })
                )
              }
            }
            assert.deepEqual(options, { filters: { flowName: Poc._tag, parentRunId: "request" }, limit: 2 })
            return {
              source: "0".repeat(32),
              revision: 1,
              cursor: null,
              runs: (mode === "missing-poc" ? [] : mode === "two-pocs" ? ["poc", "second"] : ["poc"]).map((runId) => ({
                _tag: "Observed" as const,
                runId,
                source: "0".repeat(32),
                revision: 1,
                status: "completed" as const,
                flowName: Poc._tag,
                createdAtMs: 1,
                startedAtMs: 1,
                finishedAtMs: 2,
                parentRunId: "request",
                lineageId: root,
                roundOrdinal: 0,
                cancellation: { requestedAtMs: null, acknowledgement: null },
                waiting: null
              }))
            }
          })
      }
      const read = readVibeRequest({ requestExecutionId: "request" })
      return yield* (mode === "no-owner" ? read : read.pipe(
        Effect.provideService(ModuleOwner, {
          rootId: "vibe-control",
          flowId: mode === "outside-vibe" ? "coding/request" : "coding/vibe"
        })
      )).pipe(
        Effect.provideService(RunCatalogRead.RunCatalogRead, catalog),
        Effect.provide(RunStore.layerNoop({
          get: (id) =>
            rows.has(id) && !(mode === "collected" && id === "delegate")
              ? Effect.succeed(rows.get(id)!) :
              Effect.fail(
                new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "collected", cause: null })
              )
        }))
      )
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          DurableEngineState.layerMemory,
          ControlRuntime.layerMemory({
            flows: ["coding/request", "other"].map((flowId) => ({
              flowId,
              description: "fixture",
              deployClass: false,
              envelope: { capabilities: [], flows: [], budget: {} }
            }))
          }).pipe(Layer.provide(NodeServices.layer))
        )
      )
    )
    if (mode === "valid" || mode === "prepared" || mode === "forked-root" || mode === "trampoline-parent") {
      const result = await Effect.runPromise(program)
      assert.deepEqual(
        result.originalSource,
        original,
        "source comes from the original receipt, not the newer steered Plan"
      )
      if (mode === "prepared") {
        assert("preparationExecutionId" in result)
        assert.equal(result.preparationExecutionId, "preparation")
        assert.equal("pocExecutionId" in result, false)
      }
      assert.deepEqual(result.request.plan.observedHead, intermediate)
      assert.equal(result.controlRunId, "run-1")
    } else {
      const error = await Effect.runPromise(Effect.flip(program))
      assert(error instanceof CodingError)
      assert.equal(error.code, "invalid_receipt")
    }
  })
}

/** The stack launches coding/request through the registry and hands coding/vibe the control run it launched. */
const stackModes = [
  "stack-prepared",
  "stack-poc-without-base",
  "stack-no-request",
  "stack-two-requests",
  "stack-more-pages"
] as const
const stackTip = "a".repeat(40)
const stackBase = {
  commitId: stackTip,
  ref: `refs/smithers/workspaces/0f8fad5b-d9cb-469f-a165-70867728950e/sources/${stackTip}`
}
const listed = (
  flowName: string,
  parentRunId: string,
  runIds: ReadonlyArray<string>,
  cursor: string | null = null
) => ({
  source: "0".repeat(32),
  revision: 1,
  cursor,
  runs: runIds.map((runId) => ({
    _tag: "Observed" as const,
    runId,
    source: "0".repeat(32),
    revision: 1,
    status: "completed" as const,
    flowName,
    createdAtMs: 1,
    startedAtMs: 1,
    finishedAtMs: 2,
    parentRunId,
    lineageId: parentRunId,
    roundOrdinal: 0,
    cancellation: { requestedAtMs: null, acknowledgement: null },
    waiting: null
  }))
})
for (const mode of stackModes) {
  test(`vibe evidence from a stack launch: ${mode}`, async () => {
    const legacy = mode === "stack-poc-without-base"
    const stackInput = legacy ? input : { ...input, base: stackBase }
    const queries: Array<unknown> = []
    const program = Effect.gen(function*() {
      const control = yield* ControlRuntime.ControlRuntime, graph = yield* DurableEngineState.DurableEngineState
      const { card } = yield* control.plan({ flowId: "coding/request", input: stackInput })
      const token = yield* control.lookupApproval(card.approval.target)
      yield* control.resolveApproval(token, "approved", { id: "memory", kind: "test", stampedAt: 0 })
      const launch = yield* control.launch(card.planId, card.digest, card.envelope)
      if (launch._tag !== "Started") throw new Error("fixture must launch")
      const root = launch.run.runId
      const fence = yield* control.claimFence(root)
      assert(fence !== undefined)
      yield* control.writeStatus(root, fence, "completed")
      // The registry persists the request under its registered name with delegate.call inlined:
      // one coding/request row holds both the invocation input and the request's result.
      const rows = new Map([
        [root, row(root, "agent/run", { planId: card.planId })],
        ["request", row("request", "coding/request", { input: stackInput }, requestResult(request), root)]
      ])
      yield* graph.recordRunParent("request", root)
      if (legacy) {
        rows.set(
          "poc",
          row(
            "poc",
            Poc._tag,
            { plan: { ...plan, base: original, observedHead: original }, source: original },
            pocResult(poc),
            "request"
          )
        )
        yield* graph.recordRunParent("poc", "request")
      } else {
        const { observedHead: _, ...withoutSource } = plan
        const result = Schema.encodeSync(
          Schema.toCodecJson(Flow.Result({ success: PrepareRequest.successSchema, error: PrepareRequest.errorSchema }))
        )(new Flow.Complete({ exit: Exit.succeed({ ...withoutSource, base: original, observedHead: original }) }))
        rows.set(
          "preparation",
          row("preparation", PrepareRequest._tag, { prompt: input.prompt, feedback: "" }, result, "request")
        )
        yield* graph.recordRunParent("preparation", "request")
      }
      const requests = mode === "stack-no-request"
        ? []
        : mode === "stack-two-requests"
        ? ["request", "second"]
        : ["request"]
      const catalog: RunCatalogRead.Service = {
        listRunIds: () => Effect.die("Vibe must not scan the global run catalog"),
        listRuns: (options) =>
          Effect.sync(() => {
            queries.push(options)
            const parent = options?.filters?.parentRunId
            switch (options?.filters?.flowName) {
              case "coding/request":
                return listed(
                  "coding/request",
                  root,
                  parent === root ? requests : [],
                  mode === "stack-more-pages" ? "next" : null
                )
              case PrepareRequest._tag:
                return listed(PrepareRequest._tag, "request", !legacy && parent === "request" ? ["preparation"] : [])
              default:
                return listed(Poc._tag, "request", legacy && parent === "request" ? ["poc"] : [])
            }
          })
      }
      const outcome = yield* Effect.result(readVibeRequest({ requestExecutionId: root })).pipe(
        Effect.provideService(ModuleOwner, { rootId: "vibe-control", flowId: "coding/vibe" }),
        Effect.provideService(RunCatalogRead.RunCatalogRead, catalog),
        Effect.provide(RunStore.layerNoop({
          get: (id) =>
            rows.has(id) ? Effect.succeed(rows.get(id)!) : Effect.fail(
              new RunStore.RunStoreError({ code: "not_found_row", method: "get", message: "absent", cause: null })
            )
        }))
      )
      return { root, outcome }
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          DurableEngineState.layerMemory,
          ControlRuntime.layerMemory({
            flows: [{
              flowId: "coding/request",
              description: "fixture",
              deployClass: false,
              envelope: { capabilities: [], flows: [], budget: {} }
            }]
          }).pipe(Layer.provide(NodeServices.layer))
        )
      )
    )
    const { root, outcome } = await Effect.runPromise(program)
    // The control run's one coding/request child is the request; nothing scans wider.
    assert.deepEqual(queries[0], { filters: { flowName: "coding/request", parentRunId: root }, limit: 2 })
    if (mode === "stack-prepared" || mode === "stack-poc-without-base") {
      assert.equal(outcome._tag, "Success")
      if (outcome._tag !== "Success") return
      const evidence = outcome.success
      assert.equal(evidence.requestExecutionId, root, "the stack's control run stays the request it names")
      assert.equal(evidence.controlRunId, root)
      assert.deepEqual(evidence.originalSource, original)
      // The original source is read from the selected request's own child, not the control run's.
      assert.deepEqual(
        queries.slice(1).map((query) => (query as { filters: { parentRunId: string } }).filters.parentRunId),
        legacy ? ["request", "request"] : ["request"]
      )
      if (legacy) {
        assert.equal("pocExecutionId" in evidence && evidence.pocExecutionId, "poc")
        assert.equal(evidence.fromStack, false, "a request with no stack base is not handed back to a stack")
      } else {
        assert.equal("preparationExecutionId" in evidence && evidence.preparationExecutionId, "preparation")
        assert.equal(evidence.fromStack, true, "a request started from a stack base returns its result to the stack")
      }
    } else {
      assert.equal(outcome._tag, "Failure")
      if (outcome._tag !== "Failure") return
      assert(outcome.failure instanceof CodingError)
      assert.equal(outcome.failure.code, "invalid_receipt")
      assert.equal(outcome.failure.message, "Select a native coding/Request execution")
      assert.equal(queries.length, 1, "an ambiguous or missing request reads nothing further")
    }
  })
}
