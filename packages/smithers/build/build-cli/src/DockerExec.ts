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
import * as Data from "effect/Data"
import * as Schema from "effect/Schema"
import { createHash, randomUUID } from "node:crypto"
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

const digestPattern = /^sha256:[0-9a-f]{64}$/

/**
 * The single image a build archive holds: its manifest and config digests,
 * its layer blobs, and where a synthesized `manifest.json` may be appended.
 *
 * @category models
 * @since 1.0.0
 */
export interface ArchiveImage {
  readonly manifest: string
  readonly config: string
  readonly revision: string | undefined
  readonly architecture: string | undefined
  readonly layers: ReadonlyArray<string>
  /** Whether the archive already carries the `manifest.json` `docker load` reads. */
  readonly loadable: boolean
  /** Byte offset of the archive's end-of-archive marker. */
  readonly end: number
}

/**
 * A build archive a push cannot read its image from.
 *
 * @category errors
 * @since 1.0.0
 */
class ImageArchiveError extends Data.TaggedError("smithers-build/ImageArchiveError")<{
  readonly message: string
}> {}

interface TarEntry {
  readonly offset: number
  readonly size: number
}

const block = 512

const tarString = (bytes: Buffer, start: number, length: number): string =>
  bytes.subarray(start, start + length).toString("utf8").replace(/\0[\s\S]*$/, "")

/** The value of the last `key` record of a PAX extended header. */
const paxRecord = (records: string, key: string): string | undefined =>
  [...records.matchAll(new RegExp(`^\\d+ ${key}=(.*)$`, "gm"))].at(-1)?.[1]

/**
 * Indexes a tar archive's regular files by normalized path. It reads the
 * ustar layout Go's `archive/tar` (and so BuildKit) writes: names split into
 * prefix and name, and PAX extended headers for longer paths or sizes.
 */
const tarIndex = async (
  handle: Fs.FileHandle
): Promise<{ readonly files: Map<string, TarEntry>; readonly end: number }> => {
  const { size: length } = await handle.stat()
  const files = new Map<string, TarEntry>()
  const header = Buffer.alloc(block)
  let offset = 0
  let pax = ""
  while (offset + block <= length) {
    await handle.read(header, 0, block, offset)
    if (header.every((byte) => byte === 0)) return { files, end: offset }
    const size = Number(paxRecord(pax, "size") ?? Number.parseInt(tarString(header, 124, 12).trim(), 8))
    const data = offset + block
    if (!Number.isSafeInteger(size) || data + size > length) break
    const type = tarString(header, 156, 1)
    if (type === "x") {
      const body = Buffer.alloc(size)
      await handle.read(body, 0, size, data)
      pax = body.toString("utf8")
    } else {
      const prefix = tarString(header, 345, 155)
      const name = paxRecord(pax, "path") ?? `${prefix}${prefix === "" ? "" : "/"}${tarString(header, 0, 100)}`
      pax = ""
      if (type === "0" || type === "") files.set(name.replace(/^(\.\/)+/, ""), { offset: data, size })
    }
    offset = data + Math.ceil(size / block) * block
  }
  throw new ImageArchiveError({ message: "the image archive is not a complete tar archive" })
}

const readEntry = async (handle: Fs.FileHandle, entry: TarEntry): Promise<Buffer> => {
  const body = Buffer.alloc(entry.size)
  await handle.read(body, 0, entry.size, entry.offset)
  return body
}

const indexTypes = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json"
])

const manifestTypes = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json"
])

/** BuildKit marks attestation manifests, which are not images, with this annotation. */
const referenceType = "vnd.docker.reference.type"

interface Descriptor {
  readonly mediaType?: unknown
  readonly digest?: unknown
  readonly annotations?: Readonly<Record<string, unknown>> | undefined
}

const descriptors = (document: unknown): ReadonlyArray<Descriptor> => {
  const manifests = (document as { readonly manifests?: unknown } | null)?.manifests
  return Array.isArray(manifests) ? manifests as ReadonlyArray<Descriptor> : []
}

/**
 * Reads the one image a `Docker.Build` or `Docker.Bake` archive holds from its
 * OCI layout. Attestation manifests are not images. An archive holding several
 * platform images is refused: the Docker daemon holds one platform per
 * reference, so pushing through it could publish only part of the build.
 *
 * @category execution
 * @since 1.0.0
 */
