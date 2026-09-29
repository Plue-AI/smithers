/**
 * The error class the integration adapters raise.
 *
 * `SmithersError` carries a machine-readable {@link SmithersErrorCode}, a
 * human summary, caller-supplied `details`, and a documentation URL appended
 * to the message. It stores context verbatim and does not redact it.
 * Integration adapters must remove credentials before constructing it.
 * Adapters subclass it to add their own typed fields and their own Effect
 * tag; callers classify with the tag or the code rather than by matching
 * message text.
 *
 * @since 1.0.0
 */

import * as Data from "effect/Data"
import { ERROR_REFERENCE_URL, isSmithersErrorCode, type SmithersErrorCode } from "./ErrorCode.ts"

/**
 * Construction options for a {@link SmithersError}.
 *
 * @category models
 * @since 1.0.0
 */
export interface SmithersErrorOptions<Tag extends string = string> {
  /**
   * Stored verbatim and not redacted. A cause of `undefined` is treated as no
   * cause, so the instance has no own `cause` property and a log or
   * `util.inspect` output has no `[cause]` line. A subclass may therefore
   * always include the key. Redact provider text such as a bot token in a URL
   * or an API key in a message before attaching it.
   */
  readonly cause?: unknown
  /** Set `false` to leave the documentation URL out of the message. */
  readonly includeDocsUrl?: boolean
  /**
   * The `name` the error reports and its Effect `_tag`. Defaults to
   * `"SmithersError"`. Both are installed as non-enumerable own properties,
   * like `Error.prototype.name`, and `details` is an own property only when
   * the caller supplies one.
   */
  readonly name?: Tag
}

/**
 * The fields a {@link SmithersError} stores as enumerable own properties, in
 * this order.
 */
interface SmithersErrorFields {
  /** The machine-readable classification. */
  readonly code: SmithersErrorCode
  /** The message without the appended documentation URL. */
  readonly summary: string
  /** Where the code is documented. */
  readonly docsUrl: string
  /**
   * Caller-supplied context. The top-level record is copied and frozen at
   * construction, so adding, removing, or replacing a top-level key on the
   * caller's object afterwards cannot change it. Nested values are shared by
   * reference and are not deep-frozen, so a caller must not mutate an attached
   * nested record. Callers must redact credentials. Absent as an own property
   * when the caller supplies none.
   */
  readonly details?: Readonly<Record<string, unknown>> | undefined
}

const hidden = (target: object, key: PropertyKey, value: unknown): void => {
  Object.defineProperty(target, key, { value, enumerable: false, writable: true, configurable: true })
}

/**
 * A Smithers integration failure, and an Effect tagged error.
 *
 * `_tag` equals the reported `name`, so `Effect.catchTag("SmithersError")`
 * catches a base instance and `Effect.catchTag("IntegrationError")` catches
 * the adapter subclass that reports that name. A subclass passes its tag as
 * the type argument and the same string as `options.name`.
 *
 * @category errors
 * @since 1.0.0
 */
export class SmithersError<Tag extends string = string> extends Data.Error<SmithersErrorFields> {
  /**
   * The Effect tag, equal to the name given at construction. A non-enumerable
   * own property, so it stays out of `Object.keys` and JSON.
   */
  declare readonly _tag: Tag
  /**
   * The name the error reports. Installed by the constructor as a
   * non-enumerable own property; `declare` keeps this type-level so no class
   * field is emitted.
   */
  declare readonly name: string
  /**
   * Narrowed from the optional field so a caller reads `details` without an
   * `in` check. Absent as an own property when the caller supplies none.
   */
  declare readonly details: Readonly<Record<string, unknown>> | undefined

