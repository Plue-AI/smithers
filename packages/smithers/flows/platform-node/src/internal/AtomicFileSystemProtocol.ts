/**
 * The adapter's half of the helper wire protocol: the request frame it sends,
 * the response frame it accepts, and the typed value or `PlatformError` each
 * operation's answer decodes to. Every check a helper answer has to pass lives
 * here, so a malformed or hostile response fails closed in one place.
 * @since 1.0.0
 */

import type * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import { Effect, type FileSystem, Option, PlatformError, Result } from "effect"
import * as ByteSize from "effect/ByteSize"
import type { Limits } from "../AtomicFileSystem.ts"

/**
 * One helper answer: a value, or a rejection carrying the errno name and the
 * syscall the helper observed.
 * @private
 * @since 1.0.0
 */
export interface HelperResult {
  readonly ok: boolean
  readonly value?: unknown
  readonly code?: string | null
  readonly syscall?: string | null
  readonly badArgument?: boolean
  readonly message?: string
}

/**
 * The `module` every `PlatformError` this adapter reports names.
 * @private
 * @since 1.0.0
 */
export const moduleName = "AtomicFileSystem"

const protocol = "flows-atomic/1"
/**
 * Room for `flows-atomic/1 <digits>\n` above the payload ceiling.
 * @private
 * @since 1.0.0
 */
export const frameHeaderBytes = 64
const decimal = /^[0-9]+$/
const fatalUtf8 = new TextDecoder("utf-8", { fatal: true })

/**
 * The errno-to-reason table `@effect/platform-node` applies to a Node
 * `ErrnoException`, so a caller reads the same typed reason it would get from
 * the native filesystem. `EPERM` and `ENOTSUP` are added because they are how
 * this helper reports its own refusals — outside the pinned root, a hard link,
 * a symlink, a special file, the root itself, or a host without
 * descriptor-relative POSIX. `EFBIG` and `ENXIO` are how it reports a payload
 * over the documented limit and a write-only open of a reader-less FIFO.
 * `EPROTO` is a framing failure and stays fail-closed. `EOPNOTSUPP` is the
 * same number as `ENOTSUP` on Linux, where which of the two names Python
 * reports for it is an implementation detail.
 */
const reasons: Record<string, PlatformError.SystemErrorTag | undefined> = {
  EACCES: "PermissionDenied",
  EBUSY: "Busy",
  EEXIST: "AlreadyExists",
  EFBIG: "BadResource",
  EISDIR: "BadResource",
  ELOOP: "BadResource",
  ENOENT: "NotFound",
  ENOTDIR: "BadResource",
  ENOTSUP: "PermissionDenied",
  ENXIO: "BadResource",
  EOPNOTSUPP: "PermissionDenied",
  EPERM: "PermissionDenied",
  EPROTO: "PermissionDenied"
}

/**
 * A request framed for the helper: one atomic operation, or one member of a
 * batch. The two protocols name their operands differently — a batch `glob`
 * carries the `path` it expands where an atomic `glob` carries a `pattern` —
 * so the reporting helpers read the operand by narrowing on the operation
 * rather than by taking whichever of three optional fields happened to be set.
 * @private
 * @since 1.0.0
 */
export type FramedRequest = KernelFileSystem.AtomicRequest | KernelFileSystem.AtomicBatchRequest

/** The operand a framed request names, for a failure's `pathOrDescriptor`. */
const operand = (request: FramedRequest): string | undefined =>
  "path" in request ?
    request.path :
    request.operation === "rename" ?
    request.from :
    request.operation === "glob" ?
    request.pattern :
    undefined

/**
 * A rejection carrying no errno is a transport or host failure — an absent
 * helper, a killed child, output that is not a helper result — and stays
 * `PermissionDenied` so the boundary fails closed rather than reporting a
 * benign-looking reason for an operation that never ran.
 * @private
 * @since 1.0.0
 */
