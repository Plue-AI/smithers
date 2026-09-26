import { DurableEngineState } from "@smthrs/engine-store"
import { Action } from "@smthrs/flow"
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import { Cause, Effect, Exit, Layer, ManagedRuntime, Option } from "effect"
import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as NodeJj from "../../packages/smithers/flows/jj/src/node/NodeJj.ts"
import { EarlyFeedback, feedbackLayers, ObservePlan } from "../coding/feedback.ts"
import {
  checkInputDigest,
  CodingError,
  type Implementation,
  type Plan,
  type Receipt,
  type Revision
} from "../coding/schema.ts"
import { Implement, policyLayers, RunCheck } from "../coding/workflow.ts"

const revision = (name: string, parent?: string): Revision => ({
  changeId: `jj-${name}`,
  commitId: `commit-${name}`,
  treeId: `tree-${name}`,
  operationId: `op-${name}`,
  parentCommitIds: parent ? [`commit-${parent}`] : []
})
const plan: Plan = {
  prompt: "Observe actionable feedback",
  memoryRevision: "fixture",
  base: revision("base"),
  changes: ["prefix", "owner", "tip"].map((id) => ({
    id,
    title: id,
    intent: id,
    implementation: "implementation",
    implementationDigest: "0".repeat(64),
    atoms: [{ changeId: null, message: `✨ feat: ${id}`, intent: id, reads: [], writes: [`${id}.txt`] }],
    checks: ["fast", "slow"].map((tier) => ({
      id: tier,
      target: tier,
      flow: tier,
      flowDigest: "0".repeat(64),
      tier: tier as "fast" | "slow",
      required: true
    }))
  }))
}
const implementation = (index: number, parent: Revision): Implementation => {
  const change = plan.changes[index]!, head = revision(change.id, index === 0 ? "base" : plan.changes[index - 1]!.id)
  return { change: change.id, parent, atoms: [head], head, reads: [], writes: [`${change.id}.txt`] }
}

