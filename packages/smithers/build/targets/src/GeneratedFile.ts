/**
 * The shared write-file and check-file actions used by every target that
 * generates a checked-in file from PACKAGE.ts attrs.
 *
 * This module used to also carry `PackageJsonGen`, a target that rendered a
 * manifest out of a fixed attrs struct. {@link PackageJson.PackageJson}
 * subsumes it: a package declares one manifest value, the workspace resolves
 * its labels, and the check and write halves become separate targets with
 * separate verbs.
 *
 * @since 0.1.0
 */

import { Action, type FlowRuntime } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import type * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import { randomUUID } from "node:crypto"
import * as NodeFs from "node:fs"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import * as NodeUtil from "node:util/types"
import * as Input from "./Input.ts"
import * as SafeFs from "./SafeFs.ts"

/**
 * Output handling for a generated file. `write` emits the file. `check`
 * compares the checked-in file and fails on drift. The constructor default
 * is `write`.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Mode = Schema.Literals(["write", "check"]).pipe(
  Schema.withConstructorDefault(Effect.succeed("write" as const))
)

/**
 * Output handling for a generated file.
 *
 * @category models
 * @since 0.1.0
 */
export type Mode = typeof Mode.Type

/**
 * Payload for one generated file: a workspace-relative path and the full
 * generated contents.
 *
 * @category schemas
 * @since 0.1.0
 */
export const FilePayload = Schema.Struct({
  path: Schema.NonEmptyString,
  contents: Schema.String
})

/**
 * Payload for one generated file.
 *
 * @category models
 * @since 0.1.0
 */
export type FilePayload = typeof FilePayload.Type

/**
 * A generated file could not be written.
 *
 * @category errors
 * @since 0.1.0
 */
export class WriteFileError extends Schema.TaggedError<WriteFileError>()(
  "smithers-build/WriteFileError",
  {
    path: Schema.NonEmptyString,
    message: Schema.NonEmptyString
  }
) {}

/**
 * A checked-in file is missing or differs from its generated form.
 *
 * @category errors
 * @since 0.1.0
 */
export class DriftError extends Schema.TaggedError<DriftError>()(
  "smithers-build/DriftError",
  {
    path: Schema.NonEmptyString,
    message: Schema.NonEmptyString,
    /**
     * Why the check failed, as a stable code rather than prose.
     *
     * `missing` and `drifted` are both answered by regenerating the file.
     * `unreadable` is not: a permissions failure, a symlink where a generated
     * file belongs, invalid UTF-8, or an oversized file all reach this error,
     * and calling any of them drift would send an operator to regenerate a
     * file whose problem regeneration does not touch.
     *
     * Required, not optional: an optional discriminator left every public
     * error flow free to report the reasonless value this field exists to
     * eliminate, so a caller still had to read the prose to tell the three
     * apart.
     */
    reason: Schema.Literals(["missing", "drifted", "unreadable"])
  }
) {}

/**
 * Why one generated-file check failed.
 *
 * @category models
 * @since 0.1.0
 */
export type DriftReason = DriftError["reason"]

/**
 * Constructs a typed generated-file drift failure.
 *
 * @category constructors
 * @since 0.1.0
 */
export const driftError = (path: string, message: string, reason: DriftReason): DriftError =>
  new DriftError({ path, message, reason })

/**
 * Writes one generated file.
 *
 * @category actions
 * @since 0.1.0
 */
export const WriteFile = Action.make("smithers-build/write-file", {
  payload: FilePayload,
  error: WriteFileError,
  tier: "sealed"
})

/**
 * Compares one generated file against its checked-in form.
 *
 * @category actions
 * @since 0.1.0
 */
export const CheckFile = Action.make("smithers-build/check-file", {
  payload: FilePayload,
  error: DriftError,
  tier: "sealed"
})

