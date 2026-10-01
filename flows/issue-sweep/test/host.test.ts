import assert from "node:assert/strict"
import test from "node:test"
import { Effect, Exit } from "effect"
import { isNetworkOutage, ridingOutages, staleWorkspace } from "../host.ts"

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
  assert.equal(isNetworkOutage(dns), true)
  assert.equal(isNetworkOutage("fatal: Failed to connect to github.com port 443: Operation timed out"), true)
  assert.equal(isNetworkOutage("Error: Revision `main@origin` doesn't exist"), false)
  assert.equal(isNetworkOutage("! [rejected] main -> main (fetch first)"), false)
})

test("a network outage is retried until it clears; any other failure fails at once", async () => {
  let calls = 0
  const flaky = Effect.suspend(() => ++calls < 3 ? Effect.fail({ message: dns }) : Effect.succeed("fetched"))
  assert.equal(await Effect.runPromise(ridingOutages(flaky, "1 millis")), "fetched")
  assert.equal(calls, 3)
  let refusals = 0
  const refused = Effect.suspend(() => (refusals++, Effect.fail({ message: "conflict in a.txt" })))
  assert.ok(Exit.isFailure(await Effect.runPromiseExit(ridingOutages(refused, "1 millis"))))
  assert.equal(refusals, 1)
})
