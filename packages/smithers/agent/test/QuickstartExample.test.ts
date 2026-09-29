import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { expect, it } from "vitest"

const quickstart = readFileSync(new URL("../docs/quickstart.md", import.meta.url), "utf8")

const fenced = (language: string) =>
  [...quickstart.matchAll(/^(`{3,})(\w+)\r?\n([\s\S]*?)^\1[ \t]*$/gm)]
    .filter((match) => match[2] === language)
    .map((match) => match[3]!)

it("executes every quickstart code block and prints its documented result", () => {
  const code = fenced("ts")
  const output = fenced("text")
  expect(code).toHaveLength(4)
  expect(output).toHaveLength(1)

  const directory = mkdtempSync(join(fileURLToPath(new URL("..", import.meta.url)), ".quickstart-example-"))
  try {
    const path = join(directory, "quickstart.ts")
    writeFileSync(path, code.join("\n"))
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
