import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { once } from "node:events"
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import test from "node:test"
import { pathToFileURL } from "node:url"
import {
  buildPrivateEffectAdapters,
  privateEffectAdapters,
  relocatePrivateAdapterImports
} from "../packages/repo-targets/scripts/private-effect-adapters.mjs"

const root = resolve(import.meta.dirname, "..")
const sourceRequire = createRequire(join(root, "packages/smithers/package.json"))
const sourceManifest = JSON.parse(await readFile(join(root, "packages/smithers/package.json"), "utf8"))
const version = sourceManifest.dependencies.effect
const adapters = ["@effect/platform-bun", "@effect/platform-node", "@effect/platform-node-shared"]
const manifest = () => ({
  type: "module",
  smthrs: { privateEffectAdapters: adapters },
  dependencies: { effect: version, undici: "8.10.2", redis: "6.2.1", ws: "8.21.3", "@types/ws": "8.18.1" },
  devDependencies: Object.fromEntries(adapters.map((name) => [name, version]))
})
const fixture = async (body) => {
  const directory = await mkdtemp("/private/tmp/smithers-private-adapter-test-")
  try {
    await body(directory)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
const owner = async (directory, name) => {
  const path = join(directory, name)
  await mkdir(join(path, "node_modules"), { recursive: true })
  await mkdir(join(path, "dist/esm"), { recursive: true })
  await mkdir(join(path, "dist/cjs"), { recursive: true })
  await writeFile(join(path, "package.json"), JSON.stringify(manifest()))
  await writeFile(join(path, "dist/cjs/package.json"), "{\"type\":\"commonjs\"}")
  for (const dependency of ["esbuild", "typescript", ...adapters, ...Object.keys(manifest().dependencies)]) {
    const target = join(path, "node_modules", dependency)
    await mkdir(dirname(target), { recursive: true })
    await symlink(dirname(await realpath(sourceRequire.resolve(dependency + "/package.json"))), target)
  }
  return path
}

test("private adapter declarations reject incomplete, mutable, and consumer resolver contracts", () => {
  assert.deepEqual(privateEffectAdapters({}), [])
  assert.deepEqual(privateEffectAdapters(manifest()), adapters)
  for (const value of [null, "node", ["effect"], [adapters[0], adapters[0]]]) {
    const input = manifest()
    input.smthrs.privateEffectAdapters = value
    assert.throws(() => privateEffectAdapters(input), /Invalid private/)
  }
  for (const value of [undefined, "^" + version, "workspace:*"]) {
    const input = manifest()
    input.dependencies.effect = value
    assert.throws(() => privateEffectAdapters(input), /exact Effect/)
  }
  const peer = manifest()
  peer.peerDependencies = { effect: peer.dependencies.effect }
  delete peer.dependencies.effect
  assert.deepEqual(privateEffectAdapters(peer), adapters)
  const noShared = manifest()
  noShared.smthrs.privateEffectAdapters = [adapters[1]]
  assert.throws(() => privateEffectAdapters(noShared), /pinned shared/)
  const wrong = manifest()
  wrong.devDependencies[adapters[1]] = "0.0.0"
  assert.throws(() => privateEffectAdapters(wrong), /must equal Effect/)
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    const input = manifest()
    input[section] = { ...input[section], [adapters[1]]: version }
    assert.throws(() => privateEffectAdapters(input), /published resolver edge/)
  }
})

test("owners without private adapters keep their existing build and import contract", () =>
  fixture(async (directory) => {
    await writeFile(join(directory, "package.json"), JSON.stringify({}))
    await buildPrivateEffectAdapters(directory)
    await relocatePrivateAdapterImports(directory)
  }))

test("real adapters share Effect across owners, CJS and ESM, and preserve typed Node and Bun APIs", () =>
  fixture(async (directory) => {
    const paths = [await owner(directory, "one"), await owner(directory, "two")]
    for (const path of paths) {
      await writeFile(
        join(path, "dist/esm/index.js"),
        "import {NodeFileSystem} from \"@effect/platform-node\"; export const layer=NodeFileSystem.layer; export {succeed} from \"effect/Effect\"; export const opaque=\"@effect/platform-node\";"
      )
      await writeFile(
        join(path, "dist/cjs/index.js"),
        "exports.layer=require(\"@effect/platform-node/NodeFileSystem\").layer;exports.succeed=require(\"effect/Effect\").succeed;"
      )
      const declaration =
        "export {layer} from \"@effect/platform-node/NodeFileSystem\";export {layer as bunLayer} from \"@effect/platform-bun/BunServices\";export {succeed} from \"effect/Effect\";export type NodeLayer=typeof import(\"@effect/platform-node/NodeFileSystem\").layer;"
      await writeFile(join(path, "dist/esm/index.d.ts"), declaration)
      await writeFile(join(path, "dist/cjs/index.d.ts"), declaration)
      await buildPrivateEffectAdapters(path)
      const receipt = JSON.parse(await readFile(join(path, "dist/vendor/adapters.json"), "utf8"))
      assert.equal(receipt.version, version)
      assert.ok(receipt.inputs.length > 100)
      assert.ok(receipt.inputs.some((value) => value.path === "LICENSE"))
      assert.ok(receipt.outputs.some((value) => value.path.endsWith(".d.ts")))
      assert.ok(receipt.outputs.some((value) => value.path.endsWith("LICENSE")))
      for (const value of receipt.outputs) {
        assert.equal(
          value.sha256,
          createHash("sha256").update(await readFile(join(path, "dist/vendor", value.path))).digest("hex")
        )
      }
      assert.match(await readFile(join(path, "dist/esm/index.js"), "utf8"), /opaque="@effect\/platform-node"/)
      const esm = await import(pathToFileURL(join(path, "dist/esm/index.js")))
      const cjs = createRequire(join(path, "package.json"))(join(path, "dist/cjs/index.js"))
      assert.equal(esm.layer, cjs.layer)
      assert.equal(esm.succeed, cjs.succeed)
    }
    const fromOne = createRequire(join(paths[0], "package.json"))
    const Effect = fromOne("effect/Effect"), FileSystem = fromOne("effect/FileSystem")
    const two = await import(pathToFileURL(join(paths[1], "dist/esm/index.js")))
    assert.equal(two.succeed, Effect.succeed)
    const file = join(directory, "actual.txt")
    await writeFile(file, "cross-owner contents")
    const contents = await Effect.runPromise(
      Effect.gen(function*() {
        const filesystem = yield* FileSystem.FileSystem
        return yield* filesystem.readFileString(file)
      }).pipe(Effect.provide(two.layer))
    )
    assert.equal(contents, "cross-owner contents")
    const esmSocket = await import(pathToFileURL(join(paths[0], "dist/vendor/node-shared/NodeSocket.js")))
    const cjsSocket = fromOne(join(paths[0], "dist/vendor/cjs/node-shared/NodeSocket.js"))
    assert.equal(cjsSocket.NodeWS, esmSocket.NodeWS)
    assert.equal(cjsSocket.NodeWS.WebSocket, fromOne("ws").WebSocket)
    const server = new esmSocket.NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 })
    let client
    try {
      await once(server, "listening")
      server.once("connection", (socket) => socket.send("actual private namespace connection"))
      client = new cjsSocket.NodeWS.WebSocket(`ws://127.0.0.1:${server.address().port}`)
      const [message] = await once(client, "message")
      assert.equal(message.toString(), "actual private namespace connection")
    } finally {
      client?.terminate()
      await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
    const nativeCompilerRequire = createRequire(join(root, "packages/smithers/build/build-cli/package.json"))
    const compilers = [sourceRequire, nativeCompilerRequire].map((require) =>
      join(dirname(require.resolve("typescript/package.json")), "bin/tsc")
    )
    for (const extension of ["mts", "cts"]) {
      const branch = extension === "mts" ? "esm" : "cjs"
      const other = branch === "esm" ? "cjs" : "esm"
      const mode = other === "esm" ? "import" : "require"
      await writeFile(
        join(paths[0], "proof." + extension),
        [
          `import {layer,bunLayer,succeed} from './dist/${branch}/index.js';`,
          `import {NodeWS} from './dist/vendor/${branch === "esm" ? "" : "cjs/"}node-shared/NodeSocket.js';`,
          `import type * as Other from './dist/${other}/index.js' with {"resolution-mode":"${mode}"};`,
          `import type {Effect} from 'effect/Effect' with {"resolution-mode":"import"};`,
          "const value: Effect<number> = succeed(1);void value;",
          "declare const otherLayer: typeof Other.layer; declare const otherBunLayer: typeof Other.bunLayer;",
          "const forward: typeof Other.layer = layer; const backward: typeof layer = otherLayer;",
          "const bunForward: typeof Other.bunLayer = bunLayer; const bunBackward: typeof bunLayer = otherBunLayer;",
          "void forward;void backward;void bunForward;void bunBackward;",
          "// @ts-expect-error Node API must retain its type",
          "layer.missingConsumerField;",
          "// @ts-expect-error Bun API must retain its type",
          "bunLayer.missingConsumerField;",
          "const socket: NodeWS.WebSocket = new NodeWS.WebSocket('ws://127.0.0.1');void socket;",
          "// @ts-expect-error WebSocket namespace must preserve actual constructor members",
          "NodeWS.WebSocket.missingConsumerField;"
        ].join("\n")
      )
    }
    for (const compiler of compilers) {
      for (const module of ["Node20", "NodeNext"]) {
        execFileSync(process.execPath, [
          compiler,
          "--noEmit",
          "--strict",
          "--target",
          "ES2022",
          "--module",
          module,
          "--moduleResolution",
          "NodeNext",
          "--types",
          "node",
          "--typeRoots",
          dirname(
            dirname(createRequire(sourceRequire.resolve("@types/ws/package.json")).resolve("@types/node/package.json"))
          ),
          "proof.mts",
          "proof.cts"
        ], { cwd: paths[0], stdio: "inherit" })
      }
    }
    await writeFile(join(paths[0], "dist/esm/refused.js"), "import \"@effect/platform-node/internal/secret\";")
    await assert.rejects(relocatePrivateAdapterImports(paths[0]), /Invalid private adapter module/)
    await writeFile(join(paths[0], "dist/esm/refused.js"), "import \"@effect/platform-node/../../outside\";")
    await assert.rejects(relocatePrivateAdapterImports(paths[0]), /Invalid private adapter module/)
    await writeFile(join(paths[0], "dist/esm/refused.js"), "import \"@effect/platform-node/NotAnExport\";")
    await assert.rejects(relocatePrivateAdapterImports(paths[0]), /Invalid private adapter module/)
  }))