for (const mode of ["owner", "source", "digest"] as const) {
  test(
    `native feedback: invalid ${mode} waits for the held writer despite valid first feedback`,
    { timeout: 180_000 },
    async (t) => {
      const root = await mkdtemp(join(tmpdir(), "coding-feedback-boundary-"))
      execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
      await writeFile(join(root, ".gitignore"), ".flows/\n")
      const executionId = `feedback-invalid-${mode}-held-writer`
      const events: string[] = []
      let releaseTip!: () => void, enterTip!: () => void
      const tipReleased = new Promise<void>((resolve) => {
        releaseTip = resolve
      })
      const tipEntered = new Promise<void>((resolve) => {
        enterTip = resolve
      })
      const saved = (deferredName: string) =>
        Effect.flatMap(
          DurableEngineState.DurableEngineState,
          (state) => state.deferred({ flowName: ObservePlan._tag, executionId, deferredName })
        )
      const waitSaved = (deferredName: string) =>
        Effect.gen(function*() {
          for (let attempt = 0; attempt < 3000; attempt++) {
            const row = yield* saved(deferredName)
            if (Option.isSome(row)) return row.value
            yield* Effect.sleep("10 millis")
          }
          return yield* Effect.die(new Error(`Timed out waiting for ${deferredName}`))
        })
      const HostRuntime = process.versions.bun ? await import("@smthrs/flows/BunRuntime") : NodeRuntime
      const runtime = HostRuntime.layerHost(
        {
          filename: join(root, ".flows", "engine.db"),
          workspaceRoot: root,
          owner: { hostId: "feedback-boundary-test" },
          signals: []
        },
        Layer.mergeAll(
          policyLayers,
          feedbackLayers,
          Implement.toLayer(({ change, parent }) =>
            Effect.gen(function*() {
              if (change.id === "tip") {
                events.push("tip:writing")
                enterTip()
                yield* Effect.promise(() => tipReleased).pipe(Effect.onInterrupt(() =>
                  Effect.sync(() => {
                    events.push("tip:interrupted")
                  })
                ))
              }
              events.push(`implemented:${change.id}`)
              return implementation(plan.changes.findIndex((value) => value.id === change.id), parent)
            })
          ),
          RunCheck.toLayer(({ implementation, check }) =>
            Effect.gen(function*() {
              const receipt: Receipt = {
                change: implementation.change,
                checkId: check.id,
                target: check.target,
                tier: check.tier,
                commitId: implementation.head.commitId,
                treeId: implementation.head.treeId,
                inputDigest: checkInputDigest(implementation, check),
                status: "passed",
                evidence: "scripted check",
                findings: []
              }
              if (check.tier === "fast" || implementation.change === "tip") return receipt
              if (implementation.change === "prefix") {
                return {
                  ...receipt,
                  status: "failed" as const,
                  findings: [{
                    owner: "prefix",
                    sourceCommitId: implementation.head.commitId,
                    message: "Valid earlier finding"
                  }]
                }
              }
              // Ensure this malformed receipt arrives while the later writer is active,
              // after a different valid receipt has already won the first-feedback slot.
              yield* Effect.promise(() => tipEntered)
              yield* waitSaved("coding/feedback/first-actionable")
              events.push("owner:invalid")
              return {
                ...receipt,
                status: "failed" as const,
                ...(mode === "digest" ? { inputDigest: "f".repeat(64) } : {}),
                findings: [{
                  owner: mode === "owner" ? "tip" : "owner",
                  sourceCommitId: mode === "source" ? "stale" : implementation.head.commitId,
                  message: "Malformed later receipt"
                }]
              }
            })
          )
        ).pipe(Layer.provideMerge(Action.layerImplementations))
      )
        .pipe(Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000)))
      let host = ManagedRuntime.make(runtime)
      t.after(async () => {
        releaseTip()
        await host.dispose()
        await rm(root, { recursive: true, force: true })
      })
      const running = host.runPromise(ObservePlan.execute({ plan }, { executionId }).pipe(Effect.exit))
      const recorded = await host.runPromise(Effect.raceFirst(
        waitSaved("coding/feedback/invalid-receipt").pipe(Effect.map((row) => ({ kind: "recorded" as const, row }))),
        Effect.promise(() => running).pipe(Effect.map((result) => ({ kind: "terminal" as const, result })))
      ))
      if (recorded.kind === "terminal") {
        assert.ok(Exit.isFailure(recorded.result))
        const failure = recorded.result.cause.reasons.find(Cause.isFailReason)
        assert.ok(failure?.error instanceof CodingError, Cause.pretty(recorded.result.cause))
        assert.equal(failure.error.code, "invalid_receipt")
        assert.ok(events.includes("tip:interrupted"), "baseline refusal interrupted the held writer")
      }
      assert.equal(
        recorded.kind,
        "recorded",
        "receipt validation must be durably retained while the later writer remains active"
      )
      assert.deepEqual(events, ["implemented:prefix", "implemented:owner", "tip:writing", "owner:invalid"])
      assert.equal(Option.isNone(await host.runPromise(saved("coding/feedback/implementations-ready"))), true)
      assert.equal(Option.isSome(await host.runPromise(saved("coding/feedback/first-actionable"))), true)
      releaseTip()
      const result = await running
      assert.ok(Exit.isFailure(result))
      const reason = result.cause.reasons.find(Cause.isFailReason)
      assert.ok(reason?.error instanceof CodingError, Cause.pretty(result.cause))
      assert.equal(reason.error.code, "invalid_receipt", "valid first feedback cannot mask malformed later evidence")
      assert.ok(events.includes("implemented:tip"), "all native identities exist before refusal")
      assert.ok(!events.includes("tip:interrupted"), "receipt validation cannot cancel an in-progress writer")
      const originalEvents = [...events]
      await host.dispose()
      host = ManagedRuntime.make(runtime)
      const replay = await host.runPromise(ObservePlan.execute({ plan }, { executionId }).pipe(Effect.exit))
      assert.ok(Exit.isFailure(replay))
      const replayReason = replay.cause.reasons.find(Cause.isFailReason)
      assert.ok(replayReason?.error instanceof CodingError)
      assert.equal(replayReason.error.code, "invalid_receipt")
      assert.deepEqual(
        events,
        originalEvents,
        "cold replay preserves the typed refusal without repeating writers or checks"
      )
    }
  )
}

