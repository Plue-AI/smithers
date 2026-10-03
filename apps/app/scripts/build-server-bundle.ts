import { createHash } from "node:crypto"
import { spawnSync } from "node:child_process"
import { chmodSync, closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { availableParallelism } from "node:os"
import { bundlePostgres } from "./bundle-postgres"
import { foreignLibraries } from "./system-linkage"
import { validateGitBundle } from "./validate-git-bundle"

export const JJ_REVISION = "47589ada70c12b3e829b5c98ab32503abad49eac"
const JJ_VERSION = `jj 0.44.0-${JJ_REVISION}`
// Immutable upstream downloads. Update these receipts when qualifying a release.
export const POSTGRES = {
  url: "https://github.com/PostgresApp/PostgresApp/releases/download/v2.9.6/Postgres-2.9.6-18.dmg",
  sha256: "9fc7d0dc08cf46dfd94bb32cbaaad81b41b37847a42d6dcb2f9fbd292813defb"
} as const


export const validateBuildSHA = (value: string | undefined): string => {
  if (typeof value !== "string" || !/^[0-9a-f]{40,64}$/.test(value)) throw new Error("Server bundle requires an exact SMITHERS_BUILD_SHA.")
  return value
}
export const validateNodeVersion = (value: string): void => {
  const match = /^v26\.(\d+)\.\d+$/.exec(value)
  if (match === null || Number(match[1]) < 4) throw new Error("SMITHERS_NODE_BINARY must name Node 26.4 or a later Node 26.")
}
export const validatePostgresVersion = (value: string): void => {
  if (!/^postgres \(PostgreSQL\) 18\.\d+(?:\.\d+)?(?: \(Postgres\.app\))?$/.test(value)) throw new Error(`The server bundle requires PostgreSQL 18; received ${JSON.stringify(value)}.`)
}
export const validateMsbVersion = (value: string, requiredVersion = "0.6.16"): void => {
  if (value !== `msb ${requiredVersion}`) throw new Error(`The server bundle requires msb ${requiredVersion}.`)
}
export interface BundleManifest {
  readonly version: 1
  readonly platform: "darwin-arm64"
  readonly revision: string
  readonly files: Record<string, { sha256: string; stage: string }>
}
const digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex")
const checksumFile = (path: string): string => digest(readFileSync(path))
const inside = (root: string, path: string): boolean => {
  const child = relative(root, path)
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)
}
const payloadFiles = (root: string): Array<string> => {
  const result: Array<string> = []
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const info = lstatSync(path)
      if (info.isDirectory()) visit(path)
      else if (info.isFile() || info.isSymbolicLink()) {
        if (path !== join(root, "manifest.json")) result.push(relative(root, path).split(sep).join("/"))
      } else throw new Error(`Unsupported bundle entry: ${path}`)
    }
  }
  visit(root)
  return result
}
const payloadHash = (root: string, path: string): string => {
  const full = join(root, path)
  if (!lstatSync(full).isSymbolicLink()) return checksumFile(full)
  const target = readlinkSync(full)
  if (isAbsolute(target) || !inside(root, resolve(dirname(full), target))) throw new Error(`Bundle symlink escapes: ${path}`)
  // realpath also rejects missing targets, indirect escapes and cycles.
  if (!inside(realpathSync(root), realpathSync(full))) throw new Error(`Bundle symlink escapes: ${path}`)
  return digest(target)
}
/** Publish regular files under ToolBuild's fail-closed output contract. */
export const materializeBundleFileLinks = (root: string): void => {
  for (const path of payloadFiles(root)) {
    const full = join(root, path)
    if (!lstatSync(full).isSymbolicLink()) continue
    payloadHash(root, path) // Refuse absolute, escaping, missing and cyclic links.
    const target = realpathSync(full)
    if (!statSync(target).isFile()) throw new Error(`Bundle link must target a regular file: ${path}`)
    rmSync(full)
    cpSync(target, full)
  }
}

