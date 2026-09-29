/**
 * What a command's output costs to capture.
 *
 * `Exec` buffers, and a buffer with no bound is the whole of what a process
 * decided to print. The shell flows then display thirty kilobytes of it, so an
 * unbounded capture pays for gigabytes to show a page. `maxCaptureBytes` is the
 * bound, and these cases run a real process through the real spawner because a
 * fake one would record the option rather than produce the bytes.
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Bash from "../src/Bash.ts"
import * as Container from "../src/Container.ts"
import * as Exec from "../src/internal/Exec.ts"

const host = Layer.provide(
  NodeChildProcessSpawner.layer,
  Layer.merge(NodeFileSystem.layer, Path.layer)
)

/** Prints `text` with no trailing newline, whatever characters it holds. */
const print = (text: string): string => `node -e ${JSON.stringify(`process.stdout.write(${JSON.stringify(text)})`)}`

describe.skipIf(process.platform === "win32")("Exec capture", () => {
  it.live.each([
    {
      interpreter: "bash",
      script: "printf \"stdin:%s|%s|%s\" \"$1\" \"$2\" \"$3\"",
      args: ["-c", "printf wrong", ""],
      expected: "stdin:-c|printf wrong|"
    },
    {
      interpreter: "node",
      script: "process.stdout.write('stdin:' + process.argv.slice(2).join('|'))",
      args: ["ordinary", "-x", ""],
      expected: "stdin:ordinary|-x|"
    }
  ])(
    "runs the stdin program with exact $interpreter arguments",
    ({ interpreter, script, args, expected }) =>
      Effect.gen(function*() {
        const result = yield* Bash.run({ mode: "unhermetic", interpreter, script, args })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(expected)
      }).pipe(Effect.provide(Layer.merge(host, Path.layer)))
  )

  it.live.each([
    {
      interpreter: "bash",
      script: "printf \"stdin:%s|%s|%s\" \"$1\" \"$2\" \"$3\"",
      args: ["-c", "printf wrong", ""],
      expected: "stdin:-c|printf wrong|"
    },
    {
      interpreter: "node",
      script: "process.stdout.write('stdin:' + process.argv.slice(2).join('|'))",
      args: ["ordinary", "-x", ""],
      expected: "stdin:ordinary|-x|"
    }
  ])(
    "routes $interpreter stdin and exact arguments through the container wrapper",
    ({ interpreter, script, args, expected }) =>
      Effect.gen(function*() {
        const result = yield* Bash.run({ mode: "unhermetic", container: "local", interpreter, script, args })
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toBe(expected)
      }).pipe(Effect.provide(Layer.mergeAll(
        host,
        Path.layer,
        Layer.succeed(
          Container.Container,
          Container.make({
            exec: (request) => Effect.succeed({ file: request.file, args: request.args })
          })
        )
      )))
  )

  for (const tool of ["Exec", "Bash"] as const) {
    for (const declared of [false, true]) {
      it.live(`${tool} filters the parent environment with declared env=${declared}`, () =>
        Effect.gen(function*() {
          const inherited = {
            ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
            GH_TOKEN: process.env["GH_TOKEN"],
            OPENAI_API_KEY: process.env["OPENAI_API_KEY"]
          }
          process.env["ANTHROPIC_API_KEY"] = "ambient-anthropic"
          process.env["GH_TOKEN"] = "ambient-github"
          process.env["OPENAI_API_KEY"] = "ambient-openai"
          const options = declared ? { env: { SMITHERS_EXPLICIT: "visible" } } : {}
          const result = yield* Effect.gen(function*() {
            return tool === "Exec"
              ? yield* Exec.exec("printenv", options)
              : yield* Bash.run({ mode: "unhermetic", command: "printenv", ...options })
          }).pipe(
            Effect.ensuring(Effect.sync(() => {
              for (const [name, value] of Object.entries(inherited)) {
                if (value === undefined) delete process.env[name]
                else process.env[name] = value
              }
            }))
          )
          const environment = Object.fromEntries(
            result.stdout.trim().split("\n").map((line) => {
              const separator = line.indexOf("=")
              return [line.slice(0, separator), line.slice(separator + 1)]
            })
          )
          expect(environment.PATH).toBe(process.env.PATH)
          expect(environment.SMITHERS_EXPLICIT).toBe(declared ? "visible" : undefined)
          for (const name of Object.keys(inherited)) expect(environment).not.toHaveProperty(name)
        }).pipe(Effect.provide(Layer.merge(host, Path.layer))), 30_000)
    }
  }

  it.live("keeps every byte and drops none when no bound is given", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(print("abcdefghij"))
      expect(result.stdout).toBe("abcdefghij")
      expect(result.stdoutDroppedBytes).toBe(0)
      expect(result.stderrDroppedBytes).toBe(0)
    }).pipe(Effect.provide(host)), 30_000)

  it.live("keeps the tail and reports the bytes it dropped", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(print("abcdefghijklmnop"), { maxCaptureBytes: 10 })
      expect(result.stdout).toBe("ghijklmnop")
      expect(result.stdoutDroppedBytes).toBe(6)
    }).pipe(Effect.provide(host)), 30_000)

  it.live("bounds a stream far larger than the bound", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(
        `node -e "process.stdout.write('x'.repeat(2000000) + 'END')"`,
        { maxCaptureBytes: 64 }
      )
      expect(result.stdout.length).toBe(64)
      expect(result.stdout.endsWith("END")).toBe(true)
      expect(result.stdoutDroppedBytes).toBe(2_000_003 - 64)
    }).pipe(Effect.provide(host)), 30_000)

  it.live("never decodes a cut code point into a replacement character", () =>
    Effect.gen(function*() {
      // Nine two-byte characters, cut at an odd byte count: the retained head
      // of the tail is one continuation byte, which is skipped rather than
      // decoded as U+FFFD, so the count says 12 dropped bytes and not 11.
      const result = yield* Exec.exec(print("é".repeat(9)), { maxCaptureBytes: 7 })
      expect(result.stdout).toBe("ééé")
      expect(result.stdout).not.toContain("�")
      expect(result.stdoutDroppedBytes).toBe(12)
    }).pipe(Effect.provide(host)), 30_000)

  it.live("bounds stderr on the same terms as stdout", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(
        `node -e "process.stderr.write('abcdefghijklmnop')"`,
        { maxCaptureBytes: 4 }
      )
      expect(result.stderr).toBe("mnop")
      expect(result.stderrDroppedBytes).toBe(12)
    }).pipe(Effect.provide(host)), 30_000)
})

