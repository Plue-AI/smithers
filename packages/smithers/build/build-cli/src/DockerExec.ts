/**
 * Planning helpers for Docker services, OCI builds, bake targets, and pushes.
 *
 * Every Docker rule needs the same host facts before it can plan: the CLI
 * on PATH, a daemon that answers `docker info`, and a buildx builder that
 * supports the OCI exporter. This module resolves those once per plan
 * invocation through the shared host-probe cache and turns the declarations into argv: `docker create --rm` for supervised
 * services, `buildx build`/`buildx bake` writing an OCI archive into the
 * captured output directory, and an approval-gated `docker push` for the
 * outward effect. A silent daemon is a typed refusal, never a green no-op.
 *
 * @since 0.1.0
 */

import type * as Docker from "@smthrs/targets/Docker"
import * as Input from "@smthrs/targets/Input"
import * as Stamp from "@smthrs/targets/Stamp"
import * as Schema from "effect/Schema"
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as HostProbes from "./internal/HostProbes.ts"
import * as PackageTree from "./PackageTree.ts"
import type * as ServiceSupervisor from "./ServiceSupervisor.ts"

/**
 * Resolved docker CLI plus daemon identity.
 *
 * @category models
 * @since 0.1.0
 */
export type DockerTool =
  | { readonly ok: true; readonly path: string; readonly builder: string | undefined; readonly identity: unknown }
  | { readonly ok: false; readonly refusal: string; readonly identity: unknown }

/**
 * Resolves Docker and verifies that its daemon answers.
 *
 * `environment` is the environment the plan resolved, already stripped of the
 * workspace's remote-cache credential names. Without it these three probes
 * inherited the whole process environment, so `docker info` and `buildx ls` --
 * and any PATH-resolved impostor of the name -- read credentials every later
 * spawn withholds.
 *
 * `probes` is the invocation's host-probe cache: every Docker target of one
 * plan shares one `--version`, one `info`, and one `buildx ls` under the same
 * resolved path and environment. Without it each call probes afresh.
 *
 * @category planning
 * @since 0.1.0
 */
export const resolveDocker = async (
  environment?: Readonly<Record<string, string | undefined>> | undefined,
  probes: HostProbes.HostProbes = HostProbes.none()
): Promise<DockerTool> => {
  const path = PackageTree.findOnPath("docker", environment)
  if (path === undefined) {
    return {
      ok: false,
      refusal: "host binary \"docker\" is not present on PATH",
      identity: { tag: "Docker", absent: true }
    }
  }
  const probeOptions = environment === undefined ? undefined : { environment }
  const context = HostProbes.environmentKey(environment)
  const probe = (args: ReadonlyArray<string>): Promise<PackageTree.Probe> =>
    probes.once(["docker", path, args, context], () => PackageTree.probeCommand(path, args, probeOptions))
  const version = await probe(["--version"])
  const daemon = await probe(["info", "--format", "{{.ServerVersion}}"])
  const builders = daemon.exitCode === 0 ? await probe(["buildx", "ls"]) : undefined
  const builder = builders?.output.match(/^(\S+)\s+docker-container\s*$/m)?.[1]?.replace(/\*$/, "")
  const identity = { tag: "Docker", path, version, daemon, builder: builder ?? null }
  return daemon.exitCode === 0
    ? { ok: true, path, builder, identity }
    : {
      ok: false,
      refusal: `docker daemon did not answer "docker info": ${daemon.output.trim() || `exit ${daemon.exitCode}`}`,
      identity
    }
}

const safeTarget = (target: string): string => target.replaceAll(/[^A-Za-z0-9._-]/g, "-")

/**
 * The package-relative output directory of a Docker build target.
 *
 * @category planning
 * @since 0.1.0
 */
export const outputDir = (rule: "Docker.Build" | "Docker.Bake", packagePath: string, attrs: unknown): string =>
  Input.resolvePath(
    packagePath,
    rule === "Docker.Bake"
      ? `docker-image-${safeTarget((attrs as { readonly target: string }).target)}`
      : "docker-image"
  )

