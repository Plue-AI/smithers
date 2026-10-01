import { Capability } from "@smthrs/kernel"
import * as CommandLine from "@smthrs/kernel/CommandLine"
import { Option } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import assert from "node:assert/strict"
import test from "node:test"
import { claimTool } from "../flow.ts"
import { proxyTool } from "../github.ts"

const proxyGrant = "proc:spawn:node /*/scripts/github-proxy.mjs --ensure"

const allows = (grant: string, command: string, args: ReadonlyArray<string>) => {
  const pattern = Option.getOrThrow(Capability.parsePattern(grant))
  const line = CommandLine.resource(ChildProcess.make(command, args) as ChildProcess.StandardCommand)
  return Capability.matches(pattern, Capability.make("proc:spawn", line))
}

test("the proxy grant admits exactly the proxy start, never other node code", () => {
  assert.equal(allows(proxyGrant, "node", [proxyTool, "--ensure"]), true)
  assert.equal(allows(proxyGrant, "node", ["-e", "process.exit(0)"]), false)
  assert.equal(allows(proxyGrant, "node", [proxyTool, "--ensure", "--port", "1"]), false)
  assert.equal(allows(proxyGrant, "node", ["-e", "x", proxyTool, "--ensure"]), false)
  assert.equal(allows(proxyGrant, "node", ["/tmp/other.mjs", "--ensure"]), false)
})

test("the claim grant admits the claim tool beside the flow with any arguments, and nothing else", () => {
  const grant = "proc:spawn:node /*/scripts/issue-claim.mjs *"
  assert.equal(allows(grant, "node", [claimTool, "claim", "o/r#1", "--by", "issue-sweep"]), true)
  assert.equal(allows(grant, "node", ["-e", "process.exit(0)"]), false)
  assert.equal(allows(grant, "node", [proxyTool, "--ensure"]), false)
})
