/**
 * C-UI-13 part B. Bun has no custom --stage flag: map --stage S1|S2|S3
 * to SMITHERS_INVENTORY_STAGE=S1|S2|S3 bun test ./apps/app/checks/Inventory.test.ts.
 * Expectations are reviewed literals in inventory/inventory.json, never Markdown
 * or generated production inventory. Missing stage is an error, never a default.
 * Part A and authenticated owner approval are separate closure obligations.
 */
import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import ts from "typescript"
import { isValidElement } from "react"
import inventory from "../src/mainview/inventory/inventory.json"
import { inventoryStage } from "../src/mainview/inventory/stage"

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../src/mainview")
const stage = inventoryStage(process.env.SMITHERS_INVENTORY_STAGE)
const stages = ["S1", "S2", "S3"]

// Parse declarations rather than accepting an export name in a comment/string.
function exportsIn(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(resolve(root, file), "utf8"), ts.ScriptTarget.Latest, true,
    file.endsWith("tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
  return source.statements.flatMap(statement => {
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) return []
    if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(declaration => ts.isIdentifier(declaration.name) ? [declaration.name.text] : [])
    if (ts.isFunctionDeclaration(statement) && statement.name) return [statement.name.text]
    return []
  })
}
const hasExport = (file: string, name: string) => exportsIn(file).includes(name)

for (const entry of inventory.cards.filter(entry => stages.indexOf(entry.stage) <= stages.indexOf(stage))) {
  for (const role of ["view", "container", "schema"] as const) {
    test(`inventory ${stage}: ${entry.card} ${role} ${entry[role].export}`, async () => {
      expect(hasExport(entry[role].file, entry[role].export)).toBe(true)
      if (role === "schema") {
        const module = await import(resolve(root, entry.schema.file))
        expect(typeof module[entry.schema.export]?.safeParse).toBe("function")
      }
    })
  }
}

const declaredViews = [...inventory.cards.map(entry => entry.view), ...inventory.shellViews]
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(resolve(directory, entry.name)) : [resolve(directory, entry.name)])
}
for (const file of files(resolve(root, "cards/views")).filter(file => file.endsWith(".tsx") && !/\.(test|stories)\.tsx$/.test(file))) {
  const names = exportsIn(file)
  // Include named Views even when their filename is not *View.tsx. Shell
  // helpers have literal file/export pairs because some use shorter names.
  const views = names.filter(name => name.endsWith("View") || inventory.shellViews.some(entry => resolve(root, entry.file) === file && entry.export === name))
  if (/View\.tsx$/.test(file) && views.length === 0) {
    test(`inventory ${stage}: ${file} exports a View`, () => expect(views.length).toBeGreaterThan(0))
  }
  for (const name of views) {
    test(`inventory ${stage}: View ${name} has a card or shell row`, () => {
      expect(declaredViews.some(entry => resolve(root, entry.file) === file && entry.export === name)).toBe(true)
    })
  }
}

// Exercise the registered render boundary and compare its selected component
// with the literal owner renderer. No component names are derived as oracles.
for (const entry of inventory.retained) {
  test(`inventory ${stage}: retained ${entry.kind} renders through ${entry.owner}/${entry.renderer}`, async () => {
    const { CARD_RENDERERS, renderCardBody } = await import("../src/mainview/cards/CardRenderers")
    const owner = await import(resolve(root, entry.file))
    const family = owner[entry.family]
    const registered = (CARD_RENDERERS as any)[entry.kind]
    expect(registered).toBe(family[entry.kind])
    expect(typeof registered.render).toBe("function")
    // The boundary projects a React element. Component mounting and its schema
    // snapshots remain the retained owner's tests, not synthetic part A coverage.
    const card = { id: "inventory-retained", kind: entry.kind, title: "Inventory", status: "active", createdAt: 1, ordinal: 1, payload: {} }
    const element = renderCardBody(card as any, { worldDocuments: [], onRunCommand: () => {} } as any)
    expect(isValidElement(element)).toBe(true)
    expect(typeof (element as any).type).toBe("function")
    expect((element as any).type.name).toBe(entry.renderer)
    expect((element as any).props.card).toBe(card)
  })
}
