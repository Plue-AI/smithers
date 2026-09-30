import * as Audience from "@smthrs/build-cli/Audience"
import { ApprovalAuthority, Control } from "@smthrs/control"
import { Unavailable } from "@smthrs/control/ControlError"
import { Console, Effect, Layer, Logger, References, Stream } from "effect"
import { getEventListeners } from "node:events"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative, resolve } from "node:path"
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { makeCli } from "../src/Cli.ts"
import * as Bridge from "../src/cli/ControlBridge.ts"
import { createRunsCli } from "../src/cli/ControlCommands.ts"
import * as Presentation from "../src/cli/Presentation.ts"
import * as RunProgress from "../src/cli/RunProgress.ts"
import * as CommandStatus from "../src/internal/CommandStatus.ts"
import * as Ui from "../src/Ui.ts"

const ports = vi.hoisted(() => ({
  runWith: vi.fn(),
  control: vi.fn(),
  observe: vi.fn(),
  prepare: vi.fn(),
  project: vi.fn(),
  registry: vi.fn(),
  readOnly: vi.fn(),
  scheduler: vi.fn(),
  serve: vi.fn()
}))

// Host transports are bounded doubles, so these tests never open a database,
// worktree, or listener. The bug consent cases drive the unified `bug` verb
// through its typed command; routing-only cases use a bounded handler.
vi.mock("../src/Command.ts", () => ({ cli: "legacy" }))
vi.mock("effect/unstable/cli", async (load) => {
  const actual = await load<typeof import("effect/unstable/cli")>()
  return { ...actual, Command: { ...actual.Command, runWith: ports.runWith } }
})
vi.mock("../src/NodeControl.ts", async (load) => {
  const actual = await load<typeof import("../src/NodeControl.ts")>()
  const { Effect, Layer } = await import("effect")
  return {
    ...actual,
    layer: ports.control,
    layerObserve: ports.observe,
    layerRegistry: ports.registry,
    layerOutput: Layer.effectDiscard(Effect.sync(() => ports.readOnly("output")))
  }
})
vi.mock("../src/history/History.ts", () => ({ prepare: ports.prepare }))
vi.mock("../src/Project.ts", async (load) => ({
  ...await load<typeof import("../src/Project.ts")>(),
  layer: ports.project
}))
vi.mock("../src/operator/Triggers.ts", async (load) => ({
  ...await load<typeof import("../src/operator/Triggers.ts")>(),
  layerTriggerScheduler: ports.scheduler
}))
vi.mock("../src/Serve.ts", async (load) => ({
  ...await load<typeof import("../src/Serve.ts")>(),
  host: ports.serve
}))

const directory = mkdtempSync(join(tmpdir(), "smithers-control-bridge-"))
const relativeRoot = relative(process.cwd(), join(directory, "relative"))
mkdirSync(join(directory, "relative"))
afterAll(() => rmSync(directory, { recursive: true, force: true }))
const local = { root: directory, quiet: false }
const plain = Audience.resolve({ env: {}, audience: "human", stdout: false, stderr: false })
const silent = { ...plain, progress: "silent" as const, interactive: false }
const runtime = { environment: {}, presentation: plain }
const bind = { host: "127.0.0.1", port: 0, listen: false, credential: undefined }
let handler: Effect.Effect<unknown, unknown, Control.Control | Ui.Ui> = Effect.void
let service: Control.Service
let lifecycle: Array<string>
let receivedArguments: ReadonlyArray<string>

