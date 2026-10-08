import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import { RunStore } from "@smthrs/run-store/RunStore"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { catalogLayers } from "../coding/catalog.ts"
import ImplementPlan from "../coding/flow.ts"
import {
  checkInputDigest,
  CodingError,
  Implementation as ImplementationSchema,
  Receipt as ReceiptSchema
} from "../coding/schema.ts"
import type { Check, Implementation, Plan, Receipt, Revision } from "../coding/schema.ts"
import { Implement, policyLayers, receiptFindings, RunCheck } from "../coding/workflow.ts"

const revision = (name: string, parent?: string): Revision => ({
  changeId: `jj-${name}`,
  commitId: `commit-${name}`,
  treeId: `tree-${name}`,
  operationId: `op-${name}`,
  parentCommitIds: parent === undefined ? [] : [`commit-${parent}`]
})
const plan: Plan = {
  prompt: "Build the database, then the server",
  memoryRevision: "sha256:memory",
  base: revision("base"),
  changes: ["database", "server"].map((id) => ({
    id,
    title: id,
    intent: `Implement ${id}`,
    implementation: `implement/${id}`,
    implementationDigest: "0".repeat(64),
    atoms: [{ changeId: null, message: `✨ feat: ${id}`, intent: id, reads: [], writes: [`src/${id}.ts`] }],
    checks: [
      {
        id: "build",
        target: "//:build",
        flow: "backpressure/build",
        flowDigest: "0".repeat(64),
        tier: "fast",
        required: true
      },
      { id: "review", target: "//:review", flow: "review", flowDigest: "0".repeat(64), tier: "slow", required: true },
      {
        id: "canary",
        target: "//:canary",
        flow: "delivery/canary",
        flowDigest: "0".repeat(64),
        tier: "delivery",
        required: true
      }
    ]
  }))
}
const implementation = (id: string): Implementation => {
  const parent = id === "database" ? "base" : "database"
  return {
    change: id,
    parent: parent === "database" ? revision(parent, "base") : revision(parent),
    atoms: [revision(id, parent)],
    head: revision(id, parent),
    reads: [],
    writes: [`src/${id}.ts`]
  }
}
const receipt = (impl: Implementation, check: Check): Receipt => ({
  checkId: check.id,
  target: check.target,
  tier: check.tier,
  change: impl.change,
  commitId: impl.head.commitId,
  treeId: impl.head.treeId,
  inputDigest: checkInputDigest(impl, check),
  status: "passed",
  evidence: "fixture build receipt",
  findings: []
})
const latch = () => {
  let release!: () => void
  const promise = new Promise<void>((resolve) => {
    release = resolve
  })
  return { await: Effect.promise(() => promise), release }
}
const fixture = async (t: TestContext) => {
  const root = await mkdtemp(join(tmpdir(), "smithers-coding-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
  await writeFile(join(root, ".gitignore"), ".flows/\n")
  return { root, filename: join(root, ".flows", "engine.db") }
}
const wiring = (
  fixture: { root: string; filename: string },
  implement: (input: typeof Implement.payloadSchema.Type) => Effect.Effect<Implementation, CodingError>,
  check: (input: typeof RunCheck.payloadSchema.Type) => Effect.Effect<Receipt, CodingError>
) =>
  NodeRuntime.layerHost(
    { filename: fixture.filename, workspaceRoot: fixture.root, owner: { hostId: "coding-test" }, signals: [] },
    Layer.mergeAll(
      policyLayers,
      Implement.toLayer(implement),
      RunCheck.toLayer(check),
      Interpreter.layer(ImplementPlan)
    )
      .pipe(Layer.provideMerge(Action.layerImplementations))
  )

test(
  "slow review overlaps later implementation while fast gates preserve the linear order",
  { timeout: 60_000 },
  async (t) => {
    const repo = await fixture(t), entered = latch(), advanced = latch(), events: string[] = []
    const runtime = wiring(repo, ({ change, parent }) =>
      Effect.gen(function*() {
        if (change.id === "server") {
          assert.equal(parent.commitId, "commit-database")
          yield* entered.await
          assert.ok(events.includes("build:database"))
          advanced.release()
        }
        events.push(`implement:${change.id}`)
        return implementation(change.id)
      }), ({ implementation: impl, check }) =>
      Effect.gen(function*() {
        assert.notEqual(check.tier, "delivery", "delivery belongs after vibing/landing")
        if (impl.change === "database" && check.tier === "slow") {
          events.push("slow:started")
          entered.release()
          yield* advanced.await
          events.push("slow:finished")
        } else events.push(`${check.id}:${impl.change}`)
        return receipt(impl, check)
      }))
    const result = await Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime))))
    assert.equal(result.status, "validated")
    assert.deepEqual(result.changes.map((change) => change.implementation.change), ["database", "server"])
    assert.ok(events.indexOf("implement:server") < events.indexOf("slow:finished"))
    assert.equal(result.changes[0]?.receipts.length, 2)
  }
)

