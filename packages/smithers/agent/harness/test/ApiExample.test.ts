import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const example = readFileSync(new URL("../docs/api.md", import.meta.url), "utf8")
  .split("## Example\n")[1]!
  .split("## Entry points\n")[0]!

const fenced = (language: string) =>
  [...example.matchAll(/^(`{3,})(\w+)\r?\n([\s\S]*?)^\1[ \t]*$/gm)]
    .filter((match) => match[2] === language)
    .map((match) => match[3]!)

it("executes the API example and prints its documented result", () => {
  const code = fenced("ts")
  const output = fenced("text")
  expect(code).toHaveLength(1)
  expect(output).toHaveLength(1)

  const directory = mkdtempSync(join(fileURLToPath(new URL("..", import.meta.url)), ".api-example-"))
  try {
    const path = join(directory, "example.ts")
    writeFileSync(path, code[0]!)
    const result = spawnSync(process.execPath, ["--experimental-strip-types", path], {
      encoding: "utf8",
      timeout: 30_000
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim()).toBe(output[0]!.trim())
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
