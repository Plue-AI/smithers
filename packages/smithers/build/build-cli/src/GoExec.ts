/**
 * Go-specific planning kept out of the package executor's dispatch switch.
 *
 * @since 0.1.0
 */

import type * as Go from "@smthrs/targets/Go"
import * as Input from "@smthrs/targets/Input"
import * as Target from "@smthrs/targets/Target"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as NodeChildProcess from "node:child_process"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as Path from "./internal/Path.ts"
import * as Text from "./internal/Text.ts"
import type * as NixExec from "./NixExec.ts"
import * as PackageTree from "./PackageTree.ts"
import * as StampExec from "./StampExec.ts"

/**
 * Where one Go rule is being planned: the workspace root, the declaring
 * package, and the workspace declaration whose toolchain shapes the build.
 *
 * @category models
 * @since 0.1.0
 */
export interface Context {
  readonly root: string
  /** Cancels planning subprocesses when the run stops. */
  readonly signal?: AbortSignal | undefined
  /** Per-probe override in milliseconds; go list defaults to 60000, Nix to 300000. */
  readonly timeoutMs?: number | undefined
  readonly packagePath: string
  readonly workspace: WorkspaceDeclaration.WorkspaceDeclaration
  /** The target environment used to select the executable and switched SDK. */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** The workspace's resolved Nix environment, when it declares one. */
  readonly nix?: NixExec.ResolvedEnvironment | undefined
}

/**
 * The result of planning one Go rule: either a refusal, or the argv, the
 * environment, the outputs, and the key material the executor needs.
 *
 * @category models
 * @since 0.1.0
 */
export interface Planned {
  readonly refusal?: string
  readonly argv?: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly outDirs: ReadonlyArray<string>
  readonly writeSet: ReadonlyArray<string>
  /**
   * The workspace-relative files the spawned toolchain reads: the module
   * authority (`go.mod`, `go.sum`) plus every compiler input `go list`
   * reports for the selected packages.
   *
   * A `Go.*` rule names its work with import patterns, not with `S.file`
   * declarations, so the target has no declared inputs and the confinement
   * would otherwise hide the module from its own compiler. The read set is
   * the same closure the key is computed over, which keeps "what the sandbox
   * admits" and "what the key covers" one answer rather than two.
   */
  readonly readSet: ReadonlyArray<string>
  readonly closureIdentity?: unknown
}

const toolchain = (workspace: WorkspaceDeclaration.WorkspaceDeclaration): Go.ToolchainDeclaration | undefined =>
  workspace.toolchains?.find((entry): entry is Go.ToolchainDeclaration => entry._tag === "GoToolchain")

/**
 * The workspace-relative module authority every `go` invocation opens before
 * it can resolve a single import path: the declared `go.mod` and `go.sum`.
 *
 * The toolchain declares them on the workspace, not on the target, so they
 * never reach a target's declared inputs and a confined `go` would answer
 * "go.mod file not found in current directory or any parent directory".
 */
const moduleFiles = (context: Context): ReadonlyArray<string> => {
  const declaration = toolchain(context.workspace)
  if (declaration === undefined) return []
  return [declaration.mod, declaration.sum].map((input) => Input.resolvePath("", input.path))
}

const moduleDirectory = (context: Context): string => {
  const declaration = toolchain(context.workspace)
  if (declaration === undefined) return context.root
  const mod = Input.resolvePath("", declaration.mod.path)
  return NodePath.join(context.root, NodePath.dirname(mod))
}

/**
 * The host environment a plan-time `go` or `nix` runs under.
 *
 * The planner hands down an environment it has already stripped of the
 * workspace's remote-cache credential names. Falling back to `process.env`
 * *underneath* that record put every one of those names back, so `go env`,
 * `go list` and `nix develop` -- all of which run workspace-controlled
 * configuration -- read credentials the same spawn is supposed to withhold.
 * A caller that supplies no environment is not the CLI, and still inherits the
 * process environment.
 */
const hostEnvironment = (context: Context): Record<string, string> => {
  const source = context.environment ?? process.env
  const env: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) if (typeof value === "string") env[name] = value
  return env
}