const syntheticOwner = async (directory) => {
  const path = await owner(directory, "synthetic")
  for (const name of adapters) {
    const module = join(path, "node_modules", name)
    await rm(module)
    await mkdir(join(module, "dist"), { recursive: true })
    await writeFile(
      join(module, "package.json"),
      JSON.stringify({
        name,
        version,
        type: "module",
        exports: { "./package.json": "./package.json", ".": "./dist/index.js" }
      })
    )
    await writeFile(join(module, "dist/index.js"), "export const value=1;")
    await writeFile(join(module, "dist/index.d.ts"), "export declare const value: number;")
  }
  return path
}

test("CJS namespace compatibility preserves aliases, other exports, comments, and opaque declaration strings", () =>
  fixture(async (directory) => {
    const path = await syntheticOwner(directory)
    const source = [
      "import * as Imported from \"ws\";",
      "export * as SocketNamespace from \"ws\";",
      "export { WebSocket as NamedSocket } from \"ws\";",
      "export * from \"ws\";",
      "export * as Layers from \"effect/Layer\";",
      "// export * as CommentOnly from \"ws\";",
      "export declare const opaque: \"export * as StringOnly from ws\";"
    ].join("\n")
    await writeFile(join(path, "node_modules", adapters[2], "dist/index.d.ts"), source)
    await buildPrivateEffectAdapters(path)
    const esm = await readFile(join(path, "dist/vendor/node-shared/index.d.ts"), "utf8")
    const cjs = await readFile(join(path, "dist/vendor/cjs/node-shared/index.d.ts"), "utf8")
    assert.equal(esm, source)
    assert.equal(
      cjs,
      source.replace(
        "export * as SocketNamespace from \"ws\";",
        "import * as SocketNamespace from \"ws\"; export { SocketNamespace };"
      )
    )
  }))

