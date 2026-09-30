/**
 * Every command handler in the tree, driven through the real parser.
 *
 * `ControlSurface.test.ts` covers the plan/approve/run spine and the remote
 * transports. These cases cover the rest of the surface: the listing,
 * lifecycle, and projection verbs, plus the argument decoding that every verb
 * shares: bare keys, `key=value` pairs, `--data` merged over them, and the
 * `--json`/`--quiet` presentation flags that change what the other flags mean.
 */
import { NodeServices } from "@effect/platform-node"
import { Control as ControlService, ControlError, type ControlSchema } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Cause, Effect, Exit, Layer, Option, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { CliError as ParserError, Command } from "effect/unstable/cli"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Readable, Writable } from "node:stream"
import { describe, expect, it, vi } from "vitest"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as CliError from "../src/CliError.ts"
import { cli, latestSequence } from "../src/Command.ts"
import * as ExecutorOwnership from "../src/ExecutorOwnership.ts"
import * as RunListing from "../src/internal/RunListing.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import * as Ui from "../src/Ui.ts"
import { packageVersion } from "../src/Version.ts"

const runCommand = Command.runWith(cli, { version: packageVersion })

/** The lines one invocation logged, joined; empty when the verb printed nothing. */
const text = Effect.fnUntraced(function*(args: ReadonlyArray<string>) {
  const before = (yield* TestConsole.logLines).length
  yield* runCommand(args)
  const lines = yield* TestConsole.logLines
  return lines.slice(before).map(String).join("\n")
})

/** The decoded `--json` payload of one invocation. */
const json = Effect.fnUntraced(function*(args: ReadonlyArray<string>) {
  const rendered = yield* text(args)
  return yield* Effect.try({
    try: () => JSON.parse(rendered) as unknown,
    catch: (cause) => new Error(`command produced invalid JSON: ${String(cause)} (${rendered})`)
  })
})

/**
 * The project flow these cases plan, approve, and run.
 *
 * A reserved `system/*` id would be simpler to reach. `TestControl` falls
 * back to the whole reserved catalog, but the CLI refuses to plan one, since
 * a reserved id has no body and a launch would park forever
 * (`Unsupported.reservedFlowError`). So the fixture registers a flow of its
 * own, which is also what an operator's project looks like.
 */
const demoFlow = {
  flowId: "demo/ship",
  description: "The fixture flow these cases plan and run",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} }
} as const

const testControl = TestControl.layer({ now: () => 0, flows: [demoFlow] })
// `memory` is part of the command tree, so every invocation carries its
// requirement. These cases have no local database, which is exactly the
// `--remote` situation, so they get the same refusing store a remote
// invocation gets rather than opening a `.flows/` beside the test run.
const services = Layer.mergeAll(TestConsole.layer, Output.layer, NodeControl.layerMemoryRemote)

const run = <A, E>(
  effect: Effect.Effect<A, E, ControlService.Control | Layer.Success<typeof services> | NodeServices.NodeServices>,
  control: Layer.Layer<ControlService.Control, unknown>
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(control),
      Effect.provide(services),
      Effect.provide(NodeServices.layer)
    )
  )

/** Plans, approves, and launches `demo/ship`, returning the run identifier. */
const launch = Effect.fnUntraced(function*() {
  const card = (yield* json(["--json", "plan", "demo/ship"])) as { readonly approval: unknown }
  const approval = JSON.stringify(card.approval)
  yield* json(["--json", "approve", approval])
  const receipt = (yield* json(["--json", "run", approval])) as { readonly runId?: unknown }
  if (typeof receipt.runId !== "string") return yield* Effect.fail(new Error("run did not emit its identifier"))
  return { runId: receipt.runId, approval }
})

describe("ls for a person", () => {
  it("prints one line per flow, unstarred without a catalog, and keeps the document under --json", async () => {
    const result = await run(
      Effect.gen(function*() {
        return { human: yield* text(["ls"]), json: yield* text(["--json", "ls"]) }
      }),
      testControl
    )
    expect(result.human).toBe(`  ${demoFlow.flowId}  ${demoFlow.description}`)
    expect(JSON.parse(result.json)).toEqual({
      _tag: "flows",
      items: [{ flowId: demoFlow.flowId, description: demoFlow.description }]
    })
  })
})

/** A control whose `watch` serves a fixed, finite history. */
const historyControl = (events: ReadonlyArray<ControlSchema.ControlEvent>, fail = false) =>
  Layer.effect(
    ControlService.Control,
    Effect.gen(function*() {
      const control = yield* ControlService.Control
      return ControlService.make({
        ...control,
        list: (request) =>
          request._tag === "runs" && request.filters?.runId === "run-1"
            ? Effect.succeed({
              _tag: "runs",
              items: [{
                runId: "run-1",
                flowId: "demo/ship",
                status: "running",
                createdAt: 0,
                updatedAt: 0
              }]
            })
            : control.list(request),
        watch: () =>
          fail
            ? Stream.fail(new ControlError.Unavailable({ feature: "watch", ticket: "test" }))
            : Stream.fromIterable(events)
      })
    })
  ).pipe(Layer.provide(testControl))

const event = (
  sequence: number,
  kind: string,
  payload: unknown = null
): ControlSchema.ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

describe("journal sequence folding", () => {
  it("finds the latest sequence beyond the spread-argument boundary", async () => {
    const events = Array.from({ length: 200_000 }, (_, index) => ({ sequence: index + 1 }))

    expect(await Effect.runPromise(latestSequence(Stream.fromIterable(events)))).toBe(200_000)
  })
})