/**
 * Maximum code units one rendered failure may add to a diagnostic.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumFailureMessageCodeUnits = 64 * 1024

const boundedFailureText = (message: string): string => {
  const wellFormed = message.isWellFormed() ? message : message.toWellFormed()
  if (wellFormed === "") return "unknown failure"
  return wellFormed.length <= maximumFailureMessageCodeUnits
    ? wellFormed
    : `${wellFormed.slice(0, maximumFailureMessageCodeUnits - 3)}...`
}

/**
 * Renders a failure cause as a bounded non-empty message without invoking
 * object getters, proxy traps, or user-defined string conversion.
 *
 * @category rendering
 * @since 0.1.0
 */
export const failureMessage = (cause: unknown): string => {
  if (typeof cause === "string") return boundedFailureText(cause)
  if (
    typeof cause === "number" ||
    typeof cause === "bigint" ||
    typeof cause === "boolean" ||
    typeof cause === "symbol"
  ) return boundedFailureText(String(cause))
  if ((typeof cause !== "object" && typeof cause !== "function") || cause === null || NodeUtil.isProxy(cause)) {
    return "unknown failure"
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(cause, "message")
    return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
      ? boundedFailureText(descriptor.value)
      : "unknown failure"
  } catch {
    return "unknown failure"
  }
}

const combinedFailure = (primary: unknown, secondary: unknown, secondaryLabel: string): Error =>
  new Error(
    `${failureMessage(primary)}; ${secondaryLabel}: ${failureMessage(secondary)}`,
    { cause: new AggregateError([primary, secondary]) }
  )

/**
 * Normalizes a generated output into one workspace-relative path.
 *
 * A leading `//` uses the declared-input workspace-root notation. Native
 * absolute paths and parent traversals are refused before an action is
 * planned, so a generator can never be pointed at a file outside the
 * workspace it belongs to.
 *
 * @category validation
 * @since 0.1.0
 */
export const resolveOutputPath = (path: string): string => {
  if (NodePath.isAbsolute(path) && !path.startsWith("//")) {
    throw new Error(`generated output must stay inside the workspace: ${path}`)
  }
  const resolved = Input.resolvePath("", path.startsWith("//") ? path : `//${path}`)
  if (resolved === "" || resolved === ".") {
    throw new Error(`generated output must name a file inside the workspace: ${path}`)
  }
  return resolved
}

/**
 * Hard in-memory ceiling for one generated file.
 *
 * @category constants
 * @since 0.1.0
 */
export const maximumGeneratedFileBytes = 16 * 1024 * 1024
const maximumGeneratedPathBytes = 16 * 1024
const maximumGeneratedPathDepth = 256

const validatePayload = (payload: FilePayload): { readonly path: string; readonly bytes: number } => {
  const path = resolveOutputPath(payload.path)
  const pathBytes = Buffer.byteLength(path, "utf8")
  if (pathBytes > maximumGeneratedPathBytes) {
    throw new Error(`generated output path exceeds ${maximumGeneratedPathBytes} UTF-8 bytes`)
  }
  const depth = path.split("/").length
  if (depth > maximumGeneratedPathDepth) {
    throw new Error(`generated output path exceeds ${maximumGeneratedPathDepth} components`)
  }
  if (!payload.contents.isWellFormed()) {
    throw new Error("generated contents contain an unpaired UTF-16 surrogate")
  }
  const bytes = Buffer.byteLength(payload.contents, "utf8")
  if (bytes > maximumGeneratedFileBytes) {
    throw new Error(`generated contents exceed ${maximumGeneratedFileBytes} bytes`)
  }
  return { path, bytes }
}

const identity = (stats: NodeFs.BigIntStats): string => `${stats.dev}:${stats.ino}`

interface ParentDirectory {
  readonly path: string
  readonly stats: NodeFs.BigIntStats
}