const execFile = (
  file: string,
  args: ReadonlyArray<string>,
  cwd: string,
  env: Readonly<Record<string, string>>,
  options: { readonly signal?: AbortSignal | undefined; readonly timeoutMs: number }
): Promise<string> =>
  new Promise((resolve, reject) => {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      reject(new RangeError("Go probe timeoutMs must be positive and finite"))
      return
    }
    NodeChildProcess.execFile(
      file,
      [...args],
      { cwd, maxBuffer: 256 * 1024 * 1024, env: { ...env }, signal: options.signal, timeout: options.timeoutMs },
      (error, stdout, stderr) => {
        if (error !== null) {
          const detail = error.killed && typeof error.code !== "string"
            ? `timed out after ${options.timeoutMs}ms`
            : stderr || error.message
          reject(new Error(`${file} ${args.join(" ")} failed: ${detail}`))
        } else resolve(stdout)
      }
    )
  })

/**
 * Locates the host `go` toolchain and describes it as key material, or refuses
 * with the reason the target cannot run.
 *
 * @category planning
 * @since 0.1.0
 */
export const resolveGo = async (context: Context): Promise<
  | {
    readonly ok: true
    readonly path: string
    readonly identity: unknown
    readonly executables: ReadonlyArray<string>
    /** The selected SDK's `GOROOT`, which the compiler reads far beyond its `bin`. */
    readonly sdkRoot: string
  }
  | { readonly ok: false; readonly refusal: string; readonly identity: unknown }
> => {
  const path = PackageTree.findOnPath("go", context.environment)
  if (path === undefined) {
    return { ok: false, refusal: "host binary \"go\" is not present on PATH", identity: { tag: "GoBin", absent: true } }
  }
  const cwd = moduleDirectory(context)
  // `go --version` is a usage error; `go version` is the subcommand that
  // reports the toolchain GOTOOLCHAIN actually switched to for this module,
  // which is the resolved version the key must record.
  const env = { ...hostEnvironment(context), ...toolchainEnvironment(context), ...context.environment }
  const probe = await PackageTree.probeVersion(path, { cwd, args: ["version"], environment: env })
  // GOTOOLCHAIN can dispatch through an unchanged launcher to a different
  // SDK. Its version string does not identify compiler or linker bytes.
  const selected = await PackageTree.probeVersion(path, {
    cwd,
    args: ["env", "-json", "GOROOT", "GOTOOLDIR"],
    environment: env
  })
  let sdk: { readonly GOROOT?: unknown; readonly GOTOOLDIR?: unknown }
  try {
    sdk = JSON.parse(selected.output)
    if (selected.exitCode !== 0 || typeof sdk.GOROOT !== "string" || typeof sdk.GOTOOLDIR !== "string") {
      throw new Error("go env did not identify its SDK")
    }
  } catch {
    return {
      ok: false,
      refusal: "go env could not identify GOROOT and GOTOOLDIR",
      identity: { tag: "GoBin", path, probe, selected }
    }
  }
  const executables = [path]
  for (const directory of [NodePath.join(String(sdk.GOROOT), "bin"), String(sdk.GOTOOLDIR)]) {
    for (
      const entry of (await Fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))
    ) {
      if (entry.isFile() || entry.isSymbolicLink()) executables.push(NodePath.join(directory, entry.name))
    }
  }
  const declaration = toolchain(context.workspace)
  const authorities: Array<unknown> = []
  if (declaration !== undefined) {
    for (const input of [declaration.mod, declaration.sum]) {
      const relative = Input.resolvePath("", input.path)
      authorities.push({
        path: relative,
        digest: await Input.digestFile(NodePath.join(context.root, relative), { workspaceRoot: context.root })
      })
    }
    const versions = declaration.versions as unknown as {
      readonly config?: Input.File
      readonly flake?: Input.File
      readonly lock?: Input.File
    }
    for (const input of [versions.config, versions.flake, versions.lock]) {
      if (input === undefined) continue
      const relative = Input.resolvePath("", input.path)
      authorities.push({
        path: relative,
        digest: await Input.digestFile(NodePath.join(context.root, relative), { workspaceRoot: context.root })
      })
    }
  }
  return {
    ok: true,
    path,
    executables,
    sdkRoot: String(sdk.GOROOT),
    identity: { tag: "GoBin", path, cwd: NodePath.relative(context.root, cwd), probe, authorities }
  }
}