  constructor(
    code: SmithersErrorCode,
    summary: string,
    details?: Record<string, unknown>,
    options: SmithersErrorOptions<Tag> = {}
  ) {
    // The type closes the vocabulary only for checked TypeScript callers. A
    // cast or a JavaScript caller could otherwise mint an instance that passes
    // `isSmithersError` yet fails `hasSmithersErrorShape` and every classifier.
    if (!isSmithersErrorCode(code)) {
      throw new TypeError(`SmithersError: unknown error code ${JSON.stringify(String(code))}`)
    }
    const docsUrl = ERROR_REFERENCE_URL
    const suffix = ` See ${docsUrl}`
    // Only whitespace after a suffix copy is dropped. Whitespace the summary
    // itself ends with is kept, so rewrapping `message` restores it unchanged.
    let summaryWithoutDocsUrl = summary
    for (;;) {
      const candidate = summaryWithoutDocsUrl.trimEnd()
      if (!candidate.endsWith(suffix)) break
      summaryWithoutDocsUrl = candidate.slice(0, -suffix.length)
    }
    const message = options.includeDocsUrl === false || summaryWithoutDocsUrl.trim() === ""
      ? summaryWithoutDocsUrl
      : `${summaryWithoutDocsUrl}${suffix}`
    // `Data.Error` passes `message` to `Error` and copies every field onto the
    // instance in order. `message` is already an own non-enumerable property,
    // so the copy keeps it hidden; `cause` is installed below instead, because
    // `Data.Error` drops a falsy cause from `ErrorOptions`.
    super({
      message,
      code,
      summary: summaryWithoutDocsUrl,
      docsUrl,
      ...(details !== undefined ? { details: Object.freeze({ ...details }) } : {})
    } as SmithersErrorFields)
    // Subclasses reach here through `super`, so `new.target` is what restores
    // their prototype after `Error` resets it under a transpiled target.
    Object.setPrototypeOf(this, new.target.prototype)
    const name = options.name ?? "SmithersError"
    hidden(this, "name", name)
    hidden(this, "_tag", name)
    if (options.cause !== undefined) hidden(this, "cause", options.cause)
  }

  /** Only the enumerable fields, as `JSON.stringify` shows a plain `Error`. */
  override toJSON(): Record<string, unknown> {
    return Object.fromEntries(Object.entries(this))
  }
}

// `Data.Error` inspects as its JSON. Removing the hook restores Node's `Error`
// formatting: the stack, the enumerable fields, and a `[cause]` entry.
Object.defineProperty(SmithersError.prototype, Symbol.for("nodejs.util.inspect.custom"), {
  value: undefined,
  enumerable: false,
  writable: true,
  configurable: true
})

/**
 * Whether `value` is a {@link SmithersError}.
 *
 * This refinement uses `instanceof` only. It does not detect an instance
 * produced by a duplicate copy of this package.
 *
 * @category refinements
 * @since 1.0.0
 */
export const isSmithersError = (value: unknown): value is SmithersError => value instanceof SmithersError

/**
 * Whether `value` has the structural fields of a {@link SmithersError}.
 *
 * Use this refinement when a consumer must accept an instance produced by
 * another module instance and needs more assurance than a forgeable `name`
 * check. The value must still be an `Error` with a code from the documented
 * closed vocabulary and string summary and documentation URL fields.
 * `details`, when present, must be a non-null object.
 *
 * Inspecting the value runs caller code: a property getter, or a proxy trap
 * reached by the prototype lookup, belongs to whoever built the error. Every
 * read is inside a `try`, so an inspection that throws answers `false` instead
 * of escaping and replacing the failure being classified.
 *
 * @category refinements
 * @since 1.0.0
 */
export const hasSmithersErrorShape = (value: unknown): value is SmithersError => {
  try {
    if (!(value instanceof Error)) return false
    const details = (value as SmithersError).details
    return isSmithersErrorCode((value as SmithersError).code) &&
      typeof (value as SmithersError).summary === "string" &&
      typeof (value as SmithersError).docsUrl === "string" &&
      (details === undefined || (typeof details === "object" && details !== null && !Array.isArray(details)))
  } catch {
    return false
  }
}
