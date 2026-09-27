/**
 * Portable discovery of markdown and module-backed flows.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 *
 * Discovery follows symbolic links when the host `FileSystem.stat` does,
 * confined to `Source.confinementRoot` when real paths are available. A
 * visited-directory identity set stops cycles and aliases, while a 32-segment
 * depth ceiling bounds hosts that cannot supply stable directory identities.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import * as ByteSize from "effect/ByteSize"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import {
  BodyRefModule,
  DiscoveryWarning,
  FlowDescriptor,
  type ModuleImport,
  Provenance,
  SchemaRefModule,
  SchemaRefNone,
  type Source,
  SourceScan
} from "./Descriptor.ts"
import * as Frontmatter from "./internal/Frontmatter.ts"
import * as ModuleClosure from "./internal/ModuleClosure.ts"
import * as ModuleMetadata from "./internal/ModuleMetadata.ts"
import * as Names from "./internal/Names.ts"
import * as MarkdownFlow from "./MarkdownFlow.ts"
import type { DiscoveryError } from "./RegistryError.ts"
import { discoveryError } from "./RegistryError.ts"

/**
 * Discovers flow descriptors from a configured source without loading their
 * bodies into the returned scan.
 *
 * @category services
 * @since 0.1.0
 */
export interface Discovery {
  readonly scan: (source: Source) => Effect.Effect<SourceScan, DiscoveryError>
}

/**
 * Service tag for portable flow discovery.
 *
 * @category services
 * @since 0.1.0
 */
export const Discovery: Context.Service<Discovery, Discovery> = Context.Service("flows/registry/Discovery")

const entryPrecedence = ["flow.ts", "flow.mdx", "SKILL.md"] as const

/**
 * Root directories a path-named source never reads as flows.
 *
 * At a project root `channels` and `connections` are the host's own
 * directories rather than flow directories, so a path-named scan skips them.
 * See `docs/concepts/sources.md`.
 */
const hostReservedRootDirectories = new Set(["channels", "connections"])

/**
 * Directory entries whose `stat` is in flight at once.
 *
 * Every entry costs one host round trip, so statting them one at a time makes
 * a scan pay a full round trip per file, including every resource file under a
 * skill directory that can never be an entry. Sixteen overlaps a directory's
 * round trips without spending a deep tree's descriptor budget; the results are
 * folded in sorted order, so what the scan reports is unchanged.
 */
const statConcurrency = 16

const warning = (
  code: DiscoveryWarning["code"],
  path: string,
  message: string,
  name?: string,
  cause?: unknown
): DiscoveryWarning =>
  new DiscoveryWarning({
    code,
    path,
    message,
    ...(name === undefined ? {} : { name }),
    ...(cause === undefined ? {} : { cause })
  })

const metadataReadLimit = 64 * 1024
const markdownMetadataChunkSize = 512
const moduleMetadataChunkSize = 8 * 1024

/**
 * Maximum complete entry size admitted to discovery and content hashing.
 *
 * Four MiB leaves ample room for authored metadata and bodies while refusing
 * build artifacts or hostile entries before `readFile` allocates their bytes.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const entrySizeLimit = 4 * 1024 * 1024

/**
 * Maximum number of entry-name segments traversed below a source root.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const maximumTraversalDepth = 32

/** The one wording both entry-size refusals use, so a consumer sees one message. */
const oversizedEntry = (location: string, size: bigint | number): string =>
  `Entry "${location}" is ${size} bytes, exceeding the ${entrySizeLimit}-byte discovery input ceiling`

/**
 * Either an entry's metadata, or the reason it was refused unread.
 *
 * `Oversized` carries the byte length actually read, which is what the
 * `entry_too_large` warning reports when a host's reported size was wrong.
 */
type EntryMetadata =
  | { readonly _tag: "Oversized"; readonly size: number }
  | {
    readonly _tag: "Metadata"
    readonly contentDigest: string
    /** The decoded prefix the metadata parsers read. */
    readonly text: string
    /**
     * The complete decoded source, for a module entry only.
     *
     * The metadata parsers stop at the default declaration, but an import can
     * sit anywhere in the file, so pinning what a module loads beside itself
     * needs the whole text rather than the prefix.
     */
    readonly source: string | undefined
  }

/**
 * Reads just enough of an entry file to decide its metadata.
 *
 * The complete admitted file is read because discovery also hashes every body,
 * so `visit` refuses an entry whose REPORTED size is past `entrySizeLimit`
 * before this function allocates anything. That check is a fast path, not the
 * bound: it trusts `stat`, and a host that under-reports or omits a size — an
 * in-memory or remote `FileSystem`, a special file — would otherwise walk
 * straight past the ceiling. So the bytes actually read are measured here, and
 * an oversized entry is refused before it is hashed, decoded, or parsed.
 * `metadataReadLimit` separately bounds how much of an admitted entry's bytes
 * is decoded and parsed. Module prefixes use larger chunks to avoid repeatedly
 * tokenizing hundreds of nearly identical 512-byte prefixes.
 */
