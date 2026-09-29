/**
 * Dependency documentation a workspace declares for agent memory:
 * `S.Docs.Package` and `S.Docs.Url`.
 *
 * A workspace names each source under `docs` in `WORKSPACE.ts`. A wiki
 * refresh imports them into `.flows/wiki/deps/<name>/`, and `memory` reads
 * them from there as dependency pages; memory itself never fetches. Every
 * source is pinned: a package by the version its lockfile installed, a URL by
 * the SHA-256 digest of its bytes.
 *
 * @since 1.0.0
 */

/**
 * A package-relative Markdown path: no control character, no absolute or
 * drive-rooted start, and no `..` segment on either separator.
 */
const isPackageFile = (file: unknown): file is string =>
  typeof file === "string" && !/[\0-\x1f\x7f]/.test(file) && !/^(?:[\\/]|[A-Za-z]:)/.test(file) &&
  file.split(/[\\/]/).every((segment) => segment !== "..") && /\.mdx?$/i.test(file)

/** An npm package name, scoped or not; legacy names may carry uppercase letters. */
const packageName = /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/

/** Brands the declarations this module made; a look-alike object is not one. */
const TypeId: unique symbol = Symbol("smithers-build/DependencyDocs")

const brand = <A extends object>(value: A): A => {
  Object.defineProperty(value, TypeId, { configurable: false, enumerable: false, value: TypeId, writable: false })
  return Object.freeze(value)
}

/** A lowercase hex SHA-256 digest. */
const hexDigest = /^[0-9a-f]{64}$/

/** An absolute https URL with no whitespace. */
const httpsUrl = /^https:\/\/\S+$/

/**
 * Markdown files of an installed package, read from `node_modules`.
 *
 * @category models
 * @since 1.0.0
 */
export interface PackageDocs {
  readonly _tag: "DocsPackage"
  readonly package: string
  readonly files: ReadonlyArray<string>
}

/**
 * One Markdown document at a URL, pinned by digest.
 *
 * @category models
 * @since 1.0.0
 */
export interface UrlDocs {
  readonly _tag: "DocsUrl"
  readonly url: string
  readonly sha256: string
}

/**
 * One declared documentation source.
 *
 * @category models
 * @since 1.0.0
 */
export type Declaration = PackageDocs | UrlDocs

/**
 * Declares Markdown files of an installed package; `README.md` when `files`
 * is absent.
 *
 * @category constructors
 * @since 1.0.0
 */
export const Package = (name: string, options: { readonly files?: ReadonlyArray<string> } = {}): PackageDocs => {
  if (typeof name !== "string" || !packageName.test(name)) {
    throw new TypeError(`S.Docs.Package needs an npm package name: ${JSON.stringify(String(name).slice(0, 256))}`)
  }
  const files = options.files ?? ["README.md"]
  if (
    !Array.isArray(files) || files.length === 0 ||
    !files.every(isPackageFile)
  ) {
    throw new TypeError("S.Docs.Package files must be package-relative Markdown paths")
  }
  return brand({ _tag: "DocsPackage", package: name, files: Object.freeze([...new Set(files)]) })
}

/**
 * Declares one Markdown document at an https URL, pinned by the SHA-256 of
 * its bytes.
 *
 * @category constructors
 * @since 1.0.0
 */
export const Url = (url: string, options: { readonly sha256: string }): UrlDocs => {
  if (typeof url !== "string" || !httpsUrl.test(url)) {
    throw new TypeError("S.Docs.Url needs an https URL")
  }
  if (typeof options?.sha256 !== "string" || !hexDigest.test(options.sha256)) {
    throw new TypeError("S.Docs.Url needs the lowercase hex sha256 of the document")
  }
  return brand({ _tag: "DocsUrl", url, sha256: options.sha256 })
}

/**
 * Whether a value is a source `Package` or `Url` declared; an object that
 * only carries the same `_tag` is not.
 *
 * @category guards
 * @since 1.0.0
 */
export const isDeclaration = (value: unknown): value is Declaration => {
  if (typeof value !== "object" || value === null) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, TypeId)
  return descriptor !== undefined && "value" in descriptor && descriptor.value === TypeId
}
