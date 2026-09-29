import * as DurableEngineState from "@smthrs/engine-store/DurableEngineState"
import { Action, Graph, HumanTask, Interpreter } from "@smthrs/flow"
import * as DurableDeferred from "@smthrs/flow/DurableDeferred"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Effect, Exit, Layer, Option, Schema } from "effect"
import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { join } from "node:path"
import { test } from "node:test"
import { promisify } from "node:util"
import { releaseGateArgs, releaseGateCommand, releaseGates } from "../../scripts/release-gates.mjs"
import ReleaseContent from "../release-content/flow.ts"
import * as Content from "../release-content/workflow.ts"
import { contentInput, releaseInput } from "../release-support/input.ts"
import { commandRunner } from "../release-support/io.ts"
import { actionLayers, operations } from "../release-support/operations.ts"
import { agentLayers } from "../release-support/runtime.ts"
import { type Candidate, ReleaseError } from "../release-support/schema.ts"
import ReleaseFlow from "../release/flow.ts"
import * as Release from "../release/workflow.ts"
import { evidence, repository, scriptedSeats, scriptedTemplate } from "./fixtures.ts"

test("content approval survives exit and restart in a different Node process", { timeout: 60_000 }, async (test) => {
  const fixture = await repository(test)
  const worker = join(import.meta.dirname, "resume-worker.ts")
  const start = await promisify(execFile)(process.execPath, [worker, fixture.root, "start"])
  const resume = await promisify(execFile)(process.execPath, [worker, fixture.root, "resume"])
  const first = JSON.parse(start.stdout.trim().split("\n").at(-1)!)
  const last = JSON.parse(resume.stdout.trim().split("\n").at(-1)!)
  assert.equal(first.result.status, "waiting")
  assert.equal(last.result.status, "approved")
  assert.deepEqual(last.counts, first.counts)
})

const waiting = (id: string) =>
  Effect.gen(function*() {
    const state = yield* DurableEngineState.DurableEngineState
    const row = yield* state.waiting(id)
    assert.ok(Option.isSome(row), "run must actually park in the durable engine")
    assert.equal(row.value.reason, "approval")
    return Schema.decodeUnknownSync(DurableDeferred.Token)(row.value.token)
  })

test("planning contains the bounded revision loop and no disabled drafting stages", () => {
  const input = contentInput({ channels: { blog: false, thread: false }, maxRevisions: 2 }, evidence.version)
  const calls = [...Graph.nodes(Graph.build(ReleaseContent, input))]
    .filter((node) => node.kind === "ActionCall")
    .map((node) => (node.ast as { action: string }).action)
  assert.equal(calls.filter((name) => name === "release-content/revise").length, 2)
  assert.equal(calls.includes("release-content/draft-blog"), false)
  assert.equal(calls.includes("release-content/draft-thread"), false)
  assert.equal(calls.includes("release-content/post-thread"), false)
  assert.equal(calls.includes("system/human-task"), false)
})

