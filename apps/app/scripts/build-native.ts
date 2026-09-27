import { createHash } from "node:crypto"
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs"
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path"
import { bundlePostgres } from "./bundle-postgres"
import { foreignLibraries } from "./system-linkage"
import { validateGitBundle } from "./validate-git-bundle"

const appDir = resolve(import.meta.dir, "..")
const root = resolve(appDir, "..", "..")
const revision = process.env.SMITHERS_BUILD_SHA?.trim()
if (!revision || !/^[0-9a-f]{40,64}$/.test(revision)) throw new Error("Native build requires an exact SMITHERS_BUILD_SHA.")
const nativeDir = join(appDir, ".native")
const jjRevision = "47589ada70c12b3e829b5c98ab32503abad49eac"
const jjVersion = `jj 0.44.0-${jjRevision}`
const cefSetting = process.env.SMITHERS_NATIVE_E2E_CEF?.trim()
if (cefSetting !== undefined && cefSetting !== "" && cefSetting !== "0" && cefSetting !== "1") {
  throw new Error("SMITHERS_NATIVE_E2E_CEF must be 0 or 1.")
}
const cefMatrix = cefSetting === "1"
const cdpSetting = process.env.SMITHERS_NATIVE_E2E_CDP_PORT?.trim()
if (!cefMatrix && cdpSetting) {
  throw new Error("SMITHERS_NATIVE_E2E_CDP_PORT is accepted only for the explicit CEF matrix artifact.")
}
if (cefMatrix && !cdpSetting) throw new Error("The CEF matrix artifact requires SMITHERS_NATIVE_E2E_CDP_PORT.")
if (cdpSetting && (!/^\d+$/.test(cdpSetting) || Number(cdpSetting) < 1024 || Number(cdpSetting) > 65535)) {
  throw new Error("SMITHERS_NATIVE_E2E_CDP_PORT must be an integer from 1024 through 65535.")
}
const configuredCargoTarget = process.env.CARGO_TARGET_DIR?.trim()
const cargoTargetDir = configuredCargoTarget
  ? resolve(root, configuredCargoTarget)
  : join(root, "target")
const configuredNode = process.env.SMITHERS_NODE_BINARY?.trim()
const discoveredNode = configuredNode === undefined || configuredNode === ""
  ? Bun.which("node")
  : isAbsolute(configuredNode) ? configuredNode : Bun.which(configuredNode)
if (discoveredNode === null || discoveredNode === undefined) {
  throw new Error("SMITHERS_NODE_BINARY must name a build-time Node 26.4+ executable.")
}
const nodeBinary = realpathSync(discoveredNode)
const nodeVersion = Bun.spawnSync([nodeBinary, "--version"], { stdout: "pipe", stderr: "pipe" })
const nodeRelease = /^v26\.(\d+)\./.exec(new TextDecoder().decode(nodeVersion.stdout).trim())
if (nodeVersion.exitCode !== 0 || nodeRelease === null || Number(nodeRelease[1]) < 4) {
  throw new Error("SMITHERS_NODE_BINARY must name Node 26.4 or a later Node 26.")
}
// The app ships this binary, so it must run on a Mac without the build
// machine's package manager. The nodejs.org build links only macOS.
const foreignNodeLibraries = foreignLibraries(nodeBinary)
if (foreignNodeLibraries.length > 0) {
  throw new Error(
    `SMITHERS_NODE_BINARY must link only macOS system libraries: ${nodeBinary} loads ${foreignNodeLibraries.join(", ")}`
  )
}
// Node 26 ships no corepack, so the pinned pnpm comes from PATH and must be
// exactly the release the root package.json declares.
const pnpmPin = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager: string }).packageManager
const discoveredPnpm = existsSync(join(dirname(nodeBinary), "pnpm")) ? join(dirname(nodeBinary), "pnpm") : Bun.which("pnpm")
if (discoveredPnpm === null || discoveredPnpm === undefined || (statSync(discoveredPnpm).mode & 0o111) === 0) {
  throw new Error(`The native build needs an executable ${pnpmPin} beside the selected Node or on PATH.`)
}
const pnpmBinary = discoveredPnpm
const pnpmVersion = Bun.spawnSync([pnpmBinary, "--version"], { stdout: "pipe", stderr: "pipe" })
if (pnpmVersion.exitCode !== 0 || `pnpm@${new TextDecoder().decode(pnpmVersion.stdout).trim()}` !== pnpmPin) {
  throw new Error(`The native build needs ${pnpmPin}: ${pnpmBinary}`)
}
const nodeLicense = join(dirname(dirname(nodeBinary)), "LICENSE")
if (!existsSync(nodeLicense)) throw new Error(`Node license is unavailable: ${nodeLicense}`)
const nodeEnvironment = {
  PATH: process.env.PATH === undefined || process.env.PATH === ""
    ? dirname(nodeBinary)
    : `${dirname(nodeBinary)}${delimiter}${process.env.PATH}`
}

