/**
 * The interactive rendering layer, driven through fake streams.
 *
 * Interactive cases assert on clack's symbols after stripping escape
 * sequences, because `util.styleText` decides colour from the real stdout,
 * not from the sink the layer writes to. Non-interactive cases pin bytes: that
 * text is what a log file, a pipe, and a `--json` consumer read.
 */
import { Effect, Option } from "effect"
import { getEventListeners } from "node:events"
import { PassThrough, Writable } from "node:stream"
import { stripVTControlCharacters } from "node:util"
import { describe, expect, it, vi } from "vitest"
import * as Doctor from "../src/Doctor.ts"
import * as Ui from "../src/Ui.ts"
import { packageVersion } from "../src/Version.ts"

interface Terminal {
  readonly output: Writable
  readonly input: PassThrough
  readonly text: () => string
  readonly plain: () => string
}

const terminal = (): Terminal => {
  const chunks: Array<string> = []
  const output = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    }
  })
  Object.assign(output, { columns: 80 })
  const input = new PassThrough()
  return {
    output,
    input,
    text: () => chunks.join(""),
    plain: () => stripVTControlCharacters(chunks.join(""))
  }
}

const make = (term: Terminal, interactive: boolean): Ui.Service =>
  Ui.make({ output: term.output, input: term.input, interactive })

/** Types keys into a prompt after it has attached its listener. */
const press = (term: Terminal, ...keys: ReadonlyArray<string>): void => {
  let delay = 10
  for (const key of keys) {
    setTimeout(() => term.input.write(key), delay)
    delay += 10
  }
}

async function* source<A>(items: ReadonlyArray<A>, gap = 0): AsyncGenerator<A> {
  for (const item of items) {
    if (gap > 0) await new Promise((resolve) => setTimeout(resolve, gap))
    yield item
  }
}

const checks: ReadonlyArray<Ui.Check> = [
  { name: "registry", level: "ok", detail: "2 flows discovered" },
  { name: "providers", level: "warn", detail: "no provider key set" },
  { name: "node", level: "fail", detail: "v20.0.0 is below the floor" }
]

describe("interactivity", () => {
  it("needs two terminals and neither CI nor a dumb TERM", () => {
    const tty = { isTTY: true }
    const pipe = { isTTY: undefined }
    expect(Ui.isInteractive(tty, tty, {})).toBe(true)
    expect(Ui.isInteractive(pipe, tty, {})).toBe(false)
    expect(Ui.isInteractive(tty, pipe, {})).toBe(false)
    expect(Ui.isInteractive(tty, tty, { CI: "true" })).toBe(false)
    expect(Ui.isInteractive(tty, tty, { CI: "1" })).toBe(false)
    expect(Ui.isInteractive(tty, tty, { TERM: "dumb" })).toBe(false)
  })

  it("does not prompt inside an agent harness even when all streams are terminals", () => {
    const tty = { isTTY: true }
    expect(Ui.isInteractive(tty, tty, { CLAUDECODE: "1" })).toBe(false)
    expect(Ui.isInteractive(tty, tty, { CODEX_THREAD_ID: "thread" })).toBe(false)
    expect(Ui.isInteractive(tty, tty, { OPENCODE: "1" })).toBe(false)
  })

  it("falls back to the process streams when no layer provides the service", async () => {
    const ui = await Effect.runPromise(Ui.current)
    expect(ui.interactive).toBe(Ui.isInteractive(process.stdout, process.stdin, process.env))
  })

  it("prefers the provided service", async () => {
    const term = terminal()
    const provided = make(term, false)
    const ui = await Effect.runPromise(Ui.current.pipe(Effect.provideService(Ui.Ui, provided)))
    expect(ui).toBe(provided)
  })

  it("builds the layer on the process streams", async () => {
    const ui = await Effect.runPromise(
      Effect.gen(function*() {
        return yield* Ui.Ui
      }).pipe(Effect.provide(Ui.layer({ CI: "true" })))
    )
    expect(ui.interactive).toBe(false)
  })
})