test("a required fast failure blocks the next Change", { timeout: 60_000 }, async (t) => {
  const repo = await fixture(t), implemented: string[] = []
  const runtime = wiring(
    repo,
    ({ change }) =>
      Effect.sync(() => {
        implemented.push(change.id)
        return implementation(change.id)
      }),
    ({ implementation: impl, check }) =>
      Effect.succeed({ ...receipt(impl, check), status: check.tier === "fast" ? "failed" : "passed" })
  )
  await assert.rejects(
    Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime)))),
    /did not pass/
  )
  assert.deepEqual(implemented, ["database"])
})

for (const mode of ["red-first", "infra-first", "optional-infra", "real-red", "stale-infra"] as const) {
  test(`fast gate classifies ${mode} before advancing the stack`, { timeout: 60_000 }, async (t) => {
    const repo = await fixture(t), implemented: string[] = []
    const original = plan.changes[0]!
    const build = original.checks[0]!
    const outage: Check = {
      ...build,
      id: "service",
      target: "//:service",
      required: mode !== "optional-infra"
    }
    const change = {
      ...original,
      checks: [
        ...(mode === "infra-first" ? [outage, build] : [build, outage]),
        original.checks[1]!
      ]
    }
    const chosen = { ...plan, changes: [change, plan.changes[1]!] }
    const runtime = wiring(
      repo,
      ({ change }) =>
        Effect.sync(() => {
          implemented.push(change.id)
          return implementation(change.id)
        }),
      ({ implementation: impl, check }) =>
        Effect.succeed({
          ...receipt(impl, check),
          status: check.tier === "fast" ? "failed" as const : "passed" as const,
          ...(check.id === "service" && mode !== "real-red" ? { fault: "infra" as const } : {}),
          ...(check.id === "service" && mode === "stale-infra" ? { commitId: "stale" } : {})
        })
    )
    const result = await Effect.runPromise(
      Effect.scoped(ImplementPlan.execute({ plan: chosen }).pipe(Effect.provide(runtime), Effect.exit))
    )
    assert.ok(Exit.isFailure(result))
    const reason = result.cause.reasons.find(Cause.isFailReason)
    assert.ok(reason?.error instanceof CodingError, Cause.pretty(result.cause))
    assert.equal(
      reason.error.code,
      mode === "stale-infra" ? "invalid_receipt" : mode === "real-red" ? "fast_gate" : "check_infra"
    )
    assert.deepEqual(implemented, ["database"])
  })
}

