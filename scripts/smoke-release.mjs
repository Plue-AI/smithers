/**
 * Installs release tarballs into an external temporary project and verifies
 * every packed package, not just the barrel.
 *
 * A consumer of this release never has the workspace: they get the tarballs and
 * whatever the manifests tell a package manager to fetch. So the smoke project
 * is created outside the repository, the tarballs are installed into it, and
 * each packed package is then imported through its published entry as ESM and
 * required as CJS. A package that resolves only because the workspace is on
 * disk fails here.
 *
 * Optional peer dependencies are installed too, because a peer is exactly what
 * the consumer is told to bring: `@smthrs/platform-bun` resolves
 * `@effect/platform-bun` at import time, and without it the ESM entry throws
 * ERR_MODULE_NOT_FOUND in the consumer's project.
 * A second, empty consumer installs `@smthrs/cli` alone with npm and an empty
 * package cache, answers MCP `initialize` from the installed `smthrs --mcp`,
 * and holds every Effect-family package it resolved to the pinned version: a
 * fresh resolver taking a third-party caret edge past the pin is how
 * `smithers-orchestrator@0.32.0` failed before its handshake (#2398).
 * Separate npm and pnpm consumers then certify default libraries, selected
 * Node/browser/Bun adapters, create-app/testing, and migration install shapes
 * against the same tarballs before a successful smoke receipt is written.
 * Requires npm >=11.16.0 on PATH, including under Node 26.4.0. npm 10.9.3
 * crashes in Arborist when resolving the testing optional peers.
 * Installs prefer cached metadata and package bytes. Every pnpm consumer uses
 * the workspace's store, with cache reuse reported beside command timings.
 * First-party bytes always come from the supplied candidate tarballs.
 *
 * Measured on 2026-09-14, Node 24.18.0, clean d2cc7a56 candidate, 49 packs:
 * `/usr/bin/time -p node scripts/smoke-release.mjs <packs>` took 1110.40 s.
 * Phase logs accounted for 1107.63 s: pack verification 2.05 s, main install
 * plus peers 74.84 s, isolated imports 111.39 s, CLI containment 310.27 s,
 * consumer matrix 505.79 s (npm installs 199.42 s; pnpm installs 77.45 s).
 * 105/133 pnpm progress lines reported downloaded 0. All 26 profiles and
 * both incompatible-peer refusals passed. The 600 s default cannot cover
 * this work even after removing duplicate containment CLI startups. The
 * releaseSmoke NodeTest therefore declares a 30m bound, retaining every
 * profile and uncached execution. Subsequent runs emit the same phase logs.
 *
 * usage: node scripts/smoke-release.mjs <pack-directory>
 */
import { spawn } from "node:child_process"
import { build as bundle } from "esbuild"
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { peerRangesOf } from "./release-peer-ranges.mjs"
import { captureProcess } from "./release-process.mjs"
import { releaseRegistry } from "./release-registry.mjs"
import { recordSmokeSuccess, verifyLocalCandidate } from "./publish-release.mjs"
import { assertNodeSupport } from "./release-node-support.mjs"
import { assertSmokeNpmSupport } from "./release-npm-support.mjs"
import { verifyPackagedNativeHelpers } from "./release-native-helpers.mjs"
import { EXPECTED_EFFECT_VERSION } from "./check-single-effect-version.mjs"
import { assertEffectFamilyInstalled, mcpInitialize } from "./release-mcp-handshake.mjs"
import { adapterProfiles, consumerCacheFlags, migrationProfiles, minimalProfiles, releasePackageManager, runConsumerMatrix, templateProfile } from "./release-consumers.mjs"
import { repoRoot } from "./workspace-packages.mjs"

/**
 * Packages whose published entry throws on purpose.
 *
 * `smthrs` keeps its place on the registry only to tell an upgrading project
 * where the code went, so a successful load is the failure.
 */
const noticeOnly = new Set(["smthrs"])
const noticeFirstLine = "smthrs 1.0 is a migration notice, not a runtime."

