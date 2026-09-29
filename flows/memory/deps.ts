/**
 * Imports the dependency documentation a workspace declares (`docs` on
 * `S.Workspace` in `.smithers/WORKSPACE.ts`) into `.flows/wiki/deps/<name>/`,
 * where `memory` reads it as dependency pages. A wiki refresh runs it, so
 * memory itself never touches the network.
 *
 * Every source is pinned: a package's files are copied from the version its
 * lockfile installed, and a URL's bytes must hash to the declared SHA-256.
 * Each directory carries a `source.json` receipt naming the pin.
 */
import * as DependencyDocs from "@smthrs/targets/DependencyDocs"
import { Effect, FileSystem, Path, Schema } from "effect"
import { createHash } from "node:crypto"
import * as PackageDiscovery from "../../packages/smithers/build/build-cli/src/PackageDiscovery.ts"
import * as PackageLoader from "../../packages/smithers/build/build-cli/src/PackageLoader.ts"

/** Where imported pages live, relative to the repository root. */
export const directory = ".flows/wiki/deps"

/** The largest document one source may import. */
export const maxDocBytes = 256 * 1024

/** How long one URL may take to answer in full. */
export const fetchTimeoutMs = 30_000

export class DocsImportError extends Schema.TaggedError<DocsImportError>()("DocsImportError", {
  code: Schema.Literals(["workspace", "invalid", "missing", "digest", "fetch", "too_large"]),
  source: Schema.String,
  message: Schema.String
}) {}

/** What one import wrote. */
export interface Imported {
  readonly name: string
  readonly files: ReadonlyArray<string>
  readonly pin: string
}

/** A response larger than {@link maxDocBytes}, refused before or while it streamed. */
export class TooLarge extends Error {}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const messageOf = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

/**
 * The `docs` record of the workspace declaration, or `{}` when the
 * repository declares no workspace. The one workspace loader evaluates it
 * afresh on every call and validates the module as every `smthrs` verb does.
 */
export const declared = (root: string) =>
  Effect.tryPromise({
    try: async (): Promise<Readonly<Record<string, DependencyDocs.Declaration>>> => {
      const file = await PackageDiscovery.workspaceFileOf(root)
      if (file === undefined) return {}
      return (await PackageLoader.loadWorkspaceDeclaration(root, file)).docs ?? {}
    },
    catch: (cause) =>
      new DocsImportError({
        code: "workspace",
        source: "WORKSPACE.ts",
        message: `WORKSPACE.ts did not load: ${messageOf(cause)}`
      })
  })

/**
 * Re-runs the declaration rules on a source: the declaration was evaluated in
 * another module namespace, so its brand proves nothing here.
 */
const revalidate = (name: string, source: DependencyDocs.Declaration) =>
  Effect.try({
    try: (): DependencyDocs.Declaration => {
      const value = source as Partial<DependencyDocs.PackageDocs> & Partial<DependencyDocs.UrlDocs>
      if (value._tag === "DocsPackage") return DependencyDocs.Package(value.package!, { files: value.files! })
      if (value._tag === "DocsUrl") return DependencyDocs.Url(value.url!, { sha256: value.sha256! })
      throw new TypeError("not an S.Docs declaration")
    },
    catch: (cause) => new DocsImportError({ code: "invalid", source: name, message: messageOf(cause) })
  })

const Manifest = Schema.Struct({ version: Schema.NonEmptyString })

/** Whether `child` is `parent` or lies beneath it. */
const within = (path: Path.Path, parent: string, child: string) => {
  const relative = path.relative(parent, child)
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))
}

const importPackage = (root: string, name: string, source: DependencyDocs.PackageDocs) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const refuse = (code: DocsImportError["code"], message: string) =>
      new DocsImportError({ code, source: name, message })
    const modules = path.join(root, "node_modules")
    const base = path.resolve(modules, source.package)
    if (!within(path, modules, base) || base === modules) {
      return yield* refuse("invalid", `${source.package} resolves outside node_modules`)
    }
    const manifest = yield* fs.readFileString(path.join(base, "package.json")).pipe(
      Effect.mapError(() => refuse("missing", `${source.package} is not installed`))
    )
    const { version } = yield* Effect.try({
      try: () => JSON.parse(manifest) as unknown,
      catch: () => refuse("missing", `${source.package}/package.json is not JSON`)
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Manifest)),
      Effect.mapError((error) =>
        error instanceof DocsImportError ? error : refuse("missing", `${source.package}/package.json names no version`)
      )
    )
    // pnpm links node_modules/<package> elsewhere, so confinement is checked
    // on real paths: no file, or symlink inside the package, may leave it.
    const realBase = yield* fs.realPath(base).pipe(
      Effect.mapError(() => refuse("missing", `${source.package} is not installed`))
    )
    const files: Array<{ name: string; bytes: Uint8Array }> = []
    const seen = new Set<string>()
    for (const relative of source.files) {
      const file = path.resolve(base, relative)
      const real = within(path, base, file) ? yield* fs.realPath(file).pipe(Effect.option) : undefined
      if (real === undefined) return yield* refuse("invalid", `${relative} resolves outside ${source.package}`)
      if (real._tag === "None") return yield* refuse("missing", `${source.package} has no ${relative}`)
      if (!within(path, realBase, real.value)) {
        return yield* refuse("invalid", `${relative} resolves outside ${source.package}`)
      }
      const info = yield* fs.stat(real.value).pipe(
        Effect.mapError(() => refuse("missing", `${relative} is unreadable`))
      )
      if (info.type !== "File") return yield* refuse("missing", `${source.package} has no file ${relative}`)
      if (info.size > BigInt(maxDocBytes)) {
        return yield* refuse("too_large", `${relative} exceeds ${maxDocBytes} bytes`)
      }
      const bytes = yield* fs.readFile(real.value).pipe(
        Effect.mapError(() => refuse("missing", `${relative} is unreadable`))
      )
      if (bytes.byteLength > maxDocBytes) return yield* refuse("too_large", `${relative} exceeds ${maxDocBytes} bytes`)
      const flat = relative.replaceAll("\\", "/").replaceAll("/", "__")
      // One directory holds every file; a case-insensitive filesystem merges names that differ only in case.
      if (seen.has(flat.toLowerCase())) {
        return yield* refuse("invalid", `${relative} collides with another file as ${flat}`)
      }
      seen.add(flat.toLowerCase())
      files.push({ name: flat, bytes })
    }
    return { files, pin: `${source.package}@${version}` }
  })

