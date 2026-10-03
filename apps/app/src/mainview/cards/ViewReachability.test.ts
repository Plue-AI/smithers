import { expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, extname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Existing views awaiting their owning wiring tickets; this list must only shrink.
const PENDING_WIRING: Record<string, string> = {
  "HomeView.tsx": "T-APP-01",
  "HomeActionView.tsx": "T-APP-01",
  "HomeRowView.tsx": "T-APP-01",
  "TodoView.tsx": "T-APP-02",
  "TodoActionView.tsx": "T-APP-02",
  "DraftView.tsx": "T-APP-02",
  "SetupView.tsx": "T-APP-03",
  "SettingsView.tsx": "T-APP-03",
  "ConfirmView.tsx": "T-APP-04",
  "FlowView.tsx": "T-APP-05",
  "FlowActionView.tsx": "T-APP-05",
  "MembersView.tsx": "T-APP-06",
  "MembersActionView.tsx": "T-APP-06",
  "EdgeRowView.tsx": "T-APP-07",
  "EdgeGroupView.tsx": "T-APP-07",
  "ToastNoticeView.tsx": "T-APP-07",
  "TimelineLineView.tsx": "T-APP-07",
  "CodeEditorView.tsx": "T-UI-11",
  "DiffView.tsx": "T-UI-11",
  "CommandsView.tsx": "T-UI-14",
  "CommandActionView.tsx": "T-UI-14",
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
