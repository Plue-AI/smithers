/**
 * The `smthrs suggest` verb: the order the four modules behind it happen in,
 * and what an operator sees in each of its three renderings.
 *
 * The listing paths run against the real `Ui` service on a sink, because the
 * bytes are the contract: they are what `--list` prints, what a pipe reads,
 * and what a log file keeps. The interactive path runs against a scripted
 * service instead, so a pick and a confirm are decided by the case rather
 * than by keypress timing; clack's own behaviour is `test/Ui.test.ts`'s.
 *
 * The model is never reached. `--json` and `--list` spend no token by
 * design, and the implementing step is the one seam a case replaces
 * (`Options.implement`); the bundled flow behind it is proven end to end,
 * with the model scripted and the sandbox real, in
 * `test/suggest/SuggestFlow.scripted.test.ts`.
 */
import { Cause, Deferred, Effect, Exit, Fiber, Option } from "effect"
import { Writable } from "node:stream"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as Providers from "../src/Providers.ts"
import * as Suggest from "../src/Suggest.ts"
import * as Checklist from "../src/suggest/Checklist.ts"
import * as Ui from "../src/Ui.ts"

/** A repository with one match for most of the checklist, held-back included. */
const project = Checklist.memoryRepository("/repo", {
  "package.json": JSON.stringify({ scripts: { test: "vitest run", release: "changeset publish" } }),
  "vitest.config.ts": "export default {}",
  "eslint.config.js": "export default []",
  ".git/config": "[remote \"origin\"]\n\turl = git@github.com:acme/acme.git\n",
  "packages/core/package.json": "{}"
})

/** A repository whose only match is a held-back one. */
const heavyOnly = Checklist.memoryRepository("/heavy", {
  "pnpm-workspace.yaml": "packages: []",
  "packages/core/package.json": "{}",
  // Present so `agents-md` does not match: what is left is one large
  // suggestion, which is exactly the case the pick has to hold back.
  "AGENTS.md": "# Agents"
})

const keyed = { MOONSHOT_API_KEY: "moonshot-key" }

const base = {
  root: "/repo",
  list: false,
  json: false,
  environment: keyed,
  homeDirectory: "/home/nobody",
  // No credential store on this host, so the Codex seat is unavailable and
  // the documented order falls through to Kimi.
  readFile: () => undefined,
  repository: project
} satisfies Partial<Suggest.Options>

const implemented = {
  files: ["flows/test-target/flow.mdx"],
  command: "smthrs up test-target",
  notes: "Runs vitest over the changed inputs."
}

interface Sink {
  readonly stream: Writable
  readonly text: () => string
}

const sink = (): Sink => {
  const chunks: Array<string> = []
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk))
      callback()
    }
  })
  Object.assign(stream, { columns: 80 })
  return { stream, text: () => chunks.join("") }
}

interface Scripted {
  readonly lines: Array<string>
  readonly asked: Array<string>
  readonly briefs: Array<string>
  readonly service: Ui.Service
}

/**
 * A rendering service the case decides the answers for.
 *
 * `pick` is the suggestion id to choose, or `"cancel"` for a cancelled
 * prompt; `answers` decides each confirm by its question.
 */