const scalar = (value: unknown): string | undefined => {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value)
  if (
    typeof value === "object" && value !== null &&
    (value as { readonly _tag?: unknown })._tag === "Stamp" &&
    typeof (value as { readonly name?: unknown }).name === "string"
  ) {
    return `{smthrs:stamp:${Buffer.from(JSON.stringify({ name: "docker-tag", value })).toString("base64url")}}`
  }
  return undefined
}

/**
 * Refuses an empty or malformed resolved Docker tag before a push can spawn.
 *
 * @category planning
 * @since 1.0.0
 */
export const pushTagRefusal = (tag: string): string | undefined =>
  tag === ""
    ? "Docker.Push requires a non-empty value for every tag"
    // https://github.com/distribution/reference/blob/main/regexp.go
    : /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(tag)
    ? undefined
    : "Docker.Push tags must contain 1 to 128 ASCII letters, digits, underscores, dots or hyphens and start with a letter, digit or underscore"

/**
 * The archive a `Docker.Build` or `Docker.Bake` writes for its output directory.
 *
 * @category planning
 * @since 1.0.0
 */
export const imageArchive = (outDir: string): string => `${outDir}/image.tar`

/**
 * Reads the image reference `docker load` reports for an archive: the
 * `Loaded image ID:` or `Loaded image:` line, last one wins. A push tags this
 * exact image, so it publishes what the build produced and never whatever
 * else the daemon holds under the destination reference.
 *
 * @category execution
 * @since 1.0.0
 */
export const loadedImage = (stdout: string): string | undefined => {
  let loaded: string | undefined
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^Loaded image(?: ID)?: (\S+)\s*$/.exec(line)
    if (match !== null) loaded = match[1]
  }
  return loaded
}

/**
 * Reduced plan fields for a Docker build/bake/push.
 *
 * @category models
 * @since 0.1.0
 */
export interface Plan {
  readonly argv?: ReadonlyArray<string> | undefined
  readonly commands?: ReadonlyArray<ReadonlyArray<string>> | undefined
  readonly outDirs: ReadonlyArray<string>
  readonly toolchain: unknown
  readonly refusal?: string | undefined
}

/**
 * Plans one non-service Docker target.
 *
 * @category planning
 * @since 0.1.0
 */