/**
 * Locates `nix` and the declared dev shell, returning either the resolved
 * interpreter path plus its key material or the reason it is unavailable.
 *
 * @category planning
 * @since 0.1.0
 */
export const resolveNix = async (name: string, context: Context): Promise<
  | { readonly ok: true; readonly path: string; readonly identity: unknown }
  | { readonly ok: false; readonly refusal: string; readonly identity: unknown }
> => {
  // A resolved environment answers from its own PATH: no `nix develop` per
  // tool, and the closure's store hash is the identity every reference keys on.
  if (context.nix !== undefined) {
    const path = PackageTree.findOnPath(name, { PATH: context.nix.path.join(NodePath.delimiter) })
    const authority = { closure: context.nix.hash, inputs: context.nix.inputs }
    return path === undefined
      ? {
        ok: false,
        refusal: `the declared Nix environment provides no ${JSON.stringify(name)}`,
        identity: { tag: "NixBin", name, absent: true, authority }
      }
      : { ok: true, path, identity: { tag: "NixBin", name, path, authority } }
  }
  const nix = PackageTree.findOnPath("nix", context.environment)
  const declaration = context.workspace.toolchains?.find((entry) => entry._tag === "NixDevShell") as
    | { readonly flake: Input.File; readonly lock: Input.File }
    | undefined
  const authority: Array<unknown> = []
  for (const input of [declaration?.flake, declaration?.lock]) {
    if (input === undefined) continue
    const relative = Input.resolvePath("", input.path)
    authority.push({
      path: relative,
      digest: await Input.digestFile(NodePath.join(context.root, relative), { workspaceRoot: context.root })
    })
  }
  if (nix === undefined) {
    return {
      ok: false,
      refusal: `host binary "nix" is not present on PATH (required by S.Nix.bin(${JSON.stringify(name)}))`,
      identity: { tag: "NixBin", name, absent: true, authority }
    }
  }
  try {
    const path = (await execFile(nix, ["develop", "--command", "which", name], context.root, hostEnvironment(context), {
      signal: context.signal,
      timeoutMs: context.timeoutMs ?? 300_000
    }))
      .trim()
    if (path === "") throw new Error("which returned no path")
    return { ok: true, path, identity: { tag: "NixBin", name, nix, path, authority } }
  } catch (cause) {
    return {
      ok: false,
      refusal: `Nix dev shell does not provide ${JSON.stringify(name)}: ${String(cause)}`,
      identity: { tag: "NixBin", name, nix, authority }
    }
  }
}

const anchor = (pattern: string, packagePath: string): string => {
  if (pattern.startsWith("//")) return `./${pattern.slice(2)}`
  if (!pattern.startsWith("./") || packagePath === "") return pattern
  return `./${[packagePath, pattern.slice(2)].filter(Boolean).join("/")}`
}

const targetOf = (value: unknown): Target.AnyTarget | undefined => {
  if (Target.isTarget(value)) return value
  if (typeof value === "object" && value !== null && (value as { readonly _tag?: unknown })._tag === "TargetFiles") {
    const candidate = (value as { readonly target?: unknown }).target
    return Target.isTarget(candidate) ? candidate : undefined
  }
  return undefined
}

const patternsOf = (value: unknown, context: Context): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.map((entry) => anchor(String(entry), context.packagePath))
  const target = targetOf(value)
  if (target !== undefined && Target.metadata(target).target === "Go.Packages") {
    const source = Target.metadata(target).sourceFile
    const ownPath = source === undefined
      ? context.packagePath
      : NodePath.relative(context.root, NodePath.dirname(source)).split(NodePath.sep).join("/")
    return (Target.metadata(target).attrs as { readonly pkgs: ReadonlyArray<string> }).pkgs.map((entry) =>
      anchor(entry, ownPath)
    )
  }
  return []
}