const scripted = (options: {
  readonly pick: string | "cancel"
  readonly answers?: ((message: string) => boolean) | undefined
}): Scripted => {
  const lines: Array<string> = []
  const asked: Array<string> = []
  const briefs: Array<string> = []
  const record = (prefix: string) => (message: string) => Effect.sync(() => void lines.push(`${prefix}${message}`))
  const service: Ui.Service = {
    text: () => Effect.succeed(Option.none()),
    interactive: true,
    intro: (title = Ui.brand) => record("intro: ")(title),
    outro: record("outro: "),
    note: (message, title = "") => record(`note ${title}: `)(message),
    info: record("info: "),
    success: record("success: "),
    step: record("step: "),
    warn: record("warn: "),
    error: record("error: "),
    checklist: (title) => record("checklist: ")(title),
    spinner: () => ({
      start: (message) => void lines.push(`spinner start: ${message}`),
      message: () => {},
      stop: (message) => void lines.push(`spinner stop: ${message ?? ""}`),
      cancel: (message) => void lines.push(`spinner cancel: ${message ?? ""}`),
      error: (message) => void lines.push(`spinner error: ${message ?? ""}`)
    }),
    streamSuggestions: (items, streamOptions) =>
      Effect.promise(async () => {
        const collected: Array<never> = []
        for await (const item of items) {
          collected.push(item as never)
          lines.push(`stream: ${streamOptions.label(item, collected.length)}`)
        }
        return { items: collected, stopped: false }
      }),
    pickSuggestion: (items, pickOptions) =>
      Effect.sync(() => {
        asked.push(pickOptions.message)
        for (const item of items) lines.push(`option: ${pickOptions.label(item, 1)}`)
        if (options.pick === "cancel") return Option.none()
        const found = items.find((item) => (item as Checklist.Suggestion).id === options.pick)
        return found === undefined ? Option.none() : Option.some(found)
      }),
    confirm: (confirmOptions) =>
      Effect.sync(() => {
        asked.push(confirmOptions.message)
        return options.answers?.(confirmOptions.message) ?? false
      })
  }
  return { lines, asked, briefs, service }
}

const record = (scriptedUi: Scripted): Suggest.Implement => (brief) =>
  Effect.sync(() => {
    scriptedUi.briefs.push(brief)
    return implemented
  })

describe("the seat, decided before anything is read", () => {
  it("refuses a malformed --seat as a usage error, which is exit 2", async () => {
    const error = await Effect.runPromise(Effect.flip(Suggest.run({ ...base, seat: "kimi" })))

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect(error.message).toBe("--seat must be spelled provider:model, got \"kimi\"")
    expect(CliError.exitCode(error)).toBe(2)
  })

  it("refuses an Anthropic override, the one provider this verb never uses", async () => {
    const error = await Effect.runPromise(Effect.flip(Suggest.run({ ...base, seat: "anthropic:claude-sonnet-4-5" })))

    expect(CliError.exitCode(error)).toBe(2)
    expect(error.message).toContain("never uses an Anthropic seat")
  })

  it("exits 1 with the whole seat report when nothing on the machine can run it", async () => {
    const error = await Effect.runPromise(
      Effect.flip(Suggest.run({ ...base, environment: {}, json: true, emit: () => {} }))
    )

    expect(error).toBeInstanceOf(CliError.UnsupportedError)
    expect(CliError.exitCode(error)).toBe(1)
    // The message is the one `Providers` writes, verbatim: every seat it
    // looked for, why each was unusable, and how to set it up.
    expect(error.message).toBe(
      Providers.noSeatMessage(
        Providers.detect({ environment: {}, homeDirectory: "/home/nobody", readFile: () => undefined })
      )
    )
    expect(error.message).toContain("Kimi K3 (moonshot:kimi-k3): $MOONSHOT_API_KEY is not set")
  })

  it("scans and implements on the override when one is given", async () => {
    const ui = scripted({ pick: "test-target" })
    const documents: Array<string> = []

    const outcome = await Effect.runPromise(
      Suggest.run({ ...base, seat: "gemini:gemini-2.5-pro", json: true, emit: (line) => void documents.push(line) })
    )

    expect(outcome.seat).toBe("gemini:gemini-2.5-pro")
    expect(JSON.parse(documents.at(-2)!)).toEqual({
      document: "seat",
      seat: "gemini:gemini-2.5-pro",
      source: "override",
      label: "--seat gemini:gemini-2.5-pro"
    })
    expect(ui.lines).toEqual([])
  })
})

