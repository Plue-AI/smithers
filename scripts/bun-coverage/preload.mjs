import { plugin } from "bun"
import { randomUUID } from "node:crypto"
import { readFileSync, realpathSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { observeChildren } from "./children.mjs"
import { verifyArtifacts } from "./manifest.mjs"
import { receipt } from "./receipts.mjs"

const prefix = "SMITHERS_BUN_COVERAGE_"
const configuration = process.env[`${prefix}CONFIG`]
if (!configuration) throw new Error("Missing Bun coverage run configuration")
const config = JSON.parse(readFileSync(configuration, "utf8"))
const sealedManifest = JSON.parse(readFileSync(config.manifestPath, "utf8"))
const prepared = verifyArtifacts(sealedManifest, JSON.parse(readFileSync(config.artifactPath, "utf8")))
const id = process.env[`${prefix}NEXT_ID`]
if (!id) throw new Error("Unregistered Bun child: use a qualified direct spawn boundary")
const parent = process.env[`${prefix}PARENT`] ?? null
const mode = process.env[`${prefix}MODE`]
delete process.env[`${prefix}NEXT_ID`]
process.env[`${prefix}PARENT`] = id
const envelope = { id, parent, runId: config.runId, manifest: prepared.manifest.digest }
receipt(config.run, "started", id, { ...envelope, pid: process.pid, mode })
const recordError = (error) => {
  const errorId = randomUUID()
  receipt(config.run, "errors", errorId, { id: errorId, process: id, message: String(error) })
}
// A second preload of this module uses ESM's module cache; it cannot reset hits.
globalThis.__coverage__ = prepared.zero
let owningSourceLoaded = false
plugin({ name: "smithers-owning-source-coverage", setup(builder) {
  const escaped = [...prepared.codes.keys()].map((path) => path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  builder.onLoad({ filter: new RegExp(`^(?:${escaped.join("|")})$`) }, ({ path }) => {
    const compiled = prepared.codes.get(realpathSync(path))
    if (!compiled) throw new Error(`JavaScript source missing from owning roster: ${path}`)
    if (!owningSourceLoaded) {
      // Publish before returning executable owner code. A hard-killed process
      // can contribute sealed zero only when no owning onLoad ever completed.
      try { receipt(config.run, "loads", id, { ...envelope, source: compiled.zero.path }) }
      catch (error) { recordError(error); throw error }
      owningSourceLoaded = true
    }
    return { contents: compiled.code, loader: compiled.loader }
  })
} })
observeChildren({ run: config.run, runId: config.runId, manifest: prepared.manifest.digest,
  id, configuration, preload: fileURLToPath(import.meta.url), recordError })
let completed = false
function flush(phase, code = null) {
  if (completed) return
  // Refuse source drift even when the original module wasn't imported.
  const currentManifest = JSON.parse(readFileSync(config.manifestPath, "utf8"))
  if (JSON.stringify(currentManifest) !== JSON.stringify(sealedManifest)) throw new Error("Coverage manifest changed")
  verifyArtifacts(sealedManifest, JSON.parse(readFileSync(config.artifactPath, "utf8")))
  receipt(config.run, "coverage", id, { ...envelope, phase, code, coverage: globalThis.__coverage__ })
  completed = true
}
process.once("exit", (code) => {
  try { flush("exit", code) } catch (error) { recordError(error) }
})
if (mode === "test") {
  const { afterAll } = await import("bun:test")
  afterAll(() => flush("globalAfterAll"), 30_000)
} else if (mode !== "run") throw new Error("Unsupported Bun process mode")