/** Resolves each parent component without ever accepting a directory link. */
const prepareParent = async (
  root: string,
  relative: string,
  create: boolean,
  signal: AbortSignal
): Promise<ParentDirectory | undefined> => {
  let current = root
  let currentStats = await Fs.lstat(current, { bigint: true })
  if (!currentStats.isDirectory() || currentStats.isSymbolicLink()) {
    throw new Error(`workspace root is not a real directory: ${root}`)
  }
  const parent = NodePath.dirname(relative).split(NodePath.sep).join("/")
  const segments = parent === "." ? [] : parent.split("/")
  for (const segment of segments) {
    signal.throwIfAborted()
    const candidate = NodePath.join(current, segment)
    let stats: NodeFs.BigIntStats
    try {
      stats = await Fs.lstat(candidate, { bigint: true })
    } catch (cause) {
      if (SafeFs.errorCode(cause) !== "ENOENT") throw cause
      if (!create) return undefined
      let created = false
      try {
        await Fs.mkdir(candidate)
        created = true
      } catch (mkdirCause) {
        if (SafeFs.errorCode(mkdirCause) !== "EEXIST") throw mkdirCause
      }
      if (created) await SafeFs.syncDirectory(current)
      stats = await Fs.lstat(candidate, { bigint: true })
    }
    if (stats.isSymbolicLink()) throw new Error(`generated output parent is a symbolic link: ${candidate}`)
    if (!stats.isDirectory()) throw new Error(`generated output parent is not a directory: ${candidate}`)
    const real = await Fs.realpath(candidate)
    if (!SafeFs.inside(root, real)) throw new Error(`generated output parent leaves the workspace: ${candidate}`)
    const resolvedStats = await Fs.lstat(real, { bigint: true })
    if (!resolvedStats.isDirectory() || identity(resolvedStats) !== identity(stats)) {
      throw new Error(`generated output parent changed while it was being resolved: ${candidate}`)
    }
    current = real
    currentStats = resolvedStats
  }
  return { path: current, stats: currentStats }
}

/** Rechecks the directory object held across temp-file publication. */
const checkParent = async (root: string, expected: ParentDirectory, signal: AbortSignal): Promise<void> => {
  signal.throwIfAborted()
  const real = await Fs.realpath(expected.path)
  const stats = await Fs.lstat(real, { bigint: true })
  if (
    !SafeFs.inside(root, real) ||
    real !== expected.path ||
    !stats.isDirectory() ||
    stats.isSymbolicLink() ||
    identity(stats) !== identity(expected.stats)
  ) {
    throw new Error(`generated output parent changed while the file was being published: ${expected.path}`)
  }
}

const openTemp = async (
  directory: string,
  base: string,
  mode: number,
  signal: AbortSignal
): Promise<{ readonly handle: Fs.FileHandle; readonly path: string }> => {
  const flags = NodeFs.constants.O_WRONLY |
    NodeFs.constants.O_CREAT |
    NodeFs.constants.O_EXCL |
    (NodeFs.constants.O_NOFOLLOW ?? 0)
  for (let attempt = 0; attempt < 4; attempt += 1) {
    signal.throwIfAborted()
    const path = NodePath.join(directory, `.${base}.${process.pid.toString(36)}.${randomUUID()}.tmp`)
    try {
      return { handle: await Fs.open(path, flags, mode), path }
    } catch (cause) {
      if (SafeFs.errorCode(cause) !== "EEXIST") throw cause
    }
  }
  throw new Error(`could not create a unique generated-file temporary in ${directory}`)
}

