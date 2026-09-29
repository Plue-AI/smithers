/**
 * The redacting logger: the journal's redaction rules applied to log output.
 *
 * The journal redacts on the write path, so a credential a cell logs or
 * returns never reaches a committed row (`./Redaction.ts`). The operator's
 * terminal was the other place the same credential surfaces: every built-in
 * Effect logger renders through the fiber's `Console`, so an action that hands
 * a token to `Effect.logInfo` wrote it to stderr in full and it reached
 * whatever collected that stream.
 *
 * This module closes that half with the SAME rules rather than a second rule
 * set. {@link wrap} does not re-implement redaction and does not re-format a
 * log line. It redacts the log event itself — the message, the cause, and the
 * log annotations — before the wrapped logger is handed it, and it hands that
 * logger a view of the fiber whose `Console` is a redacting console, so
 * whatever the logger renders for itself — a pretty line, a JSON document —
 * passes through `Redaction.redact` on its way to the stream as well.
 *
 * Both halves carry load. Most built-in loggers write through the fiber's
 * `Console`, which is what covers the pretty line, the `--json` document, and
 * the `.flows/logs/<runId>.log` stream. But a logger is free to read the event
 * instead of rendering it, and one in Effect's own default logger set does:
 * `Logger.tracerLogger` publishes the message as a span event name and
 * `Cause.pretty` of the cause as the span's `effect.cause` attribute, and
 * never reads `Console` at all. Redacting only the console would hide a
 * credential on stderr and export it in clear to whatever OTLP collector is
 * configured.
 *
 * Cost is bounded by the rules themselves: every alternation inside a
 * repetition in `Redaction.diagnosticRules` starts its branches with disjoint
 * characters, so each rule is linear in the length of the line and no input
 * backtracks catastrophically.
 *
 * One deliberate difference from the journal write path. `Redaction.redact`
 * rebuilds an object from its own enumerable entries, which is right for a row
 * that is about to be JSON-encoded and wrong for a terminal: an `Error` keeps
 * `message` and `stack` on non-enumerable properties, so rebuilding one prints
 * `{}` where the operator expected a failure. An `Error` is rebuilt as a plain
 * `Error` instead, carrying its name, message, stack and own members with the
 * rules applied. Its class is NOT preserved. A copy built on the original's
 * prototype inherits everything the prototype defines, an own-key walk sees
 * none of it, and each of `name`, `cause`, `toJSON`, `Symbol.toStringTag` and
 * `nodejs.util.inspect.custom` carried a credential out that way.
 *
 * @since 0.1.0
 */

import * as Cause from "effect/Cause"
import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as References from "effect/References"
import * as Redaction from "./Redaction.ts"

/**
 * Marks a logger this module already wrapped.
 *
 * Both the CLI and the durable runtime install {@link layer}, and a detached
 * `smithers run` is both at once. Wrapping twice would be correct but pay the
 * rules twice per line, so a wrapped logger is returned unchanged.
 *
 * @since 0.1.0
 * @category type ids
 */
export const TypeId: unique symbol = Symbol.for("@smthrs/journal/RedactedLogger")

/**
 * Whether {@link wrap} already wrapped this logger.
 *
 * @since 0.1.0
 * @category predicates
 */
export const isRedacted = (logger: Logger.Logger<any, any>): boolean => TypeId in logger

/**
 * Console methods that write caller-supplied values, mapped to whether their
 * arguments carry log output.
 *
 * Only `clear` and `groupEnd` are marked `false`, because those two take no
 * arguments at all: there is nothing for the rules to read and binding them
 * straight through saves a copy per call. Every other method here, `count`,
 * `countReset`, `time`, and `timeEnd` included, accepts a caller-supplied
 * LABEL and prints it, so a label of `api_key=sk-…` reached the terminal
 * through all four of them. `timeLog` already redacted its label, so the pair
 * `time` / `timeLog` also disagreed about what a timer is called; redacting all
 * of them is what makes a label match itself again.
 */
const consoleMethods = {
  assert: true,
  clear: false,
  count: true,
  countReset: true,
  debug: true,
  dir: true,
  dirxml: true,
  error: true,
  group: true,
  groupCollapsed: true,
  groupEnd: false,
  info: true,
  log: true,
  table: true,
  time: true,
  timeEnd: true,
  timeLog: true,
  trace: true,
  warn: true
} as const

/** How deep the logger walks a value before it names it instead. */
const renderDepthLimit = 200

/** What the logger renders in place of a value nested past the depth limit. */
const renderDepthMarker = "[Deep]"

/**
 * The parts of a log message.
 *
 * Effect's logging API passes an array, one entry per argument, including for
 * a single argument. A caller that builds `LogOptions` by hand may pass the
 * message itself, so it is wrapped rather than walked.
 *
 * @since 0.1.0
 * @category redaction
 */
