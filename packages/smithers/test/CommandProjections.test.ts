/**
 * The projection and reporting verbs, driven through the real parser.
 *
 * `CommandHandlers.test.ts` covers the listing and lifecycle spine. These are
 * the verbs on the other side of it: `output`, which answers what one step
 * produced; the `claude` mirror subcommands, which keep a per-session
 * subscription registry on disk; and `bug`, which posts a report over real
 * HTTP. Each has a projection module of its own with its own unit tests
 * (`NodeOutput`, `ClaudeMirror`, `Bug`), and each was wired into the command
 * tree without a case that drove the wiring: the argument decoding, the
 * `--json` versus rendered split, the refusals, and the services the handler
 * reaches for. That is what these cases pin.
 *
 * The HTTP endpoint is a real server on a real loopback port, not a stubbed
 * `fetch`: `bug` is a verb whose whole behaviour is what it does with a
 * response, and a double would assert the double.
 */
import { NodeServices } from "@effect/platform-node"
import { Control as ControlService, type ControlSchema } from "@smthrs/control"
import * as TestControl from "@smthrs/control/test/TestControl"
import { Cause, Effect, Layer, Stream } from "effect"
import { TestConsole } from "effect/testing"
import { Command } from "effect/unstable/cli"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer, type Server } from "node:http"
import { type AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PassThrough, Writable } from "node:stream"
import { afterEach, describe, expect, it } from "vitest"
import * as ClaudeMirror from "../src/ClaudeMirror.ts"
import * as CliError from "../src/CliError.ts"
import { cli } from "../src/Command.ts"
import * as NodeControl from "../src/NodeControl.ts"
import * as Output from "../src/Output.ts"
import * as Project from "../src/Project.ts"
import * as Ui from "../src/Ui.ts"
import { packageVersion } from "../src/Version.ts"

const runCommand = Command.runWith(cli, { version: packageVersion })

const staged: Array<string> = []
const servers: Array<Server> = []

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
  for (const directory of staged.splice(0)) rmSync(directory, { recursive: true, force: true })
})

const project = (): string => {
  const root = mkdtempSync(join(tmpdir(), "flows-cli-projections-"))
  staged.push(root)
  return root
}

const demoFlow = {
  flowId: "demo/ship",
  description: "The fixture flow these cases project",
  deployClass: false,
  envelope: { capabilities: [], flows: [], budget: {} }
} as const

const testControl = TestControl.layer({ now: () => 0, flows: [demoFlow] })

const event = (sequence: number, kind: string, payload: unknown): ControlSchema.ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence * 1000,
  payload: payload as ControlSchema.ControlEvent["payload"]
})

/** One run with a fixed, finite event history behind it. */
const historyControl = (events: ReadonlyArray<ControlSchema.ControlEvent>) =>
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
              items: [{
                runId: "run-1",
                flowId: "demo/ship",
                status: "running" as const,
                createdAt: 0,
                updatedAt: 0
              }, { runId: "unrelated", flowId: "demo/ship", status: "running" as const, createdAt: 0, updatedAt: 0 }]
            })
            : control.list(request),
        watch: () => Stream.fromIterable(events)
      })
    })
  ).pipe(Layer.provide(testControl))

const calls: ReadonlyArray<ControlSchema.ControlEvent> = [
  event(1, "control.agent.cell-call-started", { flowName: "read", input: { path: "a.ts" } }),
  event(2, "control.agent.cell-call-settled", { flowName: "read", outcome: "success", value: "contents of a" }),
  event(3, "control.agent.cell-call-started", { flowName: "write", input: { path: "c.ts" } })
]

const services = Layer.mergeAll(TestConsole.layer, Output.layer, NodeControl.layerMemoryRemote)

/** The lines one invocation logged, joined. */
const text = Effect.fnUntraced(function*(args: ReadonlyArray<string>) {
  const before = (yield* TestConsole.logLines).length
  yield* runCommand(args)
  const lines = yield* TestConsole.logLines
  return lines.slice(before).map(String).join("\n")
})

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

