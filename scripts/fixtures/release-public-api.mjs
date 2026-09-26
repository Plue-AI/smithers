import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"

const require = createRequire(import.meta.url)
const mode = process.argv[2]
assert.ok(mode === "esm" || mode === "cjs")
const load = mode === "cjs" ? async (name) => require(name) : (name) => import(name)
const { Smithers: targets } = await load("@smthrs/targets")
const Target = await load("@smthrs/targets/Target")
const Input = await load("@smthrs/targets/Input")
const { Node } = await load("@smthrs/plan")

for (const name of ["StandardPackage", "DurableIdentityGuard", "DocsReferenceSync", "JsdocTruthfulness", "reviewPrompt"]) {
  assert.equal(name in targets, false, `${mode}: repository policy leaked through ${name}`)
}
assert.equal(typeof targets.LlmLint, "function")

const packageRoot = dirname(require.resolve("@smthrs/targets/package.json"))
for (const name of ["StandardPackage", "ReviewLint"]) {
  await assert.rejects(load(`@smthrs/targets/${name}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
  for (const file of [`src/${name}.ts`, `dist/esm/${name}.js`, `dist/esm/${name}.d.ts`, `dist/cjs/${name}.js`, `dist/cjs/${name}.d.ts`]) {
    assert.equal(existsSync(join(packageRoot, file)), false, `${mode}: removed policy remains in ${file}`)
  }
}

const integrationRoot = dirname(require.resolve("@smthrs/integrations/package.json"))
const migrations = ["0001_integration_cursors", "0002_integration_records"]
for (const name of migrations) {
  const migration = `core/migrations/${name}`
  await assert.rejects(load(`@smthrs/integrations/${migration}`), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" })
  for (const file of [`src/${migration}.ts`, `dist/esm/${migration}.js`, `dist/esm/${migration}.d.ts`, `dist/cjs/${migration}.js`, `dist/cjs/${migration}.d.ts`]) {
    assert.equal(existsSync(join(integrationRoot, file)), false, `${mode}: raw migration remains in ${file}`)
  }
}
const { Core } = await load("@smthrs/integrations")
assert.deepEqual(Object.keys(Core.Migrations.set.migrations), migrations)

const target = targets.Shell.Test({ shell: "printf smoke" })
assert.equal(Target.isTarget(target), true)
for (const name of ["execute", "asNode", "poll", "resume", "executionId"]) {
  assert.equal(name in target, false, `${mode}: target exposes Flow method ${name}`)
}
assert.equal(Target.plan(target).ast._tag, "ActionCall")
assert.throws(() => targets.Shell.Test({ shell: "echo", args: ["silently ignored"] }))
assert.throws(() => Node.andThen(Node.succeed(false), (value) => Node.succeed(value ? "wrong" : "right")), /Node.bindPlanned/)
assert.equal(typeof Node.bindPlanned, "function")

let getterReads = 0
const forgedInput = { _tag: "File", get path() { getterReads++; return "unexpected.ts" } }
assert.equal(Input.isDeclared(forgedInput), false)
assert.throws(() => targets.Shell.Test({ shell: "printf smoke", srcs: [forgedInput] }))
assert.equal(getterReads, 0, `${mode}: input recognition invoked an author getter`)

const original = Input.file("retained.sh")
const scripted = targets.Shell.Run({ script: original })
const metadata = Target.metadata(scripted)
original.path = "caller-mutated.sh"
assert.equal(metadata.attrs.script.path, "retained.sh")
assert.throws(() => { metadata.attrs.script.path = "metadata-mutated.sh" }, TypeError)
assert.equal(metadata.inputs[0].path, "retained.sh")
console.log(`Public API contracts passed under ${mode}`)
