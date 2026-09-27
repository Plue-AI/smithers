/**
 * Workspace configuration declared in the root PACKAGE.ts file.
 *
 * A configuration value is inert: {@link Workspace} validates its fields and
 * performs no I/O, so PACKAGE.ts evaluation stays pure. The CLI discovers the
 * declaration and resolves it against the `--cache-dir` flag. The CLI passes
 * the result explicitly to input expansion and tool execution as host state.
 *
 * The resolved cache directory is explicit host state rather than target attrs
 * on purpose. It names where scratch and cache files live on one host, so it
 * must never reach a cache key or a content digest.
 *
 * @since 0.1.0
 */

import * as NodeUtil from "node:util/types"
import type * as Attr from "./Attr.ts"
import type * as WorkspaceDeclaration from "./WorkspaceDeclaration.ts"

/**
 * Runtime marker for a workspace configuration declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("smithers-build/Workspace") as never

/**
 * The cache directory used when no PACKAGE.ts declaration and no flag name one.
 *
 * @category constants
 * @since 0.1.0
 */
export const defaultCacheDirectory = ".flows"

/**
 * Maximum UTF-8 size of a normalized cache-directory path.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumCacheDirectoryBytes = 4 * 1024

/**
 * Maximum UTF-8 size of one cache-directory path segment.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumCacheDirectorySegmentBytes = 255

/**
 * A pure workspace configuration declaration.
 *
 * `cacheDirectory` is a workspace-relative directory holding the result cache
 * and target scratch files. `gitignored` asks the CLI to keep a root
 * `.gitignore` entry for it.
 *
 * @category models
 * @since 0.1.0
 */
export interface Workspace {
  readonly [TypeId]: typeof TypeId
  readonly cacheDirectory: string
  readonly gitignored: boolean
  /**
   * The confinement every tool-running target executes under. `"none"` is
   * the explicit opt-out; `{}` is the default confinement (declared reads and
   * writes only, no network); `{ network: "loopback" }` and
   * `{ network: true }` open the network in steps.
   */
  readonly sandbox: Attr.Sandbox
  /** The mechanism that enforces the confinement, when the platform default is not wanted. */
  readonly sandboxes: WorkspaceDeclaration.SandboxesDeclaration | undefined
}

/**
 * Options accepted by {@link Workspace}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /** @default ".flows" */
  readonly cacheDirectory?: string | undefined
  /** @default false */
  readonly gitignored?: boolean | undefined
  /** @default "none" */
  readonly sandbox?: Attr.Sandbox | undefined
  /** @default undefined, meaning the platform's own mechanism */
  readonly sandboxes?: WorkspaceDeclaration.SandboxesDeclaration | undefined
}

const sandboxesTypeId = Symbol.for("smithers-build/Sandboxes")

const isSandboxesDeclaration = (value: unknown): value is WorkspaceDeclaration.SandboxesDeclaration => {
  if (typeof value !== "object" || value === null) return false
  const descriptor = Object.getOwnPropertyDescriptor(value, sandboxesTypeId)
  return descriptor !== undefined && "value" in descriptor && descriptor.value === sandboxesTypeId
}

/**
 * Checks whether a value is a sandbox policy: `"none"`, or an object whose
 * only member is an optional `network` of `true`, `false`, or `"loopback"`.
 *
 * @category guards
 * @since 0.1.0
 */
export const isSandboxPolicy = (value: unknown): value is Attr.Sandbox => {
  if (value === "none") return true
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  for (const name of Object.getOwnPropertyNames(value)) {
    if (name !== "network") return false
  }
  const network = (value as { readonly network?: unknown }).network
  return network === undefined || typeof network === "boolean" || network === "loopback"
}

const absolute = /^([/\\]|[A-Za-z]:)/

/**
 * Validates one declared cache directory and returns its normalized posix
 * form.
 *
 * The value names a single workspace-relative directory. Surrounding
 * whitespace, redundant separators, and `.` segments are dropped. An empty
 * value, an absolute path, and any `..` segment are refused, so the directory
 * can never escape the workspace.
 *
 * @category validation
 * @since 0.1.0
 */