describe("smthrs output", () => {
  it("projects every node of a run when no node is named", async () => {
    const nodes = await run(json(["--json", "output", "run-1"]), historyControl(calls)) as ReadonlyArray<
      { readonly nodeId: string; readonly outcome: string }
    >

    // The call that never settled is still a row: an operator asking what a
    // dead run was doing is asking about exactly that call.
    expect(nodes.map((node) => node.nodeId)).toEqual(["read#1", "write#1"])
    expect(nodes[1]?.outcome).toBe("pending")
  })

  it("answers one named node as its whole record under --json", async () => {
    const node = await run(json(["--json", "output", "run-1", "read#1"]), historyControl(calls)) as {
      readonly nodeId: string
      readonly value: unknown
      readonly input: unknown
    }

    expect(node).toMatchObject({ nodeId: "read#1", value: "contents of a", input: { path: "a.ts" } })
  })

  it("renders one named node for a terminal, not as JSON, without --json", async () => {
    const rendered = await run(text(["output", "run-1", "read#1"]), historyControl(calls))

    // The rendered form is prose for an operator; the JSON form above is the
    // same node for a script. Both come from the one handler, and the flag is
    // the only difference between them.
    expect(rendered).toContain("read#1")
    expect(rendered).toContain("contents of a")
    expect(rendered.startsWith("{")).toBe(false)
  })

  it("refuses an unknown node id and lists what the run does have", async () => {
    const exit = await run(
      Effect.exit(text(["output", "run-1", "ghost#9"])),
      historyControl(calls)
    )

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" ? String(exit.cause) : ""
    expect(failure).toContain("ghost#9")
    expect(failure).toContain("read#1")
  })

  it("refuses a run the control plane does not have, before projecting an empty history", async () => {
    const exit = await run(Effect.exit(text(["output", "missing-run"])), testControl)

    expect(exit._tag).toBe("Failure")
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain("Run not found")
  })
})

describe("smthrs claude", () => {
  it("subscribes a session to a run, reports the count, and unsubscribes it again", async () => {
    const root = project()

    const subscribed = await run(
      json(["--json", "claude", "subscribe", "run-1", "--session", "session-a"]),
      testControl,
      root
    )
    expect(subscribed).toEqual({ subscriptions: 1 })
    // The registry is a file, not process state: the next `smithers` process
    // over this project has to find the subscription the last one wrote.
    expect(ClaudeMirror.readSubscriptions(root)).toMatchObject([{ runId: "run-1", sessionId: "session-a" }])

    const unsubscribed = await run(
      json(["--json", "claude", "unsubscribe", "run-1", "--session", "session-a"]),
      testControl,
      root
    )
    expect(unsubscribed).toEqual({ subscriptions: 0 })
    expect(ClaudeMirror.readSubscriptions(root)).toEqual([])
  })

  it("prints one mirror frame and re-asserts the subscription while it does", async () => {
    const root = project()

    const frame = await run(
      json(["--json", "claude", "tick", "run-1", "--session", "session-b"]),
      historyControl(calls),
      root
    ) as { readonly runId: string; readonly status: string }

    expect(frame).toMatchObject({ runId: "run-1", status: "running" })
    // Following a run is subscribing: a registry lost to a crash repairs
    // itself on the next tick rather than needing a second verb.
    expect(ClaudeMirror.readSubscriptions(root)).toMatchObject([{ runId: "run-1", sessionId: "session-b" }])
  })
})

