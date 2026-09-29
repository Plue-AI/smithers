/**
 * What `smthrs suggest` does when a case injects nothing.
 *
 * `test/Suggest.test.ts` replaces every seam the verb has: the credential
 * reader, the `--json` emitter, and the implementing step. That is what makes
 * its cases a table, and it is also what leaves the defaults behind those
 * seams unexercised — the reader that opens `auth.json`, the emitter that
 * writes to stdout, and the composition that runs the bundled flow on this
 * host. Each of those is a promise the verb makes to an operator who passes
 * no options at all, so each is asserted here through the same public
 * surface, with the seams left where they are.
 *
 * The default implementing step is reached with a seat this machine has no
 * credential for, so the composition is built and the seat is resolved for
 * real and the refusal arrives before any request is signed. Nothing here
 * reaches a model or a network.
 */
import * as ScriptedJudge from "@smthrs/agent/ScriptedJudge"
import { Effect, Option } from "effect"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Writable } from "node:stream"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import * as CliError from "../src/CliError.ts"
import * as Suggest from "../src/Suggest.ts"
import * as Checklist from "../src/suggest/Checklist.ts"
import * as Ui from "../src/Ui.ts"

/**
 * A repository with exactly one small match, so the pick has one candidate
 * and the cases below assert on what is offered rather than on which of
 * several it landed on. `AGENTS.md` is what holds `agents-md` back.
 */
const project = Checklist.memoryRepository("/repo", {
  "AGENTS.md": "# Agents",
  "package.json": JSON.stringify({ scripts: { test: "vitest run" } }),
  "vitest.config.ts": "export default {}"
})

/** The one suggestion that repository matches. */
const onlyMatch = "A test target that reruns only what changed"

/**
 * A repository whose directory listing throws, which is how a project that
 * cannot be read reaches the verb.
 */
const unreadable: Checklist.Repository = {
  root: "/gone",
  exists: () => false,
  read: () => undefined,
  list: () => {
    throw new Error("EACCES: permission denied")
  }
}

const base = {
  root: "/repo",
  list: false,
  json: false,
  environment: {},
  evaluator: ScriptedJudge.layer,
  repository: project
} satisfies Partial<Suggest.Options>

interface Sink {
  readonly stream: Writable
  readonly text: () => string
}

/** A stream a non-interactive service can be built on. */
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

let signedIn: string
let signedOut: string
let root: string

beforeAll(() => {
  signedIn = mkdtempSync(join(tmpdir(), "smthrs-suggest-in-"))
  signedOut = mkdtempSync(join(tmpdir(), "smthrs-suggest-out-"))
  root = mkdtempSync(join(tmpdir(), "smthrs-suggest-root-"))
  mkdirSync(join(signedIn, ".codex"), { recursive: true })
  writeFileSync(
    join(signedIn, ".codex", "auth.json"),
    JSON.stringify({ tokens: { access_token: "access", refresh_token: "refresh" } })
  )
})

afterAll(() => {
  for (const directory of [signedIn, signedOut, root]) rmSync(directory, { recursive: true, force: true })
})

describe("the credential store, read off disk when no reader is injected", () => {
  it("detects the Codex subscription from the auth.json the home directory holds", async () => {
    const documents: Array<string> = []

    const outcome = await Effect.runPromise(
      Suggest.run({
        ...base,
        // The Codex login is opt-in (#1677); the opt-in names no credential.
        environment: { SMITHERS_OPENAI_AUTH: "chatgpt" },
        json: true,
        homeDirectory: signedIn,
        emit: (line) => void documents.push(line)
      })
    )

    // Nothing but the file on disk makes this seat available: the
    // environment holds only the opt-in and no reader was passed.
    expect(outcome.seat).toBe("openai:gpt-6-sol")
    expect(JSON.parse(documents.at(-2)!)).toEqual({
      document: "seat",
      seat: "openai:gpt-6-sol",
      source: "codex-subscription",
      label: "Codex subscription"
    })
  })

  it("names the file it looked for when the home directory has none", async () => {
    const error = await Effect.runPromise(
      Effect.flip(Suggest.run({ ...base, json: true, homeDirectory: signedOut, emit: () => {} }))
    )

    expect(error).toBeInstanceOf(CliError.UnsupportedError)
    expect(CliError.exitCode(error)).toBe(1)
    // A file that cannot be opened is reported as an absent one, by path, so
    // the operator knows which store to sign in against.
    expect(error.message).toContain(`no ${join(signedOut, ".codex", "auth.json")}`)
  })
})

describe("the --json emitter, defaulted to stdout", () => {
  it("writes every document to stdout, one terminated line at a time", async () => {
    const written: Array<string> = []
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      written.push(String(chunk))
      return true
    })
    let outcome: Suggest.Outcome
    try {
      outcome = await Effect.runPromise(
        Suggest.run({ ...base, json: true, environment: { OPENAI_API_KEY: "openai-key" }, homeDirectory: signedOut })
      )
    } finally {
      stdout.mockRestore()
    }

    // One write per document, each terminated, so a consumer reading lines
    // off the pipe parses them one at a time as the scan finds them.
    expect(written.every((chunk) => chunk.endsWith("\n"))).toBe(true)
    expect(written.map((chunk) => (JSON.parse(chunk) as { readonly document: string }).document)).toEqual([
      ...outcome.suggestions.map(() => "suggestion"),
      "seat",
      "outcome"
    ])
  })
})

