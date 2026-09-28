import { describe, expect, it } from "@effect/vitest"
import { execFileSync, spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("./fixtures/bun-affected-rows.ts", import.meta.url))

// BunDatabase.test.ts shims bun:sqlite with Node, so only a real Bun process
// proves the Bun adapter's affected-row contract (issue #2419).
const bunInstalled = spawnSync("bun", ["--version"], { stdio: "ignore" }).status === 0

describe("Bun affected rows and memory deletion", () => {
  it.skipIf(!bunInstalled)("real Bun DELETE returns 1 and MemoryStore.deleteFact returns true", () => {
    const output = execFileSync("bun", [fixture], { encoding: "utf8", timeout: 60_000, killSignal: "SIGKILL" })
    expect(JSON.parse(output.trim().split("\n").at(-1)!)).toEqual({
      insert: 1,
      conflictIgnore: 0,
      returning: [{ id: 2 }],
      deleteMatch: 1,
      deleteMiss: 0,
      transaction: 1,
      remaining: [],
      deleted: true,
      deletedAgain: false,
      after: null
    })
  })
})