export const failure = (
  request: FramedRequest,
  cause: unknown,
  rejection?: HelperResult
): PlatformError.PlatformError => {
  const method = request.operation
  if (rejection?.badArgument === true) {
    return PlatformError.badArgument({ module: moduleName, method, description: rejection.message, cause })
  }
  const code = rejection?.code ?? undefined
  return PlatformError.systemError({
    module: moduleName,
    method,
    pathOrDescriptor: operand(request),
    // `@effect/platform-node` sets `syscall` on every system error it reports,
    // so a consumer that switches on it has to read a populated field here too.
    // It names the operation's own syscall rather than whichever of the calls
    // that operation makes actually raised, so it says what was attempted, not
    // which step failed. A transport failure names no syscall at all, because
    // no syscall ran.
    syscall: rejection?.syscall ?? undefined,
    _tag: code === undefined ? "PermissionDenied" : reasons[code] ?? "Unknown",
    // The cause is repeated into the description because a fail-closed refusal
    // that says only "failed closed" is unactionable: an absent helper, a
    // response over the limit, and a mangled frame all look alike otherwise.
    description: code === undefined
      ? `descriptor-relative filesystem isolation failed closed: ${String(cause)}`
      : rejection?.message,
    // Match the native Node adapter's errno contract. Artifact path checks
    // distinguish a non-link (EINVAL) from a helper or transport failure.
    cause: code === undefined ? cause : Object.assign(
      new Error(rejection?.message, { cause }),
      { code, syscall: rejection?.syscall }
    )
  })
}

/**
 * Frames a serialized request: the protocol tag, the body length, and the
 * request, content, and response ceilings the helper enforces on its side,
 * then the body.
 * @private
 * @since 1.0.0
 */
export const encode = (body: Buffer, limits: Limits): Buffer => {
  const header = Buffer.from(
    `${protocol} ${body.byteLength} ${limits.request} ${limits.content} ${limits.response}\n`,
    "ascii"
  )
  return Buffer.concat([header, body], header.byteLength + body.byteLength)
}

/**
 * Decodes one complete response frame into a result envelope. Anything that
 * is not exactly one well-formed frame within the response ceiling throws.
 * @private
 * @since 1.0.0
 */
export const decode = (frame: Buffer, limits: Limits): HelperResult => {
  const newline = frame.indexOf(10)
  if (newline < 0 || newline >= frameHeaderBytes) {
    throw new Error("atomic helper response is not framed")
  }
  const fields = frame.subarray(0, newline).toString("ascii").split(" ")
  if (fields.length !== 2 || fields[0] !== protocol) {
    throw new Error("atomic helper response carries an unknown protocol tag")
  }
  const declared = fields[1]!
  if (!decimal.test(declared)) {
    throw new Error(`atomic helper declared a non-decimal response length: ${declared}`)
  }
  const length = Number(declared)
  if (!Number.isSafeInteger(length) || length < 0 || length > limits.response) {
    throw new Error(`atomic helper declared an out-of-range response length: ${declared}`)
  }
  const body = frame.subarray(newline + 1)
  if (body.byteLength !== length) {
    // Fewer bytes is a truncated response (a killed helper); more is a second
    // frame appended to the first. Either way the stream is not one answer.
    throw new Error(`atomic helper declared ${length} response bytes and wrote ${body.byteLength}`)
  }
  // Decoded from the complete frame, so a multi-byte character split across
  // two stdout chunks is never mangled on the way in.
  return resultEnvelope(JSON.parse(fatalUtf8.decode(body)))
}

const resultEnvelope = (input: unknown): HelperResult => {
  const value = input as HelperResult
  if (value === null || typeof value !== "object" || typeof value.ok !== "boolean") {
    throw new Error("atomic helper response is not a result envelope")
  }
  if (value.code !== undefined && value.code !== null && typeof value.code !== "string") {
    throw new Error("atomic helper response carries a non-string error code")
  }
  if (value.syscall !== undefined && value.syscall !== null && typeof value.syscall !== "string") {
    throw new Error("atomic helper response carries a non-string syscall")
  }
  if (value.badArgument !== undefined && typeof value.badArgument !== "boolean") {
    throw new Error("atomic helper response carries a non-boolean badArgument flag")
  }
  if (value.message !== undefined && typeof value.message !== "string") {
    throw new Error("atomic helper response carries a non-string message")
  }
  return value
}

const record = (value: unknown, what: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object") {
    throw new Error(`atomic helper returned a non-object ${what}`)
  }
  return value as Record<string, unknown>
}

const finite = (value: unknown, field: string): number => {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`atomic helper returned a non-numeric ${field}`)
  }
  return value
}

const integer = (value: unknown, field: string): number => {
  const numeric = finite(value, field)
  if (!Number.isSafeInteger(numeric) || numeric < 0) {
    throw new Error(`atomic helper returned an out-of-range ${field}: ${numeric}`)
  }
  return numeric
}

const date = (value: unknown, field: string): Date => {
  const result = new Date(finite(value, field))
  if (!Number.isFinite(result.getTime())) {
    throw new Error(`atomic helper returned an out-of-range ${field}`)
  }
  return result
}

