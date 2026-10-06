import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// T-UI-16: CodeSurface is already reachable; T-APP-11 wires its live props. No new View.
// Views built dark await their owning wiring tickets. Wiring removes its row.
const PENDING_WIRING: Record<string, string> = {
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

// T-APP-14a replaces CodeSurface's CodeFileView with the restored CodeMirror View.
test("the restored file editor is mounted and its replaced renderer is deleted", () => {
  expect(reachable.has(join(root, "cards/views/CodeEditorView.tsx"))).toBe(true)
  expect(() => statSync(join(root, "cards/CodeSurface.tsx"))).toThrow()
})

// T-APP-21 adds a card without replacing a legacy renderer.
const API_WIRING = { view: "DebugApiView.tsx", ticket: "T-APP-21", legacy: [] as string[] }
test("T-APP-21 mounts DebugApiView through CardRenderers", () => {
  visit(join(root, "cards/CardRenderers.tsx"))
  expect(reachable.has(join(root, "cards/views", API_WIRING.view))).toBe(true)
  for (const path of API_WIRING.legacy) expect(() => statSync(join(root, path))).toThrow()
})

const SECRETS_WIRING = { view: "SecretsView.tsx", ticket: "T-APP-13" }
test("T-APP-13 mounts SecretsView and deletes the legacy table", () => {
  visit(join(root, "cards/CardRenderers.tsx"))
  expect(reachable.has(join(root, "cards/views", SECRETS_WIRING.view))).toBe(true)
  const source = readFileSync(join(root, "cards/SecretsCard.tsx"), "utf8")
  expect(source).not.toContain("<table")
  expect(source).not.toContain("secrets-table")
})
