/**
 * Planning helpers for Foundry targets and mise-pinned tool references.
 *
 * forge shares a name with unrelated binaries, so resolution probes every
 * PATH candidate and keeps the one whose version output is Foundry's; the
 * declared foundry.toml and the workspace's mise pins enter the key as
 * digested authority, and an absent or wrong forge is a typed refusal.
 * `S.Mise.bin` resolution lives here too: the pinned version is read from
 * the declared mise config and execution refuses when mise itself is not
 * on the host.
 *
 * @since 0.1.0
 */

import type * as Foundry from "@smthrs/targets/Foundry"
import * as Input from "@smthrs/targets/Input"
import type * as WorkspaceDeclaration from "@smthrs/targets/WorkspaceDeclaration"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as HostProbes from "./internal/HostProbes.ts"
import * as PackageTree from "./PackageTree.ts"

/**
 * One resolved executable and the complete identity entering target keys.
 *
 * @category models
 * @since 0.1.0
 */
export type ResolvedTool =
  | { readonly ok: true; readonly path: string; readonly identity: unknown }
  | { readonly ok: false; readonly refusal: string; readonly identity: unknown }

const toolchainsOf = (workspace: WorkspaceDeclaration.WorkspaceDeclaration): ReadonlyArray<Record<string, unknown>> =>
  (workspace.toolchains ?? [])
    .filter((entry): entry is { readonly _tag: string } => typeof entry === "object" && entry !== null)
    .map((entry) => entry as unknown as Record<string, unknown>)

const filePath = (value: unknown): string | undefined =>
  typeof value === "object" && value !== null &&
    (value as { readonly _tag?: unknown })._tag === "File" &&
    typeof (value as { readonly path?: unknown }).path === "string"
    ? (value as { readonly path: string }).path
    : undefined

const digestDeclared = async (
  root: string,
  value: unknown,
  packagePath = ""
): Promise<{ readonly path: string; readonly digest: string } | null> => {
  const path = filePath(value)
  if (path === undefined) return null
  const resolved = Input.resolvePath(packagePath, path)
  try {
    return { path: resolved, digest: await PackageTree.digestFileBytes(NodePath.join(root, ...resolved.split("/"))) }
  } catch {
    return { path: resolved, digest: "absent" }
  }
}

const miseVersion = async (root: string, config: unknown, name: string): Promise<string | null> => {
  const path = filePath(config)
  if (path === undefined) return null
  try {
    const text = await Fs.readFile(NodePath.join(root, ...Input.resolvePath("", path).split("/")), "utf8")
    const tools = /^\[tools\][ \t]*\r?$([\s\S]*?)(?=^\[[^\]\r\n]+\][ \t]*\r?$|(?![\s\S]))/m.exec(text)?.[1] ?? text
    const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")
    const match = new RegExp(`^(?:${escaped}|["']${escaped}["'])\\s*=\\s*["']([^"']+)["']`, "m").exec(tools)
    return match?.[1] ?? null
  } catch {
    return null
  }
}

/**
 * Resolves `S.Mise.bin`, keying the declared config and pinned tool entry.
 *
 * @category planning
 * @since 0.1.0
 */
export const resolveMiseBin = async (
  root: string,
  workspace: WorkspaceDeclaration.WorkspaceDeclaration,
  name: string,
  environment: Readonly<Record<string, string | undefined>>,
  probes: HostProbes.HostProbes = HostProbes.none()
): Promise<ResolvedTool> => {
  const mise = toolchainsOf(workspace).find((entry) => entry["_tag"] === "Mise")
  const config = mise?.["config"]
  const authority = await digestDeclared(root, config)
  const pinned = await miseVersion(root, config, name)
  const path = PackageTree.findOnPath("mise", environment)
  const identity = { tag: "MiseBin", name, authority, pinned }
  if (mise === undefined) {
    return {
      ok: false,
      refusal: `S.Mise.bin(${JSON.stringify(name)}) requires an S.Mise entry in Workspace toolchains`,
      identity
    }
  }
  if (path === undefined) {
    return {
      ok: false,
      refusal: `host binary "mise" is not present on PATH; S.Mise.bin(${JSON.stringify(name)}) is pinned${
        pinned === null ? " by the declared mise config" : ` to ${pinned}`
      } but cannot execute on this host`,
      identity: { ...identity, absent: true }
    }
  }
  const probe = await probes.once(
    ["mise", path, ["--version"], HostProbes.environmentKey(environment)],
    () => PackageTree.probeVersion(path, { environment })
  )
  return {
    ok: true,
    path,
    identity: { ...identity, path, probe }
  }
}