const size = (value: unknown, field: string): ByteSize.ByteSize => {
  if (typeof value === "string" && decimal.test(value)) {
    return ByteSize.bytes(BigInt(value))
  }
  return ByteSize.bytes(BigInt(integer(value, field)))
}

const optional = <A>(value: unknown, read: (value: unknown) => A): Option.Option<A> =>
  value === null || value === undefined ? Option.none() : Option.some(read(value))

/** Effect's own `FileSystem.File.Type`; anything else is a helper defect. */
const fileTypes = new Set<string>([
  "File",
  "Directory",
  "SymbolicLink",
  "BlockDevice",
  "CharacterDevice",
  "FIFO",
  "Socket",
  "Unknown"
])

const toInfo = (value: unknown): FileSystem.File.Info => {
  const info = record(value, "stat")
  if (!fileTypes.has(info.type as string)) {
    throw new Error(`atomic helper returned an unknown file type: ${String(info.type)}`)
  }
  return {
    type: info.type as FileSystem.File.Type,
    mtime: Option.some(date(info.mtime, "mtime")),
    atime: Option.some(date(info.atime, "atime")),
    birthtime: optional(info.birthtime, (raw) => date(raw, "birthtime")),
    dev: integer(info.dev, "dev"),
    ino: optional(info.ino, (raw) => integer(raw, "ino")),
    mode: integer(info.mode, "mode"),
    nlink: Option.some(integer(info.nlink, "nlink")),
    uid: Option.some(integer(info.uid, "uid")),
    gid: Option.some(integer(info.gid, "gid")),
    rdev: Option.some(integer(info.rdev, "rdev")),
    size: size(info.size, "size"),
    blksize: optional(info.blksize, (raw) => size(raw, "blksize")),
    blocks: optional(info.blocks, (raw) => integer(raw, "blocks"))
  }
}

const isBase64 = (encoded: string): boolean => {
  if (encoded.length % 4 !== 0) return false
  let end = encoded.length
  if (encoded.endsWith("=")) {
    end--
    if (encoded[end - 1] === "=") end--
  }
  // A repeated-group regexp exhausts V8's stack on ordinary multi-MiB reads.
  // Scan the alphabet once, excluding at most two trailing padding characters.
  for (let index = 0; index < end; index++) {
    const code = encoded.charCodeAt(index)
    if (
      !(code >= 65 && code <= 90) && !(code >= 97 && code <= 122) &&
      !(code >= 48 && code <= 57) && code !== 43 && code !== 47
    ) return false
  }
  return true
}

const toBytes = (value: unknown, limit: number): Uint8Array => {
  const payload = record(value, "read result")
  const encoded = payload.base64
  // Buffer.from silently drops characters it does not recognise, so the shape
  // is checked before the decode rather than inferred from its output.
  if (typeof encoded !== "string" || !isBase64(encoded)) {
    throw new Error("atomic helper returned a malformed base64 payload")
  }
  const bytes = Buffer.from(encoded, "base64")
  if (bytes.byteLength > limit) {
    throw new Error(`atomic helper returned ${bytes.byteLength} bytes, over the ${limit} byte read limit`)
  }
  return Uint8Array.from(bytes)
}

const toStringResult = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value.includes("\0")) {
    throw new Error(`atomic helper returned an invalid ${what}`)
  }
  return value
}

const maxListingEntries = 100_000

const toStringArray = (value: unknown, what: string): Array<string> => {
  if (!Array.isArray(value) || value.length > maxListingEntries) {
    throw new Error(`atomic helper returned an invalid ${what}`)
  }
  const result = value.map((entry) => toStringResult(entry, `${what} entry`))
  if (new Set(result).size !== result.length) {
    throw new Error(`atomic helper returned duplicate ${what} entries`)
  }
  return result
}

/**
 * Converts a successful helper value into the result the request's operation
 * promises, and throws when the value does not have that shape.
 * @private
 * @since 1.0.0
 */
