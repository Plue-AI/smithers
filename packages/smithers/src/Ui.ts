/**
 * The interactive rendering layer for human output.
 *
 * `Output` renders documents: the one value a verb produces, as JSON or as
 * indented text. This module renders the other half of a terminal session,
 * the part that is not a document: the brand line that opens a command, log
 * lines that arrive while work continues, a spinner that says a scan is still
 * running, the list of suggestions that scan streams out, and the questions a
 * verb asks before a follow-up. It wraps `@clack/prompts` and owns the one
 * decision clack leaves to its caller: whether the session is interactive at
 * all.
 *
 * Every method has two renderings. Interactive human sessions use clack's
 * guide bars, symbols, colour, animated spinners, and modal prompts. Harness,
 * CI, pipe, and dumb-terminal detection comes from the shared Audience policy;
 * non-interactive prompts resolve without asking. Document encoding is a
 * separate choice: humans can request JSON and still receive progress on
 * stderr. Nothing here decides process status; that stays with `Output.exitCode`.
 *
 * @since 1.0.0-rc.0
 */

import * as clack from "@clack/prompts"
import * as Audience from "@smthrs/build-cli/Audience"
import { Context, Effect, Layer, Option } from "effect"
import type { Readable, Writable } from "node:stream"
import { Writable as WritableStream } from "node:stream"
import type * as Environment from "./Environment.ts"
import * as Failure from "./internal/Failure.ts"
import { packageVersion } from "./Version.ts"

/**
 * The line `intro` prints when a verb gives it no title.
 *
 * @category constants
 * @since 1.0.0-rc.0
 */
export const brand = `smthrs ${packageVersion}`

/**
 * One line of a checklist: `smthrs doctor`'s checks, or any report that is
 * a list of named facts at three levels.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Check {
  readonly name: string
  readonly level: "ok" | "warn" | "fail"
  readonly detail: string
}

/**
 * A running indicator. `start` is not an Effect because a spinner is
 * imperative by nature: it is started before work, updated during it, and
 * settled once, and the Effect boundary sits around that whole span.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Spinner {
  readonly start: (message: string) => void
  readonly message: (message: string) => void
  readonly stop: (message?: string) => void
  readonly cancel: (message?: string) => void
  readonly error: (message?: string) => void
}

/**
 * How a streamed list is labelled and settled.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface StreamOptions<A> {
  /** The one line printed for an item, given its 1-based position. */
  readonly label: (item: A, position: number) => string
  /** The spinner text while the scan continues. Defaults to `Scanning`. */
  readonly scanning?: string | undefined
  /** The line printed when the scan settles. Defaults to `<n> suggestions`. */
  readonly settled?: ((count: number) => string) | undefined
  /** Aborting stops the scan early and settles with the items received so far. */
  readonly signal?: AbortSignal | undefined
}

/**
 * How long an aborted scan waits for its source's `return()` before settling.
 *
 * @category constants
 * @since 1.0.0
 */
export const cleanupTimeoutMillis = 2_000

/**
 * What a streamed scan produced.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Streamed<A> {
  readonly items: ReadonlyArray<A>
  /** Whether `signal` aborted the scan before the source ended. */
  readonly stopped: boolean
}

/**
 * How a pick is presented.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface PickOptions<A> {
  readonly message: string
  readonly label: (item: A, position: number) => string
  readonly hint?: ((item: A) => string | undefined) | undefined
}

/**
 * How a confirmation is presented, and what it answers when nobody can be
 * asked.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface ConfirmOptions {
  readonly message: string
  /** The option the cursor starts on. Defaults to `true`. */
  readonly initialValue?: boolean | undefined
  /**
   * The answer in a non-interactive session. Required, because the safe
   * answer differs per question and a default here would decide it silently.
   */
  readonly nonInteractive: boolean
}

