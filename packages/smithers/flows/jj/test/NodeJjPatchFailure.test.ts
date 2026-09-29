import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Jj, JjError } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { budgeted } from "./budgeted.ts"

const installed = (): boolean => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!installed())("NodeJj real-host patch normalization failure", () => {
  it("returns a typed error and releases the lock for a later diff", async () => {
    const repository = mkdtempSync(join(tmpdir(), "flows-jj-patch-failure-"))
    const target = mkdtempSync(join(tmpdir(), "flows-jj-patch-recovery-"))
    const filename = "line\nbreak.txt"
    const contents = "recovered path\n"
    const key = "template-aliases.\"json(x)\""

    try {
      execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
      const jj = await Effect.runPromise(Effect.provide(Jj, budgeted(NodeJj.layerAt(repository))))
      const empty = await Effect.runPromise(jj.snapshot())
      expect(execFileSync("jj", ["file", "list", "-r", empty.commitId], {
        cwd: repository,
        encoding: "utf8"
      })).toBe("")

      writeFileSync(join(repository, filename), contents)
      const added = await Effect.runPromise(jj.snapshot())
      execFileSync("jj", ["config", "set", "--repo", key, JSON.stringify("42")], { cwd: repository })

      const failure = await Effect.runPromise(Effect.flip(jj.diff(empty.commitId, added.commitId)))
      expect(failure).toBeInstanceOf(JjError)
      if (!(failure instanceof JjError)) throw failure
      expect(failure).toMatchObject({ code: "unknown", method: "diff" })
      expect(failure.cause?.message).toContain("Invalid jj diff path metadata")

      execFileSync("jj", ["config", "unset", "--repo", key], { cwd: repository })
      const patch = await Effect.runPromise(jj.diff(empty.commitId, added.commitId))
      const options = { cwd: target, input: patch, encoding: "utf8" as const }
      execFileSync("git", ["apply", "--check", "-"], options)
      execFileSync("git", ["apply", "-"], options)
      expect(readFileSync(join(target, filename), "utf8")).toBe(contents)
    } finally {
      rmSync(target, { recursive: true, force: true })
      rmSync(repository, { recursive: true, force: true })
    }
  })
})