describe("input decoding", () => {
  it("splits pairs on the first separator and treats a bare key as a set flag", async () => {
    const card = await run(
      json(["--json", "plan", "demo/ship", "verbose", "a=1", "k=v=w"]),
      testControl
    )

    // A bare key is `true`, a pair keeps everything after the first `=`, and
    // the summary is the canonical form of exactly that decoded object.
    expect((card as { readonly inputSummary: string }).inputSummary).toBe(
      JSON.stringify({ a: "1", "k": "v=w", verbose: true })
    )
  })

  it("treats a leading separator as a bare key, not an empty name", async () => {
    const card = await run(json(["--json", "plan", "demo/ship", "=lead", "b="]), testControl)

    // `separator < 1` is the boundary: index 0 is a bare key, index 1 is the
    // shortest real pair and its value is the empty string.
    expect((card as { readonly inputSummary: string }).inputSummary).toBe(
      JSON.stringify({ "=lead": true, b: "" })
    )
  })

  it("plans with no pairs at all as the empty input object", async () => {
    const card = await run(json(["--json", "plan", "demo/ship"]), testControl)

    expect((card as { readonly inputSummary: string }).inputSummary).toBe("{}")
  })

  it("merges an object --data over the positional pairs", async () => {
    const card = await run(
      json(["--json", "plan", "demo/ship", "a=1", "b=2", "--data", "{\"a\":\"overridden\",\"c\":3}"]),
      testControl
    )

    // `--data` is applied last, so it wins the key it shares with a pair.
    expect((card as { readonly inputSummary: string }).inputSummary).toBe(
      JSON.stringify({ a: "overridden", b: "2", c: 3 })
    )
  })

  it("reads --data @file and merges it over positional pairs", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smthrs-data-"))
    try {
      const file = join(directory, "input.json")
      writeFileSync(file, "{\"a\":\"file\",\"count\":2}")
      const card = await run(json(["--json", "plan", "demo/ship", "a=pair", "--data", `@${file}`]), testControl)
      expect((card as { readonly inputSummary: string }).inputSummary).toBe(
        JSON.stringify({ a: "file", count: 2 })
      )
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("reads --data - from stdin for plan", async () => {
    const stdin = vi.spyOn(process, "stdin", "get").mockReturnValue(
      Readable.from(["{\"topic\":\"stdin\"}"]) as typeof process.stdin
    )
    try {
      const card = await run(json(["--json", "plan", "demo/ship", "--data", "-"]), testControl)
      expect((card as { readonly inputSummary: string }).inputSummary).toBe(
        JSON.stringify({ topic: "stdin" })
      )
    } finally {
      stdin.mockRestore()
    }
  })

  it("rejects a missing --data file with a usage error", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smthrs-data-"))
    try {
      const error = await run(
        Effect.flip(runCommand(["plan", "demo/ship", "--data", `@${join(directory, "missing.json")}`])),
        testControl
      )
      expect(error).toBeInstanceOf(CliError.UsageError)
      expect((error as Error).message).toContain("missing.json")
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(
    [
      ["an array", "[1,2]", [1, 2]],
      ["a scalar", "7", 7],
      ["null", "null", null]
    ] as const
  )("nests %s --data under `data` beside the pairs", async (_label, serialized, expected) => {
    const card = await run(
      json(["--json", "plan", "demo/ship", "a=1", "--data", serialized]),
      testControl
    )

    expect((card as { readonly inputSummary: string }).inputSummary).toBe(
      JSON.stringify({ a: "1", data: expected })
    )
  })

  it("names the missing flow id and the interactive fallback", async () => {
    const error = await run(Effect.flip(runCommand(["--json", "plan"])), testControl)

    expect(error).toBeInstanceOf(ParserError.ShowHelp)
    const issue = (error as ParserError.ShowHelp).errors[0] as ParserError.UserError
    expect(issue.cause).toBeInstanceOf(CliError.UsageError)
    expect(issue.userMessage).toContain("flow-id")
    expect(issue.userMessage).toContain("--wizard")
  })

  it("collects both the run id and message for a bare steer command", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        const prompts: Array<string> = []
        const ui: Ui.Service = {
          ...Ui.make({ output: process.stderr, interactive: false }),
          interactive: true,
          text: (message) =>
            Effect.sync(() => {
              prompts.push(message)
              return Option.some(message === "Enter run-id" ? launched.runId : "continue")
            })
        }
        const receipt = yield* json(["--json", "steer"]).pipe(Effect.provideService(Ui.Ui, ui))
        return { receipt, prompts }
      }),
      testControl
    )
    expect(observed.prompts.sort()).toEqual(["Enter --message", "Enter run-id"])
    expect(observed.receipt).toMatchObject({ _tag: "Accepted" })
  })

  it("collects a missing run id before cancelling the selected run", async () => {
    const observed = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        const prompts: Array<string> = []
        const ui: Ui.Service = {
          ...Ui.make({ output: process.stderr, interactive: false }),
          interactive: true,
          text: (message) =>
            Effect.sync(() => {
              prompts.push(message)
              return Option.some(launched.runId)
            })
        }
        const receipt = yield* json(["--json", "cancel"]).pipe(Effect.provideService(Ui.Ui, ui))
        return { receipt, prompts, runId: launched.runId }
      }),
      testControl
    )
    expect(observed.prompts).toEqual(["Enter run-id"])
    expect(observed.receipt).toMatchObject({ runId: observed.runId })
  })

  it("opens the flow picker when a terminal omits the flow id", async () => {
    const ui: Ui.Service = {
      ...Ui.make({ output: process.stdout, interactive: false }),
      interactive: true,
      pickSuggestion: (items) => Effect.succeed(Option.fromNullishOr(items[0]))
    }
    const card = await run(
      json(["--json", "plan"]).pipe(Effect.provideService(Ui.Ui, ui)),
      testControl
    )

    expect(card).toMatchObject({ flowId: "demo/ship" })
  })

  it("explains how to create a flow when the picker has no candidates", async () => {
    const ui: Ui.Service = { ...Ui.make({ output: process.stderr, interactive: false }), interactive: true }
    const error = await run(
      Effect.flip(runCommand(["plan"])).pipe(Effect.provideService(Ui.Ui, ui)),
      TestControl.layer({ now: () => 0, flows: [] })
    )

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toBe("No flows discovered; run smthrs init to create one")
  })

  it.each(["plan", "cancel"])("interrupts %s when required input collection is cancelled", async (verb) => {
    const ui: Ui.Service = {
      ...Ui.make({ output: process.stderr, interactive: false }),
      interactive: true,
      text: () => Effect.succeed(Option.none()),
      pickSuggestion: () => Effect.succeed(Option.none())
    }
    const exit = await run(
      Effect.exit(runCommand([verb])).pipe(Effect.provideService(Ui.Ui, ui)),
      testControl
    )

    expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true)
  })
})

describe("presentation flags", () => {
  it("renders human output as indented JSON when --json is absent", async () => {
    const rendered = await run(text(["plan", "demo/ship"]), testControl)

    expect(rendered).toContain("\n  \"flowId\": \"demo/ship\"")
  })

  it("keeps the command document under --quiet while still performing the mutation", async () => {
    const result = await run(
      Effect.gen(function*() {
        const quiet = yield* text(["--json", "--quiet", "plan", "demo/ship"])
        const loud = yield* text(["--json", "plan", "demo/ship"])
        return { quiet, loud }
      }),
      testControl
    )

    expect(JSON.parse(result.quiet)).toMatchObject({ flowId: "demo/ship" })
    expect(JSON.parse(result.loud)).toMatchObject({ flowId: "demo/ship" })
  })

  it("refuses a non-positive monitor limit before reading the journal", async () => {
    const error = await run(
      Effect.flip(runCommand(["claude", "monitor", "--limit", "0"])),
      testControl
    )

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toBe("--limit must be a positive integer; got \"0\"")
  })
})

