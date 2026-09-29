import * as Audience from "@smthrs/build-cli/Audience"
import { Control, ControlSchema } from "@smthrs/control"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Effect, Stream } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCli } from "../src/Cli.ts"
import type * as Bridge from "../src/cli/ControlBridge.ts"
import { createRunsCli } from "../src/cli/ControlCommands.ts"
import * as Presentation from "../src/cli/Presentation.ts"

const ports = vi.hoisted(() => ({
  invoke: vi.fn(),
  query: vi.fn(),
  local: vi.fn(),
  events: vi.fn(),
  hasRecords: vi.fn(),
  list: vi.fn(),
  cancel: vi.fn(),
  watch: vi.fn(),
  reconcile: vi.fn(),
  prepare: vi.fn(),
  localRoot: vi.fn(),
  progress: vi.fn(),
  event: vi.fn(),
  close: vi.fn()
}))
vi.mock("../src/cli/ControlBridge.ts", async (load) => ({
  ...await load<typeof import("../src/cli/ControlBridge.ts")>(),
  invoke: ports.invoke,
  query: ports.query,
  local: ports.local,
  events: ports.events,
  hasRecords: ports.hasRecords
}))
vi.mock("../src/history/History.ts", async (load) => ({
  ...await load<typeof import("../src/history/History.ts")>(),
  reconcile: ports.reconcile,
  prepare: ports.prepare
}))
vi.mock("../src/cli/RunProgress.ts", async (load) => ({
  ...await load<typeof import("../src/cli/RunProgress.ts")>(),
  make: ports.progress
}))

vi.mock("../src/Project.ts", async (load) => ({
  ...await load<typeof import("../src/Project.ts")>(),
  localRoot: ports.localRoot
}))

const directories: Array<string> = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
beforeEach(() => {
  for (const port of Object.values(ports)) port.mockReset()
  ports.invoke.mockImplementation(async (args: Array<string>) => ({ receipt: args.join(" ") }))
  ports.query.mockImplementation((effect: Effect.Effect<unknown, unknown, Control.Control>) =>
    Effect.runPromise(
      Effect.gen(function*() {
        const base = yield* Control.Control
        return yield* effect.pipe(Effect.provideService(Control.Control, {
          ...base,
          list: ports.list,
          cancel: ports.cancel,
          watch: ports.watch
        }))
      }).pipe(Effect.provide(Control.layerNoop))
    )
  )
  ports.list.mockReturnValue(Effect.succeed({ _tag: "runs", items: [] }))
  ports.cancel.mockImplementation(({ runId }) =>
    Effect.succeed({ _tag: "Accepted", receiptId: `cli:cancel:${runId}`, runId })
  )
  ports.watch.mockReturnValue(Stream.empty)
  ports.events.mockImplementation(async function*() {})
  ports.hasRecords.mockReturnValue(true)
  ports.localRoot.mockImplementation((options) => options.root ?? process.cwd())
  ports.prepare.mockReturnValue({ executionRoot: "/isolated-child" })
  ports.progress.mockReturnValue({ event: ports.event, close: ports.close })
})

const invoke = async (args: Array<string>, overrides: Bridge.Runtime = {}) => {
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  const runtime: Bridge.Runtime = {
    environment: {},
    stdout: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stdout += text
      }
    },
    stderr: {
      isTTY: false,
      columns: 80,
      write: (text) => {
        result.stderr += text
      }
    },
    ...overrides
  }
  const presentation = Audience.fromArguments(args, {
    env: runtime.environment,
    stdout: runtime.stdout?.isTTY,
    stderr: runtime.stderr?.isTTY
  })
  const config = { ...runtime, presentation }
  await makeCli(config).serve(Audience.incurArguments(args, presentation), {
    env: runtime.environment,
    stdout: (text) => {
      result.stdout += text
    },
    exit: (code) => {
      result.codes.push(code)
    }
  })
  return { ...result, config }
}