const readMetadata = (
  fs: FileSystem.FileSystem,
  location: string,
  kind: "markdown" | "module"
) =>
  fs.readFile(location).pipe(
    Effect.map((bytes): EntryMetadata => {
      if (bytes.length > entrySizeLimit) {
        return { _tag: "Oversized", size: bytes.length }
      }
      const contentDigest = Digest.digest(bytes)
      const decoder = new TextDecoder()
      const chunkSize = kind === "module" ? moduleMetadataChunkSize : markdownMetadataChunkSize
      const parseLimit = Math.min(bytes.length, metadataReadLimit)
      let text = ""
      for (let offset = 0; offset < parseLimit; offset += chunkSize) {
        text += decoder.decode(bytes.subarray(offset, Math.min(offset + chunkSize, parseLimit)), { stream: true })
        const complete = kind === "markdown"
          ? Frontmatter.isMetadataComplete(text)
          : ModuleMetadata.isComplete(text)
        if (complete) break
      }
      return {
        _tag: "Metadata",
        contentDigest,
        text: text + decoder.decode(),
        source: kind === "module" ? new TextDecoder().decode(bytes) : undefined
      }
    })
  )

const compareWarnings = (left: DiscoveryWarning, right: DiscoveryWarning): number => {
  if (left.path !== right.path) {
    return left.path < right.path ? -1 : 1
  }
  if (left.code !== right.code) {
    return left.code < right.code ? -1 : 1
  }
  return left.message < right.message ? -1 : left.message > right.message ? 1 : 0
}

const directoryIdentity = (info: FileSystem.File.Info, location: string): string =>
  `${info.dev}:${Option.getOrElse(info.ino, () => location)}`