it("preserves an event-history watch failure with its run and operation", async () => {
  const error = await run(Effect.flip(runCommand(["logs", "run-1"])), historyControl([], true))

  expect(error).toBeInstanceOf(ControlError.TransportError)
  expect((error as ControlError.TransportError).message).toContain("event-history read")
  expect((error as ControlError.TransportError).message).toContain("run-1")
})

describe("listing verbs", () => {
  it("lists flows", async () => {
    const listed = await run(json(["--json", "ls"]), testControl)

    expect(listed).toMatchObject({ _tag: "flows" })
  })

  it("lists runs with no filters and with both filters applied", async () => {
    const result = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        const all = yield* json(["--json", "ps"])
        const matching = yield* json(["--json", "ps", "--flow", "demo/ship", "--status", "accepted"])
        const wrongStatus = yield* json(["--json", "ps", "--flow", "demo/ship", "--status", "failed"])
        const wrongFlow = yield* json(["--json", "ps", "--flow", "system/other", "--status", "accepted"])
        return { runId: launched.runId, all, matching, wrongStatus, wrongFlow }
      }),
      testControl
    )

    // Both filters are conjunctive: either one alone disagreeing empties the
    // listing that the pair together matches.
    expect(result.all).toMatchObject({ _tag: "runs", items: [{ runId: result.runId }] })
    expect(result.matching).toMatchObject({ _tag: "runs", items: [{ runId: result.runId }] })
    expect(result.wrongStatus).toEqual({ _tag: "runs", items: [] })
    expect(result.wrongFlow).toEqual({ _tag: "runs", items: [] })
  })

  it("pages runs by key with --limit and --cursor", async () => {
    const result = await run(
      Effect.gen(function*() {
        const launched = [(yield* launch()).runId, (yield* launch()).runId, (yield* launch()).runId]
        const pages: Array<
          { readonly items: ReadonlyArray<{ readonly runId: string }>; readonly nextCursor?: string }
        > = []
        let cursor: string | undefined
        do {
          const page = (yield* json(["--json", "ps", "--limit", "2", ...(cursor ? ["--cursor", cursor] : [])])) as {
            readonly items: ReadonlyArray<{ readonly runId: string }>
            readonly nextCursor?: string
          }
          pages.push(page)
          cursor = page.nextCursor
        } while (cursor !== undefined && pages.length < 5)
        return { launched, pages }
      }),
      testControl
    )

    expect(result.pages.map((page) => page.items.length)).toEqual([2, 1])
    expect(result.pages.flatMap((page) => page.items.map((item) => item.runId))).toEqual(result.launched)
  })
})

describe("run listing filters", () => {
  type Page = { readonly items: ReadonlyArray<{ readonly runId: string }>; readonly nextCursor?: string }
  const ids = (page: unknown) => (page as Page).items.map((item) => item.runId)

  it("applies creation-window, parent, and sort flags, and walks sorted pages without repeats", async () => {
    const result = await run(
      Effect.gen(function*() {
        const launched = [(yield* launch()).runId, (yield* launch()).runId, (yield* launch()).runId]
        const walk = Effect.fnUntraced(function*(flags: ReadonlyArray<string>) {
          const seen: Array<string> = []
          let cursor: string | undefined
          do {
            const page =
              (yield* json(["--json", "ps", ...flags, "--limit", "1", ...(cursor ? ["--cursor", cursor] : [])])) as Page
            seen.push(...page.items.map((item) => item.runId))
            cursor = page.nextCursor
          } while (cursor !== undefined && seen.length < 10)
          return seen
        })
        return {
          launched,
          newest: yield* walk(["--sort", "newest"]),
          oldest: yield* walk(["--sort", "oldest"]),
          // The fixture clock stamps every run at 0: `since` includes it, `until` excludes it.
          since: ids(yield* json(["--json", "ps", "--since", "0"])),
          sinceIso: ids(yield* json(["--json", "ps", "--since", "1970-01-01T00:00:00.000Z"])),
          sinceAfter: ids(yield* json(["--json", "ps", "--since", "1"])),
          untilAt: ids(yield* json(["--json", "ps", "--until", "0"])),
          untilAfter: ids(yield* json(["--json", "ps", "--until", "1970-01-01T00:00:00.001Z"])),
          window: ids(yield* json(["--json", "ps", "--since", "0", "--until", "0"])),
          parent: ids(yield* json(["--json", "ps", "--parent", launched[0]!])),
          filteredCount: yield* RunListing.count(yield* RunListing.request({ flow: "demo/ship", since: "0" })),
          emptyCount: yield* RunListing.count(yield* RunListing.request({ since: "1" }))
        }
      }),
      testControl
    )

    expect(result.newest).toEqual([...result.launched].reverse())
    expect(result.oldest).toEqual(result.launched)
    expect(result.since).toEqual(result.launched)
    expect(result.sinceIso).toEqual(result.launched)
    expect(result.sinceAfter).toEqual([])
    expect(result.untilAt).toEqual([])
    expect(result.untilAfter).toEqual(result.launched)
    expect(result.window).toEqual([])
    expect(result.parent).toEqual([])
    expect(result.filteredCount).toBe(3)
    expect(result.emptyCount).toBe(0)
  })

  it.each([
    [["--since", "yesterday"], "--since must be epoch milliseconds or an ISO 8601 date, received \"yesterday\""],
    [["--until", "1.5"], "--until must be epoch milliseconds or an ISO 8601 date, received \"1.5\""],
    [["--until", "2026-13-45"], "--until must be epoch milliseconds or an ISO 8601 date, received \"2026-13-45\""],
    [["--since", "2", "--until", "1"], "--since must not be after --until"]
  ])("refuses %j before reading runs", async (flags, message) => {
    const error = await run(Effect.flip(runCommand(["ps", ...flags])), testControl)

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toBe(message)
  })

  it("counts across pages larger than one listing page", async () => {
    const pages: Array<ControlSchema.ListRequest> = []
    const control = Layer.effect(ControlService.Control)(
      Effect.map(ControlService.Control, (base) => ({
        ...base,
        list: (request: ControlSchema.ListRequest) => {
          pages.push(request)
          return Effect.succeed(
            request.cursor === undefined
              ? { _tag: "runs" as const, items: Array.from({ length: 500 }, () => ({})), nextCursor: "p2" }
              : { _tag: "runs" as const, items: Array.from({ length: 7 }, () => ({})) }
          ) as never
        }
      }))
    ).pipe(Layer.provide(testControl))
    const counted = await run(
      Effect.flatMap(
        RunListing.request({ status: "failed", parent: "root", trigger: "nightly", sort: "newest" }, {
          limit: 3,
          cursor: "ignored"
        }),
        RunListing.count
      ),
      control
    )

    expect(counted).toBe(507)
    const filters = { status: "failed", parentRunId: "root", triggerId: "nightly" }
    expect(pages).toEqual([
      { _tag: "runs", filters, order: "newest", limit: 500 },
      { _tag: "runs", filters, order: "newest", limit: 500, cursor: "p2" }
    ])
  })
})