describe("Exec refuses partial capture", () => {
  for (const stream of ["stdout", "stderr"] as const) {
    it.live(`refuses overflowing ${stream}`, () =>
      Effect.gen(function*() {
        const error = yield* Effect.flip(Exec.exec(process.execPath, {
          args: ["-e", `process.${stream}.write('abcde')`],
          maxCaptureBytes: 4,
          overflow: "refuse"
        }))
        expect(error.code).toBe("capture_overflow")
        expect(error.message).toContain(stream)
      }).pipe(Effect.provide(host)))
  }

  it.live("accepts exactly the bound in both streams", () =>
    Effect.gen(function*() {
      const result = yield* Exec.exec(process.execPath, {
        args: ["-e", "process.stdout.write('éé'); process.stderr.write('abcd')"],
        maxCaptureBytes: 4,
        overflow: "refuse"
      })
      expect(result).toMatchObject({ stdout: "éé", stderr: "abcd", stdoutDroppedBytes: 0, stderrDroppedBytes: 0 })
    }).pipe(Effect.provide(host)))
})

/**
 * A command that never produced an exit code becomes one of two model-facing
 * failures, and the three shell flows have to agree on which. `Exec.exec`
 * fails with a typed `ExecError`, so the choice is a switch on its code rather
 * than a duck-typed read of an `unknown`.
 */
describe("Exec.toStdError", () => {
  it("keeps a timeout's own code and names the command", () => {
    const error = new Exec.ExecError({ code: "timeout", message: "exec: `pytest -q` exceeded 5ms" })
    expect(Exec.toStdError("pytest -q", error)).toMatchObject({
      code: "timeout",
      message: "Command timed out: pytest -q"
    })
  })

  for (const code of ["spawn_error", "capture_overflow"] as const) {
    it(`reports ${code} as a host failure carrying the exec message`, () => {
      const error = new Exec.ExecError({ code, message: "boom" })
      expect(Exec.toStdError("pytest -q", error)).toMatchObject({
        code: "command_failed",
        message: "Command failed to start: boom"
      })
    })
  }

  for (
    const { code, expected } of [
      { code: "timeout", expected: "timeout" },
      { code: "spawn_error", expected: "command_failed" },
      { code: "capture_overflow", expected: "command_failed" }
    ] as const
  ) {
    it(`classifies ${code} as ${expected}`, () => {
      expect(Exec.toStdErrorCode(new Exec.ExecError({ code, message: "boom" }))).toBe(expected)
    })
  }
})