test("private adapter capture refuses wrong versions, undeclared external dependencies, and escaped code/types", () =>
  fixture(async (directory) => {
    const path = await syntheticOwner(directory), module = join(path, "node_modules", adapters[0])
    const packagePath = join(module, "package.json"), original = JSON.parse(await readFile(packagePath, "utf8"))
    await writeFile(packagePath, JSON.stringify({ ...original, version: "0.0.0" }))
    await assert.rejects(buildPrivateEffectAdapters(path), /identity differs/)
    await writeFile(packagePath, JSON.stringify({ ...original, dependencies: { "@effect/uncaptured": version } }))
    await assert.rejects(buildPrivateEffectAdapters(path), /Uncaptured adapter dependency/)
    await writeFile(packagePath, JSON.stringify({ ...original, dependencies: { ws: "8.21.3" } }))
    const wrong = manifest()
    wrong.dependencies.ws = "0.0.0"
    await writeFile(join(path, "package.json"), JSON.stringify(wrong))
    await assert.rejects(buildPrivateEffectAdapters(path), /external dependency is not exact/)
    const peer = manifest()
    peer.peerDependencies = { effect: version }
    delete peer.dependencies.effect
    await writeFile(join(path, "package.json"), JSON.stringify(peer))
    await writeFile(
      packagePath,
      JSON.stringify({
        ...original,
        peerDependencies: { unavailable: "1.0.0" },
        peerDependenciesMeta: { unavailable: { optional: true } }
      })
    )
    await buildPrivateEffectAdapters(path)
    await writeFile(join(module, "outside.js"), "export const escaped=1;")
    await writeFile(join(module, "dist/index.js"), "export {escaped} from \"../outside.js\";")
    await assert.rejects(buildPrivateEffectAdapters(path), /Uncaptured private adapter code/)
    await writeFile(join(module, "dist/index.js"), "export const value=1;")
    await writeFile(join(module, "dist/index.d.ts"), "export {escaped} from \"../outside.js\";")
    await assert.rejects(buildPrivateEffectAdapters(path), /Escaping private declaration/)
  }))

