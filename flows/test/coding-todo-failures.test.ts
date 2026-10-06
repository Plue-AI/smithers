import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { BudgetExceeded } from "@smthrs/agent/Budget"
import { SeatUnresolved } from "@smthrs/agent/Seat"
import { Action, Fault, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { HarnessError } from "@smthrs/harness/HarnessError"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as MemoryStore from "../../packages/smithers/agent/memory/src/MemoryStore.ts"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { atomError } from "../coding/atoms.ts"
import { catalogLayers } from "../coding/catalog.ts"
import { correctionLayers, SelectRepair } from "../coding/correction.ts"
import { nativeActions, NativeCoding, NativeCodingError } from "../coding/native.ts"
import { PrepareRequest } from "../coding/preparation.ts"
import { requestRegistration } from "../coding/request.ts"
import { checkInputDigest, CodingError, Implementation, type Plan, Receipt } from "../coding/schema.ts"
import { AdmitSource } from "../coding/source-admission.ts"
import { CreateStackBase, PrepareStackBase } from "../coding/stack.ts"
import { ReceiveFeedback } from "../coding/steering.ts"
import { TodoDelivery, todoLayers } from "../coding/todo.ts"
import { InstallDependencyPages } from "../coding/wiki-refresh.ts"
import { Implement, policyLayers, RunCheck } from "../coding/workflow.ts"
import Todo from "../todo/flow.ts"

const base = {
  changeId: "k".repeat(32),
  commitId: "a".repeat(40),
  treeId: "b".repeat(40),
  operationId: "1".repeat(128),
  parentCommitIds: []
}
const head = {
  changeId: "l".repeat(32),
  commitId: "c".repeat(40),
  treeId: "d".repeat(40),
  operationId: "2".repeat(128),
  parentCommitIds: [base.commitId]
}
const budget = new BudgetExceeded({
  scope: "tokens",
  onExceeded: "fail",
  used: 90,
  reserved: 5,
  max: 100,
  next: 10,
  message: "Repair budget exhausted"
})
const recovery = {
  requestId: "00000000-0000-4000-a000-000000000001",
  path: "recovery/1",
  files: [{ path: "hello.txt", preimage: "before", proposed: "after" }]
}
class ForeignFailure
  extends Schema.TaggedError<ForeignFailure>()("fixture/ForeignFailure", { message: Schema.String })
{}
const StepError = Schema.Union([atomError, ForeignFailure])
const cases = [
  ...(["implementation", "check"] as const).map((at) => ({
    at,
    error: new ForeignFailure({ message: "Foreign failure" }),
    expected: new CodingError({
      code: "execution",
      message: `Project flow ${at} failed: fixture/ForeignFailure: Foreign failure`,
      route: "implement"
    }),
    fault: "infra"
  })),
  {
    at: "implementation",
    error: new HarnessError({ code: "read_only_cap", message: "No edits made" }),
    fault: "factory"
  },
  {
    at: "implementation",
    error: new NativeCodingError({ code: "file_conflict", message: "File changed", recovery }),
    fault: "user"
  },
  {
    at: "check",
    error: new NativeCodingError({ code: "source_publication_unavailable", message: "Source offline" }),
    fault: "dependency"
  },
  { at: "check", error: budget, fault: "policy" },
  {
    at: "repair-read",
    error: new NativeCodingError({ code: "revision_conflict", message: "Revision moved" }),
    fault: "factory"
  },
  {
    at: "repair-read",
    error: new NativeCodingError({ code: "operation_conflict", message: "Operation moved" }),
    fault: "wait"
  },
  {
    at: "repair-read",
    error: new NativeCodingError({ code: "file_recovery_required", message: "Recover files", recovery }),
    fault: "user"
  },
  {
    at: "repair-read",
    error: new NativeCodingError({ code: "host_unavailable", message: "Host offline" }),
    fault: "infra"
  },
  {
    at: "repair-read",
    error: new NativeCodingError({ code: "request_conflict", message: "Request reused" }),
    fault: "bug"
  },
  { at: "repair-select", error: budget, fault: "policy" },
  {
    at: "repair-select",
    error: new SeatUnresolved({ seat: "coding/implement", message: "Configure model" }),
    fault: "user"
  },
  {
    at: "repair-select",
    error: new HarnessError({ code: "model_failed", message: "Model offline" }),
    fault: "dependency"
  }
] as const

// Real TODO/request/correction interpreters, discovered project flows and SQLite
// recovery. Only model/native operations and stack setup are scripted here.
for (const scenario of cases) {
  const name = `${scenario.at}/${"code" in scenario.error ? scenario.error.code : scenario.error._tag}`
  test(`TODO preserves ${name} and cold replays without more work`, { timeout: 90_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "coding-todo-fault-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
    await writeFile(join(root, ".gitignore"), ".flows/\n")
    const calls: Array<string> = []
    const Step = Action.make("todo-fault/project-step", {
      payload: Executable.Invocation,
      success: Schema.Json,
      error: StepError
    })
    const Delegate = Flow.make("todo-fault/project", {
      payload: Executable.Invocation,
      success: Schema.Json,
      error: StepError,
      body: (input) => Step.call(input)
    })
    for (const name of ["implementation", "check"]) {
      const directory = join(root, "flows", name)
      await mkdir(directory, { recursive: true })
      await writeFile(
        join(directory, "flow.mdx"),
        "---\ndescription: Failure boundary fixture.\nflows: [todo-fault/project]\ncapabilities: []\n---\nRun the fixture.\n"
      )
    }
    const executables = await Effect.runPromise(
      Effect.gen(function*() {
        const found = yield* (yield* Discovery.Discovery).scan({
          source: "project",
          root: join(root, "flows"),
          naming: "path"
        })
        return yield* Effect.forEach(
          found.entries,
          (descriptor) => Executable.fromDescriptor(descriptor, { delegates: [Delegate] })
        )
      }).pipe(
        Effect.provide(Discovery.layer.pipe(Layer.provideMerge(Layer.merge(NodeFileSystem.layer, NodePath.layer))))
      )
    )
    assert.equal(executables.length, 2)
    const digest = (name: string) =>
      Descriptor.executionDigest(executables.find((entry) => entry.descriptor.name === name)!.descriptor)!
    const plan: Plan = {
      prompt: "Correct a greeting",
      memoryRevision: "fixture",
      base,
      observedHead: base,
      changes: [{
        id: "greeting",
        title: "Greeting",
        intent: "Add greeting",
        implementation: "implementation",
        implementationDigest: digest("implementation"),
        atoms: [{ changeId: null, message: "Add greeting", intent: "Add greeting", reads: [], writes: ["hello.txt"] }],
        checks: ["fast", "slow"].map((tier) => ({
          id: tier,
          target: tier,
          flow: "check",
          flowDigest: digest("check"),
          tier: tier as "fast" | "slow",
          required: true
        }))
      }]
    }
    const registration = Layer.effectDiscard(Effect.gen(function*() {
      yield* (yield* FlowRuntime.FlowRuntime).register(PrepareRequest, () => Effect.succeed(plan))
    }))
    const layers = Layer.mergeAll(
      Interpreter.layer(Todo),
      requestRegistration,
      correctionLayers,
      policyLayers,
      catalogLayers,
      nativeActions,
      registration,
      Interpreter.layer(Delegate),
      ...executables.map((entry) => entry.layer),
      todoLayers(Evaluator.layerScripted(() => ({ route: { choice: "implement" } }))),
      InstallDependencyPages.toLayer(() => Effect.void),
      PrepareStackBase.toLayer(() =>
        Effect.succeed({
          operation: "create",
          requestId: recovery.requestId,
          expectedOperationId: base.operationId,
          target: base,
          description: ""
        })
      ),
      CreateStackBase.toLayer(() => Effect.succeed(base)),
      AdmitSource.toLayer(({ plan }) => Effect.succeed({ ...plan, observedHead: base })),
      ReceiveFeedback.toLayer(({ boundary }) => Effect.succeed({ boundary, messages: [] })),
      TodoDelivery.toLayer(() =>
        Effect.suspend(() => {
          calls.push("delivery")
          return Effect.fail(
            new CodingError({ code: "invalid_receipt", message: "Unvalidated request cannot deliver" })
          )
        })
      ),
      SelectRepair.toLayer(() =>
        Effect.suspend(() => {
          calls.push("repair-select")
          if (scenario.at === "repair-select") return Effect.fail(scenario.error)
          return Effect.die("Native failure must stop before selection")
        })
      ),
      Step.toLayer((input) =>
        Effect.gen(function*() {
          calls.push(input.flow)
          if (scenario.at === input.flow) return yield* Effect.fail(scenario.error)
          if (input.flow === "implementation") {
            const payload = yield* Schema.decodeUnknownEffect(Implement.payloadSchema)(input.input).pipe(Effect.orDie)
            return yield* Schema.encodeEffect(Schema.toCodecJson(Implementation))({
              change: payload.change.id,
              parent: payload.parent,
              atoms: [head],
              head,
              reads: [],
              writes: ["hello.txt"]
            }).pipe(Effect.orDie)
          }
          const payload = yield* Schema.decodeUnknownEffect(RunCheck.payloadSchema)(input.input).pipe(Effect.orDie)
          return yield* Schema.encodeEffect(Schema.toCodecJson(Receipt))({
            change: payload.implementation.change,
            checkId: payload.check.id,
            target: payload.check.target,
            tier: payload.check.tier,
            commitId: head.commitId,
            treeId: head.treeId,
            inputDigest: checkInputDigest(payload.implementation, payload.check),
            status: payload.check.tier === "slow" ? "failed" : "passed",
            evidence: "scripted check",
            findings: payload.check.tier === "slow"
              ? [{ owner: "greeting", sourceCommitId: head.commitId, message: "Fix greeting" }]
              : []
          }).pipe(Effect.orDie)
        })
      )
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(Layer.succeed(Executable.Catalog, { executables, refused: [] })),
      Layer.provide(Layer.succeed(NativeCoding, {
        sourcePublication: "local-only",
        read: () =>
          Effect.suspend(() => {
            calls.push("repair-read")
            if (scenario.at === "repair-read") return Effect.fail(scenario.error)
            return Effect.succeed({
              status: "read",
              operationId: head.operationId,
              head: { ...head, kind: "resolved" },
              revisions: [{ ...base, kind: "resolved" }, { ...head, kind: "resolved" }]
            })
          }),
        apply: () => Effect.die("Failure must stop before native writes"),
        publishOriginalSource: () => Effect.die("Failure must stop before publication")
      }))
    )
    const runtime = NodeRuntime.layerHost({
      filename: join(root, ".flows", "engine.db"),
      workspaceRoot: root,
      owner: { hostId: "todo-fault-test" },
      signals: []
    }, layers).pipe(
      Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000)),
      Layer.provideMerge(MemoryStore.layerNoop())
    )
    let firstCalls: ReadonlyArray<string> | undefined
    for (const phase of ["fresh", "reopened"]) {
      const host = ManagedRuntime.make(runtime)
      try {
        const result = await host.runPromise(
          Todo.execute({
            prompt: plan.prompt,
            maxRounds: 2,
            base: {
              commitId: base.commitId,
              ref: `refs/smithers/workspaces/${recovery.requestId}/sources/${base.commitId}`
            }
          }, { executionId: "todo-failure" }).pipe(Effect.exit)
        )
        assert.ok(Exit.isFailure(result), phase)
        const reason = result.cause.reasons.find(Cause.isFailReason)
        assert.ok(reason, Cause.pretty(result.cause))
        assert.ok(Schema.is(atomError)(reason.error), Cause.pretty(result.cause))
        assert.ok(calls.includes(scenario.at), `fixture must reach ${scenario.at}`)
        assert.deepEqual(
          Schema.encodeSync(Schema.toCodecJson(atomError))(reason.error),
          Schema.encodeSync(Schema.toCodecJson(atomError))("expected" in scenario ? scenario.expected : scenario.error),
          `${phase}: retain all failure evidence`
        )
        assert.equal(Fault.of(reason.error).class, scenario.fault)
        assert.ok(!calls.includes("delivery"), "failed work must not enter candidate delivery")
        if (phase === "fresh") {
          firstCalls = [...calls]
        } else assert.deepEqual(calls, firstCalls, "cold replay must not repeat models, checks, reads or writes")
      } finally {
        await host.dispose()
      }
    }
  })
}