export const normalizeCacheDirectory = (value: string): string => {
  if (typeof value !== "string") throw new TypeError("cacheDirectory must be a string")
  if (value.length > maximumCacheDirectoryBytes) {
    throw new Error(`cacheDirectory must be at most ${maximumCacheDirectoryBytes} UTF-8 bytes`)
  }
  const trimmed = value.trim()
  if (trimmed === "") throw new Error("cacheDirectory must not be empty")
  if (!trimmed.isWellFormed() || /[\u0000-\u001f\u007f]/.test(trimmed)) {
    throw new Error("cacheDirectory must be well-formed text without control characters")
  }
  if (absolute.test(trimmed)) throw new Error(`cacheDirectory must be workspace-relative: ${value}`)
  const segments = trimmed.split(/[/\\]/).filter((segment) => segment !== "" && segment !== ".")
  if (segments.length === 0) throw new Error("cacheDirectory must not be empty")
  if (segments.includes("..")) throw new Error(`cacheDirectory must not leave the workspace: ${value}`)
  const encoder = new TextEncoder()
  for (const segment of segments) {
    if (encoder.encode(segment).byteLength > maximumCacheDirectorySegmentBytes) {
      throw new Error(
        `cacheDirectory segments must be at most ${maximumCacheDirectorySegmentBytes} UTF-8 bytes`
      )
    }
  }
  const normalized = segments.join("/")
  if (encoder.encode(normalized).byteLength > maximumCacheDirectoryBytes) {
    throw new Error(`cacheDirectory must be at most ${maximumCacheDirectoryBytes} UTF-8 bytes`)
  }
  return normalized
}

/**
 * Creates a pure workspace configuration declaration using PACKAGE.ts syntax.
 *
 * @example
 * ```ts
 * import { Workspace } from "@smthrs/targets/Config"
 *
 * export const workspace = Workspace({
 *   cacheDirectory: ".flows",
 *   gitignored: true
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const Workspace = (options: Options = {}): Workspace => {
  if (
    typeof options !== "object" || options === null || NodeUtil.isProxy(options) ||
    (Object.getPrototypeOf(options) !== Object.prototype && Object.getPrototypeOf(options) !== null)
  ) throw new TypeError("Workspace options must be a plain object")
  const names = Object.getOwnPropertyNames(options)
  if (Object.getOwnPropertySymbols(options).length > 0) {
    throw new TypeError("Workspace options must not contain symbol properties")
  }
  for (const name of names) {
    if (name !== "cacheDirectory" && name !== "gitignored" && name !== "sandbox" && name !== "sandboxes") {
      throw new TypeError(`Workspace received unknown option ${JSON.stringify(name)}`)
    }
  }
  const read = (name: "cacheDirectory" | "gitignored" | "sandbox" | "sandboxes"): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(options, name)
    if (descriptor === undefined) return undefined
    if (!("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`Workspace option ${name} must be an enumerable data property`)
    }
    return descriptor.value
  }
  const cacheDirectory = read("cacheDirectory")
  const gitignored = read("gitignored")
  const sandbox = read("sandbox")
  const sandboxes = read("sandboxes")
  if (cacheDirectory !== undefined && typeof cacheDirectory !== "string") {
    throw new TypeError("Workspace option cacheDirectory must be a string")
  }
  if (gitignored !== undefined && typeof gitignored !== "boolean") {
    throw new TypeError("Workspace option gitignored must be a boolean")
  }
  if (sandbox !== undefined && !isSandboxPolicy(sandbox)) {
    throw new TypeError(
      "Workspace option sandbox must be \"none\" or { network?: boolean | \"loopback\" }"
    )
  }
  if (sandboxes !== undefined && !isSandboxesDeclaration(sandboxes)) {
    throw new TypeError("Workspace option sandboxes must be an S.Sandboxes declaration")
  }
  return Object.freeze<Workspace>({
    [TypeId]: TypeId,
    cacheDirectory: cacheDirectory === undefined
      ? defaultCacheDirectory
      : normalizeCacheDirectory(cacheDirectory),
    gitignored: gitignored ?? false,
    sandbox: sandbox === undefined
      ? "none"
      : sandbox === "none"
      ? "none"
      : Object.freeze({ ...(sandbox.network === undefined ? {} : { network: sandbox.network }) }),
    sandboxes
  })
}

/**
 * Checks whether a PACKAGE.ts export is a workspace configuration declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isWorkspace = (value: unknown): value is Workspace => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const own = (key: PropertyKey): unknown => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    return descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
  }
  return own(TypeId) === TypeId &&
    typeof own("cacheDirectory") === "string" &&
    typeof own("gitignored") === "boolean" &&
    (own("sandbox") === undefined || isSandboxPolicy(own("sandbox"))) &&
    (own("sandboxes") === undefined || isSandboxesDeclaration(own("sandboxes")))
}
