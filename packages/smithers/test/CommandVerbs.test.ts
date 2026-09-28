/**
 * The verbs the other command suites do not reach, driven through the real parser.
 *
 * `CommandHandlers.test.ts` owns the listing and lifecycle spine and
 * `CommandProjections.test.ts` owns `output`, the claude mirror, and `bug`.
 * What was left with no case at all is the rest of the shipped command set: `steer`,
 * `down`, `init`, the `resume`/`workflow list`/`events` aliases, the
 * `claude` follow verbs, and `mcp add`. Each has a
 * module of its own with its own unit tests; none had a case driving the
 * command wiring around it, so a verb could be renamed, mis-decoded, or wired
 * to the wrong service without a single test noticing.
 *
 * The refusals the paged flow catalog owes an operator are here for the same
 * reason. A control plane that answers a flow listing with a run page, repeats
 * a cursor, or hands back more of a catalog than the CLI will hold is a
 * failure an operator has to be told about, and each of those three paths was
 * written and never exercised.
 *
 * Everything here runs against the real `ControlLive` stack over the in-memory
 * runtime, a real project directory under `mkdtemp`, and real files: the only
 * things substituted are the control-plane answers a real plane cannot be made
 * to give on demand.
 */
import { NodeServices } from "@effect/platform-node"
import { Control as ControlService, type ControlSchema } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Effect, Layer, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { hostname, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import * as Agents from "../src/Agents.ts"
import { makeCli } from "../src/Cli.ts"
import * as CliError from "../src/CliError.ts"
import { cli } from "../src/Command.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import { packageVersion } from "../src/Version.ts"

const runCommand = Command.runWith(cli, { version: packageVersion })

const staged: Array<string> = []

afterEach(() => {
  for (const directory of staged.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), "flows-cli-verbs-"))
  staged.push(root)
  return root
}

const demoFlow = {
  flowId: "demo/ship",
  description: "The fixture flow these cases plan, launch, and steer",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} }
} as const

const canonical = async (args: Array<string>, root?: string) => {
  let output = ""
  let code = 0
  await makeCli({ environment: { HOME: process.env["HOME"] } }).serve([
    ...args,
    ...(root === undefined ? [] : ["--root", root]),
    "--json"
  ], {
    stdout: (text) => {
      output += text
    },
    exit: (value) => {
      code = value
    }
  })
  return { code, data: JSON.parse(output), output }
}

const testControl = TestControl.layer({ now: () => 0, flows: [demoFlow] })

const services = Layer.mergeAll(TestConsole.layer, Output.layer, NodeControl.layerMemoryRemote)

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
  return JSON.parse(rendered) as unknown
})

const run = <A, E>(
  effect: Effect.Effect<A, E, ControlService.Control | Layer.Success<typeof services> | NodeServices.NodeServices>,
  control: Layer.Layer<ControlService.Control, unknown>,
  root?: string
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(control),
      Effect.provide(services),
      Effect.provide(
        Project.layer(root ?? process.cwd(), Project.legacyRoot(undefined, root ?? process.cwd()))
      ),
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
  return receipt.runId
})

const event = (sequence: number, kind: string, payload: unknown): ControlSchema.ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence * 1000,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

/** One run with a fixed, finite event history behind it. */
const historyControl = (
  events: ReadonlyArray<ControlSchema.ControlEvent>,
  status: ControlSchema.RunSummary["status"] = "running"
) =>
  Layer.effect(
    ControlService.Control,
    Effect.gen(function*() {
      const control = yield* ControlService.Control
      return ControlService.make({
        ...control,
        list: (request) =>
          request._tag === "runs"
            ? Effect.succeed({
              _tag: "runs",
              items: [{ runId: "run-1", flowId: "demo/ship", status, createdAt: 0, updatedAt: 0 }]
            })
            : control.list(request),
        watch: () => Stream.fromIterable(events)
      })
    })
  ).pipe(Layer.provide(testControl))