test(
  "real agents draft, revise, and park; a fresh SQLite host resumes without redrafting",
  { timeout: 90_000 },
  async (test) => {
    const fixture = await repository(test)
    const counts: Record<string, number> = {}
    let collections = 0
    const filename = join(fixture.root, ".flows", "engine.db")
    const input = contentInput(
      { dryRun: false, from: "v0.35.0", channels: { blog: false, thread: false } },
      fixture.evidence.version
    )
    const engine = () =>
      NodeRuntime.layerHost(
        {
          filename,
          workspaceRoot: fixture.root,
          owner: { hostId: "release-content-test" },
          signals: []
        },
        Layer.mergeAll(
          actionLayers({
            root: fixture.root,
            evaluator: scriptedTemplate,
            run: async (command, args, opts) => {
              if (command === "git" && args[0] === "log") collections++
              return commandRunner(fixture.root)(command, args, opts)
            }
          }),
          agentLayers(scriptedSeats(counts, { failReviews: 1 }), 250_000, scriptedTemplate),
          HumanTask.layer,
          Interpreter.layer(ReleaseContent)
        ).pipe(Layer.provideMerge(Action.layerImplementations))
      )

    const token = await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        yield* ReleaseContent.execute(input, { executionId: "content-resume", discard: true })
        const polled = yield* ReleaseContent.poll("content-resume")
        if (Option.isSome(polled) && polled.value._tag === "Complete" && Exit.isFailure(polled.value.exit)) {
          return yield* Effect.failCause(polled.value.exit.cause)
        }
        return yield* waiting("content-resume")
      }).pipe(Effect.provide(engine()))
    ))
    assert.equal(counts.score, 2)
    assert.equal(counts.revise, 1)
    const before = { ...counts }
    const result = await Effect.runPromise(Effect.scoped(
      Effect.gen(function*() {
        yield* HumanTask.answer({ token, value: true })
        return yield* ReleaseContent.execute(input, { executionId: "content-resume" })
      }).pipe(Effect.provide(engine()))
    ))
    assert.equal(result.status, "approved")
    assert.deepEqual(counts, before)
    assert.equal(collections, 1)
  }
)

test("exhausted quality reviews fail before preview or publication", { timeout: 90_000 }, async (test) => {
  const fixture = await repository(test)
  const counts: Record<string, number> = {}
  const input = contentInput(
    { maxRevisions: 1, from: "v0.35.0", channels: { blog: false, thread: false } },
    fixture.evidence.version
  )
  const engine = NodeRuntime.layerHost(
    {
      filename: join(fixture.root, ".flows", "engine.db"),
      workspaceRoot: fixture.root,
      owner: { hostId: "release-quality-test" },
      signals: []
    },
    Layer.mergeAll(
      actionLayers({ root: fixture.root, evaluator: scriptedTemplate }),
      agentLayers(scriptedSeats(counts, { failReviews: 99 }), 250_000, scriptedTemplate),
      HumanTask.layer,
      Interpreter.layer(ReleaseContent)
    ).pipe(Layer.provideMerge(Action.layerImplementations))
  )
  await assert.rejects(
    Effect.runPromise(
      Effect.scoped(ReleaseContent.execute(input, { executionId: "quality" }).pipe(Effect.provide(engine)))
    ),
    /score|Explain restart behavior/
  )
  assert.equal(counts.score, 2)
  assert.equal(counts.revise, 1)
})

for (const decision of [true, false] as const) {
  test(
    `release preparation ${decision}: version and lock commands require approval`,
    { timeout: 60_000 },
    async (test) => {
      const fixture = await repository(test)
      const commands: string[] = []
      const counts: Record<string, number> = {}
      const input = releaseInput({
        version: "2.0.0",
        from: "v0.35.0",
        phase: "prepare",
        dryRun: false,
        requireContentApproval: false
      }, fixture.evidence.version)
      const engine = () =>
        NodeRuntime.layerHost(
          {
            filename: join(fixture.root, ".flows", "engine.db"),
            workspaceRoot: fixture.root,
            owner: { hostId: "release-prepare-test" },
            signals: []
          },
          Layer.mergeAll(
            actionLayers({
              root: fixture.root,
              evaluator: scriptedTemplate,
              run: async (command, args, options) => {
                if (command === "git") return commandRunner(fixture.root)(command, args, options)
                commands.push([command, ...args].join(" "))
                return ""
              }
            }),
            agentLayers(scriptedSeats(counts), 250_000, scriptedTemplate),
            HumanTask.layer,
            Interpreter.layer(ReleaseFlow)
          ).pipe(Layer.provideMerge(Action.layerImplementations))
        )
      const token = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          yield* ReleaseFlow.execute(input, { executionId: "prepare", discard: true })
          return yield* waiting("prepare")
        }).pipe(Effect.provide(engine()))
      ))
      assert.equal(commands.length, 0)
      const result = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          yield* HumanTask.answer({ token, value: decision })
          return yield* ReleaseFlow.execute(input, { executionId: "prepare" })
        }).pipe(Effect.provide(engine()))
      ))
      assert.equal(result.status, decision ? "prepared" : "declined")
      assert.equal(counts.audit, 1)
      if (decision) {
        assert.equal(commands.length, 5)
        assert.match(commands[0]!, /set-release-version.mjs 2.0.0/)
        assert.match(commands[1]!, /generate-changelog.mjs --version 2.0.0/)
        assert.match(commands[2]!, /install --lockfile-only --ignore-scripts/)
        assert.ok(commands.every((command) => !/publish|git commit|git tag|git push/.test(command)))
      } else assert.equal(commands.length, 0)
    }
  )
}

