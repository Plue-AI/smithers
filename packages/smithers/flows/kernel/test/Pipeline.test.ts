import { describe, expect, it } from "@effect/vitest"
import * as Permission from "@smthrs/capability/Permission"
import { Effect, Exit, Layer, Path, Sink, Stream } from "effect"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner, ExitCode, make, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import * as GuardedSpawner from "../src/ChildProcessSpawner.ts"
import * as ContainedSpawner from "../src/ContainedSpawner.ts"
import { emptyPolicy as closedPolicy } from "../src/GrantStore.ts"
import { GrantStore } from "../src/GrantStore.ts"
import * as ProcessConfinement from "../src/ProcessConfinement.ts"
import * as ProcessLedger from "../src/ProcessLedger.ts"
import * as Workspace from "../src/Workspace.ts"

const bytes = (text: string) => Stream.make(new TextEncoder().encode(text))
const textOf = (stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>) =>
  stream.pipe(Stream.decodeText(), Stream.mkString)

const fixture = (failures: ReadonlyArray<string> = []) => {
  const commands: Array<ChildProcess.StandardCommand> = []
  const events: Array<string> = []
  const errors = new Map<string, PlatformError.PlatformError>()
  const host = Layer.succeed(ChildProcessSpawner)(make((command) =>
    Effect.sync(() => {
      if (command._tag !== "StandardCommand") throw new Error("a pipeline escaped per-leg containment")
      commands.push(command)
      const name = command.command
      const error = PlatformError.systemError({
        _tag: "Unknown",
        module: "ChildProcess",
        method: "kill",
        description: name
      })
      errors.set(name, error)
      return makeHandle({
        pid: ProcessId(4300 + commands.length),
        exitCode: Effect.succeed(ExitCode(commands.length)),
        isRunning: Effect.succeed(false),
        kill: () =>
          Effect.suspend(() => {
            events.push(`kill:${name}`)
            return failures.includes(name) ? Effect.fail(error) : Effect.void
          }),
        stdin: Sink.drain,
        stdout: bytes(`out:${name}`),
        stderr: bytes(`err:${name}`),
        all: bytes(`all:${name}`),
        getInputFd: () => Sink.drain,
        getOutputFd: (fd) => bytes(`fd${fd}:${name}`),
        unref: Effect.sync(() => {
          events.push(`unref:${name}`)
          return Effect.sync(() => {
            events.push(`reref:${name}`)
          })
        })
      })
    })
  ))
  const layer = ContainedSpawner.layer().pipe(
    Layer.provide(host),
    Layer.provide(ProcessLedger.layerMemory({ hostId: "pipeline", ownerPid: 7 }))
  )
  return { commands, events, errors, layer }
}