const row = (runId: string, status: ControlSchema.RunSummary["status"] = "parked"): ControlSchema.RunSummary => ({
  runId,
  flowId: "demo/ship",
  status,
  createdAt: 1,
  updatedAt: 2
})
const event = (
  sequence: number,
  kind = "control.agent.turn-opened",
  payload: unknown = {}
): ControlSchema.ControlEvent => ({
  sequence,
  kind,
  runId: "run-1",
  occurredAt: sequence,
  payload: payload as ControlSchema.ControlEvent["payload"]
})
const approval = { idempotencyKey: "approval:one", target: { _tag: "Run", runId: "run-1", sequence: 3 } }
const approvalEvents = [
  event(2, "control.approval.requested", { question: "Ship this change?", payload: approval }),
  event(3, "control.run.waiting-approval", { runId: "run-1", status: "waiting-approval" })
]

describe("unified control dispatch", () => {
  it.each([
    ["mcp", "--help"],
    ["--help", "mcp"],
    ["--ui", "plain", "mcp", "--help"]
  ])("uses the Smithers MCP registration help with prefixes: %j", async (...args) => {
    const result = await invoke(args)
    expect(result.codes).toEqual([])
    expect(result.stdout).toContain("Register with Claude Code or Codex")
    expect(ports.invoke).not.toHaveBeenCalled()
  })

  it.each([
    [["flow", "list"], ["ls"]],
    [["flow", "plan", "demo/ship"], ["plan", "demo/ship"]],
    [["flow", "plan", "demo/ship", "branch=next", "count=2", "--data", "{\"extra\":true}"], [
      "plan",
      "demo/ship",
      "branch=next",
      "count=2",
      "--data",
      "{\"extra\":true}"
    ]],
    [["flow", "start", "demo/ship"], ["up", "demo/ship"]],
    [["flow", "start", "demo/ship", "-d", "--data", "{}"], ["up", "demo/ship", "--data", "{}", "--detached"]],
    [["flow", "start", "demo/ship", "--budget-tokens", "50", "--budget-ms", "1000", "--on-exceeded", "park"], [
      "up",
      "demo/ship",
      "--budget-tokens",
      "50",
      "--budget-ms",
      "1000",
      "--on-exceeded",
      "park"
    ]],
    [["flow", "execute", JSON.stringify(approval)], ["run", JSON.stringify(approval)]],
    [["runs", "output", "run-1"], ["output", "run-1"]],
    [["runs", "output", "run-1", "publish"], ["output", "run-1", "publish"]],
    [["runs", "cancel", "run-1"], ["cancel", "run-1"]],
    [["runs", "signal", "run-1", "{\"wake\":true}"], ["signal", "run-1", "{\"wake\":true}"]],
    [["runs", "steer", "run-1", "--message", "Keep the exact words"], [
      "steer",
      "run-1",
      "--message",
      "Keep the exact words"
    ]],
    [["approvals", "approve", JSON.stringify(approval)], ["approve", JSON.stringify(approval), "--scope", "run"]],
    [["approvals", "approve", JSON.stringify(approval), "--scope", "remembered"], [
      "approve",
      JSON.stringify(approval),
      "--scope",
      "remembered"
    ]],
    [["approvals", "deny", JSON.stringify(approval)], ["deny", JSON.stringify(approval)]]
  ])("translates %j without changing its payload", async (args, expected) => {
    const result = await invoke([
      ...args,
      "--root",
      "/fixture",
      "--remote",
      "https://control.invalid",
      "--json"
    ])
    expect(ports.invoke).toHaveBeenCalledExactlyOnceWith(
      expected,
      expect.objectContaining({
        root: "/fixture",
        remote: "https://control.invalid",
        quiet: false
      }),
      result.config
    )
    expect(result.codes).toEqual([])
    expect(result.stdout + result.stderr).not.toContain("private-fixture")
  })

  it.each(["execute", "approve", "deny"])("reads the complete @file for %s", async (command) => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-approval-dispatch-"))
    directories.push(root)
    const file = join(root, "decision.json")
    const contents = JSON.stringify(approval, null, 2) + "\n"
    await writeFile(file, contents)
    await invoke([
      command === "execute" ? "flow" : "approvals",
      command,
      `@${file}`,
      ...(command === "approve" ? ["--scope", "run"] : []),
      "--json"
    ])
    expect(ports.invoke.mock.calls[0]![0]).toEqual(
      command === "approve"
        ? ["approve", contents, "--scope", "run"]
        : [command === "execute" ? "run" : "deny", contents]
    )
  })

  it("does not dispatch a payload file that cannot be read", async () => {
    const result = await invoke(["flow", "execute", "@/missing-smthrs-review/approval.json", "--json"])
    expect(result.codes).toEqual([1])
    expect(result.stdout).toContain("ENOENT")
    expect(ports.invoke).not.toHaveBeenCalled()
  })

  const remote = ["--remote", "https://control.invalid"]

  it("finds a remote flow after an empty page and preserves the catalog cursor exactly", async () => {
    const flow = { flowId: "demo/ship", description: "Publish a release" }
    ports.list.mockReturnValueOnce(Effect.succeed({ _tag: "flows", items: [], nextCursor: "opaque/page:2" }))
      .mockReturnValueOnce(
        Effect.succeed({ _tag: "flows", items: [{ flowId: "other", description: "Other" }, flow] })
      )
    const result = await invoke(["flow", "show", "demo/ship", ...remote, "--json"])
    expect(JSON.parse(result.stdout)).toEqual(flow)
    expect(ports.list.mock.calls).toEqual([
      [{ _tag: "flows", limit: ControlSchema.maxPageSize }],
      [{ _tag: "flows", limit: ControlSchema.maxPageSize, cursor: "opaque/page:2" }]
    ])
    expect(ports.local).not.toHaveBeenCalled()
  })

  it.each([
    [{ _tag: "flows", items: [] }, "Unknown flow missing"],
    [{ _tag: "runs", items: [] }, "the control plane returned a run page for a flow listing"]
  ])("reports missing or malformed catalogs instead of inventing a flow", async (page, message) => {
    ports.list.mockReturnValue(Effect.succeed(page))
    const result = await invoke(["flow", "show", "missing", ...remote, "--json"])
    expect(result.codes).toEqual([1])
    expect(result.stdout).toContain(message)
  })

  it("reads a local flow catalog from the discovery snapshot, never the control host", async () => {
    const flow = { flowId: "demo/ship", description: "Publish a release" }
    ports.local.mockResolvedValue({ items: [{ flowId: "other", description: "Other" }, flow], warnings: [] })
    const shown = await invoke(["flow", "show", "demo/ship", "--json"])
    expect(JSON.parse(shown.stdout)).toEqual(flow)
    ports.local.mockResolvedValue({ _tag: "flows", items: [flow] })
    const listed = await invoke(["flow", "list", "--json"])
    expect(JSON.parse(listed.stdout)).toMatchObject({ _tag: "flows", items: [flow] })
    expect(ports.local).toHaveBeenCalledTimes(2)
    expect(ports.invoke).not.toHaveBeenCalled()
    expect(ports.query).not.toHaveBeenCalled()
  })

  it("answers observing verbs empty without opening a store the project does not have", async () => {
    const root = await mkdtemp(join(tmpdir(), "smthrs-observe-empty-"))
    directories.push(root)
    ports.hasRecords.mockReturnValue(false)
    const at = ["--root", root, "--json"]
    expect(JSON.parse((await invoke(["runs", "list", ...at])).stdout)).toMatchObject({ _tag: "runs", items: [] })
    expect(JSON.parse((await invoke(["approvals", "list", ...at])).stdout)).toEqual([])
    const shown = await invoke(["runs", "show", "absent", ...at])
    expect(shown.codes).toEqual([1])
    expect(shown.stdout).toContain("Unknown run absent")
    expect(JSON.parse((await invoke(["runs", "logs", "absent", ...at])).stdout)).toEqual([])
    for (const port of [ports.invoke, ports.query, ports.events, ports.reconcile]) {
      expect(port).not.toHaveBeenCalled()
    }
  })

  it.each([false, true])("reconciles local history before listing with filters=%s", async (filtered) => {
    const order: Array<string> = []
    ports.reconcile.mockImplementation(() => {
      order.push("reconcile")
    })
    ports.invoke.mockImplementation(async () => {
      order.push("query")
      return []
    })
    await invoke([
      "runs",
      "list",
      "--root",
      "/fixture",
      ...(filtered
        ? ["--flow", "demo/ship", "--status", "waiting-approval", "--limit", "2", "--cursor", "page-2"]
        : []),
      "--json"
    ])
    expect(order).toEqual(["reconcile", "query"])
    expect(ports.reconcile).toHaveBeenCalledExactlyOnceWith("/fixture")
    expect(ports.invoke.mock.calls[0]![0]).toEqual([
      "ps",
      ...(filtered
        ? ["--flow", "demo/ship", "--status", "waiting-approval", "--limit", "2", "--cursor", "page-2"]
        : [])
    ])
  })

  it("diagnoses the requested run using its entire finite transcript", async () => {
    const run = row("run-1", "waiting-approval")
    ports.list.mockReturnValue(Effect.succeed({ _tag: "runs", items: [row("other"), run] }))
    ports.watch.mockReturnValue(Stream.fromIterable(approvalEvents))
    const result = await invoke(["runs", "show", "run-1", "--root", "/fixture", "--json"])
    expect(ports.list).toHaveBeenCalledExactlyOnceWith({ _tag: "runs", filters: { runId: "run-1" } })
    expect(ports.watch).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", follow: false })
    const output = JSON.parse(result.stdout)
    expect(output).toEqual({
      ...run,
      diagnosis: {
        status: "waiting-approval",
        turns: 0,
        calls: 0,
        callsFailed: 0,
        duplicateCalls: 0,
        editsAttempted: 0,
        editsSucceeded: 0,
        flows: [],
        refusals: [],
        inputTokens: 0,
        outputTokens: 0,
        parkedQuestion: "Ship this change?",
        parkedApproval: JSON.stringify(approval),
        startedAt: 2,
        endedAt: 3
      },
      cta: {
        description: "Suggested commands:",
        commands: [
          {
            command: "smthrs runs logs run-1 --format jsonl --root /fixture",
            description: "Read detailed events only when needed"
          },
          { command: "smthrs approvals list --root /fixture", description: "Inspect pending approval payloads" }
        ]
      }
    })
  })

  it.each([{ _tag: "runs", items: [row("other")] }, { _tag: "flows", items: [] }])(
    "does not watch a missing run",
    async (page) => {
      ports.list.mockReturnValue(Effect.succeed(page))
      const result = await invoke(["runs", "show", "run-1", "--json"])
      expect(result.codes).toEqual([1])
      expect(result.stdout).toContain("Unknown run run-1")
      expect(ports.watch).not.toHaveBeenCalled()
    }
  )

  it.each(["show", "approvals"])("fails %s when its transcript exceeds the event byte budget", async (command) => {
    ports.list.mockReturnValue(Effect.succeed({ _tag: "runs", items: [row("run-1", "waiting-approval")] }))
    ports.watch.mockReturnValue(
      Stream.fromIterable([...approvalEvents, event(4, "example", { text: "x".repeat(1024 * 1024) })])
    )
    const result = await invoke(
      command === "show" ? ["runs", "show", "run-1", "--json"] : ["approvals", "list", "--json"]
    )
    expect(result.codes).toEqual([1])
    expect(result.stdout).toContain("ResourceLimitError")
    expect(result.stdout).not.toContain("Ship this change?")
  })

  it("cancels every nonterminal run across pages and returns each distinct receipt", async () => {
    ports.list.mockReturnValueOnce(
      Effect.succeed({
        _tag: "runs",
        items: [row("completed", "completed"), row("accepted", "accepted"), row("failed", "failed")],
        nextCursor: "more"
      })
    )
      .mockReturnValueOnce(
        Effect.succeed({
          _tag: "runs",
          items: [
            row("cancelled", "cancelled"),
            row("running", "running"),
            row("parked"),
            row("approval", "waiting-approval")
          ]
        })
      )
    const result = await invoke(["runs", "cancel-all", "--root", "/fixture", "--json"])
    expect(ports.list.mock.calls).toEqual([[{ _tag: "runs" }], [{ _tag: "runs", cursor: "more" }]])
    expect(ports.cancel.mock.calls.map((call) => call[0])).toEqual(
      ["accepted", "running", "parked", "approval"].map((runId) => ({ runId, idempotencyKey: `cli:cancel:${runId}` }))
    )
    expect(JSON.parse(result.stdout)).toEqual({
      cancelled: ["accepted", "running", "parked", "approval"].map((runId) => ({
        runId,
        receipt: { _tag: "Accepted", receiptId: `cli:cancel:${runId}`, runId }
      }))
    })
  })

  it("acquires the runtime once for listing and all cancellations", async () => {
    ports.list.mockReturnValue(Effect.succeed({ _tag: "runs", items: [row("first"), row("second")] }))
    const result = await invoke(["runs", "cancel-all", "--root", "/fixture", "--json"])
    expect(result.codes).toEqual([])
    expect(ports.query).toHaveBeenCalledTimes(1)
    expect(ports.invoke).not.toHaveBeenCalled()
    expect(ports.cancel).toHaveBeenCalledTimes(2)
    expect(ports.reconcile).toHaveBeenCalledExactlyOnceWith("/fixture")
    expect(ports.prepare).not.toHaveBeenCalled()
  })

  it("refuses a malformed cancellation page before issuing any cancellation", async () => {
    ports.list.mockReturnValueOnce(Effect.succeed({ _tag: "runs", items: [row("run-1")], nextCursor: "wrong" }))
      .mockReturnValueOnce(Effect.succeed({ _tag: "flows", items: [] }))
    const result = await invoke(["runs", "cancel-all", "--json"])
    expect(result.codes).toEqual([1])
    expect(result.stdout).toContain("Expected durable runs")
    expect(ports.invoke).not.toHaveBeenCalled()
    expect(ports.cancel).not.toHaveBeenCalled()
  })

  it("does not continue cancelling after a failed mutation", async () => {
    ports.list.mockReturnValue(Effect.succeed({ _tag: "runs", items: [row("first"), row("second"), row("third")] }))
    ports.cancel.mockReturnValueOnce(Effect.succeed({ _tag: "Accepted", receiptId: "first", runId: "first" }))
      .mockReturnValueOnce(Effect.fail(new Error("cancellation unavailable")))
    const result = await invoke(["runs", "cancel-all", "--json"])
    expect(result.codes).toEqual([1])
    expect(ports.cancel.mock.calls.map((call) => call[0])).toEqual([
      { runId: "first", idempotencyKey: "cli:cancel:first" },
      { runId: "second", idempotencyKey: "cli:cancel:second" }
    ])
    expect(result.stdout).toContain("cancellation unavailable")
  })

  it("resumes locally inside the reconciled child execution root", async () => {
    const result = await invoke(["runs", "resume", "child", "--root", "/fixture", "--json"], {
      executionRoot: "/stale-child"
    })
    expect(ports.prepare).toHaveBeenCalledExactlyOnceWith("/fixture", "child")
    expect(ports.invoke).toHaveBeenCalledExactlyOnceWith(["resume", "child"], { root: "/fixture", quiet: false }, {
      ...result.config,
      executionRoot: "/isolated-child"
    })
  })

  it("forwards --allow-code-drift to the resume handler and not to the connection", async () => {
    const result = await invoke(["runs", "resume", "child", "--allow-code-drift", "--root", "/fixture", "--json"])
    expect(ports.invoke).toHaveBeenCalledExactlyOnceWith(
      ["resume", "child", "--allow-code-drift"],
      { root: "/fixture", quiet: false },
      { ...result.config, executionRoot: "/isolated-child" }
    )
  })

  it.each(["flag", "environment"])("leaves remote resume and list to the remote host (%s)", async (source) => {
    const args = source === "flag" ? ["--remote", "https://control.invalid"] : []
    const environment = source === "environment" ? { SMITHERS_REMOTE: "https://control.invalid" } : {}
    const result = await invoke(["runs", "resume", "run-1", ...args, "--json"], { environment })
    expect(ports.invoke.mock.calls[0]![2]).toEqual(result.config)
    await invoke(["runs", "list", ...args, "--json"], { environment })
    expect(ports.prepare).not.toHaveBeenCalled()
    expect(ports.reconcile).not.toHaveBeenCalled()
  })

  it.each([undefined, "run-1"])("lists exact approval payloads across every page with run filter %s", async (run) => {
    ports.list.mockReturnValueOnce(Effect.succeed({ _tag: "runs", items: [], nextCursor: "approval-page:2" }))
      .mockReturnValueOnce(Effect.succeed({ _tag: "runs", items: [row("run-1", "waiting-approval")] }))
    ports.watch.mockReturnValue(Stream.fromIterable(approvalEvents))
    const result = await invoke(["approvals", "list", ...(run === undefined ? [] : ["--run", run]), "--json"])
    const filters = { status: "waiting-approval", ...(run === undefined ? {} : { runId: run }) }
    expect(ports.list.mock.calls).toEqual([[{ _tag: "runs", filters }], [{
      _tag: "runs",
      filters,
      cursor: "approval-page:2"
    }]])
    expect(ports.watch).toHaveBeenCalledExactlyOnceWith({ runId: "run-1", follow: false })
    expect(JSON.parse(result.stdout)).toEqual([{
      runId: "run-1",
      flowId: "demo/ship",
      question: "Ship this change?",
      approval: JSON.stringify(approval)
    }])
  })

  it("refuses a malformed pending-approval page", async () => {
    ports.list.mockReturnValue(Effect.succeed({ _tag: "flows", items: [] }))
    const result = await invoke(["approvals", "list", "--json"])
    expect(result.codes).toEqual([1])
    expect(result.stdout).toContain("Expected durable runs")
  })

  it.each([
    [
      new NodeDatabase.UnsupportedDatabase({ code: "unsupported_database_file", message: "Old database file" }),
      "unsupported_database_file",
      1
    ],
    [{ _tag: "/cli/UsageError", message: "Authorization: Bearer private-fixture" }, "UsageError", 2],
    [{ _tag: "/control/Unavailable", message: "temporarily unavailable" }, "Unavailable", 1],
    ["Authorization: Bearer private-fixture", "command_failed", 1],
    [null, "command_failed", 1]
  ])("keeps stable typed refusal codes and redacts credentials", async (cause, code, exitCode) => {
    ports.local.mockRejectedValue(cause)
    const result = await invoke(["flow", "list", "--json"])
    expect(result.codes).toEqual([exitCode])
    expect(result.stdout).toContain(`"code": "${code}"`)
    expect(result.stdout).not.toContain("private-fixture")
  })

  it("lists flows one per line for a person, starring the featured rows", async () => {
    ports.local.mockResolvedValue({
      _tag: "flows",
      items: [
        { flowId: "review", description: "Reviews the change.", featured: true, summary: "Review the change." },
        { flowId: "create-flow/scaffold", description: "Writes the flow file." }
      ]
    })
    let terminal = ""
    const result = await invoke(["flow", "list", "--audience", "human", "--silent"], {
      stdout: {
        isTTY: true,
        columns: 80,
        write: (text) => {
          terminal += text
        }
      }
    })
    expect(result.codes).toEqual([])
    expect(result.stdout).toBe("")
    expect(terminal).toBe(
      "flow list\n" +
        `* ${"review".padEnd("create-flow/scaffold".length)}  Review the change.\n` +
        "  create-flow/scaffold  Writes the flow file.\n" +
        "Next:\nsmthrs flow show review\nsmthrs flow plan --help\n"
    )
    expect(terminal).not.toContain("flowId")
  })

  it("keeps the flow page document for agents and --json", async () => {
    const page = { _tag: "flows", items: [{ flowId: "review", description: "Reviews the change.", featured: true }] }
    ports.local.mockResolvedValue(page)
    const result = await invoke(["flow", "list", "--json"])
    expect(result.codes).toEqual([])
    expect(JSON.parse(result.stdout)).toMatchObject(page)
  })

  it("keeps the guard usable directly without a presentation session", async () => {
    const error = vi.fn<(cause: { code: string; message: string; exitCode?: number }) => never>()
    expect(await Presentation.guard({ error }, async () => ({ answer: 42 }))).toEqual({ answer: 42 })
    expect(error).not.toHaveBeenCalled()
  })
})