for (const decision of [true, false, "dry-run"] as const) {
  test(`release publication ${decision}: all gates precede approval, then only the chosen branch executes`, {
    timeout: 60_000
  }, async (test) => {
    const fixture = await repository(test)
    const calls: string[] = []
    const candidate: Candidate = {
      directory: ".flows/releases/npm/test",
      digest: "sha512-tested",
      sourceSha: fixture.evidence.sourceSha,
      version: fixture.evidence.version,
      packageCount: 49,
      approvalPrompt: "Publish the 49 exact tested packages?"
    }
    const input = releaseInput(
      { phase: "publish", dryRun: decision === "dry-run", requireContentApproval: false },
      fixture.evidence.version
    )
    const note = <A>(name: string, value: A) =>
      Effect.sync(() => {
        calls.push(name)
        return value
      })
    const engine = () =>
      NodeRuntime.layerHost(
        {
          filename: join(fixture.root, ".flows", "engine.db"),
          workspaceRoot: fixture.root,
          owner: { hostId: "release-publish-test" },
          signals: []
        },
        Layer.mergeAll(
          Release.AuditDocs.toLayer(() => note("audit", { passed: true, missing: [], explanation: "covered" })),
          Release.PreparePlan.toLayer(() => Effect.die("must not prepare during publication")),
          Release.WritePreparation.toLayer(() => Effect.die("must not write preparation during publication")),
          Content.Collect.toLayer(() => note("collect", fixture.evidence)),
          Release.Validate.toLayer(() => note("validate", fixture.evidence)),
          Release.Checks.toLayer(() => note("checks", fixture.evidence)),
          Release.Build.toLayer(() => note("build", fixture.evidence)),
          Release.Pack.toLayer(() => note("pack", candidate)),
          Release.Smoke.toLayer(({ runtime }) => note(`smoke-${runtime}`, candidate)),
          Release.VerifyCandidate.toLayer(() => note("verify", candidate)),
          Release.Publish.toLayer(() =>
            note("publish", {
              status: "published" as const,
              version: input.version,
              artifact: candidate.directory,
              published: ["smthrs"]
            })
          ),
          Release.Outcome.toLayer(Effect.succeed),
          HumanTask.layer,
          Interpreter.layer(ReleaseFlow)
        ).pipe(Layer.provideMerge(Action.layerImplementations))
      )
    if (decision === "dry-run") {
      const result = await Effect.runPromise(
        Effect.scoped(ReleaseFlow.execute(input, { executionId: "release" }).pipe(Effect.provide(engine())))
      )
      assert.equal(result.status, "preview")
    } else {
      const token = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          yield* ReleaseFlow.execute(input, { executionId: "release", discard: true })
          return yield* waiting("release")
        }).pipe(Effect.provide(engine()))
      ))
      assert.equal(calls.includes("publish"), false)
      const result = await Effect.runPromise(Effect.scoped(
        Effect.gen(function*() {
          yield* HumanTask.answer({ token, value: decision })
          return yield* ReleaseFlow.execute(input, { executionId: "release" })
        }).pipe(Effect.provide(engine()))
      ))
      assert.equal(result.status, decision ? "published" : "declined")
    }
    assert.deepEqual(calls, [
      "collect",
      "audit",
      "validate",
      "checks",
      "build",
      "pack",
      "smoke-26.4.0",
      "verify",
      ...(decision === true ? ["publish"] : [])
    ])
  })
}

