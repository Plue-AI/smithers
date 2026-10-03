import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// T-UI-16: CodeSurface is already reachable; T-APP-11 wires its live props. No new View.
// Existing views awaiting their owning wiring tickets; this list must only shrink.
const PENDING_WIRING: Record<string, string> = {
  "BranchView.tsx": "T-APP-10",
  "TodoView.tsx": "T-APP-02",
  "DraftView.tsx": "T-APP-02",
  "SettingsView.tsx": "T-APP-03",
embersView.tsx": "T-APP-06",
  "CommandsView.tsx": "T-UI-14",
  "TerminalView.tsx": "T-APP-12",
  "SecretsView.tsx": "T-APP-13",
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