export const plan = async (options: {
  readonly rule: "Docker.Build" | "Docker.Bake" | "Docker.Push"
  readonly packagePath: string
  readonly attrs:
    | (typeof Docker.BuildAttrs)["Type"]
    | (typeof Docker.BakeAttrs)["Type"]
    | (typeof Docker.PushAttrs)["Type"]
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly probes?: HostProbes.HostProbes | undefined
}): Promise<Plan> => {
  const tool = await resolveDocker(options.environment, options.probes)
  if (!tool.ok) return { outDirs: [], toolchain: tool.identity, refusal: tool.refusal }
  if (options.rule === "Docker.Push") {
    const attrs = options.attrs as (typeof Docker.PushAttrs)["Type"]
    if (attrs.tags.length === 0) {
      return { outDirs: [], toolchain: tool.identity, refusal: "Docker.Push requires at least one tag" }
    }
    const tags = attrs.tags.map(scalar)
    if (tags.some((tag) => tag === undefined)) {
      return {
        outDirs: [],
        toolchain: tool.identity,
        refusal: "Docker.Push tags must resolve to strings before execution"
      }
    }
    for (const [index, tag] of tags.entries()) {
      // Real stamps are late-bound; their resolved tag is checked at spawn.
      if (Schema.is(Stamp.Value)(attrs.tags[index])) continue
      const refusal = pushTagRefusal(tag!)
      if (refusal !== undefined) return { outDirs: [], toolchain: tool.identity, refusal }
    }
    const commands = tags.map((tag) => [tool.path, "push", `${attrs.registry}/${attrs.name}:${tag}`])
    return {
      argv: commands[0],
      commands,
      outDirs: [],
      toolchain: tool.identity
    }
  }
  const outDir = outputDir(options.rule, options.packagePath, options.attrs)
  const destination = imageArchive(outDir)
  if (options.rule === "Docker.Build") {
    const attrs = options.attrs as (typeof Docker.BuildAttrs)["Type"]
    const args: Array<string> = [
      tool.path,
      "buildx",
      "build",
      ...(tool.builder === undefined ? [] : ["--builder", tool.builder]),
      "--file",
      Input.resolvePath(options.packagePath, attrs.dockerfile.path)
    ]
    if ((attrs.platforms?.length ?? 0) > 0) args.push("--platform", attrs.platforms!.join(","))
    for (const [name, value] of Object.entries(attrs.buildArgs ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
      const rendered = scalar(value)
      if (rendered === undefined) {
        return {
          outDirs: [outDir],
          toolchain: tool.identity,
          refusal: `Docker.Build buildArgs.${name} must resolve to a string before execution`
        }
      }
      args.push("--build-arg", `${name}=${rendered}`)
    }
    args.push(
      "--output",
      `type=oci,dest=${destination}`,
      Input.resolvePath(options.packagePath, attrs.context) || "."
    )
    return { argv: args, outDirs: [outDir], toolchain: tool.identity }
  }
  const attrs = options.attrs as (typeof Docker.BakeAttrs)["Type"]
  return {
    argv: [
      tool.path,
      "buildx",
      "bake",
      ...(tool.builder === undefined ? [] : ["--builder", tool.builder]),
      "--file",
      Input.resolvePath(options.packagePath, attrs.config.path),
      "--set",
      `${attrs.target}.output=type=oci,dest=${destination}`,
      attrs.target
    ],
    outDirs: [outDir],
    toolchain: tool.identity
  }
}

/**
 * Creates output parents before Docker writes its OCI tar.
 *
 * @category execution
 * @since 0.1.0
 */
export const prepareOutputs = async (root: string, outDirs: ReadonlyArray<string>): Promise<void> => {
  for (const outDir of outDirs) await Fs.mkdir(NodePath.join(root, ...outDir.split("/")), { recursive: true })
}

/**
 * Stable container name prefix within one invocation, target and directory.
 * The supervisor appends a fresh nonce for each shared resource lifetime and
 * captures its container ID. Consumers of the live resource share that ID.
 *
 * @category planning
 * @since 0.1.0
 */
export const containerName = (label: string, cwd: string, invocationId: string): string =>
  `smthrs-${
    createHash("sha256").update(JSON.stringify([NodePath.resolve(cwd), label, invocationId])).digest("hex").slice(0, 32)
  }`

/**
 * Resolves one Docker service declaration into the supervisor's process spec.
 *
 * @category planning
 * @since 0.1.0
 */
export const serviceSpec = async (options: {
  readonly invocationId: string
  readonly label: string
  readonly cwd: string
  readonly attrs: (typeof Docker.ServeAttrs)["Type"]
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  readonly probes?: HostProbes.HostProbes | undefined
}): Promise<ServiceSupervisor.ServiceSpec | { readonly error: string }> => {
  const tool = await resolveDocker(options.environment, options.probes)
  if (!tool.ok) return { error: tool.refusal }
  const attrs = options.attrs
  // Creation options stay canonical across consumers. The supervisor supplies
  // the unique name only when the refcounted resource is actually created.
  const argv: Array<string> = [tool.path]
  for (const [container, host] of Object.entries(attrs.ports ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    // Bind loopback explicitly. An unqualified `-p host:container` publishes on
    // 0.0.0.0, which puts a developer fixture or a CI container on the LAN and
    // on anything sharing the CI host's network. The HTTP readiness probe
    // already targets 127.0.0.1, so the port mapping was the one place the
    // local-only posture was not stated.
    argv.push("-p", `127.0.0.1:${host}:${container}`)
  }
  for (const [key, value] of Object.entries(attrs.env ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    argv.push("-e", `${key}=${value}`)
  }
  for (const [volume, destination] of Object.entries(attrs.volumes ?? {}).sort(([a], [b]) => a.localeCompare(b))) {
    argv.push("-v", `${volume}:${destination}`)
  }
  argv.push(attrs.tag === undefined ? attrs.image : `${attrs.image}:${attrs.tag}`)
  argv.push(...(attrs.command ?? []))
  return {
    key: options.label,
    cwd: options.cwd,
    docker: containerName(options.label, options.cwd, options.invocationId),
    argv: argv as [string, ...Array<string>],
    readiness: attrs.readiness,
    health: attrs.health,
    stop: attrs.stop,
    init: (attrs.init ?? []).map((command) => [...command] as [string, ...Array<string>])
  }
}