// Phase records include cleanup and non-command work, so their wall time can
// be reconciled with `/usr/bin/time -p node scripts/smoke-release.mjs <packs>`.
const phase = async (name, work) => {
  const started = performance.now()
  console.log(JSON.stringify({ smokePhase: name, event: "start", at: new Date().toISOString() }))
  try { return await work() }
  finally {
    console.log(JSON.stringify({ smokePhase: name, event: "end", at: new Date().toISOString(), durationMs: performance.now() - started }))
  }
}
const runQuietly = (command, args, cwd, options) => phase(
  `probe: ${[command, ...args].join(" ")}`, () => captureProcess(command, args, cwd, options))

const run = (command, args, cwd) => phase(`command: ${[command, ...args].join(" ")}`, () =>
  new Promise((resolveRun, reject) => {
    const started = Date.now()
    const child = spawn(command, args, { cwd, stdio: "inherit" })
    child.once("error", reject)
    child.once("exit", (code, signal) => {
      console.log(JSON.stringify({ command, args, cwd, node: process.version, exit: code, signal, durationMs: Date.now() - started }))
      if (code === 0) {
        resolveRun()
      } else {
        reject(new Error(`${command} exited with ${code ?? signal ?? "unknown status"}`))
      }
    })
  }))

const packDirectory = process.argv[2]
if (packDirectory === undefined) {
  throw new Error("usage: node scripts/smoke-release.mjs <pack-directory>")
}

const absolutePackDirectory = resolve(packDirectory)
// A failed rerun must not leave the prior successful receipt available to publish.
await rm(join(absolutePackDirectory, "smoke-evidence.json"), { force: true })
const candidate = await phase("pack read and integrity", async () => {
  const manifest = JSON.parse(await readFile(join(absolutePackDirectory, "release-manifest.json"), "utf8"))
  await verifyLocalCandidate(absolutePackDirectory, manifest)
  return manifest
})
const npmVersion = await runQuietly("npm", ["--version"], repoRoot)
if (!npmVersion.ok) throw new Error(`npm --version failed: ${npmVersion.output}`)
assertSmokeNpmSupport(npmVersion.output.trim())
console.log(JSON.stringify({ smokeToolchain: { node: process.version, npm: npmVersion.output.trim(), pnpm: releasePackageManager } }))
const packManifest = JSON.parse(
  await readFile(join(absolutePackDirectory, "manifest.json"), "utf8")
)
const expected = new Set(packManifest.map((entry) => entry.filename))
const tarballs = (await readdir(absolutePackDirectory))
  .filter((filename) => filename.endsWith(".tgz"))
  .sort()

if (tarballs.length !== expected.size || tarballs.some((filename) => !expected.has(filename))) {
  throw new Error("release pack directory does not match manifest.json")
}

