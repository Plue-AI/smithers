import { Schema } from "effect"
import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { test, type TestContext } from "node:test"
import { releaseGateArgs, releaseGateCommand, releaseGates } from "../../scripts/release-gates.mjs"
import { commandRunner, type RunCommand } from "./io.ts"
import { type ReleaseGateSet, runReleaseGates } from "./operations.ts"
import { GateEvidence } from "./schema.ts"

// The real command runner launches a verifier that reads and advances a disk
// journal. It must validate each argv and the previous command's completion
// before exiting successfully. No canned successful command results are used.
const fixture = async (t: TestContext, gates: ReleaseGateSet, failAt = -1) => {
  const root = await mkdtemp(join(import.meta.dirname, ".gate-test-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const expected = gates.inventory.map((gate) => ["pnpm", "exec", "smthrs", ...releaseGateArgs(gate)])
  await writeFile(join(root, "expected.json"), JSON.stringify(expected))
  await writeFile(join(root, "completed.json"), "[]")
  await writeFile(join(root, "attempted.json"), "[]")
  await writeFile(
    join(root, "verify.mjs"),
    `
import assert from "node:assert/strict"
import { readFileSync, writeFileSync } from "node:fs"
const expected = JSON.parse(readFileSync("expected.json", "utf8"))
const completed = JSON.parse(readFileSync("completed.json", "utf8"))
const attempted = JSON.parse(readFileSync("attempted.json", "utf8"))
attempted.push(process.argv.slice(2))
writeFileSync("attempted.json", JSON.stringify(attempted))
assert.deepEqual(process.argv.slice(2), expected[completed.length])
assert.notEqual(completed.length, ${failAt}, "gate verification failed")
completed.push(process.argv.slice(2))
writeFileSync("completed.json", JSON.stringify(completed))
`
  )
  const runner = commandRunner(root)
  const run: RunCommand = (command, args, options) =>
    runner(process.execPath, ["verify.mjs", command, ...args], options)
  const completed = async () => JSON.parse(await readFile(join(root, "completed.json"), "utf8")) as string[][]
  const attempted = async () => JSON.parse(await readFile(join(root, "attempted.json"), "utf8")) as string[][]
  return { run, completed, attempted, expected }
}

test("real release gate processes complete the full inventory in order before issuing a receipt", async (t) => {
  const gates = { inventory: releaseGates, exceptions: [] }
  const state = await fixture(t, gates)
  const receipt = await runReleaseGates(state.run, gates)
  assert.deepEqual(await state.completed(), state.expected)
  assert.deepEqual(Schema.decodeUnknownSync(GateEvidence)(receipt), {
    ran: releaseGates.map((gate) => gate.name),
    exceptions: []
  })
})

test("a pending process completion blocks later gates and exceptions survive schema encoding", async (t) => {
  const [first, skipped, last] = releaseGates
  assert.ok(first && skipped && last)
  const exception = {
    name: skipped.name,
    command: releaseGateCommand(skipped),
    reason: "Fixture host has no runner container image store."
  }
  const gates = { inventory: [first, last], exceptions: [exception] }
  const state = await fixture(t, gates)
  const entered = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  t.after(() => release.resolve())
  let calls = 0
  const result = runReleaseGates(async (command, args, options) => {
    calls++
    const output = await state.run(command, args, options)
    if (calls === 1) {
      entered.resolve()
      await release.promise
    }
    return output
  }, gates)
  await Promise.race([entered.promise, result.then(() => assert.fail("receipt issued before first completion"))])
  assert.equal(calls, 1)
  assert.deepEqual(await state.completed(), state.expected.slice(0, 1))
  release.resolve()
  const receipt = await result
  assert.deepEqual(await state.completed(), state.expected)
  assert.deepEqual(Schema.decodeUnknownSync(GateEvidence)(JSON.parse(JSON.stringify(receipt))), {
    ran: [first.name, last.name],
    exceptions: [exception]
  })
  assert.equal(receipt.ran.includes(skipped.name), false)
})

test("a real gate failure prevents later processes and produces no successful receipt", async (t) => {
  const gates = { inventory: releaseGates.slice(0, 3), exceptions: [] }
  const state = await fixture(t, gates, 1)
  await assert.rejects(runReleaseGates(state.run, gates), /gate verification failed/)
  assert.deepEqual(await state.completed(), state.expected.slice(0, 1))
  assert.deepEqual(await state.attempted(), state.expected.slice(0, 2), "the third verifier never starts")
})