const output = (argv: ReadonlyArray<string>, env = process.env): string => {
  const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe", env })
  if (result.exitCode !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`)
  }
  return new TextDecoder().decode(result.stdout).trim()
}
const withoutGitOverrides = Object.fromEntries(
  Object.entries(process.env).filter(([name, value]) =>
    value !== undefined && name !== "GIT_EXEC_PATH" && name !== "GIT_TEMPLATE_DIR")
) as Record<string, string>
const configuredGit = process.env.SMITHERS_GIT_BINARY?.trim()
const discoveredGit = configuredGit
  ? isAbsolute(configuredGit) ? configuredGit : Bun.which(configuredGit)
  : process.platform === "darwin"
  ? output(["/usr/bin/xcrun", "--find", "git"], withoutGitOverrides)
  : Bun.which("git")
if (discoveredGit === null || discoveredGit === undefined || discoveredGit === "") {
  throw new Error("SMITHERS_GIT_BINARY must name an executable Git installation.")
}
const gitBinary = realpathSync(discoveredGit)
const gitVersion = output([gitBinary, "--version"], withoutGitOverrides)
if (!/^git version \d+\.\d+/.test(gitVersion)) throw new Error("The selected Git installation returned an invalid version.")
const gitExecSource = realpathSync(output([gitBinary, "--exec-path"], withoutGitOverrides))
const gitPrefix = resolve(gitExecSource, "..", "..")
const gitShareSource = join(gitPrefix, "share", "git-core")
if (!existsSync(gitShareSource)) throw new Error(`Git resources are unavailable: ${gitShareSource}`)

const checksumFile = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex")
const verifyChecksumSidecar = (path: string): void => {
  const expected = `${checksumFile(path)}  ${basename(path)}\n`
  if (readFileSync(`${path}.sha256`, "utf8") !== expected) {
    throw new Error(`Packaged checksum is invalid: ${path}.sha256`)
  }
}
const run = async (
  label: string,
  argv: ReadonlyArray<string>,
  cwd = root,
  extraEnv: Readonly<Record<string, string>> = {}
): Promise<void> => {
  console.log(`[build-native] ${label}: ${argv.join(" ")}`)
  const child = Bun.spawn([...argv], {
    cwd,
    env: {
      ...process.env,
      CARGO_BUILD_JOBS: "2",
      GOMAXPROCS: "2",
      ...extraEnv
    },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit"
  })
  const code = await child.exited
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}.`)
}

const postgresBundle = process.env.SMITHERS_POSTGRES_BUNDLE_DIR?.trim()
if (!postgresBundle) {
  throw new Error(
    "SMITHERS_POSTGRES_BUNDLE_DIR must name a build-time PostgreSQL 18 distribution; native launch never downloads binaries."
  )
}
const postgresBin = join(postgresBundle, "bin")
for (const tool of ["postgres", "initdb", "pg_isready", "psql", "pg_dump", "pg_restore"]) {
  const path = join(postgresBin, tool)
  if (!existsSync(path) || (statSync(path).mode & 0o111) === 0) {
    throw new Error(`PostgreSQL bundle is missing bin/${tool}.`)
  }
}
const version = Bun.spawnSync([join(postgresBin, "postgres"), "--version"], {
  stdout: "pipe",
  stderr: "pipe"
})
if (
  version.exitCode !== 0 ||
  !/PostgreSQL\)?\s+18\./.test(new TextDecoder().decode(version.stdout))
) {
  throw new Error("SMITHERS_POSTGRES_BUNDLE_DIR must contain PostgreSQL 18.")
}
if (!existsSync(join(root, "crates", "smithers-ffi", "Cargo.toml"))) {
  throw new Error("crates/smithers-ffi is required for the native distribution.")
}