test("slow infrastructure receipts refuse correction findings after exact validation", () => {
  const impl = implementation("database"), check = plan.changes[0]!.checks[1]!
  const failed: Receipt = { ...receipt(impl, check), status: "failed", fault: "infra" }
  const expected = (code: string) => (error: unknown) => error instanceof CodingError && error.code === code
  assert.throws(() => receiptFindings(plan, 0, impl, check, failed), expected("check_infra"))
  assert.throws(
    () =>
      receiptFindings(plan, 0, impl, check, {
        ...failed,
        findings: [{
          owner: "database",
          sourceCommitId: impl.head.commitId,
          message: "unavailable"
        }]
      }),
    expected("check_infra"),
    "an infrastructure message cannot become a code correction"
  )
  assert.throws(
    () => receiptFindings(plan, 0, impl, check, { ...failed, commitId: "old-commit" }),
    expected("invalid_receipt")
  )
  assert.throws(
    () =>
      receiptFindings(plan, 0, impl, check, {
        ...failed,
        findings: [{
          owner: "server",
          sourceCommitId: impl.head.commitId,
          message: "invalid owner"
        }]
      }),
    expected("invalid_receipt")
  )
  assert.deepEqual(
    receiptFindings(plan, 0, impl, check, {
      ...failed,
      fault: "factory"
    }),
    [{ owner: "database", sourceCommitId: impl.head.commitId, message: `${check.id}: failed` }]
  )
  for (const target of [".", "//:review", "same-target"]) {
    const named = { ...check, target }
    const namedPlan = { ...plan, changes: [{ ...plan.changes[0]!, checks: [named] }, ...plan.changes.slice(1)] }
    assert.deepEqual(
      receiptFindings(namedPlan, 0, impl, named, {
        ...receipt(impl, named),
        status: "failed",
        findings: []
      }),
      [{ owner: "database", sourceCommitId: impl.head.commitId, message: `${check.id}: failed` }]
    )
  }
  const legacy = { ...failed }
  delete legacy.fault
  assert.deepEqual(receiptFindings(plan, 0, impl, check, legacy), [
    { owner: "database", sourceCommitId: impl.head.commitId, message: `${check.id}: failed` }
  ])
})

test("a receipt from a previous commit cannot unlock the next Change", { timeout: 60_000 }, async (t) => {
  const repo = await fixture(t), implemented: string[] = []
  const runtime = wiring(repo, ({ change }) =>
    Effect.sync(() => {
      implemented.push(change.id)
      return implementation(change.id)
    }), ({ implementation: impl, check }) => Effect.succeed({ ...receipt(impl, check), commitId: "old-commit" }))
  await assert.rejects(
    Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime)))),
    /current revision/
  )
  assert.deepEqual(implemented, ["database"])
})

test("a late finding retains the earlier owner and prevents validation", { timeout: 60_000 }, async (t) => {
  const repo = await fixture(t)
  const runtime = wiring(
    repo,
    ({ change }) => Effect.succeed(implementation(change.id)),
    ({ implementation: impl, check }) =>
      Effect.succeed(
        impl.change === "server" && check.tier === "slow"
          ? {
            ...receipt(impl, check),
            status: "failed",
            findings: [{
              owner: "database",
              sourceCommitId: impl.head.commitId,
              message: "The database owns the missing constraint"
            }]
          }
          : receipt(impl, check)
      )
  )
  const result = await Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime))))
  assert.equal(result.status, "changes-requested")
  assert.equal(result.findings[0]?.owner, "database")
  assert.equal(result.findings[0]?.sourceCommitId, "commit-server")
})

test("invalid plan policy is refused before implementation starts", { timeout: 60_000 }, async (t) => {
  const repo = await fixture(t), called: string[] = []
  const invalid = {
    ...plan,
    changes: plan.changes.map((change) => ({
      ...change,
      checks: [...change.checks, change.checks[0]!]
    }))
  }
  const runtime = wiring(repo, ({ change }) =>
    Effect.sync(() => {
      called.push(change.id)
      return implementation(change.id)
    }), ({ implementation: impl, check }) => Effect.succeed(receipt(impl, check)))
  await assert.rejects(
    Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan: invalid }).pipe(Effect.provide(runtime)))),
    /Duplicate check/
  )
  assert.deepEqual(called, [])
})

test(
  "an implementation on a different parent cannot advance the mythical progression",
  { timeout: 60_000 },
  async (t) => {
    const repo = await fixture(t), implemented: string[] = []
    const runtime = wiring(repo, ({ change }) =>
      Effect.sync(() => {
        implemented.push(change.id)
        return {
          ...implementation(change.id),
          head: revision(change.id, "unrelated"),
          atoms: [revision(change.id, "unrelated")]
        }
      }), ({ implementation: impl, check }) => Effect.succeed(receipt(impl, check)))
    await assert.rejects(
      Effect.runPromise(Effect.scoped(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime)))),
      /linear progression/
    )
    assert.deepEqual(implemented, ["database"])
  }
)

