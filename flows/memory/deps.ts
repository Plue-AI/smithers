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
import * as PackageDiscovery from "@smthrs/build-cli/PackageDiscovery"
import * as PackageLoader from "@smthrs/build-cli/PackageLoader"
import { Fault } from "@smthrs/flow"
import * as DependencyDocs from "@smthrs/targets/DependencyDocs"
import { Effect, FileSystem, Path, Schema } from "effect"
import { createHash } from "node:crypto"

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
Fault.register(
  "DocsImportError",
  {
    workspace: "user",
    invalid: "user",
    missing: "user",
    digest: "user",
    fetch: "infra",
    too_large: "policy"
  } satisfies Fault.Rows<DocsImportError["code"]>
)

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

/**
 * Imported files travel to agent checkouts as ordinary wiki pages: a wiki
 * refresh publishes each one ({@link publishedPages}), the stack hands its
 * published pages to every stack request, and the request writes these back
 * under {@link directory} in its own checkout ({@link installPages}). A page's
 * title is where it lives, `deps/<name>/<file>`, and its id is that path
 * slugged under `dep-`; its first line names the pin. A lane gets the pages
 * of the last published main, so a dependency upgrade reaches it with the
 * next refresh. The pages also show in the cloud wiki; a person's edit there
 * stays in the cloud wiki and never reaches a lane.
 */
const pageTitle = /^deps\/([A-Za-z0-9][A-Za-z0-9._-]*)\/([^/\\\p{Cc}]+\.mdx?)$/iu
/**
 * The most bytes all dependency pages together may take: a quarter of the
 * 64 KiB of wiki the stack hands a lane, so the repository's own pages keep
 * the rest.
 */
export const maxPageBytes = 16 * 1024

/** Whether a wiki page is an imported dependency file. */
export const isDependencyPage = (page: { readonly id: string; readonly title: string }) =>
  page.id.startsWith("dep-") && pageTitle.test(page.title)

/** One imported file as a wiki page. */
export interface DependencyPage {
  readonly id: string
  readonly title: string
  readonly body: string
  /** The pin and the file's SHA-256: the page is unchanged while both are. */
  readonly inputDigest: string
  readonly contentDigest: string
}

/**
 * The Markdown files a refresh imported under `root`, as pages, verified
 * against each source's receipt. Refuses a set a lane could not be handed
 * whole: a page over {@link maxPageBytes}, all of them together over it, or
 * two whose ids collide.
 */
export const publishedPages = (root: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const refuse = (source: string, message: string) => new DocsImportError({ code: "invalid", source, message })
    const base = path.join(root, directory)
    if (!(yield* fs.exists(base))) return []
    const Receipt = Schema.Struct({
      pin: Schema.String,
      files: Schema.Array(Schema.Struct({ name: Schema.String, sha256: Schema.String }))
    })
    const pages: Array<DependencyPage> = []
    let total = 0
    for (const name of (yield* fs.readDirectory(base)).sort()) {
      const receipt = yield* fs.readFileString(path.join(base, name, "source.json")).pipe(
        Effect.flatMap((text) =>
          Effect.try({ try: () => JSON.parse(text) as unknown, catch: () => refuse(name, "source.json is not JSON") })
        ),
        Effect.flatMap(Schema.decodeUnknownEffect(Receipt)),
        Effect.mapError((error) =>
          error instanceof DocsImportError ? error : refuse(name, `${directory}/${name} has no import receipt`)
        )
      )
      for (const file of receipt.files) {
        const title = `deps/${name}/${file.name}`
        if (!pageTitle.test(title)) return yield* refuse(name, `${file.name} cannot be a wiki page`)
        const bytes = yield* fs.readFile(path.join(base, name, file.name)).pipe(
          Effect.mapError(() => refuse(name, `${file.name} was not imported`))
        )
        if (sha256(bytes) !== file.sha256) return yield* refuse(name, `${file.name} changed after it was imported`)
        const id = `dep-${`${name}-${file.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")}`
        if (id.length > 81 || pages.some((page) => page.id === id)) {
          return yield* refuse(name, `${file.name} has no page id of its own (${id})`)
        }
        const body = `<!-- ${receipt.pin} -->\n${new TextDecoder().decode(bytes)}`
        // What the lane is handed is the body, pin line and all.
        total += new TextEncoder().encode(body).byteLength
        if (total > maxPageBytes) {
          return yield* new DocsImportError({
            code: "too_large",
            source: name,
            message: `dependency docs exceed ${maxPageBytes} bytes, their share of what a lane is handed`
          })
        }
        pages.push({
          id,
          title,
          body,
          inputDigest: sha256(new TextEncoder().encode(`${receipt.pin}\n${file.sha256}`)),
          contentDigest: sha256(new TextEncoder().encode(body))
        })
      }
    }
    return pages
  })

/**
 * Writes the dependency pages a stack request was handed into `root`'s
 * {@link directory}, replacing what was there, so `memory` in this checkout
 * reads them as it reads a local import. Other pages are ignored. It
 * refuses a `.flows`, `.flows/wiki` or deps directory that is a link, so it
 * never removes or writes outside the checkout.
 */
export const installPages = (
  root: string,
  pages: ReadonlyArray<{ readonly id: string; readonly title: string; readonly body: string }>
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const base = path.join(root, directory)
    const realRoot = yield* fs.realPath(root)
    for (const relative of [".flows", ".flows/wiki", directory]) {
      const at = path.join(root, relative)
      if ((yield* fs.exists(at)) && (yield* fs.realPath(at)) !== path.join(realRoot, relative)) {
        return yield* new DocsImportError({ code: "invalid", source: relative, message: `${relative} is a link` })
      }
    }
    yield* fs.remove(base, { recursive: true, force: true })
    for (const page of pages.filter(isDependencyPage)) {
      const [, name, file] = pageTitle.exec(page.title)!
      yield* fs.makeDirectory(path.join(base, name!), { recursive: true })
      yield* fs.writeFileString(path.join(base, name!, file!), page.body)
    }
  })
