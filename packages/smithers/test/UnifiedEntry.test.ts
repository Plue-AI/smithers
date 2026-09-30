import type { RuntimeConfig } from "@smthrs/build-cli/Cli"
import { Cli, z } from "incur"
import { EventEmitter } from "node:events"
import { delimiter, join, resolve } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { type Host, main } from "../src/cli/Entry.ts"

const { makeCli, serve } = vi.hoisted(() => ({ makeCli: vi.fn(), serve: vi.fn() }))
vi.mock("../src/Cli.ts", () => ({ makeCli }))

beforeEach(() => {
  makeCli.mockReset().mockReturnValue({ serve })
  serve.mockReset().mockResolvedValue(undefined)
})

const fixture = (argv: Array<string> = ["--help"], env: Host["env"] = {}) => {
  const signals = new EventEmitter()
  const result = { stdout: "", stderr: "", codes: [] as Array<number> }
  const host: Host = {
    argv,
    env,
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
    on: (signal, listener) => {
      signals.on(signal, listener)
    },
    removeListener: (signal, listener) => {
      signals.removeListener(signal, listener)
    },
    setExitCode: (code) => {
      result.codes.push(code)
    }
  }
  return { host, signals, result }
}
const config = () => makeCli.mock.calls[0]![0] as RuntimeConfig
const clean = (signals: EventEmitter) => {
  expect(signals.listenerCount("SIGINT")).toBe(0)
  expect(signals.listenerCount("SIGTERM")).toBe(0)
}

describe("unified process entry", () => {
  it("isolates cache credentials before constructing commands and preserves other environment", async () => {
    const env = { SMITHERS_CACHE_URL: "https://cache.invalid", SMITHERS_CACHE_TOKEN: "fixture-token", KEEP: "yes" }
    const { host, signals, result } = fixture(["targets", "--root", "/fixture", "--json"], env)
    makeCli.mockImplementation((runtime: RuntimeConfig) => {
      expect(env).toEqual({ KEEP: "yes" })
      expect(runtime.cacheUrl).toBe("https://cache.invalid")
      expect(runtime.cacheToken).toBe("fixture-token")
      expect(runtime.environment).toBe(env)
      return { serve }
    })
    serve.mockImplementation(async (_args, options) => {
      options.stdout("result\n")
    })
    await main(host)
    expect(serve.mock.calls[0]![0]).toContain("--workspace=/fixture")
    expect(serve.mock.calls[0]![0]).not.toContain("--root")
    expect(result).toEqual({ stdout: "result\n", stderr: "", codes: [0] })
    clean(signals)
  })

  it("anchors relative PATH entries to the launch directory before constructing commands", async () => {
    // `pnpm exec` prepends `./node_modules/.bin`; action-backed targets refuse a relative entry.
    const launch = resolve("/launch")
    const absolute = resolve("/usr/bin")
    const env = { PATH: ["./node_modules/.bin", "", absolute].join(delimiter) }
    const { host, signals } = fixture(["targets", "--json"], env)
    let planned: string | undefined
    makeCli.mockImplementation((runtime: RuntimeConfig) => {
      planned = runtime.environment?.["PATH"]
      return { serve }
    })
    await main({ ...host, cwd: launch })
    const anchored = [join(launch, "node_modules", ".bin"), absolute].join(delimiter)
    expect(planned).toBe(anchored)
    expect(env.PATH).toBe(anchored)
    clean(signals)
  })

  it("does not overwrite a failed command with a later success", async () => {
    const { host, signals, result } = fixture()
    serve.mockImplementation(async (_args, options) => {
      config().exit?.(3)
      options.exit(0)
    })
    await main(host)
    expect(result.codes).toEqual([3, 3, 3])
    clean(signals)
  })

  it.each([new Error("Authorization: Bearer fixture-private-token"), "Authorization: Bearer fixture-private-token"])(
    "redacts thrown failures and cleans listeners (%s)",
    async (failure) => {
      const { host, signals, result } = fixture()
      serve.mockRejectedValue(failure)
      await main(host)
      expect(result.codes.at(-1)).toBe(1)
      expect(result.stderr).toBe(
        failure instanceof Error
          ? "Authorization: Bearer [REDACTED_TOKEN]\n"
          : "Something went wrong on our side. Not your fault.\n"
      )
      expect(result.stderr).not.toContain("fixture-private-token")
      clean(signals)
    }
  )

  it.each([
    new Error("sshpass -p ZqSynthetic7Secret4Value9 ssh host"),
    new Error("Authorization: Token ZqSynthetic7Secret4Value9")
  ])("redacts diagnostic credential spellings from thrown failures (%s)", async (failure) => {
    const { host, signals, result } = fixture()
    serve.mockRejectedValue(failure)
    await main(host)
    expect(result.stderr).toContain("[REDACTED]")
    expect(result.stderr).not.toContain("ZqSynthetic7Secret4Value9")
    expect(result.codes.at(-1)).toBe(1)
    clean(signals)
  })

  it.each([false, true])("keeps generic defaults and redacts explicit verbose diagnostics (%s)", async (verbose) => {
    const { host, signals, result } = fixture(verbose ? ["--help", "--verbose"] : ["--help"])
    serve.mockRejectedValue(new TypeError("sshpass -p ZqSynthetic7Secret4Value9 ssh host"))
    await main(host)
    expect(result.stderr).toContain("Something went wrong on our side. Not your fault.")
    expect(result.stderr).not.toContain("ZqSynthetic7Secret4Value9")
    if (verbose) expect(result.stderr).toContain("sshpass -p [REDACTED] ssh host")
    else expect(result.stderr).not.toContain("sshpass")
    expect(result.codes.at(-1)).toBe(1)
    clean(signals)
  })

  it("refuses invalid presentation configuration without constructing commands", async () => {
    const { host, signals, result } = fixture(["--help"], { SMITHERS_AUDIENCE: "unknown" })
    await main(host)
    expect(makeCli).not.toHaveBeenCalled()
    expect(result.codes.at(-1)).toBe(1)
    expect(result.stderr).toContain("SMITHERS_AUDIENCE")
    clean(signals)
  })

  it.each([["SIGINT", 130], ["SIGTERM", 143]] as const)(
    "owns %s during delivery, aborts work and preserves exit %i",
    async (signal, code) => {
      const { host, signals, result } = fixture()
      let observed = 0
      const backstop = () => {
        observed = signals.listenerCount(signal)
      }
      serve.mockImplementation(async (_args, options) => {
        signals.on(signal, backstop)
        signals.emit(signal)
        expect(observed).toBe(2)
        expect(config().signal?.aborted).toBe(true)
        expect(String(config().signal?.reason)).toContain(signal)
        await Promise.resolve()
        expect(signals.listenerCount(signal)).toBe(1)
        signals.removeListener(signal, backstop)
        options.exit(0)
        throw new Error("interrupted operation")
      })
      await main(host)
      expect(result.codes.every((status) => status === code)).toBe(true)
      expect(result.codes.at(-1)).toBe(code)
      expect(result.stderr).toBe("")
      clean(signals)
    }
  )

  it("keeps MCP alive for disconnect without letting tool failures terminate the server", async () => {
    const { host, signals, result } = fixture(["--mcp"])
    const disconnect = vi.fn(async (signal: AbortSignal) => {
      expect(signal).toBe(config().signal)
      expect(signal.aborted).toBe(false)
      expect(result.codes).toEqual([])
      signals.emit("SIGTERM")
      expect(signal.aborted).toBe(true)
    })
    serve.mockImplementation(async () => {
      config().exit?.(1)
    })
    await main({ ...host, waitForDisconnect: disconnect })
    expect(disconnect).toHaveBeenCalledTimes(1)
    expect(result.codes.at(-1)).toBe(143)
    clean(signals)
  })

  it("supports an MCP host without a disconnect hook", async () => {
    const { host, signals, result } = fixture(["--mcp"])
    await main(host)
    expect(result.codes).toEqual([0])
    clean(signals)
  })
})

