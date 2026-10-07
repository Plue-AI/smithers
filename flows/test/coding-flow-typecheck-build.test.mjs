import assert from "node:assert/strict"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { test } from "node:test"
import { typecheckInputs } from "../coding/flow-typecheck-build.mjs"

const root = fileURLToPath(new URL("../../", import.meta.url))

test("packaged type inputs read main sources as data and refuse sources outside the checkout", async t => {
  const inside = await mkdtemp(join(root, ".flow-types-"))
  const outside = await mkdtemp(join(tmpdir(), "flow-types-"))
  t.after(async () => {
    await rm(inside, { recursive: true, force: true })
    await rm(outside, { recursive: true, force: true })
  })
  const entry = join(inside, "entry.ts"), marker = join(outside, "evaluated")
  const source = `import { writeFileSync } from "node:fs"\nwriteFileSync(${JSON.stringify(marker)}, "evaluated")\nexport const name: string = "main"\n`
  await writeFile(entry, source)
  const inputs = await typecheckInputs(root, { "@test/main": entry })
  const key = inputs.entries["@test/main"]
  assert.ok(key.startsWith("/__smithers_types__/.flow-types-"))
  assert.equal(inputs.files[key], source)
  assert.ok(inputs.files[inputs.lib])
  assert.ok(inputs.files[inputs.node])
  assert.ok(Object.keys(inputs.files).every(name => !name.includes(root)))
  await assert.rejects(readFile(marker), { code: "ENOENT" })
  const foreign = join(outside, "entry.ts")
  await writeFile(foreign, source)
  await assert.rejects(typecheckInputs(root, { "@test/foreign": foreign }), /outside the build checkout/)
  await assert.rejects(readFile(marker), { code: "ENOENT" })
})
