/** Real discovery, registry loading, engine, platform and host boundaries. Models alone are scripted. */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as Budget from "@smthrs/agent/Budget"
import { FlowEngine } from "@smthrs/engine"
import { Action, FlowRuntime } from "@smthrs/flow"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import { afterEach, expect, test } from "bun:test"
import { Effect, Fiber, FileSystem, Layer } from "effect"
import { TestClock } from "effect/testing"
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as module from "../../flow.ts"
import { host } from "../host.ts"
import { type Answer, scriptedSeats } from "./scriptedSeats.ts"
const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})
function repository(jj = false) {
  const repo = mkdtempSync(join(tmpdir(), "review-registry-"))
  dirs.push(repo)
  if (jj) execFileSync("jj", ["git", "init", "--colocate", repo], { stdio: "pipe" })
  else {
    const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" })
    git(["init"])
    git(["config", "user.email", "review@example.com"])
    git(["config", "user.name", "Review"])
    writeFileSync(join(repo, "file.ts"), "export const n = 1;\n")
    git(["add", "."])
    git(["-c", "commit.gpgsign=false", "commit", "-m", "base"])
  }
  writeFileSync(join(repo, "file.ts"), "export const n = 2;\n")
  return repo
}
const loadReview = Effect.gen(function*() {
  const discovery = yield* Discovery.Discovery
  const scanned = yield* discovery.scan({
    source: "project",
    root: fileURLToPath(new URL("../../../../", import.meta.url)) + "flows",
    naming: "path"
  })
  const descriptor = scanned.entries.find((entry) => entry.name === "review")
  if (!descriptor) return yield* Effect.die(new Error("review was not discovered"))
  expect(descriptor.body._tag).toBe("Module")
  const executable = yield* Executable.fromDescriptor(descriptor, { delegates: [], load: () => Effect.succeed(module) })
  yield* Layer.build(executable.layer)
  return executable
})
function run(repo: string, answer: Answer, budget?: ReturnType<typeof Budget.layer>) {
  return Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const executable = yield* loadReview
      const runtime = yield* FlowRuntime.FlowRuntime
      return yield* runtime.execute(executable.flow, {
        payload: { input: { repo, narrate: false, verify: false } },
        executionId: crypto.randomUUID()
      })
    })).pipe(Effect.provide(Discovery.layer), Effect.provide(host(scriptedSeats(answer), budget)))
  )
}
test.each([false, true])(
  "ordinary /review is discovered and runs on the caller's platform and engine (jj=%s)",
  async (jj) => {
    let calls = 0
    const repo = repository(jj)
    const result = await run(repo, () => {
      calls++
      return { status: "success", comments: [], warnings: [] }
    }) as { review: { status: string }; ui: { kind: string; html: string }; walkthrough: { path: string } }
    expect(calls).toBe(1)
    expect(result.review.status).toBe("success")
    expect(result.ui.kind).toBe("html")
    expect(result.ui.html).toContain("file.ts")
    expect(readFileSync(result.walkthrough.path, "utf8")).toBe(result.ui.html)
  },
  15000
)
test("the caller's exhausted budget prevents model calls and preserves honest failure output", async () => {
  let calls = 0
  const result = await run(repository(), () => {
    calls++
    return { status: "success", comments: [], warnings: [] }
  }, Budget.layer({ tokens: { max: 0 } })) as { review: { status: string; warnings: unknown[] }; ui: { html: string } }
  expect(calls).toBe(0)
  expect(result.review.status).toBe("failed")
  expect(JSON.stringify(result.review.warnings)).toMatch(/budget|tokens/i)
  expect(result.ui.html).toContain("Review failed")
}, 15000)
test("caller cancellation interrupts the model and never publishes success", async () => {
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  let aborted = false
  const repo = repository()
  const program = Effect.scoped(Effect.gen(function*() {
    const executable = yield* loadReview
    const runtime = yield* FlowRuntime.FlowRuntime
    const fiber = yield* Effect.forkChild(
      runtime.execute(executable.flow, {
        payload: { input: { repo, narrate: false, verify: false } },
        executionId: crypto.randomUUID()
      })
    )
    yield* Effect.promise(() => started)
    yield* Fiber.interrupt(fiber)
  })).pipe(
    Effect.provide(Discovery.layer),
    Effect.provide(host(scriptedSeats((_ask, signal) =>
      new Promise((_resolve, reject) => {
        entered()
        signal.addEventListener("abort", () => {
          aborted = true
          reject(new Error("cancelled"))
        }, { once: true })
      })
    )))
  )
  await Effect.runPromise(program)
  expect(aborted).toBe(true)
  expect(() => readFileSync(join(repo, ".smithers-review/walkthrough.html"))).toThrow()
}, 15000)
test("a host filesystem refusal is surfaced instead of falling back to native repository reads", async () => {
  const repo = repository()
  const denied = Layer.unwrap(Effect.gen(function*() {
    const real = yield* FileSystem.FileSystem
    return Layer.succeed(FileSystem.FileSystem, {
      ...real,
      exists: (path) =>
        path.startsWith(repo) ? Effect.die(new Error("host denies repository access")) : real.exists(path)
    })
  }))
  await expect(Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const executable = yield* loadReview
      const runtime = yield* FlowRuntime.FlowRuntime
      return yield* runtime.execute(executable.flow, { payload: { input: { repo } }, executionId: crypto.randomUUID() })
    })).pipe(
      Effect.provide(Discovery.layer),
      Effect.provide(denied.pipe(Layer.provideMerge(host(scriptedSeats(() => undefined)))))
    )
  )).rejects.toThrow("host denies repository access")
}, 15000)

