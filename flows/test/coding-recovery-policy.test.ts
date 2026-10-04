import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import ts from "typescript"

// Declaration lint complements the engine crossing tests. These are the
// retained TODO's command-check and delivery adapters, including local shell
// publication; inspecting their syntax catches a silently restored default.
test("TODO shell and delivery actions explicitly declare recovery policy", () => {
  const expected = new Map([
    ["coding/check-command", "sealed"],
    ["coding/check", "sealed"],
    ["coding/submit-vibe-lane", "irreversible"],
    ["coding/open-vibe-pull", "irreversible"],
    ["coding/create-vibe-landing", "irreversible"],
    ["coding/queue-vibe-append", "irreversible"],
    ["coding/prepare-vibe-candidate", "irreversible"],
    ["coding/fast-forward-vibe", "irreversible"],
    ["coding/open-vibe-local-pull", "irreversible"],
    ["coding/merge-vibe-local-pull", "irreversible"]
  ])
  for (const file of ["checks.ts", "workflow.ts", "vibe-landing.ts"]) {
    const source = ts.createSourceFile(
      file,
      readFileSync(new URL(`../coding/${file}`, import.meta.url), "utf8"),
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS
    )
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && node.expression.getText(source) === "Action.make") {
        const [name, options] = node.arguments
        assert.ok(name && ts.isStringLiteral(name))
        if (expected.has(name.text) || file !== "workflow.ts") {
          assert.ok(options && ts.isObjectLiteralExpression(options))
          const fields = new Map(
            options.properties.filter(ts.isPropertyAssignment)
              .map((property) => [property.name.getText(source), property.initializer.getText(source)])
          )
          assert.equal(fields.get("tier"), JSON.stringify(expected.get(name.text) ?? "sealed"), name.text)
          // Until lookup providers are wired, irreversible shell crossings are
          // explicitly keyless. Do not turn a stable string into unsafe retry.
          assert.equal(fields.get("idempotencyKey"), "undefined", name.text)
          expected.delete(name.text)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  assert.deepEqual([...expected.keys()], [])
})
