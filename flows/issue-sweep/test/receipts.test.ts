import { Effect, Exit } from "effect"
import assert from "node:assert/strict"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { makeReservations } from "../accounts.ts"
import { make, restoreAssignments, values } from "../work/receipts.ts"

test("long durable identities persist in bounded filenames and reconstruct without collisions or traversal", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "issue-sweep-receipts-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = await Effect.runPromise(make(join(root, "receipts")))
  const key = `job/${"long/execution/".repeat(1000)}#g0`
  const other = key.replace("#g0", "#g1")
  await Effect.runPromise(store.set(key, JSON.stringify({ remoteId: "machine-one" })))
  await Effect.runPromise(store.set(other, "second"))
  await Effect.runPromise(store.set("../../outside", "third"))
  const restored = await Effect.runPromise(make(join(root, "receipts")))
  assert.equal(await Effect.runPromise(restored.get(key)), "{\"remoteId\":\"machine-one\"}")
  assert.equal(await Effect.runPromise(restored.get(other)), "second")
  assert.equal(await Effect.runPromise(restored.get("absent")), undefined)
  assert.equal(await Effect.runPromise(restored.size), 3)
  for (const name of await fs.readdir(join(root, "receipts"))) assert.match(name, /^[a-f0-9]{64}\.json$/)
  await Effect.runPromise(restored.remove(other))
  await Effect.runPromise(restored.remove(other))
  assert.equal(await Effect.runPromise(restored.get(other)), undefined)
  assert.equal(await Effect.runPromise(restored.size), 2)
  await fs.writeFile(join(root, "receipts", ".interrupted.tmp"), "partial")
  await Effect.runPromise(restored.clear)
  assert.equal(await Effect.runPromise(restored.size), 0)
  assert.deepEqual(await fs.readdir(join(root, "receipts")), [".interrupted.tmp"])
})

test("a failed atomic publication preserves the previous complete receipt and cleans its temporary file", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "issue-sweep-receipts-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = await Effect.runPromise(make(root))
  await Effect.runPromise(store.set("job", "old complete receipt"))
  const rename = t.mock.method(fs, "rename", async () => {
    throw Object.assign(new Error("disk failed before publication"), { code: "EIO" })
  })
  const failed = await Effect.runPromiseExit(store.set("job", "replacement receipt"))
  assert.ok(Exit.isFailure(failed))
  rename.mock.restore()
  assert.equal(await Effect.runPromise(store.get("job")), "old complete receipt")
  assert.equal((await fs.readdir(root)).length, 1)
  await Effect.runPromise(store.set("job", "replacement receipt"))
  assert.equal(await Effect.runPromise(store.get("job")), "replacement receipt")
})

test("cold hosts enumerate only committed receipt values before account admission", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "issue-sweep-receipts-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  assert.deepEqual(await Effect.runPromise(values(root)), [])
  const directory = join(root, ".flows", "issue-sweep-jobs")
  const store = await Effect.runPromise(make(directory))
  const one = JSON.stringify({ key: "one#g0", agent: "codex", account: "codex-1" })
  const two = JSON.stringify({ key: "two#g0", agent: "claude", account: "claude-2" })
  await Effect.runPromise(store.set("job/one", one))
  await Effect.runPromise(store.set("job/two", two))
  await fs.writeFile(join(directory, ".uncommitted.tmp"), "partial assignment")
  await fs.writeFile(join(directory, "unrelated"), "unrelated")
  assert.deepEqual((await Effect.runPromise(values(root))).sort(), [one, two].sort())
  await Effect.runPromise(store.remove("job/one"))
  assert.deepEqual(await Effect.runPromise(values(root)), [two])
})

test("cold preload restores account holds before new starts and skips collected and job receipts", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "issue-sweep-receipts-"))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const store = await Effect.runPromise(make(join(root, ".flows", "issue-sweep-jobs")))
  const assignment = { key: "parked#g0", agent: "codex", account: "codex-1" }
  await Effect.runPromise(store.set("issue-sweep/remote/account/parked#g0", JSON.stringify(assignment)))
  await Effect.runPromise(
    store.set("issue-sweep/remote/collected/completed#g0", JSON.stringify({ _tag: "Done", value: {} }))
  )
  await Effect.runPromise(store.set("sandbox/job/other#g0", JSON.stringify({ id: "other#g0", remoteId: "machine" })))
  const picker = makeReservations(1)
  await Effect.runPromise(restoreAssignments(root, picker.restore))
  await Effect.runPromise(restoreAssignments(root, picker.restore))
  const pools = { codex: { ready: ["codex-1"], unavailable: [] }, claude: { ready: [], unavailable: [] } }
  assert.equal(picker.reserve(pools, 2), undefined, "parked job blocks new account selection before its first probe")
  picker.release("parked#g0")
  const available = picker.reserve(pools, 2)!
  assert.equal(available.account, "codex-1", "repeated preload creates one hold and ignores other receipt shapes")
  available.release()
})
