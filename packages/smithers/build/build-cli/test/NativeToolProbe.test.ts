import * as Fs from "node:fs/promises"
import * as Os from "node:os"
import * as Path from "node:path"
import { expect, it } from "vitest"
import * as PackageDiscovery from "../src/PackageDiscovery.ts"
import * as PackageExec from "../src/PackageExec.ts"
import { PackageIndex } from "../src/PackageIndex.ts"
import * as PackageLoader from "../src/PackageLoader.ts"

interface Observation {
  readonly selected: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string
  readonly path: string | null
  readonly ambient: string | null
  readonly declared: string | null
}

/**
 * A real native plan must identify the executable its declared lookup context
 * selects. Probes receive only lookup capabilities, even before execution.
 */
it.skipIf(process.platform === "win32")(
  "confines native version probes to each target's lookup environment and workspace cwd",
  async () => {
    const root = await Fs.realpath(await Fs.mkdtemp(Path.join(Os.tmpdir(), "smithers-native-tool-probe-")))
    const saved = new Map(["PATH", "SMITHERS_TEST_TOOL_PROBE_CANARY"].map((name) => [name, process.env[name]]))
    const trace = Path.join(root, "probe.jsonl")
    const name = "owned-tool-probe.cjs"
    const selected = Path.join(root, "selected")
    const decoy = Path.join(root, "decoy")
    const paths = [
      [selected, Path.join(root, "lookup-one"), Path.dirname(process.execPath)].join(Path.delimiter),
      [selected, Path.join(root, "lookup-two"), Path.dirname(process.execPath)].join(Path.delimiter)
    ]
    const write = async (relative: string, contents: string): Promise<void> => {
      const path = Path.join(root, relative)
      await Fs.mkdir(Path.dirname(path), { recursive: true })
      await Fs.writeFile(path, contents)
    }
    try {
      await write("package.json", "{\"name\":\"owned-native-tool-probe\",\"private\":true,\"type\":\"module\"}\n")
      await write(
        "WORKSPACE.ts",
        `import { Smithers as S } from "@smthrs/targets"
const runtime = S.Runtime.Node({ version: ">=26.4.0" })
export const Workspace = S.Workspace("owned-native-tool-probe", {
  repository: "git+https://example.invalid/owned-native-tool-probe.git",
  cache: S.Cache({ directory: ".flows" }), runtime,
  packageManager: S.PackageManager.Pnpm({ version: "11.25.0", runtime }),
  nodeModules: S.Npm.NodeModules({ packageJson: S.file("//package.json") }),
  host: S.Host({ bins: [${JSON.stringify(name)}] }),
  sandboxes: S.Sandboxes({ default: S.Sandbox.None() })
})\n`
      )
      await write(
        "PACKAGE.ts",
        `import { Smithers as S } from "@smthrs/targets"
export const Package = S.Package({ targets: {
  one: S.Shell.Build({ bin: S.Host.bin(${JSON.stringify(name)}), env: { PATH: ${
          JSON.stringify(paths[0])
        }, PROBE_DECLARED_MARKER: "one" }, outDirs: ["one"], sandbox: "none" }),
  two: S.Shell.Build({ bin: S.Host.bin(${JSON.stringify(name)}), env: { PATH: ${
          JSON.stringify(paths[1])
        }, PROBE_DECLARED_MARKER: "two" }, outDirs: ["two"], sandbox: "none" })
} })\n`
      )
      for (const location of ["selected", "decoy"]) {
        await write(
          `${location}/${name}`,
          `#!${process.execPath}\n` +
            `const fs = require('node:fs')\n` +
            `fs.appendFileSync(${JSON.stringify(trace)}, JSON.stringify({ selected: ${
              JSON.stringify(location)
            }, args: process.argv.slice(2), cwd: process.cwd(), path: process.env.PATH ?? null, ambient: process.env.SMITHERS_TEST_TOOL_PROBE_CANARY ?? null, declared: process.env.PROBE_DECLARED_MARKER ?? null }) + '\\n')\n` +
            `process.stdout.write('1.0.0\\n')\n`
        )
        await Fs.chmod(Path.join(root, location, name), 0o755)
      }
      process.env["PATH"] = [decoy, Path.dirname(process.execPath), saved.get("PATH") ?? ""].join(Path.delimiter)
      process.env["SMITHERS_TEST_TOOL_PROBE_CANARY"] = "private-test-marker-must-not-reach-probes"
      const loaded = await PackageLoader.load(await PackageDiscovery.discover(root))
      const plan = await PackageExec.plan({
        index: PackageIndex.make(loaded),
        patterns: ["//..."],
        cacheDirectory: ".flows",
        verb: "build"
      })
      for (const label of ["//:one", "//:two"]) {
        expect(plan.nodes.get(label)?.refusal).toBeUndefined()
        expect(plan.nodes.get(label)?.argv).toEqual([Path.join(selected, name)])
      }
      const observed = (await Fs.readFile(trace, "utf8")).trim().split("\n").map((line) =>
        JSON.parse(line) as Observation
      )
      // Both contexts resolve the same path. Two observations with distinct
      // lookup environments prove that the second did not reuse the first map.
      expect(observed).toHaveLength(2)
      expect(new Set(observed.map((entry) => entry.path))).toEqual(new Set(paths))
      for (const entry of observed) {
        expect(entry).toMatchObject({
          selected: "selected",
          args: ["--version"],
          cwd: root,
          ambient: null,
          declared: null
        })
      }
      await expect(Fs.stat(Path.join(root, "one"))).rejects.toMatchObject({ code: "ENOENT" })
      await expect(Fs.stat(Path.join(root, "two"))).rejects.toMatchObject({ code: "ENOENT" })
    } finally {
      for (const [name, value] of saved) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
      await Fs.rm(root, { recursive: true, force: true })
    }
  }
)
