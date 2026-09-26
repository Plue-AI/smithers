import { Effect, Fiber } from "effect"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import type { RunView } from "./client.ts"
import * as Notify from "./notify.ts"

const scratch = mkdtempSync(join(tmpdir(), "org-notify-"))
after(() => rmSync(scratch, { recursive: true, force: true }))
for (const name of ["state", "failing", "empty"]) mkdirSync(join(scratch, name))

const gate = (runId: string, digest: string): RunView => ({
  runId,
  flowId: "organization/deliver",
  status: "waiting-approval",
  gates: [{ runId, gateId: "land", subjectDigest: digest, prompt: "Land this change?\nDiff: 1 file", wait: "gate" }]
})
const failed = (runId: string): RunView => ({ runId, flowId: "organization/deliver", status: "failed", gates: [] })

test("tells the owner each gate and failure once, across restarts, and not failures from before it started", async () => {
  const stateDir = join(scratch, "state")
  const shown: Array<string> = []
  let runs: ReadonlyArray<RunView> = [gate("run-1", "d1"), failed("run-0")]
  const options: Notify.Options = {
    stateDir,
    runs: async () => runs,
    notify: (notice) => shown.push(notice.text),
    log: () => {}
  }

  assert.deepEqual((await Notify.check(options)).map((notice) => notice.text), ["answer land: Land this change?"])
  assert.equal(statSync(join(stateDir, "notified.json")).mode & 0o777, 0o600)
  runs = [gate("run-1", "d1"), failed("run-0"), failed("run-2"), gate("run-3", "d3")]
  await Notify.check(options)
  // A restarted host reads what was told.
  await Notify.check({ ...options })
  assert.deepEqual(shown, ["answer land: Land this change?", "run-2 failed", "answer land: Land this change?"])
})

test("keeps looking when a notice cannot be shown or the runs cannot be read", async () => {
  const stateDir = join(scratch, "failing")
  const lines: Array<string> = []
  const told = await Notify.check({
    stateDir,
    runs: async () => [gate("run-1", "d1")],
    notify: () => {
      throw new Error("no display")
    },
    log: (line) => lines.push(line)
  })
  assert.equal(told.length, 1)
  assert.deepEqual(lines, ["notification failed: no display"])
  // An empty look on a new state directory still records that it looked.
  await Notify.check({ stateDir: join(scratch, "empty"), runs: async () => [], notify: () => {}, log: () => {} })
  assert.deepEqual(JSON.parse(readFileSync(join(scratch, "empty", "notified.json"), "utf8")), { keys: [] })

  const fiber = Effect.runFork(Notify.watcher({
    stateDir,
    runs: async () => {
      throw new Error("control unavailable")
    },
    notify: () => {},
    log: (line) => lines.push(line)
  }))
  await new Promise((done) => setTimeout(done, 50))
  await Effect.runPromise(Fiber.interrupt(fiber))
  assert.equal(lines.at(-1), "notifications: control unavailable")
})

test("is on by default on a Mac without Slack, and passes the text to osascript as data", () => {
  assert.equal(Notify.enabled({}, false, "darwin"), true)
  assert.equal(Notify.enabled({ SMITHERS_ORG_NOTIFY: "off" }, false, "darwin"), false)
  assert.equal(Notify.enabled({ SMITHERS_ORG_NOTIFY: "OFF" }, false, "darwin"), false)
  assert.equal(Notify.enabled({}, true, "darwin"), false)
  assert.equal(Notify.enabled({}, false, "linux"), false)
  const args = Notify.osascript({ key: "k", text: "answer land: \"quoted\" & done" })
  assert.equal(args.at(-1), "answer land: \"quoted\" & done")
  assert.ok(!args.slice(0, -1).join(" ").includes("quoted"))
})