describe("bookends and log lines", () => {
  it("prints the brand line, guide bars, and symbols interactively", async () => {
    const term = terminal()
    const ui = make(term, true)
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* ui.intro()
        yield* ui.info("info")
        yield* ui.success("success")
        yield* ui.step("step")
        yield* ui.warn("warn")
        yield* ui.error("error")
        yield* ui.note("body", "title")
        yield* ui.outro("done")
      })
    )
    const plain = term.plain()
    expect(plain).toContain(`┌  smthrs ${packageVersion}`)
    expect(plain).toContain("●  info")
    expect(plain).toContain("◆  success")
    expect(plain).toContain("◇  step")
    expect(plain).toContain("▲  warn")
    expect(plain).toContain("■  error")
    expect(plain).toContain("◇  title")
    expect(plain).toContain("│  body")
    expect(plain).toContain("└  done")
  })

  it("prints plain lines with no escape sequences otherwise", async () => {
    const term = terminal()
    const ui = make(term, false)
    await Effect.runPromise(
      Effect.gen(function*() {
        yield* ui.intro("smithers suggest")
        yield* ui.info("info")
        yield* ui.success("success")
        yield* ui.step("step")
        yield* ui.warn("warn")
        yield* ui.error("error")
        yield* ui.note("body", "title")
        yield* ui.note("untitled")
        yield* ui.outro("done")
      })
    )
    expect(term.text()).toBe("smithers suggest\ninfo\nsuccess\nstep\nwarn\nerror\ntitle\nbody\nuntitled\ndone\n")
    expect(Ui.brand).toBe(`smthrs ${packageVersion}`)
  })
})

describe("checklist", () => {
  it("is byte-identical to Doctor.render when not interactive", () => {
    const report: Doctor.Report = { root: "/work", checks }
    expect(Ui.renderChecklist(`Diagnostics: ${report.root}`, report.checks, { interactive: false }))
      .toBe(Doctor.render(report))
  })

  it("levels each check with a symbol and closes with the verdict", () => {
    const plain = stripVTControlCharacters(
      Ui.renderChecklist("smithers doctor: /work", checks, { interactive: true, columns: 100 })
    )
    expect(plain).toContain("┌  smithers doctor: /work")
    expect(plain).toContain("◆  registry: 2 flows discovered")
    expect(plain).toContain("▲  providers: no provider key set")
    expect(plain).toContain("■  node: v20.0.0 is below the floor")
    expect(plain).toContain("└  1 blocking problem")
    expect(plain.endsWith("\n")).toBe(false)
  })

  it("words the verdict by what it found", () => {
    const verdict = (list: ReadonlyArray<Ui.Check>) =>
      stripVTControlCharacters(Ui.renderChecklist("t", list, { interactive: true })).split("\n").at(-1)
    expect(verdict([checks[0]!])).toBe("└  no problems found")
    expect(verdict([checks[0]!, checks[1]!])).toBe("└  no blocking problems, 1 warning")
    expect(verdict([checks[1]!, checks[1]!])).toBe("└  no blocking problems, 2 warnings")
    expect(verdict([checks[2]!, checks[2]!])).toBe("└  2 blocking problems")
  })
})

describe("spinner", () => {
  it("animates interactively and settles with a symbol", async () => {
    const term = terminal()
    const spinner = make(term, true).spinner()
    spinner.start("working")
    spinner.message("still working")
    await new Promise((resolve) => setTimeout(resolve, 150))
    spinner.stop("worked")
    expect(term.plain()).toContain("◇  worked")

    spinner.start("again")
    spinner.cancel("gave up")
    expect(term.plain()).toContain("■  gave up")

    spinner.start("once more")
    spinner.error("broke")
    expect(term.plain()).toContain("▲  broke")
  })

  it("prints one line per transition otherwise", () => {
    const term = terminal()
    const spinner = make(term, false).spinner()
    spinner.start("working")
    spinner.message("ignored")
    spinner.stop("worked")
    spinner.start("again")
    spinner.cancel("gave up")
    spinner.start("once more")
    spinner.error("broke")
    spinner.start("silent")
    spinner.stop()
    spinner.cancel()
    spinner.error()
    expect(term.text()).toBe("working...\nworked\nagain...\ngave up\nonce more...\nbroke\nsilent...\n")
  })
})