/**
 * The rendering service.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export interface Service {
  readonly interactive: boolean
  /** A required text value; cancellation or a non-interactive session returns None. */
  readonly text: (message: string) => Effect.Effect<Option.Option<string>>
  readonly intro: (title?: string) => Effect.Effect<void>
  readonly outro: (message: string) => Effect.Effect<void>
  readonly note: (message: string, title?: string) => Effect.Effect<void>
  readonly info: (message: string) => Effect.Effect<void>
  readonly success: (message: string) => Effect.Effect<void>
  readonly step: (message: string) => Effect.Effect<void>
  readonly warn: (message: string) => Effect.Effect<void>
  readonly error: (message: string) => Effect.Effect<void>
  /** A titled list of checks; non-interactive output matches `Doctor.render`. */
  readonly checklist: (title: string, checks: ReadonlyArray<Check>) => Effect.Effect<void>
  readonly spinner: () => Spinner
  /**
   * Prints each item as it arrives while a spinner says the scan continues,
   * and returns everything received once the source settles or `signal`
   * aborts. A source that throws settles the spinner as an error and fails
   * with the thrown value.
   */
  readonly streamSuggestions: <A>(
    items: AsyncIterable<A>,
    options: StreamOptions<A>
  ) => Effect.Effect<Streamed<A>, Error>
  /**
   * A `select` over items already received. `None` when the list is empty,
   * when the operator cancels, or in a non-interactive session, where the
   * candidates are printed as numbered lines instead.
   */
  readonly pickSuggestion: <A>(items: ReadonlyArray<A>, options: PickOptions<A>) => Effect.Effect<Option.Option<A>>
  /** A yes/no question. A cancelled prompt answers `false`. */
  readonly confirm: (options: ConfirmOptions) => Effect.Effect<boolean>
}

/**
 * Context key for the rendering service.
 *
 * @category services
 * @since 1.0.0-rc.0
 */
export class Ui extends Context.Service<Ui, Service>()("/cli/Ui") {}

/**
 * The streams and the interactivity decision one service is built on.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface Options {
  readonly output: Writable
  readonly input?: Readable | undefined
  readonly interactive: boolean
}

interface Terminal {
  readonly isTTY?: boolean | undefined
}

/**
 * Whether a human session can animate and ask. Harness detection and explicit
 * audience overrides use the same policy as target and durable-run progress.
 *
 * @category predicates
 * @since 1.0.0-rc.0
 */
export const isInteractive = (
  output: Terminal,
  input: Terminal,
  environment: Environment.Source
): boolean =>
  Audience.resolve({
    env: environment,
    stdin: input.isTTY === true,
    stdout: output.isTTY === true,
    stderr: output.isTTY === true
  }).interactive

/**
 * The fixed-width word a checklist line leads with.
 * @category formatting
 * @since 1.0.0
 */
export const levelWord = (level: Check["level"]): string => level === "ok" ? "ok  " : level === "warn" ? "warn" : "fail"

const write = (output: Writable, line: string): void => {
  output.write(`${line}\n`)
}

