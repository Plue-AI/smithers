// Hand-transcribed fixtures fail here, not in their own tests, when the spec
// text they were copied from changes (tech lead 8a, C-UI-13, 2026-10-03).
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { digest, sectionText, staleness } from "./spec-transcriptions.mjs"

const ROOT = join(import.meta.dirname, "../..")
const fixtures = ["apps/app/src/mainview/inventory/inventory.json"]

for (const path of fixtures) {
  test(`${path} matches the spec text it transcribes`, () => {
    const { spec } = JSON.parse(readFileSync(join(ROOT, path), "utf8")).header
    assert.ok(spec?.file && spec.start && /^[0-9a-f]{64}$/.test(spec.sha256 ?? ""), `${path} header.spec needs file, start and sha256`)
    assert.equal(staleness(path, spec, readFileSync(join(ROOT, spec.file), "utf8")), null)
  })
}

test("a section runs from its start line to the next heading of level three or higher", () => {
  const markdown = "### 1 A\nintro\n1.0 **X.** body\n\n1.0a more\n#### 1.1 kept\n| t |\n### 2 B\nafter"
  assert.equal(sectionText(markdown, "1.0 "), "1.0 **X.** body\n\n1.0a more\n#### 1.1 kept\n| t |")
  assert.equal(sectionText(markdown.replace(/\n/g, "\r\n"), "1.0 "), sectionText(markdown, "1.0 "))
  assert.equal(sectionText("1.0 last", "1.0 "), "1.0 last")
})

test("an edited or removed section refuses with a re-transcribe message", () => {
  const markdown = "### 1\n1.0 text\n### 2"
  const spec = { file: "spec.md", start: "1.0 ", sha256: digest("1.0 text") }
  assert.equal(staleness("f.json", spec, markdown), null)
  assert.match(staleness("f.json", spec, markdown.replace("text", "edited")), /re-transcribe f\.json .*digest changed/)
  assert.match(staleness("f.json", spec, "### 1\nother"), /re-transcribe f\.json .*section missing/)
})