test(
  "registered project flows persist native child lineage and replay without reimplementing",
  { timeout: 90_000 },
  async (t) => {
    const repo = await fixture(t), called: Array<{ flow: string; runId: string }> = []
    const DelegateAction = Action.make("coding-test/project-step", {
      payload: Executable.Invocation,
      success: Schema.Json
    })
    const Delegate = Flow.make("coding-test/project", {
      payload: Executable.Invocation,
      success: Schema.Json,
      body: (input) => DelegateAction.call(input)
    })
    for (const name of ["implement/database", "implement/server", "backpressure/build", "review"]) {
      const path = join(repo.root, "flows", name)
      await mkdir(path, { recursive: true })
      await writeFile(
        join(path, "flow.mdx"),
        "---\ndescription: Coding contract fixture.\nflows: [coding-test/project]\ncapabilities: []\n---\nRun the registered fixture.\n"
      )
    }
    const platform = Layer.merge(NodeFileSystem.layer, NodePath.layer)
    const executables = await Effect.runPromise(
      Effect.gen(function*() {
        const discovery = yield* Discovery.Discovery
        const found = yield* discovery.scan({ source: "project", root: join(repo.root, "flows"), naming: "path" })
        assert.equal(found.entries.length, 4)
        return yield* Effect.forEach(
          found.entries,
          (descriptor) => Executable.fromDescriptor(descriptor, { delegates: [Delegate] })
        )
      }).pipe(Effect.provide(Discovery.layer.pipe(Layer.provideMerge(platform))))
    )
    const digests = new Map(
      executables.map((executable) => [executable.descriptor.name, Descriptor.executionDigest(executable.descriptor)!])
    )
    const pinnedPlan = {
      ...plan,
      changes: plan.changes.map((change) => ({
        ...change,
        implementationDigest: digests.get(change.implementation)!,
        checks: change.checks.map((check) => ({ ...check, flowDigest: digests.get(check.flow) ?? check.flowDigest }))
      }))
    }
    const delegates = DelegateAction.toLayer((input) =>
      Effect.gen(function*() {
        const instance = yield* FlowRuntime.FlowInstance
        called.push({ flow: input.flow, runId: instance.executionId })
        if (input.flow.startsWith("implement/")) {
          const payload = yield* Schema.decodeUnknownEffect(Implement.payloadSchema)(input.input).pipe(Effect.orDie)
          return Schema.encodeSync(Schema.toCodecJson(ImplementationSchema))(implementation(payload.change.id))
        }
        const payload = yield* Schema.decodeUnknownEffect(RunCheck.payloadSchema)(input.input).pipe(Effect.orDie)
        return Schema.encodeSync(Schema.toCodecJson(ReceiptSchema))(receipt(payload.implementation, payload.check))
      })
    )
    const runtime = NodeRuntime.layerHost(
      { filename: repo.filename, workspaceRoot: repo.root, owner: { hostId: "coding-catalog-test" }, signals: [] },
      Layer.mergeAll(
        policyLayers,
        catalogLayers,
        delegates,
        Interpreter.layer(ImplementPlan),
        Interpreter.layer(Delegate),
        ...executables.map((executable) => executable.layer)
      )
        .pipe(
          Layer.provideMerge(Action.layerImplementations),
          Layer.provideMerge(Layer.succeed(Executable.Catalog, { executables, refused: [] }))
        )
    )
    const run = Effect.gen(function*() {
      const result = yield* ImplementPlan.execute({ plan: pinnedPlan }, {
        executionId: "coding-catalog-parent-" + "p".repeat(150)
      })
      const store = yield* RunStore
      for (const call of called) {
        const row = yield* store.get(call.runId)
        // RunStore.parentRunId is the trampoline predecessor. Spawn ancestry
        // lives in the engine state and its existing durable parent-edge table.
        assert.equal(JSON.parse(row.stateJson).parentExecutionId, "coding-catalog-parent-" + "p".repeat(150))
        assert.ok(call.runId.length <= 200, "nested catalog execution IDs remain bounded")
        assert.equal(row.status, "completed")
      }
      return result
    }).pipe(Effect.provide(runtime), Effect.scoped)
    assert.equal((await Effect.runPromise(run)).status, "validated")
    assert.equal(called.length, 6)
    assert.equal(new Set(called.map((call) => call.runId)).size, 6)
    assert.equal((await Effect.runPromise(run)).status, "validated")
    assert.equal(called.length, 6, "settled native executions must replay after the host is reopened")
    // `coding` IS this flow, so input the plan schema refuses is refused by the
    // declaration rather than by a delegate that decoded an envelope by hand.
    await assert.rejects(
      Effect.runPromise(
        ImplementPlan.execute({ plan: "malformed" } as never, { executionId: "coding-invalid-envelope" }).pipe(
          Effect.provide(runtime),
          Effect.scoped
        )
      ),
      /plan/
    )
    assert.equal(called.length, 6)
    const stalePlan = {
      ...pinnedPlan,
      changes: pinnedPlan.changes.map((change) => ({ ...change, implementationDigest: "f".repeat(64) }))
    }
    await assert.rejects(
      Effect.runPromise(
        ImplementPlan.execute({ plan: stalePlan }, { executionId: "coding-stale-definition" })
          .pipe(Effect.provide(runtime), Effect.scoped)
      ),
      /changed since this plan/
    )
    assert.equal(called.length, 6, "a changed executable definition must not start native implementation")
  }
)