export const createBundleManifest = (root: string, revision: string, stages: Readonly<Record<string, string>>): BundleManifest => {
  validateBuildSHA(revision)
  const files: BundleManifest["files"] = Object.create(null)
  for (const path of payloadFiles(root)) {
    let key = path
    while (!Object.hasOwn(stages, key) && key.includes("/")) key = key.slice(0, key.lastIndexOf("/"))
    const stage = stages[key]
    if (typeof stage !== "string" || stage.trim() === "") throw new Error(`Bundle file has no producing stage: ${path}`)
    files[path] = { sha256: payloadHash(root, path), stage }
  }
  return { version: 1, platform: "darwin-arm64", revision, files }
}
export const verifyBundleManifest = (root: string): void => {
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as BundleManifest
  if (manifest === null || manifest.version !== 1 || manifest.platform !== "darwin-arm64" || typeof manifest.files !== "object" || manifest.files === null || Array.isArray(manifest.files)) throw new Error("Invalid bundle manifest.")
  validateBuildSHA(manifest.revision)
  const actual = payloadFiles(root)
  const listed = Object.keys(manifest.files).sort()
  if (JSON.stringify(actual.slice().sort()) !== JSON.stringify(listed)) throw new Error("Bundle manifest file inventory differs from the payload.")
  for (const path of listed) {
    if (isAbsolute(path) || path.split("/").some((part) => part === ".." || part === "." || part === "")) throw new Error(`Unsafe manifest path: ${path}`)
    const entry = manifest.files[path]
    if (entry === null || typeof entry !== "object" || typeof entry.stage !== "string" || entry.stage.trim() === "" || typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) throw new Error(`Invalid manifest entry: ${path}`)
    if (entry.sha256 !== payloadHash(root, path)) throw new Error(`Bundle hash mismatch: ${path}`)
  }
}

export const compileServerLauncher = async (entry: string, outfile: string): Promise<void> => {
  const launcherDirectory = dirname(resolve(entry))
  const result = await Bun.build({
    entrypoints: [entry],
    compile: { target: "bun-darwin-arm64", outfile },
    plugins: [{
      name: "relocatable-server-launcher",
      setup(build) {
        build.onLoad({ filter: /(?:^|\/)(?:serve|NativeBackendProcess|server)\.ts$/ }, (args) => {
          if (dirname(resolve(args.path)) !== launcherDirectory) return undefined
          return {
            contents: readFileSync(args.path, "utf8").replaceAll("import.meta.dir", "require('node:path').dirname(process.execPath)"),
            loader: "ts",
          }
        })
      },
    }],
  })
  if (!result.success) throw new Error(`Server launcher compilation failed: ${result.logs.map(String).join("\n")}`)
}

const output = (argv: ReadonlyArray<string>, env = process.env): string => {
  const result = Bun.spawnSync([...argv], { stdout: "pipe", stderr: "pipe", env })
  if (result.exitCode !== 0) throw new Error(`${argv.join(" ")} failed: ${new TextDecoder().decode(result.stderr).trim()}`)
  return new TextDecoder().decode(result.stdout).trim()
}

