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

// T-APP-05 keeps the embedded and maximized Flow card on one renderer.
const FLOW_WIRING = { view: "FlowView.tsx", ticket: "T-APP-05", legacy: ["cards/WorkflowCards.tsx", "cards/FlowContainer.tsx"] }
test("T-APP-05 mounts FlowView and removes both replaced renderers", () => {
  visit(join(root, "cards/CardRenderers.tsx"))
  expect(reachable.has(join(root, "cards/views", FLOW_WIRING.view))).toBe(true)
  for (const path of FLOW_WIRING.legacy) expect(() => statSync(join(root, path))).toThrow()
})

const SECRETS_WIRING = { view: "SecretsView.tsx", ticket: "T-APP-13" }
test("T-APP-13 mounts SecretsView and deletes the legacy table", () => {
  visit(join(root, "cards/CardRenderers.tsx"))
  expect(reachable.has(join(root, "cards/views", SECRETS_WIRING.view))).toBe(true)
  const source = readFileSync(join(root, "cards/SecretsCard.tsx"), "utf8")
  expect(source).not.toContain("<table")
  expect(source).not.toContain("secrets-table")
})

// T-APP-12 moves the terminal facet to the single Terminal card mount.
const TERMINAL_WIRING = { view: "TerminalView.tsx", ticket: "T-APP-12" }
test("T-APP-12 mounts TerminalView and removes the Workspace terminal facet", () => {
  visit(join(root, "cards/CardRenderers.tsx"))
  expect(reachable.has(join(root, "cards/views", TERMINAL_WIRING.view))).toBe(true)
  const renderer = readFileSync(join(root, "cards/CardRenderers.tsx"), "utf8")
  expect(renderer).toContain("terminalCardFamily")
  const workspace = join(root, "cards/WorkspaceCard.tsx")
  // T-APP-10 may have removed the remaining Workspace card altogether.
  try { statSync(workspace) } catch { return }
  const source = readFileSync(workspace, "utf8")
  expect(source).not.toContain("CloudTerminal")
  expect(source).not.toContain("<Terminal")
  expect(source).not.toContain('case "terminal"')
})

// T-APP-03: Setup and Settings replace these families together. Recorded
// legacy payloads remain decodable. The neighboring cut ticket retains the
// deferred RepositoryChoice source for persisted history (mvp.md §8).
const INSTALL_WIRING = [
  { view: "SetupView.tsx", legacy: ["AccountCard.tsx", "EnvCard.tsx", "RepoImportCard.tsx"] },
  { view: "SettingsView.tsx", legacy: ["ProviderAccountsCard.test.tsx", "CardActions.ts", "InstallCardActions.ts"] }
]
test("T-APP-03 mounts Setup and Settings and deletes their replaced families", () => {
  visit(join(root, "cards/CardRenderers.tsx"))
  for (const { view, legacy } of INSTALL_WIRING) {
    expect(reachable.has(join(root, "cards/views", view))).toBe(true)
    for (const file of legacy) expect(() => statSync(join(root, "cards", file))).toThrow()
  }
  expect(readFileSync(join(root, "cards/SecretsCard.tsx"), "utf8")).not.toContain("ProviderAccountsCardBody")
  expect(readFileSync(join(root, "cards/SyncCards.tsx"), "utf8")).not.toContain('"connector-setup"')
})
