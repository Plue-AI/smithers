import assert from "node:assert/strict"
import test from "node:test"
import { Fault } from "@smthrs/flow"
import { Unreachable } from "@smthrs/kernel"
import { TestClock } from "effect/testing"
import { Effect, Exit, Fiber } from "effect"
import { ridingOutages, staleWorkspace } from "../host.ts"

const refused = (stderr: string) => ({ stdout: "", stderr, code: 255 })
const sibling = "Internal error: The repo was loaded at operation 3798008d8429, which seems to be a sibling of " +
  "the working copy's operation baea8ee8ed27\nHint: Run `jj op integrate baea8ee8ed27`"

// #3228: one such refusal failed a workspace and stopped the whole round.
test("a jj -R command refused for a sibling or stale working-copy operation names its workspace", () => {
  assert.equal(staleWorkspace(["-R", "/w/issue-1", "log", "-r", "@"], refused(sibling)), "/w/issue-1")
  assert.equal(
    staleWorkspace(["-R", "/w/issue-2", "st"], refused("Error: The working copy is stale (not updated since op 1)")),
    "/w/issue-2"
  )
})

test("other failures, successes and commands without -R are left alone", () => {
  assert.equal(staleWorkspace(["-R", "/w", "log"], refused("Error: Revision `x` doesn't exist")), undefined)
  assert.equal(staleWorkspace(["-R", "/w", "log"], { stdout: "", stderr: sibling, code: 0 }), undefined)
  assert.equal(staleWorkspace(["git", "fetch"], refused(sibling)), undefined)
  assert.equal(staleWorkspace(["-R"], refused(sibling)), undefined)
})

// 2026-10-01: a 75-minute DNS outage failed 109 landings and 9 adoptions as final.
const dns = "Error: Git process failed: External git program failed: fatal: unable to access " +
  "'https://github.com/smithersai/smithers.git/': Could not resolve host: github.com"

test("a failure names a network outage only when git or curl says the network failed", () => {
  assert.equal(Unreachable.classifyExit(dns) instanceof Unreachable.Unreachable, true)
  assert.equal(Unreachable.classifyExit("fatal: Failed to connect to github.com port 443: Operation timed out") instanceof Unreachable.Unreachable, true)
  assert.equal(Unreachable.classifyExit("Error: Revision `main@origin` doesn't exist"), undefined)
  assert.equal(Unreachable.classifyExit("! [rejected] main -> main (fetch first)"), undefined)
})

test("a network outage retries with transient backoff; other failures fail at once", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    let calls = 0
    const flaky = Effect.suspend(() => ++calls < 3 ? Effect.fail({ message: dns }) : Effect.succeed("fetched"))
    const fiber = yield* ridingOutages(flaky).pipe(Effect.forkChild)
    yield* TestClock.adjust(4999)
    assert.equal(calls, 1)
    yield* TestClock.adjust(1)
    assert.equal(calls, 2)
    yield* TestClock.adjust(10000)
    assert.equal(yield* Fiber.join(fiber), "fetched")
    assert.equal(calls, 3)
    let refusals = 0
    const failure = { message: "conflict in a.txt", detail: "original typed error" }
    const refused = Effect.suspend(() => (refusals++, Effect.fail(failure)))
    const exit = yield* ridingOutages(refused).pipe(Effect.exit)
    assert.ok(Exit.isFailure(exit))
    assert.equal(refusals, 1)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      assert.equal(reason?._tag === "Fail" && reason.error, failure)
    }
  }).pipe(Effect.provide(TestClock.layer())))
})

test("exhausting transient retries restores the final original typed host error", async () => {
  await Effect.runPromise(Effect.gen(function*() {
    let attempts = 0
    let last: { message: string; code: number } | undefined
    const failed = Effect.suspend(() => {
      last = { message: dns, code: ++attempts }
      return Effect.fail(last)
    })
    const fiber = yield* ridingOutages(failed).pipe(Effect.exit, Effect.forkChild)
    yield* TestClock.adjust(7200000)
    const exit = yield* Fiber.join(fiber)
    assert.ok(Exit.isFailure(exit))
    assert.ok(attempts > 20)
    if (Exit.isFailure(exit)) {
      const reason = exit.cause.reasons.find((reason) => reason._tag === "Fail")
      assert.equal(reason?._tag === "Fail" && reason.error, last)
    }
  }).pipe(Effect.provide(TestClock.layer())))
})

test("network signatures retry even when the original host error is registered as a bug", async () => {
  Fault.register("test/HostOutageBug", "bug")
  await Effect.runPromise(Effect.gen(function*() {
    let attempts = 0
    const failure = { _tag: "test/HostOutageBug", message: dns }
    const fiber = yield* ridingOutages(Effect.suspend(() => ++attempts < 3
      ? Effect.fail(failure) : Effect.succeed("recovered"))).pipe(Effect.forkChild)
    yield* TestClock.adjust(15000)
    assert.equal(yield* Fiber.join(fiber), "recovered")
    assert.equal(attempts, 3)
    assert.equal(Fault.of(failure).class, "bug")
  }).pipe(Effect.provide(TestClock.layer())))
})