describe("streamSuggestions", () => {
  const options: Ui.StreamOptions<string> = {
    label: (item, position) => `${position}. ${item}`,
    scanning: "Scanning the tree",
    settled: (count) => `${count} found`
  }

  it("prints each item as it arrives under a running spinner", async () => {
    const term = terminal()
    const ui = make(term, true)
    const streamed = await Effect.runPromise(ui.streamSuggestions(source(["a", "b"], 150), options))
    expect(streamed).toEqual({ items: ["a", "b"], stopped: false })
    const plain = term.plain()
    expect(plain).toContain("◇  1. a")
    expect(plain).toContain("◇  2. b")
    expect(plain).toContain("Scanning the tree (1 so far)")
    expect(plain).toContain("◇  2 found")
    expect(plain.indexOf("1. a")).toBeLessThan(plain.indexOf("2. b"))
  })

  it("prints plain lines and the settling line otherwise", async () => {
    const term = terminal()
    const ui = make(term, false)
    const streamed = await Effect.runPromise(ui.streamSuggestions(source(["a", "b"]), options))
    expect(streamed.items).toEqual(["a", "b"])
    expect(term.text()).toBe("1. a\n2. b\n2 found\n")
  })

  it("uses the default wording", async () => {
    const term = terminal()
    const ui = make(term, false)
    await Effect.runPromise(ui.streamSuggestions(source(["a"]), { label: (item) => item }))
    expect(term.text()).toBe("a\n1 suggestions\n")
  })

  it("settles early with what it has when the signal aborts", async () => {
    for (const interactive of [true, false]) {
      const term = terminal()
      const ui = make(term, interactive)
      const controller = new AbortController()
      let returned = false
      let entered!: () => void
      let release!: () => void
      const waiting = new Promise<void>((resolve) => {
        entered = resolve
      })
      const blocked = new Promise<void>((resolve) => {
        release = resolve
      })
      async function* slow(): AsyncGenerator<string> {
        try {
          yield "a"
          entered()
          await blocked
          yield "never"
        } finally {
          returned = true
        }
      }
      const running = Effect.runPromise(
        ui.streamSuggestions(slow(), { ...options, signal: controller.signal })
      )
      await waiting
      controller.abort()
      await new Promise<void>((resolve) => setImmediate(resolve))
      const stoppedBeforeCleanup = term.plain().includes("Scanning the tree stopped, 1 found")
      const returnedBeforeRelease = returned
      release()
      const streamed = await running
      expect(streamed).toEqual({ items: ["a"], stopped: true })
      expect(stoppedBeforeCleanup).toBe(true)
      expect(returnedBeforeRelease).toBe(false)
      expect(returned).toBe(true)
      expect(term.plain()).toContain("Scanning the tree stopped, 1 found")
    }
  })

  it("settles after a bounded wait when the source never finishes its cleanup", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] })
    try {
      const term = terminal()
      const controller = new AbortController()
      let returnCalled = false
      const stuck: AsyncIterable<string> = {
        [Symbol.asyncIterator]: () => ({
          next: () => new Promise<IteratorResult<string>>(() => {}),
          return: () => {
            returnCalled = true
            return new Promise<IteratorResult<string>>(() => {})
          }
        })
      }
      let settled = false
      const running = Effect.runPromise(
        make(term, false).streamSuggestions(stuck, { ...options, signal: controller.signal })
      ).then((value) => {
        settled = true
        return value
      })
      controller.abort()
      await vi.advanceTimersByTimeAsync(Ui.cleanupTimeoutMillis)
      expect(returnCalled).toBe(true)
      expect(settled).toBe(true)
      expect(await running).toEqual({ items: [], stopped: true })
    } finally {
      vi.useRealTimers()
    }
  })

  it("removes its abort listener when a scan completes normally", async () => {
    const combined = vi.spyOn(AbortSignal, "any")
    try {
      const term = terminal()
      await Effect.runPromise(
        make(term, false).streamSuggestions(source(["a"]), {
          ...options,
          signal: new AbortController().signal
        })
      )
      const signal = combined.mock.results.find((result) => result.type === "return")?.value as AbortSignal
      expect(signal).toBeInstanceOf(AbortSignal)
      expect(getEventListeners(signal, "abort")).toHaveLength(0)
    } finally {
      combined.mockRestore()
    }
  })

  it("treats a signal that is already aborted as an empty scan", async () => {
    const term = terminal()
    const ui = make(term, false)
    const controller = new AbortController()
    controller.abort()
    const streamed = await Effect.runPromise(
      ui.streamSuggestions(source(["a"]), { ...options, signal: controller.signal })
    )
    expect(streamed).toEqual({ items: [], stopped: true })
  })

  it("settles the spinner as an error and fails with the cause", async () => {
    for (const interactive of [true, false]) {
      const term = terminal()
      const ui = make(term, interactive)
      async function* broken(): AsyncGenerator<string> {
        yield "a"
        throw new Error("scan exploded")
      }
      const exit = await Effect.runPromiseExit(ui.streamSuggestions(broken(), options))
      expect(exit._tag).toBe("Failure")
      expect(String(exit)).toContain("scan exploded")
      if (interactive) expect(term.plain()).toContain("▲  Scanning the tree failed")
    }
    const term = terminal()
    async function* thrown(): AsyncGenerator<string> {
      yield "a"
      throw "not an error"
    }
    const exit = await Effect.runPromiseExit(make(term, false).streamSuggestions(thrown(), options))
    expect(String(exit)).toContain("not an error")
  })
})

