import assert from "node:assert/strict"
import test from "node:test"
import { staleWorkspace } from "../host.ts"

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