describe("lifecycle verbs", () => {
  it("cancels a launched run and reports the terminal status", async () => {
    const result = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        const receipt = yield* json(["--json", "cancel", launched.runId])
        const listed = yield* json(["--json", "ps"])
        return { receipt, listed }
      }),
      testControl
    )

    // Cancellation is synchronous here, so the receipt already reports the
    // terminal status the listing then shows.
    expect(result.receipt).toMatchObject({ _tag: "Terminal", status: "cancelled" })
    expect(result.listed).toMatchObject({ _tag: "runs", items: [{ status: "cancelled" }] })
  })

  it("answers a repeated cancel from the run rather than from its receipt", async () => {
    const result = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        const first = yield* json(["--json", "cancel", launched.runId])
        const second = yield* json(["--json", "cancel", launched.runId])
        return { first, second }
      }),
      testControl
    )

    // Retargeted: the key is derived from the run id alone, so a repeated
    // cancel used to replay the first one's receipt as `AlreadyApplied`. That
    // is the right answer only while the receipt is still true, and a cancel
    // that finished nothing leaves a non-terminal run behind. The release validation
    // smoke's `cancel` and `down` both replayed against two runs no command
    // could reach. `cancel` reads the run first now, so a settled run answers
    // `Terminal` every time and a live one is asked again.
    expect(result.first).toMatchObject({ _tag: "Terminal", status: "cancelled" })
    expect(result.second).toMatchObject({ _tag: "Terminal", status: "cancelled" })
  })

  it("answers a repeated resume from the run rather than from its receipt", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const launched = yield* launch()
        const first = yield* json(["--json", "run", launched.runId, "--resume"])
        yield* json(["--json", "cancel", launched.runId])
        const second = yield* json(["--json", "run", launched.runId, "--resume"])
        return { first, second }
      }).pipe(
        Effect.timeout("20 seconds"),
        // A remote CLI owns no driver, so the receipt is the whole answer and
        // the settlement wait is out of the way of what this asks.
        Effect.provide(ExecutorOwnership.layer(false)),
        Effect.provide(testControl),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    // The key is `cli:resume:<runId>` when no park was ever committed, so the
    // second call reuses the first one's receipt. Replaying it answered
    // `AlreadyApplied` for a run that had since been cancelled: the release validation
    // smoke got that answer for `run --resume` against a completed run and for
    // `approve` against another, and neither says anything about the run.
    expect(result.first).toMatchObject({ _tag: "Accepted" })
    expect(result.second).toMatchObject({ _tag: "Terminal", status: "cancelled" })
  })

  it("delivers a named JSON signal to a run", async () => {
    const receipt = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        return yield* json([
          "--json",
          "signal",
          launched.runId,
          "{\"name\":\"proceed\",\"payload\":{\"answer\":42}}"
        ])
      }),
      testControl
    )

    expect(receipt).toMatchObject({ _tag: "Accepted" })
  })

  it("rejects a signal payload that parses but does not match the schema", async () => {
    const error = await run(
      Effect.flip(runCommand(["signal", "run-1", "{\"name\":\"proceed\"}"])),
      testControl
    )

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toContain("signal-json must match the expected payload schema")
    expect((error as CliError.UsageError).message).toContain("payload")
    expect((error as CliError.UsageError).message).not.toContain("{\"name\":\"proceed\"}")
  })

  it("denies a complete approval payload", async () => {
    const receipt = await run(
      Effect.gen(function*() {
        const card = (yield* json(["--json", "plan", "demo/ship"])) as { readonly approval: unknown }
        return yield* json(["--json", "deny", JSON.stringify(card.approval)])
      }),
      testControl
    )

    expect(receipt).toMatchObject({ _tag: "Accepted" })
  })

  it("refuses to run an in-run node approval payload", async () => {
    const payload = JSON.stringify({
      target: {
        _tag: "Node",
        runId: "run-1",
        requestId: "request-1",
        digest: "digest-1",
        envelope: { capabilities: [], flows: [], budget: {} }
      },
      scope: "run",
      idempotencyKey: "approve:node-1"
    })
    const error = await run(Effect.flip(runCommand(["run", payload])), testControl)

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toBe("run requires a plan approval payload")
    expect(CliError.exitCode(error as CliError.UsageError)).toBe(2)
  })
})

