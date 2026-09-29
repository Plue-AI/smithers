import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Jj } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { resolveJjBinary } from "../src/node/resolveJjBinary.ts"
import { budgeted } from "./budgeted.ts"

const realJj = resolveJjBinary()

describe.skipIf(!realJj.executable)("NodeJj real-host patch race", () => {
  it("diffs the same @ even when an external jj operation advances it between calls", async () => {
    const root = mkdtempSync(join(tmpdir(), "flows-jj-patch-race-"))
    const repository = join(root, "repo")
    const target = join(root, "apply")
    const wrapper = join(root, "jj-wrapper")
    const injected = join(root, "injected")
    const earlyName = "early\nname.txt"
    const earlyContents = "early contents\n"
    const lateContents = "late contents\n"
    const previousJj = process.env.SMITHERS_JJ_PATH
    const previousReal = process.env.JJ_RACE_REAL_BINARY
    const previousRepo = process.env.JJ_RACE_REPOSITORY
    const previousMarker = process.env.JJ_RACE_MARKER

    try {
      mkdirSync(target)
      execFileSync(realJj.path, ["git", "init", repository], { stdio: "ignore" })
      writeFileSync(
        wrapper,
        `#!/bin/sh
for arg in "$@"; do
  if [ "$1" = "diff" ] && [ "$arg" = "--template" ] && [ ! -e "$JJ_RACE_MARKER" ]; then
    printf 'late contents\\n' > "$JJ_RACE_REPOSITORY/late.txt"
    "$JJ_RACE_REAL_BINARY" status >/dev/null || exit $?
    : > "$JJ_RACE_MARKER"
    break
  fi
done
exec "$JJ_RACE_REAL_BINARY" "$@"
`
      )
      chmodSync(wrapper, 0o755)
      process.env.SMITHERS_JJ_PATH = wrapper
      process.env.JJ_RACE_REAL_BINARY = realJj.path
      process.env.JJ_RACE_REPOSITORY = repository
      process.env.JJ_RACE_MARKER = injected

      const jj = await Effect.runPromise(Effect.provide(Jj, budgeted(NodeJj.layerAt(repository))))
      const baseline = await Effect.runPromise(jj.snapshot())
      expect(execFileSync(realJj.path, ["file", "list", "-r", baseline.commitId], {
        cwd: repository,
        encoding: "utf8"
      })).toBe("")

      writeFileSync(join(repository, earlyName), earlyContents)
      let patch: string | undefined
      let failure: unknown
      try {
        patch = await Effect.runPromise(jj.diff(baseline.commitId, "@"))
      } catch (error) {
        failure = error
      }

      expect(existsSync(injected)).toBe(true)
      expect(readFileSync(join(repository, "late.txt"), "utf8")).toBe(lateContents)
      expect(execFileSync(realJj.path, ["file", "list", "-r", "@"], {
        cwd: repository,
        encoding: "utf8"
      })).toContain("late.txt")
      expect(failure, "diff must use one @ despite the external jj status").toBeUndefined()
      expect(patch).toBeTypeOf("string")
      expect(patch).toContain("diff --git")

      const options = { cwd: target, input: patch, encoding: "utf8" as const }
      execFileSync("/usr/bin/git", ["apply", "--check", "-"], options)
      execFileSync("/usr/bin/git", ["apply", "-"], options)
      expect(readdirSync(target)).toEqual([earlyName])
      expect(readFileSync(join(target, earlyName), "utf8")).toBe(earlyContents)
    } finally {
      if (previousJj === undefined) delete process.env.SMITHERS_JJ_PATH
      else process.env.SMITHERS_JJ_PATH = previousJj
      if (previousReal === undefined) delete process.env.JJ_RACE_REAL_BINARY
      else process.env.JJ_RACE_REAL_BINARY = previousReal
      if (previousRepo === undefined) delete process.env.JJ_RACE_REPOSITORY
      else process.env.JJ_RACE_REPOSITORY = previousRepo
      if (previousMarker === undefined) delete process.env.JJ_RACE_MARKER
      else process.env.JJ_RACE_MARKER = previousMarker
      rmSync(root, { recursive: true, force: true })
    }
  })
})