describe("pickSuggestion", () => {
  const options: Ui.PickOptions<string> = {
    message: "Apply which?",
    label: (item, position) => `${position}. ${item}`,
    hint: (item) => item === "b" ? "the second" : undefined
  }

  it("selects with the arrow keys", async () => {
    const term = terminal()
    const ui = make(term, true)
    press(term, "[B", "\r")
    const picked = await Effect.runPromise(ui.pickSuggestion(["a", "b"], options))
    expect(picked).toEqual(Option.some("b"))
    expect(term.plain()).toContain("2. b (the second)")
  })

  it("answers none when the operator cancels", async () => {
    const term = terminal()
    const ui = make(term, true)
    press(term, "")
    const picked = await Effect.runPromise(ui.pickSuggestion(["a", "b"], options))
    expect(Option.isNone(picked)).toBe(true)
  })

  it("answers none for an empty list without asking", async () => {
    const term = terminal()
    const picked = await Effect.runPromise(make(term, true).pickSuggestion([], options))
    expect(Option.isNone(picked)).toBe(true)
    expect(term.text()).toBe("")
  })

  it("lists the candidates and answers none otherwise", async () => {
    const term = terminal()
    const picked = await Effect.runPromise(make(term, false).pickSuggestion(["a", "b"], options))
    expect(Option.isNone(picked)).toBe(true)
    expect(term.text()).toBe("Apply which?\n1. 1. a\n2. 2. b\n")
  })
})

describe("confirm", () => {
  it("answers the chosen option", async () => {
    const term = terminal()
    const ui = make(term, true)
    press(term, "\r")
    expect(await Effect.runPromise(ui.confirm({ message: "Apply?", nonInteractive: false }))).toBe(true)
    press(term, "\r")
    expect(
      await Effect.runPromise(ui.confirm({ message: "Apply?", initialValue: false, nonInteractive: true }))
    ).toBe(false)
  })

  it("answers false when cancelled", async () => {
    const term = terminal()
    const ui = make(term, true)
    press(term, "")
    expect(await Effect.runPromise(ui.confirm({ message: "Apply?", nonInteractive: true }))).toBe(false)
  })

  it("answers the declared non-interactive value and says so", async () => {
    const term = terminal()
    const ui = make(term, false)
    expect(await Effect.runPromise(ui.confirm({ message: "Apply?", nonInteractive: true }))).toBe(true)
    expect(await Effect.runPromise(ui.confirm({ message: "Delete?", nonInteractive: false }))).toBe(false)
    expect(term.text()).toBe("Apply? yes (non-interactive)\nDelete? no (non-interactive)\n")
  })
})

describe("required text", () => {
  it("collects a nonblank value through clack", async () => {
    const term = terminal()
    press(term, "run-1", "\r")
    expect(await Effect.runPromise(make(term, true).text("Enter run-id"))).toEqual(Option.some("run-1"))
    expect(term.plain()).toContain("Enter run-id")
  })

  it("does not read a pipe", async () => {
    const term = terminal()
    expect(await Effect.runPromise(make(term, false).text("Enter run-id"))).toEqual(Option.none())
    expect(term.text()).toBe("")
  })

  it("cancels without selecting a value", async () => {
    const term = terminal()
    press(term, "\u0003")
    expect(await Effect.runPromise(make(term, true).text("Enter run-id"))).toEqual(Option.none())
  })
})