const toArray = (message: unknown): ReadonlyArray<unknown> => Array.isArray(message) ? message : [message]

/**
 * Reads one piece of text off `error` and runs it through the rules.
 *
 * Everything a renderer prints about an error is read here, once, and only the
 * redacted result crosses to the copy. A caller's error can define any of these
 * as an accessor that throws, and reading one happens while a log line is
 * rendering, so a refusal costs that piece of text and nothing else.
 */
const redactedText = (read: () => unknown, redactor: Redaction.Redactor, fallback: string): string => {
  try {
    return String(redactor(String(read())))
  } catch {
    return fallback
  }
}

/** `error.stack` through the rules, or `undefined` when it has none to give. */
const redactedStack = (error: Error, redactor: Redaction.Redactor): string | undefined => {
  try {
    const stack = error.stack
    // An `Error.stack` is optional. Under `exactOptionalPropertyTypes` an
    // assignment cannot carry the `undefined` a stackless error has, so the
    // copy defines the property instead of assigning it.
    return typeof stack === "string" ? String(redactor(stack)) : undefined
  } catch {
    return undefined
  }
}

/**
 * A member NAME with the rules applied, replaced outright when one fires.
 *
 * The treatment `Redaction.redact` gives an object key, for the same reason: a
 * name is text a renderer prints. Rewriting one in place would change what it
 * reads as and redaction would stop being a fixed point, so a name that matches
 * becomes the placeholder whole.
 */
const redactedName = (key: string, redactor: Redaction.Redactor): string => {
  const redacted = String(redactor(key))
  return redacted === key ? key : Redaction.placeholder
}

/**
 * Own names the copy never carries, because a renderer CALLS them.
 *
 * `name`, `message` and `stack` are defined from the rules above instead. The
 * rest are hooks: a redacted `toString` or `valueOf` would leave a string under
 * a name the language calls, and `String(error)` would then throw from inside
 * the renderer, which is the failure mode this module exists to avoid.
 */
const renderHooks: ReadonlySet<string> = new Set([
  "constructor",
  "message",
  "name",
  "stack",
  "toJSON",
  "toString",
  "valueOf"
])

/**
 * A copy of `error` carrying the same information with the rules applied.
 *
 * A PLAIN `Error`, never a copy built on the original's prototype. A prototype
 * is an unbounded leak surface and an own-key walk never looks at one: an
 * inherited `name`, `cause`, `toJSON`, `Symbol.toStringTag` or
 * `nodejs.util.inspect.custom` each carried a credential straight to an OTLP
 * span attribute or to the operator's terminal, one per review round, and a
 * getter anywhere on the chain is the same hole with a different name. So
 * nothing inherited crosses. Only redacted text does: the name, the message,
 * the stack, and the error's own members, each read once here and stored as
 * data, since a getter carried across unchanged would hand the unredacted
 * value to whatever reads it next.
 *
 * The copy is not an instance of the original's class, so a renderer that
 * special-cases `instanceof MyError` sees a plain `Error`. That is the fidelity
 * trade the release policy already records for every other value, and it is
 * the trade the same problem's earlier, crashing form was settled with: a copy
 * on a host prototype, such as the `DOMException` an `AbortSignal` carries as
 * its reason, is an impostor whose brand check throws from inside `Cause.pretty`
 * and kills the run the line was describing.
 */
const redactError = (
  error: Error,
  redactor: Redaction.Redactor,
  seen: WeakMap<Error, Error>,
  depth = 0
): Error => {
  // The memo holds the COPY, not a visited mark: returning the original on a
  // repeat reference put the unredacted error back into the output, so a
  // diamond (two fields naming one error) leaked on its second field. The copy
  // is registered before its own members are walked, so a cycle terminates on
  // it and every reference to one error is the same redacted object.
  const memoized = seen.get(error)
  if (memoized !== undefined) return memoized
  const clone = new Error()
  seen.set(error, clone)
  const define = (key: string, value: unknown, enumerable: boolean): void => {
    Object.defineProperty(clone, key, { value, writable: true, enumerable, configurable: true })
  }
  define("name", redactedText(() => error.name, redactor, "Error"), false)
  define("message", redactedText(() => error.message, redactor, ""), false)
  define("stack", redactedStack(error, redactor), false)
  // Own NAMES, not `Reflect.ownKeys`. A symbol key never crosses: its
  // description is text no walk can rewrite in place, and the three hooks with
  // no name to skip are symbols too, `Symbol.toPrimitive`,
  // `Symbol.toStringTag`, and `nodejs.util.inspect.custom`.
  for (const key of Object.getOwnPropertyNames(error)) {
    if (renderHooks.has(key)) continue
    const descriptor = Object.getOwnPropertyDescriptor(error, key)!
    const value = "value" in descriptor
      ? descriptor.value
      : (error as unknown as Record<PropertyKey, unknown>)[key]
    define(
      redactedName(key, redactor),
      // A credential-named member is replaced wholesale, the way the journal's
      // own walk replaces one, so both halves of the one rule set answer alike.
      Redaction.isSensitiveKey(key)
        ? Redaction.placeholder
        // The depth cap binds under an Error exactly as it does beside one: a
        // deep value carried on a cause can exhaust the stack just as easily.
        : depth + 1 >= renderDepthLimit
        ? renderDepthMarker
        : value instanceof Error
        ? redactError(value, redactor, seen, depth + 1)
        : redactor(value),
      descriptor.enumerable === true
    )
  }
  return clone
}