const writeFile = async (
  workspaceRoot: string,
  payload: FilePayload,
  signal: AbortSignal
): Promise<void> => {
  const validated = validatePayload(payload)
  const root = await SafeFs.canonicalRoot(workspaceRoot)
  const parent = await prepareParent(root, validated.path, true, signal)
  if (parent === undefined) throw new Error("generated output parent could not be created")
  const absolute = NodePath.join(parent.path, NodePath.basename(validated.path))
  let existing: NodeFs.BigIntStats | undefined
  try {
    existing = await Fs.lstat(absolute, { bigint: true })
  } catch (cause) {
    if (SafeFs.errorCode(cause) !== "ENOENT") throw cause
  }
  if (existing?.isSymbolicLink()) throw new Error(`generated output is a symbolic link: ${validated.path}`)
  if (existing !== undefined && !existing.isFile()) {
    throw new Error(`generated output is not a regular file: ${validated.path}`)
  }
  const mode = existing === undefined ? 0o666 : Number(existing.mode & 0o7777n)
  const temp = await openTemp(parent.path, NodePath.basename(absolute), mode, signal)
  let consumed = false
  let primary: unknown
  try {
    const opened = await temp.handle.stat({ bigint: true })
    const named = await Fs.lstat(temp.path, { bigint: true })
    const real = await Fs.realpath(temp.path)
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      identity(opened) !== identity(named) ||
      !SafeFs.inside(root, real)
    ) {
      throw new Error("generated-file temporary did not remain a private workspace file")
    }
    signal.throwIfAborted()
    await temp.handle.writeFile(payload.contents, "utf8")
    if (existing !== undefined) await temp.handle.chmod(mode)
    const written = await temp.handle.stat({ bigint: true })
    if (!written.isFile() || written.nlink !== 1n || written.size !== BigInt(validated.bytes)) {
      throw new Error("generated-file temporary did not contain the complete output")
    }
    await temp.handle.sync()
  } catch (cause) {
    primary = cause
  }
  try {
    await temp.handle.close()
  } catch (cause) {
    primary = primary === undefined ? cause : combinedFailure(primary, cause, "temporary file close also failed")
  }
  if (primary === undefined) {
    try {
      await checkParent(root, parent, signal)
      await Fs.rename(temp.path, absolute)
      consumed = true
      await SafeFs.syncDirectory(parent.path)
    } catch (cause) {
      primary = cause
    }
  }
  if (!consumed) {
    try {
      await Fs.rm(temp.path, { force: true })
    } catch (cause) {
      primary = primary === undefined
        ? cause
        : combinedFailure(primary, cause, "temporary file cleanup also failed")
    }
  }
  if (primary !== undefined) throw primary
}

/**
 * Writes contents to a sibling temp file, then renames it into place.
 *
 * Exported so every generator that renders its own contents publishes them the
 * same way, and so the publication itself stays directly testable.
 *
 * @category effects
 * @since 0.1.0
 */
export const writeGeneratedFile = (
  workspaceRoot: string,
  payload: FilePayload
): Effect.Effect<void, WriteFileError> =>
  Effect.tryPromise({
    try: (signal) => writeFile(workspaceRoot, payload, signal),
    catch: (cause) => new WriteFileError({ path: payload.path, message: failureMessage(cause) })
  })

/**
 * Publishes a generated symlink without traversing symlinked parent directories.
 * The link target is stored as text and is never opened.
 *
 * @category effects
 * @since 1.0.0
 */
export const writeGeneratedSymlink = (
  workspaceRoot: string,
  payload: { readonly path: string; readonly target: string }
): Effect.Effect<void, WriteFileError> =>
  Effect.tryPromise({
    try: async (signal) => {
      const validated = validatePayload({ path: payload.path, contents: payload.target })
      const root = await SafeFs.canonicalRoot(workspaceRoot)
      const parent = await prepareParent(root, validated.path, true, signal)
      if (parent === undefined) throw new Error("generated output parent could not be created")
      const absolute = NodePath.join(parent.path, NodePath.basename(validated.path))
      const temporary = NodePath.join(parent.path, `.${NodePath.basename(absolute)}.${randomUUID()}.tmp`)
      await checkParent(root, parent, signal)
      await Fs.symlink(payload.target, temporary)
      try {
        await checkParent(root, parent, signal)
        await Fs.rename(temporary, absolute)
        await SafeFs.syncDirectory(parent.path)
      } finally {
        // Cleanup must not follow a parent replaced while publication ran.
        await checkParent(root, parent, new AbortController().signal)
        await Fs.rm(temporary, { force: true })
      }
    },
    catch: (cause) => new WriteFileError({ path: payload.path, message: failureMessage(cause) })
  })

/**
 * Checks the link itself after proving its parents; never reads its target.
 *
 * @category effects
 * @since 1.0.0
 */