for (
  const mode of [
    "early-before-tip",
    "early-after-tip",
    "later-check-pending",
    "all-pass",
    "invalid-owner",
    "invalid-source",
    "fast-failure",
    "late-fast-failure"
  ] as const
) {
  test(`native feedback: ${mode}`, { timeout: 180_000 }, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "coding-feedback-"))
    t.after(() => rm(root, { recursive: true, force: true }))
    execFileSync("jj", ["git", "init", root], { stdio: "pipe" })
    await writeFile(join(root, ".gitignore"), ".flows/\n")
    const events: string[] = []
    let released = 0
    let findingReady!: () => void
    const finding = new Promise<void>((resolve) => {
      findingReady = resolve
    })
    let pendingReady!: () => void
    const pending = new Promise<void>((resolve) => {
      pendingReady = resolve
    })
    const early = mode.startsWith("early") || mode === "later-check-pending"
    const HostRuntime = process.versions.bun ? await import("@smthrs/flows/BunRuntime") : NodeRuntime
    const runtime = HostRuntime.layerHost(
      {
        filename: join(root, ".flows", "engine.db"),
        workspaceRoot: root,
        owner: { hostId: "feedback-test" },
        signals: []
      },
      Layer.mergeAll(
        policyLayers,
        feedbackLayers,
        Implement.toLayer(({ change, parent }) =>
          Effect.gen(function*() {
            if ((mode === "early-before-tip" || mode === "late-fast-failure") && change.id === "tip") {
              yield* Effect.promise(() => finding)
            }
            events.push(`implement:${change.id}`)
            return implementation(plan.changes.findIndex((value) => value.id === change.id), parent)
          })
        ),
        RunCheck.toLayer(({ implementation, check }) =>
          Effect.gen(function*() {
            const receipt: Receipt = {
              change: implementation.change,
              checkId: check.id,
              target: check.target,
              tier: check.tier,
              commitId: implementation.head.commitId,
              treeId: implementation.head.treeId,
              inputDigest: checkInputDigest(implementation, check),
              status: "passed",
              evidence: "scripted check",
              findings: []
            }
            if (
              early && check.tier === "slow" &&
              implementation.change === (mode === "later-check-pending" ? "tip" : "prefix")
            ) {
              events.push(`${implementation.change}:waiting`)
              pendingReady()
              return yield* Effect.never.pipe(Effect.ensuring(Effect.sync(() => {
                released++
              })))
            }
            if (
              (mode === "fast-failure" || (mode === "late-fast-failure" && implementation.change === "tip")) &&
              check.tier === "fast"
            ) return { ...receipt, status: "failed" as const }
            if (
              mode !== "all-pass" && mode !== "fast-failure" && check.tier === "slow" &&
              implementation.change === "owner"
            ) {
              if (mode === "early-after-tip") yield* Effect.sleep("250 millis")
              if (mode === "later-check-pending") yield* Effect.promise(() => pending)
              events.push("owner:finding")
              findingReady()
              return {
                ...receipt,
                status: "failed" as const,
                findings: [{
                  owner: mode === "invalid-owner" ? "tip" : "owner",
                  sourceCommitId: mode === "invalid-source" ? "stale" : implementation.head.commitId,
                  message: "Fix owner"
                }]
              }
            }
            return receipt
          })
        )
      ).pipe(Layer.provideMerge(Action.layerImplementations))
    )
      .pipe(Layer.provide(Layer.succeed(NodeJj.StartupTimeoutMs, 30_000)))
    const result = await Effect.runPromise(
      ObservePlan.execute({ plan }, { executionId: `feedback-${mode}` }).pipe(
        Effect.exit,
        Effect.scoped,
        Effect.provide(runtime)
      )
    )
    if (mode === "all-pass") {
      assert.equal(Exit.isSuccess(result), true)
      return
    }
    assert.ok(Exit.isFailure(result))
    const reason = result.cause.reasons.find(Cause.isFailReason)
    if (early) {
      assert.ok(reason?.error instanceof EarlyFeedback, Cause.pretty(result.cause))
      assert.equal(reason.error.result.changes.length, 3)
      assert.equal(reason.error.result.status, "changes-requested")
      assert.equal(
        reason.error.result.changes[mode === "later-check-pending" ? 2 : 0]!.receipts.length,
        1,
        "pending slow receipt is not fabricated"
      )
      assert.equal(released, 1, "unrelated slow action is interrupted and its scope closes")
      const recordedEvents = [...events]
      const replay = await Effect.runPromise(
        ObservePlan.execute({ plan }, { executionId: `feedback-${mode}` }).pipe(
          Effect.exit,
          Effect.scoped,
          Effect.provide(runtime)
        )
      )
      assert.ok(Exit.isFailure(replay))
      const repeated = replay.cause.reasons.find(Cause.isFailReason)
      assert.ok(repeated?.error instanceof EarlyFeedback)
      assert.deepEqual(repeated.error.result, reason.error.result)
      assert.deepEqual(
        events,
        recordedEvents,
        "cold host replay retains the first feedback decision without executing checks or implementation"
      )
      const order = events.indexOf("owner:finding") - events.indexOf("implement:tip")
      assert.ok(mode === "early-before-tip" ? order < 0 : order > 0)
    } else {
      assert.ok(!(reason?.error instanceof EarlyFeedback))
      assert.match(
        Cause.pretty(result.cause),
        (mode === "fast-failure" || mode === "late-fast-failure") ? /did not pass/ : /invalid owner or source revision/
      )
      if (mode === "fast-failure") assert.deepEqual(events, ["implement:prefix"])
      if (mode === "late-fast-failure") {
        assert.ok(
          events.includes("owner:finding"),
          "a recorded first finding cannot leave the failed implementation branch waiting for all IDs"
        )
      }
    }
  })
}
