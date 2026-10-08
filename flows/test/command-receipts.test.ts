import { NodeFileSystem } from "@effect/platform-node"
import { Effect, FileSystem } from "effect"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { ModuleOwner } from "../../packages/smithers/src/internal/ModuleOwner.ts"
import { commandReceipts } from "../coding/command-receipts.ts"

test("private command receipts invalidate old exits, survive replacement and fail closed on corrupt storage", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "command-receipts-"))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const fs = await Effect.runPromise(FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)))
  const audit = commandReceipts(fs, directory)
  assert.equal(await Effect.runPromise(audit.begin(["/bin/sh"])), undefined)
  const begin = () =>
    Effect.runPromise(
      audit.begin(["/bin/sh", "-c", "figlet"]).pipe(
        Effect.provideService(ModuleOwner, { rootId: "root/../with-path", flowId: "todo" })
      )
    )
  const complete = await begin()
  assert.ok(complete)
  const running = await Effect.runPromise(audit.read("root/../with-path"))
  assert.equal(running?.status, "running")
  await Effect.runPromise(complete({ exitCode: 127, stderr: { text: "sh: figlet: not found\n" }, fault: "factory" }))
  const replacement = commandReceipts(fs, directory)
  const failed = await Effect.runPromise(replacement.read("root/../with-path"))
  assert.equal(failed?.status, "completed")
  assert.equal(failed?.exitCode, 127)
  assert.equal(failed?.fault, "factory")
  const next = await begin()
  assert.ok(next)
  const pending = await Effect.runPromise(replacement.read("root/../with-path"))
  assert.equal(pending?.status, "running")
  assert.equal(pending?.exitCode, undefined)
  assert.notEqual(pending?.operationId, failed?.operationId)
  await Effect.runPromise(next({ exitCode: 0, stderr: { text: "" } }))
  assert.equal((await Effect.runPromise(replacement.read("root/../with-path")))?.exitCode, 0)
  assert.equal(await Effect.runPromise(replacement.read("another-run")), undefined)
  const file = join(directory, createHash("sha256").update("root/../with-path").digest("hex") + ".json")
  for (
    const bytes of [
      "broken",
      "{}",
      "{\"runId\":\"root\",\"operationId\":\"op\",\"status\":\"invented\",\"argv\":[\"sh\"]}"
    ]
  ) {
    await writeFile(file, bytes)
    await assert.rejects(Effect.runPromise(replacement.read("root/../with-path")))
  }
  const refusing = commandReceipts({ ...fs, rename: () => Effect.die(new Error("receipt disk refused")) }, directory)
  await assert.rejects(
    Effect.runPromise(
      refusing.begin(["sh"]).pipe(
        Effect.provideService(ModuleOwner, { rootId: "another-run", flowId: "todo" })
      )
    ),
    /receipt disk refused/
  )
})