rmSync(nativeDir, { recursive: true, force: true })
mkdirSync(join(nativeDir, "bin"), { recursive: true })
mkdirSync(join(nativeDir, "licenses"), { recursive: true })
const wasm = join(root, "packages", "smithers", "flows", "jj", "wasm", "flows_jj.wasm")
if (!existsSync(wasm) || statSync(wasm).size === 0) {
  throw new Error("The canonical flows_jj.wasm artifact is missing.")
}
await run("pinned Rust toolchain", ["rustup", "toolchain", "install"])
if (process.platform === "linux" && process.arch === "x64") {
  await run("canonical jj WebAssembly", ["node", "crates/flows-jj/build-wasm.mjs", "--verify"])
} else {
  console.log("[build-native] canonical jj WebAssembly: using verified linux/amd64 artifact")
}
await run("native FFI", ["cargo", "build", "--locked", "--release", "--package", "smithers-ffi"])
const jjInstallRoot = join(nativeDir, ".jj-install")
await run(
  "pinned jj CLI",
  [
    "cargo", "install", "--locked",
    "--git", "https://github.com/smithersai/jj.git", "--rev", jjRevision,
    "--root", jjInstallRoot, "jj-cli"
  ],
  root,
  { NIX_JJ_GIT_HASH: jjRevision }
)
const installedJj = join(jjInstallRoot, "bin", "jj")
if (output([installedJj, "--version"]) !== jjVersion) throw new Error(`Native releases require ${jjVersion}.`)
cpSync(installedJj, join(nativeDir, "bin", "jj"))
rmSync(jjInstallRoot, { recursive: true, force: true })
await run(
  "Go backend",
  ["go", "build", "-trimpath", "-ldflags", `-X github.com/smithersai/smithers/packages/backend/internal/compose.BuildSHA=${revision}`, "-o", join(nativeDir, "bin", "smithers-backend"), "./apps/backend"]
)
await run("Node buildchain", [nodeBinary, "--version"], root, nodeEnvironment)
await run("pinned pnpm buildchain", [pnpmBinary, "--version"], root, nodeEnvironment)
const codingHost = join(nativeDir, "bin", "smithers-coding-host")
await run(
  "canonical coding host",
  [
    nodeBinary,
    "flows/coding/build.mjs",
    codingHost
  ],
  root,
  nodeEnvironment
)
const librarianHost = join(nativeDir, "bin", "smithers-librarian-host")
await run(
  "canonical librarian host",
  [nodeBinary, "flows/librarian/build.mjs", librarianHost],
  root,
  nodeEnvironment
)
const modelHost = join(nativeDir, "bin", "smithers-model-host")
await run("canonical model host", [nodeBinary, "apps/model-host/build.mjs", modelHost], root, nodeEnvironment)
verifyChecksumSidecar(modelHost)
await run(
  "Flow host manifest",
  [
    nodeBinary,
    "distribution/flow-host-manifest.mjs",
    join(nativeDir, "bin", "flow-hosts.json"),
    codingHost,
    librarianHost
  ],
  root,
  nodeEnvironment
)

// Canonical host artifacts are executable ESM with `#!/usr/bin/env node`.
// Ship the validated Node 26 build runtime and its license. An installed app
// never depends on Homebrew, nvm, or a runtime download.
const hostRuntime = join(nativeDir, "bin", "node")
cpSync(nodeBinary, hostRuntime)
cpSync(nodeLicense, join(nativeDir, "licenses", "node-LICENSE"))
cpSync(join(root, "distribution", "licenses", "jj-LICENSE"), join(nativeDir, "licenses", "jj-LICENSE"))
cpSync(join(root, "distribution", "licenses", "git-COPYING"), join(nativeDir, "licenses", "git-COPYING"))
await run("packaged coding host", [hostRuntime, codingHost, "--help"])
await run("packaged librarian host", [hostRuntime, librarianHost, "--help"])
await run("packaged model host", [hostRuntime, modelHost, "--help"])