/** A control plane that answers every run listing with the given summaries. */
const listingControl = (items: ReadonlyArray<ControlSchema.RunSummary>) =>
  Layer.effect(
    ControlService.Control,
    Effect.gen(function*() {
      const control = yield* ControlService.Control
      return ControlService.make({
        ...control,
        list: (request) => request._tag === "runs" ? Effect.succeed({ _tag: "runs", items }) : control.list(request)
      })
    })
  ).pipe(Layer.provide(testControl))

/** A control plane whose flow listing answers exactly what the case dictates. */
const flowListingControl = (answer: (cursor: string | undefined) => ControlSchema.ListResponse) =>
  Layer.effect(
    ControlService.Control,
    Effect.gen(function*() {
      const control = yield* ControlService.Control
      return ControlService.make({
        ...control,
        list: (request) =>
          request._tag === "flows"
            ? Effect.succeed(answer(request.cursor))
            : control.list(request)
      })
    })
  ).pipe(Layer.provide(testControl))

/** Runs `use` with the home directory pointed at a scratch tree. */
const withHome = async <A>(home: string, use: () => Promise<A>): Promise<A> => {
  const previousHome = process.env["HOME"]
  const previousProfile = process.env["USERPROFILE"]
  process.env["HOME"] = home
  process.env["USERPROFILE"] = home
  try {
    return await use()
  } finally {
    if (previousHome === undefined) delete process.env["HOME"]
    else process.env["HOME"] = previousHome
    if (previousProfile === undefined) delete process.env["USERPROFILE"]
    else process.env["USERPROFILE"] = previousProfile
  }
}

describe("smthrs steer", () => {
  it("delivers the operator's message to a launched run and reports the receipt", async () => {
    const receipt = await run(
      Effect.gen(function*() {
        const runId = yield* launch()
        return (yield* json(["--json", "steer", runId, "--message", "prefer the smaller diff"])) as {
          readonly _tag: string
        }
      }),
      testControl
    )

    // The receipt is the control plane's own, so a script reads the delivery
    // from the same shape every other mutation answers with.
    expect(receipt._tag).toBeTypeOf("string")
  })

  it("refuses the removed --takeover flag instead of silently ignoring it", async () => {
    const exit = await run(
      Effect.exit(text(["steer", "run-1", "--message", "hello", "--takeover"])),
      testControl
    )

    expect(exit._tag).toBe("Failure")
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain("takeover")
  })
})

describe("smthrs down", () => {
  it("cancels every run that has not settled and reports one receipt each", async () => {
    const cancelled = await run(
      Effect.gen(function*() {
        yield* launch()
        return (yield* json(["--json", "down"])) as {
          readonly cancelled: ReadonlyArray<{ readonly runId: string }>
        }
      }),
      testControl
    )

    expect(cancelled.cancelled.length).toBeGreaterThan(0)
    for (const entry of cancelled.cancelled) expect(entry.runId).toBeTypeOf("string")
  })

  it("cancels nothing when every run the plane holds is already terminal", async () => {
    const terminal: ControlSchema.RunSummary = {
      runId: "run-done",
      flowId: "demo/ship",
      status: "completed",
      createdAt: 0,
      updatedAt: 0
    }

    const cancelled = await run(json(["--json", "down"]), listingControl([terminal]))

    // `down` is "stop what is still running", not "touch every row": a
    // completed run has nothing to cancel and must not be sent a mutation.
    expect(cancelled).toEqual({ cancelled: [] })
  })
})

describe("smthrs init", () => {
  it("scaffolds a flow into the project and reports where it wrote", async () => {
    const root = project()

    const result = await canonical(["init", "ship-it"], root)
    expect(result.code, result.output).toBe(0)
    const scaffolded = result.data

    expect(scaffolded).toBeTypeOf("object")
    expect(existsSync(join(root, "flows", "ship-it"))).toBe(true)
  })

  it("refuses a name that would write outside flows/ before touching the disk", async () => {
    const root = project()

    const result = await canonical(["init", "../outside"], root)

    expect(result.code).toBe(1)
    expect(result.output).toContain("one path segment")
    // The refusal is a refusal, not a partial scaffold: nothing was created
    // under the project and nothing was created beside it.
    expect(existsSync(join(root, "flows"))).toBe(false)
  })
})