interface GoListRow {
  readonly ImportPath?: string
  readonly Dir?: string
  readonly Standard?: boolean
  readonly Module?: {
    readonly Path?: string
    readonly Dir?: string
    readonly Replace?: { readonly Path?: string; readonly Dir?: string }
  }
  readonly GoFiles?: ReadonlyArray<string>
  readonly CgoFiles?: ReadonlyArray<string>
  readonly TestGoFiles?: ReadonlyArray<string>
  readonly XTestGoFiles?: ReadonlyArray<string>
  readonly EmbedFiles?: ReadonlyArray<string>
  readonly TestEmbedFiles?: ReadonlyArray<string>
  readonly XTestEmbedFiles?: ReadonlyArray<string>
  readonly CFiles?: ReadonlyArray<string>
  readonly CXXFiles?: ReadonlyArray<string>
  readonly MFiles?: ReadonlyArray<string>
  readonly HFiles?: ReadonlyArray<string>
  readonly FFiles?: ReadonlyArray<string>
  readonly SFiles?: ReadonlyArray<string>
  readonly SwigFiles?: ReadonlyArray<string>
  readonly SwigCXXFiles?: ReadonlyArray<string>
  readonly SysoFiles?: ReadonlyArray<string>
}

/**
 * Every collection `go list -json` reports that the compiler reads.
 *
 * The union used to stop at the Go and embed files, so editing a `.c`, `.h`,
 * or `.s` file consumed by cgo, or swapping a prebuilt `.syso`, left the
 * target key unchanged and the cache served a binary built from the previous
 * sources. Every compiler input `go list` names belongs in the key.
 */
const compilerInputCollections = [
  "GoFiles",
  "CgoFiles",
  "TestGoFiles",
  "XTestGoFiles",
  "EmbedFiles",
  "TestEmbedFiles",
  "XTestEmbedFiles",
  "CFiles",
  "CXXFiles",
  "MFiles",
  "HFiles",
  "FFiles",
  "SFiles",
  "SwigFiles",
  "SwigCXXFiles",
  "SysoFiles"
] as const satisfies ReadonlyArray<keyof GoListRow>

const jsonRows = (text: string): ReadonlyArray<GoListRow> => {
  const rows: Array<GoListRow> = []
  let start = -1, depth = 0, string = false, escape = false
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!
    if (string) {
      if (escape) escape = false
      else if (ch === "\\") escape = true
      else if (ch === "\"") string = false
      continue
    }
    if (ch === "\"") string = true
    else if (ch === "{") { if (depth++ === 0) start = index }
    else if (ch === "}" && --depth === 0 && start >= 0) {
      rows.push(JSON.parse(text.slice(start, index + 1)))
      start = -1
    }
  }
  return rows
}

const listed = async (
  goPath: string,
  cwd: string,
  patterns: ReadonlyArray<string>,
  deps: boolean,
  env: Readonly<Record<string, string>>,
  context: Context,
  tests = false
): Promise<ReadonlyArray<GoListRow>> =>
  jsonRows(
    await execFile(
      goPath,
      ["list", ...(deps ? ["-deps"] : []), ...(tests ? ["-test"] : []), "-json", ...patterns],
      cwd,
      env,
      { signal: context.signal, timeoutMs: context.timeoutMs ?? 60_000 }
    )
  )

const selectedPackages = async (
  selection: unknown,
  context: Context,
  goPath: string,
  env: Readonly<Record<string, string>>
): Promise<ReadonlyArray<string>> => {
  if (
    typeof selection === "object" && selection !== null &&
    (selection as { readonly _tag?: unknown })._tag === "FilesDifference"
  ) {
    const difference = selection as { readonly left: unknown; readonly right: unknown }
    const left = await listed(
      goPath,
      moduleDirectory(context),
      patternsOf(difference.left, context),
      false,
      env,
      context
    )
    const right = new Set(
      (await listed(goPath, moduleDirectory(context), patternsOf(difference.right, context), false, env, context)).map((
        row
      ) => row.ImportPath)
    )
    return left.flatMap((row) => row.ImportPath !== undefined && !right.has(row.ImportPath) ? [row.ImportPath] : [])
  }
  const patterns = patternsOf(selection, context)
  const rows = await listed(goPath, moduleDirectory(context), patterns, false, env, context)
  return rows.flatMap((row) => row.ImportPath === undefined ? [] : [row.ImportPath])
}

