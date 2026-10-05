import { Effect, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as ContainedProcess from "../src/internal/ContainedProcess.ts"
import { fixture, until } from "./helpers/ContainedCommand.ts"

describe("contained process capture", () => {
  it.each([7, 8, 9])("enforces the output ceiling in bytes at %s bytes", async (size) => {
    let stdout = ""
    const pending = ContainedProcess.run({
      command: process.execPath,
      args: ["-e", `process.stdout.write(Buffer.concat([Buffer.from("é"), Buffer.alloc(${size - 2}, 120)]))`],
      cwd: process.cwd(),
      timeoutMs: 5000,
      maxOutputBytes: 8,
      stdout: (text) => {
        stdout += text
      },
      stderr: () => {}
    })
    if (size <= 8) {
      expect(await pending).toBe(0)
      expect(stdout).toBe(`é${"x".repeat(size - 2)}`)
    } else {
      await expect(pending).rejects.toMatchObject({ _tag: "smithers-build/ProcessError", code: "output_limit" })
    }
  })

  it("decodes a character split across pipe chunks", async () => {
    let stdout = ""
    expect(
      await ContainedProcess.run({
        command: process.execPath,
        args: [
          "-e",
          "process.stdout.write(Buffer.from([0xc3])); setTimeout(() => process.stdout.write(Buffer.from([0xa9])), 50)"
        ],
        cwd: process.cwd(),
        timeoutMs: 5000,
        fatalUtf8: true,
        stdout: (text) => {
          stdout += text
        },
        stderr: () => {}
      })
    ).toBe(0)
    expect(stdout).toBe("é")
  })

  it("refuses incomplete UTF-8 rather than renaming a git path", async () => {
    await expect(ContainedProcess.run({
      command: process.execPath,
      args: ["-e", "process.stdout.write(Buffer.from([0xc3]))"],
      cwd: process.cwd(),
      timeoutMs: 5000,
      fatalUtf8: true,
      stdout: () => {},
      stderr: () => {}
    })).rejects.toMatchObject({
      _tag: "smithers-build/ProcessError",
      code: "process_failed",
      cause: expect.any(TypeError)
    })
  })

  it("writes stdin and closes it, and keeps the exit status of a command that never reads it", async () => {
    let stdout = ""
    expect(
      await ContainedProcess.run({
        command: process.execPath,
        args: [
          "-e",
          "let s='';process.stdin.on('data',(c)=>s+=c).on('end',()=>{process.stdout.write(s);process.exit(4)})"
        ],
        cwd: process.cwd(),
        timeoutMs: 5000,
        stdin: "{\"revision\":\"é\"}",
        stdout: (text) => {
          stdout += text
        },
        stderr: () => {}
      })
    ).toBe(4)
    expect(stdout).toBe("{\"revision\":\"é\"}")
    expect(
      await ContainedProcess.run({
        command: process.execPath,
        args: ["-e", "process.exit(5)"],
        cwd: process.cwd(),
        timeoutMs: 5000,
        stdin: "x".repeat(1024 * 1024),
        stdout: () => {},
        stderr: () => {}
      })
    ).toBe(5)
  })
})

describe.skipIf(process.platform === "win32")("contained protocol input", () => {
  it("propagates input failure after joining the leader and resistant descendant", async () => {
    const child = await fixture({ natural: false, inheritedOutput: false })
    const failure = new Error("protocol reader failed")
    try {
      const input = Stream.fromEffect(
        Effect.promise(async () => {
          await child.ready()
          const descendant = (await child.beat())!
          expect(child.stopped(descendant)).toBe(false)
        }).pipe(Effect.andThen(Effect.fail(failure)))
      )
      await expect(ContainedProcess.run({
        command: child.argv[0],
        args: child.argv.slice(1),
        cwd: child.directory,
        input,
        timeoutMs: 15_000,
        stdout: () => {},
        stderr: () => {}
      })).rejects.toMatchObject({ code: "process_failed", cause: failure })
      const leader = await child.leader()
      const descendant = await child.beat()
      expect(leader).toBeDefined()
      expect(descendant).toBeDefined()
      expect(child.stopped(leader!)).toBe(true)
      expect(child.stopped(descendant!)).toBe(true)
    } finally {
      await child.dispose()
    }
  })

  it("cancels and joins an open input reader when the process exits", async () => {
    const child = await fixture({ natural: false, inheritedOutput: false })
    let readerStarted = false, readerReleased = false
    const controller = new AbortController()
    try {
      const input = Stream.fromEffect(
        Effect.sync(() => {
          readerStarted = true
        }).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Effect.sync(() => {
            readerReleased = true
          }))
        )
      )
      const pending = ContainedProcess.run({
        command: child.argv[0],
        args: child.argv.slice(1),
        cwd: child.directory,
        input,
        signal: controller.signal,
        timeoutMs: 15_000,
        stdout: () => {},
        stderr: () => {}
      })
      const completed = expect(pending).resolves.toBe(0)
      await child.ready()
      await until(async () => readerStarted)
      expect(readerReleased).toBe(false)
      const leader = (await child.leader())!
      const descendant = (await child.beat())!
      expect(child.stopped(leader)).toBe(false)
      expect(child.stopped(descendant)).toBe(false)
      await child.exit()
      await completed
      expect(readerReleased).toBe(true)
      expect(child.stopped(leader)).toBe(true)
      expect(child.stopped(descendant)).toBe(true)
    } finally {
      controller.abort()
      await child.dispose()
    }
  })
})