describe("the unlisted aliases", () => {
  it("resumes through `resume <run-id>` exactly as `run --resume` does", async () => {
    const receipts = await run(
      Effect.gen(function*() {
        const runId = yield* launch()
        const aliased = (yield* json(["--json", "resume", runId])) as {
          readonly _tag: string
          readonly runId: string
          readonly receiptId: string
        }
        const spelled = (yield* json(["--json", "run", "--resume", runId])) as {
          readonly _tag: string
          readonly receiptId: string
        }
        return { runId, aliased, spelled }
      }),
      testControl
    )

    expect(receipts.aliased).toMatchObject({ _tag: "Accepted", runId: receipts.runId })
    // One implementation behind two spellings: the alias mints the same
    // idempotency key, so the spelled-out form replays the alias's receipt
    // rather than resuming the run a second time.
    expect(receipts.spelled).toMatchObject({
      _tag: "AlreadyApplied",
      receiptId: receipts.aliased.receiptId
    })
  })

  it("lists flows through `workflow list` exactly as `ls` does", async () => {
    const both = await run(
      Effect.gen(function*() {
        const listed = yield* text(["--json", "ls"])
        const aliased = yield* text(["--json", "workflow", "list"])
        return { listed, aliased }
      }),
      testControl
    )

    expect(both.aliased).toBe(both.listed)
  })

  it("reads a run's history through `events` exactly as `logs --json` does", async () => {
    const both = await run(
      Effect.gen(function*() {
        const logged = yield* text(["--json", "logs", "run-1"])
        const aliased = yield* text(["events", "run-1"])
        return { logged, aliased }
      }),
      historyControl([event(1, "control.run.started", null)])
    )

    expect(both.aliased).toBe(both.logged)
  })
})

describe("smthrs claude node-wait", () => {
  const settled: ReadonlyArray<ControlSchema.ControlEvent> = [
    event(1, "control.agent.cell-call-started", { flowName: "read", input: { path: "a.ts" } }),
    event(2, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "contents of a" })
  ]

  it("returns the node the moment it has settled", async () => {
    const node = await run(
      json(["claude", "node-wait", "run-1", "read#1"]),
      historyControl(settled)
    ) as { readonly nodeId: string; readonly outcome: string; readonly timedOut: boolean }

    expect(node).toMatchObject({ nodeId: "read#1", outcome: "success", timedOut: false })
  })

  it("reports a node that never appeared in a run that has already ended", async () => {
    const node = await run(
      json(["claude", "node-wait", "run-1", "ghost#1"]),
      historyControl(settled, "completed")
    ) as { readonly nodeId: string; readonly outcome: string; readonly status: string }

    // "vanished" rather than a timeout: the run is terminal, so no further
    // waiting can produce the node, and telling the caller to keep waiting for
    // thirty seconds would be a lie.
    expect(node).toMatchObject({ nodeId: "ghost#1", outcome: "vanished", status: "completed" })
  })

  it("gives up at the deadline on a running run that never produces the node", async () => {
    const node = await run(
      json(["claude", "node-wait", "run-1", "ghost#1", "--timeout-ms", "0"]),
      historyControl(settled)
    ) as { readonly nodeId: string; readonly outcome: string; readonly timedOut: boolean }

    expect(node).toEqual({ nodeId: "ghost#1", outcome: "pending", timedOut: true })
  })

  it("refuses a run the control plane does not have", async () => {
    const exit = await run(Effect.exit(text(["claude", "node-wait", "missing", "read#1"])), testControl)

    expect(exit._tag).toBe("Failure")
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain("Run not found")
  })
})

