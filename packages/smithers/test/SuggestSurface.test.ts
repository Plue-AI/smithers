/**
 * `smthrs suggest` with its defaults left in place.
 *
 * `test/Suggest.test.ts` asserts the order of the verb and the shape of its
 * three renderings with every seam replaced: a reader for the credential
 * store, an emitter for `--json`, an implementing step, a rendering service.
 * Those doubles are what make the order legible, and they are also what a
 * default is hidden behind: a case that always supplies a reader never learns
 * which file the seat scan opens, and a case that always supplies a step
 * never learns what the verb builds when nobody does.
 *
 * So each case here removes exactly one of those defaults and asserts what
 * the module does on its own — which path the seat scan reads, where a
 * `--json` document goes, what an operator is told when the step the verb
 * built for itself cannot reach the seat they named, and what a reader that
 * fails part-way through turns into.
 *
 * The model is still never reached. The one case that lets the bundled flow
 * run points it at a provider this machine has no key for, so the step fails
 * where a seat is resolved and no request is ever prepared.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Effect, Option } from "effect"
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as Suggest from "../src/Suggest.ts"
import * as Checklist from "../src/suggest/Checklist.ts"
import * as Ui from "../src/Ui.ts"

const staged: Array<string> = []

const directory = (prefix: string): string => {
  const made = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  staged.push(made)
  return made
}

afterEach(() => {
  while (staged.length > 0) rmSync(staged.pop()!, { recursive: true, force: true })
})

/** The same repository `test/Suggest.test.ts` scans, so the ids are the same. */
const project = Checklist.memoryRepository("/repo", {
  "package.json": JSON.stringify({ scripts: { test: "vitest run", release: "changeset publish" } }),
  "vitest.config.ts": "export default {}",
  "eslint.config.js": "export default []",
  ".git/config": "[remote \"origin\"]\n\turl = git@github.com:acme/acme.git\n",
  "packages/core/package.json": "{}"
})

/**
 * A reader that fails the way a repository on a host that revoked access
 * fails: not by answering "absent", but by throwing where the scan reads.
 * `Options.repository` is the seam that makes such a reader expressible, and
 * the verb owes it one sentence rather than a stack trace.
 */
const unreadable = (root: string): Checklist.Repository => ({
  root,
  exists: () => true,
  read: () => {
    throw new Error("EACCES: permission denied, open 'package.json'")
  },
  list: () => []
})

const keyed = { MOONSHOT_API_KEY: "fabricated-moonshot-key" }

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
  readonly hints: Array<string | undefined>
  readonly service: Ui.Service
}

/**
 * A rendering service the case answers for, kept to what these cases read:
 * the pick, and the hint the pick puts beside each option.
 */
const scripted = (pick: string): Scripted => {
  const lines: Array<string> = []
  const hints: Array<string | undefined> = []
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
        for (const item of items) {
          // The renderer reads the hint for every option it draws, which is
          // the only place this arm of the verb is observable from.
          hints.push(pickOptions.hint?.(item))
          lines.push(`option: ${pickOptions.label(item, 1)}`)
        }
        const found = items.find((item) => (item as Checklist.Suggestion).id === pick)
        return found === undefined ? Option.none() : Option.some(found)
      }),
    confirm: () => Effect.succeed(false)
  }
  return { lines, hints, service }
}

describe("the credential store the seat scan reads when it is handed no reader", () => {
  it("opens ~/.codex/auth.json and runs on the Codex seat when it holds a session", async () => {
    const home = directory("smthrs-suggest-home-")
    mkdirSync(join(home, ".codex"))
    writeFileSync(
      join(home, ".codex", "auth.json"),
      JSON.stringify({ tokens: { access_token: "fabricated-access", refresh_token: "fabricated-refresh" } })
    )
    const documents: Array<string> = []

    const outcome = await Effect.runPromise(
      Suggest.run({
        root: "/repo",
        list: false,
        json: true,
        environment: {},
        homeDirectory: home,
        repository: project,
        emit: (line) => void documents.push(line)
      })
    )

    // No `readFile`, no `MOONSHOT_API_KEY`: the only thing that can have
    // chosen this seat is the file the default reader opened under `home`.
    expect(outcome.seat).toBe("openai:gpt-6-sol")
    expect(JSON.parse(documents.at(-2)!)).toEqual({
      document: "seat",
      seat: "openai:gpt-6-sol",
      source: "codex-subscription",
      label: "Codex subscription"
    })
  })

  it("answers `no file` rather than throwing when the store is not there", async () => {
    const home = directory("smthrs-suggest-home-")

    const error = await Effect.runPromise(
      Effect.flip(
        Suggest.run({
          root: "/repo",
          list: false,
          json: true,
          environment: {},
          homeDirectory: home,
          repository: project,
          emit: () => {}
        })
      )
    )

    // A missing store is a seat that is not available, never a crash: the
    // report names the path it looked at and moves on to the next candidate.
    expect(CliError.exitCode(error)).toBe(1)
    expect(error.message).toContain(`no ${join(home, ".codex", "auth.json")}`)
    expect(error.message).toContain("Kimi K3 (moonshot:kimi-k3): $MOONSHOT_API_KEY is not set")
  })
})

