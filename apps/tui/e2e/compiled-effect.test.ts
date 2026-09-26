/** A compiled host and disk-loaded project schemas must share one Effect runtime. */
import { expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"

const app = resolve(import.meta.dir, "..")
const require = createRequire(join(app, "package.json"))

it("preserves public Effect module identity and encoded values, and refuses a version mismatch", async () => {
  const { compiledEffectRuntime } = await import(
    resolve(app, "../../packages/smithers/scripts/compiled-effect-runtime.mjs")
  )
  const root = mkdtempSync(join(tmpdir(), "tui-compiled-effect-"))
  try {
    symlinkSync(join(app, "node_modules"), join(root, "node_modules"), "dir")
    const project = join(root, "project.ts")
    writeFileSync(
      project,
      `
      import { Schema } from "effect"
      import * as SchemaSubpath from "effect/Schema"
      import { Headers } from "effect/unstable/http"
      import * as HeadersSubpath from "effect/unstable/http/Headers"
      export { Schema, SchemaSubpath, Headers, HeadersSubpath }
    `
    )
    const binary = join(root, "probe")
    const built = await Bun.build({
      entrypoints: ["probe.ts"],
      files: {
        "probe.ts": `${compiledEffectRuntime(require)}
          const host = await import(${JSON.stringify(require.resolve("effect"))})
          const http = await import(${JSON.stringify(require.resolve("effect/unstable/http"))})
          const project = await import(process.argv[2])
          const codec = host.Schema.toCodecJson(host.Schema.Struct({ value: project.Schema.String }))
          console.log(JSON.stringify({
            schema: host.Schema.String === project.Schema.String && project.Schema.String === project.SchemaSubpath.String,
            headers: http.Headers.fromInput === project.Headers.fromInput && project.Headers.fromInput === project.HeadersSubpath.fromInput,
            result: host.Schema.encodeSync(codec)({ value: "preserved 日本語 🦉" })
          }))`
      },
      compile: {
        outfile: binary,
        autoloadPackageJson: true,
        autoloadDotenv: false,
        autoloadBunfig: false,
        autoloadTsconfig: false
      }
    })
    expect(built.success, built.logs.map(String).join("\n")).toBe(true)
    const result = spawnSync(binary, [project], { encoding: "utf8", timeout: 20_000 })
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual({ schema: true, headers: true, result: { value: "preserved 日本語 🦉" } })

    const mismatch = join(root, "mismatch")
    const effect = join(mismatch, "node_modules/effect")
    mkdirSync(join(effect, "dist"), { recursive: true })
    writeFileSync(
      join(effect, "package.json"),
      JSON.stringify({ name: "effect", version: "0.0.0", type: "module", exports: { ".": "./dist/index.js" } })
    )
    writeFileSync(join(effect, "dist/index.js"), "throw new Error('must refuse before loading a different version')")
    writeFileSync(join(mismatch, "project.ts"), "export { Schema } from \"effect\"")
    const refused = spawnSync(binary, [join(mismatch, "project.ts")], { encoding: "utf8", timeout: 20_000 })
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain("the project resolves effect@0.0.0")
    expect(refused.stderr).not.toContain("must refuse before loading")
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}, 60_000)