describe("runs wait status exits", () => {
  it.each([["local", []], ["remote", ["--remote", "https://control.invalid"]]] as const)(
    "exits 3 on timeout and 0 after success (%s)",
    async (_name, connection) => {
      ports.list.mockReturnValueOnce(Effect.succeed({ _tag: "runs", items: [row("run-1", "running")] }))
        .mockReturnValueOnce(Effect.succeed({ _tag: "runs", items: [row("run-1", "completed")] }))
      const timed = await invoke(["runs", "wait", "run-1", "--timeout", "0", ...connection, "--json"])
      expect(timed.codes).toEqual([3])
      const done = await invoke(["runs", "wait", "run-1", ...connection, "--json"])
      expect(done.codes).toEqual([])
      expect(JSON.parse(done.stdout)).toMatchObject({ runId: "run-1", status: "completed" })
    }
  )

  it.each(["parked", "waiting-approval", "failed", "cancelled"] as const)("exits for %s", async (status) => {
    ports.list.mockReturnValue(Effect.succeed({ _tag: "runs", items: [row("run-1", status)] }))
    const result = await invoke(["runs", "wait", "run-1", "--json"])
    expect(result.codes).toEqual([status === "failed" ? 1 : status === "cancelled" ? 130 : 3])
  })

  it("waits for a remotely launched flow", async () => {
    ports.invoke.mockResolvedValue({ _tag: "Accepted", runId: "run-1" })
    ports.list.mockReturnValue(Effect.succeed({ _tag: "runs", items: [row("run-1", "completed")] }))
    const result = await invoke([
      "flow",
      "start",
      "demo/ship",
      "--wait",
      "--remote",
      "https://control.invalid",
      "--json"
    ])
    expect(result.codes).toEqual([])
    expect(ports.invoke.mock.calls[0]![0]).toEqual(["up", "demo/ship", "--wait"])
  })
})