/**
 * One package selection's key material plus the workspace-relative files it
 * was computed over.
 *
 * @category models
 * @since 0.1.0
 */
export interface Closure {
  /** The value the target key records for this selection. */
  readonly identity: unknown
  /** Workspace-relative paths of the compiler inputs that live in the tree. */
  readonly files: ReadonlyArray<string>
}

const closure = async (
  packages: ReadonlyArray<string>,
  context: Context,
  goPath: string,
  env: Readonly<Record<string, string>>,
  tests = false
): Promise<Closure> => {
  // Test variants add imports that only internal or external _test.go files use.
  const rows = await listed(goPath, moduleDirectory(context), packages, true, env, context, tests)
  // Key → absolute path. In-workspace files key on their workspace-relative
  // path. A module a `replace` directive points at a local directory outside
  // the workspace is neither pinned by go.sum nor covered by that path, so its
  // files key on the replacement's module path and their position inside it —
  // stable across machines, unlike the absolute directory itself. The standard
  // library and the module cache stay out: the toolchain identity and go.sum
  // already pin them.
  const files = new Map<string, string>()
  for (const row of rows) {
    if (row.Dir === undefined || row.Standard === true) continue
    const replacementDir = row.Module?.Replace?.Dir
    const replacementPath = row.Module?.Replace?.Path ?? row.Module?.Path
    for (const collection of compilerInputCollections) {
      for (const name of row[collection] ?? []) {
        // The generated test main uses an absolute path in Go's build cache.
        const absolute = NodePath.resolve(row.Dir, name)
        const inside = Path.containedRelative(context.root, absolute)
        if (inside !== undefined && inside !== "") {
          files.set(Text.posix(inside), absolute)
          continue
        }
        if (replacementDir === undefined || replacementPath === undefined) continue
        const withinReplacement = Path.containedRelative(replacementDir, absolute)
        if (withinReplacement === undefined || withinReplacement === "") continue
        files.set(`replace:${replacementPath}/${Text.posix(withinReplacement)}`, absolute)
      }
    }
  }
  const digests: Array<readonly [string, string]> = []
  // A `replace:` key names a module directory outside the workspace, so only
  // the in-tree spelling is a path the confinement can admit.
  const inTree: Array<string> = []
  for (const key of [...files.keys()].sort(Text.byCodeUnit)) {
    const bytes = await Fs.readFile(files.get(key)!)
    digests.push([key, Text.sha256Hex(bytes)])
    if (!key.startsWith("replace:")) inTree.push(key)
  }
  return { identity: { packages: [...packages].sort(), files: digests }, files: inTree }
}

/**
 * The environment facts that shape which files a package contains: the
 * toolchain layer's cgo and experiment settings, the target triple, and the
 * target's own declared env.
 *
 * `go list` resolves build constraints, so it needs exactly these to report
 * the same package graph the build will compile. tapes turns `jsonv2` on
 * module-wide, and without `GOEXPERIMENT` every `go list` over a package that
 * imports `encoding/json/v2` fails with "build constraints exclude all Go
 * files"; a cross-compiled binary likewise resolves a different file set.
 */
const graphEnvironment = (context: Context, attrs: Record<string, unknown>): Record<string, string> => {
  const declaration = toolchain(context.workspace)
  const env = { ...((attrs["env"] as Record<string, string> | undefined) ?? {}) }
  const cgo = attrs["cgo"] ?? declaration?.cgo
  if (typeof cgo === "boolean") env["CGO_ENABLED"] = cgo ? "1" : "0"
  if ((declaration?.experiments.length ?? 0) > 0) env["GOEXPERIMENT"] = declaration!.experiments.join(",")
  if (attrs["goos"] !== undefined) env["GOOS"] = String(attrs["goos"])
  if (attrs["goarch"] !== undefined) env["GOARCH"] = String(attrs["goarch"])
  return env
}

/**
 * The module cache directory a `Go.ModDownload` on this target's `data` edge
 * fills, if it declares one.
 *
 * `offline` is only honest if it points the run at the cache the declared
 * fetch resource produced. Without this, `GOPROXY=off` runs against the
 * host's ambient `GOMODCACHE`: green on a developer's warm machine and
 * broken on a clean one, with the fetch edge doing nothing.
 */