test("a failed release gate prevents packing and publication", { timeout: 60_000 }, async (test) => {
  const fixture = await repository(test)
  let packed = false
  const input = releaseInput(
    { phase: "publish", dryRun: false, requireContentApproval: false },
    fixture.evidence.version
  )
  const engine = NodeRuntime.layerHost(
    {
      filename: join(fixture.root, ".flows", "engine.db"),
      workspaceRoot: fixture.root,
      owner: { hostId: "release-failed-check-test" },
      signals: []
    },
    Layer.mergeAll(
      Release.AuditDocs.toLayer(() => Effect.succeed({ passed: true, missing: [], explanation: "covered" })),
      Release.PreparePlan.toLayer(() => Effect.die("must not prepare during publication")),
      Release.WritePreparation.toLayer(() => Effect.die("must not write preparation during publication")),
      Content.Collect.toLayer(() => Effect.succeed(fixture.evidence)),
      Release.Validate.toLayer(() => Effect.succeed(fixture.evidence)),
      Release.Checks.toLayer(() => Effect.fail(new ReleaseError({ step: "checks", message: "tests failed" }))),
      Release.Pack.toLayer(() =>
        Effect.sync(() => {
          packed = true
          throw new Error("must not pack")
        })
      ),
      Release.Build.toLayer(() => Effect.die("must not build")),
      Release.Smoke.toLayer(() => Effect.die("must not smoke")),
      Release.VerifyCandidate.toLayer(() => Effect.die("must not verify")),
      Release.Publish.toLayer(() => Effect.die("must not publish")),
      Release.Outcome.toLayer(Effect.succeed),
      HumanTask.layer,
      Interpreter.layer(ReleaseFlow)
    ).pipe(Layer.provideMerge(Action.layerImplementations))
  )
  const result = await Effect.runPromise(
    Effect.scoped(Effect.exit(ReleaseFlow.execute(input, { executionId: "fail" })).pipe(Effect.provide(engine)))
  )
  assert.equal(Exit.isFailure(result), true)
  if (Exit.isFailure(result)) assert.match(JSON.stringify(result.cause), /tests failed/)
  assert.equal(packed, false)
})

test("the checks gate runs the whole shared release inventory and returns a receipt naming every gate", {
  timeout: 60_000
}, async (test) => {
  // The flow used to keep its own partial gate list, then a 12-gate inventory
  // of release.yml's 35; this pins the inventory as the single source, the
  // gates the review found missing by name, and the receipt the pack step
  // files with the candidate.
  const fixture = await repository(test)
  const gates: string[] = []
  const ops = operations({
    root: fixture.root,
    gates: { inventory: releaseGates, exceptions: [] },
    run: async (command, args, options) => {
      if (command !== "pnpm") return commandRunner(fixture.root)(command, args, options)
      assert.deepEqual(args.slice(0, 2), ["exec", "smthrs"])
      gates.push(args.slice(2).join(" "))
      return ""
    }
  })
  const checked = await ops.checks(fixture.evidence)
  assert.deepEqual(checked, {
    ...fixture.evidence,
    gates: { ran: releaseGates.map((gate) => gate.name), exceptions: [] }
  })
  assert.deepEqual(gates, releaseGates.map((gate) => releaseGateArgs(gate).join(" ")))
  assert.ok(gates.length >= 37, `${gates.length} gates is fewer than release.yml's publish job plus the flow's own two`)
  for (
    const command of [
      "ci //packages/... --jobs 2 --verbose",
      "test //scripts/... --verbose",
      "lint //:jsdocTree --verbose",
      "build //apps/app:check --verbose",
      "test //apps/app:unitTests --verbose",
      "ci //apps/server/... --verbose",
      "test //evals/agent:test --verbose",
      "build //evals/agent:check --verbose",
      "test //evals/swebench:offline --jobs 1 --verbose",
      "lint //:ci --verbose",
      "lint //:factoryProjection --verbose",
      "lint //:targetIndex --verbose",
      "test //packages/...:faults --jobs 1 --verbose",
      "test //packages/smithers/flows/engine-store:disasterRecovery --verbose",
      "test //crates/flows-jj:buildScript --verbose",
      "test //crates/flows-jj:wasmReproducibility --verbose"
    ]
  ) assert.ok(gates.includes(command), `${command} ran`)
  assert.ok(
    gates.indexOf("ci //packages/... --jobs 2 --verbose") <
      gates.indexOf("test //packages/...:faults --jobs 1 --verbose")
  )
  assert.ok(
    gates.indexOf("test //packages/...:faults --jobs 1 --verbose") <
      gates.indexOf("test //crates/flows-jj:wasmReproducibility --verbose")
  )
})