/**
 * Builds a service on explicit streams.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const make = (options: Options): Service => {
  const { input, interactive, output } = options
  const common = { output, ...(input === undefined ? {} : { input }) }
  const plain = (message: string) => Effect.sync(() => write(output, message))
  const styled = (paint: (message: string) => void, message: string) => Effect.sync(() => paint(message))
  const logged = (paint: (message: string, opts: clack.LogMessageOptions) => void) => (message: string) =>
    interactive ? styled((text) => paint(text, common), message) : plain(message)

  const spinner = (): Spinner => {
    if (!interactive) {
      return {
        start: (message) => write(output, `${message}...`),
        message: () => {},
        stop: (message) => {
          if (message !== undefined) write(output, message)
        },
        cancel: (message) => {
          if (message !== undefined) write(output, message)
        },
        error: (message) => {
          if (message !== undefined) write(output, message)
        }
      }
    }
    const live = clack.spinner(common)
    return {
      start: (message) => live.start(message),
      message: (message) => live.message(message),
      stop: (message) => live.stop(message),
      cancel: (message) => live.cancel(message),
      error: (message) => live.error(message)
    }
  }

  const streamSuggestions = <A>(items: AsyncIterable<A>, streamOptions: StreamOptions<A>) =>
    Effect.tryPromise({
      try: async (effectSignal) => {
        const scanning = streamOptions.scanning ?? "Scanning"
        const settled = streamOptions.settled ?? ((count: number) => `${count} suggestions`)
        const signal = streamOptions.signal === undefined
          ? effectSignal
          : AbortSignal.any([effectSignal, streamOptions.signal])
        const collected: Array<A> = []
        const iterator = items[Symbol.asyncIterator]()
        let onAbort: (() => void) | undefined
        const aborted = new Promise<"aborted">((resolve) => {
          if (signal.aborted) resolve("aborted")
          else {
            onAbort = () => resolve("aborted")
            signal.addEventListener("abort", onAbort, { once: true })
          }
        })
        // Non-interactive sessions print the item lines and the settling
        // line only: no frames, no "Scanning..." that a log reader has to
        // skip past.
        const live = interactive ? clack.spinner(common) : undefined
        live?.start(scanning)
        try {
          while (true) {
            const next = await Promise.race([iterator.next(), aborted])
            if (next === "aborted") {
              const message = `${scanning} stopped, ${settled(collected.length)}`
              if (live === undefined) write(output, message)
              else live.cancel(message)
              // A generator cannot finish return() until its pending next()
              // finishes. Stop animation immediately, then give cleanup a
              // bounded wait: a source whose next() never settles must not
              // hold the caller forever.
              const cleanup = Promise.resolve(iterator.return?.())
              // A rejection after the wait has nobody left to report to.
              cleanup.catch(() => {})
              let timer: ReturnType<typeof setTimeout> | undefined
              await Promise.race([
                cleanup,
                new Promise<void>((resolve) => {
                  timer = setTimeout(resolve, cleanupTimeoutMillis)
                })
              ])
              clearTimeout(timer)
              return { items: collected, stopped: true }
            }
            if (next.done) break
            collected.push(next.value)
            const line = streamOptions.label(next.value, collected.length)
            if (live === undefined) {
              write(output, line)
            } else {
              // The spinner frame sits on the last line. Clearing it, writing
              // the step line, and starting again is the one interleave that
              // leaves scrollback intact.
              live.clear()
              clack.log.step(line, common)
              live.start(`${scanning} (${collected.length} so far)`)
            }
          }
        } catch (cause) {
          live?.error(`${scanning} failed`)
          throw cause
        } finally {
          if (onAbort !== undefined) signal.removeEventListener("abort", onAbort)
        }
        const message = settled(collected.length)
        if (live === undefined) write(output, message)
        else live.stop(message)
        return { items: collected, stopped: false }
      },
      catch: (cause) => cause instanceof Error ? cause : new Error(Failure.unknownSentence, { cause })
    })

  const pickSuggestion = <A>(items: ReadonlyArray<A>, pickOptions: PickOptions<A>) =>
    Effect.promise(async (): Promise<Option.Option<A>> => {
      if (items.length === 0) return Option.none()
      if (!interactive) {
        write(output, pickOptions.message)
        items.forEach((item, index) => write(output, `${index + 1}. ${pickOptions.label(item, index + 1)}`))
        return Option.none()
      }
      const picked = await clack.select<number>({
        ...common,
        message: pickOptions.message,
        options: items.map((item, index) => {
          const hint = pickOptions.hint?.(item)
          return {
            value: index,
            label: pickOptions.label(item, index + 1),
            ...(hint === undefined ? {} : { hint })
          }
        })
      })
      return clack.isCancel(picked) ? Option.none() : Option.some(items[picked]!)
    })

  const confirm = (confirmOptions: ConfirmOptions) =>
    Effect.promise(async (): Promise<boolean> => {
      if (!interactive) {
        write(output, `${confirmOptions.message} ${confirmOptions.nonInteractive ? "yes" : "no"} (non-interactive)`)
        return confirmOptions.nonInteractive
      }
      const answer = await clack.confirm({
        ...common,
        message: confirmOptions.message,
        initialValue: confirmOptions.initialValue ?? true
      })
      return clack.isCancel(answer) ? false : answer
    })

  return {
    interactive,
    text: (message) =>
      Effect.promise(async () => {
        if (!interactive) return Option.none()
        const value = await clack.text({
          ...common,
          message,
          validate: (value) => value === undefined || value.trim() === "" ? "Enter a value" : undefined
        })
        return clack.isCancel(value) ? Option.none() : Option.some(value)
      }),
    intro: (title = brand) => interactive ? styled((text) => clack.intro(text, common), title) : plain(title),
    outro: (message) => interactive ? styled((text) => clack.outro(text, common), message) : plain(message),
    note: (message, title = "") =>
      interactive
        ? styled((text) => clack.note(text, title, common), message)
        : plain(title === "" ? message : `${title}\n${message}`),
    info: logged(clack.log.info),
    success: logged(clack.log.success),
    step: logged(clack.log.step),
    warn: logged(clack.log.warn),
    error: logged(clack.log.error),
    checklist: (title, checks) =>
      Effect.sync(() => {
        if (!interactive) {
          write(output, title)
          for (const check of checks) write(output, `${levelWord(check.level)} ${check.name}: ${check.detail}`)
          return
        }
        clack.intro(title, common)
        for (const check of checks) {
          const line = `${check.name}: ${check.detail}`
          if (check.level === "ok") clack.log.success(line, common)
          else if (check.level === "warn") clack.log.warn(line, common)
          else clack.log.error(line, common)
        }
        const failed = checks.filter((check) => check.level === "fail").length
        const warned = checks.filter((check) => check.level === "warn").length
        clack.outro(
          failed > 0
            ? `${failed} blocking problem${failed === 1 ? "" : "s"}`
            : warned > 0
            ? `no blocking problems, ${warned} warning${warned === 1 ? "" : "s"}`
            : "no problems found",
          common
        )
      }),
    spinner,
    streamSuggestions,
    pickSuggestion,
    confirm
  }
}

/**
 * Renders a checklist to a string, for handlers that print through `Output`
 * and `Console` rather than writing to a stream themselves.
 *
 * The non-interactive text is what `Doctor.render` returns; the
 * interactive text carries clack's symbols and, when the real stdout has
 * colour, its escape sequences.
 *
 * @category conversions
 * @since 1.0.0-rc.0
 */