/**
 * Every Foundry target of one plan shares one forge resolution: the PATH walk
 * and the `--version` probe of each candidate run once per environment.
 */
const resolveForge = (
  environment: Readonly<Record<string, string | undefined>>,
  probes: HostProbes.HostProbes
): Promise<ResolvedTool> =>
  probes.once(["forge", HostProbes.environmentKey(environment)], async () => {
    const candidates = PackageTree.findAllOnPath("forge", environment)
    for (const path of candidates) {
      const probe = await PackageTree.probeVersion(path, { environment })
      if (/^forge Version:/m.test(probe.output)) {
        return { ok: true, path, identity: { tag: "FoundryForge", path, probe } }
      }
    }
    return {
      ok: false,
      refusal: candidates.length === 0
        ? "host binary \"forge\" is not present on PATH"
        : "the PATH entries named \"forge\" are not Foundry forge executables",
      identity: { tag: "FoundryForge", candidates, absent: true }
    }
  })

/**
 * The reduced plan fields a Foundry target contributes to PackageExec.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly argv?: ReadonlyArray<string> | undefined
  readonly cwd: string
  readonly env: Readonly<Record<string, string>>
  readonly outDirs: ReadonlyArray<string>
  /**
   * Workspace-relative directories forge writes on its own account: the
   * compiler cache (`cache_path`, when caching is on) and the artifact
   * directory (`out`). Neither is a declared output of the rule (`Foundry.Test`
   * declares none, and a `Foundry.Build` may name a different `outDirs`), so
   * the confinement learns them here, from `forge config` itself, which is
   * what resolves the profile, the environment, and the config file the same
   * way the build will.
   */
  readonly writeSet: ReadonlyArray<string>
  readonly toolchain: unknown
  readonly refusal?: string | undefined
}

/**
 * Plans one Foundry rule from validated attrs.
 *
 * @category planning
 * @since 0.1.0
 */
