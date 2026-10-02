import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { FlowEngine } from "@smthrs/engine"
import { Action, ExternalJob, Flow, Interpreter } from "@smthrs/flow"
import { RemoteChildProcessSpawner, Sandbox } from "@smthrs/sandbox"
import { Cause, Effect, Exit, Fiber, Layer, Stream } from "effect"
import { TestClock } from "effect/testing"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import assert from "node:assert/strict"
import test from "node:test"
import { AgentFailed, makeRemoteJob, RemoteFix } from "../work/flow.ts"

// Inject transport responses rather than replacing Sandbox.job: the real
// launcher, retained identity validation, receipt store and capture run here.
const fixture = () => {
  const state = {
    starts: [] as string[],
    commands: [] as string[],
    saved: [] as string[],
    released: [] as string[],
    reservations: 0,
    destroyed: [] as string[],
    status: "Running",
    stdout: "Fixed",
    stderr: "",
    code: 0,
    patch: "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n+new\n",
    readLoginFails: false,
    missingGuestLogin: false,
    saveLoginFails: false,
    saveLoginFailures: 0,
    unavailable: false,
    agent: "codex" as "codex" | "claude",
    login: "SECRET_LOGIN",
    refreshed: "REFRESHED_LOGIN"
  }
  const machines = new Map<string, Sandbox.Session>()
  const session = (key: string): Sandbox.Session => ({
    id: key,
    remoteId: `machine:${key}`,
    workdir: "/workspace",
    spawn: (command) =>
      Effect.sync(() => {
        state.commands.push(command)
        if (command.includes("setsid /bin/sh") && !state.starts.includes(key)) state.starts.push(key)
        const out = command.startsWith("if test -f")
          ? state.status
          : command.includes("smithers-capture.")
          ? state.patch
          : ""
        return { stdout: Stream.make(new TextEncoder().encode(out)), stderr: Stream.empty, exitCode: Effect.succeed(0) }
      }),
    writeFile: () => Effect.void,
    readFile: (path) =>
      state.missingGuestLogin && (path.endsWith("/auth.json") || path.endsWith("/oauth-token")) ?
        Effect.fail(
          new RemoteChildProcessSpawner.ProviderError({ code: "not_found", message: "missing guest login" })
        ) :
        Effect.succeed(new TextEncoder().encode(
          path.endsWith("/key") ? key : path.endsWith("/out") ? state.stdout : path.endsWith("/err") ?
            state.stderr :
            path.endsWith("/exit")
            ? String(state.code)
            : path.endsWith("/base")
            ? "abcdef"
            : state.refreshed
        ))
  })
  const provider: Sandbox.Provider = {
    retained: true,
    acquire: (key) =>
      Effect.sync(() => {
        const existing = machines.get(key)
        if (existing) return existing
        const created = session(key)
        machines.set(key, created)
        return created
      }),
    attach: (handle) =>
      state.unavailable
        ? Effect.fail(new RemoteChildProcessSpawner.ProviderError({ code: "unavailable", message: "network reset" }))
        : machines.has(handle.id) ?
        Effect.succeed(machines.get(handle.id)!)
        : Effect.fail(new RemoteChildProcessSpawner.ProviderError({ code: "not_found", message: "machine lost" })),
    destroy: (handle) =>
      Effect.sync(() => {
        state.destroyed.push(handle.id)
        machines.delete(handle.id)
      })
  }
  const options = {
    provider: () => Effect.succeed(provider),
    reserve: () =>
      Effect.sync(() => {
        state.reservations++
        return { agent: state.agent, account: "account-1", ...(state.readLoginFails ? {} : { login: state.login }) }
      }),
    restore: () => {},
    release: (key: string) => {
      state.released.push(key)
    },
    readLogin: () =>
      state.readLoginFails ? Effect.fail(new AgentFailed({ message: "login missing" })) : Effect.succeed(state.login),
    saveLogin: (_account: string, login: string) =>
      Effect.suspend(() => {
        if (state.saveLoginFails || state.saveLoginFailures > 0) {
          state.saveLoginFailures--
          assert.equal(state.destroyed.length, 0)
          assert.equal(state.released.length, 0)
          return Effect.fail(new AgentFailed({ message: "could not save login" }))
        }
        return Effect.sync(() => {
          state.saved.push(login)
        })
      }),
    cool: () => Effect.void
  }
  return { state, machines, options, job: makeRemoteJob(options) }
}
const input = {
  repo: "smithersai/smithers",
  issue: 3378,
  text: { title: "Restart", body: "Fix", comments: [] },
  placement: "cloud" as const
}
const failure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function*() {
    const exit = yield* Effect.exit(effect)
    assert(Exit.isFailure(exit))
    return Cause.squash(exit.cause)
  })
