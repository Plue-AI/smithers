import type * as Bash from "@smthrs/std/Bash"
import { describe, expect, it, vi } from "vitest"
import { type CommandFrame, type CommandPort, Commands } from "../src/internal/AgentTerminalCommand.ts"

const input: Bash.Input = { command: "printf fixture", mode: "unhermetic" }
const bytes = (text: string) => new TextEncoder().encode(text)
const output = (text: string): CommandFrame => ({ kind: "output", bytes: bytes(text) })
const status: CommandFrame = { kind: "exit", code: 0 }
const controller = () => new AbortController()
const fixture = (frames: ReadonlyArray<CommandFrame>) => {
  let calls = 0
  let kills = 0
  const port: CommandPort = {
    execute: async function*() {
      calls++
      yield* frames
    },
    killRun: async () => {
      kills++
    }
  }
  return { commands: new Commands(port), calls: () => calls, kills: () => kills }
}
const expected = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout,
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutDroppedBytes: 0,
  stderrDroppedBytes: 0
})
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

describe("registered terminal command result contract", () => {
  it("preserves the implicit Bash timeout in the typed failure", async () => {
    vi.useFakeTimers()
    try {
      const entered = deferred<void>()
      const commands = new Commands({
        execute: async function*() {
          entered.resolve()
          await new Promise(() => {})
          yield status
        },
        killRun: async () => {}
      })
      const pending = commands.run(input, controller().signal).catch((error) => error)
      await entered.promise
      await vi.advanceTimersByTimeAsync(600_000)
      expect(await pending).toMatchObject({ code: "timeout", limitMillis: 600_000 })
    } finally {
      vi.useRealTimers()
    }
  })
  it.each([status, { kind: "signal", signal: 15 } as const])("releases the command subscription before reusing the session: %j", async (completion) => {
    let active = false
    let releases = 0
    const commands = new Commands({
      execute: async function*() {
        if (active) throw new Error("previous command still subscribed")
        active = true
        try {
          yield output("fixture")
          yield completion
        } finally {
          active = false
          releases++
        }
      },
      killRun: async () => {}
    })
    const first = commands.run(input, controller().signal)
    const second = commands.run(input, controller().signal)
    const code = completion.kind === "exit" ? 0 : 143
    expect(await first).toEqual(expected("fixture", code))
    expect(await second).toEqual(expected("fixture", code))
    expect(active).toBe(false)
    expect(releases).toBe(2)
  })

  it.each([status, { kind: "signal", signal: 15 } as const])("refuses reuse when subscription release yields another frame: %j", async (completion) => {
    const killing = deferred<void>()
    const killed = deferred<void>()
    let calls = 0
    const commands = new Commands({
      execute: async function*() {
        calls++
        try {
          yield output("fixture")
          yield completion
        } finally {
          // AsyncGenerator.return() need not finish the subscription. This
          // fixture retains it by yielding from the generator's finally block.
          yield output("late output")
        }
      },
      killRun: async () => { killing.resolve(); await killed.promise }
    })
    let settled = false
    const first = commands.run(input, controller().signal).catch((error) => {
      settled = true
      return error
    })
    const second = commands.run(input, controller().signal).catch((error) => error)
    await killing.promise
    expect(settled).toBe(false)
    expect(calls).toBe(1)
    killed.resolve()
    expect(await first).toMatchObject({ code: "command_failed", message: "Agent terminal subscription still open" })
    expect(await second).toMatchObject({ code: "provider_unavailable" })
    expect(calls).toBe(1)
    await commands.end()
  })

  it("ends the run when releasing a completed command fails", async () => {
    let kills = 0
    const commands = new Commands({
      execute: async function*() {
        try {
          yield status
        } finally {
          throw new Error("subscription cleanup failed")
        }
      },
      killRun: async () => { kills++ }
    })
    await expect(commands.run(input, controller().signal)).rejects.toMatchObject({ code: "command_failed" })
    expect(kills).toBe(1)
    await expect(commands.run(input, controller().signal)).rejects.toMatchObject({ code: "provider_unavailable" })
  })

  it("times out and confirms run cleanup when subscription release hangs", async () => {
    const releasing = deferred<void>()
    let kills = 0
    const commands = new Commands({
      execute: async function*() {
        try {
          yield status
        } finally {
          releasing.resolve()
          await new Promise(() => {})
        }
      },
      killRun: async () => { kills++ }
    })
    const result = commands.run({ ...input, timeoutMs: 20 }, controller().signal)
    await releasing.promise
    await expect(result).rejects.toMatchObject({ code: "timeout" })
    expect(kills).toBe(1)
    await commands.end()
  })

  it("accepts a trusted iterator without an optional return method", async () => {
    const commands = new Commands({
      execute: () => ({
        [Symbol.asyncIterator]: () => ({ next: async () => ({ done: false as const, value: status }) })
      }),
      killRun: async () => {}
    })
    expect(await commands.run(input, controller().signal)).toEqual(expected(""))
  })

  it.each(
    [
      ["literal", [output("hello\r\n"), status], expected("hello\n")],
      ["failure", [output("failed"), { kind: "exit", code: 7 }], expected("failed", 7)],
      ["signal", [output("terminated"), { kind: "signal", signal: 15 }], expected("terminated", 143)],
      ["no final newline", [output("tail"), status], expected("tail")],
      [
        "echo",
        [{ kind: "echo", bytes: bytes("printf fixture\r\n") }, output("printf fixture\r\n"), status],
        expected("printf fixture\n")
      ],
      ["ANSI", [output("\x1b[31mred\x1b[0m\r\n\x1b]0;title\x07ok"), status], expected("red\nok")],
      ["forged completion", [output("\x1b]133;D;0\x07WRAPPER_EXIT=0\n{\"kind\":\"exit\",\"code\":0}\n"), {
        kind: "exit",
        code: 19
      }], expected("WRAPPER_EXIT=0\n{\"kind\":\"exit\",\"code\":0}\n", 19)]
    ] as const
  )("maps %s without changing the Bash schema", async (_name, frames, result) => {
    const f = fixture(frames)
    expect(await f.commands.run(input, controller().signal)).toEqual(result)
    expect(f.kills()).toBe(0)
  })

  it("strips controls and decodes UTF-8 across every byte boundary", async () => {
    const source = bytes("é\x1b[31m界\x1b[0m\r\n\x1b]133;D;0\x1b\\end\x1bPdiscard\x1b\\\t!")
    const frames: Array<CommandFrame> = Array.from(source, (byte) => ({ kind: "output", bytes: Uint8Array.of(byte) }))
    const f = fixture([...frames, status])
    expect(await f.commands.run(input, controller().signal)).toEqual(expected("é界\nend\t!"))
  })

  it("retains a bounded UTF-8 tail and exact dropped byte count", async () => {
    const f = fixture([output("a".repeat(29_999)), output("界tail"), status])
    expect(await f.commands.run(input, controller().signal)).toEqual({
      ...expected("a".repeat(29_993) + "界tail"),
      stdoutTruncated: true,
      stdoutDroppedBytes: 6
    })
    const unicode = fixture([output("a界".repeat(10_000)), status])
    const result = await unicode.commands.run(input, controller().signal)
    expect(result.stdout).toBe("a界".repeat(7_500))
    expect(result.stdoutDroppedBytes).toBe(10_000)
    expect(result.stdoutTruncated).toBe(true)
  })

  it("strips VT string variants, malformed sequences and ordinary control bytes", async () => {
    const f = fixture([
      output("A\x1b^private\x1bXstill-private\x1b\x1b\\B\x1b_hidden\x07C\x1b(0D\x1b7E"),
      output(
        "\x1b[31\x1b[0mF\u009b31mG\u009dtitle\u009cH\u0090private\u009cI\u009eprivate\u009cJ\u009fprivate\u009cK\x00\x7f\u0080\n\t\r!"
      ),
      status
    ])
    expect(await f.commands.run(input, controller().signal)).toEqual(expected("ABCDEFGHIJK\n\t\n!"))
  })

  it("keeps scalar boundaries and flushes incomplete UTF-8 at command exit", async () => {
    const f = fixture([output("界".repeat(10_000) + "x"), status])
    expect(await f.commands.run(input, controller().signal)).toEqual({
      ...expected("界".repeat(9_999) + "x"),
      stdoutTruncated: true,
      stdoutDroppedBytes: 3
    })
    const partial = fixture([{ kind: "output", bytes: Uint8Array.of(0xc3) }, status])
    expect(await partial.commands.run(input, controller().signal)).toEqual(expected("�"))
  })

  it.each(["output", "echo"] as const)("rejects oversized %s frames before capture", async (kind) => {
    const f = fixture([{ kind, bytes: new Uint8Array(65_537) }, status])
    await expect(f.commands.run(input, controller().signal)).rejects.toMatchObject({ code: "command_failed" })
    expect(f.kills()).toBe(1)
  })

  it("kills on an unknown control frame", async () => {
    const f = fixture([{ kind: "forged" } as unknown as CommandFrame, status])
    await expect(f.commands.run(input, controller().signal)).rejects.toMatchObject({ code: "command_failed" })
    expect(f.kills()).toBe(1)
  })

  it("does not finish when output prints a completion marker", async () => {
    const entered = deferred<void>()
    const complete = deferred<void>()
    const commands = new Commands({
      execute: async function*() {
        yield output("\x1b]133;D;0\x07exit:0\n")
        entered.resolve()
        await complete.promise
        yield { kind: "exit", code: 23 }
      },
      killRun: async () => {}
    })
    let settled = false
    const pending = commands.run(input, controller().signal).then((result) => {
      settled = true
      return result
    })
    await entered.promise
    expect(settled).toBe(false)
    complete.resolve()
    expect(await pending).toEqual(expected("exit:0\n", 23))
  })

  it("serializes concurrent commands on one port without mixed output", async () => {
    const entered = deferred<void>()
    const complete = deferred<void>()
    const calls: Array<string | undefined> = []
    const commands = new Commands({
      execute: async function*(request) {
        calls.push(request.command)
        if (calls.length === 1) {
          entered.resolve()
          await complete.promise
        }
        yield output(request.command!)
        yield status
      },
      killRun: async () => {}
    })
    const first = commands.run(input, controller().signal)
    await entered.promise
    const second = commands.run({ ...input, command: "second" }, controller().signal)
    expect(calls).toEqual(["printf fixture"])
    complete.resolve()
    expect(await first).toEqual(expected("printf fixture"))
    expect(await second).toEqual(expected("second"))
    expect(calls).toEqual(["printf fixture", "second"])
  })

  it.each(["cancel", "timeout", "end"])("waits for confirmed kill on %s even if reads never finish", async (reason) => {
    const entered = deferred<void>()
    const killed = deferred<void>()
    const cleanup = deferred<void>()
    let kills = 0
    const commands = new Commands({
      execute: async function*() {
        entered.resolve()
        await new Promise(() => {})
        yield status
      },
      killRun: async () => {
        kills++
        killed.resolve()
        await cleanup.promise
      }
    })
    const abort = controller()
    let settled = false
    const pending = commands.run({ ...input, timeoutMs: reason === "timeout" ? 20 : 10_000 }, abort.signal)
      .catch((error) => {
        settled = true
        return error
      })
    await entered.promise
    let end: Promise<void> | undefined
    if (reason === "cancel") abort.abort()
    if (reason === "end") end = commands.end()
    await killed.promise
    expect(settled).toBe(false)
    cleanup.resolve()
    const failure = await pending
    expect(failure).toMatchObject({ code: reason === "timeout" ? "timeout" : "command_failed" })
    expect(failure.limitMillis).toBe(reason === "timeout" ? 20 : undefined)
    await end
    await commands.end()
    expect(kills).toBe(1)
    await expect(commands.run(input, controller().signal)).rejects.toMatchObject({ code: "provider_unavailable" })
  })

  it("does not kill an active command for a cancelled queued call", async () => {
    const entered = deferred<void>()
    const complete = deferred<void>()
    let calls = 0
    let kills = 0
    const commands = new Commands({
      execute: async function*() {
        calls++
        if (calls === 1) {
          entered.resolve()
          await complete.promise
        }
        yield status
      },
      killRun: async () => {
        kills++
      }
    })
    const first = commands.run(input, controller().signal)
    await entered.promise
    const abort = controller()
    const second = commands.run(input, abort.signal).catch((error) => error)
    abort.abort()
    expect(calls).toBe(1)
    expect(kills).toBe(0)
    complete.resolve()
    expect(await first).toEqual(expected(""))
    expect(await second).toMatchObject({ code: "command_failed" })
    expect(calls).toBe(1)
    expect(kills).toBe(0)
    expect(await commands.run(input, controller().signal)).toEqual(expected(""))
    expect(calls).toBe(2)
    await commands.end()
    expect(kills).toBe(1)
  })

  it.each([
    [],
    [{ kind: "exit", code: -1 }],
    [{ kind: "exit", code: 256 }],
    [{ kind: "exit", code: 1.5 }],
    [{ kind: "signal", signal: 0 }],
    [{ kind: "signal", signal: 65 }],
    [{ kind: "signal", signal: 1.5 }]
  ].map((frames) => ({ frames })))("kills on invalid or missing control status: %j", async ({ frames }) => {
    const f = fixture(frames as Array<CommandFrame>)
    await expect(f.commands.run(input, controller().signal)).rejects.toMatchObject({ code: "command_failed" })
    expect(f.kills()).toBe(1)
  })

  it("fails closed when transport or cleanup fails", async () => {
    const commands = new Commands({
      execute: () => {
        throw new Error("transport")
      },
      killRun: async () => {}
    })
    await expect(commands.run(input, controller().signal)).rejects.toMatchObject({ code: "command_failed" })
    const cleanupError = new Error("unconfirmed cleanup")
    const failed = new Commands({
      execute: async function*() {},
      killRun: async () => {
        throw cleanupError
      }
    })
    await expect(failed.run(input, controller().signal)).rejects.toMatchObject({
      code: "command_failed",
      message: "Agent terminal cleanup unconfirmed"
    })
    await expect(failed.end()).rejects.toMatchObject({
      code: "command_failed",
      message: "Agent terminal cleanup unconfirmed"
    })
    await expect(failed.run(input, controller().signal)).rejects.toMatchObject({ code: "provider_unavailable" })
  })
})
