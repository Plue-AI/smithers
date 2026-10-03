import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { runGh as runGhImpl, runGhJsonLines } from "../../src/github/runGh.ts"
import { testIo } from "../io.ts"

const FAKE_GH = fileURLToPath(new URL("./fixtures/fake-gh", import.meta.url))

afterEach(() => {
  delete process.env.SMITHERS_GH_BIN
  delete process.env.SMITHERS_FAKE_GH_LOG
})

describe("runGh failure branches", () => {
  test("throws when the gh binary cannot be spawned (spawn error)", async () => {
    process.env.SMITHERS_GH_BIN = "/nonexistent/path/to/gh-binary-xyz"
    const tmp = await mkdtemp(join(tmpdir(), "smithers-runGh-err-"))
    try {
      await expect(runGh(tmp, ["api", "x"])).rejects.toThrow("gh api x failed:")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("throws with the stderr detail when gh exits non-zero", async () => {
    process.env.SMITHERS_GH_BIN = FAKE_GH
    const tmp = await mkdtemp(join(tmpdir(), "smithers-runGh-fail-"))
    process.env.SMITHERS_FAKE_GH_LOG = join(tmp, "log.json")
    try {
      await expect(runGh(tmp, ["api", "fail"], "")).rejects.toThrow("gh api fail failed: fixture failure")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })

  test("falls back to the exit code when a non-zero exit produces no stderr", async () => {
    // `false` exits 1 with no output → the detail is the "exited with code" fallback.
    process.env.SMITHERS_GH_BIN = "false"
    const tmp = await mkdtemp(join(tmpdir(), "smithers-runGh-silent-"))
    try {
      await expect(runGh(tmp, ["api", "quiet"])).rejects.toThrow("gh api quiet failed: exited with code 1")
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})

describe("runGhJsonLines", () => {
  test("parses one record per line, unwraps double-encoded strings, and skips junk", async () => {
    // Injected gh (the seam the function exposes) returns mixed lines: a plain
    // object, a double-encoded JSON string, a blank line, and unparseable junk.
    const gh = async () =>
      ["{\"a\":1}", JSON.stringify(JSON.stringify({ b: 2 })), "", "not json at all", "\"plain string\""].join("\n")
    const records = await runGhJsonLines("/tmp", ["api", "x"], gh)
    expect(records).toEqual([{ a: 1 }, { b: 2 }])
  })
})

const runGh = (...args: Parameters<typeof runGhImpl>) => testIo(() => runGhImpl(...args))
