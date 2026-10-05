import { NodeCrypto } from "@effect/platform-node"
import { FlowEngine } from "@smthrs/engine"
import { Action, Poll, Sleep } from "@smthrs/flow"
import { Effect, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { test } from "node:test"
import type { AppendObservation, AppendPreparation } from "../coding/landing-schema.ts"
import { type BackendLanding, Landing, type LocalLanding } from "../coding/landing.ts"
import { NativeCoding, NativeCodingError } from "../coding/native.ts"
import { checkInputDigest, CodingError, type Implementation, type Plan, type Revision } from "../coding/schema.ts"
import { landerLayer } from "../coding/vibe-lander.ts"
import { landingLayers, LandVibe } from "../coding/vibe-landing.ts"
import { publicationLayers } from "../coding/vibe-publication.ts"
import type { VibeCleanup } from "../coding/vibe-schema.ts"
import { RunCheck } from "../coding/workflow.ts"

/** Native ID patterns: 32 letters k..z for changes, 40 hex for commits and trees. */
const ids: Record<string, [letter: string, hex: string]> = {
  original: ["k", "a"],
  earlier: ["l", "b"],
  first: ["m", "c"],
  last: ["n", "d"]
}
const revision = (name: string, parent?: string): Revision => ({
  changeId: ids[name]![0].repeat(32),
  commitId: ids[name]![1].repeat(40),
  treeId: ids[name]![1].repeat(39) + "e",
  operationId: "0".repeat(128),
  parentCommitIds: parent ? [ids[parent]![1].repeat(40)] : []
})
const original = revision("original"),
  base = revision("earlier", "original"),
  first = revision("first", "earlier"),
  last = revision("last", "first")
const plan: Plan = {
  prompt: "Finish",
  memoryRevision: "wiki",
  base,
  observedHead: base,
  changes: ["first", "last"].map((id) => ({
    id,
    title: id,
    intent: id,
    implementation: "coding/implementation",
    implementationDigest: "0".repeat(64),
    atoms: [{ changeId: null, message: `✨ feat: ${id}`, intent: id, reads: [], writes: [id] }],
    checks: [{
      id: "fast",
      target: "fast",
      flow: "checks/fast",
      flowDigest: "0".repeat(64),
      tier: "fast",
      required: true
    }]
  }))
}
const implementations: Implementation[] = [{
  change: "first",
  parent: base,
  atoms: [first],
  head: first,
  reads: [],
  writes: ["first"]
}, { change: "last", parent: first, atoms: [last], head: last, reads: [], writes: ["last"] }]
const result = {
  status: "validated" as const,
  findings: [],
  changes: implementations.map((implementation, index) => ({
    implementation,
    receipts: plan.changes[index]!.checks.map((check) => ({
      change: implementation.change,
      checkId: check.id,
      target: check.target,
      tier: check.tier,
      commitId: implementation.head.commitId,
      treeId: implementation.head.treeId,
      inputDigest: checkInputDigest(implementation, check),
      status: "passed" as const,
      findings: [],
      evidence: "fixture"
    }))
  }))
}
const cleanup: VibeCleanup = {
  summary: "✨ feat: finish the validated request",
  result,
  head: last,
  admission: {
    requestExecutionId: "request",
    controlRunId: "control",
    planId: "plan",
    planDigest: "digest",
    pocExecutionId: "poc",
    originalSource: original,
    validatedHead: last,
    request: { plan, outcome: { status: "validated", rounds: 1, blocked: null, result } }
  }
}
/** A request the stack launched from its base (the stack's tip): its result belongs to that stack. */
const stackTip = "7".repeat(40)
const fromStack: VibeCleanup = {
  ...cleanup,
  admission: { ...cleanup.admission, fromStack: true, originalSource: { ...original, parentCommitIds: [stackTip] } }
}
const main = "5".repeat(40)
/** The backend verifies through its own landing policy; no check runs in this host. */
const noChecks = RunCheck.toLayer(() => Effect.die("the backend lander never runs checks here"))
const preparation: AppendPreparation = {
  status: "prepared",
  target_bookmark: "main",
  expected_commit_id: main,
  source_commit_id: last.commitId,
  source_base_commit_id: main,
  changes: [base, first, last].map((atom) => ({ change_id: atom.changeId, commit_id: atom.commitId }))
}
const landed = (status: AppendObservation["status"]) =>
  ({
    status,
    task_id: 12,
    request: {
      change_ids: preparation.changes.map((change) => change.commit_id),
      target_bookmark: "main" as const,
      expected_commit_id: main,
      operation_key: "existing",
      append: { source_commit_id: last.commitId, source_base_commit_id: main, description: cleanup.summary }
    },
    ...(status === "landed"
      ? { result: { landed_count: 3, target_bookmark: "main" as const, target_commit_id: "9".repeat(40) } }
      : {})
  }) as AppendObservation
const modes = [
  "valid",
  "native-stack",
  // A stack request whose repository has no active stack lands as any other.
  "from-stack-without-stack",
  "pending-then-landed",
  "policy-failed",
  "foreign-tail",
  "unretained",
  "count-mismatch",
  "pull-request",
  "pull-refused"
] as const
const pullModes: ReadonlyArray<string> = ["pull-request", "pull-refused"]
for (const mode of modes) {
  test(`vibe landing: ${mode}`, { timeout: 60_000 }, async (t) => {
    const calls: string[] = []
    let observations = 0
    const fake: BackendLanding = {
      kind: "backend",
      binding: { repositoryId: 42, workspaceId: "11111111-1111-4111-a111-111111111111" },
      readStack: Effect.sync(() => {
        if (mode === "native-stack") calls.push("stack")
        return mode === "native-stack"
      }),
      submitLane: () => Effect.die("native stack must open a landing instead of submitting a lane"),
      readMain: Effect.die("a coding run pins its base"),
      pinMain: Effect.sync(() => {
        calls.push("main")
        return main
      }),
      readDelivery: Effect.sync(() => {
        calls.push("delivery")
        return pullModes.includes(mode) ? "pull-request" as const : "append" as const
      }),
      openPull: (identity, commitId, runId) =>
        Effect.suspend(() => {
          calls.push(`pull:${identity.number}:${commitId}`)
          assert.ok(runId)
          return mode === "pull-refused" ?
            Effect.fail(
              new CodingError({
                code: "unavailable",
                message: "Landing API did not acknowledge the required operation (HTTP 403 forbidden)"
              })
            )
            : Effect.succeed({
              landing_number: identity.number,
              repository: "acme/app",
              number: 41,
              url: "https://github.com/acme/app/pull/41",
              state: "open" as const,
              merged: false,
              head_ref: `smithers/landing-${identity.number}`,
              head_sha: commitId,
              base_ref: "main" as const,
              created: true
            })
        }),
      prepare: (input) =>
        Effect.sync(() => {
          calls.push("prepare")
          assert.deepEqual(input, {
            target_bookmark: "main",
            expected_commit_id: main,
            source_commit_id: last.commitId,
            source_base_commit_id: main
          })
          return mode === "foreign-tail"
            ? {
              ...preparation,
              changes: [...preparation.changes, { change_id: "z".repeat(32), commit_id: "f".repeat(40) }]
            }
            : preparation
        }),
      create: (requestId, _preparation, description) =>
        Effect.sync(() => {
          calls.push(`create:${requestId}`)
          assert.equal(description, cleanup.summary)
          return { requestId, number: 7 }
        }),
      queue: (identity, prepared, request) =>
        Effect.sync(() => {
          calls.push("queue")
          return { ...identity, taskId: 12, preparation: prepared, request }
        }),
      observe: () =>
        Effect.sync(() => {
          calls.push("observe")
          observations++
          if (mode === "policy-failed") return landed("failed")
          if (mode === "pending-then-landed" && observations < 3) {
            return landed(observations === 1 ? "pending" : "running")
          }
          const value = landed("landed")
          return mode === "count-mismatch"
            ? {
              ...value,
              result: { ...(value as Extract<AppendObservation, { status: "landed" }>).result, landed_count: 2 }
            } as AppendObservation
            : value
        })
    }
    const native = Layer.succeed(NativeCoding, {
      sourcePublication: "cloud",
      read: () => Effect.die("no reads"),
      apply: () => Effect.die("no writes"),
      publishOriginalSource: (request) => {
        calls.push(`retain:${request.source.commitId}`)
        return mode === "unretained" ?
          Effect.fail(new NativeCodingError({ code: "source_publication_unavailable", message: "no ACK" }))
          : Effect.succeed({
            status: "retained" as const,
            requestId: request.requestId,
            workspaceId: fake.binding.workspaceId,
            repositoryId: 42,
            ref: `refs/smithers/workspaces/${fake.binding.workspaceId}/sources/${request.source.commitId}`,
            source: request.source
          })
      }
    })
    const host = ManagedRuntime.make(
      Layer.mergeAll(landingLayers, landerLayer, publicationLayers, noChecks, Poll.layer, Sleep.layer).pipe(
        Layer.provide(Layer.mergeAll(Layer.succeed(Landing, fake), native)),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
    )
    t.after(() => host.dispose())
    const execute = LandVibe.execute(mode === "from-stack-without-stack" ? fromStack : cleanup, { executionId: "land" })
    if (mode === "pull-request") {
      const value = await host.runPromise(execute)
      assert.ok("pullRequest" in value && "landing" in value)
      assert.equal(value.pullRequest.number, 41)
      assert.equal(value.landing.number, 7)
      assert.equal(value.cleanedSource.source.commitId, last.commitId)
      assert.deepEqual(calls.filter((call) => !call.startsWith("create:")), [
        `retain:${last.commitId}`,
        "main",
        "prepare",
        "delivery",
        `pull:7:${last.commitId}`
      ])
      assert.ok(!calls.includes("queue"), "a send-upstream Change never appends to Smithers main")
      const count = calls.length
      assert.deepEqual(await host.runPromise(execute), value)
      assert.equal(calls.length, count, "replay uses receipts; no second pull request")
    } else if (
      mode === "valid" || mode === "native-stack" || mode === "from-stack-without-stack" ||
      mode === "pending-then-landed"
    ) {
      // The pending case waits two real durable rounds (10 s each); nothing re-queues.
      const value = await host.runPromise(execute)
      assert.ok("taskId" in value)
      assert.equal(value.mainCommitId, "9".repeat(40))
      assert.equal(value.landedCount, 3)
      assert.equal(value.taskId, 12)
      assert.equal(value.cleanedSource.source.commitId, last.commitId)
      const rest = calls.filter((call) => call !== "delivery" && call !== "stack")
      if (mode === "native-stack") assert.deepEqual(calls.slice(0, 3), [`retain:${last.commitId}`, "stack", "delivery"])
      const expected = [
        `retain:${last.commitId}`,
        "main",
        "prepare",
        rest[3]!,
        "queue",
        ...Array<string>(mode === "pending-then-landed" ? 3 : 1).fill("observe")
      ]
      assert.deepEqual(rest, expected)
      assert.match(rest[3]!, /^create:[0-9a-f-]{36}$/)
      assert.equal(calls.filter((call) => call === "delivery").length, mode === "native-stack" ? 2 : 1)
      const count = calls.length
      assert.deepEqual(await host.runPromise(execute), value)
      assert.equal(calls.length, count, "replay uses receipts; nothing is re-queued")
    } else {
      const error = await host.runPromise(Effect.flip(execute))
      assert(error instanceof CodingError)
      assert.equal(error.code, mode === "unretained" || mode === "pull-refused" ? "unavailable" : "invalid_receipt")
      if (mode === "pull-refused") assert.match(error.message, /HTTP 403 forbidden/)
      assert.deepEqual(
        calls.filter((call) => call === "queue").length,
        mode === "policy-failed" || mode === "count-mismatch" ? 1 : 0,
        "refusals before queue never queue"
      )
      if (mode === "foreign-tail") assert.deepEqual(calls.slice(1), ["main", "prepare"])
    }
  })
}

test(
  "vibe landing: a repository with an active mythical stack hands the result to it",
  { timeout: 60_000 },
  async (t) => {
    const calls: string[] = []
    const unused = () => Effect.die("a stack repository neither appends nor opens its own pull request")
    const fake: BackendLanding = {
      kind: "backend",
      binding: { repositoryId: 42, workspaceId: "11111111-1111-4111-a111-111111111111" },
      readMain: unused(),
      pinMain: unused(),
      readDelivery: Effect.sync(() => {
        calls.push("delivery")
        return "pull-request" as const
      }),
      openPull: unused,
      prepare: unused,
      create: unused,
      queue: unused,
      observe: unused,
      readStack: Effect.sync(() => {
        calls.push("stack")
        return true
      }),
      submitLane: (submission) =>
        Effect.sync(() => {
          calls.push(`submit:${submission.base}:${submission.source}`)
          assert.equal(submission.workspaceId, fake.binding.workspaceId)
          assert.equal(submission.requestRunId, "control", "the run the stack bound")
          assert.equal(submission.summary, cleanup.summary)
          return { itemId: "item-1", state: "integrating", source: submission.source }
        })
    }
    const native = Layer.succeed(NativeCoding, {
      sourcePublication: "cloud",
      read: () => Effect.die("no reads"),
      apply: () => Effect.die("no writes"),
      publishOriginalSource: (request) =>
        Effect.sync(() => {
          calls.push(`retain:${request.source.commitId}`)
          return {
            status: "retained" as const,
            requestId: request.requestId,
            workspaceId: fake.binding.workspaceId,
            repositoryId: 42,
            ref: `refs/smithers/workspaces/${fake.binding.workspaceId}/sources/${request.source.commitId}`,
            source: request.source
          }
        })
    })
    const host = ManagedRuntime.make(
      Layer.mergeAll(landingLayers, landerLayer, publicationLayers, noChecks, Poll.layer, Sleep.layer).pipe(
        Layer.provide(Layer.mergeAll(Layer.succeed(Landing, fake), native)),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
    )
    t.after(() => host.dispose())
    // A stack request's original source is the fresh working change on the tip.
    const tip = "7".repeat(40)
    const stackCleanup: VibeCleanup = {
      ...cleanup,
      admission: { ...cleanup.admission, originalSource: { ...original, parentCommitIds: [tip] } }
    }
    const execute = LandVibe.execute(stackCleanup, { executionId: "stack" })
    const value = await host.runPromise(execute)
    assert.ok("lane" in value)
    assert.equal(value.lane.itemId, "item-1")
    // The base is the stack tip the request started from: the original source's parent.
    assert.deepEqual(calls, [`retain:${last.commitId}`, "stack", "delivery", `submit:${tip}:${last.commitId}`])
    const count = calls.length
    assert.deepEqual(await host.runPromise(execute), value)
    assert.equal(calls.length, count, "replay uses receipts; nothing is submitted twice")
  }
)

test(
  "vibe landing: a request started from a stack base returns to its stack though main has no factory.json",
  { timeout: 60_000 },
  async (t) => {
    const calls: string[] = []
    const unused = () => Effect.die("a stack request neither appends nor opens its own pull request")
    const fake: BackendLanding = {
      kind: "backend",
      binding: { repositoryId: 42, workspaceId: "11111111-1111-4111-a111-111111111111" },
      readMain: unused(),
      pinMain: unused(),
      // Main has no .smithers/factory.json, so the declared delivery is the landing append.
      readDelivery: Effect.sync(() => {
        calls.push("delivery")
        return "append" as const
      }),
      openPull: unused,
      prepare: unused,
      create: unused,
      queue: unused,
      observe: unused,
      readStack: Effect.sync(() => {
        calls.push("stack")
        return true
      }),
      submitLane: (submission) =>
        Effect.sync(() => {
          calls.push(`submit:${submission.base}:${submission.source}`)
          assert.equal(submission.requestRunId, "control", "the run the stack bound")
          return { itemId: "item-2", state: "integrating", source: submission.source }
        })
    }
    const native = Layer.succeed(NativeCoding, {
      sourcePublication: "cloud",
      read: () => Effect.die("no reads"),
      apply: () => Effect.die("no writes"),
      publishOriginalSource: (request) =>
        Effect.sync(() => {
          calls.push(`retain:${request.source.commitId}`)
          return {
            status: "retained" as const,
            requestId: request.requestId,
            workspaceId: fake.binding.workspaceId,
            repositoryId: 42,
            ref: `refs/smithers/workspaces/${fake.binding.workspaceId}/sources/${request.source.commitId}`,
            source: request.source
          }
        })
    })
    const host = ManagedRuntime.make(
      Layer.mergeAll(landingLayers, landerLayer, publicationLayers, noChecks, Poll.layer, Sleep.layer).pipe(
        Layer.provide(Layer.mergeAll(Layer.succeed(Landing, fake), native)),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
    )
    t.after(() => host.dispose())
    const value = await host.runPromise(LandVibe.execute(fromStack, { executionId: "from-stack" }))
    assert.ok("lane" in value)
    assert.equal(value.lane.itemId, "item-2")
    // The stack's lane waits for this result; the repository's delivery policy is never consulted.
    assert.deepEqual(calls, [`retain:${last.commitId}`, "stack", `submit:${stackTip}:${last.commitId}`])
  }
)

/** A host without the backend: the fake lander answers the members `LandVibe` runs, in order. */
const localModes = [
  "ff-landed",
  "ff-checks-failed",
  "ff-check-outage",
  "ff-main-moved",
  "ff-conflict",
  "pr-merged",
  "pr-open",
  "pr-checks-failed",
  "pr-pending-then-passed"
] as const
for (const mode of localModes) {
  test(`vibe landing without the backend: ${mode}`, { timeout: 60_000 }, async (t) => {
    const calls: string[] = []
    let observations = 0
    const mainRevision = {
      changeId: "m".repeat(32),
      commitId: main,
      treeId: "6".repeat(40),
      operationId: "0".repeat(128),
      parentCommitIds: []
    }
    const candidate = {
      changeId: "o".repeat(32),
      commitId: "8".repeat(40),
      treeId: last.treeId,
      operationId: "1".repeat(128),
      parentCommitIds: [main]
    }
    const prepared = {
      lander: mode.startsWith("ff") ? "fast-forward" as const : "pull-request" as const,
      main: mainRevision,
      summary: cleanup.summary,
      candidate
    }
    const pull = {
      number: 41,
      url: "https://github.com/acme/app/pull/41",
      state: "open" as const,
      headRef: "smithers/landing-x",
      headSha: candidate.commitId,
      baseRef: "main",
      mergeCommitId: null
    }
    const fake: LocalLanding = {
      kind: prepared.lander,
      prepare: (input, requestId) =>
        Effect.suspend(() => {
          calls.push(`prepare:${requestId}`)
          assert.equal(input.head.commitId, last.commitId)
          return mode === "ff-conflict"
            ? Effect.fail(new CodingError({ code: "evicted", message: "The cleaned tip conflicts with main: b.txt" }))
            : Effect.succeed(prepared)
        }),
      fastForward: (input) =>
        Effect.suspend(() => {
          calls.push("fast-forward")
          assert.deepEqual(input, prepared)
          return mode === "ff-main-moved"
            ? Effect.fail(new CodingError({ code: "evicted", message: "main moved after the candidate was verified" }))
            : Effect.succeed(candidate.commitId)
        }),
      abandon: () =>
        Effect.sync(() => {
          calls.push("abandon")
        }),
      openPull: (input, requestId) =>
        Effect.sync(() => {
          calls.push(`pull:${requestId}`)
          assert.deepEqual(input, prepared)
          return pull
        }),
      observeChecks: () =>
        Effect.sync(() => {
          calls.push("checks")
          observations++
          if (mode === "pr-checks-failed") {
            return { status: "failed" as const, checks: [{ name: "ci", bucket: "fail" }] }
          }
          if (mode === "pr-pending-then-passed" && observations === 1) {
            return { status: "pending" as const, checks: [{ name: "ci", bucket: "pending" }] }
          }
          return { status: "passed" as const, checks: [{ name: "ci", bucket: "pass" }] }
        }),
      merge: (input) =>
        Effect.sync(() => {
          calls.push("merge")
          assert.equal(input.number, 41)
          return mode === "pr-open"
            ? { status: "open" as const, reason: "review required" }
            : { status: "merged" as const, mainCommitId: "9".repeat(40) }
        })
    }
    const native = Layer.succeed(NativeCoding, {
      sourcePublication: "local-only",
      read: () => Effect.die("no reads"),
      apply: () => Effect.die("no writes"),
      publishOriginalSource: () => Effect.die("a local lander never retains a source with the backend")
    })
    // The project's checks run on the candidate through the ordinary check action.
    const checks = RunCheck.toLayer(({ implementation, check }) =>
      Effect.sync(() => {
        calls.push(`check:${check.id}`)
        assert.equal(implementation.change, "landing-candidate")
        assert.deepEqual(implementation.head, candidate)
        assert.deepEqual(implementation.parent, mainRevision)
        assert.deepEqual(implementation.writes, ["first", "last"])
        const passed = !mode.startsWith("ff-check") || check.id !== "fast"
        return {
          ...(mode === "ff-check-outage" && !passed ? { fault: "infra" as const } : {}),
          checkId: check.id,
          target: check.target,
          tier: check.tier,
          change: implementation.change,
          commitId: implementation.head.commitId,
          treeId: implementation.head.treeId,
          inputDigest: checkInputDigest(implementation, check),
          status: passed ? "passed" as const : "failed" as const,
          evidence: "fixture",
          findings: passed
            ? []
            : [{ owner: implementation.change, sourceCommitId: candidate.commitId, message: "fast failed" }]
        }
      })
    )
    const host = ManagedRuntime.make(
      Layer.mergeAll(landingLayers, landerLayer, publicationLayers, checks, Poll.layer, Sleep.layer).pipe(
        Layer.provide(Layer.mergeAll(Layer.succeed(Landing, fake), native)),
        Layer.provideMerge(Action.layerImplementations),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
    )
    t.after(() => host.dispose())
    const execute = LandVibe.execute(cleanup, { executionId: `land-${mode}` })
    const requestId = /^[0-9a-f-]{36}$/
    if (mode === "ff-landed") {
      const value = await host.runPromise(execute)
      assert.ok("receipts" in value)
      assert.equal(value.mainCommitId, candidate.commitId)
      assert.deepEqual(value.prepared, prepared)
      assert.deepEqual(value.receipts.map((receipt) => [receipt.checkId, receipt.status]), [["fast", "passed"]])
      assert.match(calls[0]!, /^prepare:[0-9a-f-]{36}$/)
      assert.deepEqual(calls.slice(1), ["check:fast", "fast-forward"])
      const count = calls.length
      assert.deepEqual(await host.runPromise(execute), value)
      assert.equal(calls.length, count, "replay uses receipts; main is not moved twice")
    } else if (mode === "pr-merged" || mode === "pr-open" || mode === "pr-pending-then-passed") {
      // The pending case waits one real durable round (15 s); nothing is pushed or opened twice.
      const value = await host.runPromise(execute)
      assert.ok("pullRequest" in value && "merge" in value)
      assert.equal(value.pullRequest.number, 41)
      assert.deepEqual(value.prepared, prepared)
      assert.deepEqual(
        value.merge,
        mode === "pr-open"
          ? { status: "open", reason: "review required" }
          : { status: "merged", mainCommitId: "9".repeat(40) }
      )
      assert.ok(requestId.test(calls[0]!.slice("prepare:".length)))
      assert.equal(
        calls[1]!.slice("pull:".length),
        calls[0]!.slice("prepare:".length),
        "one request identity names the branch"
      )
      assert.deepEqual(calls.slice(2), [
        ...Array<string>(mode === "pr-pending-then-passed" ? 2 : 1).fill("checks"),
        "merge"
      ])
      const count = calls.length
      assert.deepEqual(await host.runPromise(execute), value)
      assert.equal(calls.length, count, "replay uses receipts; nothing is merged twice")
    } else if (mode === "ff-check-outage") {
      // A check the host could not run says nothing about the candidate: no eviction, no fast-forward.
      const error = await host.runPromise(Effect.flip(execute))
      assert(error instanceof CodingError)
      assert.equal(error.code, "check_infra")
      assert.deepEqual(calls.map((call) => call.replace(/:[0-9a-f-]{36}$/, "")), ["prepare", "check:fast", "abandon"])
    } else {
      const error = await host.runPromise(Effect.flip(execute))
      assert(error instanceof CodingError)
      assert.equal(error.code, "evicted")
      const rest = calls.map((call) => call.replace(/:[0-9a-f-]{36}$/, ""))
      if (mode === "ff-conflict") {
        assert.match(error.message, /conflicts with main: b\.txt/)
        assert.deepEqual(rest, ["prepare"])
      } else if (mode === "ff-checks-failed") {
        assert.match(error.message, /failed required checks on main: fast/)
        assert.deepEqual(
          rest,
          ["prepare", "check:fast", "abandon"],
          "an evicted candidate is dropped, never fast-forwarded"
        )
      } else if (mode === "ff-main-moved") {
        assert.match(error.message, /main moved/)
        assert.deepEqual(rest, ["prepare", "check:fast", "fast-forward", "abandon"])
      } else {
        assert.match(error.message, /Pull request #41 failed required checks: ci/)
        assert.deepEqual(
          rest,
          ["prepare", "pull", "checks"],
          "a failed pull request stays open for its author; nothing merges"
        )
      }
    }
  })
}
