import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// T-UI-16: CodeSurface is already reachable; T-APP-11 wires its live props. No new View.
// Views built dark await their owning wiring tickets. Wiring removes its row.
const PENDING_WIRING: Record<string, string> = {
  "FilePresenceView.tsx": "T-APP-14",
  "DebugApiView.tsx": "T-APP-21",
  "SecretsView.tsx": "T-APP-13",
  "DocsView.tsx": "T-APP-20",
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..")
const entries = [join(root, "App.tsx"), join(root, "cards/CardRenderers.tsx")]
const reachable = new Set<string>()
const visit = (file: string) => {
  if (reachable.has(file)) return
  reachable.add(file)
  const source = readFileSync(file, "utf8")
  for (const [, specifier] of source.matchAll(/(?:from\s*|import\s*)["'](\.[^"']+)["']/g)) {
    const base = resolve(dirname(file), specifier!)
    const dependency = [base, ...[".ts", ".tsx"].map(extension => `${base}${extension}`)].find(path => {
      try { return statSync(path).isFile() && [".ts", ".tsx"].includes(extname(path)) } catch { return false }
    })
    if (dependency) visit(dependency)
  }
}

test("every card and shell view is reachable from its renderer", () => {
  for (const entry of entries) visit(entry)
  const views = readdirSync(join(root, "cards/views"), { withFileTypes: true })
    .filter(file => file.isFile() && file.name.endsWith("View.tsx"))
    .map(file => file.name)
  expect(views.filter(view => !reachable.has(join(root, "cards/views", view))).sort())
    .toEqual(Object.keys(PENDING_WIRING).sort())
})
