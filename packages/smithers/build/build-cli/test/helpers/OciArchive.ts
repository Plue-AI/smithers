/**
 * Writes small image archives in the layouts buildx exporters produce: an OCI
 * layout (`type=oci`), optionally with Docker's `manifest.json`
 * (`type=docker`), for Docker.Push tests that never run a real build.
 */
import { createHash } from "node:crypto"
import * as Fs from "node:fs/promises"

const block = 512

const header = (name: string, size: number, type = "0", prefix = ""): Buffer => {
  const bytes = Buffer.alloc(block)
  bytes.write(name, 0, 100, "utf8")
  bytes.write(prefix, 345, 155, "utf8")
  bytes.write("0000444\0", 100, "ascii")
  bytes.write("0000000\0", 108, "ascii")
  bytes.write("0000000\0", 116, "ascii")
  bytes.write(`${size.toString(8).padStart(11, "0")}\0`, 124, "ascii")
  bytes.write("00000000000\0", 136, "ascii")
  bytes.write("        ", 148, "ascii")
  if (type !== "\0") bytes.write(type, 156, "ascii")
  bytes.write("ustar\u000000", 257, "ascii")
  let sum = 0
  for (const byte of bytes) sum += byte
  bytes.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii")
  return bytes
}

/**
 * One tar entry. `pax` stores the path (and `paxSize` the size, with a zero
 * octal size field) in a PAX extended header; `prefix` splits the name into
 * the ustar prefix field; `type` overrides the regular-file type flag.
 */
export interface TarFile {
  readonly name: string
  readonly body: Buffer | string
  readonly pax?: boolean
  readonly paxSize?: boolean
  readonly prefix?: string
  readonly type?: string
}

/** Serializes regular files into a ustar archive with its end-of-archive marker. */
export const tar = (files: ReadonlyArray<TarFile>): Buffer => {
  const parts: Array<Buffer> = []
  const entry = (name: string, body: Buffer, type = "0", prefix = "", size = body.length) => {
    parts.push(header(name, size, type, prefix), body, Buffer.alloc((block - (body.length % block)) % block))
  }
  const record = (key: string, value: string) => {
    const text = ` ${key}=${value}\n`
    let length = text.length
    while (`${length}${text}`.length !== length) length = `${length}${text}`.length
    return `${length}${text}`
  }
  for (const file of files) {
    const body = Buffer.isBuffer(file.body) ? file.body : Buffer.from(file.body, "utf8")
    const records = [
      ...(file.pax === true ? [record("path", file.name)] : []),
      ...(file.paxSize === true ? [record("size", String(body.length))] : [])
    ]
    if (records.length > 0) entry("PaxHeader", Buffer.from(records.join(""), "utf8"), "x")
    entry(
      file.pax === true ? "placeholder" : file.name,
      body,
      file.type,
      file.prefix,
      file.paxSize === true ? 0 : body.length
    )
  }
  parts.push(Buffer.alloc(2 * block))
  return Buffer.concat(parts)
}

const digest = (body: Buffer | string) => `sha256:${createHash("sha256").update(body).digest("hex")}`
const blob = (value: string) => `blobs/sha256/${value.slice("sha256:".length)}`

/** Digests of the image an archive holds. */
export interface ArchiveDigests {
  readonly manifest: string
  readonly config: string
  readonly layers: ReadonlyArray<string>
}

/**
 * Builds an image archive: one image per platform under an index, plus an
 * attestation manifest when `attestation` is set.
 */
export const imageArchive = (options: {
  readonly platforms?: ReadonlyArray<string>
  readonly dockerManifest?: boolean
  readonly attestation?: boolean
  readonly nested?: boolean
  readonly pax?: boolean
  readonly seed?: string
} = {}): { readonly bytes: Buffer; readonly images: ReadonlyArray<ArchiveDigests> } => {
  const files: Array<TarFile> = [{ name: "oci-layout", body: "{\"imageLayoutVersion\":\"1.0.0\"}" }]
  const images: Array<ArchiveDigests> = []
  const descriptors: Array<unknown> = []
  for (const platform of options.platforms ?? ["linux/arm64"]) {
    const [os, architecture] = platform.split("/")
    const layer = `layer ${platform} ${options.seed ?? ""}`
    const config = JSON.stringify({ architecture, os, rootfs: { type: "layers", diff_ids: [digest(layer)] } })
    const manifest = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { mediaType: "application/vnd.oci.image.config.v1+json", digest: digest(config), size: config.length },
      layers: [{ mediaType: "application/vnd.oci.image.layer.v1.tar", digest: digest(layer), size: layer.length }]
    })
    files.push(
      { name: blob(digest(layer)), body: layer, pax: options.pax ?? false },
      { name: blob(digest(config)), body: config },
      { name: blob(digest(manifest)), body: manifest }
    )
    images.push({ manifest: digest(manifest), config: digest(config), layers: [digest(layer)] })
    descriptors.push({
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: digest(manifest),
      size: manifest.length,
      platform: { architecture, os }
    })
  }
  if (options.attestation === true) {
    const statement = "{}"
    const manifest = JSON.stringify({ schemaVersion: 2, config: { digest: digest(statement) }, layers: [] })
    files.push({ name: blob(digest(statement)), body: statement }, { name: blob(digest(manifest)), body: manifest })
    descriptors.push({
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      digest: digest(manifest),
      size: manifest.length,
      platform: { architecture: "unknown", os: "unknown" },
      annotations: { "vnd.docker.reference.type": "attestation-manifest" }
    })
  }
  let top: ReadonlyArray<unknown> = descriptors
  if (options.nested === true) {
    const inner = JSON.stringify({
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: descriptors
    })
    files.push({ name: blob(digest(inner)), body: inner })
    top = [{ mediaType: "application/vnd.oci.image.index.v1+json", digest: digest(inner), size: inner.length }]
  }
  files.push({
    name: "index.json",
    body: JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: top })
  })
  if (options.dockerManifest === true) {
    files.push({
      name: "manifest.json",
      body: JSON.stringify(images.map((image) => ({
        Config: blob(image.config),
        RepoTags: null,
        Layers: image.layers.map(blob)
      })))
    })
  }
  return { bytes: tar(files), images }
}

/** Writes {@link imageArchive} to `path` and returns the digests of its images. */
export const writeImageArchive = async (
  path: string,
  options: Parameters<typeof imageArchive>[0] = {}
): Promise<ReadonlyArray<ArchiveDigests>> => {
  const archive = imageArchive(options)
  await Fs.writeFile(path, archive.bytes)
  return archive.images
}
