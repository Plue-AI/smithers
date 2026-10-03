import { expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import ts from "typescript"

const root = resolve(import.meta.dir, "../../../..")
type Violation = "randomUUID" | "subtle" | "serviceWorker" | "clipboard"
const violations = (source: string, path: string): Violation[] => {
  if (path.endsWith("/InstallRequestId.ts") || path.endsWith("/internal/copyToClipboard.ts")) return []
  const found: Violation[] = []
  const parsed = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  const visit = (node: ts.Node): void => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const property = ts.isPropertyAccessExpression(node) ? node.name.text
        : ts.isStringLiteral(node.argumentExpression) ? node.argumentExpression.text : ""
      const receiver = node.expression.getText(parsed)
      if (/(^|\.)crypto$/.test(receiver) && (property === "randomUUID" || property === "subtle")) found.push(property)
      if (/(^|\.)navigator$/.test(receiver) && (property === "serviceWorker" || property === "clipboard")) found.push(property)
    }
    ts.forEachChild(node, visit)
  }
  visit(parsed)
  return found
}

// Literal forbidden API vocabulary from T-INS-04 / §16.3.2; comments and
// strings are inert. Clipboard enforcement joins the T-UI-01 owner gate:
// its existing consumers/helper have not yet satisfied C-INS-01. The full
// production assertion stays red until that dependency is corrected and
// consumer wiring can activate; no violations are silently excluded.
test("secure-context scanner detects each planted API violation", () => {
  for (const [source, expected] of [
    ["crypto.randomUUID()", "randomUUID"], ["window.crypto.subtle.digest('SHA-256', bytes)", "subtle"],
    ["navigator.serviceWorker.register('worker.js')", "serviceWorker"], ["navigator.clipboard.writeText(text)", "clipboard"],
    ["navigator['clipboard'].writeText(text)", "clipboard"]
  ] as const) expect(violations(source, "fixture.ts")).toEqual([expected])
  expect(violations('// crypto.randomUUID()\nconst text = "navigator.clipboard"', "fixture.ts")).toEqual([])
  expect(violations("crypto.getRandomValues(bytes)", "fixture.ts")).toEqual([])
  expect(violations("navigator.clipboard.writeText(text)", "ui/internal/copyToClipboard.ts")).toEqual([])
})

test("app and shared UI require no secure-context API", () => {
  const files = execFileSync("rg", ["--files", "apps/app/src", "packages/smithers/ui/src"], { cwd: root, encoding: "utf8" }).trim().split("\n")
  const failures: string[] = []
  for (const path of files.filter(path => /\.[cm]?[jt]sx?$/.test(path))) {
    for (const violation of violations(readFileSync(resolve(root, path), "utf8"), path)) {
      failures.push(`${path}: ${violation}`)
    }
  }
  expect(failures).toEqual([])
})