const run = <A, E>(effect: Effect.Effect<A, E, KeyValueStore.KeyValueStore>) =>
  Effect.runPromise(effect.pipe(Effect.provide(KeyValueStore.layerMemory)))

test("remote fix reattaches after host reconstruction without launching twice and saves rotated login", async () => {
  const f = fixture()
  await run(Effect.gen(function*() {
    const handle = yield* f.job.start(input, "restart#g1")
    assert.deepEqual(yield* f.job.status(handle, "restart#g1"), { _tag: "Running" })
    const recovered = makeRemoteJob(f.options)
    assert.deepEqual(yield* recovered.status(handle, "restart#g1"), { _tag: "Running" })
    f.state.status = "Exited 0"
    const result = yield* recovered.collect(handle, "restart#g1", { _tag: "Exited", exitCode: 0 })
    assert.equal(result.result.report, "Fixed")
    assert.equal(result.work._tag, "Changed")
    assert.deepEqual(f.state.starts, ["restart#g1"])
    assert.deepEqual(f.state.saved, ["REFRESHED_LOGIN"])
    assert(!JSON.stringify(handle).includes("SECRET_LOGIN"))
    assert(!JSON.stringify(result).includes("SECRET_LOGIN"))
    assert.deepEqual(f.state.destroyed, ["restart#g1"])
  }))
})

test("remote transport outage stays retryable; confirmed loss permits the next generation", async () => {
  const f = fixture()
  await run(Effect.gen(function*() {
    const handle = yield* f.job.start(input, "lost#g1")
    f.state.unavailable = true
    assert((yield* failure(f.job.status(handle, "lost#g1"))) instanceof RemoteChildProcessSpawner.ProviderError)
    f.state.unavailable = false
    f.machines.clear()
    assert.deepEqual(yield* f.job.status(handle, "lost#g1"), { _tag: "Lost" })
    yield* f.job.start(input, "lost#g2")
    assert.deepEqual(f.state.starts, ["lost#g1", "lost#g2"])
  }))
})

test("remote cancellation terminates the retained process and releases its account", async () => {
  const f = fixture()
  await run(Effect.gen(function*() {
    const handle = yield* f.job.start(input, "cancel#g1")
    yield* f.job.cancel(handle, "cancel#g1")
    assert(f.state.commands.some((command) => command.includes("kill -TERM") && command.includes("cancelled")))
    assert.deepEqual(f.state.destroyed, ["cancel#g1"])
    assert(f.state.released.includes("cancel#g1"))
  }))
})

for (
  const [stderr, retry] of [["You have reached your usage limit", true], [
    "fatal: invalid configuration",
    false
  ]] as const
) {
  test(`remote nonzero exit ${retry ? "retries quota failure" : "fails invalid configuration"}`, async () => {
    const f = fixture()
    f.state.code = 1
    f.state.stderr = stderr
    await run(Effect.gen(function*() {
      const handle = yield* f.job.start(input, "failure#g1")
      const error = yield* failure(f.job.collect(handle, "failure#g1", { _tag: "Exited", exitCode: 1 }))
      assert(error instanceof (retry ? ExternalJob.Again : AgentFailed))
    }))
  })
}

