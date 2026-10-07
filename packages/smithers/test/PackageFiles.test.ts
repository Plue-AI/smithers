import { readdirSync, readFileSync } from "node:fs"
import { dirname, join, matchesGlob, relative, resolve } from "node:path"
import { describe, expect, it } from "vitest"

const root = resolve(import.meta.dirname, "..")
const files: string[] = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).files
const jsonImport = /from\s+"(\.{1,2}\/[^"]+\.json)"\s+with\s+\{\s*type:\s*"json"\s*\}/g

function sources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sources(path)
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : []
  })
}

// The build emits each imported JSON module beside its JavaScript; npm pack
// keeps only what "files" matches. A dropped catalog.mvp.json crashed every
// installed CLI at startup (#3754).
describe("package files", () => {
  it("ship every JSON module the source imports", () => {
    const missing: string[] = []
    for (const source of sources(join(root, "src"))) {
      for (const [, specifier] of readFileSync(source, "utf8").matchAll(jsonImport)) {
        if (specifier === undefined) throw new Error(`JSON import has no specifier in ${source}`)
        const target = relative(join(root, "src"), resolve(dirname(source), specifier))
        for (const flavor of ["esm", "cjs"]) {
          const shipped = `dist/${flavor}/${target}`
          if (!files.some((glob) => matchesGlob(shipped, glob))) missing.push(shipped)
        }
      }
    }
    expect([...new Set(missing)]).toEqual([])
  })
})