const fetchedModuleCache = (context: Context, attrs: Record<string, unknown>): string | undefined => {
  const data = attrs["data"]
  if (!Array.isArray(data)) return undefined
  // Workspace-relative: the executor roots GOMODCACHE at spawn. A rooted path
  // here entered the key and split the cache per checkout.
  for (const entry of data) {
    const target = targetOf(entry)
    if (target === undefined || Target.metadata(target).target !== "Go.ModDownload") continue
    const outDirs = (Target.metadata(target).attrs as { readonly outDirs?: ReadonlyArray<string> }).outDirs
    const first = outDirs?.[0]
    if (first !== undefined) return Input.resolvePath("", first)
  }
  return undefined
}

/**
 * The graph environment plus the fetch-shaping knobs `offline` declares.
 *
 * These stay off the plan-time `go list`: they decide where modules may come
 * from, not which files a package has, and the module cache the fetch
 * resource fills is materialized for the spawn, not for planning.
 */
const environment = (context: Context, attrs: Record<string, unknown>): Record<string, string> => {
  const env = graphEnvironment(context, attrs)
  if (attrs["offline"] === true) {
    env["GOPROXY"] = "off"
    env["GOFLAGS"] = "-mod=readonly"
    const cache = fetchedModuleCache(context, attrs)
    if (cache !== undefined) env["GOMODCACHE"] = cache
  }
  return env
}

/**
 * The environment a Go toolchain probe runs under: the declared toolchain
 * settings with no target-specific additions.
 *
 * @category planning
 * @since 0.1.0
 */
export const toolchainEnvironment = (context: Context): Readonly<Record<string, string>> => environment(context, {})

/**
 * Plans one `Go.*` rule into argv, environment, outputs, and the closure the
 * cache key is computed over.
 *
 * @category planning
 * @since 0.1.0
 */