describe("--json", () => {
  it("writes one document per suggestion as it is found, then the seat and the outcome", async () => {
    const documents: Array<string> = []

    const outcome = await Effect.runPromise(
      Suggest.run({ ...base, json: true, emit: (line) => void documents.push(line) })
    )

    const parsed = documents.map((line) => JSON.parse(line) as { readonly document: string; readonly id?: string })
    // The suggestion documents come first, in checklist order, and the two
    // closing documents come last: a consumer reads the list as it is found
    // and learns the seat and the outcome when the scan is over.
    expect(parsed.map((document) => document.document)).toEqual([
      ...parsed.slice(0, -2).map(() => "suggestion"),
      "seat",
      "outcome"
    ])
    expect(parsed.slice(0, -2).map((document) => document.id)).toEqual([
      "test-target",
      "lint-target",
      "agents-md",
      "release-notes",
      "pr-review",
      "repeated-script",
      "build-graph",
      "sandboxed-review"
    ])
    expect(JSON.parse(documents[0]!)).toEqual({
      document: "suggestion",
      position: 1,
      id: "test-target",
      title: "A test target that reruns only what changed",
      why:
        "vitest is the test runner (package.json, vitest.config.ts), so a target keyed on its inputs skips the tests whose inputs did not change",
      effort: "small",
      followUp: false,
      followUps: ["ci", "incremental"],
      files: ["package.json", "vitest.config.ts"]
    })
    expect(JSON.parse(documents.at(-1)!)).toEqual({
      document: "outcome",
      status: "listed",
      root: "/repo",
      seat: "moonshot:kimi-k3",
      suggestions: outcome.suggestions,
      implemented: []
    })
    expect(Suggest.exitStatus(outcome)).toBe(0)
  })

  it("never prompts and never implements, so a --json run spends nothing", async () => {
    const ui = scripted({ pick: "test-target", answers: () => true })
    const implement: Suggest.Implement = () => Effect.die(new Error("--json must not implement"))

    const outcome = await Effect.runPromise(
      Suggest.run({ ...base, json: true, emit: () => {}, implement }).pipe(
        Effect.provideService(Ui.Ui, ui.service)
      )
    )

    expect(outcome.status).toBe("listed")
    expect(outcome.implemented).toEqual([])
    expect(ui.asked).toEqual([])
  })
})

describe("--list, and any session that cannot be asked", () => {
  const listing = async (options: { readonly list: boolean }) => {
    const terminal = sink()
    const outcome = await Effect.runPromise(
      Suggest.run({ ...base, list: options.list }).pipe(
        Effect.provideService(Ui.Ui, Ui.make({ output: terminal.stream, interactive: false }))
      )
    )
    return { outcome, text: terminal.text() }
  }

  it("names the seat in the intro, prints one line per suggestion, and asks nothing", async () => {
    const { outcome, text } = await listing({ list: true })

    const lines = text.split("\n").filter((line) => line !== "")
    expect(lines[0]).toBe("smthrs suggest on moonshot:kimi-k3 (Kimi K3)")
    expect(lines[1]).toBe(
      "1. A test target that reruns only what changed (small): vitest is the test runner (package.json, vitest.config.ts), so a target keyed on its inputs skips the tests whose inputs did not change"
    )
    // The held-back one is listed too, and says so on its own line.
    expect(lines.at(-3)).toContain("8. A sandboxed review that runs the tests on each pull request (large, follow-up)")
    expect(lines.at(-2)).toBe("8 suggestions")
    expect(lines.at(-1)).toBe(
      "Nothing implemented; run `smthrs suggest` in a terminal, without --list, to pick one"
    )
    expect(outcome.status).toBe("listed")
    expect(outcome.implemented).toEqual([])
    expect(Suggest.exitStatus(outcome)).toBe(0)
  })

  it("prints the same thing without --list when the session is not a terminal", async () => {
    const listed = await listing({ list: true })
    const piped = await listing({ list: false })

    // A question nobody can answer is a hang, so a pipe reads the list.
    expect(piped.text).toBe(listed.text)
    expect(piped.outcome).toEqual(listed.outcome)
  })

  it("says so when a project matches nothing", async () => {
    const terminal = sink()

    const outcome = await Effect.runPromise(
      Suggest.run({ ...base, list: true, repository: Checklist.memoryRepository("/empty", {}) }).pipe(
        Effect.provideService(Ui.Ui, Ui.make({ output: terminal.stream, interactive: false }))
      )
    )

    expect(outcome.suggestions).toEqual([])
    expect(terminal.text()).toContain("Nothing to suggest for this project yet")
  })
})