/**
 * Redacts one value on its way out of the logger.
 *
 * An `Error` is rebuilt as a plain `Error` whose name, message, stack and own
 * members are redacted, so a renderer that special-cases an `Error` still gets
 * one. Everything else goes through the journal's own rules, which rebuild a
 * value from its plain data: a `Date`, a `Map`, a class instance or a host
 * object therefore reaches the operator in that plain form rather than as
 * itself.
 *
 * That collapse is deliberate, and it now covers the `Error` too. An earlier
 * version rebuilt each value on its own prototype to keep the rendering
 * faithful. Three rounds of review found three ways that could kill the run it
 * was logging, because a host class keeps state a property walk cannot see and
 * a copy of one throws the moment a brand check reads it, and four more found
 * that the prototype an `Error` copy kept was itself the leak: everything it
 * defines is read by a renderer and seen by no own-key walk. A log line is not
 * worth a run, and the rendering it buys is cosmetic.
 *
 * @since 0.1.0
 * @category redaction
 */
export const redactArgument = (value: unknown, redactor: Redaction.Redactor): unknown => {
  try {
    return value instanceof Error ? redactError(value, redactor, new WeakMap()) : redactor(value)
  } catch {
    // A logged value is arbitrary and a throw here happens while the line is
    // rendering, which would kill the run the line describes. The marker is
    // deliberately NOT derived from the value: an earlier fallback rendered
    // the value to text and printed it, and that text had never been through
    // the rules, so a credential reached the terminal in clear.
    return unrenderableMarker
  }
}

/** What the logger renders in place of a value that cannot be rendered. */
const unrenderableMarker = "[Unrenderable]"

/**
 * A console that runs every value it is handed through `redactor` and then
 * delegates to `target`.
 *
 * @since 0.1.0
 * @category constructors
 */
export const redactingConsole = (target: Console.Console, redactor: Redaction.Redactor): Console.Console => {
  const methods = target as unknown as Record<string, (...args: ReadonlyArray<any>) => unknown>
  const view: Record<string, unknown> = {}
  for (const [name, redacts] of Object.entries(consoleMethods)) {
    const method = methods[name]!.bind(target)
    view[name] = redacts
      ? (...args: ReadonlyArray<unknown>) => {
        const redacted = args.map((value) => redactArgument(value, redactor))
        try {
          return method(...redacted)
        } catch {
          // The delegate refused what we handed it. Retry with markers, never
          // with a rendering of the values: a rendering has not been through
          // the rules, and printing one is how a credential reached the
          // terminal before. A delegate that refuses the markers too is out of
          // options, and a log line is not worth the run.
          try {
            return method(...redacted.map(() => unrenderableMarker))
          } catch {
            return undefined
          }
        }
      }
      : method
  }
  return view as unknown as Console.Console
}

/**
 * A view of `fiber` whose console redacts and whose log annotations are
 * already redacted.
 *
 * The view inherits from the fiber itself, so `id`, `currentSpan`, and every
 * other member a logger reads answer exactly as before; only the two
 * references a logger renders from are substituted.
 */
const redactedFiber = (
  fiber: Fiber.Fiber<unknown, unknown>,
  redactor: Redaction.Redactor
): Fiber.Fiber<unknown, unknown> => {
  const view = Object.create(fiber) as Fiber.Fiber<unknown, unknown>
  Object.defineProperty(view, "getRef", {
    value: <X>(reference: Context.Reference<X>): X => {
      const current = fiber.getRef(reference)
      if (reference === (Console.Console as unknown as Context.Reference<X>)) {
        return redactingConsole(current as Console.Console, redactor) as X
      }
      if (reference === (References.CurrentLogAnnotations as unknown as Context.Reference<X>)) {
        // The same treatment a message part gets, so one log event obeys one
        // rule and an annotated Error is redacted like a logged one.
        return redactArgument(current, redactor) as X
      }
      return current
    }
  })
  return view
}

/**
 * Rebuilds the frame chain as redacted data. Evaluate the lazy stack here:
 * carrying its original function would defer the credential past the boundary.
 * The same depth cap as logged values also bounds cyclic parent chains.
 */