export const readImageArchive = async (path: string): Promise<ArchiveImage | { readonly error: string }> => {
  const handle = await Fs.open(path, "r")
  try {
    const { files, end } = await tarIndex(handle)
    const json = async (name: string): Promise<unknown> => {
      const entry = files.get(name)
      if (entry === undefined) throw new ImageArchiveError({ message: `the image archive has no ${name}` })
      return JSON.parse((await readEntry(handle, entry)).toString("utf8"))
    }
    const blob = (digest: string) => `blobs/sha256/${digest.slice("sha256:".length)}`
    const images: Array<string> = []
    const visit = async (list: ReadonlyArray<Descriptor>): Promise<void> => {
      for (const descriptor of list) {
        const digest = descriptor.digest
        if (typeof digest !== "string" || !digestPattern.test(digest)) {
          throw new ImageArchiveError({ message: "the image archive has a malformed digest" })
        }
        const mediaType = String(descriptor.mediaType)
        // Content addressing rules out cycles: an index cannot name its own digest.
        if (indexTypes.has(mediaType)) await visit(descriptors(await json(blob(digest))))
        else if (manifestTypes.has(mediaType) && descriptor.annotations?.[referenceType] === undefined) {
          if (!images.includes(digest)) images.push(digest)
        }
      }
    }
    await visit(descriptors(await json("index.json")))
    if (images.length !== 1) {
      return {
        error: images.length === 0
          ? "the image archive holds no image"
          : `Docker.Push publishes one platform image, but the build archive holds ${images.length}`
      }
    }
    const manifest = await json(blob(images[0]!)) as {
      readonly config?: { readonly digest?: unknown }
      readonly layers?: ReadonlyArray<{ readonly digest?: unknown }>
    }
    const config = manifest.config?.digest
    const layers = (manifest.layers ?? []).map((layer) => layer.digest)
    const digests = [config, ...layers]
    if (!digests.every((digest): digest is string => typeof digest === "string" && digestPattern.test(digest))) {
      return { error: "the image manifest has a malformed digest" }
    }
    const missing = digests.find((digest) => !files.has(blob(digest)))
    if (missing !== undefined) return { error: `the image archive has no blob ${missing}` }
    const document = await json(blob(config as string)) as {
      readonly architecture?: string
      readonly config?: { readonly Labels?: Readonly<Record<string, string>> }
    }
    return {
      revision: document.config?.Labels?.["org.opencontainers.image.revision"],
      architecture: document.architecture,
      manifest: images[0]!,
      config: config as string,
      layers: layers as ReadonlyArray<string>,
      loadable: files.has("manifest.json"),
      end
    }
  } catch (error) {
    return { error: (error as Error).message }
  } finally {
    await handle.close()
  }
}

const tarHeader = (name: string, size: number): Buffer => {
  const header = Buffer.alloc(block)
  header.write(name, 0, 100, "utf8")
  header.write("0000444\0", 100, "ascii")
  header.write("0000000\0", 108, "ascii")
  header.write("0000000\0", 116, "ascii")
  header.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii")
  header.write("00000000000\0", 136, "ascii")
  header.write("        ", 148, "ascii")
  header.write("0", 156, "ascii")
  header.write("ustar\u000000", 257, "ascii")
  let sum = 0
  for (const byte of header) sum += byte
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii")
  return header
}

/**
 * Writes a copy of an OCI-layout archive that `docker load` accepts: the same
 * entries plus the `manifest.json` naming the image's config and layer blobs.
 * Docker's exporter writes this file itself; buildx's OCI exporter does not.
 *
 * @category execution
 * @since 1.0.0
 */
export const writeLoadableArchive = async (source: string, destination: string, image: ArchiveImage): Promise<void> => {
  const blob = (digest: string) => `blobs/sha256/${digest.slice("sha256:".length)}`
  const manifest = Buffer.from(
    JSON.stringify([{ Config: blob(image.config), RepoTags: null, Layers: image.layers.map(blob) }]),
    "utf8"
  )
  await Fs.copyFile(source, destination)
  const handle = await Fs.open(destination, "r+")
  try {
    const padded = Math.ceil(manifest.length / block) * block
    const tail = Buffer.alloc(block + padded + 2 * block)
    tarHeader("manifest.json", manifest.length).copy(tail, 0)
    manifest.copy(tail, block)
    await handle.write(tail, 0, tail.length, image.end)
    await handle.truncate(image.end + tail.length)
  } finally {
    await handle.close()
  }
}