describe("the interactive session", () => {
  it("picks, implements, lists the files and the command, then offers the follow-ups", async () => {
    const ui = scripted({ pick: "test-target", answers: (message) => message === "Run this in CI?" })

    const outcome = await Effect.runPromise(
      Suggest.run({ ...base, implement: record(ui) }).pipe(Effect.provideService(Ui.Ui, ui.service))
    )

    expect(outcome.status).toBe("implemented")
    // The pick offers only the suggestions the checklist did not hold back.
    expect(ui.lines).toContain("option: A test target that reruns only what changed")
    expect(ui.lines).not.toContain("option: A sandboxed review that runs the tests on each pull request")
    // Both of the picked suggestion's follow-ups are asked, in order, and the
    // held-back suggestion is asked last: a large change is a reasonable
    // question once a small one has landed.
    expect(ui.asked).toEqual([
      "Which one should I implement?",
      "Run this in CI?",
      "Make it incremental, so unchanged inputs reuse their recorded result?",
      "Also implement: The whole build as PACKAGE.ts targets?",
      "Also implement: A sandboxed review that runs the tests on each pull request?"
    ])
    // One implementation for the pick and one for the accepted follow-up; the
    // two declined questions wrote nothing.
    expect(outcome.implemented).toEqual([
      { kind: "suggestion", suggestion: "test-target", ...implemented },
      { kind: "follow-up", suggestion: "test-target", followUp: "ci", ...implemented }
    ])
    expect(ui.lines.filter((line) => line.startsWith("spinner "))).toEqual([
      "spinner start: A test target that reruns only what changed",
      "spinner stop: A test target that reruns only what changed: 1 file written",
      "spinner start: Run this in CI?",
      "spinner stop: Run this in CI?: 1 file written"
    ])
    expect(ui.briefs).toHaveLength(2)
    expect(ui.briefs[0]).toContain("# Suggestion `test-target`: A test target that reruns only what changed")
    expect(ui.briefs[0]).toContain("Seat for the flow's `model:` line: `moonshot:kimi-k3`")
    expect(ui.briefs[1]).toContain("# Follow-up on `test-target`: Run this in CI?")
    // Every file it wrote, and the one command that runs them.
    expect(ui.lines).toContain(
      "note A test target that reruns only what changed: - flows/test-target/flow.mdx\n\nRun it with: smthrs up test-target\n\nRuns vitest over the changed inputs."
    )
    expect(ui.lines.at(-1)).toBe("outro: 2 changes written, nothing committed")
    expect(Suggest.exitStatus(outcome)).toBe(0)
  })

  it("implements a held-back suggestion when the operator accepts it", async () => {
    const ui = scripted({
      pick: "test-target",
      answers: (message) => message === "Also implement: The whole build as PACKAGE.ts targets?"
    })

    const outcome = await Effect.runPromise(
      Suggest.run({ ...base, implement: record(ui) }).pipe(Effect.provideService(Ui.Ui, ui.service))
    )

    expect(outcome.implemented.map((entry) => entry.kind)).toEqual(["suggestion", "held-back"])
    expect(outcome.implemented[1]!.suggestion).toBe("build-graph")
    expect(ui.briefs[1]).toContain("# Suggestion `build-graph`")
  })

  it("reports a cancelled pick as 130, with nothing written", async () => {
    const ui = scripted({ pick: "cancel" })
    const implement: Suggest.Implement = () => Effect.die(new Error("a cancelled pick must not implement"))

    const outcome = await Effect.runPromise(
      Suggest.run({ ...base, implement }).pipe(Effect.provideService(Ui.Ui, ui.service))
    )

    expect(outcome.status).toBe("cancelled")
    expect(outcome.implemented).toEqual([])
    expect(Suggest.exitStatus(outcome)).toBe(130)
    expect(ui.lines.at(-1)).toBe("outro: Cancelled, nothing was written")
  })

  it("asks nothing when every match was held back", async () => {
    const ui = scripted({ pick: "cancel" })

    const outcome = await Effect.runPromise(
      Suggest.run({ ...base, root: "/heavy", repository: heavyOnly }).pipe(
        Effect.provideService(Ui.Ui, ui.service)
      )
    )

    // Not a failure and not a cancel: the scan found only work too large to
    // offer first, and said so.
    expect(outcome.status).toBe("nothing")
    expect(outcome.suggestions).toEqual(["build-graph"])
    expect(ui.asked).toEqual([])
    expect(Suggest.exitStatus(outcome)).toBe(0)
  })

  it("releases the live spinner when interrupted after implementation starts", async () => {
    const ui = scripted({ pick: "test-target" })
    const terminal = sink()
    const spinner = Ui.make({ output: terminal.stream, interactive: true }).spinner()
    const signals = ["SIGINT", "SIGTERM", "exit", "unhandledRejection", "uncaughtExceptionMonitor"] as const
    const listeners = () => signals.map((signal) => process.listenerCount(signal))
    const before = listeners()

    try {
      const exit = await Effect.runPromise(Effect.gen(function*() {
        const started = yield* Deferred.make<void>()
        const implement: Suggest.Implement = () =>
          Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        const fiber = yield* Suggest.run({ ...base, implement }).pipe(
          Effect.provideService(Ui.Ui, { ...ui.service, spinner: () => spinner }),
          Effect.forkChild
        )
        yield* Deferred.await(started)
        expect(process.listenerCount("SIGTERM")).toBe(before[1]! + 1)
        yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }))

      expect(Exit.hasInterrupts(exit)).toBe(true)
      expect(listeners()).toEqual(before)
      expect(terminal.text()).toContain("A test target that reruns only what changed: cancelled")
      expect(ui.asked).toEqual(["Which one should I implement?"])
    } finally {
      // Keep a failing regression from leaking the real spinner into other tests.
      spinner.cancel()
    }
  })

  it.each(["effect", "callback"] as const)("settles the spinner when the implementation %s defects", async (kind) => {
    const ui = scripted({ pick: "test-target" })
    const defect = new Error("implementation defect")
    const implement: Suggest.Implement = () => {
      if (kind === "callback") throw defect
      return Effect.die(defect)
    }

    const exit = await Effect.runPromiseExit(
      Suggest.run({ ...base, implement }).pipe(Effect.provideService(Ui.Ui, ui.service))
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(defect)
    expect(ui.lines.filter((line) => line.startsWith("spinner "))).toEqual([
      "spinner start: A test target that reruns only what changed",
      "spinner error: A test target that reruns only what changed: failed"
    ])
    expect(ui.asked).toEqual(["Which one should I implement?"])
  })

  it("exits 1 when the implementation fails, naming the step that failed", async () => {
    const ui = scripted({ pick: "lint-target" })
    const implement: Suggest.Implement = () => Effect.fail(new Error("the seat refused the request"))

    const error = await Effect.runPromise(
      Effect.flip(Suggest.run({ ...base, implement }).pipe(Effect.provideService(Ui.Ui, ui.service)))
    )

    expect(CliError.exitCode(error)).toBe(1)
    expect(error).toMatchObject({ _tag: "/cli/Refused", fault: "dependency", code: "suggest_implementation_failed" })
    expect(error.message).toBe("A lint target over the files that changed: the seat refused the request")
    expect(ui.lines).toContain("spinner error: A lint target over the files that changed: failed")
    expect(ui.lines.filter((line) => line.startsWith("spinner "))).toEqual([
      "spinner start: A lint target over the files that changed",
      "spinner error: A lint target over the files that changed: failed"
    ])
  })
})

describe("an implementation that fails with no designed sentence", () => {
  it("names the step and prints the generic sentence, never the raw text", async () => {
    const ui = scripted({ pick: "lint-target" })
    const implement: Suggest.Implement = () =>
      Effect.fail(new TypeError("Cannot read properties of undefined (reading 'token')"))

    const error = await Effect.runPromise(
      Effect.flip(Suggest.run({ ...base, implement }).pipe(Effect.provideService(Ui.Ui, ui.service)))
    )

    expect(CliError.exitCode(error)).toBe(1)
    expect(error).toMatchObject({ _tag: "/cli/Refused", code: "suggest_implementation_failed" })
    expect(error.message).toBe(
      "A lint target over the files that changed: Something went wrong on our side. Not your fault."
    )
    expect(error.message).not.toContain("reading 'token'")
  })
})

describe("the path a verb is pointed at", () => {
  it("accepts a directory and refuses anything else", () => {
    expect(Suggest.isDirectory(fileURLToPath(new URL("..", import.meta.url)))).toBe(true)
    expect(Suggest.isDirectory(fileURLToPath(new URL("../package.json", import.meta.url)))).toBe(false)
    expect(Suggest.isDirectory("/no/such/directory")).toBe(false)
  })
})