export const plan = async (options: {
  readonly root: string
  readonly packagePath: string
  readonly workspace: WorkspaceDeclaration.WorkspaceDeclaration
  readonly rule: "Foundry.Build" | "Foundry.Test" | "Foundry.Fmt"
  readonly mode: "execute" | "check" | "write"
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** The invocation's host-probe cache; a fresh one when planning a single target directly. */
  readonly probes?: HostProbes.HostProbes | undefined
  readonly attrs:
    | (typeof Foundry.BuildAttrs)["Type"]
    | (typeof Foundry.TestAttrs)["Type"]
    | (typeof Foundry.FmtAttrs)["Type"]
}): Promise<Plan> => {
  const probes = options.probes ?? HostProbes.none()
  const resolved = await resolveForge(options.environment ?? process.env, probes)
  const foundry = toolchainsOf(options.workspace).find((entry) => entry["_tag"] === "FoundryToolchain")
  const configValue = (options.attrs as { readonly config?: unknown }).config ?? foundry?.["config"]
  const configAuthority = await digestDeclared(
    options.root,
    configValue,
    (options.attrs as { readonly config?: unknown }).config === undefined ? "" : options.packagePath
  )
  const versions = foundry?.["versions"] as Record<string, unknown> | undefined
  const versionsAuthority = await digestDeclared(options.root, versions?.["config"])
  const pinned = await miseVersion(options.root, versions?.["config"], "forge")
  const toolchain = {
    forge: resolved.identity,
    config: configAuthority,
    versions: versionsAuthority,
    pinned
  }
  const cwd = options.packagePath || "."
  if (!resolved.ok) return { cwd, env: {}, outDirs: [], writeSet: [], toolchain, refusal: resolved.refusal }
  const attrs = options.attrs as {
    readonly profile?: string
    readonly skip?: ReadonlyArray<string>
    readonly outDirs?: ReadonlyArray<string>
  }
  const argv: Array<string> = [resolved.path]
  if (options.rule === "Foundry.Build") argv.push("build")
  else if (options.rule === "Foundry.Test") argv.push("test")
  else argv.push("fmt", ...(options.mode === "check" ? ["--check"] : []))
  if (configAuthority !== null && options.rule !== "Foundry.Fmt") {
    argv.push(
      "--config-path",
      NodePath.relative(options.packagePath || ".", configAuthority.path) || NodePath.basename(configAuthority.path)
    )
  }
  if (options.rule === "Foundry.Build") {
    for (const skip of attrs.skip ?? []) argv.push("--skip", skip)
  }
  const env = attrs.profile === undefined ? {} : { FOUNDRY_PROFILE: attrs.profile }
  const outDirs = options.rule === "Foundry.Build"
    ? (attrs.outDirs ?? []).map((dir) => Input.resolvePath(options.packagePath, dir))
    : []
  if (options.rule === "Foundry.Fmt") return { argv, cwd, env, outDirs, writeSet: [], toolchain }
  const projectRoot = configAuthority === null
    ? options.packagePath
    : (NodePath.posix.dirname(configAuthority.path) === "." ? "" : NodePath.posix.dirname(configAuthority.path))
  // A project fact, not a host fact: keyed by the directory, the config path
  // and the profile-bearing environment, so two targets of one project share
  // it and a distinct profile or project asks forge itself.
  const configCwd = NodePath.join(options.root, ...cwd.split("/").filter((segment) => segment !== "."))
  const configPath = configAuthority === null ? undefined : argv[argv.indexOf("--config-path") + 1]
  const configEnvironment = { ...options.environment, ...env }
  const forgeConfig = await probes.once(
    ["forge config", resolved.path, configCwd, configPath ?? null, HostProbes.environmentKey(configEnvironment)],
    () => effectiveConfig(resolved.path, configCwd, configPath, configEnvironment)
  )
  if (typeof forgeConfig === "string") {
    return { argv, cwd, env, outDirs, writeSet: [], toolchain, refusal: forgeConfig }
  }
  const writeSet = [forgeConfig.out, ...(forgeConfig.cache ? [forgeConfig.cachePath] : [])].map((directory) =>
    Input.resolvePath(projectRoot, directory)
  )
  return { argv, cwd, env, outDirs, writeSet, toolchain }
}

/**
 * The directories forge will write, as forge itself resolves them: `out` and
 * `cache_path` after the profile, `FOUNDRY_*` overrides, and the config file
 * are applied. Relative values are relative to the project root, which is
 * the config file's directory. A string is the refusal to report when forge
 * cannot read its own configuration, which is the same failure the build
 * would then print.
 */
const effectiveConfig = async (
  forge: string,
  cwd: string,
  configPath: string | undefined,
  environment: Readonly<Record<string, string | undefined>>
): Promise<{ readonly out: string; readonly cachePath: string; readonly cache: boolean } | string> => {
  const args = ["config", "--json", ...(configPath === undefined ? [] : ["--config-path", configPath])]
  const raw = await PackageTree.runCommand(forge, args, { cwd, environment }).catch((cause: unknown) =>
    cause instanceof Error ? cause : new Error(String(cause))
  )
  if (raw instanceof Error) return `forge config failed: ${raw.message}`
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return "forge config did not print JSON"
  }
  const record = parsed as { readonly out?: unknown; readonly cache_path?: unknown; readonly cache?: unknown }
  const out = typeof record.out === "string" && record.out !== "" ? record.out : "out"
  const cachePath = typeof record.cache_path === "string" && record.cache_path !== "" ? record.cache_path : "cache"
  return { out, cachePath, cache: record.cache !== false }
}