describe("where a --json document goes when the verb is handed no emitter", () => {
  it("writes one document per line to stdout", async () => {
    const home = directory("smthrs-suggest-home-")
    const written: Array<string> = []
    const original = process.stdout.write
    const passthrough = original.bind(process.stdout) as unknown as (...args: ReadonlyArray<unknown>) => boolean
    process.stdout.write = ((chunk: string | Uint8Array, ...rest: ReadonlyArray<unknown>): boolean => {
      const text = typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
      if (!text.startsWith("{")) return passthrough(chunk, ...rest)
      written.push(text)
      return true
    }) as unknown as typeof process.stdout.write

    let outcome: Suggest.Outcome
    try {
      outcome = await Effect.runPromise(
        Suggest.run({
          root: "/repo",
          list: false,
          json: true,
          environment: keyed,
          homeDirectory: home,
          repository: project
        })
      )
    } finally {
      process.stdout.write = original
    }

    // One write per document, each a complete line: a consumer reading
    // stdout line by line parses every one of them.
    expect(written.length).toBe(outcome.suggestions.length + 2)
    expect(written.every((chunk) => chunk.endsWith("\n") && !chunk.slice(0, -1).includes("\n"))).toBe(true)
    const parsed = written.map((chunk) => JSON.parse(chunk) as { readonly document: string })
    expect(parsed.at(-2)!.document).toBe("seat")
    expect(parsed.at(-1)).toEqual({
      document: "outcome",
      status: "listed",
      root: "/repo",
      seat: "moonshot:kimi-k3",
      suggestions: outcome.suggestions,
      implemented: []
    })
  })
})

describe("the implementing step the verb builds when nobody supplies one", () => {
  it.each([false, true])("chooses its judge before resolving a missing seat (scripted: %s)", async (hasJudge) => {
    const root = directory("smthrs-suggest-root-")
    const home = directory("smthrs-suggest-home-")
    const ui = scripted("test-target")

    const error = await Effect.runPromise(
      Effect.flip(
        Suggest.run({
          root,
          // A provider with no key on this machine, so the step the verb
          // built reaches the seat resolver and stops there.
          seat: "gemini:gemini-2.5-pro",
          list: false,
          json: false,
          environment: keyed,
          evaluator: hasJudge ? ScriptedJudge.layer : undefined,
          homeDirectory: home,
          repository: project
        }).pipe(Effect.provideService(Ui.Ui, ui.service))
      )
    )

    expect(CliError.exitCode(error)).toBe(1)
    // The step that failed is named first, then the seat resolver's own
    // sentence: an operator learns which suggestion stopped and what to set.
    expect(error.message).toContain("A test target that reruns only what changed:")
    expect(error.message).toContain("Set GEMINI_API_KEY or GOOGLE_API_KEY to run the gemini:gemini-2.5-pro seat")
    expect(ui.lines).toContain("spinner error: A test target that reruns only what changed: failed")
    // A step that could not start wrote nothing under the root it was pinned
    // to, which is the promise the verb makes about a failed implementation.
    expect(readdirSync(root)).toEqual([])
  }, 120_000)
})

describe("a reader that fails part-way through the scan", () => {
  it("is one sentence naming the repository root under --json", async () => {
    const home = directory("smthrs-suggest-home-")
    const documents: Array<string> = []

    const error = await Effect.runPromise(
      Effect.flip(
        Suggest.run({
          root: "/repo",
          list: false,
          json: true,
          environment: keyed,
          homeDirectory: home,
          repository: unreadable("/repo"),
          emit: (line) => void documents.push(line)
        })
      )
    )

    expect(CliError.exitCode(error)).toBe(1)
    expect(error.message).toBe(
      "the scan of /repo failed: Error: EACCES: permission denied, open 'package.json'"
    )
    // The stream stops where the scan did: no seat document, no outcome
    // document, so a consumer never reads a truncated list as a complete one.
    expect(documents).toEqual([])
  })

  it("is one sentence naming the path the verb was pointed at when it is streamed", async () => {
    const home = directory("smthrs-suggest-home-")
    const terminal = sink()

    const error = await Effect.runPromise(
      Effect.flip(
        Suggest.run({
          root: "/repo",
          list: true,
          json: false,
          environment: keyed,
          homeDirectory: home,
          repository: unreadable("/repo")
        }).pipe(Effect.provideService(Ui.Ui, Ui.make({ output: terminal.stream, interactive: false })))
      )
    )

    expect(CliError.exitCode(error)).toBe(1)
    expect(error.message).toBe(
      "the scan of /repo failed: EACCES: permission denied, open 'package.json'"
    )
    // The intro named the seat before the scan, and nothing was settled
    // after it: an operator sees where it got to, not a count it can trust.
    expect(terminal.text()).toContain("smthrs suggest on moonshot:kimi-k3 (Kimi K3)")
    expect(terminal.text()).not.toContain("suggestions")
  })
})

describe("the hint the pick puts beside each option", () => {
  it("is how big the change is, for every option offered", async () => {
    const home = directory("smthrs-suggest-home-")
    const ui = scripted("nothing-matches-this-id")

    const outcome = await Effect.runPromise(
      Suggest.run({
        root: "/repo",
        list: false,
        json: false,
        environment: keyed,
        homeDirectory: home,
        repository: project
      }).pipe(Effect.provideService(Ui.Ui, ui.service))
    )

    // Every option the pick draws carries one, and it is the effort the
    // checklist recorded: the operator chooses by size without opening
    // anything.
    expect(ui.hints.length).toBe(ui.lines.filter((line) => line.startsWith("option: ")).length)
    expect(ui.hints.length).toBeGreaterThan(0)
    expect(new Set(ui.hints)).toEqual(new Set(["small", "medium"]))
    expect(outcome.status).toBe("cancelled")
  })
})