// Run the actual RemoteFix declaration through the memory engine to prove the
// ExternalJob continuation selects a new generation after confirmed loss.
test("RemoteFix engine restarts a lost generation and returns only the replacement work", async () => {
  const f = fixture()
  const Caller = Flow.make("test/remote-fix-caller", {
    payload: {},
    success: RemoteFix.successSchema,
    error: RemoteFix.errorSchema,
    body: () => RemoteFix.call(input)
  })
  const implementations = RemoteFix.toLayer(f.job)
  const layer = Layer.mergeAll(implementations, Interpreter.layer(Caller)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(KeyValueStore.layerMemory),
    Layer.provideMerge(TestClock.layer())
  )
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Caller.execute({}, { executionId: "lost-engine" }))
      for (let turn = 0; turn < 300 && f.state.starts.length === 0; turn++) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      }
      assert.equal(f.state.starts.length, 1)
      f.machines.clear()
      for (let turn = 0; turn < 300 && f.state.starts.length < 2; turn++) {
        yield* TestClock.adjust("5 seconds")
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      }
      assert.equal(f.state.starts.length, 2)
      assert.match(f.state.starts[0]!, /#g1$/)
      assert.match(f.state.starts[1]!, /#g2$/)
      f.state.status = "Exited 0"
      for (let turn = 0; turn < 100 && f.state.destroyed.length < 2; turn++) {
        yield* TestClock.adjust("5 seconds")
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      }
      const result = yield* Fiber.join(fiber)
      assert.equal(result.result.report, "Fixed")
      assert.equal(result.work.session, f.state.starts[1])
    })).pipe(Effect.provide(layer))
  )
})

for (
  const [stdout, valid] of [[JSON.stringify({ type: "result", result: "Claude fixed" }), true], [
    "not a Claude result",
    false
  ]] as const
) {
  test(`remote Claude collection ${valid ? "decodes final result" : "rejects malformed result"}`, async () => {
    const f = fixture()
    f.state.agent = "claude"
    f.state.stdout = stdout
    await run(Effect.gen(function*() {
      const handle = yield* f.job.start(input, "claude#g1")
      if (valid) {
        const result = yield* f.job.collect(handle, "claude#g1", { _tag: "Exited", exitCode: 0 })
        assert.equal(result.result.report, "Claude fixed")
      } else {
        assert(
          (yield* failure(f.job.collect(handle, "claude#g1", { _tag: "Exited", exitCode: 0 }))) instanceof AgentFailed
        )
      }
      assert.equal(f.state.saved.length, 0)
      assert(!JSON.stringify(handle).includes("SECRET_LOGIN"))
    }))
  })
}

test("RemoteFix engine timeout cancels its retained worker", async () => {
  const f = fixture()
  const Caller = Flow.make("test/remote-fix-cancel-caller", {
    payload: {},
    success: RemoteFix.successSchema,
    error: RemoteFix.errorSchema,
    body: () => RemoteFix.call(input)
  })
  const layer = Layer.mergeAll(RemoteFix.toLayer(f.job), Interpreter.layer(Caller)).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(KeyValueStore.layerMemory),
    Layer.provideMerge(TestClock.layer())
  )
  await Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const fiber = yield* Effect.forkChild(Effect.exit(Caller.execute({}, { executionId: "cancel-engine" })))
      for (let turn = 0; turn < 300 && f.state.starts.length === 0; turn++) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      }
      assert.equal(f.state.starts.length, 1)
      for (let turn = 0; turn < 100; turn++) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      }
      yield* TestClock.adjust("3 hours")
      for (let turn = 0; turn < 300 && f.state.destroyed.length === 0; turn++) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      }
      assert.deepEqual(f.state.destroyed, f.state.starts)
      assert(f.state.commands.some((command) => command.includes("kill -TERM")))
      assert(f.state.released.includes(f.state.starts[0]!))
      const exit = yield* Fiber.join(fiber)
      assert(Exit.isFailure(exit))
    })).pipe(Effect.provide(layer))
  )
})

