import assert from "node:assert/strict"
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { FlowEngine } from "@smthrs/engine"
import { Action } from "@smthrs/flow"
import { Effect, Exit, Layer, Scope } from "effect"
import { Discovery, Executable } from "../../src/index.ts"

const fixture = fileURLToPath(new URL("./mdx", import.meta.url))
const root = await mkdtemp(fileURLToPath(new URL("./.mdx-", import.meta.url)))
const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer, NodeCrypto.layer)
const scope = await Effect.runPromise(Scope.make())
const context = await Effect.runPromise(Layer.buildWithScope(
  Layer.mergeAll(platform, FlowEngine.layerMemory, Action.layerImplementations), scope
))
const run = (effect) => Effect.runPromise(effect.pipe(Effect.provide(context), Effect.provideService(Scope.Scope, scope)))
const scan = () => run(Effect.gen(function*() {
  const discovery = yield* Discovery.Discovery
  return yield* discovery.scan({ root, naming: "path", source: "project" })
}).pipe(Effect.provide(Discovery.layer.pipe(Layer.provide(platform)))))
const load = (descriptor) => run(Executable.fromDescriptor(descriptor, { delegates: [] }))
const execute = (executable, number) => run(executable.flow.execute(
  { input: { name: "Ada" } }, { executionId: `mdx-${number}` }
).pipe(
  Effect.provide(executable.layer)
))

try {
  await cp(fixture, `${root}/mdx`, { recursive: true })
  const original = await scan()
  assert.deepEqual(original.entries.map((entry) => entry.name), ["mdx"])
  assert.equal(globalThis.__smithersMdxLoaded, undefined, "discovery evaluated MDX")
  assert.equal(original.warnings.length, 0)
  const descriptor = original.entries[0]
  assert.ok(descriptor.body.imports.some((entry) => entry.path === "prompt.mdx" && entry.contentDigest))
  assert.ok(descriptor.body.imports.some((entry) => entry.path === "component.ts" && entry.contentDigest))
  assert.ok(descriptor.body.imports.some((entry) => entry.path === "settings.json" && entry.contentDigest))
  const loaded = await load(descriptor)
  assert.equal(globalThis.__smithersMdxLoaded, 1)
  const first = await execute(loaded, 1)
  assert.equal(first, '# Hello Ada\n\nEvidence for Ada\n\n```json\n{"verified":true}\n```')
  const promptPath = `${root}/mdx/prompt.mdx`
  await writeFile(promptPath, (await readFile(promptPath, "utf8")).replace("Hello", "Welcome"))
  await assert.rejects(load(descriptor), /changed at "prompt.mdx"/)
  assert.equal(globalThis.__smithersMdxLoaded, 1, "stale prompt evaluated before refusal")
  assert.equal((await execute(loaded, 2)), first, "loaded prompt reopened source bytes")
  const refreshed = (await scan()).entries[0]
  const second = await load(refreshed)
  assert.match((await execute(second, 3)), /^# Welcome Ada/)
  await writeFile(`${root}/mdx/component.ts`, 'export const Greeting = ({name}) => `Changed for ${name}`\n')
  await assert.rejects(load(refreshed), /changed at "component.ts"/)
  assert.equal(globalThis.__smithersMdxLoaded, 2, "stale component evaluated before refusal")
  const third = await load((await scan()).entries[0])
  assert.match((await execute(third, 4)), /Changed for Ada/)
  await writeFile(`${root}/mdx/tsconfig.json`, JSON.stringify({ compilerOptions: { paths: {
    "@smthrs/registry/Prompt/jsx-runtime": ["./component.ts"]
  } } }))
  await assert.rejects(load((await scan()).entries[0]), /maps the MDX text runtime to project files/)
  assert.equal(globalThis.__smithersMdxLoaded, 3, "mapped runtime evaluated before refusal")
  await rm(`${root}/mdx/tsconfig.json`)
  await writeFile(promptPath, "<Unclosed>")
  const invalid = (await scan()).entries[0]
  await assert.rejects(load(invalid), /could not be compiled as MDX/)
  assert.equal(globalThis.__smithersMdxLoaded, 3)
  process.stdout.write(JSON.stringify({ runtime: process.versions.bun ? "Bun" : "Node", assertions: "passed" }))
} finally {
  await Effect.runPromise(Scope.close(scope, Exit.void))
  await rm(root, { recursive: true, force: true })
}