// Reuse downloaded dependencies across the main smoke and every isolated
// profile. Keep first-party resolution on the loopback registry of these exact
// candidate tarballs; a warm store never substitutes workspace source packages.
const cacheFlags = await phase("pnpm store resolution", () => consumerCacheFlags("pnpm"))
const smokeRoot = await mkdtemp(join(tmpdir(), "smthrs-release-smoke-"))
let registry
try {
  registry = await phase("registry startup", () => releaseRegistry(absolutePackDirectory, packManifest))
  await writeFile(join(smokeRoot, ".npmrc"), `@smthrs:registry=${registry.url}\n`)
  const releaseDependencies = Object.fromEntries(
    packManifest.map((entry) => [entry.name, entry.name.startsWith("@smthrs/")
      ? entry.version : `file:${join(absolutePackDirectory, entry.filename)}`])
  )
  await writeFile(
    join(smokeRoot, "package.json"),
    `${JSON.stringify({
      private: true,
      smthrsReleaseConsumer: true,
      type: "module",
      packageManager: releasePackageManager,
      dependencies: {
        ...releaseDependencies,
        typescript: "7.0.2",
        vitest: "5.0.0"
      }
    }, null, 2)}\n`
  )
  // Resolve both direct and transitive first-party edges through a disposable
  // registry. Root file: dependencies do not satisfy transitive registry edges
  // in pnpm. This uses unchanged published manifests, without overrides,
  // workspace linking, or requiring an unreleased package to exist on npm.
  await run("pnpm", ["--dir", smokeRoot, "--version"], repoRoot)
  await run(
    "pnpm",
    [
      "--dir",
      smokeRoot,
      "install",
      "--ignore-scripts",
      ...cacheFlags,
    ],
    repoRoot
  )

  const installed = await Promise.all(
    packManifest.map(async (entry) =>
      JSON.parse(await readFile(join(smokeRoot, "node_modules", entry.name, "package.json"), "utf8"))
    )
  )
  for (const manifest of installed) {
    assertNodeSupport(manifest, process.versions.node)
  }
  const peers = [...peerRangesOf(installed)]
    .filter(([name]) => installed.every((manifest) => manifest.name !== name))
    .map(([name, range]) => `${name}@${range}`)
  if (peers.length > 0) {
    await run("pnpm", ["--dir", smokeRoot, "add", "--ignore-scripts", ...cacheFlags, ...peers], repoRoot)
  }
  await run("pnpm", ["--dir", smokeRoot, "peers", "check"], repoRoot)

  // Every packed package, through its published entry, in a project that has
  // no access to the workspace.
  const failures = []
  for (const entry of packManifest) {
    const size = (await stat(join(absolutePackDirectory, entry.filename))).size
    const esm = await runQuietly(
      process.execPath,
      ["--input-type=module", "--eval", `await import(${JSON.stringify(entry.name)})`],
      smokeRoot
    )
    const cjs = await runQuietly(
      process.execPath,
      ["--eval", `require(${JSON.stringify(entry.name)})`],
      smokeRoot
    )
    if (noticeOnly.has(entry.name)) {
      // The unscoped `smthrs` package is a migration notice: loading is
      // supposed to fail with the notice as the message. A load that succeeds
      // means the notice stopped working.
      const results = [["ESM import", esm], ["CJS require", cjs]]
      const wrong = results.filter(([, result]) => result.ok || !result.output.includes(noticeFirstLine))
      const status = wrong.length === 0 ? "ok  " : "FAIL"
      console.log(
        `smoke ${status} ${entry.name}@${entry.version} (${entry.filename}, ${(size / 1024).toFixed(1)} kB, migration notice)`
      )
      for (const [label, result] of wrong) {
        failures.push(
          `${entry.name}: ${label} did not report the migration notice\n${result.output.trimEnd()}`
        )
      }
      continue
    }
    const status = esm.ok && cjs.ok ? "ok  " : "FAIL"
    console.log(
      `smoke ${status} ${entry.name}@${entry.version} (${entry.filename}, ${(size / 1024).toFixed(1)} kB)`
    )
    if (!esm.ok) failures.push(`${entry.name}: ESM import failed\n${esm.output.trimEnd()}`)
    if (!cjs.ok) failures.push(`${entry.name}: CJS require failed\n${cjs.output.trimEnd()}`)
  }
  if (failures.length > 0) {
    throw new Error(`release tarballs failed to load:\n${failures.join("\n\n")}`)
  }

  // The same recorded transport and stubborn stdio server used by the source
  // fault tests, relocated beside the installed fixture so imports resolve
  // exclusively from this external consumer's dependencies.
  for (const [source, target] of [
    ["recorded-provider.mjs", "release-recorded-provider.mjs"],
    ["contained-mcp.mjs", "release-contained-mcp.mjs"]
  ]) {
    await writeFile(join(smokeRoot, target), await readFile(
      join(repoRoot, "packages/smithers/test/faults/fixtures", source)
    ))
  }
  for (const filename of ["consumer-boundary.mjs", "process-state.mjs"]) {
    await writeFile(join(smokeRoot, filename), await readFile(
      join(repoRoot, "scripts/fixtures/installed-consumer", filename)
    ))
  }
  for (const fixture of ["release-public-api.mjs", "release-history-workspace.mjs", "installed-consumer/release-cli-containment.mjs"]) {
    const filename = fixture.split("/").at(-1)
    await writeFile(
      join(smokeRoot, filename),
      await readFile(join(repoRoot, "scripts/fixtures", fixture))
    )
    for (const mode of ["esm", "cjs"]) {
      await run(process.execPath, [filename, mode], smokeRoot)
    }
  }

  for (const [binary, name] of [["smthrs", "@smthrs/cli"], ["smithers-build", "@smthrs/build-cli"]]) {
    const version = packManifest.find((entry) => entry.name === name).version
    const result = await runQuietly(join(smokeRoot, "node_modules/.bin", binary), ["--version"], smokeRoot)
    if (!result.ok || !result.output.includes(version)) throw new Error(`${binary} --version failed: ${result.output}`)
  }
  const cli = join(smokeRoot, "node_modules/.bin/smthrs")
  const nativePackage = join(smokeRoot, "node_modules/@smthrs/platform-node")
  // The script gate packs before native helpers are downloaded. Final release
  // packing supplies them, and a partial helper bundle must still fail here.
  const hasPackagedNativeHelpers = await verifyPackagedNativeHelpers(nativePackage, Boolean(process.env.SMITHERS_NATIVE_HELPERS_DIR))
  const cliEnv = { ...process.env }
  // Final packs must discover their own helper. The earlier script gate still
  // runs every CLI operation using the explicitly configured source helper.
  if (hasPackagedNativeHelpers) delete cliEnv.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
  for (const args of [["init", "release-smoke", "--json"], ["targets", "--json"], ["flow", "list", "--json"]]) {
    const result = await runQuietly(cli, args, smokeRoot, { env: cliEnv })
    if (!result.ok) throw new Error(`Installed CLI ${args.join(" ")} failed: ${result.output}`)
  }
  console.log("CLI smoke ok: packaged binaries, workspace initialization, target loading, and flow discovery")

  await phase("installed CLI MCP handshake", async () => {
    const cliVersion = packManifest.find((entry) => entry.name === "@smthrs/cli").version
    const consumer = await mkdtemp(join(tmpdir(), "smthrs-release-mcp-"))
    try {
      await writeFile(join(consumer, ".npmrc"), `@smthrs:registry=${registry.url}\n`)
      await writeFile(join(consumer, "package.json"), `${JSON.stringify({
        private: true, dependencies: { "@smthrs/cli": cliVersion }
      }, null, 2)}\n`)
      // An empty cache: every third-party range resolves as a new user's would.
      await run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--cache", join(consumer, ".empty-npm-cache")], consumer)
      const installed = assertEffectFamilyInstalled(consumer, EXPECTED_EFFECT_VERSION)
      const serverInfo = await mcpInitialize(join(consumer, "node_modules/.bin/smthrs"), ["--mcp"], { cwd: consumer, env: cliEnv })
      if (serverInfo.version !== cliVersion) {
        throw new Error(`installed smthrs --mcp reported ${serverInfo.version}, packed ${cliVersion}`)
      }
      console.log(`MCP smoke ok: installed smthrs --mcp answered initialize as ${serverInfo.name} ${serverInfo.version}; ` +
        `${installed.length} Effect-family packages all at ${EXPECTED_EFFECT_VERSION}`)
    } finally {
      await rm(consumer, { recursive: true, force: true })
    }
  })

  // Import-only checks cannot catch a guest runner path erased by a CJS build.
  // Execute a real sandboxed flow through both published module conditions.
  for (const filename of ["release-sandbox-entry.mjs", "release-sandbox-smoke.mjs"]) {
    await writeFile(join(smokeRoot, filename), await readFile(join(repoRoot, "scripts/fixtures/installed-consumer", filename)))
  }
  await run(process.execPath, ["release-sandbox-smoke.mjs"], smokeRoot)

  // Bundle a bare side-effect import from the installed tarball. The package
  // manifest, not this repository's source graph, decides whether esbuild may
  // erase the CLI entry. Other packages stay external so this assertion is
  // exactly about retaining `@smthrs/cli/bin` in ESM and CommonJS consumers.
  const sideEffectBuild = async (format) =>
    bundle({
      absWorkingDir: smokeRoot,
      stdin: {
        contents: format === "esm" ? 'import "@smthrs/cli/bin"\n' : 'require("@smthrs/cli/bin")\n',
        resolveDir: smokeRoot,
        sourcefile: `cli-side-effect.${format === "esm" ? "mjs" : "cjs"}`
      },
      bundle: true,
      format,
      platform: "node",
      treeShaking: true,
      write: false,
      metafile: true,
      logLevel: "silent",
      plugins: [{
        name: "external-packages-except-cli-entry",
        setup(build) {
          build.onResolve({ filter: /^[^./]/ }, (args) =>
            args.path === "@smthrs/cli/bin" ? undefined : { path: args.path, external: true }
          )
        }
      }]
    })
  for (const format of ["esm", "cjs"]) {
    const result = await sideEffectBuild(format)
    const suffix = `/@smthrs/cli/dist/${format}/bin.js`
    const retained = Object.values(result.metafile.outputs).some((output) =>
      Object.entries(output.inputs).some(([path, contribution]) =>
        path.endsWith(suffix) && contribution.bytesInOutput > 0
      )
    )
    if (!retained) failures.push(`@smthrs/cli: ${format.toUpperCase()} tree shaking removed the bin side effect`)
  }
  if (failures.length > 0) {
    throw new Error(`release tarball consumer checks failed:\n${failures.join("\n\n")}`)
  }

  await writeFile(
    join(smokeRoot, "smoke.mts"),
    [
      'import * as Flows from "@smthrs/flows"',
      'import { runHostContract } from "@smthrs/kernel/test/contract"',
      "",
      "const publicApi: typeof Flows = Flows",
      "void publicApi",
      "void runHostContract",
      ""
    ].join("\n")
  )
  await writeFile(join(smokeRoot, "smoke.cts"), [
    'import Flows = require("@smthrs/flows")',
    'import Errors = require("@smthrs/errors")',
    'import Contract = require("@smthrs/kernel/test/contract")',
    "const publicApi: typeof Flows = Flows",
    "void publicApi",
    "void Errors.SmithersError",
    "void Contract.runHostContract",
    ""
  ].join("\n"))
  for (const module of ["Node16", "NodeNext"]) {
    await run("node", [
      "node_modules/typescript/bin/tsc", "--noEmit",
      "--module", module, "--moduleResolution", module,
      "--target", "ES2022", "--skipLibCheck", "smoke.mts", "smoke.cts"
    ], smokeRoot)
  }
  // All-peers imports alone can conceal an unrelated adapter forced into a
  // library's default install. Certify independent profiles on both managers
  // against these same candidate bytes before issuing the success receipt.
  await phase("consumer matrix", () => runConsumerMatrix(absolutePackDirectory, packManifest, {
    profiles: [...minimalProfiles(packManifest), ...adapterProfiles(packManifest), ...migrationProfiles(packManifest), templateProfile(absolutePackDirectory, packManifest)], runtime: true
  }))
  if (hasPackagedNativeHelpers) {
    await phase("success receipt", () => recordSmokeSuccess(absolutePackDirectory, candidate))
  } else {
    console.log("Pre-helper rehearsal passed; no publishable smoke receipt written.")
  }
  console.log(
    `\nrelease smoke holds: ${packManifest.length} tarballs install, import, and typecheck` +
      ` on node ${process.versions.node}.`
  )
} finally {
  await phase("cleanup", async () => {
    await registry?.close()
    await rm(smokeRoot, { recursive: true, force: true })
  })
}