export const convert = <A>(
  request: FramedRequest,
  value: unknown,
  limits: Limits
): Effect.Effect<A, PlatformError.PlatformError> => {
  if (request.operation === "batch") {
    const response = record(value, "batch")
    const requests = request.requests
    if (
      response.rootIdentity !== request.rootIdentity || !Array.isArray(response.entries) ||
      response.entries.length !== requests.length
    ) {
      throw new Error("atomic helper returned a foreign or incomplete batch")
    }
    const seen = new Set<number>()
    let previous = ""
    let previousIndex = -1
    const pending = response.entries.map((raw) => {
      const entry = record(raw, "batch entry")
      const index = integer(entry.index, "batch index")
      const member = requests[index]
      if (
        member === undefined || seen.has(index) || entry.path !== member.path ||
        member.path < previous || (member.path === previous && index <= previousIndex)
      ) {
        throw new Error("atomic helper returned an invalid batch member identity or order")
      }
      seen.add(index)
      previous = member.path
      previousIndex = index
      if (Buffer.byteLength(JSON.stringify(entry.result), "utf8") > limits.batchEntry) {
        throw new Error("atomic helper returned an oversized batch entry")
      }
      const envelope = resultEnvelope(entry.result)
      const identity = { index, path: member.path }
      if (!envelope.ok) {
        return Effect.succeed({
          ...identity,
          result: Result.fail(failure(member, new Error(envelope.message ?? "atomic batch member failed"), envelope))
        })
      }
      if (member.operation === "digest") {
        const measured = record(envelope.value, "digest")
        if (typeof measured.digest !== "string" || !/^[a-f0-9]{64}$/.test(measured.digest)) {
          throw new Error("atomic helper returned an invalid SHA-256 digest")
        }
        const sizeBytes = integer(measured.sizeBytes, "digest size")
        if (sizeBytes > limits.content) throw new Error("atomic helper returned an oversized digest measurement")
        const bytes = member.content === true ? toBytes(measured, limits.content) : undefined
        if (bytes !== undefined && bytes.length !== sizeBytes) {
          throw new Error("atomic helper returned a mismatched digest size")
        }
        return Effect.succeed({
          ...identity,
          result: Result.succeed<KernelFileSystem.AtomicBatchValue>({
            operation: "digest",
            digest: measured.digest,
            sizeBytes,
            ...(bytes === undefined ? {} : { bytes })
          })
        })
      }
      return Effect.map(convert(member, envelope.value, limits), (converted) => ({
        ...identity,
        result: Result.succeed<KernelFileSystem.AtomicBatchValue>(
          member.operation === "stat"
            ? { operation: "stat", info: converted as FileSystem.File.Info }
            : member.operation === "resolve"
            ? { operation: "resolve", resolution: converted as KernelFileSystem.Resolution }
            : { operation: member.operation, paths: (converted as Array<string>).sort() }
        )
      }))
    })
    return Effect.map(Effect.all(pending), (entries) => ({ rootIdentity: response.rootIdentity, entries }) as A)
  }
  if (request.operation === "readFile" || request.operation === "readFileString") {
    // An empty file encodes to an empty string, so the payload is read by
    // shape: truthiness would return the raw envelope for it instead.
    const bytes = toBytes(value, limits.content)
    if (request.operation === "readFile") {
      return Effect.succeed(bytes as A)
    }
    try {
      return Effect.succeed(new TextDecoder(request.encoding).decode(bytes) as A)
    } catch (cause) {
      // Effect's own `readFileString` reports a rejected encoding as a
      // BadArgument, not as a filesystem failure.
      return Effect.fail(PlatformError.badArgument({
        module: "FileSystem",
        method: "readFileString",
        description: "invalid encoding",
        cause
      }))
    }
  }
  if (request.operation === "stat") {
    return Effect.succeed(toInfo(value) as A)
  }
  if (request.operation === "exists") {
    if (typeof value !== "boolean") {
      throw new Error("atomic helper returned a non-boolean exists result")
    }
    return Effect.succeed(value as A)
  }
  if (request.operation === "readLink" || request.operation === "realPath") {
    return Effect.succeed(toStringResult(value, `${request.operation} result`) as A)
  }
  if (request.operation === "resolve") {
    const resolution = record(value, "resolve result")
    const target = resolution.target === null ? null : toStringResult(resolution.target, "resolve target")
    const answer: KernelFileSystem.Resolution = { path: toStringResult(resolution.path, "resolve path"), target }
    return Effect.succeed(answer as A)
  }
  if (request.operation === "readDirectory" || request.operation === "glob") {
    return Effect.succeed(toStringArray(value, `${request.operation} result`) as A)
  }
  if (
    request.operation === "writeFile" ||
    request.operation === "writeFileString" ||
    request.operation === "chmod" ||
    request.operation === "chown" ||
    request.operation === "makeDirectory" ||
    request.operation === "remove" ||
    request.operation === "rename"
  ) {
    if (value !== null) {
      throw new Error(`atomic helper returned a non-null ${request.operation} result`)
    }
    return Effect.succeed(undefined as A)
  }
  throw new Error(
    `atomic helper returned success for unsupported operation ${(request as FramedRequest).operation}`
  )
}
