import assert from "node:assert/strict"
import { execFileSync } from "node:child_process"
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { bundle } from "../coding/build.mjs"

// The one shape of a repository flow: flows/<name>/flow.ts, Flow.make, and
// effect plus @smthrs packages from the repository's own node_modules.
const echo = `import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

export default Flow.make("echo", {
  description: "Echo",
  capabilities: [],
  effects: { reads: [], writes: [], mode: "expected", onConflict: "serialize", tier: "sealed" },
  payload: { text: Schema.String },
  success: Schema.String,
  body: ({ text }) => Node.succeed(text)
})
`

// Node needs the flag for a repository's TypeScript; Bun runs it as is.
const runtimeFlags = process.versions.bun ? [] : ["--experimental-strip-types"]

test("the packaged host settles a repository file flow with the flow's own schemas", {
  timeout: 120_000
}, async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-host-modules-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const repository = join(temporary, "repository")
  await mkdir(join(repository, "flows", "echo"), { recursive: true })
  await writeFile(join(repository, "flows", "echo", "flow.ts"), echo)
  // The repository installs its own copies, which the host must not load.
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(repository, "node_modules"))
  const output = join(temporary, "host.mjs")
  await bundle(fileURLToPath(new URL("./fixtures/coding-host-modules-entry.ts", import.meta.url)), output)
  const settle = (flow: string, channel: "success" | "error", value: unknown) =>
    JSON.parse(
      execFileSync(process.execPath, ["--experimental-strip-types", output, flow, channel, JSON.stringify(value)], {
        encoding: "utf8",
        timeout: 60_000,
        stdio: ["ignore", "pipe", "pipe"]
      })
    )
  assert.deepEqual(settle(join(repository, "flows", "echo", "flow.ts"), "success", "echoed"), {
    flow: "echo",
    encoded: { _tag: "Complete", exit: { _tag: "Success", value: "echoed" } },
    settled: "echoed"
  })
})

test("a shared package entry point the host does not bundle is refused, not loaded twice", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-host-modules-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  // A repository with its own installation, so an unshared import can load.
  await symlink(fileURLToPath(new URL("../node_modules", import.meta.url)), join(temporary, "node_modules"))
  const probe = join(temporary, "probe.mjs")
  await writeFile(
    probe,
    `import { share } from ${JSON.stringify(fileURLToPath(new URL("../coding/host-modules.ts", import.meta.url)))}
const effect = { marker: "host" }
share(new Map([["effect", effect]]))
const own = await import("data:text/javascript,import * as E from 'effect'; export default E")
const refused = await import("effect/Schema").then(() => "loaded", (error) => error.message)
const plain = (await import("node:path")).sep
const version = (await import("effect/package.json", { with: { type: "json" } })).default.version
process.stdout.write(JSON.stringify({ marker: own.default.marker, refused, plain, version }))
`
  )
  const result = JSON.parse(execFileSync(process.execPath, [...runtimeFlags, probe], {
    cwd: temporary,
    encoding: "utf8",
    timeout: 60_000
  }))
  assert.equal(result.marker, "host")
  assert.match(result.refused, /coding host does not provide "effect(\/Schema)?"/)
  assert.equal(result.plain, "/")
  assert.match(result.version, /^\d+\.\d+\.\d+/, "package.json is data, read from the repository")
})

test("an unbundled Smithers package refuses before importing repository dependency code", async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), "coding-host-unbundled-"))
  t.after(() => rm(temporary, { recursive: true, force: true }))
  const dependency = join(temporary, "node_modules", "@smthrs", "unbundled")
  await mkdir(dependency, { recursive: true })
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "@smthrs/unbundled",
      type: "module",
      exports: { ".": "./index.js", "./package.json": "./package.json", "./evil/package.json": "./index.js" }
    })
  )
  await writeFile(join(dependency, "index.js"), "globalThis.repositoryImports = 1; export const value = 'repository'")
  const ordinary = join(temporary, "node_modules", "pinned-dependency")
  await mkdir(ordinary)
  await writeFile(join(ordinary, "package.json"), JSON.stringify({ type: "module", exports: "./index.js" }))
  await writeFile(join(ordinary, "index.js"), "export const value = 'pinned dependency'")
  const probe = join(temporary, "probe.mjs")
  await writeFile(
    probe,
    `import { share } from ${JSON.stringify(fileURLToPath(new URL("../coding/host-modules.ts", import.meta.url)))}
globalThis.repositoryImports = 0
share(new Map([["effect", { marker: "host" }]]))
const refused = await import("@smthrs/unbundled").then(() => "loaded", (error) => error.message)
const data = (await import("@smthrs/unbundled/package.json", { with: { type: "json" } })).default.name
const deceptive = await import("@smthrs/unbundled/evil/package.json").then(() => "loaded", (error) => error.message)
const ordinary = (await import("pinned-dependency")).value
process.stdout.write(JSON.stringify({ refused, deceptive, imports: globalThis.repositoryImports, data, ordinary }))
`
  )
  const result = JSON.parse(execFileSync(process.execPath, [...runtimeFlags, probe], {
    cwd: temporary,
    encoding: "utf8",
    timeout: 60_000
  }))
  assert.match(result.refused, /coding host does not provide "@smthrs\/unbundled"/)
  assert.match(result.deceptive, /coding host does not provide "@smthrs\/unbundled\/evil\/package.json"/)
  assert.equal(result.imports, 0)
  assert.equal(result.data, "@smthrs/unbundled", "package metadata remains repository data")
  assert.equal(result.ordinary, "pinned dependency", "ordinary dependencies resolve from the source checkout")
})