export const checkGeneratedSymlink = (
  workspaceRoot: string,
  payload: { readonly path: string; readonly target: string }
): Effect.Effect<void, DriftError> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: async (signal) => {
        const validated = validatePayload({ path: payload.path, contents: payload.target })
        const root = await SafeFs.canonicalRoot(workspaceRoot)
        const parent = await prepareParent(root, validated.path, false, signal)
        if (parent === undefined) return undefined
        await checkParent(root, parent, signal)
        const absolute = NodePath.join(parent.path, NodePath.basename(validated.path))
        try {
          const stats = await Fs.lstat(absolute)
          return stats.isSymbolicLink() ? await Fs.readlink(absolute) : null
        } catch (cause) {
          if (SafeFs.errorCode(cause) === "ENOENT") return undefined
          throw cause
        }
      },
      catch: (cause) => new DriftError({ path: payload.path, reason: "unreadable", message: failureMessage(cause) })
    }),
    (actual) =>
      actual === payload.target
        ? Effect.void
        : Effect.fail(
          new DriftError({
            path: payload.path,
            reason: actual === undefined ? "missing" : "drifted",
            message: actual === undefined ? "the generated link is missing" : "the generated link drifted"
          })
        )
  )

/**
 * Fails with {@link DriftError} unless the checked-in file matches.
 *
 * The failure carries a `reason`: `missing` and `drifted` are answered by
 * regenerating the file, `unreadable` never is.
 *
 * @category effects
 * @since 0.1.0
 */
export const checkGeneratedFile = (
  workspaceRoot: string,
  payload: FilePayload
): Effect.Effect<void, DriftError> =>
  Effect.flatMap(
    Effect.tryPromise({
      try: async (signal) => {
        const validated = validatePayload(payload)
        const root = await SafeFs.canonicalRoot(workspaceRoot)
        const parent = await prepareParent(root, validated.path, false, signal)
        if (parent === undefined) return undefined
        return SafeFs.readText(NodePath.join(parent.path, NodePath.basename(validated.path)), {
          root,
          signal,
          symlinks: "reject",
          limit: maximumGeneratedFileBytes,
          what: "generated file"
        })
      },
      catch: (cause) =>
        new DriftError({
          path: payload.path,
          reason: "unreadable",
          message: `the generated file could not be read: ${failureMessage(cause)}`
        })
    }),
    (actual) =>
      actual === payload.contents
        ? Effect.void
        : Effect.fail(
          new DriftError({
            path: payload.path,
            reason: actual === undefined ? "missing" : "drifted",
            message: actual === undefined
              ? "the generated file is missing"
              : "the checked-in file drifted from its generated form"
          })
        )
  )

/**
 * Implements {@link WriteFile} with an atomic write: contents go to a sibling
 * temp file that is renamed over the payload path. Parent directories are
 * created as needed. The payload path resolves against `workspaceRoot`.
 *
 * @category layers
 * @since 0.1.0
 */
export const WriteFileLive = (options: {
  readonly workspaceRoot: string
}): Layer.Layer<Action.Requirement<"smithers-build/write-file">, never, FlowRuntime.FlowRuntime> =>
  WriteFile.toLayer((payload) => writeGeneratedFile(options.workspaceRoot, payload))

/**
 * Implements {@link CheckFile} with a read and byte comparison. The payload
 * path resolves against `workspaceRoot`.
 *
 * @category layers
 * @since 0.1.0
 */
export const CheckFileLive = (options: {
  readonly workspaceRoot: string
}): Layer.Layer<Action.Requirement<"smithers-build/check-file">, never, FlowRuntime.FlowRuntime> =>
  CheckFile.toLayer((payload) => checkGeneratedFile(options.workspaceRoot, payload))

/**
 * What executing a generated-file node may require: the write or the check
 * implementation.
 *
 * @category models
 * @since 0.1.0
 */
export type FileRequirement =
  | Action.Requirement<"smithers-build/write-file">
  | Action.Requirement<"smithers-build/check-file">

/**
 * Plans one generated file: {@link WriteFile} in `write` mode,
 * {@link CheckFile} in `check` mode.
 *
 * @category constructors
 * @since 0.1.0
 */
export const generateFile = (
  mode: Mode,
  payload: FilePayload
): Node.Node<void, WriteFileError | DriftError, FileRequirement> =>
  mode === "check" ? CheckFile.call(payload) : WriteFile.call(payload)
