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
  // This repository's own register-repository flow, its typed failure included.
  const failure = { _tag: "register-repository/Error", code: "unavailable", message: "GitHub is unavailable" }
  const registered = settle(fileURLToPath(new URL("../register-repository/flow.ts", import.meta.url)), "error", failure)
  assert.equal(registered.flow, "register-repository")
  assert.equal(registered.encoded.exit._tag, "Failure")
  assert.deepEqual(registered.settled, failure)
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