test("a declared exception is never run and is reported in the receipt instead of counted as passed", {
  timeout: 60_000
}, async (test) => {
  // Inject a partition independent of the test host: the fault
  // matrix moves from the inventory to the exceptions and the checks step must
  // skip exactly that command, run everything else, and say so in the receipt.
  const fixture = await repository(test)
  const skipped = releaseGates.find((gate) => gate.target === "//packages/...:faults")!
  const exception = {
    name: skipped.name,
    command: releaseGateCommand(skipped),
    reason: "this host has no exclusive resources"
  }
  const gates: string[] = []
  const ops = operations({
    root: fixture.root,
    gates: { inventory: releaseGates.filter((gate) => gate !== skipped), exceptions: [exception] },
    run: async (command, args, options) => {
      if (command !== "pnpm") return commandRunner(fixture.root)(command, args, options)
      gates.push(args.slice(2).join(" "))
      return ""
    }
  })
  const checked = await ops.checks(fixture.evidence)
  assert.equal(gates.includes("test //packages/...:faults --jobs 1 --verbose"), false, "the exception did not run")
  assert.equal(gates.length, releaseGates.length - 1, "every other gate ran")
  assert.deepEqual(checked.gates, {
    ran: releaseGates.filter((gate) => gate !== skipped).map((gate) => gate.name),
    exceptions: [exception]
  })
  assert.equal(checked.gates!.ran.includes(skipped.name), false, "the receipt never lists an exception as ran")
  // Pack refuses evidence that skipped the checks step altogether.
  await assert.rejects(ops.pack(fixture.evidence), /Release checks did not run/)
})

for (
  const target of [
    "//packages/...:faults",
    "//crates/flows-jj:wasmReproducibility",
    "//apps/app:unitTests",
    "//packages/smithers/flows/engine-store:disasterRecovery"
  ]
) {
  test(`a failing ${target} gate fails checks before any later gate runs`, { timeout: 60_000 }, async (test) => {
    const fixture = await repository(test)
    const after: string[] = []
    let failed = false
    const ops = operations({
      root: fixture.root,
      gates: { inventory: releaseGates, exceptions: [] },
      run: async (command, args, options) => {
        if (command !== "pnpm") return commandRunner(fixture.root)(command, args, options)
        if (failed) after.push(args.join(" "))
        if (args[3] === target) {
          failed = true
          throw new Error(`${target} failed`)
        }
        return ""
      }
    })
    await assert.rejects(ops.checks(fixture.evidence), new RegExp(`${target.replace(/[.]/g, "\\.")} failed`))
    assert.equal(failed, true, "the gate was invoked")
    assert.deepEqual(after, [], "no gate runs after the failure, so build and pack never start")
  })
}
