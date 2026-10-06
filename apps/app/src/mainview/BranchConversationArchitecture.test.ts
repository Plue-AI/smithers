import { expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { resolve } from "node:path"

test("branch conversations have no browser tool continuation", async () => {
  const glob = new Bun.Glob("**/*.ts")
  const calls: string[] = []
  for await (const path of glob.scan({ cwd: import.meta.dir, absolute: true })) {
    if (path.includes(".test.") || path.includes("/testdata/")) continue
    const source = await readFile(path, "utf8")
    if (/\.executeForAgent\s*\(/.test(source)) calls.push(path)
  }
  expect(calls).toEqual([])
  expect(existsSync(resolve(import.meta.dir, "state/controller/httpTurns.ts"))).toBe(false)
  const history = await readFile(resolve(import.meta.dir, "native/WebAgent.ts"), "utf8")
  expect(history).not.toMatch(/TURN_PATH|CANCEL_PATH|TURN_RETIRE_PATH|function_call_output/)
})
