import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"

const packageRoot = join(import.meta.dirname, "..")

const sources = (dir: string): Array<{ path: string; source: string }> =>
  readdirSync(join(packageRoot, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    return entry.isDirectory()
      ? sources(path)
      : entry.name.endsWith(".ts")
      ? [{ path, source: readFileSync(join(packageRoot, path), "utf8") }]
      : []
  })

describe("the exports in this package", () => {
  test("declare their version in an immediately preceding JSDoc @since tag", () => {
    const missing = sources("src").flatMap(({ path, source }) => {
      const lines = source.split("\n")
      return lines.flatMap((line, index) => {
        if (!/^\s*export (?:const|type|interface|class|function|enum)\b/.test(line)) return []
        const preceding = lines.slice(0, index).join("\n").trimEnd()
        const comment = preceding.match(/\/\*\*((?:(?!\/\*\*|\*\/).)*?)\*\/$/s)
        return comment !== null && /@since\b/.test(comment[0]) ? [] : [`${path}:${index + 1}`]
      })
    })
    expect(missing).toEqual([])
  })
})
