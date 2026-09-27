import { NodeServices } from "@effect/platform-node"
import { Control as ControlService } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Cause, Effect, Exit, Layer, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cli } from "../src/Command.ts"
import * as Detached from "../src/Detached.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"

const roots: Array<string> = []
const project = () => {
  const root = mkdtempSync(join(tmpdir(), "smithers-detached-command-"))
  roots.push(root)
  return root
}
const invoke = (root: string) =>
  Command.runWith(cli, { version: "test" })(["up", "demo", "-d"]).pipe(
    Effect.provide(TestControl.layer({
      now: () => 0,
      flows: [{
        flowId: "demo",
        description: "fixture",
        deployClass: false,
        envelope: { capabilities: [], flows: [], budget: {} }
      }]
    })),
    Effect.provide(Project.layer(root, Project.legacyRoot(undefined, root))),
    Effect.provide(NodeControl.layerMemoryRemote),
    Effect.provide(Output.layer),
    Effect.provide(TestConsole.layer),
    Effect.provide(NodeServices.layer)
  )

afterEach(() => {
  vi.restoreAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("detached command ownership", () => {
  it("retains the rejected launch log and reports its path and tail", async () => {
    const root = project()
    const logFile = join(root, "pending-fixture.log")
    writeFileSync(logFile, "full diagnostic output\n")
    vi.spyOn(Detached, "launch").mockResolvedValue({ reason: "launch failed", tail: "diagnostic tail", logFile })

    const exit = await Effect.runPromiseExit(invoke(root))

    expect(Exit.isFailure(exit)).toBe(true)
    expect(existsSync(logFile)).toBe(true)
    const error = Exit.isFailure(exit) ? String(Cause.squash(exit.cause)) : ""
    expect(error).toContain(`Log: ${logFile}`)
    expect(error).toContain("diagnostic tail")
  })

  it("passes interruption to the launch and waits for cleanup before exiting", async () => {
    const root = project()
    let signal: AbortSignal | undefined
    let cleaned = false
    const launch = vi.spyOn(Detached, "launch").mockImplementation(async (options) => {
      signal = options.signal
      await new Promise((resolve) => setTimeout(resolve, 300))
      cleaned = true
      return { reason: "interrupted", tail: "", logFile: join(root, "pending.log") }
    })
    const controller = new AbortController()
    const pending = Effect.runPromiseExit(invoke(root), { signal: controller.signal })
    await vi.waitFor(() => expect(launch).toHaveBeenCalled())
    controller.abort()
    const exit = await pending
    expect(Exit.isFailure(exit)).toBe(true)
    expect(signal?.aborted).toBe(true)
    expect(cleaned).toBe(true)
  })
})

describe("attached receipt timing", () => {
  it.each([false, true])("prints the failed receipt after settlement (resume: %s)", async (resume) => {
    let observed = false
    const control = Layer.effect(
      ControlService.Control,
      Effect.gen(function*() {
        const base = yield* ControlService.Control
        const receipt = Effect.succeed({ _tag: "Accepted", receiptId: "receipt-1", runId: "run-1" } as const)
        return ControlService.make({
          ...base,
          run: () => receipt,
          resume: () => receipt,
          watch: (filter) =>
            filter.follow === false ? Stream.empty : Stream.fromEffect(Effect.gen(function*() {
              expect(yield* TestConsole.logLines).toEqual([])
              observed = true
              return {
                sequence: 1,
                kind: "control.run.failed",
                runId: "run-1",
                occurredAt: 1,
                payload: { cause: "fixture failure" }
              }
            }))
        })
      })
    ).pipe(Layer.provide(TestControl.layer({
      now: () => 0,
      flows: [{
        flowId: "demo",
        description: "fixture",
        deployClass: false,
        envelope: { capabilities: [], flows: [], budget: {} }
      }]
    })))
    const lines = await Effect.runPromise(
      Effect.gen(function*() {
        const service = yield* ControlService.Control
        const card = yield* service.plan({ flowId: "demo", input: {} })
        const args = resume ? ["run", "--resume", "run-1"] : ["run", JSON.stringify(card.approval)]
        yield* Command.runWith(cli, { version: "test" })(["--json", ...args])
        return yield* TestConsole.logLines
      }).pipe(
        Effect.provide(control),
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.provide(NodeControl.layerMemoryRemote),
        Effect.provide(Output.layer),
        Effect.provide(TestConsole.layer),
        Effect.provide(NodeServices.layer)
      )
    )
    expect(observed).toBe(true)
    expect(lines).toHaveLength(1)
    expect(JSON.parse(String(lines[0]))).toEqual({
      _tag: "Accepted",
      receiptId: "receipt-1",
      runId: "run-1",
      status: "failed",
      cause: "fixture failure"
    })
  })
})