test("module resolution calls relocate the full adapter identity root and preserve opaque values", () =>
  fixture(async (directory) => {
    const path = await syntheticOwner(directory)
    const file = join(path, "dist/esm/resolution.js")
    await writeFile(
      join(path, "node_modules", adapters[0], "dist/index.d.ts"),
      "export * as Shared from \"@effect/platform-node-shared\";"
    )
    await writeFile(
      file,
      "const loadedModuleRoot=(name,module)=>import.meta.resolve(module);export const root=loadedModuleRoot(\"adapter\",\"@effect/platform-node\");const require={resolve:(value)=>value};const __smthrsResolve=(value)=>value;export const a=require.resolve(\"@effect/platform-node\");export const b=__smthrsResolve(\"@effect/platform-node\");export const value={resolve:value=>value}.resolve(\"@effect/platform-node\");export const load=value=>import(value);"
    )
    await writeFile(
      join(path, "dist/cjs/resolution.js"),
      "const loadedModuleRoot=(name,module)=>require.resolve(module);exports.root=loadedModuleRoot(\"adapter\",\"@effect/platform-node\");"
    )
    await buildPrivateEffectAdapters(path)
    const cjsRoot = createRequire(join(path, "package.json"))(join(path, "dist/cjs/resolution.js")).root
    assert.equal(dirname(cjsRoot), join(path, "dist/vendor"))
    const output = await import(pathToFileURL(file))
    assert.equal(dirname(new URL(output.root).pathname), join(path, "dist/vendor"))
    assert.equal(output.value, "@effect/platform-node")
    assert.match(output.a, /vendor\/platform-node\.js$/)
    assert.match(output.b, /vendor\/platform-node\.js$/)
    const disabled = manifest()
    disabled.smthrs.privateEffectAdapters = []
    assert.deepEqual(privateEffectAdapters(disabled), [])
  }))

test("capture refuses code changed while esbuild runs", () =>
  fixture(async (directory) => {
    const path = await syntheticOwner(directory), entry = join(path, "node_modules", adapters[0], "dist/index.js")
    for (let i = 0; i < 200; i++) await writeFile(join(dirname(entry), `source-${i}.js`), `export const value=${i};`)
    const { writeFileSync } = await import("node:fs")
    let revision = 1
    const timer = setInterval(() => writeFileSync(entry, `export const value=${++revision};`), 1)
    try {
      await assert.rejects(buildPrivateEffectAdapters(path), /changed during build/)
    } finally {
      clearInterval(timer)
    }
    assert.ok(revision > 1)
  }))

test("capture refuses code changed after declaration copying starts", () =>
  fixture(async (directory) => {
    const path = await syntheticOwner(directory), entry = join(path, "node_modules", adapters[2], "dist/index.js")
    for (let i = 0; i < 200; i++) {
      await writeFile(
        join(path, "node_modules", adapters[1], "dist", `declaration-${i}.d.ts`),
        "export declare const value: number;"
      )
    }
    const vendor = join(path, "dist/vendor")
    await mkdir(vendor)
    const { watch, writeFileSync } = await import("node:fs")
    let changed = false
    const watcher = watch(vendor, (_event, file) => {
      if (!changed && file?.endsWith(".d.ts")) {
        changed = true
        writeFileSync(entry, "export const value=2;")
      }
    })
    let failure
    try {
      failure = await buildPrivateEffectAdapters(path).catch((error) => error)
    } finally {
      watcher.close()
    }
    assert.equal(changed, true)
    assert.match(failure?.message ?? "build succeeded", /changed during declaration copying/)
  }))

test("explicit staging roots relocate private declarations without writing workspace outputs", () =>
  fixture(async (directory) => {
    const path = await syntheticOwner(directory), distRoot = join(directory, "independent-dist")
    const original = "export * from \"@effect/platform-node\";"
    await writeFile(join(path, "dist/esm/index.d.ts"), original)
    await mkdir(join(distRoot, "esm"), { recursive: true })
    await writeFile(join(distRoot, "esm/index.d.ts"), original)
    await buildPrivateEffectAdapters(path, { distRoot })
    assert.equal(await readFile(join(path, "dist/esm/index.d.ts"), "utf8"), original)
    assert.match(await readFile(join(distRoot, "esm/index.d.ts"), "utf8"), /\.\.\/vendor\/platform-node\.js/)
    await relocatePrivateAdapterImports(path, { distRoot, directory: join(distRoot, "esm") })
  }))