it.each([[[]], [["--environment", "dev"]]])("lets an interactive TUI own Ctrl+C (%j)", async (extra) => {
  const { host, signals, result } = fixture(["tui", ...extra])
  serve.mockImplementation(async (_args, options) => {
    signals.emit("SIGINT")
    expect(config().signal?.aborted).toBe(false)
    expect(result.codes).toEqual([])
    signals.emit("SIGTERM")
    expect(config().signal?.aborted).toBe(true)
    options.exit(0)
  })
  await main(host)
  expect(result.codes.at(-1)).toBe(143)
  clean(signals)
})

it("keeps TUI print mode cancellable", async () => {
  const { host, signals, result } = fixture(["tui", "--environment", "dev", "-p", "hello"])
  serve.mockImplementation(async () => {
    signals.emit("SIGINT")
    expect(config().signal?.aborted).toBe(true)
  })
  await main(host)
  expect(result.codes.at(-1)).toBe(130)
  clean(signals)
})

it.each([
  ["--ui", "plain"],
  ["--ui=plain"],
  ["--audience", "human"],
  ["--help"]
])("preserves interactive TUI Ctrl+C after global prefix %j", async (...prefix) => {
  const { host, signals, result } = fixture([...prefix, "tui", "--environment", "dev"])
  serve.mockImplementation(async (_args, options) => {
    signals.emit("SIGINT")
    expect(config().signal?.aborted).toBe(false)
    expect(result.codes).toEqual([])
    options.exit(0)
  })
  await main(host)
  expect(result.codes.at(-1)).toBe(0)
  clean(signals)
})

it("constructs once and gives selected command arities authority over transport and presentation", async () => {
  const cli = Cli.create("fixture").command("issue", { options: z.object({ title: z.string() }), run: () => undefined })
  cli.serve = serve
  makeCli.mockReturnValue(cli)
  const { host, signals, result } = fixture(["issue", "--title", "--mcp"])
  const disconnect = vi.fn()
  await main({ ...host, waitForDisconnect: disconnect })
  expect(makeCli).toHaveBeenCalledTimes(1)
  expect(config().presentation?.source).toBe("pipe")
  expect(serve.mock.calls[0]![0]).toContain("--title=--mcp")
  expect(serve.mock.calls[0]![0]).not.toContain("--mcp")
  expect(disconnect).not.toHaveBeenCalled()
  expect(result.codes).toEqual([0])
  clean(signals)
})

it.each([["--no-mcp"], ["--mcp=false"], ["--mcp", "false"], ["--mcp=maybe"], ["--", "--mcp"]])(
  "does not wait for MCP disconnect for non-transport spelling %j",
  async (...argv) => {
    const { host, signals } = fixture(argv)
    const disconnect = vi.fn()
    await main({ ...host, waitForDisconnect: disconnect })
    expect(config().presentation?.source).not.toBe("mcp")
    expect(disconnect).not.toHaveBeenCalled()
    clean(signals)
  }
)