export const planRule = async (
  rule: string,
  attrs: Record<string, unknown>,
  context: Context,
  goPath: string
): Promise<Planned> => {
  const env = environment(context, attrs)
  const listEnv = { ...hostEnvironment(context), ...graphEnvironment(context, attrs) }
  const authority = moduleFiles(context)
  if (rule === "Go.Packages") {
    const packages = await selectedPackages(attrs["pkgs"], context, goPath, listEnv)
    const graph = await closure(packages, context, goPath, listEnv)
    return {
      env,
      outDirs: [],
      writeSet: [],
      readSet: [...authority, ...graph.files],
      closureIdentity: graph.identity
    }
  }
  if (rule === "Go.ModDownload") {
    const outDirs = (attrs["outDirs"] as ReadonlyArray<string>).map((path) =>
      Input.resolvePath(context.packagePath, path)
    )
    return {
      argv: [goPath, "mod", "download"],
      env: { ...env, GOMODCACHE: outDirs[0] ?? ".gomodcache" },
      outDirs,
      writeSet: [],
      readSet: authority
    }
  }
  if (rule === "Go.Binary") {
    const pkg = anchor(String(attrs["pkg"]), context.packagePath)
    const out = Input.resolvePath(context.packagePath, String(attrs["out"]))
    const flags = [...((attrs["ldflags"] as ReadonlyArray<string> | undefined) ?? [])]
    for (const [name, value] of Object.entries((attrs["stamp"] as Record<string, unknown> | undefined) ?? {})) {
      flags.push("-X", `${name}=${StampExec.token(name, value)}`)
    }
    // `go build` stamps the repository's commit and dirty flag into a main
    // package by default. That state is not key material here, so the same key
    // would serve a binary stamped from another commit; and the confinement
    // admits the declared closure, not `.git`, so the toolchain's own probe
    // fails the build outright. Version information enters through the declared
    // `stamp` attr, which does key, and is the only stamping this rule allows.
    const argv = [
      goPath,
      "build",
      "-buildvcs=false",
      "-o",
      out,
      ...(flags.length === 0 ? [] : ["-ldflags", flags.join(" ")]),
      pkg
    ]
    const packages = await selectedPackages([pkg], { ...context, packagePath: "" }, goPath, listEnv)
    const graph = await closure(packages, context, goPath, listEnv)
    return {
      argv,
      env,
      outDirs: [NodePath.dirname(out)],
      writeSet: [],
      readSet: [...authority, ...graph.files],
      closureIdentity: graph.identity
    }
  }
  if (rule === "Go.Test") {
    const packages = await selectedPackages(attrs["pkgs"], context, goPath, listEnv)
    // A declared runner is part of what the target asked for. Falling back to
    // plain `go test` would report green for a run the declaration did not
    // describe, so an absent runner refuses by name instead.
    const gotestsum = attrs["runner"] === "gotestsum" ? PackageTree.findOnPath("gotestsum") : undefined
    if (attrs["runner"] === "gotestsum" && gotestsum === undefined) {
      return {
        refusal: "host binary \"gotestsum\" is not present on PATH (required by S.Go.Test({ runner: \"gotestsum\" }))",
        env,
        outDirs: [],
        writeSet: [],
        readSet: []
      }
    }
    const testFlags = [
      ...(attrs["timeout"] === undefined ? [] : ["-timeout", String(attrs["timeout"])]),
      // Go's own default for -parallel is GOMAXPROCS, so "cpus" is the
      // default and stays off the argv: spelling the host's core count would
      // put host state into the key and split the cache per machine.
      ...(typeof attrs["parallel"] === "number" ? [`-parallel=${String(attrs["parallel"])}`] : []),
      ...packages
    ]
    const argv = gotestsum === undefined
      ? [goPath, "test", ...testFlags]
      : [gotestsum, "--", ...testFlags]
    const graph = await closure(packages, context, goPath, listEnv, true)
    return {
      argv,
      env,
      outDirs: [],
      writeSet: [],
      readSet: [...authority, ...graph.files],
      closureIdentity: graph.identity
    }
  }
  if (rule === "Go.Lint") {
    const pkgs = (attrs["pkgs"] as ReadonlyArray<string>).map((entry) => anchor(entry, context.packagePath))
    const config = Input.resolvePath(context.packagePath, (attrs["config"] as Input.File).path)
    const changes = ((attrs["changes"] as ReadonlyArray<string> | undefined) ?? []).map((entry) =>
      Input.resolvePath(context.packagePath, entry)
    )
    return {
      argv: [
        goPath,
        "run",
        `github.com/golangci/golangci-lint/v2/cmd/golangci-lint@${String(attrs["version"])}`,
        "run",
        "--config",
        config,
        ...(changes.length > 0 ? ["--fix"] : []),
        ...pkgs
      ],
      env,
      outDirs: [],
      writeSet: changes,
      readSet: [...authority, config]
    }
  }
  if (rule === "Go.Generate") {
    const packages = await selectedPackages(attrs["pkgs"], context, goPath, listEnv)
    const graph = await closure(packages, context, goPath, listEnv)
    return {
      argv: [goPath, "generate", ...packages],
      env,
      outDirs: [],
      writeSet: ((attrs["changes"] as ReadonlyArray<string>) ?? []).map((entry) =>
        Input.resolvePath(context.packagePath, entry)
      ),
      readSet: [...authority, ...graph.files],
      closureIdentity: graph.identity
    }
  }
  if (rule === "Go.Fuzz") {
    const pkg = anchor(String(attrs["pkg"]), context.packagePath)
    const packages = await selectedPackages([pkg], { ...context, packagePath: "" }, goPath, listEnv)
    const graph = await closure(packages, context, goPath, listEnv, true)
    return {
      argv: [
        goPath,
        "test",
        pkg,
        "-run=^$",
        `-fuzz=${String(attrs["fuzz"])}`,
        `-fuzztime=${String(attrs["time"])}`,
        ...(attrs["parallel"] === undefined ? [] : [`-parallel=${String(attrs["parallel"])}`])
      ],
      env,
      outDirs: [],
      writeSet: [],
      readSet: [...authority, ...graph.files],
      closureIdentity: graph.identity
    }
  }
  return { env, outDirs: [], writeSet: [], readSet: authority }
}
