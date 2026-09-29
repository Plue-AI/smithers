/** Manual read-only discovery measurement; run with Bun from the repository root. */
import { NodeFileSystem, NodePath } from "@effect/platform-node"
import { Effect, FileSystem, Layer, Path } from "effect"
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { writeFileSync } from "node:fs"
import { arch, cpus, platform } from "node:os"
import { join, resolve } from "node:path"
import * as Extension from "../../apps/tui/src/extension.ts"
import * as FlowControl from "../../apps/tui/src/flow-control.ts"
import * as Discovery from "../../packages/smithers/agent/registry/src/Discovery.ts"

const cwd = resolve(process.argv[2] ?? ".")
const output = process.argv[3]
if (output === undefined) {
  throw new Error("Usage: bun scripts/bench/flow-discovery.ts <cwd> <new-output.json> [warm-samples=1]")
}
const repetitions = Number(process.argv[4] ?? "1")
if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 20) {
  throw new Error("warm-samples must be an integer from 1 to 20")
}
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8" }).trim()
const normalized = (value: unknown) => JSON.stringify(value).replaceAll(cwd, "<repo>")
const hash = (value: unknown) => createHash("sha256").update(normalized(value)).digest("hex")
const port = FlowControl.make({
  cwd,
  environment: {},
  approvals: {
    mode: "deny",
    authorize: async () => {
      throw new Error("Discovery must not request execution")
    },
    pending: async () => [],
    reply: async () => undefined
  }
})
const samples: Array<{ phase: string; elapsedMs: number; count: number; sha256: string }> = []
try {
  for (const phase of ["cold", ...Array.from({ length: repetitions }, (_, index) => `warm-${index + 1}`)]) {
    const start = performance.now()
    const descriptors = await port.discover()
    const sample = { phase, elapsedMs: performance.now() - start, count: descriptors.length, sha256: hash(descriptors) }
    samples.push(sample)
    console.error(JSON.stringify(sample))
  }
  const counted = await Effect.runPromise(
    Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const stats = new Map<string, number>()
      let readFile = 0
      let readDirectory = 0
      const counting = FileSystem.make({
        ...fs,
        stat: (file) =>
          Effect.suspend(() => {
            stats.set(file, (stats.get(file) ?? 0) + 1)
            return fs.stat(file)
          }),
        readFile: (file) =>
          Effect.suspend(() => {
            readFile++
            return fs.readFile(file)
          }),
        readDirectory: (file) =>
          Effect.suspend(() => {
            readDirectory++
            return fs.readDirectory(file)
          })
      })
      const start = performance.now()
      const scan = yield* Discovery.make(counting, path).scan({
        source: "project",
        root: join(cwd, "flows"),
        naming: "path"
      })
      return {
        elapsedMs: performance.now() - start,
        stat: [...stats.values()].reduce((total, count) => total + count, 0),
        uniqueStat: stats.size,
        readFile,
        readDirectory,
        descriptors: scan.entries,
        warnings: scan.warnings
      }
    }).pipe(Effect.provide(Layer.merge(NodeFileSystem.layer, NodePath.layer)))
  )
  const projected = hash(counted.descriptors.map(Extension.project))
  if (samples.some((sample) => sample.sha256 !== projected)) {
    throw new Error("Discovery output differs between samples/platforms")
  }
  writeFileSync(
    output,
    JSON.stringify(
      {
        revision,
        runtime: process.versions,
        machine: { platform: platform(), arch: arch(), cpus: cpus().length },
        samples,
        counted: JSON.parse(normalized(counted)),
        descriptorSha256: hash(counted.descriptors),
        warningSha256: hash(counted.warnings)
      },
      null,
      2
    ) + "\n",
    { flag: "wx" }
  )
} finally {
  await port.dispose()
}