const importUrl = (name: string, source: DependencyDocs.UrlDocs, fetchBytes: (url: string) => Promise<Uint8Array>) =>
  Effect.gen(function*() {
    const tooLarge = () =>
      new DocsImportError({ code: "too_large", source: name, message: `${source.url} exceeds ${maxDocBytes} bytes` })
    const bytes = yield* Effect.tryPromise({
      try: () => fetchBytes(source.url),
      catch: (cause) =>
        cause instanceof TooLarge
          ? tooLarge()
          : new DocsImportError({ code: "fetch", source: name, message: messageOf(cause) })
    })
    if (bytes.byteLength > maxDocBytes) return yield* tooLarge()
    const digest = sha256(bytes)
    if (digest !== source.sha256) {
      return yield* new DocsImportError({
        code: "digest",
        source: name,
        message: `${source.url} hashed to ${digest}, not the declared ${source.sha256}`
      })
    }
    const file = new URL(source.url).pathname.split("/").pop() || "index.md"
    return { files: [{ name: /\.mdx?$/i.test(file) ? file : `${file}.md`, bytes }], pin: `sha256:${digest}` }
  })

/**
 * Fetches one document: no redirect, at most `timeoutMs` in full, and never
 * more than {@link maxDocBytes} + 1 bytes read. A declared or streamed body
 * over the limit rejects with {@link TooLarge}.
 */
export const fetchBounded = async (url: string, timeoutMs = fetchTimeoutMs): Promise<Uint8Array> => {
  const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${url} answered ${response.status}`)
  }
  if (Number(response.headers.get("content-length") ?? 0) > maxDocBytes) {
    await response.body?.cancel()
    throw new TooLarge(`${url} declares more than ${maxDocBytes} bytes`)
  }
  const chunks: Array<Uint8Array> = []
  let total = 0
  if (response.body !== null) {
    const reader = response.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      total += value.byteLength
      if (total > maxDocBytes) {
        await reader.cancel()
        throw new TooLarge(`${url} streamed more than ${maxDocBytes} bytes`)
      }
    }
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

/**
 * Imports every declared source into `root/.flows/wiki/deps`, replacing each
 * source's directory whole, and removes directories no longer declared. The
 * first failing source fails the import before anything is written. Verified
 * bytes are written unchanged, and the receipt hashes those bytes.
 */
export const importDocs = (
  root: string,
  docs: Readonly<Record<string, DependencyDocs.Declaration>>,
  fetchBytes: (url: string) => Promise<Uint8Array> = (url) => fetchBounded(url)
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const names = Object.keys(docs).sort()
    const read = yield* Effect.forEach(names, (name) =>
      Effect.flatMap(revalidate(name, docs[name]!), (source) =>
        Effect.map(
          source._tag === "DocsPackage" ? importPackage(root, name, source) : importUrl(name, source, fetchBytes),
          (result) => ({ name, source, ...result })
        )))
    const base = path.join(root, directory)
    yield* fs.makeDirectory(base, { recursive: true })
    for (
      const stale of (yield* fs.readDirectory(base)).filter((entry) =>
        !names.includes(entry)
      )
    ) {
      yield* fs.remove(path.join(base, stale), { recursive: true })
    }
    const imported: Array<Imported> = []
    for (const entry of read) {
      const target = path.join(base, entry.name)
      yield* fs.remove(target, { recursive: true, force: true })
      yield* fs.makeDirectory(target, { recursive: true })
      for (const file of entry.files) yield* fs.writeFile(path.join(target, file.name), file.bytes)
      yield* fs.writeFileString(
        path.join(target, "source.json"),
        JSON.stringify(
          {
            source: entry.source,
            pin: entry.pin,
            files: entry.files.map((file) => ({ name: file.name, sha256: sha256(file.bytes) }))
          },
          null,
          2
        ) + "\n"
      )
      imported.push({ name: entry.name, files: entry.files.map((file) => file.name), pin: entry.pin })
    }
    return imported
  })

/** Reads the workspace declaration and imports what it declares. */
export const importDeclared = (root: string, fetchBytes?: (url: string) => Promise<Uint8Array>) =>
  Effect.flatMap(declared(root), (docs) => importDocs(root, docs, fetchBytes))