describe("contained pipeline wiring", () => {
  for (const denied of [undefined, "first", "last"] as const) {
    const allowed = denied === undefined
    it.effect(`authorizes every pipeline leg before spawning either (denied=${denied ?? "none"})`, () => {
      const test = fixture()
      const checks: Array<string> = []
      const store = GrantStore.of({
        policy: closedPolicy,
        check: (capability) => {
          checks.push(capability.resource)
          return capability.resource !== denied
            ? Effect.void
            : Effect.fail(Permission.permissionDenied(capability, "pipeline not approved"))
        },
        reply: () => Effect.void,
        list: Effect.succeed([]),
        grantEnvelope: () => Effect.void
      })
      return Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const result = yield* Effect.exit(
          spawner.spawn(ChildProcess.pipeTo(ChildProcess.make("first"), ChildProcess.make("last")))
        )
        expect(Exit.isSuccess(result)).toBe(allowed)
        expect(checks).toEqual(denied === "first" ? ["first"] : ["first", "last"])
        expect(test.commands.map((command) => command.command)).toEqual(allowed ? ["first", "last"] : [])
      }).pipe(
        Effect.provide(
          GuardedSpawner.layer.pipe(
            Layer.provide(ProcessConfinement.layerNoop),
            Layer.provide([Workspace.layerNoop, Path.layer])
          )
        ),
        Effect.provide(test.layer),
        Effect.provideService(GrantStore, store),
        Effect.scoped
      )
    })
  }

  for (const from of [undefined, "stdout", "stderr", "all", "fd5", "invalid"] as const) {
    for (const to of [undefined, "stdin", "fd7", "invalid"] as const) {
      it.effect(`routes ${from ?? "default"} to ${to ?? "default"} through distinct recorded legs`, () => {
        const test = fixture()
        return Effect.gen(function*() {
          const spawner = yield* ChildProcessSpawner
          const command = ChildProcess.pipeTo(
            ChildProcess.make("first"),
            ChildProcess.make("second", [], { stdin: { stream: "pipe", endOnDone: false, encoding: "utf8" } }),
            { from: from as ChildProcess.PipeFromOption, to: to as ChildProcess.PipeToOption }
          )
          const handle = yield* spawner.spawn(command)
          expect(handle.pid).toBe(4302)
          expect(yield* handle.exitCode).toBe(2)
          expect(yield* textOf(handle.stdout)).toBe("out:second")
          const second = test.commands[1]!
          const input = to === "fd7" ? second.options.additionalFds?.fd7 : second.options.stdin
          expect(typeof input).toBe("object")
          const stream = (input as { readonly stream: Stream.Stream<Uint8Array, PlatformError.PlatformError> }).stream
          const prefix = from === "stderr" ? "err" : from === "all" ? "all" : from === "fd5" ? "fd5" : "out"
          expect(yield* textOf(stream)).toBe(`${prefix}:first`)
          if (to !== "fd7") expect(input).toMatchObject({ endOnDone: false, encoding: "utf8" })
        }).pipe(Effect.provide(test.layer), Effect.scoped)
      })
    }
  }

  it.effect("feeds the first leg of a nested destination and preserves unrelated fds", () => {
    const test = fixture()
    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      yield* spawner.spawn(ChildProcess.pipeTo(
        ChildProcess.make("first"),
        ChildProcess.pipeTo(
          ChildProcess.make("middle", [], { additionalFds: { fd9: { type: "output" } } }),
          ChildProcess.make("last", [], { stdin: bytes("replaced") })
        ),
        { from: "stderr", to: "fd7" }
      ))
      expect(test.commands.map((command) => command.command)).toEqual(["first", "middle", "last"])
      expect(test.commands[1]!.options.additionalFds?.fd9).toEqual({ type: "output" })
      const fd = test.commands[1]!.options.additionalFds?.fd7 as {
        stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>
      }
      expect(yield* textOf(fd.stream)).toBe("err:first")
      const stdin = test.commands[2]!.options.stdin as {
        stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>
      }
      expect(yield* textOf(stdin.stream)).toBe("out:middle")
    }).pipe(Effect.provide(test.layer), Effect.scoped)
  })

  for (const failures of [[], ["first"], ["last"], ["first", "last"]]) {
    it.effect(`attempts every leg in reverse order and reports failures ${failures.join(",")}`, () => {
      const test = fixture(failures)
      return Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const handle = yield* spawner.spawn(ChildProcess.pipeTo(ChildProcess.make("first"), ChildProcess.make("last")))
        const exit = yield* Effect.exit(handle.kill())
        expect(test.events).toEqual(["kill:last", "kill:first"])
        if (failures.length === 0) expect(Exit.isSuccess(exit)).toBe(true)
        else {
          const error = yield* Effect.flip(handle.kill())
          expect(error).toBe(test.errors.get(failures.includes("last") ? "last" : "first"))
        }
      }).pipe(Effect.provide(test.layer), Effect.scoped)
    })
  }

  it.effect("unrefs in start order and rerefs in reverse order", () => {
    const test = fixture()
    return Effect.gen(function*() {
      const spawner = yield* ChildProcessSpawner
      const handle = yield* spawner.spawn(ChildProcess.pipeTo(
        ChildProcess.pipeTo(ChildProcess.make("first"), ChildProcess.make("middle", [], { stdin: "ignore" })),
        ChildProcess.make("last")
      ))
      const reref = yield* handle.unref
      yield* reref
      expect(test.events).toEqual([
        "unref:first",
        "unref:middle",
        "unref:last",
        "reref:last",
        "reref:middle",
        "reref:first"
      ])
    }).pipe(Effect.provide(test.layer), Effect.scoped)
  })
})