describe("unified durable log streams", () => {
  const chunk = (data: ControlSchema.ControlEvent) => ({ type: "chunk", data })
  const done = (after?: number, root = "") => ({
    type: "done",
    ok: true,
    meta: {
      command: "runs logs",
      duration: expect.stringMatching(/^\d+ms$/),
      ...(after === undefined ? {} : {
        cta: {
          description: "Suggested command:",
          commands: [{
            command: `smthrs runs logs run-1 --after ${after} --format jsonl${root}`,
            description: "Continue from the last returned event"
          }]
        }
      })
    }
  })

  it("returns exact ordered events, resumes after the supplied cursor, and closes on its explicit bound", async () => {
    const returned = vi.fn()
    const values = [event(41), event(44), event(49)]
    ports.events.mockImplementation(async function*() {
      try {
        yield* values
      } finally {
        returned()
      }
    })
    const result = await invoke([
      "runs",
      "logs",
      "run-1",
      "--after",
      "40",
      "--limit",
      "2",
      "--root",
      "/fixture",
      "--format",
      "jsonl"
    ])
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toEqual([...values.slice(0, 2).map(chunk), done(44, " --root /fixture")])
    expect(ports.events).toHaveBeenCalledExactlyOnceWith(
      "run-1",
      false,
      { after: 40, limit: 2, root: "/fixture", quiet: false, follow: false },
      result.config,
      40
    )
    expect(returned).toHaveBeenCalledOnce()
    expect(ports.progress).not.toHaveBeenCalled()
  })

  it("bounds an agent's default pull to 100 events without consuming event 101", async () => {
    const consumed: Array<number> = []
    ports.events.mockImplementation(async function*() {
      for (let sequence = 1; sequence <= 101; sequence++) {
        consumed.push(sequence)
        yield event(sequence)
      }
    })
    const result = await invoke(["runs", "logs", "run-1", "--audience", "agent", "--format", "jsonl"])
    const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
    expect(lines).toEqual([...Array.from({ length: 100 }, (_, index) => chunk(event(index + 1))), done(100)])
    expect(consumed).toEqual(Array.from({ length: 100 }, (_, index) => index + 1))
  })

  it("follows beyond the default pull limit and emits no continuation when the source ends", async () => {
    const values = Array.from({ length: 101 }, (_, index) => event(index + 1))
    ports.events.mockImplementation(async function*() {
      yield* values
    })
    const result = await invoke(["runs", "logs", "run-1", "--follow", "--format", "jsonl"])
    expect(result.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([...values.map(chunk), done()])
    expect(ports.events.mock.calls[0]![1]).toBe(true)
  })

  it("does not invent a continuation for an empty finite transcript", async () => {
    const result = await invoke(["runs", "logs", "run-1", "--after", "40", "--limit", "1", "--format", "jsonl"])
    expect(result.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([done()])
    expect(result.codes).toEqual([])
  })

  it.each([new Error("Authorization: Bearer private-fixture"), "Authorization: Bearer private-fixture"])(
    "preserves emitted events and redacts a subsequent stream failure",
    async (cause) => {
      ports.events.mockImplementation(async function*() {
        yield event(1)
        throw cause
      })
      const result = await invoke(["runs", "logs", "run-1", "--format", "jsonl"])
      const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line))
      expect(lines).toEqual([chunk(event(1)), {
        type: "error",
        ok: false,
        error: { code: "logs_failed", message: "Authorization: Bearer [REDACTED_TOKEN]" }
      }])
      expect(result.stdout).toContain("[REDACTED_TOKEN]")
      expect(result.stdout).not.toContain("private-fixture")
      expect(result.codes).toEqual([1])
    }
  )

  it.each([false, true])("renders human events and closes the renderer after failure=%s", async (fail) => {
    ports.events.mockImplementation(async function*() {
      yield event(1)
      if (fail) throw new Error("stream unavailable")
    })
    const result = await invoke(["runs", "logs", "run-1", "--audience", "human", "--silent"], {
      stdout: { isTTY: true, columns: 80, write: () => {} }
    })
    expect(ports.progress.mock.calls[0]![1].policy).toMatchObject({
      audience: "human",
      progress: "plain",
      structured: false
    })
    expect(ports.event).toHaveBeenCalledExactlyOnceWith(event(1))
    expect(ports.close.mock.calls).toEqual(fail ? [["failed"], ["ended"]] : [["ended"]])
    expect(result.codes).toEqual(fail ? [1] : [])
  })

  it("supports an independently mounted runs group without a presentation session", async () => {
    ports.events.mockImplementation(async function*() {
      yield event(1)
    })
    let output = ""
    await createRunsCli({
      environment: { SMITHERS_AUDIENCE: "human" },
      stdout: { isTTY: true, columns: 80, write: () => {} }
    }).serve(["logs", "run-1"], {
      stdout: (text) => {
        output += text
      },
      env: {},
      exit: () => {}
    })
    expect(ports.progress.mock.calls[0]![1].output).toBe(process.stdout)
    expect(ports.event).toHaveBeenCalledExactlyOnceWith(event(1))
    expect(ports.close).toHaveBeenCalledExactlyOnceWith("ended")
    expect(output).toBe("")
  })

  it.each(["0", "10001", "1.5"])("rejects invalid event limit %s before opening a stream", async (limit) => {
    const result = await invoke(["runs", "logs", "run-1", "--limit", limit, "--json"])
    expect(result.codes.some((code) => code !== 0)).toBe(true)
    expect(ports.events).not.toHaveBeenCalled()
  })
})