describe("up", () => {
  it("plans, approves for the run, and launches in one command", async () => {
    const receipt = await run(json(["--json", "up", "demo/ship"]), testControl)

    // One command, one receipt: the plan and its approval are internal to the
    // verb, and the caller reads the run id off the receipt because rc.0 has
    // no operator-supplied run id (the release policy).
    expect(receipt).toMatchObject({ _tag: "Accepted" })
    expect(typeof (receipt as { readonly runId: string }).runId).toBe("string")
  })

  it("launches with --data @file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "smthrs-data-"))
    try {
      const file = join(directory, "input.json")
      writeFileSync(file, "{\"topic\":\"file\"}")
      const receipt = await run(json(["--json", "up", "demo/ship", "--data", `@${file}`]), testControl)
      expect(receipt).toMatchObject({ _tag: "Accepted" })
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it("refuses to auto-approve an envelope that grants every capability", async () => {
    const wildcardFlow = {
      ...demoFlow,
      flowId: "demo/skill",
      envelope: { capabilities: ["*"], flows: [], budget: {} }
    } as const
    const error = await run(
      Effect.flip(runCommand(["up", "demo/skill"])),
      TestControl.layer({ now: () => 0, flows: [wildcardFlow] })
    )

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toContain("grants every capability")
    // The hint names the canonical verbs, never the hidden `plan`/`approve` aliases.
    expect((error as CliError.UsageError).message).toContain("smthrs flow plan")
    expect((error as CliError.UsageError).message).toContain("smthrs approvals approve")
    expect((error as CliError.UsageError).message).toContain("smthrs flow plan demo/skill")
  })

  it("lays --budget-tokens, --budget-ms and --on-exceeded over the flow's budget", async () => {
    const cards: Array<ControlSchema.PlanCard> = []
    const recording = Layer.effect(ControlService.Control)(
      Effect.map(ControlService.Control, (control) => ({
        ...control,
        plan: (input: Parameters<typeof control.plan>[0]) =>
          control.plan(input).pipe(Effect.tap((card) => Effect.sync(() => cards.push(card))))
      }))
    ).pipe(Layer.provide(testControl))
    const receipt = await run(
      json(["--json", "up", "demo/ship", "--budget-tokens", "50", "--budget-ms", "1000", "--on-exceeded", "park"]),
      recording
    )

    expect(receipt).toMatchObject({ _tag: "Accepted" })
    expect(cards.map((card) => card.envelope.budget)).toEqual([{ tokens: 50, milliseconds: 1000, onExceeded: "park" }])
  })

  it("refuses a budget ceiling that is not a positive integer before planning", async () => {
    const error = await run(Effect.flip(runCommand(["up", "demo/ship", "--budget-tokens", "0"])), testControl)

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toBe("--budget-tokens must be a positive integer")
  })

  it("lays --budget-usd over the flow's budget, fractions included", async () => {
    const cards: Array<ControlSchema.PlanCard> = []
    const recording = Layer.effect(ControlService.Control)(
      Effect.map(ControlService.Control, (control) => ({
        ...control,
        plan: (input: Parameters<typeof control.plan>[0]) =>
          control.plan(input).pipe(Effect.tap((card) => Effect.sync(() => cards.push(card))))
      }))
    ).pipe(Layer.provide(testControl))
    const receipt = await run(
      json(["--json", "up", "demo/ship", "--budget-usd", "2.5", "--on-exceeded", "park"]),
      recording
    )

    expect(receipt).toMatchObject({ _tag: "Accepted" })
    expect(cards.map((card) => card.envelope.budget)).toEqual([{ usd: 2.5, onExceeded: "park" }])
  })

  it.each(["0", "-1"])("refuses a --budget-usd of %s before planning", async (value) => {
    const error = await run(Effect.flip(runCommand(["up", "demo/ship", `--budget-usd=${value}`])), testControl)

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toBe("--budget-usd must be a positive dollar amount")
  })

  it("carries --data into the planned input", async () => {
    const card = await run(json(["--json", "plan", "demo/ship", "--data", "{\"topic\":\"flows\"}"]), testControl)

    expect(card).toMatchObject({ flowId: "demo/ship" })
    expect((card as { readonly inputSummary: string }).inputSummary).toBe(JSON.stringify({ topic: "flows" }))
  })

  it("hands the detached child the parent's MCP config and explicit root", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-detached-argv-"))
    const originalArgv = process.argv
    const previousMarker = process.env["SMITHERS_TEST_DETACHED_ARGV"]
    try {
      const marker = join(root, "argv.json")
      const entry = join(root, "child.mjs")
      const mcpConfig = join(root, "servers.json")
      writeFileSync(mcpConfig, "[]")
      writeFileSync(
        entry,
        [
          "import { writeFileSync } from \"node:fs\"",
          "writeFileSync(process.env.SMITHERS_TEST_DETACHED_ARGV, JSON.stringify(process.argv.slice(2)))",
          "const nonce = process.env.SMITHERS_INTERNAL_DETACHED_ADMISSION",
          "process.stderr.write(\"SMITHERS_DETACHED_ADMISSION=run:\" + nonce + \" runId=run-detached-test\\n\")"
        ].join("\n")
      )
      process.argv = [process.execPath, entry]
      process.env["SMITHERS_TEST_DETACHED_ARGV"] = marker

      const error = await run(
        Effect.flip(
          json([
            "--json",
            "--mcp-config",
            mcpConfig,
            "--root",
            root,
            "up",
            "demo/ship",
            "-d"
          ]).pipe(Effect.provide(Project.layer(root, Project.legacyRoot(undefined, root))))
        ),
        testControl
      )

      // The fake child only announces an id; the parent's control store holds
      // no such run for this plan, so the launch is refused, not receipted.
      expect(error).toBeInstanceOf(CliError.UnsupportedError)
      expect((error as CliError.UnsupportedError).message).toContain("announced run-detached-test")
      const argv = JSON.parse(readFileSync(marker, "utf8")) as ReadonlyArray<string>
      expect(argv[0]).toBe("run")
      expect(argv.slice(2)).toEqual(["--mcp-config", mcpConfig, "--root", root])
    } finally {
      process.argv = originalArgv
      if (previousMarker === undefined) delete process.env["SMITHERS_TEST_DETACHED_ARGV"]
      else process.env["SMITHERS_TEST_DETACHED_ARGV"] = previousMarker
      rmSync(root, { recursive: true, force: true })
    }
  }, 15_000)

  it("refuses a detached executor against --remote before any network call", async () => {
    const error = await run(
      Effect.flip(runCommand([
        "--remote",
        "http://127.0.0.1:9999",
        "up",
        "demo/ship",
        "-d"
      ])),
      testControl
    )

    expect(error).toBeInstanceOf(CliError.UnsupportedError)
    expect((error as CliError.UnsupportedError).message).toBe(
      "flow start -d spawns a local executor; run `smthrs flow start` attached against --remote"
    )
  })
})

describe("forensic projections", () => {
  it("renders the human status card for one run and the raw listing under --json", async () => {
    const result = await run(
      Effect.gen(function*() {
        const launched = yield* launch()
        const card = yield* text(["status", launched.runId])
        const raw = yield* json(["--json", "status", launched.runId])
        return { runId: launched.runId, card, raw }
      }),
      testControl
    )

    // `--json` keeps the stable listing shape; the human reader gets the
    // diagnosis computed from the run's own events.
    expect(result.card).toContain("Verdict")
    expect(result.card).toContain(`Next      smthrs runs logs ${result.runId}`)
    expect(result.raw).toMatchObject({ _tag: "runs", items: [{ runId: result.runId }] })
  })

  it("renders the whole listing when no run id is given, in either format", async () => {
    const result = await run(
      Effect.gen(function*() {
        yield* launch()
        const human = yield* text(["status"])
        const raw = yield* json(["--json", "status"])
        return { human, raw }
      }),
      testControl
    )

    // Without a run id there is nothing to diagnose, so the human form is the
    // indented listing rather than a card.
    expect(result.human).toContain("\"_tag\": \"runs\"")
    expect(result.raw).toMatchObject({ _tag: "runs" })
  })

  it("refuses a run query when the listing answers with the wrong shape", async () => {
    const mismatched = Layer.effect(
      ControlService.Control,
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        return ControlService.make({
          ...control,
          list: () => Effect.succeed({ _tag: "flows", items: [] })
        })
      })
    ).pipe(Layer.provide(testControl))
    const error = await run(Effect.flip(runCommand(["status", "run-1"])), mismatched)

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toContain("\"run-1\"")
  })

  it.each(
    [
      ["status", ["status", "run-missing"]],
      ["why", ["why", "run-missing"]],
      ["logs", ["logs", "run-missing"]],
      ["output", ["output", "run-missing"]]
    ] as const
  )("refuses a missing run in %s", async (_verb, args) => {
    const error = await run(Effect.flip(runCommand(args)), testControl)

    expect(error).toBeInstanceOf(CliError.UsageError)
    expect((error as CliError.UsageError).message).toBe("Run not found: \"run-missing\"")
    expect(CliError.exitCode(error as CliError.UsageError)).toBe(2)
  })

  it("names the memory a run was brought and the memory Jev withheld on its status card", async () => {
    const reading = (sequence: number, kept: ReadonlyArray<string>, withheld: ReadonlyArray<string>) =>
      event(sequence, "control.agent.relevance-settled", {
        scope: "run-1/coding/draft-plan",
        frame: 0,
        source: "run",
        withholdAt: 0.9,
        latencyMs: 5,
        kept: kept.map((id) => ({ kind: "memory", id, digest: `d-${id}`, p: 0.1 })),
        withheld: withheld.map((id) => ({ kind: "memory", id, digest: `d-${id}`, p: 0.95 }))
      })
    const history = historyControl([
      event(1, "control.run.running", { runId: "run-1", status: "running" }),
      reading(2, ["coding-learning-migrations"], ["coding-learning-release"]),
      reading(3, ["coding-learning-tests"], [])
    ])
    const card = await run(text(["status", "run-1"]), history)
    expect(card).toContain(
      "Memory    2 in: coding-learning-migrations, coding-learning-tests · 1 withheld: coding-learning-release"
    )
    const unread = await run(
      text(["status", "run-1"]),
      historyControl([event(1, "control.run.running", { runId: "run-1", status: "running" })])
    )
    expect(unread).not.toContain("Memory")
  })

  it("projects a finite history as a transcript for humans and as raw events under --json", async () => {
    const history = historyControl([
      event(1, "control.run.running", { runId: "run-1", status: "running" }),
      event(2, "control.agent.turn-opened", { seat: "anthropic:claude-sonnet-4-5" }),
      event(3, "control.run.completed", { runId: "run-1", status: "completed" })
    ])
    const result = await run(
      Effect.gen(function*() {
        const transcript = yield* text(["logs", "run-1"])
        const raw = yield* json(["--json", "logs", "run-1"])
        return { transcript, raw }
      }),
      history
    )

    expect(result.transcript).toContain("=== turn 1 · anthropic:claude-sonnet-4-5 ===")
    expect(result.transcript).toContain("run-1 · completed")
    expect(Array.isArray(result.raw)).toBe(true)
    expect((result.raw as ReadonlyArray<unknown>).length).toBe(3)
  })

  it("renders one line per event as it lands under --follow, in either format", async () => {
    const history = historyControl([
      event(1, "control.agent.cell-produced", { text: "return 1" }),
      event(2, "control.run.completed", { runId: "run-1", status: "completed" })
    ])
    const result = await run(
      Effect.gen(function*() {
        const human = yield* text(["logs", "run-1", "--follow"])
        const raw = yield* text(["--json", "logs", "run-1", "--follow"])
        return { human, raw }
      }),
      history
    )

    // Follow mode renders per event, so two events are two rendered lines in
    // both formats, never the whole-run transcript.
    expect(result.human.split("\n")).toEqual([
      "cell    return 1",
      "control.run.completed {\"runId\":\"run-1\",\"status\":\"completed\"}"
    ])
    expect(result.raw.split("\n").length).toBe(2)
    expect(JSON.parse(result.raw.split("\n")[0]!)).toMatchObject({ kind: "control.agent.cell-produced" })
  })

  it("reads every run's events when no run id is given", async () => {
    const history = historyControl([event(1, "control.run.running", { runId: "run-1", status: "running" })])
    const raw = await run(json(["--json", "logs"]), history)

    expect((raw as ReadonlyArray<unknown>).length).toBe(1)
  })
})

