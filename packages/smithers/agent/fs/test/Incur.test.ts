import { Flow } from "@smthrs/core"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { Cause, Effect, Layer, Logger, Option, References, Schema } from "effect"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import * as FlowInvoker from "../src/FlowInvoker.ts"
import { FsError } from "../src/FsError.ts"
import * as Incur from "../src/Incur.ts"
import * as Route from "../src/Route.ts"
import visible from "./fixtures/command/visible.ts"
import { latchedInvoke, makeRoute, recordedImports, recordedModule, refinedModule } from "./helpers.ts"

const makeCli = async (routes = [makeRoute("review")], invoke?: FlowInvoker.Service["invoke"]) => {
  const seen: Array<FlowInvoker.Invocation> = []
  const invoker = FlowInvoker.make({
    invoke: invoke ?? ((invocation) =>
      Effect.sync(() => {
        seen.push(invocation)
        const number = (invocation.input as { readonly number: number }).number
        return { accepted: true, number }
      }))
  })
  const cli = await Effect.runPromise(
    Incur.createCli("flows", routes).pipe(Effect.provide(Layer.succeed(FlowInvoker.FlowInvoker, invoker)))
  )
  return { cli, seen }
}

const capture = () => {
  const writes: Array<string> = []
  const exits: Array<number> = []
  return {
    writes,
    exits,
    options: {
      stdout: (value: string) => writes.push(value),
      exit: (code: number) => exits.push(code)
    }
  }
}

const paths = async (cli: { readonly fetch: (request: Request) => Promise<Response> }) => {
  const spec = await (await cli.fetch(new Request("http://localhost/openapi.json"))).json() as {
    readonly paths: Readonly<Record<string, unknown>>
  }
  return Object.keys(spec.paths).sort()
}

/** Calls one tool on the MCP surface and returns the JSON-RPC payload. */
const tool = async (
  cli: { readonly fetch: (request: Request) => Promise<Response> },
  name: string,
  args: Readonly<Record<string, unknown>>
) => {
  const response = await cli.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } })
    })
  )
  return await response.json() as {
    readonly result: {
      readonly isError?: boolean
      readonly content: ReadonlyArray<{ readonly text: string }>
    }
  }
}

const transports = ["HTTP", "CLI", "MCP"] as const

const call = async (cli: Awaited<ReturnType<typeof makeCli>>["cli"], transport: typeof transports[number]) => {
  if (transport === "HTTP") {
    const response = await cli.fetch(new Request("http://localhost/review?number=42"))
    return { failed: response.status >= 400, body: await response.text() }
  }
  if (transport === "CLI") {
    const run = capture()
    await cli.serve(["review", "--number", "42", "--format", "json"], run.options)
    return { failed: run.exits.includes(1), body: run.writes.join("") }
  }
  const response = await tool(cli, "call_write_tool", { name: "review", arguments: { number: 42 } })
  return { failed: response.result.isError === true, body: JSON.stringify(response) }
}