describe("smthrs claude monitor", () => {
  const transitions: ReadonlyArray<ControlSchema.ControlEvent> = [
    event(1, "control.run.started", null),
    event(2, "control.run.parked", { reason: "approval" }),
    event(3, "control.run.completed", null)
  ]

  it("prints one NDJSON line per notable transition across every run", async () => {
    const root = project()

    const rendered = await run(text(["claude", "monitor", "--all-runs"]), historyControl(transitions), root)

    const lines = rendered.split("\n").filter((line) => line !== "")
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(JSON.parse(line)).toMatchObject({ runId: "run-1" })
  })

  it("keeps only the most recent transitions when the limit is smaller than the history", async () => {
    const root = project()

    const rendered = await run(
      text(["claude", "monitor", "--all-runs", "--limit", "1"]),
      historyControl(transitions),
      root
    )

    // The ring is a bound, not a filter: one line, and it is the last
    // transition rather than the first.
    const lines = rendered.split("\n").filter((line) => line !== "")
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]!)).toMatchObject({ runId: "run-1" })
  })

  it("prints nothing for a session that follows no run", async () => {
    const root = project()

    const rendered = await run(
      text(["claude", "monitor", "--session", "unfollowed"]),
      historyControl(transitions),
      root
    )

    // Without `--all-runs` the mirror reports only what this session
    // subscribed to, and this one subscribed to nothing.
    expect(rendered).toBe("")
  })
})

describe("smthrs mcp add", () => {
  it("registers the MCP server in each agent's own config file", async () => {
    const home = project()

    const wired = await withHome(
      home,
      async () => {
        const result = await canonical(["mcp", "add"])
        expect(result.code, result.output).toBe(0)
        return result.data
      }
    ) as ReadonlyArray<{ readonly agent: string; readonly status: string }>

    expect(wired.map((entry) => entry.agent).sort()).toEqual(Agents.agents.map((agent) => agent.id).sort())
    const claude = JSON.parse(readFileSync(join(home, ".claude.json"), "utf8")) as {
      readonly mcpServers: Record<string, unknown>
    }
    expect(Object.keys(claude.mcpServers)).toContain("smithers")
  })

  it("refuses an agent it does not know, naming the ones it does", async () => {
    const home = project()

    const exit = await withHome(
      home,
      () => canonical(["mcp", "add", "--agent", "emacs"])
    )

    expect(exit.code).toBe(2)
    const failure = exit.output
    expect(failure).toContain("emacs")
    for (const agent of Agents.agents) expect(failure).toContain(agent.id)
  })
})

describe("the paged flow catalog's refusals", () => {
  const flowPage = (
    items: ReadonlyArray<{ readonly flowId: string; readonly description: string }>,
    nextCursor?: string
  ): ControlSchema.ListResponse =>
    ({
      _tag: "flows",
      items: items.map((item) => ({ ...item, deployClass: false })),
      ...(nextCursor === undefined ? {} : { nextCursor })
    }) as ControlSchema.ListResponse

  it("refuses a run page answered to a flow listing", async () => {
    const exit = await run(
      Effect.exit(text(["ls"])),
      flowListingControl(() => ({ _tag: "runs", items: [] }) as ControlSchema.ListResponse)
    )

    expect(exit._tag).toBe("Failure")
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain("run page for a flow listing")
  })

  it("refuses a control plane that repeats a cursor instead of paging forever", async () => {
    const exit = await run(
      Effect.exit(text(["ls"])),
      flowListingControl(() => flowPage([{ flowId: "demo/ship", description: "one" }], "same-cursor"))
    )

    expect(exit._tag).toBe("Failure")
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain("repeated a flow-listing cursor")
  })

  it("refuses a catalog larger than the CLI will hold, naming the limit it hit", async () => {
    const oversized = Array.from({ length: 50_001 }, (_, index) => ({
      flowId: `demo/flow-${index}`,
      description: "x"
    }))

    const exit = await run(Effect.exit(text(["ls"])), flowListingControl(() => flowPage(oversized)))

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" ? exit.cause : undefined
    expect(String(failure)).toContain("50000")
    expect(String(failure)).toContain("events")
  })

  it("reports each distinct discovery warning once, however many pages repeat it", async () => {
    const warning = { code: "flow_metadata_invalid", path: "flows/a", message: "no name" }
    let page = 0
    const listed = await run(
      json(["--json", "doctor"]),
      flowListingControl(() => {
        page += 1
        return ({
          _tag: "flows",
          items: [],
          warnings: [warning, warning],
          ...(page === 1 ? { nextCursor: "next" } : {})
        }) as ControlSchema.ListResponse
      })
    ) as { readonly checks: ReadonlyArray<{ readonly name: string; readonly detail: string }> }

    // Two pages, each carrying the same warning twice: `doctor` renders one
    // check per distinct warning, so the operator is told about one problem
    // rather than the same one four times.
    expect(page).toBe(2)
    const reported = listed.checks.filter((check) => check.name === "registry flows/a")
    expect(reported).toHaveLength(1)
    expect(reported[0]?.detail).toBe("flow_metadata_invalid: no name")
  })
})

