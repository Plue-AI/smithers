import { test } from "node:test"
import assert from "node:assert/strict"
import { parseAppendixC } from "./appendix-c.mjs"
import { readFileSync } from "node:fs"
const row = (tag, title, mvp = "Keep") => `| \`${tag}\` | action | file.ts:1 | what | Machine | ${mvp} | ${title} |`
test("only Keep titles survive, with literal capitalization and duplicate agreement", () => {
  assert.deepEqual(parseAppendixC([row("coding/plan", "Planned the change"), row("coding/plan", "Planned the change"), row("cut", "Cut", "Cut"), row("engine", "-")].join("\n")), { "coding/plan": "Planned the change" })
})
test("rejects conflicting duplicates, malformed columns, and empty registries", () => {
  assert.throws(() => parseAppendixC([row("tag", "One"), row("tag", "Two")].join("\n")), /Conflicting/)
  assert.throws(() => parseAppendixC("| `tag` | action |"), /Invalid/)
  assert.throws(() => parseAppendixC(""), /no Keep/)
})
test("escaped pipes and CRLF retain the display title", () => {
  assert.deepEqual(parseAppendixC(row("tag", "Read A \\| B") + "\r\n"), { tag: "Read A | B" })
})
test("property: permutation and duplicate input preserve every title", () => {
  for (let count = 1; count <= 100; count++) {
    const rows = Array.from({ length: count }, (_, n) => row(`tag/${n}`, `Did ${n}`))
    assert.deepEqual(parseAppendixC(rows.join("\n")), parseAppendixC([...rows.reverse(), ...rows].join("\n")))
  }
})
test("real Appendix C contains the coding titles", () => {
  const labels = parseAppendixC(readFileSync(new URL("../.specs/product/actions.md", import.meta.url), "utf8"))
  assert.equal(labels["coding/edit-atom"], "Edited the files")
  assert.equal(labels["coding/check-command"], "Ran checks")
  assert.ok(Object.keys(labels).length > 100)
})