describe("Incur projection", () => {
  const within = async <A>(promise: Promise<A>, milliseconds: number): Promise<A> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("Metadata wait exceeded test deadline")), milliseconds)
        })
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  it("bounds a native import stuck in top-level await and discovers sibling routes", async () => {
    let release!: () => void
    const globals = globalThis as { fsMetadataGate?: Promise<void> }
    globals.fsMetadataGate = new Promise<void>((resolve) => {
      release = resolve
    })
    const directory = await mkdtemp(join(tmpdir(), "fs-metadata-"))
    const source = join(directory, "stuck.mjs")
    await writeFile(source, "await globalThis.fsMetadataGate; export default null\n")
    const { cli } = await makeCli([makeRoute("a-stuck", source), makeRoute("review")])
    const discovery = paths(cli)
    try {
      expect(await within(discovery, 8_000)).toEqual(["/a-stuck", "/review"])
      const called = await tool(cli, "call_write_tool", { name: "a-stuck", arguments: {} })
      expect(called.result.isError).toBe(true)
      expect(called.result.content[0]!.text).toContain("The route metadata load timed out")
      expect((await call(cli, "MCP")).failed).toBe(false)
    } finally {
      // Release this otherwise unbounded module only after the deadline
      // assertions so teardown leaves no outstanding module evaluation.
      release()
      await discovery.catch(() => undefined)
      delete globals.fsMetadataGate
      await rm(directory, { recursive: true, force: true })
    }
  })

  it.each(["/openapi.json", "/missing"])("cancels only the waiter for %s", async (path) => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const load = vi.spyOn(Route, "load").mockReturnValue(Effect.promise(() => gate).pipe(Effect.as(visible)))
    const { cli } = await makeCli()
    const controller = new AbortController()
    const reason = new Error("request cancelled")
    const request = cli.fetch(new Request(`http://localhost${path}`, { signal: controller.signal }))
    const other = paths(cli)
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
      controller.abort(reason)
      await expect(within(request, 500)).rejects.toBe(reason)
      expect(load).toHaveBeenCalledTimes(1)
      release()
      expect(await other).toEqual(["/review"])
    } finally {
      release()
      await Promise.allSettled([request, other])
      load.mockRestore()
    }
  })

  it("does not start a metadata build for an already aborted request", async () => {
    const load = vi.spyOn(Route, "load")
    const { cli } = await makeCli()
    const controller = new AbortController()
    const reason = new Error("already cancelled")
    controller.abort(reason)
    try {
      await expect(cli.fetch(new Request("http://localhost/openapi.json", { signal: controller.signal })))
        .rejects.toBe(reason)
      expect(load).not.toHaveBeenCalled()
    } finally {
      load.mockRestore()
    }
  })

  it("retries a rejected shared metadata build on the next request", async () => {
    const load = vi.spyOn(Route, "load").mockReturnValueOnce(Effect.die(new Error("build failed once")))
    const { cli } = await makeCli()
    try {
      await expect(paths(cli)).rejects.toThrow("build failed once")
      expect(await paths(cli)).toEqual(["/review"])
      expect(await paths(cli)).toEqual(["/review"])
      expect(load).toHaveBeenCalledTimes(2)
    } finally {
      load.mockRestore()
    }
  })

  it("cancels a request aborted synchronously while its shared build starts", async () => {
    const controller = new AbortController()
    const reason = new Error("cancelled during startup")
    const load = vi.spyOn(Route, "load").mockImplementationOnce(() => {
      controller.abort(reason)
      return Effect.succeed(visible)
    })
    const { cli } = await makeCli()
    try {
      await expect(cli.fetch(new Request("http://localhost/openapi.json", { signal: controller.signal })))
        .rejects.toBe(reason)
      expect(await paths(cli)).toEqual(["/review"])
      expect(load).toHaveBeenCalledTimes(1)
    } finally {
      load.mockRestore()
    }
  })

  describe("request cancellation", () => {
    it("never invokes a flow for an already aborted request", async () => {
      const { cli, seen } = await makeCli()
      const controller = new AbortController()
      const reason = new Error("cancelled before dispatch")
      controller.abort(reason)
      await expect(cli.fetch(new Request("http://localhost/review?number=42", { signal: controller.signal })))
        .rejects.toBe(reason)
      await expect(
        cli.fetch(
          new Request("http://localhost/mcp", {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "call_write_tool", arguments: { name: "review", arguments: { number: 42 } } }
            })
          })
        )
      ).rejects.toBe(reason)
      expect(seen).toEqual([])
    })

    it("interrupts route selection when the request aborts", async () => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      const interrupted = vi.fn()
      const load = vi.spyOn(Route, "load").mockReturnValue(
        Effect.promise(() => gate).pipe(Effect.as(visible), Effect.onInterrupt(() => Effect.sync(interrupted)))
      )
      const { cli, seen } = await makeCli()
      const controller = new AbortController()
      const request = cli.fetch(new Request("http://localhost/review?number=42", { signal: controller.signal }))
      try {
        await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
        controller.abort(new Error("cancelled during selection"))
        await expect(within(request, 500)).rejects.toThrow("All fibers interrupted")
        expect(interrupted).toHaveBeenCalledTimes(1)
        expect(seen).toEqual([])
      } finally {
        release()
        await Promise.allSettled([request])
        load.mockRestore()
      }
    })

    it.each(["HTTP", "MCP"] as const)(
      "interrupts an in-flight %s invocation when the request aborts",
      async (transport) => {
        const latch = latchedInvoke()
        const { cli } = await makeCli(undefined, latch.invoke)
        const controller = new AbortController()
        const request = transport === "HTTP"
          ? new Request("http://localhost/review?number=42", { signal: controller.signal })
          : new Request("http://localhost/mcp", {
            method: "POST",
            signal: controller.signal,
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: { name: "call_write_tool", arguments: { name: "review", arguments: { number: 42 } } }
            })
          })
        const response = cli.fetch(request)
        const settled = Promise.allSettled([response])
        try {
          await within(latch.started, 8_000)
          controller.abort(new Error("client went away"))
          // The abort interrupts the invocation fiber, which runs its finalizers
          // before the request settles.
          await within(latch.finalized, 500)
          const [outcome] = await settled
          if (outcome!.status === "fulfilled") {
            const result = outcome!.value
            if (transport === "HTTP") {
              expect(result.status).toBeGreaterThanOrEqual(400)
            } else {
              const payload = await result.json() as {
                readonly error?: unknown
                readonly result?: { readonly isError?: boolean }
              }
              expect(payload.error !== undefined || payload.result?.isError === true).toBe(true)
            }
          }
        } finally {
          latch.release()
          await settled
        }
      }
    )
  })

  it("closes the host by interrupting the build before projecting more routes", async () => {
    const interrupted = vi.fn()
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const load = vi.spyOn(Route, "load").mockReturnValue(
      Effect.promise(() => gate).pipe(Effect.as(visible), Effect.onInterrupt(() => Effect.sync(interrupted)))
    )
    const { cli } = await makeCli([makeRoute("first"), makeRoute("second")])
    const pending = paths(cli)
    // Install a rejection handler before closing the host.
    const settled = Promise.allSettled([pending])
    try {
      await vi.waitFor(() => expect(load).toHaveBeenCalledTimes(1))
      await within(cli.close(), 500)
      expect(interrupted).toHaveBeenCalledTimes(1)
      expect((await settled)[0]!.status).toBe("rejected")
      await expect(paths(cli)).rejects.toThrow("The CLI is closed")
      await expect(cli.fetch(new Request("http://localhost/first"))).rejects.toThrow("The CLI is closed")
      await expect(cli.serve(["--llms"], capture().options)).rejects.toThrow("The CLI is closed")
      await cli.close()
      expect(load).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await settled
      load.mockRestore()
    }
  })

  it("carries typed inputs consistently over GET and JSON POST", async () => {
    const { cli, seen } = await makeCli()
    const get = await cli.fetch(new Request("http://localhost/review?number=42&enabled=true"))
    const post = await cli.fetch(
      new Request("http://localhost/review", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ number: 43, tags: ["a", "b"] })
      })
    )

    expect(get.status).toBe(200)
    expect((await get.json()).data).toEqual({ accepted: true, number: 42 })
    expect(post.status).toBe(200)
    expect((await post.json()).data).toEqual({ accepted: true, number: 43 })
    expect(seen.map((invocation) => invocation.input)).toEqual([
      { number: 42, enabled: true },
      { number: 43, tags: ["a", "b"] }
    ])
  })

  it("accepts declared flags from the CLI projection", async () => {
    const { cli, seen } = await makeCli()
    const writes: Array<string> = []
    const write = vi.spyOn(process.stdout, "write").mockImplementation(
      ((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      }) as typeof process.stdout.write
    )
    try {
      await cli.serve(["review", "--number", "44", "--format", "json"])
    } finally {
      write.mockRestore()
    }
    expect(seen[0]?.input).toEqual({ number: 44 })
    expect(writes.join("")).toContain("44")
  })

  it("carries an explicit null scalar input over a JSON body and MCP arguments", async () => {
    const flow = Flow.make({
      name: "scalar",
      input: Schema.NullOr(Schema.String),
      output: Schema.NullOr(Schema.String)
    })
    vi.spyOn(Route, "load").mockReturnValue(Effect.succeed(flow))
    try {
      const inputs: Array<unknown> = []
      const { cli } = await makeCli([makeRoute("scalar")], ({ input }) =>
        Effect.sync(() => {
          inputs.push(input)
          return input
        }))
      const post = await cli.fetch(
        new Request("http://localhost/scalar", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ input: null })
        })
      )
      expect(post.status).toBe(200)
      const called = await tool(cli, "call_write_tool", { name: "scalar", arguments: { input: null } })
      expect(called.result.isError).not.toBe(true)
      expect(inputs).toEqual([null, null])
    } finally {
      vi.restoreAllMocks()
    }
  })

  it("advertises the real input schema on every discovery surface", async () => {
    const { cli } = await makeCli()
    // The flow's own JSON Schema is the yardstick: a discovery surface that
    // publishes anything narrower or vaguer misdescribes what the flow takes.
    const declared = Schema.toJsonSchemaDocument(visible.input).schema as {
      readonly properties: Readonly<Record<string, unknown>>
      readonly required: ReadonlyArray<string>
    }

    const details = await tool(cli, "get_tool_details", { name: "review" })
    const advertised = JSON.parse(details.result.content[0]!.text) as {
      readonly inputSchema: {
        readonly properties: Readonly<Record<string, unknown>>
        readonly required: ReadonlyArray<string>
      }
    }
    expect(advertised.inputSchema.properties).toEqual(declared.properties)
    expect(advertised.inputSchema.required).toEqual(declared.required)

    const spec = await (await cli.fetch(new Request("http://localhost/openapi.json"))).json() as {
      readonly paths: {
        readonly "/review": {
          readonly post: {
            readonly requestBody: {
              readonly content: {
                readonly "application/json": {
                  readonly schema: { readonly properties: Readonly<Record<string, unknown>> }
                }
              }
            }
          }
        }
      }
    }
    expect(spec.paths["/review"].post.requestBody.content["application/json"].schema.properties).toEqual(
      declared.properties
    )

    const help = capture()
    await cli.serve(["review", "--schema"], help.options)
    expect(help.writes.join("")).toContain("number")
  })

  it("carries MCP tool arguments through to the invoked flow", async () => {
    const { cli, seen } = await makeCli()
    const called = await tool(cli, "call_write_tool", { name: "review", arguments: { number: 42 } })
    expect(called.result.isError).toBeUndefined()
    expect(called.result.content[0]!.text).toContain("42")
    expect(seen.map((invocation) => invocation.input)).toEqual([{ number: 42 }])
  })

  it("keeps an unprojectable route advertised and answers with its typed failure", async () => {
    const unsupported = makeRoute("bad", undefined, { input: new Descriptor.SchemaRefMarkdownOutput({}) })
    const { cli, seen } = await makeCli([makeRoute("review"), unsupported])

    // A route that cannot be projected is still dispatchable, so hiding it from
    // discovery would be the one failure this projection exists to prevent.
    expect(await paths(cli)).toEqual(["/bad", "/review"])
    const called = await tool(cli, "call_write_tool", { name: "bad", arguments: {} })
    expect(called.result.isError).toBe(true)
    expect(called.result.content[0]!.text).toContain("An output locator cannot describe command input")
    expect(seen).toEqual([])
  })

  it("loads only the dispatched module until a discovery surface needs the rest", async () => {
    const { cli, seen } = await makeCli([makeRoute("review"), makeRoute("recorded", recordedModule)])
    expect(recordedImports()).toBe(0)

    expect((await cli.fetch(new Request("http://localhost/review?number=1"))).status).toBe(200)
    expect(seen.map((invocation) => invocation.name)).toEqual(["review"])
    expect(recordedImports()).toBe(0)

    // Discovery must publish real schemas, so it projects every command once
    // and reuses that projection.
    expect(await paths(cli)).toEqual(["/recorded", "/review"])
    expect(recordedImports()).toBe(1)
    expect(await paths(cli)).toEqual(["/recorded", "/review"])
    expect(recordedImports()).toBe(1)
  })

  it("keeps parent routes and nested routes independently executable", async () => {
    const { cli, seen } = await makeCli([makeRoute("domains"), makeRoute("domains/list")])
    expect((await cli.fetch(new Request("http://localhost/domains?number=1"))).status).toBe(200)
    const nested = await cli.fetch(new Request("http://localhost/domains/list?number=2"))
    expect(nested.status, await nested.clone().text()).toBe(200)
    expect(seen.map((invocation) => invocation.name)).toEqual(["domains", "domains/list"])
  })

  it("advertises a route that also has children under the reserved self segment", async () => {
    const { cli, seen } = await makeCli([makeRoute("domains"), makeRoute("domains/list")])
    expect(await paths(cli)).toEqual(["/domains/list", "/domains/self"])

    const manifest = capture()
    await cli.serve(["--llms"], manifest.options)
    expect(manifest.writes.join("")).toContain("domains self")

    const self = await cli.fetch(new Request("http://localhost/domains/self?number=3"))
    expect(self.status, await self.clone().text()).toBe(200)
    expect((await self.json()).data).toEqual({ accepted: true, number: 3 })

    const cliRun = capture()
    await cli.serve(["domains", "self", "--number", "5", "--format", "json"], cliRun.options)
    expect(cliRun.writes.join("")).toContain("5")
    expect(seen.map((invocation) => invocation.name)).toEqual(["domains", "domains"])
  })

  it("refuses a child route that claims the reserved self segment", async () => {
    const exit = await Effect.runPromise(Effect.exit(
      Incur.createCli("flows", [makeRoute("domains"), makeRoute(`domains/${Incur.selfSegment}`)]).pipe(
        Effect.provide(FlowInvoker.layerNoop())
      )
    ))
    expect(exit._tag).toBe("Failure")
    if (exit._tag === "Failure") {
      const failure = Cause.findErrorOption(exit.cause)
      expect(Option.isSome(failure) && failure.value).toMatchObject({
        code: "duplicate_route",
        path: "domains/self"
      })
    }
  })

  it("surfaces a hydration failure instead of falling back to help output", async () => {
    const unsupported = makeRoute("bad", undefined, { input: new Descriptor.SchemaRefMarkdownOutput({}) })
    const { cli, seen } = await makeCli([unsupported])

    const response = await cli.fetch(new Request("http://localhost/bad?number=1"))
    const body = await response.json()
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(body.error).toMatchObject({
      code: "unsupported_schema",
      message: "An output locator cannot describe command input"
    })

    const run = capture()
    await cli.serve(["bad", "--number", "1"], run.options)
    expect(run.writes.join("")).toContain("unsupported_schema")
    expect(run.exits).toContain(1)
    expect(seen).toEqual([])
  })

  it("reports a resolution resource limit before dispatch on both surfaces", async () => {
    const { cli, seen } = await makeCli()
    const oversized = "x".repeat(5_000)

    const response = await cli.fetch(new Request(`http://localhost/${oversized}`))
    expect(response.status).toBe(400)
    expect((await response.json()).error).toMatchObject({ code: "resource_limit" })

    const run = capture()
    await cli.serve([oversized], run.options)
    expect(run.writes.join("")).toContain("resource_limit")
    expect(run.exits).toEqual([1])
    expect(seen).toEqual([])
  })

  it("writes a pre-dispatch failure to stdout and exits when no overrides are supplied", async () => {
    const { cli } = await makeCli()
    const writes: Array<string> = []
    const write = vi.spyOn(process.stdout, "write").mockImplementation(
      ((chunk: unknown) => {
        writes.push(String(chunk))
        return true
      }) as typeof process.stdout.write
    )
    const exits: Array<number> = []
    const exit = vi.spyOn(process, "exit").mockImplementation(
      ((code: number) => {
        exits.push(code)
      }) as never
    )
    try {
      await cli.serve(["x".repeat(5_000)])
    } finally {
      write.mockRestore()
      exit.mockRestore()
    }
    expect(writes.join("")).toContain("resource_limit")
    expect(exits).toEqual([1])
  })

  it("percent-decodes and NFC-normalizes request paths", async () => {
    const composed = "caf\u00e9"
    const decomposed = "cafe\u0301"
    // The route is declared decomposed, as a macOS directory name arrives, and
    // requested composed, as a browser or an agent sends it.
    const { cli, seen } = await makeCli([makeRoute(decomposed)])

    const unicode = await cli.fetch(new Request(`http://localhost/${encodeURIComponent(composed)}?number=9`))
    expect(unicode.status, await unicode.clone().text()).toBe(200)
    expect(seen.map((invocation) => invocation.name)).toEqual([composed])

    // An encoded slash decodes inside one segment and never invents a boundary.
    expect((await cli.fetch(new Request("http://localhost/%2Fcaf%C3%A9?number=1"))).status).toBe(404)

    const malformed = await cli.fetch(new Request("http://localhost/%E0%A4%A"))
    expect(malformed.status).toBe(400)
    expect((await malformed.json()).error).toMatchObject({
      code: "parse_failed",
      message: "The request path contains a malformed percent escape"
    })
    expect(seen).toHaveLength(1)
  })

  it("treats COMPLETE as truthy exactly as incur does", async () => {
    const { cli, seen } = await makeCli()
    const previous = process.env.COMPLETE
    const empty = capture()
    const shell = capture()
    try {
      process.env.COMPLETE = ""
      await cli.serve(["review", "--number", "4", "--format", "json"], empty.options)
      process.env.COMPLETE = "zsh"
      await cli.serve(["review", "--number", "6", "--format", "json"], shell.options)
    } finally {
      if (previous === undefined) delete process.env.COMPLETE
      else process.env.COMPLETE = previous
    }
    expect(empty.writes.join("")).toContain("4")
    expect(shell.writes.join("")).not.toContain("6")
    expect(seen.map((invocation) => invocation.input)).toEqual([{ number: 4 }])
  })

  it("accepts slash names and metadata-only groups through the CLI", async () => {
    const { cli, seen } = await makeCli([makeRoute("nested/visible"), makeRoute("domains/list")])
    const writes: Array<string> = []
    await cli.serve(["nested/visible", "--number", "7", "--format", "json"], {
      stdout: (value) => writes.push(value),
      exit: () => undefined
    })
    expect(seen.map((entry) => entry.name)).toEqual(["nested/visible"])
    expect(writes.join("")).toContain("7")
    expect((await cli.fetch(new Request("http://localhost/openapi.json"))).status).toBe(200)
  })

  it("refuses a surplus positional on every route before invoking its flow", async () => {
    const { cli, seen } = await makeCli([
      makeRoute("review"),
      makeRoute("nested/visible"),
      makeRoute("domains"),
      makeRoute("domains/list")
    ])
    for (
      const path of [["review"], ["nested/visible"], ["nested", "visible"], ["domains", "self"], ["domains", "list"]]
    ) {
      const run = capture()
      await cli.serve([...path, "surplus", "--number", "1", "--format", "json"], run.options)
      expect(run.exits, path.join(" ")).toEqual([1])
      expect(JSON.parse(run.writes.join(""))).toMatchObject({
        code: "UNEXPECTED_ARGUMENT",
        message: "Unexpected argument: surplus"
      })
    }
    expect(seen).toEqual([])
  })

  it("keeps CLI discovery and unknown commands metadata-only", async () => {
    const { cli, seen } = await makeCli()
    const writes: Array<string> = []
    const exits: Array<number> = []
    const options = {
      stdout: (value: string) => writes.push(value),
      exit: (code: number) => exits.push(code)
    }
    await cli.serve(["--help"], options)
    await cli.serve(["missing"], options)
    expect(writes.join("")).toContain("review")
    expect(exits).toContain(1)
    expect(seen).toEqual([])
  })

  it("never mounts hidden or unsupported routes", async () => {
    const { cli } = await makeCli([
      makeRoute("visible"),
      makeRoute("hidden", undefined, { modelInvocable: false }),
      makeRoute("markdown", undefined, { kind: "markdown" }),
      makeRoute("skill", undefined, { kind: "skill" })
    ])
    for (const name of ["hidden", "markdown", "skill"]) {
      expect((await cli.fetch(new Request(`http://localhost/${name}?number=1`))).status).toBe(404)
    }
    const spec = await cli.fetch(new Request("http://localhost/openapi.json"))
    expect(spec.status).toBe(200)
    expect(await spec.text()).not.toContain("hidden")
  })

  it("refuses input its advertised schema rejects without echoing the value", async () => {
    const { cli, seen } = await makeCli()
    // The advertised schema is enforced, not decorative: the refusal names the
    // field that failed and never repeats what the caller sent.
    const response = await cli.fetch(new Request("http://localhost/review?number=not-a-number"))
    const body = await response.json() as {
      readonly error: { readonly fieldErrors: ReadonlyArray<{ readonly path: string }> }
    }
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(body.error.fieldErrors.map((field) => field.path)).toEqual(["number"])
    expect(JSON.stringify(body)).not.toContain("not-a-number")

    const run = capture()
    await cli.serve(["review", "--number", "not-a-number", "--format", "json"], run.options)
    expect(run.writes.join("")).toContain("\"path\": \"number\"")
    expect(run.writes.join("")).not.toContain("not-a-number")
    expect(seen).toEqual([])
  })

  it("returns a stable typed refusal when only the flow schema can reject the input", async () => {
    // `Schema.NonEmptyString` projects to `string`, so the empty title passes
    // the advertised schema and the authoritative decoder is what refuses it.
    const { cli, seen } = await makeCli([makeRoute("refined", refinedModule)])
    const response = await cli.fetch(new Request("http://localhost/refined?title="))
    const body = await response.json()
    expect(response.status).toBeGreaterThanOrEqual(400)
    expect(body.error).toMatchObject({ code: "decode_failed" })
    expect(seen).toEqual([])
  })

  describe.each(transports)("%s invocation boundary", (transport) => {
    it.each([false, true])("enforces authorization after metadata initialized: %s", async (initialized) => {
      const { cli, seen } = await makeCli()
      if (initialized) await paths(cli)
      const guards: Array<string> = []
      expect(cli.use(async (_context, next) => {
        guards.push("first")
        return next()
      })).toBe(cli)
      cli.use((context) => {
        guards.push("deny")
        return context.error({ code: "UNAUTHORIZED", message: "Denied" })
      })
      const response = await call(cli, transport)
      expect(response.failed).toBe(true)
      expect(response.body).toContain(transport === "MCP" ? "Denied" : "UNAUTHORIZED")
      expect(guards).toEqual(["first", "deny"])
      expect(seen).toEqual([])
    })

    it.each(["die", "throw", "failure"])("sanitizes an invoker %s", async (kind) => {
      const sentinel = "SECRET_SENTINEL_credential_from_backend"
      const { cli } = await makeCli(undefined, () => {
        if (kind === "throw") throw new Error(sentinel)
        if (kind === "die") return Effect.die(new Error(sentinel))
        // A JavaScript host can violate the service's typed failure contract.
        return Effect.fail(new Error(sentinel)) as Effect.Effect<never, FsError>
      })
      const response = await call(cli, transport)
      expect(response.failed).toBe(true)
      expect(response.body).not.toContain(sentinel)
      if (transport !== "MCP") expect(response.body).toContain("invocation_unavailable")
      expect(response.body).toContain("The flow invocation failed")
    })

    it.each([false, true])("preserves interruption with a concurrent defect: %s", async (defect) => {
      const sentinel = "SECRET_SENTINEL_interrupted_backend"
      const { cli } = await makeCli(undefined, () =>
        Effect.failCause(Cause.fromReasons<never>([
          ...Cause.interrupt().reasons,
          ...(defect ? Cause.die(new Error(sentinel)).reasons : [])
        ])))
      const response = await call(cli, transport)
      expect(response.failed).toBe(true)
      expect(response.body.toLowerCase()).toContain("interrupt")
      expect(response.body).not.toContain("invocation_unavailable")
      expect(response.body).not.toContain(sentinel)
    })

    it("preserves deliberately public typed failures", async () => {
      const { cli } = await makeCli(undefined, () =>
        Effect.fail(
          new FsError({
            code: "invocation_unavailable",
            method: "test.invoke",
            description: "Public refusal"
          })
        ))
      const response = await call(cli, transport)
      expect(response.failed).toBe(true)
      if (transport !== "MCP") expect(response.body).toContain("invocation_unavailable")
      expect(response.body).toContain("Public refusal")
    })
  })

  it("retains unexpected causes only in the host's private debug logger", async () => {
    const defect = new Error("SECRET_SENTINEL_private_diagnostics")
    const logged: Array<{ readonly message: unknown; readonly cause: Cause.Cause<unknown> }> = []
    const logger = Logger.make((entry) => {
      logged.push(entry)
    })
    const cli = await Effect.runPromise(
      Incur.createCli("flows", [makeRoute("review")]).pipe(
        Effect.provideService(FlowInvoker.FlowInvoker, FlowInvoker.make({ invoke: () => Effect.die(defect) })),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(Logger.layer([logger]))
      )
    )
    const response = await call(cli, "HTTP")
    expect(response.failed).toBe(true)
    expect(response.body).not.toContain(defect.message)
    expect(logged).toHaveLength(1)
    expect(logged[0]!.message).toEqual(["Incur invocation failed"])
    expect(Cause.squash(logged[0]!.cause)).toBe(defect)
  })
  it("keeps built-in debug diagnostics off CLI stdout", async () => {
    const sentinel = "SECRET_SENTINEL_debug_console"
    const cli = await Effect.runPromise(
      Incur.createCli("flows", [makeRoute("review")]).pipe(
        Effect.provideService(
          FlowInvoker.FlowInvoker,
          FlowInvoker.make({ invoke: () => Effect.die(new Error(sentinel)) })
        ),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
        Effect.provide(Logger.layer([Logger.defaultLogger]))
      )
    )
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined)
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined)
    try {
      const response = await call(cli, "CLI")
      expect(response.failed).toBe(true)
      expect(response.body).not.toContain(sentinel)
      expect(stdout).not.toHaveBeenCalled()
      expect(JSON.stringify(stderr.mock.calls)).toContain(sentinel)
    } finally {
      stdout.mockRestore()
      stderr.mockRestore()
    }
  })
})