test("a check receipt for different delegated inputs cannot unlock progression", { timeout: 60_000 }, async (t) => {
  const repo = await fixture(t), called: string[] = []
  const runtime = wiring(
    repo,
    ({ change }) =>
      Effect.sync(() => {
        called.push(change.id)
        return implementation(change.id)
      }),
    ({ implementation: impl, check }) => Effect.succeed({ ...receipt(impl, check), inputDigest: "sha256:wrong-inputs" })
  )
  await assert.rejects(
    Effect.runPromise(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime), Effect.scoped)),
    /current revision/
  )
  assert.deepEqual(called, ["database"])
})

test("head and parent evidence must agree on every native revision field", { timeout: 90_000 }, async (t) => {
  for (
    const [subject, field] of [
      ["head", "changeId"],
      ["head", "operationId"],
      ["head", "parentCommitIds"],
      ["parent", "changeId"],
      ["parent", "treeId"],
      ["parent", "operationId"],
      ["parent", "parentCommitIds"]
    ] as const
  ) {
    const repo = await fixture(t)
    const runtime = wiring(repo, ({ change }) =>
      Effect.succeed({
        ...implementation(change.id),
        [subject]: {
          ...implementation(change.id)[subject],
          [field]: field === "parentCommitIds" ? ["forged"] : "forged"
        }
      }), ({ implementation: impl, check }) => Effect.succeed(receipt(impl, check)))
    await assert.rejects(
      Effect.runPromise(ImplementPlan.execute({ plan }).pipe(Effect.provide(runtime), Effect.scoped)),
      /does not match the planned atoms/
    )
  }
})

test("an atom cannot be reused under a later nonadjacent Change", { timeout: 60_000 }, async (t) => {
  const repo = await fixture(t)
  const third = { ...plan.changes[1]!, id: "interface", title: "Interface" }
  const runtime = wiring(repo, ({ change }) =>
    Effect.succeed(
      change.id !== "interface" ? implementation(change.id) : {
        change: "interface",
        parent: revision("server", "database"),
        head: { ...revision("interface", "server"), changeId: "jj-database" },
        atoms: [{ ...revision("interface", "server"), changeId: "jj-database" }],
        reads: [],
        writes: []
      }
    ), ({ implementation: impl, check }) => Effect.succeed(receipt(impl, check)))
  await assert.rejects(
    Effect.runPromise(
      ImplementPlan.execute({ plan: { ...plan, changes: [...plan.changes, third] } })
        .pipe(Effect.provide(runtime), Effect.scoped)
    ),
    /more than one implemented owner/
  )
})
