#!/usr/bin/env bun
/**
 * Compiles the Smithers TUI into one self-contained executable per platform
 * with `bun build --compile`, and writes each as an npm package
 * `@smthrs/tui-<os>-<arch>[-baseline][-musl]` under `out/tui-binaries/`,
 * outside the `dist` the CLI package publishes. Listed as optional
 * dependencies of `@smthrs/cli`, they let an installation carry only its
 * platform's binary, so `smthrs tui` needs neither Bun nor a particular Node
 * (see `src/commands/Tui.ts`).
 *
 * The targets and package shape follow opencode's `script/build.ts`: glibc,
 * musl and pre-AVX2 ("baseline") variants, `os`/`cpu`/`libc` fields, the
 * tree-sitter worker bundled as a second entry at a fixed `$bunfs` path, and
 * a replayed print-mode smoke test for the host's binary. Windows is not
 * built: the TUI drives POSIX shells.
 *
 * Runs under Bun: `bun scripts/build-tui-binaries.mjs [--single]`. `--single`
 * builds the host platform only. Cross targets need every
 * `@opentui/core-<platform>` native package installed.
 */
import { spawnSync } from "node:child_process"
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { compiledEffectRuntime } from "./compiled-effect-runtime.mjs"
import { nativeEditorPlugin } from "./tui-native-editor.mjs"
import { verifyNativeArtifacts } from "../vendor/opentui-native/verify.mjs"
import { nativeHelper, nativeHelperBootstrap } from "./tui-native-helper.mjs"

if (typeof Bun === "undefined") {
  console.error("build-tui-binaries.mjs compiles with Bun: run `bun scripts/build-tui-binaries.mjs`.")
  process.exit(1)
}

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..")

verifyNativeArtifacts()
const app = resolve(packageRoot, "../../apps/tui")
const manifest = JSON.parse(readFileSync(resolve(packageRoot, "package.json"), "utf8"))
const fromApp = createRequire(join(app, "package.json"))

/** Every published target, named as `bun build --compile --target=bun-<name>` names it. */
export const targets = [
  { os: "darwin", arch: "arm64" },
  { os: "darwin", arch: "x64" },
  { os: "darwin", arch: "x64", baseline: true },
  { os: "linux", arch: "arm64" },
  { os: "linux", arch: "x64" },
  { os: "linux", arch: "x64", baseline: true },
  { os: "linux", arch: "arm64", musl: true },
  { os: "linux", arch: "x64", musl: true },
  { os: "linux", arch: "x64", baseline: true, musl: true }
]

/** `darwin-arm64`, `linux-x64-baseline-musl`, ... */
export const suffix = (target) =>
  [target.os, target.arch, target.baseline ? "baseline" : undefined, target.musl ? "musl" : undefined]
    .filter(Boolean)
    .join("-")

const single = process.argv.includes("--single")
const selected = single
  ? targets.filter((target) =>
    target.os === process.platform && target.arch === process.arch && !target.baseline && !target.musl
  )
  : targets
if (selected.length === 0) {
  console.error(`No TUI binary target matches ${process.platform}-${process.arch}.`)
  process.exit(1)
}

const workerName = "opentui-tree-sitter-worker.js"
const worker = await Bun.file(fromApp.resolve("@opentui/core/parser.worker")).text()
const entryName = "smithers-tui.ts"
const runtime = compiledEffectRuntime(fromApp)
// Refuse an incomplete cross-build before replacing any existing artifacts.
const helpers = new Map(selected.map((target) => [target, nativeHelper(target, packageRoot)]))
const out = resolve(packageRoot, "out/tui-binaries")
rmSync(out, { recursive: true, force: true })

for (const target of selected) {
  const name = `@smthrs/tui-${suffix(target)}`
  const directory = join(out, `tui-${suffix(target)}`)
  const outfile = join(directory, "bin", "smithers-tui")
  mkdirSync(dirname(outfile), { recursive: true })
  console.log(`building ${name}`)
  const helper = helpers.get(target)
  const result = await Bun.build({
    plugins: [nativeEditorPlugin(packageRoot)],
    entrypoints: [entryName, workerName],
    files: {
      [entryName]: `${runtime}\n${nativeHelperBootstrap(helper, packageRoot)}\nawait import(${JSON.stringify(join(app, "src/main.tsx"))});`,
      [workerName]: worker
    },
    tsconfig: join(app, "tsconfig.json"),
    format: "esm",
    minify: true,
    compile: {
      target: `bun-${suffix(target)}`,
      outfile,
      autoloadBunfig: false,
      autoloadDotenv: false,
      autoloadTsconfig: false,
      // Runtime project imports need package export maps, even though the host
      // itself is bundled. The generated bridge keeps Effect a single instance.
      autoloadPackageJson: true
    },
    define: {
      OTUI_TREE_SITTER_WORKER_PATH: JSON.stringify(`/$bunfs/root/${workerName}`),
      ...(target.os === "linux" ? { "process.env.OPENTUI_LIBC": JSON.stringify(target.musl ? "musl" : "glibc") } : {})
    }
  })
  if (!result.success) {
    for (const log of result.logs) console.error(log)
    process.exit(1)
  }
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify(
      {
        name,
        version: manifest.version,
        description: `The Smithers TUI compiled for ${suffix(target)}`,
        license: manifest.license,
        repository: manifest.repository,
        preferUnplugged: true,
        os: [target.os],
        cpu: [target.arch],
        ...(target.os === "linux" ? { libc: [target.musl ? "musl" : "glibc"] } : {})
      },
      null,
      2
    ) + "\n"
  )
  if (target.os === process.platform && target.arch === process.arch && !target.musl) smoke(outfile)
}

/** Replays a one-cell answer in print mode; the binary must print it and exit 0. */
function smoke(binary) {
  const result = spawnSync(binary, ["-p", "Reply with pong"], {
    cwd: app,
    encoding: "utf8",
    timeout: 60_000,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      SMITHERS_TUI_REPLAY: join(app, "test/fixtures/pong.jsonl"),
      SMITHERS_TUI_SESSION_DIR: join(out, ".smoke-sessions")
    }
  })
  rmSync(join(out, ".smoke-sessions"), { recursive: true, force: true })
  if (result.status !== 0 || result.stdout.trim() !== "pong") {
    console.error(`Smoke test failed for ${binary}: status ${result.status}\n${result.stdout}${result.stderr}`)
    process.exit(1)
  }
  console.log(`smoke test passed: ${binary}`)
}