describe("smthrs bug", () => {
  /** A real HTTP endpoint on a loopback port, and the requests it received. */
  const endpoint = async (status: number) => {
    const received: Array<unknown> = []
    const server = createServer((request, response) => {
      let body = ""
      request.setEncoding("utf8")
      request.on("data", (chunk: string) => {
        body += chunk
      })
      request.on("end", () => {
        received.push(JSON.parse(body))
        response.writeHead(status, { "content-type": "application/json" })
        response.end("{}")
      })
    })
    servers.push(server)
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()))
    const port = (server.address() as AddressInfo).port
    return { url: `http://127.0.0.1:${port}/`, received }
  }

  const withEndpoint = async <A>(url: string, use: () => Promise<A>): Promise<A> => {
    const previous = process.env["SMITHERS_BUG_ENDPOINT"]
    process.env["SMITHERS_BUG_ENDPOINT"] = url
    try {
      return await use()
    } finally {
      if (previous === undefined) delete process.env["SMITHERS_BUG_ENDPOINT"]
      else process.env["SMITHERS_BUG_ENDPOINT"] = previous
    }
  }

  it.each([["the", "gc", "verb", "hangs"], ["the gc verb hangs"]])(
    "posts the report with summary words %j and says where it went",
    async (...summary) => {
      const target = await endpoint(202)

      const reported = await withEndpoint(
        target.url,
        () => run(json(["--json", "bug", "--yes", ...summary]), testControl)
      )

      expect(reported).toEqual({ reported: true, endpoint: target.url })
      // The variadic summary is one sentence, and the environment the report
      // carries is this process's own rather than anything the caller supplied.
      expect(target.received).toHaveLength(1)
      expect(target.received[0]).toMatchObject({
        summary: "the gc verb hangs",
        version: packageVersion,
        node: process.versions.node
      })
    }
  )

  it("fails with the status when the endpoint refuses the report", async () => {
    const target = await endpoint(503)

    const exit = await withEndpoint(
      target.url,
      () => run(Effect.exit(text(["bug", "--yes", "everything", "is", "broken"])), testControl)
    )

    expect(exit._tag).toBe("Failure")
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain("503")
    const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
    expect(error).toMatchObject({ _tag: "/cli/Refused", fault: "dependency", code: "bug_report_rejected" })
  })

  it("names the endpoint it could not reach, never the transport's raw text", async () => {
    const exit = await withEndpoint(
      "http://127.0.0.1:1/",
      () => run(Effect.exit(text(["bug", "--yes", "everything", "is", "broken"])), testControl)
    )

    const error = exit._tag === "Failure" ? Cause.squash(exit.cause) : undefined
    expect(error).toMatchObject({
      _tag: "/cli/Refused",
      fault: "dependency",
      code: "bug_report_unreachable",
      message: "Could not reach http://127.0.0.1:1/. The report was not sent."
    })
    expect(CliError.exitCode(error as CliError.CliError)).toBe(1)
  })

  it("requires consent before sending any request", async () => {
    const target = await endpoint(202)
    const exit = await withEndpoint(
      target.url,
      () => run(Effect.exit(text(["bug", "a failure"])), historyControl(calls))
    )
    expect(exit._tag).toBe("Failure")
    expect(String(exit._tag === "Failure" ? exit.cause : "")).toContain("--yes")
    expect(target.received).toEqual([])
  })

  it("dry-run previews a redacted payload and endpoint without posting, even with --yes", async () => {
    const target = await endpoint(202)
    const preview = await withEndpoint(target.url, () =>
      run(
        json(["--json", "bug", "Authorization: Bearer secret-token", "--dry-run", "--yes"]),
        historyControl(calls)
      ))
    expect(preview).toMatchObject({ endpoint: target.url, payload: { runs: [] }, reported: false })
    expect(JSON.stringify(preview)).not.toContain("secret-token")
    expect(target.received).toEqual([])
  })

  it("includes only the named run and prints the exact payload it sends", async () => {
    const target = await endpoint(202)
    const result = await withEndpoint(target.url, () =>
      run(
        Effect.gen(function*() {
          yield* text(["bug", "a failure", "--run", "run-1", "--yes"])
          return { runId: "run-1", errors: yield* TestConsole.errorLines }
        }),
        historyControl(calls)
      ))
    expect(target.received).toHaveLength(1)
    expect(target.received[0]).toMatchObject({ runs: [{ runId: result.runId }] })
    expect((target.received[0] as { runs: unknown[] }).runs).toHaveLength(1)
    expect(result.errors.map(String)).toContain(target.url)
    expect(result.errors.map(String)).toContain(JSON.stringify(target.received[0]))
  })

  it.each([true, false])("posts only when the TTY confirmation is accepted (%s)", async (accepted) => {
    const target = await endpoint(202)
    const input = new PassThrough()
    const output = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      }
    })
    const ui = Ui.make({ input, output, interactive: true })
    const keys = setTimeout(() => input.write(accepted ? "y\r" : "n\r"), 100)
    try {
      const exit = await withEndpoint(target.url, () =>
        run(
          Effect.exit(text(["bug", "a failure"]).pipe(Effect.provideService(Ui.Ui, ui))),
          testControl
        ))
      expect(exit._tag).toBe(accepted ? "Success" : "Failure")
      expect(target.received).toHaveLength(accepted ? 1 : 0)
    } finally {
      clearTimeout(keys)
      input.destroy()
      output.destroy()
    }
  })

  it("refuses an empty summary before reaching the network", async () => {
    const exit = await withEndpoint(
      "http://127.0.0.1:1/",
      () => run(Effect.exit(text(["bug", "   "])), testControl)
    )

    expect(exit._tag).toBe("Failure")
    const failure = exit._tag === "Failure" ? exit.cause : undefined
    expect(String(failure)).toContain("needs a one-line summary")
    // A usage error, so the process exits 2 rather than 1: the operator
    // mistyped the command, the endpoint never answered badly.
    expect(CliError.exitCode(new CliError.UsageError({ message: "x" }))).toBe(2)
  })
})
