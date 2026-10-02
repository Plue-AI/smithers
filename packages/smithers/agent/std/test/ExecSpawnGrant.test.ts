/**
 * A `proc:spawn` grant for a command does not cover that command run with a
 * model-supplied environment that changes which program or configuration it
 * loads. `Exec` overlays the declared env last, so a declared `PATH` or `HOME`
 * wins over the ambient one; the kernel spawner must name it in the resource.
 * This runs the real `Exec`, the real kernel spawner, and the real unattended
 * `GrantStore`; only the host spawner is a recording double.
 */
import { describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as ProcessConfinement from "@smthrs/kernel/ProcessConfinement"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Layer, Path, Sink, Stream } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import {
  ChildProcessSpawner as HostChildProcessSpawner,
  ExitCode,
  make as makeSpawner,
  makeHandle,
  ProcessId
} from "effect/unstable/process/ChildProcessSpawner"
import * as Exec from "../src/internal/Exec.ts"

const spawned: Array<ChildProcess.Command> = []

const host = makeSpawner((command) =>
  Effect.sync(() => {
    spawned.push(command)
    return makeHandle({
      pid: ProcessId(1),
      exitCode: Effect.succeed(ExitCode(0)),
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      stdin: Sink.drain,
      stdout: Stream.empty,
      stderr: Stream.empty,
      all: Stream.empty,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      unref: Effect.succeed(Effect.void)
    })
  })
)

// This recording host never executes a process; test the permission boundary
// independently from the real OS confinement suites.
const guarded = KernelChildProcessSpawner.layer.pipe(
  Layer.provide(ProcessConfinement.layerNoop),
  Layer.provide(GrantStore.layer({
    attended: false,
    rules: [
      new Permission.Rule({
        effect: "allow",
        pattern: new CapabilityPattern({ action: "proc:spawn", resource: "git status" })
      })
    ]
  })),
  Layer.provide([Workspace.layer("/workspace"), Path.layer, Layer.succeed(HostChildProcessSpawner)(host)])
)

const run = (env: Record<string, string> | undefined) =>
  Effect.gen(function*() {
    spawned.length = 0
    const exit = yield* Effect.exit(Exec.exec("git status", env === undefined ? {} : { env }))
    return { exit, spawned: spawned.length }
  }).pipe(Effect.provide(guarded))

describe("Exec under a proc:spawn grant", () => {
  it.effect("runs the granted command with the inherited environment", () =>
    Effect.gen(function*() {
      const result = yield* run(undefined)
      expect(result.exit._tag).toBe("Success")
      expect(result.spawned).toBe(1)
    }))

  it.effect("refuses the granted command with a model-supplied PATH or HOME", () =>
    Effect.gen(function*() {
      for (
        const [name, env] of [["PATH", { PATH: "/workspace/evil" }], ["HOME", { HOME: "/workspace/evilhome" }]] as const
      ) {
        const result = yield* run(env)
        expect(result.exit._tag, name).toBe("Failure")
        expect(JSON.stringify(result.exit), name).toContain(`env ${name} -- git status`)
        expect(result.spawned, JSON.stringify(env)).toBe(0)
      }
    }))
})