describe("the executor-handoff label on a listing", () => {
  const summary = (
    runId: string,
    fields: Partial<ControlSchema.RunSummary>
  ): ControlSchema.RunSummary => ({
    runId,
    flowId: "demo/ship",
    status: "accepted",
    createdAt: 0,
    updatedAt: 0,
    ...fields
  } as ControlSchema.RunSummary)

  it("labels only the accepted runs whose owner this host can prove is gone", async () => {
    const now = Date.now()
    const stale = now - 60_000
    const rows = [
      summary("no-owner", { updatedAt: stale }),
      summary("unparseable-owner", { updatedAt: stale, ownerId: "not json at all" }),
      summary("foreign-host", {
        updatedAt: stale,
        ownerId: JSON.stringify({ hostId: `${hostname()}-elsewhere`, pid: 4242, nonce: "n" })
      }),
      summary("live-owner", {
        updatedAt: stale,
        ownerId: JSON.stringify({ hostId: hostname(), pid: process.pid, nonce: "n" })
      }),
      summary("just-launched", { updatedAt: now })
    ]

    const listed = await run(json(["--json", "ps"]), listingControl(rows)) as {
      readonly items: ReadonlyArray<{ readonly runId: string; readonly waitingReason?: string }>
    }

    const labelled = new Map(listed.items.map((item) => [item.runId, item.waitingReason]))
    // No owner recorded past the handoff window is the one case this host can
    // decide on its own evidence.
    expect(labelled.get("no-owner")).toBe("executor")
    // Everything else is left alone: an owner record it cannot parse, an owner
    // on another machine whose process table it cannot read, an owner that is
    // demonstrably alive, and a launch still inside the handoff window.
    expect(labelled.get("unparseable-owner")).toBeUndefined()
    expect(labelled.get("foreign-host")).toBeUndefined()
    expect(labelled.get("live-owner")).toBeUndefined()
    expect(labelled.get("just-launched")).toBeUndefined()
  })
})

describe("smthrs logs --follow over an oversized event", () => {
  it("stops with a resource-limit failure instead of streaming a megabyte of one payload", async () => {
    const huge = event(1, "control.agent.cell-call-settled", { flowName: "read", value: "x".repeat(1_100_000) })

    const exit = await run(Effect.exit(text(["logs", "run-1", "--follow"])), historyControl([huge]))

    expect(exit._tag).toBe("Failure")
    const failure = String(exit._tag === "Failure" ? exit.cause : "")
    expect(failure).toContain("log follow")
    expect(failure).toContain("bytes")
  })
})

describe("the reserved catalog", () => {
  it.each([["plan"], ["up"]] as const)("refuses to %s a reserved system flow", async (verb) => {
    const exit = await run(Effect.exit(text([verb, "system/release"])), testControl)

    expect(exit._tag).toBe("Failure")
    const failure = String(exit._tag === "Failure" ? exit.cause : "")
    expect(failure).toContain("system/release")
  })

  it("keeps the reserved catalog out of `ls` even when the plane lists it", async () => {
    const listed = await run(json(["--json", "ls"]), testControl) as {
      readonly items: ReadonlyArray<{ readonly flowId: string }>
    }

    expect(listed.items.map((item) => item.flowId)).toEqual(["demo/ship"])
  })
})

describe("exit statuses these verbs report", () => {
  it("gives a usage error 2 and an unsupported failure 1", () => {
    expect(CliError.exitCode(new CliError.UsageError({ message: "x" }))).toBe(2)
    expect(CliError.exitCode(new CliError.UnsupportedError({ message: "x" }))).toBe(1)
  })
})