test("the normal registry refuses a review without host agent services", async () => {
  await expect(
    Effect.runPromise(
      loadReview.pipe(
        Effect.provide(Discovery.layer),
        Effect.provide(
          Layer.mergeAll(
            NodeCrypto.layer,
            NodeFileSystem.layer,
            NodePath.layer,
            FlowEngine.layerMemory,
            Action.layerImplementations
          )
        ),
        Effect.scoped
      )
    )
  ).rejects.toMatchObject({ code: "missing_service", flow: "review", service: expect.stringContaining("Host") })
})
test("repository commands use the caller's process guard", async () => {
  const repo = repository()
  let attempted = 0
  // Explicit host policy denial; normal-path tests launch real git/jj.
  const denied = Layer.unwrap(Effect.gen(function*() {
    const real = yield* ChildProcessSpawner.ChildProcessSpawner
    return Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, {
      ...real,
      spawn: () =>
        Effect.sync(() => {
          attempted++
        }).pipe(Effect.flatMap(() => Effect.die(new Error("host denies process"))))
    })
  }))
  await expect(Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const executable = yield* loadReview
      const runtime = yield* FlowRuntime.FlowRuntime
      return yield* runtime.execute(executable.flow, { payload: { input: { repo } }, executionId: crypto.randomUUID() })
    })).pipe(
      Effect.provide(Discovery.layer),
      Effect.provide(denied.pipe(Layer.provideMerge(host(scriptedSeats(() => undefined)))))
    )
  )).rejects.toThrow("host denies process")
  expect(attempted).toBe(1)
}, 15000)

test("registry dispatch applies the ordinary model-action deadline", async () => {
  const repo = repository()
  let aborted = false
  let entered!: () => void
  const started = new Promise<void>((resolve) => {
    entered = resolve
  })
  const result = await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const executable = yield* loadReview
      const runtime = yield* FlowRuntime.FlowRuntime
      const pending = yield* runtime.execute(executable.flow, {
        payload: { input: { repo, timeout: 1, narrate: false, verify: false } },
        executionId: crypto.randomUUID()
      }).pipe(Effect.forkChild({ startImmediately: true }))
      yield* Effect.promise(() => started)
      yield* TestClock.adjust(59_999)
      expect(aborted).toBe(false)
      expect(pending.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(1)
      return yield* Fiber.join(pending)
    })).pipe(
      Effect.provide(Discovery.layer),
      Effect.provide(host(scriptedSeats((_ask, signal) =>
        new Promise((_resolve, reject) => {
          entered()
          signal.addEventListener("abort", () => {
            aborted = true
            reject(new Error("cancelled"))
          }, { once: true })
        })
      ))),
      Effect.provide(TestClock.layer())
    )
  ) as { review: { status: string; warnings: unknown[] } }
  expect(aborted).toBe(true)
  expect(result.review.status).toBe("failed")
  expect(JSON.stringify(result.review.warnings)).toContain("timed out")
}, 15000)