export interface BundleCommandOptions {
  readonly cwd: string
  readonly env: Readonly<Record<string, string | undefined>>
  readonly diskRoot?: string
  readonly minimumFreeKiB?: number
  readonly kind?: "build" | "cleanup"
}
const assertBundleDiskSpace = (options: BundleCommandOptions): void => {
  if (options.kind !== "cleanup") {
    const disk = spawnSync("/bin/df", ["-k", options.diskRoot ?? options.cwd], { encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" })
    if (disk.error !== undefined || disk.status !== 0) throw new Error(`Server bundle build cannot inspect free disk: ${disk.error?.message ?? disk.stderr.trim()}`)
    const availableKiB = Number(disk.stdout.trim().split("\n").at(-1)?.split(/\s+/)[3])
    const requiredKiB = Math.max(8 * 1024 * 1024, options.minimumFreeKiB ?? 0)
    if (!Number.isFinite(availableKiB) || !Number.isFinite(requiredKiB) || availableKiB < requiredKiB) throw new Error(`Server bundle build requires at least ${requiredKiB / (1024 * 1024)} GiB of free disk.`)
  }
}

export const preparePostgresArm64 = (source: string, destination: string, options: BundleCommandOptions): void => {
  if (existsSync(destination)) throw new Error(`PostgreSQL preparation requires a new owned directory: ${destination}`)
  const tool = (argv: ReadonlyArray<string>): string => {
    assertBundleDiskSpace(options)
    const result = spawnSync(argv[0], argv.slice(1), { cwd: options.cwd, env: options.env, encoding: "utf8", timeout: 30_000, killSignal: "SIGKILL" })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(`${argv.join(" ")} failed: ${result.stderr.trim()}`)
    return result.stdout.trim()
  }
  assertBundleDiskSpace(options)
  let complete = false
  try {
    cpSync(source, destination, { recursive: true, dereference: true })
    // Postgres.app's optional PL/Python modules link an operator-installed
    // Python.framework. The install needs PostgreSQL, not that external language
    // runtime. Remove both plugins and extension declarations from our copy.
    const pythonExtensions = ["plpython3", "hstore_plpython3", "jsonb_plpython3", "ltree_plpython3"]
    for (const name of pythonExtensions) rmSync(join(destination, "lib", "postgresql", `${name}.dylib`), { force: true })
    const extensions = join(destination, "share", "postgresql", "extension")
    if (existsSync(extensions)) for (const name of readdirSync(extensions)) {
      if (pythonExtensions.some((extension) => name === `${extension}u.control` || name.startsWith(`${extension}u--`) && name.endsWith(".sql")))
        rmSync(join(extensions, name))
    }
    for (const file of payloadFiles(destination)) {
      const path = join(destination, file)
      const prefix = Buffer.alloc(4)
      const descriptor = openSync(path, "r")
      let length: number
      try { length = readSync(descriptor, prefix, 0, prefix.length, 0) } finally { closeSync(descriptor) }
      // Mach-O (32/64-bit, either byte order) and universal container headers.
      if (length !== 4 || ![0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf, 0xbfbafeca].includes(prefix.readUInt32BE(0))) continue
      if (!tool(["/usr/bin/file", "-b", path]).includes("Mach-O")) continue
      const architectures = tool(["/usr/bin/lipo", "-archs", path]).split(/\s+/)
      if (!architectures.includes("arm64")) throw new Error(`PostgreSQL Mach-O requires an arm64 slice: ${file} (${architectures.join(" ")}).`)
      if (architectures.length > 1) {
        const temporary = mkdtempSync(join(dirname(path), ".smithers-arm64-"))
        try {
          const thin = join(temporary, "thin")
          tool(["/usr/bin/lipo", path, "-thin", "arm64", "-output", thin])
          chmodSync(thin, statSync(path).mode & 0o777)
          renameSync(thin, path)
        } finally {
          rmSync(temporary, { recursive: true, force: true })
        }
      }
      // Postgres.app ICU libraries use bare install names. Resolve only a
      // sibling inside the staged distribution, never the developer's PATH.
      const identity = tool(["/usr/bin/otool", "-D", path]).split("\n").slice(1).map((line) => line.trim())
      let normalized = false
      for (const line of tool(["/usr/bin/otool", "-L", path]).split("\n").slice(1)) {
        const dependency = line.trim().split(" (compatibility version", 1)[0]
        if (!dependency || isAbsolute(dependency) || dependency.startsWith("@") || identity.includes(dependency)) continue
        const local = resolve(dirname(path), dependency)
        if (!inside(destination, local) || !existsSync(local)) throw new Error(`PostgreSQL local dependency is unavailable: ${dependency} (${file}).`)
        tool(["/usr/bin/install_name_tool", "-change", dependency, `@loader_path/${relative(dirname(path), local).split(sep).join("/")}`, path])
        normalized = true
      }
      if (normalized) tool(["/usr/bin/codesign", "--force", "--sign", "-", path])
    }
    complete = true
  } finally {
    if (!complete) rmSync(destination, { recursive: true, force: true })
  }
}

export const runBundleCommand = async (label: string, argv: ReadonlyArray<string>, options: BundleCommandOptions): Promise<void> => {
  assertBundleDiskSpace(options)
  console.log(`[build-server-bundle] ${label}: ${argv.join(" ")}`)
  const child = Bun.spawn([...argv], { cwd: options.cwd, env: options.env, stdin: "inherit", stdout: "inherit", stderr: "inherit" })
  const code = await child.exited
  if (code !== 0) throw new Error(`${label} failed with exit code ${code}.`)
}

export const copyGitCoreResources = (source: string, destination: string): void => {
  mkdirSync(dirname(destination), { recursive: true })
  cpSync(source, destination, { recursive: true, dereference: false, verbatimSymlinks: true })
  // Xcode links these optional commands into git-core; the bundle ships bin/git.
  for (const command of ["git-shell", "scalar"]) rmSync(join(destination, command), { force: true })
}

export const bundleBuildEnvironment = (
  work: string,
  nodeBinary: string,
  root: string,
  revision: string,
  inherited: Readonly<Record<string, string | undefined>> = process.env,
): Record<string, string | undefined> => ({
  ...inherited,
  PATH: `${dirname(nodeBinary)}${delimiter}${inherited.PATH ?? ""}`,
  SMITHERS_BUILD_SHA: revision,
  CARGO_TARGET_DIR: join(work, "cargo-target"),
  CARGO_BUILD_JOBS: inherited.CARGO_BUILD_JOBS ?? String(availableParallelism()),
  GOCACHE: inherited.GOCACHE ?? join(work, "go-build"),
  GIT_CEILING_DIRECTORIES: inherited.HOME ?? root,
  GOMAXPROCS: inherited.GOMAXPROCS ?? String(availableParallelism()),
})

export const webBundleCommand = (pnpm: string, bundle: string): string[] => [pnpm, "run", "build:web", "--outDir", join(bundle, "views", "mainview")]

export const buildServerBundle = async (): Promise<void> => {
  const appDir = resolve(import.meta.dir, "..")
  const root = resolve(appDir, "..", "..")
  const revision = validateBuildSHA(process.env.SMITHERS_BUILD_SHA)
  if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("The server bundle must be built on darwin-arm64.")
  const configuredNode = process.env.SMITHERS_NODE_BINARY
  const discoveredNode = configuredNode ? isAbsolute(configuredNode) ? configuredNode : Bun.which(configuredNode) : Bun.which("node")
  if (!discoveredNode) throw new Error("SMITHERS_NODE_BINARY must name a build-time Node 26.4+ executable.")
  const nodeBinary = realpathSync(discoveredNode)
  validateNodeVersion(output([nodeBinary, "--version"]))
  const foreignNode = foreignLibraries(nodeBinary)
  if (foreignNode.length > 0) throw new Error(`SMITHERS_NODE_BINARY must link only macOS system libraries: ${nodeBinary} loads ${foreignNode.join(", ")}`)
  const pnpmPin = (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager: string }).packageManager
  const pnpmBinary = existsSync(join(dirname(nodeBinary), "pnpm")) ? join(dirname(nodeBinary), "pnpm") : Bun.which("pnpm")
  if (!pnpmBinary || (statSync(pnpmBinary).mode & 0o111) === 0 || `pnpm@${output([pnpmBinary, "--version"])}` !== pnpmPin) throw new Error(`The server bundle needs ${pnpmPin}.`)
  const nodeLicense = join(dirname(dirname(nodeBinary)), "LICENSE")
  if (!existsSync(nodeLicense)) throw new Error(`Node license is unavailable: ${nodeLicense}`)
  const withoutGitOverrides = Object.fromEntries(Object.entries(process.env).filter(([name]) => name !== "GIT_EXEC_PATH" && name !== "GIT_TEMPLATE_DIR"))
  const gitBinary = realpathSync(output(["/usr/bin/xcrun", "--find", "git"], withoutGitOverrides))
  const gitVersion = output([gitBinary, "--version"], withoutGitOverrides)
  if (!/^git version \d+\.\d+/.test(gitVersion)) throw new Error("Git returned an invalid version.")
  const gitExecSource = realpathSync(output([gitBinary, "--exec-path"], withoutGitOverrides))
  const gitShareSource = join(resolve(gitExecSource, "..", ".."), "share", "git-core")
  if (!existsSync(gitShareSource)) throw new Error(`Git resources are unavailable: ${gitShareSource}`)
  const bundle = join(appDir, ".server-bundle")
  const work = join(bundle, ".build")
  mkdirSync(work, { recursive: true })
  const stages: Record<string, string> = {}
  const run = (label: string, argv: ReadonlyArray<string>, cwd = root, extraEnv: Readonly<Record<string, string>> = {}, kind: "build" | "cleanup" = "build"): Promise<void> => {
    return runBundleCommand(label, argv, { cwd, diskRoot: root, kind, env: { ...bundleBuildEnvironment(work, nodeBinary, root, revision), ...extraEnv } })
  }
  const copy = (source: string, destination: string, stage: string, dereference = true): void => {
    mkdirSync(dirname(join(bundle, destination)), { recursive: true })
    cpSync(source, join(bundle, destination), { recursive: true, dereference, verbatimSymlinks: !dereference })
    stages[destination] = stage
  }
  const download = async (url: string, sha256: string, destination: string): Promise<void> => {
    if (!existsSync(destination)) await run("pinned download", ["/usr/bin/curl", "--fail", "--location", "--retry", "3", "--output", destination, url])
    if (checksumFile(destination) !== sha256) throw new Error(`Pinned download SHA-256 mismatch: ${url}`)
  }
  try {
    // Keep only a verified revision-keyed jj binary between rebuilds. Cargo's
    // intermediate tree is workspace-local and removed before the manifest.
    const cachedJj = join(bundle, "bin", "jj")
    let reuseJj = false
    for (const candidate of [cachedJj, join(bundle, "cache", `jj-${JJ_REVISION}`)]) {
      try {
        if (existsSync(candidate) && output([candidate, "--version"]) === JJ_VERSION) {
          cpSync(candidate, join(work, `jj-${JJ_REVISION}`))
          reuseJj = true
          break
        }
      } catch { /* A corrupt/stale cached executable is a cache miss. */ }
    }

    for (const name of readdirSync(bundle)) if (name !== ".build") rmSync(join(bundle, name), { recursive: true, force: true })
    mkdirSync(join(bundle, "bin"), { recursive: true })
    const wasm = join(root, "packages", "smithers", "flows", "jj", "wasm", "flows_jj.wasm")
    if (!existsSync(wasm) || statSync(wasm).size === 0) throw new Error("The canonical flows_jj.wasm artifact is missing.")
    await run("pinned Rust toolchain", ["rustup", "toolchain", "install"])
    await run("native FFI", ["cargo", "build", "--locked", "--release", "--package", "smithers-ffi"])
    if (!reuseJj) await run("pinned jj CLI", ["cargo", "install", "--locked", "--git", "https://github.com/smithersai/jj.git", "--rev", JJ_REVISION, "--root", join(work, "jj-install"), "jj-cli"], root, { NIX_JJ_GIT_HASH: JJ_REVISION })
    const installedJj = reuseJj ? join(work, `jj-${JJ_REVISION}`) : join(work, "jj-install", "bin", "jj")
    if (output([installedJj, "--version"]) !== JJ_VERSION) throw new Error(`Server bundles require ${JJ_VERSION}.`)
    copy(installedJj, "bin/jj", "jj")
    await run("Go backend", ["sh", "scripts/build-backend.sh", join(bundle, "bin", "smithers-backend"), revision])
    stages["bin/smithers-backend"] = "backend"
    const codingHost = join(bundle, "bin", "smithers-coding-host")
    await run("canonical coding host", [nodeBinary, "flows/coding/build.mjs", codingHost])
    stages["bin/smithers-coding-host"] = "coding-host"
    const modelHost = join(bundle, "bin", "smithers-model-host")
    await run("canonical model host", [nodeBinary, "apps/model-host/build.mjs", modelHost])
    stages["bin/smithers-model-host"] = "model-host"
    stages["bin/smithers-model-host.sha256"] = "model-host"
    if (readFileSync(`${modelHost}.sha256`, "utf8") !== `${checksumFile(modelHost)}  ${basename(modelHost)}\n`) throw new Error("Packaged model host checksum is invalid.")
    // All helper dependencies are Rust. The pinned Rust distribution supplies
    // both the Linux musl sysroot and the host rust-lld cross linker.
    await run("Linux Rust standard library", ["rustup", "target", "add", "aarch64-unknown-linux-musl"])
    const rustSysroot = output(["rustc", "--print", "sysroot"])
    const linuxLinker = join(rustSysroot, "lib", "rustlib", "aarch64-apple-darwin", "bin", "rust-lld")
    if (!existsSync(linuxLinker)) throw new Error("Pinned Rust toolchain is missing rust-lld.")
    await run("Linux arm64 helper", ["cargo", "build", "--locked", "--release", "--package", "smithers-ffi", "--bin", "smithers-jj-export", "--target", "aarch64-unknown-linux-musl"], root, {
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER: linuxLinker,
      CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_RUSTFLAGS: "-C linker-flavor=ld.lld -C target-feature=+crt-static"
    })
    copy(join(work, "cargo-target", "aarch64-unknown-linux-musl", "release", "smithers-jj-export"), "bin/linux-arm64/smithers-jj-export", "linux-arm64-helper")
    await run("Flow host manifest", [nodeBinary, "distribution/flow-host-manifest.mjs", join(bundle, "bin", "flow-hosts.json"), codingHost, join(bundle, "bin", "linux-arm64", "smithers-jj-export")])
    stages["bin/flow-hosts.json"] = "flow-host-manifest"
    stages["bin/smithers-coding-host.sha256"] = "flow-host-manifest"
    stages["bin/linux-arm64/smithers-jj-export.sha256"] = "flow-host-manifest"
    copy(nodeBinary, "bin/node", "node-runtime")
    copy(nodeLicense, "licenses/node-LICENSE", "node-runtime")
    copy(join(root, "distribution", "licenses", "jj-LICENSE"), "licenses/jj-LICENSE", "jj")
    copy(join(root, "distribution", "licenses", "git-COPYING"), "licenses/git-COPYING", "git")
    await run("packaged coding host", [join(bundle, "bin", "node"), codingHost, "--help"])
    await run("packaged model host", [join(bundle, "bin", "node"), modelHost, "--help"])
    copy(gitBinary, "bin/git", "git")
    copyGitCoreResources(gitExecSource, join(bundle, "libexec", "git-core"))
    stages["libexec/git-core"] = "git"
    copy(gitShareSource, "share/git-core", "git", false)
    validateGitBundle(bundle, [join(bundle, "bin", "git"), join(bundle, "libexec", "git-core"), join(bundle, "share", "git-core")])
    writeFileSync(join(bundle, "share", "build-tools.json"), `${JSON.stringify({ revision, git: gitVersion, jj: JJ_VERSION, jjRevision: JJ_REVISION, linuxHelperRevision: revision }, null, 2)}\n`)
    stages["share/build-tools.json"] = "git-jj-smoke"
    const gitEnv = { GIT_EXEC_PATH: join(bundle, "libexec", "git-core"), GIT_TEMPLATE_DIR: join(bundle, "share", "git-core", "templates") }
    const smoke = join(work, "git-jj-smoke")
    mkdirSync(smoke, { recursive: true })
    await run("packaged Git repository init", [join(bundle, "bin", "git"), "init", "--quiet"], smoke, gitEnv)
    await run("packaged Git owner", [join(bundle, "bin", "git"), "config", "user.name", "Smithers Package Test"], smoke, gitEnv)
    await run("packaged Git email", [join(bundle, "bin", "git"), "config", "user.email", "package-test@smithers.invalid"], smoke, gitEnv)
    writeFileSync(join(smoke, "README"), "packaged git and jj\n")
    await run("packaged Git add", [join(bundle, "bin", "git"), "add", "README"], smoke, gitEnv)
    await run("packaged Git commit", [join(bundle, "bin", "git"), "commit", "--quiet", "-m", "package smoke"], smoke, gitEnv)
    await run("packaged jj colocated init", [join(bundle, "bin", "jj"), "git", "init", "--colocate"], smoke, gitEnv)
    await run("packaged jj workspace read", [join(bundle, "bin", "jj"), "log", "--no-graph", "-r", "@", "-T", "commit_id"], smoke, gitEnv)
    copy(join(work, "cargo-target", "release", "libsmithers_ffi.dylib"), "bin/libsmithers_ffi.dylib", "native-ffi")
    copy(join(work, "cargo-target", "release", "smithers-jj-export"), "bin/smithers-jj-export", "native-ffi")
    const msbEntry = Bun.resolveSync("microsandbox", join(root, "packages", "smithers", "flows"))
    const msbPackage = dirname(Bun.resolveSync("@superradcompany/microsandbox-darwin-arm64/package.json", dirname(msbEntry)))
    const requiredVersion = /const RequiredVersion = "([^"]+)"/.exec(readFileSync(join(root, "packages", "backend", "microsandbox", "cli.go"), "utf8"))?.[1]
    if (requiredVersion !== "0.6.16") throw new Error("The assembler's Microsandbox pin differs from the backend's RequiredVersion.")
    validateMsbVersion(output([join(msbPackage, "bin", "msb"), "--version"]), requiredVersion)
    copy(join(msbPackage, "bin", "msb"), "bin/msb", "microsandbox")
    copy(join(msbPackage, "lib", "libkrunfw.5.dylib"), "lib/libkrunfw.5.dylib", "microsandbox")
    copy(join(root, "packages", "backend", "microsandbox", "guest", "smithers-guest.py"), "share/microsandbox/smithers-guest.py", "guest-helper")
    const image = /const DefaultImage = "([^"]+)"/.exec(readFileSync(join(root, "packages", "backend", "microsandbox", "runtime.go"), "utf8"))?.[1]
    if (!image || !/@sha256:[0-9a-f]{64}$/.test(image)) throw new Error("The guest base image must be digest-pinned.")
    const imageArchive = join(bundle, "share", "microsandbox", "base-image.oci.tar")
    const imageEnv = { HOME: join(work, "image-home"), MSB_BACKEND: "local" }
    mkdirSync(imageEnv.HOME, { recursive: true })
    await run("pinned guest image", [join(bundle, "bin", "msb"), "image", "pull", image], root, imageEnv)
    await run("guest OCI archive", [join(bundle, "bin", "msb"), "image", "save", "--format", "oci", "--output", imageArchive, image], root, imageEnv)
    stages["share/microsandbox/base-image.oci.tar"] = "guest-image"
    writeFileSync(join(bundle, "share", "microsandbox", "base-image.json"), `${JSON.stringify({ image, archive: "base-image.oci.tar", sha256: checksumFile(imageArchive) })}\n`)
    stages["share/microsandbox/base-image.json"] = "guest-image"
    const postgresImage = join(work, "postgres.dmg")
    await download(POSTGRES.url, POSTGRES.sha256, postgresImage)
    const mount = join(work, "postgres-mount")
    mkdirSync(mount, { recursive: true })
    await run("PostgreSQL 18 distribution", ["/usr/bin/hdiutil", "attach", "-readonly", "-nobrowse", "-mountpoint", mount, postgresImage])
    try {
      const postgres = join(mount, "Postgres.app", "Contents", "Versions", "18")
      validatePostgresVersion(output([join(postgres, "bin", "postgres"), "--version"]))
      const preparedPostgres = join(work, "postgres-arm64")
      preparePostgresArm64(postgres, preparedPostgres, { cwd: root, diskRoot: root, env: bundleBuildEnvironment(work, nodeBinary, root, revision) })
      bundlePostgres(preparedPostgres, join(bundle, "postgres"))
      // bundlePostgres relocates all dependencies before flattening its source
      // prefix. Publish a stable payload path rather than its synthetic mount
      // hierarchy, which can contain the build user's home directory.
      const pgRoot = join(bundle, "postgres")
      const pgManifest = JSON.parse(readFileSync(join(pgRoot, "bundle.json"), "utf8")) as { bin: string }
      renameSync(dirname(join(pgRoot, pgManifest.bin)), join(pgRoot, "runtime"))
      rmSync(join(pgRoot, "root"), { recursive: true, force: true })
      writeFileSync(join(pgRoot, "bundle.json"), `${JSON.stringify({ version: 1, bin: "runtime/bin" })}\n`)
      stages.postgres = "postgres"
    } finally {
      // Detaching releases an owned resource even when a build-stage disk
      // preflight can no longer succeed; it still reports command failures.
      await run("detach PostgreSQL distribution", ["/usr/bin/hdiutil", "detach", mount], root, {}, "cleanup")
    }
    await run("web bundle", webBundleCommand(pnpmBinary, bundle), appDir)
    if (!existsSync(join(bundle, "views", "mainview", "index.html"))) throw new Error("Web bundle did not produce index.html.")
    stages["views/mainview"] = "web"
    // The existing launcher resolves ../bin, ../postgres and ../views/mainview.
    // Replace Bun's virtual compile directory with the executable's runtime
    // directory, so moving the prefix never retains a build-machine path.
    await compileServerLauncher(join(appDir, "src/bun/serve.ts"), join(bundle, "bin", "smithers-server"))
    stages["bin/smithers-server"] = "launcher"
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
  materializeBundleFileLinks(bundle)
  writeFileSync(join(bundle, "manifest.json"), `${JSON.stringify(createBundleManifest(bundle, revision, stages), null, 2)}\n`)
  verifyBundleManifest(bundle)
  console.log(`[build-server-bundle] complete: ${bundle}`)
}

if (import.meta.main) await buildServerBundle()