/**
 * Creates a discovery service from portable file-system and path services.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (fs: FileSystem.FileSystem, path: Path.Path): Discovery =>
  Discovery.of({
    scan: Effect.fn("Discovery.scan")((source) =>
      Effect.gen(function*() {
        const provenance = new Provenance({ source: source.source, root: source.root })
        // Sibling flows in one project share most of their imports, so the
        // closure walk reads and tokenizes each reached module once per scan.
        const closures = ModuleClosure.cache()
        const entries: Array<FlowDescriptor> = []
        const warnings: Array<DiscoveryWarning> = []

        const realRoot = source.confinementRoot === undefined
          ? undefined
          : yield* Effect.result(fs.realPath(source.confinementRoot))
        const withinRoot = Effect.fnUntraced(function*(location: string) {
          if (realRoot === undefined || Result.isFailure(realRoot)) return true
          const realLocation = yield* Effect.result(fs.realPath(location))
          if (Result.isFailure(realLocation)) return true
          const root = path.resolve(realRoot.success)
          const candidate = path.resolve(realLocation.success)
          if (candidate !== root && !candidate.startsWith(path.join(root, path.sep))) {
            warnings.push(warning(
              "outside_root",
              location,
              `Path "${location}" resolves outside confinement root "${realRoot.success}"`
            ))
            return false
          }
          return true
        })

        const exists = yield* fs.exists(source.root).pipe(
          Effect.mapError((cause) =>
            discoveryError({
              code: "read_failed",
              method: "scan",
              path: source.root,
              description: `could not access source root "${source.root}"`,
              cause
            })
          )
        )
        if (!exists) {
          if (source.optionalRoot === true) return new SourceScan({ entries, warnings })
          return yield* Effect.fail(
            discoveryError({
              code: "root_missing",
              method: "scan",
              path: source.root,
              description: `source root "${source.root}" does not exist`
            })
          )
        }

        const rootInfo = yield* fs.stat(source.root).pipe(
          Effect.mapError((cause) =>
            discoveryError({
              code: "read_failed",
              method: "scan",
              path: source.root,
              description: `could not inspect source root "${source.root}"`,
              cause
            })
          )
        )
        if (rootInfo.type !== "Directory") {
          return yield* Effect.fail(
            discoveryError({
              code: "invalid_root",
              method: "scan",
              path: source.root,
              description: `source root "${source.root}" is not a directory`
            })
          )
        }

        if (!(yield* withinRoot(source.root))) {
          return new SourceScan({ entries, warnings })
        }

        const rootEntries = yield* fs.readDirectory(source.root).pipe(
          Effect.mapError((cause) =>
            discoveryError({
              code: "read_failed",
              method: "scan",
              path: source.root,
              description: `could not read source root "${source.root}"`,
              cause
            })
          )
        )

        /**
         * Projects one selected entry file's already-read metadata into a
         * descriptor, or into the warnings that refuse it.
         *
         * Reading the bytes, refusing an oversized entry, and confinement stay
         * with the caller, so what is left here is the naming and metadata
         * rules of the two entry kinds. Both spell the path-derived name as
         * `Names.deriveFromPath`, so the naming rule lives in one place.
         */
        const projectEntry = (
          directory: string,
          location: string,
          selected: (typeof entryPrecedence)[number],
          contents: Extract<EntryMetadata, { readonly _tag: "Metadata" }>,
          segments: ReadonlyArray<string>,
          imports: ReadonlyArray<ModuleImport>
        ): {
          readonly descriptor: Option.Option<FlowDescriptor>
          readonly warnings: ReadonlyArray<DiscoveryWarning>
        } => {
          const pathName = Names.deriveFromPath(segments)
          if (selected !== "flow.ts") {
            return MarkdownFlow.fromMarkdown({
              text: contents.text,
              contentDigest: contents.contentDigest,
              path: location,
              baseDirectory: directory,
              naming: source.naming,
              name: pathName,
              dirBasename: path.basename(directory),
              provenance
            })
          }

          const metadata = ModuleMetadata.parse(contents.text)
          // A root-level entry in a path-named source is refused before the
          // read, so a module reaching here always has a path name; a
          // frontmatter-named source names it after its directory instead.
          const name = Option.getOrElse(
            source.naming === "path" ? pathName : Option.none<string>(),
            () => path.basename(directory)
          )
          const warnings: Array<DiscoveryWarning> = []
          for (const item of metadata.warnings) {
            warnings.push(warning("unsupported_module_metadata", location, item.message, name))
          }
          // `Flow.make` requires a name, because the name is the tag the flow,
          // its action, and every plan that records a call carry. In a
          // path-named source the registry name is the path, so a module that
          // declares the same string is saying one thing twice and nothing is
          // ignored. A module that declares a different one is: the path still
          // wins, and the author has to be told which name the registry
          // answers to. A name this reader cannot evaluate is warned about for
          // the same reason, because it cannot be shown to agree.
          if (
            source.naming === "path" && metadata.declaresName &&
            !Option.contains(metadata.declaredName, name)
          ) {
            warnings.push(
              warning(
                "name_field_ignored",
                location,
                "Ignoring Flow.make name because this source uses path-derived names",
                name
              )
            )
          }
          if (metadata.description === undefined) {
            warnings.push(
              warning(
                "missing_description",
                location,
                "Module flows require a literal description in the default Flow.make value",
                name
              )
            )
            return { descriptor: Option.none(), warnings }
          }
          return {
            descriptor: Option.some(
              new FlowDescriptor({
                name,
                description: metadata.description,
                body: new BodyRefModule({
                  path: location,
                  contentDigest: contents.contentDigest,
                  // Absent, not empty, when the entry loads nothing beside
                  // itself: such a module keeps the identity it had before a
                  // closure was recorded at all.
                  ...(imports.length === 0 ? {} : { imports })
                }),
                input: metadata.hasInput
                  ? new SchemaRefModule({ path: location, field: "input" })
                  : new SchemaRefNone({}),
                output: metadata.hasOutput
                  ? new SchemaRefModule({ path: location, field: "output" })
                  : new SchemaRefNone({}),
                model: metadata.model,
                flows: metadata.flows,
                capabilities: metadata.capabilities,
                effects: metadata.effects,
                placement: metadata.placement,
                modelInvocable: metadata.modelInvocable,
                path: location,
                frontmatter: {},
                provenance
              })
            ),
            warnings
          }
        }

        const visit: (
          directory: string,
          segments: ReadonlyArray<string>,
          directoryOrigins: Map<string, string>,
          initialEntries?: ReadonlyArray<string>
        ) => Effect.Effect<void> =
          // Untraced because recursive directory traversal is a scan hot path.
          Effect.fnUntraced(function*(
            directory,
            segments,
            directoryOrigins,
            initialEntries
          ) {
            if (segments.length > maximumTraversalDepth) {
              warnings.push(
                warning(
                  "max_depth_exceeded",
                  directory,
                  `Directory "${directory}" exceeds the maximum discovery depth of ${maximumTraversalDepth} entry-name segments`
                )
              )
              return
            }

            const directoryEntries = initialEntries === undefined
              ? yield* Effect.result(fs.readDirectory(directory))
              : Result.succeed(initialEntries)

            if (Result.isFailure(directoryEntries)) {
              warnings.push(
                warning(
                  "unreadable",
                  directory,
                  `Could not read directory "${directory}"`,
                  undefined,
                  directoryEntries.failure
                )
              )
              return
            }

            const stats = yield* Effect.forEach(
              [...directoryEntries.success].sort(),
              (entry) =>
                Effect.map(
                  Effect.result(fs.stat(path.join(directory, entry))),
                  (info) => [entry, info] as const
                ),
              { concurrency: statConcurrency }
            )

            const files = new Map<string, FileSystem.File.Info>()
            const directories: Array<{
              readonly name: string
              readonly location: string
              readonly identity: string
            }> = []
            for (const [entry, info] of stats) {
              const location = path.join(directory, entry)
              if (Result.isFailure(info)) {
                warnings.push(
                  warning("unreadable", location, `Could not inspect "${location}"`, undefined, info.failure)
                )
                continue
              }
              if (info.success.type === "File") {
                files.set(entry, info.success)
                continue
              }
              if (info.success.type !== "Directory") {
                continue
              }
              if (
                entry === "node_modules" ||
                entry.startsWith(".") ||
                (segments.length === 0 &&
                  source.naming === "path" &&
                  hostReservedRootDirectories.has(entry))
              ) {
                continue
              }
              directories.push({ name: entry, location, identity: directoryIdentity(info.success, location) })
            }

            const candidates = entryPrecedence.filter((entry) => files.has(entry))
            const selected = candidates[0]
            if (selected !== undefined && (yield* withinRoot(path.join(directory, selected)))) {
              const location = path.join(directory, selected)
              const selectedInfo = files.get(selected)!
              if (candidates.length > 1) {
                warnings.push(
                  warning(
                    "multiple_entry_files",
                    directory,
                    `Multiple entry files found (${candidates.join(", ")}); using ${selected}`
                  )
                )
              }

              if (segments.length === 0 && source.naming === "path") {
                warnings.push(
                  warning(
                    "root_level_entry",
                    location,
                    "Path-named sources cannot contain a root-level entry"
                  )
                )
              } else if (selectedInfo.size > ByteSize.bytes(entrySizeLimit)) {
                warnings.push(
                  warning("entry_too_large", location, oversizedEntry(location, selectedInfo.size))
                )
              } else {
                const contents = yield* Effect.result(
                  readMetadata(fs, location, selected === "flow.ts" ? "module" : "markdown")
                )
                if (Result.isFailure(contents)) {
                  warnings.push(
                    warning(
                      "unreadable",
                      location,
                      `Could not read entry metadata from "${location}"`,
                      undefined,
                      contents.failure
                    )
                  )
                } else if (contents.success._tag === "Oversized") {
                  // The reported size was wrong. The bytes are the authority,
                  // so the entry is refused with the same code and wording the
                  // stat path uses, before anything hashes or parses them.
                  warnings.push(
                    warning("entry_too_large", location, oversizedEntry(location, contents.success.size))
                  )
                } else {
                  const imports = contents.success.source === undefined
                    ? []
                    : yield* ModuleClosure.collect(fs, path, location, contents.success.source, closures)
                  const projected = projectEntry(
                    directory,
                    location,
                    selected,
                    contents.success,
                    segments,
                    imports
                  )
                  warnings.push(...projected.warnings)
                  Option.match(projected.descriptor, {
                    onNone: () => undefined,
                    onSome: (descriptor) => entries.push(descriptor)
                  })
                }
              }
            }

            for (const child of directories) {
              if (!(yield* withinRoot(child.location))) continue
              const ancestor = directoryOrigins.get(child.identity)
              if (ancestor !== undefined) {
                warnings.push(
                  warning(
                    "symlink_cycle",
                    child.location,
                    `Directory "${child.location}" resolves to already visited directory "${ancestor}"; skipping recursive traversal`
                  )
                )
                continue
              }
              directoryOrigins.set(child.identity, child.location)
              yield* visit(child.location, [...segments, child.name], directoryOrigins)
            }
          })

        const rootIdentity = directoryIdentity(rootInfo, source.root)
        yield* visit(
          source.root,
          [],
          new Map([[rootIdentity, source.root]]),
          rootEntries
        )
        entries.sort((left, right) => Number(left.path > right.path) - Number(left.path < right.path))
        warnings.sort(compareWarnings)
        return new SourceScan({ entries, warnings })
      })
    )
  })

/**
 * Provides portable flow discovery from the current file-system and path
 * services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<Discovery, never, FileSystem.FileSystem | Path.Path> = Layer.effect(
  Discovery,
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return make(fs, path)
  })
)

/**
 * Creates an empty discovery stub with optional method overrides.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Discovery> = {}): Discovery =>
  Discovery.of({
    scan: Effect.fn("Discovery.scan")(() => Effect.succeed(new SourceScan({ entries: [], warnings: [] }))),
    ...overrides
  })

/**
 * Provides an empty discovery stub with optional method overrides.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Discovery> = {}): Layer.Layer<Discovery> =>
  Layer.succeed(Discovery)(makeNoop(overrides))