const redactedFrame = (
  frame: References.StackFrame | undefined,
  redactor: Redaction.Redactor,
  depth = 0
): References.StackFrame | undefined => {
  if (frame === undefined) return undefined
  if (depth >= renderDepthLimit) {
    return { name: renderDepthMarker, stack: () => undefined, parent: undefined }
  }
  const stack = redactedText(() => frame.stack() ?? "", redactor, unrenderableMarker)
  return {
    name: redactedText(() => frame.name, redactor, unrenderableMarker),
    stack: () => stack,
    parent: redactedFrame(frame.parent, redactor, depth + 1)
  }
}

/**
 * The log event's cause with the rules applied to failures, defects and stack
 * annotations. `Cause.pretty` renders these frames after rendering the error;
 * the tracer exports that text without passing through the redacting console.
 * Interruptions also carry both their own and the interruptor's frame chains.
 * Rebuild reasons and annotation maps so the original cause stays untouched.
 */
const redactedCause = (
  cause: Cause.Cause<unknown>,
  redactor: Redaction.Redactor
): Cause.Cause<unknown> => {
  if (cause.reasons.length === 0) return cause
  return Cause.fromReasons(cause.reasons.map((reason) => {
    const annotations = new Map(reason.annotations)
    for (const key of [Cause.StackTrace.key, Cause.InterruptorStackTrace.key]) {
      if (annotations.has(key)) {
        annotations.set(key, redactedFrame(annotations.get(key) as References.StackFrame | undefined, redactor))
      }
    }
    const copy = reason._tag === "Fail"
      ? Cause.makeFailReason(redactArgument(reason.error, redactor))
      : reason._tag === "Die"
      ? Cause.makeDieReason(redactArgument(reason.defect, redactor))
      : Cause.makeInterruptReason(reason.fiberId)
    return copy.annotate(Context.makeUnsafe(annotations))
  }))
}

/**
 * Returns `logger` with the journal's redaction rules over everything it
 * renders. A logger this module already wrapped is returned unchanged.
 *
 * @since 0.1.0
 * @category combinators
 */
export const wrap = <Message, Output>(
  logger: Logger.Logger<Message, Output>,
  options?: Redaction.Options
): Logger.Logger<Message, Output> => {
  if (isRedacted(logger)) return logger
  // A logger NAMES a too-deep value rather than throwing: a throw is caught one
  // frame up and costs the operator every argument on the line, not just the
  // deep one. A log line is a diagnostic, so it takes the diagnostic rules. A
  // caller passing its own `onTooDeep` or `rules` still wins.
  const redactor = Redaction.make({ onTooDeep: "name", rules: Redaction.diagnosticRules, ...options })
  const wrapped = Logger.make<Message, Output>((logOptions) =>
    logger.log({
      ...logOptions,
      // The message is redacted here, not only behind the fiber's Console,
      // because a logger is free to read it directly: `Logger.tracerLogger`
      // ships in Effect's default set and publishes the message as a span
      // event name, so a Console-only substitution would export a credential
      // in clear to whatever collector is configured.
      //
      // Effect delivers the message as an array of parts, one per argument,
      // including the single-argument case; a non-array reaches here only from
      // a caller that builds `LogOptions` by hand, and `toArray` covers it
      // without a branch no test could reach through the logging API.
      message: (toArray(logOptions.message).map((part) => redactArgument(part, redactor))) as Message,
      // The cause travels the same way and for the same reason. A failure is
      // logged as a `Cause`, not as message parts (`Effect.logError(cause)`
      // moves it out of the arguments), and `Logger.tracerLogger` renders it
      // itself into the span's `effect.cause` attribute without going near the
      // console, so an error message carrying a token would leave the process
      // in clear.
      cause: redactedCause(logOptions.cause, redactor),
      fiber: redactedFiber(logOptions.fiber, redactor)
    })
  )
  Object.defineProperty(wrapped, TypeId, { value: true })
  return wrapped
}

/**
 * Replaces the active logger set with redacting wrappers of the same loggers.
 *
 * It composes over whatever loggers are already installed rather than
 * choosing one, so an operator keeps the FORMAT they had, meaning their own
 * logger and its layout, though a value inside a line is rendered from its
 * redacted plain data rather than as its own class, and a host that
 * installed its own logger keeps it too.
 *
 * @since 0.1.0
 * @category layers
 */
export const layer = (options?: Redaction.Options): Layer.Layer<never> =>
  Layer.effect(
    Logger.CurrentLoggers,
    Effect.withFiber((fiber) =>
      Effect.sync(() => {
        const wrapped = new Set<Logger.Logger<unknown, any>>()
        for (const logger of fiber.getRef(Logger.CurrentLoggers)) wrapped.add(wrap(logger, options))
        return wrapped
      })
    )
  )