beforeEach(async () => {
  for (const port of Object.values(ports)) port.mockReset()
  lifecycle = []
  receivedArguments = []
  handler = Effect.void
  service = await Effect.runPromise(Control.Control.pipe(Effect.provide(Control.layerNoop)))
  ports.runWith.mockImplementation(() => (args: ReadonlyArray<string>) => {
    receivedArguments = args
    return handler
  })
  const control = () =>
    Layer.effect(
      Control.Control,
      Effect.acquireRelease(
        Effect.sync(() => {
          lifecycle.push("control:open")
          return service
        }),
        () =>
          Effect.sync(() => {
            lifecycle.push("control:close")
          })
      )
    )
  ports.control.mockImplementation(control)
  ports.observe.mockImplementation(control)
  ports.project.mockImplementation(() => Layer.effectDiscard(Effect.sync(() => ports.readOnly("project"))))
  ports.registry.mockImplementation(() => Layer.effectDiscard(Effect.sync(() => ports.readOnly("registry"))))
  ports.prepare.mockReturnValue({ executionRoot: "/bridge-snapshot", migrationRoot: "/bridge-legacy" })
  ports.scheduler.mockImplementation(() =>
    Layer.effectDiscard(Effect.gen(function*() {
      const control = yield* Control.Control
      expect(control).toBe(service)
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          lifecycle.push("scheduler:open")
        }),
        () =>
          Effect.sync(() => {
            lifecycle.push("scheduler:close")
          })
      )
    }))
  )
  ports.serve.mockImplementation(() =>
    Effect.gen(function*() {
      expect(yield* Control.Control).toBe(service)
      lifecycle.push("serve")
    })
  )
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("control bridge configuration and routing", () => {
  it("has records only over a remote plane or an existing local control store", () => {
    const root = mkdtempSync(join(tmpdir(), "smthrs-bridge-records-"))
    try {
      const options = { root, quiet: false }
      expect(Bridge.hasRecords(options, { environment: {} })).toBe(false)
      expect(Bridge.isRemote(options, { environment: {} })).toBe(false)
      const remote = { environment: { SMITHERS_REMOTE: "https://control.invalid" } }
      expect(Bridge.hasRecords(options, remote)).toBe(true)
      expect(Bridge.isRemote(options, remote)).toBe(true)
      mkdirSync(join(root, ".flows"))
      writeFileSync(join(root, ".flows", "control.db"), "")
      expect(Bridge.hasRecords(options, { environment: {} })).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("binds MCP transport identity independently of display preferences and forwards only host policy", async () => {
    const approvalAuthority = ApprovalAuthority.local
    const host = { ...runtime, approvalAuthority }
    for (
      const context of [
        { agent: true, formatExplicit: true, globals: {} },
        { request: {}, globals: { audience: "human" as const } }
      ]
    ) {
      await Presentation.scope(context, host, async () => {
        expect(Presentation.current()?.transport).toBe("mcp")
        await Bridge.invoke(["ls"], local, host)
        expect(ports.control).toHaveBeenLastCalledWith(expect.objectContaining({
          principal: { id: "mcp", kind: "agent" },
          approvalAuthority
        }))
      })
    }
    await Presentation.scope({ globals: { audience: "agent" } }, host, async () => {
      expect(Presentation.current()?.transport).toBe("cli")
      expect(Bridge.configuration(local, host).principal).toBeUndefined()
    })
    expect(Bridge.configuration(local, runtime).principal).toBeUndefined()
    expect(Bridge.connectionOptions.parse({ approvalAuthority: { authorize: "untrusted" } })).not.toHaveProperty(
      "approvalAuthority"
    )
  })

  it("refuses caller-selected connection overrides over MCP and keeps the host destination", async () => {
    const environment = { SMITHERS_REMOTE: "https://host.invalid", SMITHERS_TOKEN: "host-bearer" }
    const host = { ...runtime, environment }
    await Presentation.scope({ request: {}, command: "flow_list" }, host, async () => {
      for (const override of [{ remote: "https://attacker.invalid" }]) {
        expect(() => Bridge.configuration({ ...local, ...override }, host)).toThrow(/is not accepted over MCP/)
        await expect(Bridge.invoke(["ls"], { ...local, ...override }, host)).rejects.toThrow(/is not accepted over MCP/)
        await expect(Bridge.query(Effect.void, { ...local, ...override }, host)).rejects.toThrow(
          /is not accepted over MCP/
        )
      }
      expect(ports.control).not.toHaveBeenCalled()
      expect(receivedArguments).toEqual([])
      await Bridge.invoke(["ls"], local, host)
      expect(ports.control).toHaveBeenLastCalledWith(expect.objectContaining({
        remote: "https://host.invalid",
        credential: "host-bearer",
        principal: { id: "mcp", kind: "agent" }
      }))
    })
    expect(Bridge.configuration({ ...local, remote: "https://explicit.invalid" }, host))
      .toMatchObject({ remote: "https://explicit.invalid", principal: undefined })
  })

  it("keeps concurrent CLI and MCP identities separate", async () => {
    await Promise.all([
      Presentation.scope({ agent: true, formatExplicit: true, globals: {} }, runtime, async () => {
        await Promise.resolve()
        expect(Bridge.configuration(local, runtime).principal).toEqual({ id: "mcp", kind: "agent" })
      }),
      Presentation.scope({ globals: { audience: "human" } }, runtime, async () => {
        await Promise.resolve()
        expect(Bridge.configuration(local, runtime).principal).toBeUndefined()
      })
    ])
  })
  it("preserves explicitly supplied connection arguments and quiet defaults", () => {
    expect(Bridge.connectionOptions.parse({})).toEqual({ quiet: false })
    expect(Bridge.connectionArguments({ quiet: false })).toEqual([])
    expect(Bridge.connectionArguments({
      root: "some project",
      remote: "https://control.invalid",
      mcpConfig: "servers.json",
      quiet: true
    })).toEqual([
      "--root",
      "some project",
      "--remote",
      "https://control.invalid",
      "--mcp-config",
      "servers.json",
      "--quiet"
    ])
  })

  it("resolves relative roots, caller environment and explicit transport precedence", () => {
    const environment = { SMITHERS_REMOTE: "https://env.invalid", SMITHERS_TOKEN: "env-fixture" }
    expect(Bridge.configuration({ root: relativeRoot, quiet: false }, { environment })).toMatchObject({
      root: resolve(relativeRoot),
      remote: "https://env.invalid",
      credential: "env-fixture",
      executionRoot: undefined
    })
    expect(Bridge.configuration({ ...local, remote: "https://explicit.invalid" }, {
      environment,
      executionRoot: "/snapshot"
    })).toMatchObject({
      root: local.root,
      remote: "https://explicit.invalid",
      credential: "env-fixture",
      executionRoot: "/snapshot"
    })
    vi.stubEnv("SMITHERS_REMOTE", "https://ambient.invalid")
    expect(Bridge.configuration(local, {}).remote).toBe("https://ambient.invalid")
  })

  it.each(["resume", "cancel", "signal", "steer"])("prepares the recorded workspace for local %s", async (verb) => {
    await Bridge.invoke([verb, "run-7"], local, runtime)
    expect(ports.prepare).toHaveBeenCalledExactlyOnceWith(local.root, "run-7")
    expect(ports.control).toHaveBeenCalledWith(expect.objectContaining({
      root: local.root,
      executionRoot: "/bridge-snapshot",
      migrationRoot: "/bridge-legacy"
    }))
    expect(lifecycle).toEqual(["control:open", "control:close"])
  })

  it.each(["approve", "deny"])("prepares a node-target %s from its decoded run identity", async (verb) => {
    // The same complete payload `approvals approve` serializes; the bridge
    // shares the legacy executable's extraction, which decodes it in full.
    const payload = {
      target: {
        _tag: "Node",
        runId: "approved-run",
        requestId: "ask",
        digest: "reviewed",
        envelope: { capabilities: [], flows: [], budget: {} }
      },
      scope: "once",
      idempotencyKey: "decision"
    }
    await Bridge.invoke([verb, JSON.stringify(payload), "--scope", "once"], local, runtime)
    expect(ports.prepare).toHaveBeenCalledExactlyOnceWith(local.root, "approved-run")
  })

  it.each([
    undefined,
    "{",
    "null",
    "{}",
    "{\"target\":{\"_tag\":\"Plan\",\"runId\":\"wrong\"}}",
    "{\"target\":{\"_tag\":\"Node\",\"runId\":4}}"
  ])(
    "leaves malformed or non-run approvals to the handler: %s",
    async (payload) => {
      const failure = { _tag: "decoder-failure", payload }
      handler = Effect.fail(failure)
      await expect(Bridge.invoke(payload === undefined ? ["approve"] : ["approve", payload], local, runtime))
        .rejects.toBe(failure)
      expect(ports.prepare).not.toHaveBeenCalled()
      expect(lifecycle).toEqual(["control:open", "control:close"])
    }
  )

  it("uses remote and explicit execution roots without preparing a history workspace", async () => {
    await Bridge.invoke(["resume", "r"], { ...local, remote: "https://control.invalid" }, runtime)
    await Bridge.invoke(["resume", "r"], local, { ...runtime, executionRoot: "/provided-snapshot" })
    await Bridge.invoke([], local, runtime)
    expect(ports.prepare).not.toHaveBeenCalled()
    expect(ports.control.mock.calls[1]![0].executionRoot).toBe("/provided-snapshot")
  })

  it("composes a project verb without starting the durable control host", async () => {
    const failure = new Error("project verb failed")
    const seen = await Bridge.local(
      Effect.gen(function*() {
        expect((yield* RunProgress.Configuration)?.policy.progress).toBe("silent")
        expect(yield* References.MinimumLogLevel).toBe("Error")
        return (yield* Ui.Ui).interactive
      }),
      { ...local, quiet: true },
      runtime
    )
    expect(seen).toBe(false)
    expect(ports.project).toHaveBeenCalledExactlyOnceWith(local.root, local.root)
    expect(ports.registry).toHaveBeenCalledExactlyOnceWith(local.root)
    expect(ports.control).not.toHaveBeenCalled()
    expect(ports.readOnly.mock.calls.map(([name]) => name).sort()).toEqual(["project", "registry"])
    await expect(Bridge.local(Effect.fail(failure), local, runtime)).rejects.toBe(failure)
  })

  it("hands a typed query the host's control service and prompt surface", async () => {
    const interactive = await Bridge.query(
      Effect.gen(function*() {
        expect(yield* Control.Control).toBe(service)
        return (yield* Ui.Ui).interactive
      }),
      local,
      { ...runtime, presentation: { ...plain, interactive: true } }
    )
    expect(interactive).toBe(true)
    expect(ports.control).toHaveBeenCalledWith(expect.objectContaining({ root: local.root }))
  })
})

describe("control bridge result and progress contract", () => {
  it("captures complete JSON, scalar, object and plain-text documents in order", async () => {
    const document = { rows: [1, 2] }
    handler = Console.log("{\"status\":\"ok\"}", document, "3", "false", "null", "plain text")
    expect(await Bridge.invoke(["list"], local, runtime))
      .toEqual([{ status: "ok" }, document, 3, false, null, "plain text"])
    expect(receivedArguments).toEqual(["--json", "--root", local.root, "list"])
    handler = Effect.void
    expect(await Bridge.invoke(["list"], local, runtime)).toEqual([])
  })

  it("uses scoped stderr and policy, sanitizes and bounds progress, and preserves returned data", async () => {
    let stderr = ""
    handler = Effect.gen(function*() {
      expect((yield* RunProgress.Configuration)?.policy.progress).toBe("plain")
      expect(yield* References.MinimumLogLevel).toBe("Info")
      expect(yield* Logger.LogToStderr).toBe(true)
      yield* Console.error("%s\n%s", "\u001b[31mprogress\u001b[0m", "x".repeat(600))
      yield* Console.log("{\"complete\":true}")
    })
    let result: unknown
    await Presentation.scope({ command: "list" }, {
      ...runtime,
      stderr: {
        isTTY: false,
        columns: 80,
        write: (text) => {
          stderr += text
        }
      }
    }, async () => {
      result = await Bridge.invoke(["list"], local, { ...runtime, presentation: silent })
    })
    expect(result).toEqual({ complete: true })
    expect(stderr).toMatch(/^progress x+…\n$/)
    expect(stderr.length).toBe(501)
  })

  it("quiet suppresses progress and interaction while retaining the final document and exit status", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const exit = vi.fn()
    handler = Effect.gen(function*() {
      expect((yield* RunProgress.Configuration)?.policy.progress).toBe("silent")
      expect((yield* Ui.Ui).interactive).toBe(false)
      expect(yield* References.MinimumLogLevel).toBe("Error")
      yield* Console.error("hidden progress")
      yield* CommandStatus.set(2)
      yield* Console.log("{\"document\":\"retained\"}")
    })
    expect(await Bridge.invoke(["list"], { ...local, quiet: true }, { ...runtime, exit }))
      .toEqual({ document: "retained" })
    expect(exit).toHaveBeenCalledExactlyOnceWith(2)
    expect(receivedArguments).not.toContain("--quiet")
    expect(stderr).not.toHaveBeenCalled()
    await Bridge.invoke(["list"], { ...local, quiet: true })
  })

  it.each([
    { output: false, failure: { _tag: "/cli/UnsupportedError" } },
    { output: true, failure: { _tag: "/cli/UnsupportedError" } },
    { output: true, failure: { _tag: "other" } },
    { output: true, failure: new Error("transport failed") },
    { output: true, failure: null },
    { output: true, failure: "failure" }
  ])("preserves the original failure identity ($failure)", async (fixture) => {
    const exit = vi.fn()
    handler = (fixture.output ? Console.log("partial") : Effect.void).pipe(
      Effect.andThen(Effect.fail(fixture.failure))
    )
    await expect(Bridge.invoke(["list"], local, { ...runtime, exit })).rejects.toBe(fixture.failure)
    expect(exit).not.toHaveBeenCalled()
  })
})

describe("control bridge bug report consent", () => {
  const endpoint = "https://preview.invalid/report"
  const summary = `${"two  spaces of diagnostic context; ".repeat(30)}Authorization: Bearer private-preview-token`
  /** Drives the unified `bug` verb the way `bin` does, with a captured session stderr. */
  const bug = async (flags: ReadonlyArray<string>, overrides: Partial<Bridge.Runtime> = {}) => {
    const captured = { stdout: "", stderr: "", codes: [] as Array<number> }
    const stderr = {
      isTTY: false,
      columns: 80,
      write: (text: string) => {
        captured.stderr += text
        return true
      }
    }
    const config = {
      environment: { SMITHERS_BUG_ENDPOINT: endpoint },
      presentation: plain,
      stderr,
      ...overrides
    }
    const argv = ["bug", summary, "--root", local.root, ...flags, "--json"]
    await makeCli(config).serve(Audience.incurArguments(argv, config.presentation ?? plain), {
      env: config.environment,
      stdout: (text) => {
        captured.stdout += text
      },
      exit: (code) => {
        captured.codes.push(code)
      }
    })
    return captured
  }
  const preview = (stderr: string) => {
    const [shownEndpoint, payload] = stderr.trimEnd().split("\n")
    expect(shownEndpoint).toBe(endpoint)
    expect(payload!.length).toBeGreaterThan(500)
    expect(payload).not.toContain("private-preview-token")
    expect(JSON.parse(payload!).summary).toContain("two  spaces")
    return payload!
  }

  it.each([true, false])("shows the complete redacted payload before interactive consent (%s)", async (accepted) => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }))
    let shownBeforeConsent = ""
    let stderrSoFar = () => ""
    const ui = Ui.make({ output: process.stderr, input: process.stdin, interactive: true })
    const confirm = vi.fn(() =>
      Effect.sync(() => {
        expect(fetch).not.toHaveBeenCalled()
        shownBeforeConsent = preview(stderrSoFar())
        return accepted
      })
    )
    vi.spyOn(Ui, "make").mockReturnValue({ ...ui, confirm })
    const captured = { stderr: "" }
    stderrSoFar = () => captured.stderr
    const result = await bug([], {
      presentation: { ...plain, interactive: true },
      stderr: {
        isTTY: false,
        columns: 80,
        write: (text: string) => {
          captured.stderr += text
          return true
        }
      }
    })
    if (accepted) {
      expect(JSON.parse(result.stdout)).toMatchObject({ reported: true, endpoint })
      expect(fetch).toHaveBeenCalledExactlyOnceWith(
        endpoint,
        expect.objectContaining({
          method: "POST",
          body: shownBeforeConsent
        })
      )
    } else {
      expect(result.stdout).toContain("Report not sent")
      expect(result.codes).toContain(2)
      expect(fetch).not.toHaveBeenCalled()
    }
    expect(confirm).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      initialValue: false,
      nonInteractive: false
    }))
  })

  it("quiet explicit consent still shows the complete payload before posting", async () => {
    let shown = ""
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, options) => {
      shown = String(options?.body)
      return new Response("{}", { status: 202 })
    })
    const result = await bug(["--yes", "--quiet"])
    expect(JSON.parse(result.stdout)).toMatchObject({ reported: true, endpoint })
    expect(preview(result.stderr)).toBe(shown)
    expect(fetch).toHaveBeenCalledOnce()
  })

  it("dry-run wins over explicit consent and quiet without posting", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }))
    const result = await bug(["--yes", "--dry-run", "--quiet"])
    expect(JSON.parse(result.stdout)).toMatchObject({
      reported: false,
      endpoint,
      payload: JSON.parse(preview(result.stderr))
    })
    expect(fetch).not.toHaveBeenCalled()
  })

  it("quiet without consent previews the report and refuses to post", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 202 }))
    const result = await bug(["--quiet"])
    expect(result.stdout).toContain("Report not sent")
    preview(result.stderr)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe("control bridge transport scope", () => {
  it("keeps one acquired Control alive through bulk listing and cancellation", async () => {
    service = {
      ...service,
      list: () =>
        Effect.sync(() => {
          lifecycle.push("list")
          return {
            _tag: "runs" as const,
            items: ["first", "second"].map((runId) => ({
              runId,
              flowId: "demo/ship",
              status: "parked" as const,
              createdAt: 1,
              updatedAt: 1
            }))
          }
        }),
      cancel: ({ runId, idempotencyKey }) =>
        Effect.sync(() => {
          lifecycle.push(`cancel:${runId}`)
          return { _tag: "Accepted" as const, runId, receiptId: idempotencyKey }
        })
    }
    const codes: Array<number> = []
    await createRunsCli(runtime).serve(["cancel-all", "--remote", "https://control.invalid", "--json"], {
      stdout: () => {},
      exit: (code) => {
        codes.push(code)
      }
    })
    expect(codes).toEqual([])
    expect(ports.control).toHaveBeenCalledTimes(1)
    expect(lifecycle).toEqual(["control:open", "list", "cancel:first", "cancel:second", "control:close"])
  })

  it.each([undefined, plain, silent])(
    "queries the selected service and closes it with policy %j",
    async (presentation) => {
      const value = await Bridge.query(
        Effect.gen(function*() {
          expect(yield* Control.Control).toBe(service)
          expect(yield* Logger.LogToStderr).toBe(true)
          expect(yield* References.MinimumLogLevel).toBe(presentation === silent ? "Error" : "Info")
          return { rows: ["first", "second"] }
        }),
        local,
        { environment: {}, presentation }
      )
      expect(value).toEqual({ rows: ["first", "second"] })
      expect(lifecycle).toEqual(["control:open", "control:close"])
    }
  )

  it("reads through the observing host alone, and events do too", async () => {
    service = { ...service, watch: () => Stream.empty }
    const value = await Bridge.read(
      Effect.map(Control.Control, (control) => control === service),
      local,
      runtime
    )
    expect(value).toBe(true)
    for await (const _ of Bridge.events("r", false, local, runtime)) break
    expect(ports.control).not.toHaveBeenCalled()
    expect(ports.observe).toHaveBeenCalledTimes(2)
    expect(ports.observe.mock.calls[0]![0]).toMatchObject({ root: directory })
    expect(lifecycle).toEqual(["control:open", "control:close", "control:open", "control:close"])
  })

  it("preserves query failure identity and releases its transport", async () => {
    const failure = { _tag: "query-failure", code: 17 }
    await expect(Bridge.query(Effect.fail(failure), local, runtime)).rejects.toBe(failure)
    expect(lifecycle).toEqual(["control:open", "control:close"])
  })

  it("applies the current presentation session to queries ahead of caller defaults", async () => {
    await Presentation.scope({ command: "list" }, { ...runtime, presentation: silent }, async () => {
      expect(await Bridge.query(References.MinimumLogLevel, local, runtime)).toBe("Error")
    })
    expect(await Bridge.query(Effect.succeed("default runtime"), local)).toBe("default runtime")
  })

  it.each(["command", "query", "host"])("aborts an active %s and releases every acquired resource", async (kind) => {
    const abort = new AbortController()
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    const waiting = Effect.sync(started).pipe(Effect.andThen(Effect.never))
    handler = waiting
    ports.serve.mockReturnValue(waiting)
    const options = { ...local, quiet: true }
    const invocation = { ...runtime, signal: abort.signal }
    const result = (kind === "command"
      ? Bridge.invoke(["list"], options, invocation)
      : kind === "query"
      ? Bridge.query(waiting, options, invocation)
      : Bridge.host(bind, options, invocation)).then(() => "completed", () => "interrupted")
    await ready
    expect(lifecycle).toContain("control:open")
    abort.abort()
    expect(await result).toBe("interrupted")
    expect(lifecycle).toEqual(
      kind === "host"
        ? ["control:open", "scheduler:open", "scheduler:close", "control:close"]
        : ["control:open", "control:close"]
    )
  })

  it.each([undefined, 0, 17])(
    "forwards watch cursors and releases the transport on early consumer return (%s)",
    async (after) => {
      const watch = vi.fn().mockReturnValue(Stream.make({ sequence: 18 }, { sequence: 19 }))
      service = { ...service, watch }
      const iterator = Bridge.events("watched", true, local, runtime, after)[Symbol.asyncIterator]()
      expect(await iterator.next()).toEqual({ done: false, value: { sequence: 18 } })
      await iterator.return!()
      expect(watch).toHaveBeenCalledExactlyOnceWith({
        runId: "watched",
        follow: true,
        ...(after === undefined ? {} : { afterSequence: after })
      })
      expect(lifecycle).toEqual(["control:open", "control:close"])
    }
  )

  it("releases the watch service after stream failure", async () => {
    const failure = new Unavailable({ feature: "watch", ticket: "bridge-fixture" })
    service = { ...service, watch: () => Stream.fail(failure) }
    const iterator = Bridge.events("r", false, local)[Symbol.asyncIterator]()
    await expect(iterator.next()).rejects.toBe(failure)
    expect(lifecycle).toEqual(["control:open", "control:close"])
  })

  it("aborts a waiting watch and removes its abort listener", async () => {
    const abort = new AbortController()
    const add = vi.spyOn(abort.signal, "addEventListener")
    let started!: () => void
    const ready = new Promise<void>((resolve) => {
      started = resolve
    })
    service = { ...service, watch: () => Stream.fromEffect(Effect.sync(started).pipe(Effect.andThen(Effect.never))) }
    const iterator = Bridge.events("r", true, local, { ...runtime, signal: abort.signal })[Symbol.asyncIterator]()
    const waiting = iterator.next()
    await ready
    abort.abort()
    expect(await waiting).toEqual({ done: true, value: undefined })
    expect(lifecycle).toEqual(["control:open", "control:close"])
    expect(add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true })
    expect(getEventListeners(abort.signal, "abort")).toEqual([])
  })

  it("completes a watch whose signal was already aborted without retaining a listener", async () => {
    const abort = new AbortController()
    abort.abort()
    const add = vi.spyOn(abort.signal, "addEventListener")
    service = { ...service, watch: () => Stream.never }
    const iterator = Bridge.events("r", true, local, { ...runtime, signal: abort.signal })[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: true, value: undefined })
    expect(add).not.toHaveBeenCalled()
    expect(getEventListeners(abort.signal, "abort")).toEqual([])
    expect(lifecycle.filter((event) => event === "control:open").length)
      .toBe(lifecycle.filter((event) => event === "control:close").length)
  })

  it("removes an untriggered abort listener when the consumer stops following", async () => {
    const abort = new AbortController()
    const remove = vi.spyOn(abort.signal, "removeEventListener")
    service = { ...service, watch: vi.fn().mockReturnValue(Stream.make({ sequence: 1 })) }
    const iterator = Bridge.events("r", true, local, { ...runtime, signal: abort.signal })[Symbol.asyncIterator]()
    expect(await iterator.next()).toEqual({ done: false, value: { sequence: 1 } })
    await iterator.return!()
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function))
    expect(getEventListeners(abort.signal, "abort")).toEqual([])
    expect(lifecycle).toEqual(["control:open", "control:close"])
  })

  it("shares one scoped control service between the server and scheduler", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    await Bridge.host(bind, local, runtime)
    expect(ports.scheduler).toHaveBeenCalledExactlyOnceWith(local.root)
    // A host with no credential mints a per-session operator token for approvals.
    expect(ports.serve).toHaveBeenCalledExactlyOnceWith(
      { ...bind, operatorToken: expect.stringMatching(/^[0-9a-f]{64}$/) },
      local.root
    )
    const { operatorToken } = ports.serve.mock.calls[0]![0] as { readonly operatorToken: string }
    expect(lifecycle).toEqual(["control:open", "scheduler:open", "serve", "scheduler:close", "control:close"])
    expect(stderr.mock.calls.map(([text]) => String(text))).toEqual([
      expect.stringContaining("127.0.0.1:0"),
      `  approval token  ${operatorToken}\n`
    ])
  })

  it("mints no operator token for a host that carries a credential", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const credentialed = { ...bind, credential: "host-bearer" }
    await Bridge.host(credentialed, local, runtime)
    expect(ports.serve).toHaveBeenCalledExactlyOnceWith({ ...credentialed, operatorToken: undefined }, local.root)
    expect(stderr).toHaveBeenCalledOnce()
    expect(String(stderr.mock.calls[0]![0])).not.toContain("approval token")
  })

  it("does not print a quiet host banner and preserves launch failures after cleanup", async () => {
    const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true)
    const failure = { _tag: "host-failure" }
    ports.serve.mockReturnValue(Effect.fail(failure))
    await expect(Bridge.host(bind, { ...local, quiet: true }, runtime)).rejects.toBe(failure)
    // Quiet drops the banner but never the token an operator needs to approve.
    const { operatorToken } = ports.serve.mock.calls[0]![0] as { readonly operatorToken: string }
    expect(stderr.mock.calls.map(([text]) => String(text))).toEqual([`  approval token  ${operatorToken}\n`])
    expect(lifecycle).toEqual(["control:open", "scheduler:open", "scheduler:close", "control:close"])
  })

  it("refuses remote or unapproved public hosting before any resource is acquired", async () => {
    await expect(Bridge.host(bind, { ...local, remote: "https://control.invalid" }, runtime))
      .rejects.toMatchObject({
        _tag: "/cli/UnsupportedError",
        message: expect.stringContaining("--remote is not supported")
      })
    await expect(Bridge.host({ ...bind, host: "0.0.0.0" }, local, runtime)).rejects.toThrow("pass --listen")
    expect(ports.control).not.toHaveBeenCalled()
    expect(ports.scheduler).not.toHaveBeenCalled()
    expect(ports.serve).not.toHaveBeenCalled()
    expect(lifecycle).toEqual([])
  })
})