test("remote terminal login preparation failure destroys its acquired machine and releases account", async () => {
  const f = fixture()
  f.state.readLoginFails = true
  f.state.missingGuestLogin = true
  await run(Effect.gen(function*() {
    assert((yield* failure(f.job.start(input, "bad-login#g1"))) instanceof AgentFailed)
    assert.deepEqual(f.state.destroyed, ["bad-login#g1"])
    assert(f.state.released.includes("bad-login#g1"))
    assert.equal(f.state.starts.length, 0)
  }))
})
test("remote collect retains rotated credentials on host save failure and retries successfully", async () => {
  const f = fixture()
  await run(Effect.gen(function*() {
    const handle = yield* f.job.start(input, "save-fail#g1")
    f.state.saveLoginFails = true
    const error = yield* failure(f.job.collect(handle, "save-fail#g1", { _tag: "Exited", exitCode: 0 }))
    assert(error instanceof RemoteChildProcessSpawner.ProviderError)
    assert.equal(error.code, "unavailable")
    assert.equal(f.state.destroyed.length, 0)
    assert.equal(f.state.released.length, 0)
    f.state.saveLoginFails = false
    assert.equal((yield* f.job.collect(handle, "save-fail#g1", { _tag: "Exited", exitCode: 0 })).result.report, "Fixed")
    assert.deepEqual(f.state.saved, ["REFRESHED_LOGIN"])
    assert.deepEqual(f.state.destroyed, ["save-fail#g1"])
  }))
})
test("remote Claude credential leak fails durably and cleans up the retained machine", async () => {
  const f = fixture()
  f.state.agent = "claude"
  f.state.patch += "+REFRESHED_LOGIN\n"
  await run(Effect.gen(function*() {
    const handle = yield* f.job.start(input, "leak#g1")
    const first = yield* failure(f.job.collect(handle, "leak#g1", { _tag: "Exited", exitCode: 0 }))
    assert(first instanceof AgentFailed)
    assert(!first.message.includes("REFRESHED_LOGIN"))
    assert.deepEqual(f.state.destroyed, ["leak#g1"])
    const replay = yield* failure(f.job.collect(handle, "leak#g1", { _tag: "Exited", exitCode: 0 }))
    assert(replay instanceof AgentFailed)
    assert.equal(replay.message, first.message)
  }))
})
test("remote cancel preserves rotated login through a transient save failure", async () => {
  const f = fixture()
  await run(
    Effect.gen(function*() {
      const handle = yield* f.job.start(input, "cancel-save#g1")
      f.state.saveLoginFailures = 1
      const fiber = yield* Effect.forkChild(f.job.cancel(handle, "cancel-save#g1"))
      for (let turn = 0; turn < 100 && f.state.saveLoginFailures > 0; turn++) {
        yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)))
      }
      assert.equal(f.state.destroyed.length, 0)
      yield* TestClock.adjust("10 seconds")
      yield* Fiber.join(fiber)
      assert.deepEqual(f.state.destroyed, ["cancel-save#g1"])
      assert.deepEqual(f.state.saved, ["REFRESHED_LOGIN"])
    }).pipe(Effect.provide(TestClock.layer()))
  )
})

test("remote Start replay uses retained guest login when host login disappeared", async () => {
  const f = fixture()
  await run(Effect.gen(function*() {
    const first = yield* f.job.start(input, "login-replay#g1")
    f.state.readLoginFails = true
    assert.deepEqual(yield* f.job.start(input, "login-replay#g1"), first)
    assert.deepEqual(f.state.starts, ["login-replay#g1"])
    assert.equal(f.state.reservations, 1)
  }))
})

test("remote Start replay across launch-receipt gap preserves retained guest login", async () => {
  const f = fixture()
  await run(Effect.gen(function*() {
    const first = yield* f.job.start(input, "login-gap#g1")
    const store = yield* KeyValueStore.KeyValueStore
    yield* store.remove("issue-sweep/remote/started/login-gap#g1")
    f.state.readLoginFails = true
    assert.deepEqual(yield* f.job.start(input, "login-gap#g1"), first)
    assert.deepEqual(f.state.starts, ["login-gap#g1"])
    assert.equal(f.state.reservations, 1)
  }))
})