/**
 * The image IDs `docker load` reports, in order.
 *
 * @category execution
 * @since 1.0.0
 */
export const loadedImageIds = (stdout: string): ReadonlyArray<string> =>
  [...stdout.matchAll(/^Loaded image ID: (\S+)\s*$/gm)].map((match) => match[1]!)

/**
 * The manifest digest `docker push` reports for the reference it published.
 *
 * @category execution
 * @since 1.0.0
 */
export const pushedDigest = (stdout: string): string | undefined => {
  let digest: string | undefined
  for (const match of stdout.matchAll(/: digest: (sha256:[0-9a-f]{64}) size: \d+/g)) digest = match[1]
  return digest
}

/**
 * The config digest of a raw registry image manifest, or undefined when the
 * document is not a single image manifest.
 *
 * @category execution
 * @since 1.0.0
 */
export const manifestConfig = (raw: string): string | undefined => {
  try {
    const digest = (JSON.parse(raw) as { readonly config?: { readonly digest?: unknown } } | null)?.config?.digest
    return typeof digest === "string" && digestPattern.test(digest) ? digest : undefined
  } catch {
    return undefined
  }
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

/** The captured outcome of one archive transport command.
 * @category models
 * @since 1.0.0
 */
export interface PushCommandResult {
  readonly ok: boolean
  readonly error?: string | undefined
  readonly result?: { readonly stdout: string } | undefined
}

/** Loads, tags, pushes and verifies the built archive through one shared transport.
 * The caller owns credentials and reporting; temporary loadable copies always settle.
 * @category execution
 * @since 1.0.0
 */
export const pushArchive = async (options: {
  readonly archive: string
  readonly docker: ReadonlyArray<string>
  readonly repository: string
  readonly references: ReadonlyArray<string>
  readonly temporaryDirectory: string
  readonly run: (argv: ReadonlyArray<string>) => Promise<PushCommandResult>
}): Promise<{ readonly digest: string } | { readonly error: string }> => {
  if (options.references.length === 0) return { error: "docker push planned no commands" }
  const image = await readImageArchive(options.archive)
  if ("error" in image) return image
  const loadable = image.loadable
    ? options.archive
    : NodePath.join(options.temporaryDirectory, `docker-load-${randomUUID()}.tar`)
  try {
    if (!image.loadable) {
      await Fs.mkdir(options.temporaryDirectory, { recursive: true })
      await writeLoadableArchive(options.archive, loadable, image)
    }
    const loaded = await options.run([...options.docker, "load", "--input", loadable])
    if (!loaded.ok) return { error: loaded.error ?? "docker load failed" }
    const id = loadedImageIds(loaded.result?.stdout ?? "").find((id) => id === image.config || id === image.manifest)
    if (id === undefined) return { error: `docker load did not load ${image.config} from ${options.archive}` }
    let digest = image.manifest
    for (const reference of options.references) {
      const tagged = await options.run([...options.docker, "tag", id, reference])
      if (!tagged.ok) return { error: tagged.error ?? "docker tag failed" }
      const pushed = await options.run([...options.docker, "push", reference])
      if (!pushed.ok) return { error: pushed.error ?? "docker push failed" }
      const pushedImage = pushedDigest(pushed.result?.stdout ?? "")
      if (pushedImage === undefined) return { error: `docker push reported no digest for ${reference}` }
      digest = pushedImage
      const inspected = await options.run([
        ...options.docker,
        "buildx",
        "imagetools",
        "inspect",
        "--raw",
        `${options.repository}@${digest}`
      ])
      if (!inspected.ok) return { error: inspected.error ?? "docker buildx imagetools inspect failed" }
      const config = manifestConfig(inspected.result?.stdout ?? "")
      if (config !== image.config) {
        return {
          error: `${options.repository}@${digest} holds config ${config ?? "(none)"}, not the built ${image.config}`
        }
      }
    }
    return { digest }
  } finally {
    if (!image.loadable) await Fs.rm(loadable, { force: true })
  }
}