describe("a repository that cannot be read", () => {
  it("fails the --json scan, naming the root and what the read threw", async () => {
    const error = await Effect.runPromise(
      Effect.flip(
        Suggest.run({
          ...base,
          json: true,
          environment: { OPENAI_API_KEY: "openai-key" },
          repository: unreadable,
          readFile: () => undefined,
          emit: () => {}
        })
      )
    )

    expect(error).toBeInstanceOf(CliError.UnsupportedError)
    expect(CliError.exitCode(error)).toBe(1)
    expect(error.message).toBe("the scan of /gone failed: Error: EACCES: permission denied")
  })

  it("fails the streamed scan the same way, after the seat has been named", async () => {
    const terminal = sink()

    const error = await Effect.runPromise(
      Effect.flip(
        Suggest.run({
          ...base,
          root: "/gone",
          list: true,
          environment: { OPENAI_API_KEY: "openai-key" },
          repository: unreadable,
          readFile: () => undefined
        }).pipe(Effect.provideService(Ui.Ui, Ui.make({ output: terminal.stream, interactive: false })))
      )
    )

    expect(CliError.exitCode(error)).toBe(1)
    expect(error.message).toBe("the scan of /gone failed: EACCES: permission denied")
    // The intro is printed before anything is read, so a failed scan still
    // tells the operator which seat the run had picked.
    expect(terminal.text()).toContain("smthrs suggest on openai:gpt-6-sol (OpenAI)")
  })
})

describe("the pick", () => {
  it("offers each candidate by title and hints how large it is", async () => {
    const terminal = sink()
    const offered: Array<{ readonly label: string; readonly hint: string | undefined }> = []
    const service: Ui.Service = {
      ...Ui.make({ output: terminal.stream, interactive: false }),
      interactive: true,
      pickSuggestion: (items, options) =>
        Effect.sync(() => {
          items.forEach((item, index) =>
            offered.push({ label: options.label(item, index + 1), hint: options.hint?.(item) })
          )
          return Option.none()
        })
    }

    const outcome = await Effect.runPromise(
      Suggest.run({ ...base, environment: { OPENAI_API_KEY: "openai-key" }, readFile: () => undefined }).pipe(
        Effect.provideService(Ui.Ui, service)
      )
    )

    // A pick that listed titles alone would ask an operator to choose
    // between changes without saying which one is the small one.
    expect(offered).toEqual([{ label: onlyMatch, hint: "small" }])
    expect(outcome.status).toBe("cancelled")
    expect(Suggest.exitStatus(outcome)).toBe(130)
  })
})

describe("the implementing step, defaulted to the bundled flow on this host", () => {
  it.each([undefined, "must-not-spend-this-key"])(
    "keeps a detected subscription's auth mode when OPENAI_API_KEY is %s",
    async (apiKey) => {
      const terminal = sink()
      const service: Ui.Service = {
        ...Ui.make({ output: terminal.stream, interactive: false }),
        interactive: true,
        pickSuggestion: (items) => Effect.succeed(Option.fromUndefinedOr(items[0])),
        confirm: () => Effect.succeed(false)
      }
      // Detection sees a session that has disappeared by execution time. The
      // real resolver must ask for that session, even if a metered key exists.
      const error = await Effect.runPromise(Effect.flip(
        Suggest.run({
          ...base,
          root,
          environment: { CODEX_HOME: signedOut, OPENAI_API_KEY: apiKey, SMITHERS_OPENAI_AUTH: "chatgpt" },
          readFile: () => JSON.stringify({ tokens: { access_token: "test-access", refresh_token: "test-refresh" } })
        }).pipe(Effect.provideService(Ui.Ui, service))
      ))
      expect(error.message).toContain("no ChatGPT credentials")
      expect(error.message).not.toContain("Set OPENAI_API_KEY")
    }
  )

  it("resolves the chosen seat for real and refuses before signing anything", { timeout: 120_000 }, async () => {
    const terminal = sink()
    const settled: Array<string> = []
    const service: Ui.Service = {
      ...Ui.make({ output: terminal.stream, interactive: false }),
      interactive: true,
      spinner: () => ({
        start: () => {},
        message: () => {},
        stop: () => {},
        cancel: () => {},
        error: (message) => void settled.push(message ?? "")
      }),
      pickSuggestion: (items) => Effect.succeed(Option.fromUndefinedOr(items[0])),
      confirm: () => Effect.succeed(false)
    }

    const error = await Effect.runPromise(
      Effect.flip(
        Suggest.run({
          ...base,
          root,
          // A provider the resolver has a route for and this machine has no
          // key for: the composition is built and the seat is resolved for
          // real, and the refusal is the last thing that happens before a
          // request would be signed.
          seat: "openrouter:openai/gpt-6-sol",
          environment: {},
          readFile: () => undefined
        }).pipe(Effect.provideService(Ui.Ui, service))
      )
    )

    expect(error).toBeInstanceOf(CliError.UnsupportedError)
    expect(CliError.exitCode(error)).toBe(1)
    // The step is named first, so an operator watching several of them knows
    // which one stopped, and the resolver's own sentence says what to set.
    expect(error.message).toMatch(new RegExp(`^${onlyMatch}: `))
    expect(error.message).toContain("Set OPENROUTER_API_KEY to run the openrouter:openai/gpt-6-sol seat")
    // The spinner for that step settled as an error rather than being left
    // spinning over a failure.
    expect(settled).toEqual([`${onlyMatch}: failed`])
  })
})