export const renderChecklist = (
  title: string,
  checks: ReadonlyArray<Check>,
  options: { readonly interactive: boolean; readonly columns?: number | undefined }
): string => {
  const chunks: Array<string> = []
  const sink = new WritableStream({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    }
  })
  Object.assign(sink, { columns: options.columns ?? 80 })
  Effect.runSync(make({ output: sink, interactive: options.interactive }).checklist(title, checks))
  return chunks.join("").replace(/\n+$/, "")
}

/**
 * The service on the process's own streams.
 *
 * @category layers
 * @since 1.0.0-rc.0
 */
export const layer = (environment: Environment.Source): Layer.Layer<Ui> =>
  Layer.sync(Ui, () =>
    make({
      output: process.stdout,
      input: process.stdin,
      interactive: isInteractive(process.stdout, process.stdin, environment)
    }))

/**
 * The service in scope, or one built on the process's streams when no layer
 * provided it. Handlers read this so a test can inject a fake terminal
 * without every test composition having to.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const current: Effect.Effect<Service> = Effect.gen(function*() {
  const provided = yield* Effect.serviceOption(Ui)
  if (Option.isSome(provided)) return provided.value
  return make({
    output: process.stdout,
    input: process.stdin,
    interactive: isInteractive(process.stdout, process.stdin, process.env)
  })
})

/**
 * Required-input prompts use stderr so piping a document leaves stdin usable.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const prompting: Effect.Effect<Service> = Effect.gen(function*() {
  const provided = yield* Effect.serviceOption(Ui)
  if (Option.isSome(provided)) return provided.value
  return make({ output: process.stderr, input: process.stdin, interactive: process.stdin.isTTY === true })
})
