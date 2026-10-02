import { expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

it("lists every TypeScript source file exactly once in sorted order", () => {
  const root = new URL("../", import.meta.url)
  const roster = JSON.parse(readFileSync(new URL("coverage-roster.json", root), "utf8"))
  const sources: string[] = []

  function visit(directory: string) {
    for (const entry of readdirSync(new URL(directory, root), { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(`${path}/`)
      else if (entry.isFile() && /\.tsx?$/.test(entry.name)) sources.push(path)
    }
  }

  visit("src/")
  expect(roster).toEqual(sources.sort())
})