const packagedGitRoot = nativeDir
cpSync(gitBinary, join(nativeDir, "bin", "git"))
cpSync(gitExecSource, join(nativeDir, "libexec", "git-core"), {
  recursive: true,
  verbatimSymlinks: true
})
// Xcode links these optional commands into git-core, but the app ships only bin/git.
for (const unused of ["git-shell", "scalar"]) {
  rmSync(join(nativeDir, "libexec", "git-core", unused), { force: true })
}
cpSync(gitShareSource, join(nativeDir, "share", "git-core"), {
  recursive: true,
  verbatimSymlinks: true
})
writeFileSync(join(nativeDir, "share", "build-tools.json"), JSON.stringify({ revision, git: gitVersion, jj: jjVersion }, null, 2) + "\n")
validateGitBundle(nativeDir, [
  join(nativeDir, "bin", "git"),
  join(nativeDir, "libexec", "git-core"),
  join(nativeDir, "share", "git-core")
])
const gitEnvironment = {
  GIT_EXEC_PATH: join(packagedGitRoot, "libexec", "git-core"),
  GIT_TEMPLATE_DIR: join(packagedGitRoot, "share", "git-core", "templates")
}
await run("packaged Git", [join(nativeDir, "bin", "git"), "--version"], root, gitEnvironment)
await run("packaged jj", [join(nativeDir, "bin", "jj"), "--version"])
const toolSmoke = mkdtempSync(join(nativeDir, ".git-jj-smoke-"))
try {
  const packagedGit = join(nativeDir, "bin", "git")
  const packagedJj = join(nativeDir, "bin", "jj")
  await run("packaged Git repository init", [packagedGit, "init", "--quiet"], toolSmoke, gitEnvironment)
  await run("packaged Git owner", [packagedGit, "config", "user.name", "Smithers Package Test"], toolSmoke, gitEnvironment)
  await run("packaged Git email", [packagedGit, "config", "user.email", "package-test@smithers.invalid"], toolSmoke, gitEnvironment)
  writeFileSync(join(toolSmoke, "README"), "packaged git and jj\n")
  await run("packaged Git add", [packagedGit, "add", "README"], toolSmoke, gitEnvironment)
  await run("packaged Git commit", [packagedGit, "commit", "--quiet", "-m", "package smoke"], toolSmoke, gitEnvironment)
  await run("packaged jj colocated init", [packagedJj, "git", "init", "--colocate"], toolSmoke, gitEnvironment)
  await run("packaged jj workspace read", [packagedJj, "log", "--no-graph", "-r", "@", "-T", "commit_id"], toolSmoke, gitEnvironment)
} finally {
  rmSync(toolSmoke, { recursive: true, force: true })
}

const ffiName = process.platform === "darwin"
  ? "libsmithers_ffi.dylib"
  : process.platform === "linux"
  ? "libsmithers_ffi.so"
  : "smithers_ffi.dll"
const ffi = join(cargoTargetDir, "release", ffiName)
if (!existsSync(ffi)) {
  throw new Error(`Rust build did not produce ${basename(ffi)}.`)
}
const jjExport = join(cargoTargetDir, "release", "smithers-jj-export")
if (!existsSync(jjExport)) {
  throw new Error("Rust build did not produce smithers-jj-export.")
}
cpSync(ffi, join(nativeDir, "bin", ffiName))
cpSync(jjExport, join(nativeDir, "bin", "smithers-jj-export"))
bundlePostgres(postgresBundle, join(nativeDir, "postgres"))

await run("web bundle", [pnpmBinary, "run", "build:web"], appDir, nodeEnvironment)
await run(
  cefMatrix ? "stable Electrobun CEF matrix package" : "stable Electrobun package",
  [pnpmBinary, "exec", "electrobun", "build", "--env=stable"],
  appDir,
  nodeEnvironment
)