describe("owned-run settlement", () => {
  const watchControl = (resumes: { count: number }, failHistory: boolean) =>
    Layer.effect(
      ControlService.Control,
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        return ControlService.make({
          ...control,
          resume: (input) => {
            resumes.count += 1
            return Effect.succeed({ _tag: "Accepted", receiptId: input.idempotencyKey, runId: "run-1" })
          },
          watch: (filter) =>
            failHistory || filter.follow !== false
              ? Stream.fail(new Error("transport gone") as never)
              : Stream.empty
        })
      })
    ).pipe(Layer.provide(testControl))

  it("fails a resume before mutation when the latest-park lookup fails", async () => {
    const resumes = { count: 0 }
    const exit = await Effect.runPromise(
      Effect.exit(json(["--json", "run", "run-1", "--resume"])).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.provide(watchControl(resumes, true)),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(ControlError.TransportError)
    expect((error as ControlError.TransportError).message).toContain("approval-park lookup")
    expect((error as ControlError.TransportError).message).toContain("run-1")
    expect(resumes.count).toBe(0)
  })

  it("fails after admission when a locally owned settlement watch fails", async () => {
    const resumes = { count: 0 }
    const exit = await Effect.runPromise(
      Effect.exit(json(["--json", "run", "run-1", "--resume"])).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.provide(watchControl(resumes, false)),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
    expect(error).toBeInstanceOf(ControlError.TransportError)
    expect((error as ControlError.TransportError).message).toContain("settlement")
    expect((error as ControlError.TransportError).message).toContain("run-1")
    expect(resumes.count).toBe(1)
  })

  it("does not wait on settlement when this process does not own the executor", async () => {
    const resumes = { count: 0 }
    const receipt = await Effect.runPromise(
      json(["--json", "run", "run-1", "--resume"]).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(ExecutorOwnership.layer(false)),
        Effect.provide(watchControl(resumes, false)),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(receipt).toMatchObject({ _tag: "Accepted" })
    expect(resumes.count).toBe(1)
  })

  it("stops the settlement wait at the first settling event kind", async () => {
    const settlements = [
      "control.run.waiting-approval",
      "control.run.pending",
      "control.run.completed",
      "control.run.failed",
      "control.run.cancelled"
    ] as const
    const results = await Promise.all(settlements.map((kind) =>
      Effect.runPromise(
        Effect.exit(json(["--json", "run", "run-1", "--resume"])).pipe(
          Effect.timeout("5 seconds"),
          Effect.provide(ExecutorOwnership.layer(true)),
          Effect.provide(
            Layer.effect(
              ControlService.Control,
              Effect.gen(function*() {
                const control = yield* ControlService.Control
                return ControlService.make({
                  ...control,
                  resume: (input) =>
                    Effect.succeed({ _tag: "Accepted", receiptId: input.idempotencyKey, runId: "run-1" }),
                  watch: (filter) =>
                    filter.follow === false
                      ? Stream.empty
                      : Stream.make(
                        event(1, "control.agent.turn-opened", { seat: "s" }),
                        event(2, kind, {
                          cause: "quota_exceeded: Add credits to continue.\nError: The cell frame failed"
                        })
                      ).pipe(
                        Stream.concat(Stream.never)
                      )
                })
              })
            ).pipe(Layer.provide(testControl))
          ),
          Effect.provide(services),
          Effect.provide(NodeServices.layer)
        )
      )
    ))

    // Every settlement kind releases the wait; a non-settling event before it
    // does not. `control.run.pending` releases it with the executor's refusal
    // rather than the launch receipt: the run is durable and stopped.
    for (const [index, exit] of results.entries()) {
      const kind = settlements[index]!
      if (kind === "control.run.pending") {
        expect(Exit.isFailure(exit)).toBe(true)
        // Restated 2026-08-31: the refusal used to read "the executor did not
        // take it"; it now names the cause and both ways forward.
        expect(String(Exit.isFailure(exit) ? Cause.squash(exit.cause) : "")).toContain(
          "no executor took it"
        )
        continue
      }
      expect(Exit.isSuccess(exit)).toBe(true)
      expect(Exit.isSuccess(exit) ? exit.value : undefined).toMatchObject({ _tag: "Accepted" })
      if (kind === "control.run.failed") {
        expect(Exit.isSuccess(exit) ? exit.value : undefined).toMatchObject({
          runId: "run-1",
          status: "failed",
          cause: "quota_exceeded: Add credits to continue."
        })
      }
    }
  })
})

describe("attached human progress", () => {
  it("streams tasks during resume and keeps --silent independent of the JSON receipt", async () => {
    for (const silent of [false, true]) {
      const progress: Array<string> = []
      let following = 0
      const output = new Writable({
        write(chunk, _encoding, callback) {
          progress.push(String(chunk))
          callback()
        }
      })
      const receipt = await Effect.runPromise(
        json(["--json", "--audience", "human", ...(silent ? ["--silent"] : []), "resume", "run-1"]).pipe(
          Effect.provideService(RunProgress.Configuration, {
            policy: {
              audience: "human",
              source: "override",
              harnesses: [],
              structured: true,
              progress: "plain",
              interactive: false
            },
            output
          }),
          Effect.provide(ExecutorOwnership.layer(true)),
          Effect.provide(
            Layer.effect(
              ControlService.Control,
              Effect.gen(function*() {
                const control = yield* ControlService.Control
                return ControlService.make({
                  ...control,
                  resume: (input) =>
                    Effect.succeed({ _tag: "Accepted", receiptId: input.idempotencyKey, runId: "run-1" }),
                  watch: (filter) => {
                    if (filter.follow === false) return Stream.empty
                    following++
                    return Stream.make(
                      event(1, "control.agent.cell-call-started", { flowName: "test" }),
                      event(2, "control.agent.cell-call-settled", { flowName: "test", outcome: "success" }),
                      event(3, "control.run.completed")
                    ).pipe(Stream.concat(Stream.never))
                  }
                })
              })
            ).pipe(Layer.provide(testControl))
          ),
          Effect.provide(services),
          Effect.provide(NodeServices.layer)
        )
      )
      expect(receipt).toMatchObject({ _tag: "Accepted", runId: "run-1" })
      expect(following).toBe(1)
      if (silent) expect(progress.join("")).toBe("")
      else {
        expect(progress.join("")).toContain("Running test")
        expect(progress.join("")).toContain("test completed")
      }
    }
  })
})

describe("exit statuses", () => {
  it("gives a parked receipt exit status 3 and an accepted one status 0", async () => {
    const result = await run(
      Effect.gen(function*() {
        const card = (yield* json(["--json", "plan", "demo/ship"])) as { readonly approval: unknown }
        const approval = JSON.stringify(card.approval)
        const parked = yield* json(["--json", "run", approval])
        yield* json(["--json", "approve", approval])
        const accepted = yield* json(["--json", "run", approval])
        return { parked, accepted }
      }),
      testControl
    )

    expect(Output.exitCode(result.parked)).toBe(3)
    expect(Output.exitCode(result.accepted)).toBe(0)
  })

  it("fails an unknown subcommand as a parse error, not a control call", async () => {
    const exit = await Effect.runPromise(
      Effect.exit(runCommand(["nope"])).pipe(
        Effect.provide(testControl),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(String(Cause.squash(exit.cause))).not.toContain("demo/ship")
    }
  })
})

describe("`gc` over a database it cannot open", () => {
  it("names the file and fails, instead of rendering an empty sweep and exiting 0", async () => {
    // `gc --dry-run` is trusted to name exactly what a real pass would delete.
    // A file it could not even open rendered as `{ runs: [], deleted: {} }`
    // with exit 0, which reads as "there is nothing to collect".
    const root = mkdtempSync(join(tmpdir(), "smithers-gc-handler-"))
    try {
      mkdirSync(join(root, ".flows"), { recursive: true })
      writeFileSync(join(root, ".flows", "control.db"), "not a database at all")

      const exit = await Effect.runPromise(
        Effect.exit(runCommand(["gc", "--dry-run", "--json"])).pipe(
          Effect.provide(testControl),
          Effect.provide(services),
          // The migration root defaults the way `NodeControl` defaults it when a
          // configuration names none, so this drives the layer the CLI builds.
          Effect.provide(Project.layer(root, Project.legacyRoot(undefined, root))),
          Effect.provide(NodeServices.layer)
        )
      )

      expect(Exit.isFailure(exit)).toBe(true)
      const error = Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined
      expect(error).toBeInstanceOf(CliError.UnsupportedError)
      expect((error as CliError.UnsupportedError).message).toContain(join(root, ".flows", "control.db"))
      expect(CliError.exitCode(error as CliError.UnsupportedError)).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("deciding an in-run approval from the CLI", () => {
  const nodePayload = (runId: string) =>
    JSON.stringify({
      target: {
        _tag: "Node",
        runId,
        requestId: "request-1",
        digest: "digest-1",
        envelope: { capabilities: [], flows: [], budget: {} }
      },
      scope: "run",
      idempotencyKey: `approve:${runId}`
    })

  /**
   * A control whose run settles only while somebody is watching it.
   *
   * That is what a local executor is: `Control.approve` resumes the parked run
   * server-side, and the driver that picks the resume up lives exactly as long
   * as the process that opened it. A command that prints its receipt and
   * returns takes the driver down with it, so the run it just restarted stops
   * where it stood.
   *
   * The committed park is served as history so the wait has to be scoped past
   * it: `control.run.waiting-approval` is itself a settling kind, and a wait
   * that replayed it would return without ever driving the run.
   */
  const settlingControl = (state: { status: string; runs: number }) =>
    Layer.effect(
      ControlService.Control,
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        const decided = (input: ControlService.ApprovalInput): ControlSchema.Receipt =>
          input.target._tag === "Node"
            ? { _tag: "Accepted", receiptId: input.idempotencyKey, runId: input.target.runId }
            : { _tag: "Accepted", receiptId: input.idempotencyKey }
        return ControlService.make({
          ...control,
          run: (input) => {
            state.runs += 1
            return control.run(input)
          },
          approve: (input) => Effect.succeed(decided(input)),
          deny: (input) => Effect.succeed(decided(input)),
          watch: (filter) => {
            const history = (filter.afterSequence ?? 0) < 1
              ? [event(1, "control.run.waiting-approval")]
              : []
            if (filter.follow === false) return Stream.fromIterable(history)
            return Stream.fromIterable(history).pipe(
              Stream.concat(Stream.fromEffect(
                Effect.delay(
                  Effect.sync(() => {
                    state.status = "completed"
                    return event(2, "control.run.completed")
                  }),
                  "20 millis"
                )
              )),
              Stream.concat(Stream.never)
            )
          }
        })
      })
    ).pipe(Layer.provide(testControl))

  const decide = (verb: "approve" | "deny") => json(["--json", verb, nodePayload("run-1")])

  it.each(["approve", "deny"] as const)("settles a parked run on %s alone", async (verb) => {
    const state = { status: "waiting-approval", runs: 0 }
    const receipt = await Effect.runPromise(
      decide(verb).pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(ExecutorOwnership.layer(true)),
        Effect.provide(settlingControl(state)),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    // the release policy: the decision resumes the run, so one call settles it.
    expect(receipt).toMatchObject({ _tag: "Accepted", runId: "run-1" })
    expect(state.status).toBe("completed")
    // And it settles through the decision, not through a second verb.
    expect(state.runs).toBe(0)
  })

  it("hands a USD budget raise to the control plane with its dollar ceiling intact", async () => {
    const decided: Array<ControlService.ApprovalInput> = []
    const recording = Layer.effect(
      ControlService.Control,
      Effect.map(ControlService.Control, (control) =>
        ControlService.make({
          ...control,
          approve: (input) =>
            Effect.sync(() => {
              decided.push(input)
              return { _tag: "Accepted", receiptId: input.idempotencyKey } as const
            })
        }))
    ).pipe(Layer.provide(testControl))
    const payload = {
      target: {
        _tag: "Node",
        runId: "run-1",
        requestId: "budget/run-1/usd",
        digest: "digest-1",
        envelope: { capabilities: [], flows: [], budget: { usd: 2.2, tokens: 5_000, onExceeded: "park" } }
      },
      scope: "once",
      idempotencyKey: "approve:budget"
    }
    const receipt = await Effect.runPromise(
      json(["--json", "approve", JSON.stringify(payload)]).pipe(
        Effect.provide(ExecutorOwnership.layer(false)),
        Effect.provide(recording),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    expect(receipt).toMatchObject({ _tag: "Accepted" })
    expect(decided.map((input) => input.target)).toEqual([payload.target])
  })

  it("does not wait on a decision when this process does not own the executor", async () => {
    const state = { status: "waiting-approval", runs: 0 }
    const receipt = await Effect.runPromise(
      decide("approve").pipe(
        Effect.timeout("5 seconds"),
        Effect.provide(ExecutorOwnership.layer(false)),
        Effect.provide(settlingControl(state)),
        Effect.provide(services),
        Effect.provide(NodeServices.layer)
      )
    )

    // A remote CLI owns no driver; the server it called owns the resume.
    expect(receipt).toMatchObject({ _tag: "Accepted" })
    expect(state.status).toBe("waiting-approval")
  })
})

describe("signal idempotency", () => {
  /** Records the mutation key each `signal` invocation minted. */
  const recordingSignals = (keys: Array<string>) =>
    Layer.effect(
      ControlService.Control,
      Effect.gen(function*() {
        const control = yield* ControlService.Control
        return ControlService.make({
          ...control,
          signal: (input) =>
            Effect.sync(() => {
              keys.push(input.idempotencyKey)
              return { _tag: "Accepted", receiptId: input.idempotencyKey, runId: input.runId }
            })
        })
      })
    ).pipe(Layer.provide(testControl))

  it("mints one mutation per signal payload", async () => {
    const keys: Array<string> = []
    await run(
      Effect.gen(function*() {
        yield* json(["--json", "signal", "run-1", "{\"name\":\"first\",\"payload\":null}"])
        yield* json(["--json", "signal", "run-1", "{\"name\":\"second\",\"payload\":null}"])
      }),
      recordingSignals(keys)
    )

    // the release policy: two different signals to one run are two mutations. A
    // key that named the run alone replayed the first receipt for the second
    // signal, and the second signal was never delivered.
    expect(new Set(keys).size).toBe(2)
    expect(keys.every((key) => key.startsWith("cli:signal:run-1:"))).toBe(true)
  })

  it("replays one mutation for the same signal sent twice", async () => {
    const keys: Array<string> = []
    await run(
      Effect.gen(function*() {
        yield* json(["--json", "signal", "run-1", "{\"name\":\"first\",\"payload\":null}"])
        yield* json(["--json", "signal", "run-1", "{\"name\":\"first\",\"payload\":null}"])
      }),
      recordingSignals(keys)
    )

    expect(new Set(keys).size).toBe(1)
  })
})
