/**
 * Two role-task paths through the real agent stack: a Review gate answered
 * by the reviewer's role task (`Actions.reviewHandler`), and a builder whose
 * workspace tools act in the workspace a previous step prepared.
 *
 * The workspace here is a host directory served through the same
 * `Workspace.Machines` contract as a microVM, so the case runs everywhere;
 * `WorkspaceMicrovm.test.ts` proves the same lifecycle against real
 * machines.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as AgentAction from "@smthrs/agent/AgentAction"
import { Action, Flow, Interpreter } from "@smthrs/flow"
import * as Node from "@smthrs/plan/Node"
import { Effect, Exit, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Actions from "../src/Actions.ts"
import * as Authority from "../src/Authority.ts"
import * as Gates from "../src/Gates.ts"
import * as GatesLive from "../src/GatesLive.ts"
import * as Profile from "../src/Profile.ts"
import * as Workspace from "../src/Workspace.ts"
import {
  agentStack,
  answering,
  type Asked,
  done,
  failureOf,
  loadSnapshot,
  memoryServices,
  patched,
  payloadFor,
  type Recorded,
  scripted,
  task
} from "./dispatchSupport.ts"
import { fixtureRepo, hostMachines } from "./workspaceSupport.ts"

const Ship = Action.make("test/ship", {
  implementationVersion: "ship/v1",
  payload: { diff: Schema.String },
  success: Schema.String
})

const release: Gates.At = { boundary: "release", target: "test/deliver" }

const Deliver = Flow.make("test/deliver", {
  payload: { diff: Schema.String, gates: Gates.GatePolicy },
  success: Schema.String,
  error: Gates.GateRefused,
  body: Node.capture({ release }, function(payload) {
    return Gates.before(payload.gates, this.release, { diff: payload.diff }, Ship.call({ diff: payload.diff }))
  })
})

const policy = (reviewer: string): Gates.GatePolicy => ({
  revision: "review-1",
  gates: [{ at: release, spec: { _tag: "Review", id: "ship-review", reviewer } }]
})

const reviewed = async (options: {
  readonly cells: ReadonlyArray<string>
  readonly reviewer?: string
  readonly paused?: boolean
  readonly verdictField?: string
}) => {
  const asked: Array<Asked> = []
  const recorded: Array<Recorded> = []
  let shipped = 0
  const snapshot = await loadSnapshot((profiles) =>
    options.paused === true ? patched(profiles, "checker", { status: "paused" }) : profiles
  )
  const implementations = Layer.mergeAll(
    Ship.toLayer(({ diff }) => Effect.sync(() => `shipped ${diff} after ${++shipped} ship`), {
      implementationVersion: "ship/v1"
    }),
    GatesLive.layer({ review: Actions.reviewHandler({ verdictField: options.verdictField }) }),
    Authority.layer(Actions.RoleTask.layer)
  )
  const stack = Layer.mergeAll(implementations, Interpreter.layer(Deliver, { callbackIdentity: "stable" })).pipe(
    Layer.provideMerge(agentStack({
      snapshot,
      resources: { memory: memoryServices, claimCap: 0 },
      model: scripted(options.cells, asked),
      recorded
    }))
  )
  const exit = await Effect.runPromise(
    Deliver.execute({ diff: "+hello world", gates: policy(options.reviewer ?? "checker") }, {
      executionId: `review-${Math.random()}`
    }).pipe(Effect.provide(stack), Effect.exit)
  )
  return { exit, asked, recorded, shipped: () => shipped }
}

describe("a Review gate answered by the reviewer's role task", () => {
  it("passes when the reviewer approves, and the reviewer saw the subject as data", async () => {
    const { exit, asked, recorded, shipped } = await reviewed({
      cells: [answering(done({ verdict: "approve", findings: "none" }, "The diff says hello world."))]
    })
    expect(Exit.isSuccess(exit) && exit.value).toBe("shipped +hello world after 1 ship")
    expect(shipped()).toBe(1)
    expect(asked).toHaveLength(1)
    expect(asked[0]!.text).toContain("Independently decide whether a change meets its acceptance criteria.")
    expect(asked[0]!.text).toContain("<source provider=\"organization\" id=\"gate/ship-review\"")
    expect(asked[0]!.text).toContain("+hello world")
    // The checker holds workspace, memory, and retrieval; a review names no
    // workspace, so it runs with memory and web-fetch alone.
    expect(recorded[0]!.flows).toEqual(["recall", "remember", "web-fetch"])
  })

  it("denies the gate when the reviewer requests changes", async () => {
    const { exit, shipped } = await reviewed({
      cells: [answering(done({ verdict: "request-changes", findings: "lib.txt: wrong greeting" }, "Wrong greeting."))]
    })
    const refused = failureOf(exit)
    expect(refused).toBeInstanceOf(Gates.GateRefused)
    expect((refused as Gates.GateRefused).record).toMatchObject({
      outcome: "denied",
      reason: "Wrong greeting.",
      decidedBy: "checker"
    })
    expect(shipped()).toBe(0)
  })

  it("denies the gate when the reviewer's result breaks its charter or the reviewer cannot act", async () => {
    const incomplete = await reviewed({ cells: [answering(done({ verdict: "approve" }))] })
    expect((failureOf(incomplete.exit) as Gates.GateRefused).record.reason).toBe("the reviewer produced no verdict")

    const paused = await reviewed({ cells: [answering(done({ verdict: "approve", findings: "none" }))], paused: true })
    expect((failureOf(paused.exit) as Gates.GateRefused).record.outcome).toBe("denied")
    expect(paused.asked).toHaveLength(0)

    const noField = await reviewed({
      cells: [answering(done({ verdict: "approve", findings: "none" }))],
      verdictField: "decision"
    })
    expect((failureOf(noField.exit) as Gates.GateRefused).record.outcome).toBe("denied")
    expect(noField.asked).toHaveLength(0)
    for (const attempt of [incomplete, paused, noField]) expect(attempt.shipped()).toBe(0)
  })
})

const Build = Flow.make("test/build", {
  payload: Authority.RoleTaskPayload,
  success: Profile.RoleResult,
  error: AgentAction.AgentFailure,
  body: (payload) => Actions.RoleTask.call(payload)
})

describe("a builder's workspace tools", () => {
  it("act in the prepared workspace, and the change is what the workspace collects", async () => {
    const { repo, commit } = fixtureRepo()
    const { machines } = hostMachines()
    const executionId = "build-1"
    const key = `${executionId}/example/demo/build`
    const workspaceLayer = Workspace.layer({ machines, maxConcurrentVMs: 2 }).pipe(
      Layer.provideMerge(NodeServices.layer)
    )
    const snapshot = await loadSnapshot()
    const asked: Array<Asked> = []
    const recorded: Array<Recorded> = []
    const cell =
      `const edit = await ctx.call("bash", { command: "printf 'hello world\\\\n' > lib.txt && cat lib.txt && (pwd -W 2>/dev/null || pwd)" });
const result = ${JSON.stringify(done({ summary: "", commands: "" }))};
result.fields.summary = edit.stdout;
result.fields.commands = "exit " + edit.exitCode;
ctx.done(JSON.stringify(result))`
    const stack = Layer.mergeAll(Authority.layer(Actions.RoleTask.layer), Interpreter.layer(Build)).pipe(
      Layer.provideMerge(workspaceLayer),
      Layer.provideMerge(agentStack({
        snapshot,
        resources: { memory: memoryServices, claimCap: 0 },
        model: scripted([cell], asked),
        recorded
      }))
    )
    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const workspace = yield* Workspace.Workspace
        const prepared = yield* workspace.prepare({ key, repoPath: repo, commit })
        const result = yield* Build.execute(
          { ...payloadFor(snapshot, "builder", task()), workspace: { key, repository: "example/demo" } },
          { executionId }
        )
        const diff = yield* workspace.collect(prepared)
        return { prepared, result, diff }
      }).pipe(Effect.provide(stack))
    )
    expect(outcome.result.fields["commands"]).toBe("exit 0")
    // Git Bash prints its POSIX view of the directory; `pwd -W` gives the
    // Windows path, with forward slashes, that the workspace prepared.
    const workdir = process.platform === "win32"
      ? outcome.prepared.workdir.replaceAll("\\", "/")
      : outcome.prepared.workdir
    expect(outcome.result.fields["summary"]).toBe(`hello world\n${workdir}\n`)
    expect(outcome.diff.files).toEqual([{ path: "lib.txt", added: 1, deleted: 1 }])
    expect(recorded[0]!.flows).toEqual([
      "apply_patch",
      "bash",
      "edit",
      "glob",
      "grep",
      "ls",
      "read",
      "recall",
      "remember",
      "web-fetch",
      "write"
    ])
    expect(recorded[0]!.envelope).toContain("proc:spawn:*")
    expect(recorded[0]!.system).toContain(
      `Your workspace is the repository checkout at ${outcome.prepared.workdir} inside an isolated machine. Shell and file tools act only there; use absolute paths under ${outcome.prepared.workdir}.`
    )
  })
})
