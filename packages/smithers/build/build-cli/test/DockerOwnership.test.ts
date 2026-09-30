import * as ScopedProcess from "@smthrs/platform-node/ScopedProcess"
import { Cause, Deferred, Effect, Exit, Fiber, Scope, Sink, Stream } from "effect"
import { ExitCode, makeHandle, ProcessId } from "effect/unstable/process/ChildProcessSpawner"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as DockerExec from "../src/DockerExec.ts"
import * as PackageTree from "../src/PackageTree.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"

afterEach(() => vi.restoreAllMocks())

/**
 * Only the Docker host and process boundary are modeled. Names are exclusive,
 * IDs are immutable, exec requires a live container, and rm accepts a name or ID.
 * Acquisition, refcounts, readiness, initialization, health and scope cleanup
 * all run through the production supervisor. No clock or sleep orders the race.
 */
const dockerHost = (
  faults: {
    createCleanupFailure?: Error
    removeCleanupFailure?: Error
    createOutput?: string
    createCode?: number
    startCode?: number
    initCode?: number
    holdCreateResponse?: boolean
    /** The daemon completes the create only after a removal misses it, or when the test lands it. */
    lateCreate?: "after-missed-rm" | "manual"
  } = {}
) => {
  vi.spyOn(PackageTree, "findOnPath").mockReturnValue("/docker")
  vi.spyOn(PackageTree, "probeCommand").mockResolvedValue({ exitCode: 0, output: "fixture engine" })
  const containers = new Map<
    string,
    { id: string; pid: number; exit: Deferred.Deferred<ExitCode>; initialized: boolean }
  >()
  const commands: Array<ReadonlyArray<string>> = []
  let nextPid = 100
  let delayedPid: number | undefined
  const pendingCreates: Array<{ name: string; id: string }> = []
  const landLateCreates = () =>
    Effect.gen(function*() {
      for (const { name, id } of pendingCreates.splice(0)) {
        containers.set(name, { id, pid: -1, exit: yield* Deferred.make<ExitCode>(), initialized: false })
      }
    })
  const stopping = Deferred.makeUnsafe<void>()
  const releaseStop = Deferred.makeUnsafe<void>()
  const creating = Deferred.makeUnsafe<void>()
  const releaseCreate = Deferred.makeUnsafe<void>()
  const spawn = (options: ScopedProcess.Options) =>
    Effect.gen(function*() {
      const args = options.args ?? []
      commands.push(args)
      const pid = nextPid++
      const exit = yield* Deferred.make<ExitCode>()
      let ownedId: string | undefined
      let output = ""
      const lookup = (target: string) =>
        [...containers.entries()].find(([name, container]) => name === target || container.id === target)
      const remove = (target: string) => {
        const entry = lookup(target)
        if (entry === undefined) return false
        const [name, container] = entry
        containers.delete(name)
        Deferred.doneUnsafe(container.exit, Effect.succeed(ExitCode(137)))
        return true
      }
      switch (args[0]) {
        case "create": {
          const name = args[args.indexOf("--name") + 1]!
          if (containers.has(name)) {
            yield* Deferred.succeed(exit, ExitCode(125))
          } else {
            const id = pid.toString(16).padStart(64, "0")
            if (faults.lateCreate) {
              pendingCreates.push({ name, id })
            } else if (faults.createOutput === undefined) {
              containers.set(name, { id, pid: -1, exit: yield* Deferred.make<ExitCode>(), initialized: false })
            }
            output = faults.createOutput ?? id + "\n"
            yield* Deferred.succeed(exit, ExitCode(faults.createCode ?? 0))
          }
          break
        }
        case "start": {
          const container = lookup(args[2]!)?.[1]
          if (container === undefined || faults.startCode !== undefined) {
            yield* Deferred.succeed(exit, ExitCode(faults.startCode ?? 1))
          } else {
            ownedId = container.id
            container.pid = pid
            container.exit = exit
          }
          break
        }
        case "rm": {
          const removed = remove(args[2]!)
          yield* Deferred.succeed(exit, ExitCode(removed ? 0 : 1))
          if (!removed && faults.lateCreate === "after-missed-rm") yield* landLateCreates()
          break
        }
        case "ps": {
          // Only the exact-name filter the supervisor uses is modeled.
          const filter = args[args.indexOf("--filter") + 1]!
          const pattern = new RegExp(filter.slice("name=".length))
          output = [...containers.entries()].filter(([name]) => pattern.test(`/${name}`))
            .map(([, container]) => container.id + "\n").join("")
          yield* Deferred.succeed(exit, ExitCode(0))
          break
        }
        case "exec": {
          const container = lookup(args[1]!)?.[1]
          if (container !== undefined && args[2] === "initialize") container.initialized = true
          yield* Deferred.succeed(
            exit,
            ExitCode(
              container === undefined || container.pid === -1 ? 1 : args[2] === "initialize" ? faults.initCode ?? 0 : 0
            )
          )
          break
        }
        default:
          throw new Error(`unexpected Docker command: ${args.join(" ")}`)
      }
      const kill = () =>
        Effect.gen(function*() {
          if (args[0] === "create" && faults.createCleanupFailure !== undefined) {
            return yield* Effect.die(faults.createCleanupFailure)
          }
          if (args[0] === "rm" && faults.removeCleanupFailure !== undefined) {
            return yield* Effect.die(faults.removeCleanupFailure)
          }
          // The attached process follows its immutable container ID even if a
          // name is reused. Explicit rm still models Docker's name/ID lookup.
          if (ownedId !== undefined) remove(ownedId)
          if (pid === delayedPid) {
            yield* Deferred.succeed(stopping, undefined)
            yield* Deferred.await(releaseStop)
          }
        })
      yield* Effect.addFinalizer(kill)
      return Object.assign(
        makeHandle({
          pid: ProcessId(pid),
          exitCode: Deferred.await(exit),
          isRunning: Effect.sync(() => !Deferred.isDoneUnsafe(exit)),
          kill,
          stdin: Sink.drain,
          stdout: Stream.fromEffect(Effect.gen(function*() {
            if (args[0] === "create" && faults.holdCreateResponse) {
              yield* Deferred.succeed(creating, undefined)
              yield* Deferred.await(releaseCreate)
            }
            return new TextEncoder().encode(output)
          })),
          // Docker diagnostics must not be parsed as part of its stdout ID.
          stderr: Stream.make(new TextEncoder().encode(args[0] === "create" ? "engine warning\n" : "")),
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
          unref: Effect.succeed(Effect.void)
        }),
        { targetPid: pid }
      )
    })
  vi.spyOn(ScopedProcess, "spawn").mockImplementation(spawn)
  return {
    containers,
    commands,
    stopping,
    releaseStop,
    creating,
    releaseCreate,
    delayStop: (pid: number) => delayedPid = pid,
    /** Completes every create the daemon was still processing. */
    landLateCreates
  }
}

const specFor = async (invocationId: string, cwd: string) => {
  const options: Parameters<typeof DockerExec.serviceSpec>[0] = {
    invocationId,
    label: "//:service",
    cwd,
    attrs: {
      image: "fixture",
      readiness: { exec: ["ready"], timeout: "1s" },
      init: [["initialize"]]
    }
  }
  const spec = await DockerExec.serviceSpec(options)
  if ("error" in spec) throw new Error(spec.error)
  return spec
}

const holdConsumer = (handle: ServiceSupervisor.ServiceHandle) =>
  Effect.gen(function*() {
    const entered = yield* Deferred.make<void>()
    const resume = yield* Deferred.make<string>()
    const fiber = yield* handle.whileHealthy(Effect.gen(function*() {
      yield* Deferred.succeed(entered, undefined)
      return yield* Deferred.await(resume)
    })).pipe(Effect.forkChild)
    yield* Deferred.await(entered)
    return { resume, fiber }
  })

describe("Docker invocation ownership", () => {
  for (const createCleanupFails of [false, true]) {
    it(`removes its created container when create client cleanup fails=${createCleanupFails}`, async () => {
      const cleanupFailure = new Error("create client cleanup could not be verified")
      const host = dockerHost(createCleanupFails ? { createCleanupFailure: cleanupFailure } : {})
      const spec = await specFor("invocation-a", "/workspace")
      const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        yield* supervisor.acquire(spec)
      })))
      expect.soft(host.containers.size).toBe(0)
      expect.soft(host.commands.filter((args) => args[0] === "rm")).toEqual([[
        "rm",
        "-f",
        (100).toString(16).padStart(64, "0")
      ]])
      if (createCleanupFails) {
        expect(host.commands.map((args) => args[0])).toEqual(["create", "rm"])
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(Cause.squash(exit.cause)).toBe(cleanupFailure)
      } else {
        expect(Exit.isSuccess(exit)).toBe(true)
      }
    })
  }

  it("preserves both create and removal client cleanup failures", async () => {
    const createCleanupFailure = new Error("create client cleanup could not be verified")
    const removeCleanupFailure = new Error("removal client cleanup could not be verified")
    const host = dockerHost({ createCleanupFailure, removeCleanupFailure })
    const spec = await specFor("invocation-a", "/workspace")
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      yield* supervisor.acquire(spec)
    })))
    expect.soft(host.containers.size).toBe(0)
    expect.soft(host.commands.filter((args) => args[0] === "rm")).toEqual([[
      "rm",
      "-f",
      (100).toString(16).padStart(64, "0")
    ]])
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.pretty(exit.cause)).toContain(createCleanupFailure.message)
      expect(Cause.pretty(exit.cause)).toContain(removeCleanupFailure.message)
    }
  })

  it("cleans up the returned ID when acquisition is interrupted during creation", async () => {
    const host = dockerHost({ holdCreateResponse: true })
    const spec = await specFor("invocation-a", "/workspace")
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const acquiring = yield* Effect.scoped(supervisor.acquire(spec)).pipe(Effect.forkChild)
      yield* Deferred.await(host.creating)
      acquiring.interruptUnsafe()
      yield* Deferred.succeed(host.releaseCreate, undefined)
      expect(Exit.isFailure(yield* Fiber.await(acquiring))).toBe(true)
    })))
    expect(host.containers.size).toBe(0)
    expect(host.commands.filter((args) => args[0] === "rm")).toEqual([[
      "rm",
      "-f",
      (100).toString(16).padStart(64, "0")
    ]])
  })

  it("includes the Docker prefix in spec drift detection", async () => {
    dockerHost()
    const spec = await specFor("invocation-a", "/workspace")
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      yield* supervisor.acquire(spec)
      const error = yield* Effect.flip(supervisor.acquire({ ...spec, docker: "different-prefix" }))
      expect(error.reason).toBe("spec-drift")
    })))
  })

  for (const docker of ["", "-option", 1, {}]) {
    it(`rejects an invalid Docker prefix ${JSON.stringify(docker)} before spawning`, async () => {
      const host = dockerHost()
      const spec = await specFor("invocation-a", "/workspace")
      const error = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        return yield* Effect.flip(supervisor.acquire({ ...spec, docker } as ServiceSupervisor.ServiceSpec))
      })))
      expect(error.reason).toBe("invalid-spec")
      expect(host.commands).toEqual([])
    })
  }

  it("preserves a same-supervisor replacement through the previous lifetime's delayed cleanup", async () => {
    const host = dockerHost()
    const spec = await specFor("invocation-a", "/workspace")
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const oldScope = yield* Scope.fork(yield* Scope.Scope)
      const old = yield* supervisor.acquire(spec).pipe(Scope.provide(oldScope))
      host.delayStop(old.pid)
      const closing = yield* Scope.close(oldScope, Exit.void).pipe(Effect.forkChild)
      yield* Deferred.await(host.stopping)
      const { next, consumer } = yield* Effect.gen(function*() {
        const next = yield* supervisor.acquire(spec)
        const consumer = yield* holdConsumer(next)
        return { next, consumer }
      }).pipe(Effect.ensuring(Deferred.succeed(host.releaseStop, undefined)))
      yield* Fiber.join(closing)
      // Report the harm first: a lost replacement is the defect, and the
      // identity assertions below only explain how it was lost.
      expect.soft([...host.containers.values()].map((c) => c.pid)).toEqual([next.pid])
      expect.soft([...host.containers.values()].map((c) => c.initialized)).toEqual([true])
      // If cleanup deleted the replacement, let the real exit observer fail
      // its waiting consumer rather than racing it with a successful body.
      if (host.containers.size > 0) yield* Deferred.succeed(consumer.resume, "consumer completed")
      expect.soft(yield* Fiber.await(consumer.fiber)).toEqual(Exit.succeed("consumer completed"))
      const creates = host.commands.filter((args) => args[0] === "create")
      expect(new Set(creates.map((args) => args[3])).size).toBe(2)
      const starts = host.commands.filter((args) => args[0] === "start")
      expect(host.commands.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", starts[0]![2]]])
    })))
    expect(host.containers.size).toBe(0)
    const startedIds = host.commands.filter((args) => args[0] === "start").map((args) => args[2])
    expect(host.commands.filter((args) => args[0] === "rm").map((args) => args[2])).toEqual(startedIds)
  })

  it("shares live acquisitions and creates a fresh identity after serialized release", async () => {
    const host = dockerHost()
    const spec = await specFor("invocation-a", "/workspace")
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const old = yield* Effect.scoped(Effect.gen(function*() {
        const first = yield* supervisor.acquire(spec)
        const shared = yield* supervisor.acquire(yield* Effect.promise(() => specFor("invocation-a", "/workspace")))
        expect(shared.pid).toBe(first.pid)
        expect(host.commands.filter((args) => args[0] === "create")).toHaveLength(1)
        return first
      }))
      expect(host.containers.size).toBe(0)
      const next = yield* supervisor.acquire(spec)
      expect(next.pid).not.toBe(old.pid)
      const creates = host.commands.filter((args) => args[0] === "create")
      expect(new Set(creates.map((args) => args[3])).size).toBe(2)
    })))
    expect(host.containers.size).toBe(0)
  })

  for (const options of [{ createCode: 1 }, { startCode: 1 }, { initCode: 1 }]) {
    it(`cleans up the returned ID after failure ${JSON.stringify(options)}`, async () => {
      const host = dockerHost(options)
      const spec = await specFor("invocation-a", "/workspace")
      const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        yield* supervisor.acquire(spec)
      })))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(host.containers.size).toBe(0)
      expect(host.commands.filter((args) => args[0] === "rm")).toEqual([[
        "rm",
        "-f",
        (100).toString(16).padStart(64, "0")
      ]])
    })
  }

  for (const createOutput of ["", "not-a-container-id", "--all"]) {
    it(`removes its own name, never the invalid creation output ${JSON.stringify(createOutput)}`, async () => {
      const host = dockerHost({ createOutput })
      const spec = await specFor("invocation-a", "/workspace")
      const failure = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        return yield* Effect.flip(supervisor.acquire(spec))
      })))
      expect(failure).toMatchObject({ key: "//:service", reason: "spawn-failed" })
      // Unreadable output leaves a container the daemon may still hold under
      // the name this acquisition minted, so that name is the only safe
      // removal target. The output itself never reaches the command line.
      const name = host.commands.find((args) => args[0] === "create")![3]!
      expect(host.commands.map((args) => args[0])).toEqual(["create", "rm"])
      expect(host.commands.find((args) => args[0] === "rm")).toEqual(["rm", "-f", name])
      expect(name).not.toBe(createOutput.trim())
    })
  }

  it("names the expired bound when creation does not answer, and removes its own name", async () => {
    const host = dockerHost({ holdCreateResponse: true })
    const spec = await specFor("invocation-a", "/workspace")
    const failure = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      return yield* Effect.flip(supervisor.acquire(spec)).pipe(
        Effect.ensuring(Deferred.succeed(host.releaseCreate, undefined))
      )
    })))
    expect(failure).toMatchObject({ key: "//:service", reason: "spawn-failed" })
    // A daemon that prints something before the bound expires must not read
    // as an ordinary refusal: the message has to name the bound it exceeded.
    expect(failure.message).toContain("container creation failed after 1000ms")
    const name = host.commands.find((args) => args[0] === "create")![3]!
    expect(host.commands.find((args) => args[0] === "rm")).toEqual(["rm", "-f", name])
  })

  it("removes a container the daemon creates after the create client timed out", async () => {
    const host = dockerHost({ holdCreateResponse: true, lateCreate: "after-missed-rm" })
    const spec = await specFor("invocation-a", "/workspace")
    const failure = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      return yield* Effect.flip(supervisor.acquire(spec)).pipe(
        Effect.ensuring(Deferred.succeed(host.releaseCreate, undefined))
      )
    })))
    expect(failure.message).toContain("container creation failed after 1000ms")
    const name = host.commands.find((args) => args[0] === "create")![3]!
    const id = (100).toString(16).padStart(64, "0")
    // The removal by name missed the pending create; the daemon then created
    // it, and closing the supervisor waited for the reap that removed it.
    expect(host.containers.size).toBe(0)
    expect(host.commands.filter((args) => args[0] === "rm")).toEqual([["rm", "-f", name], ["rm", "-f", id]])
    expect(host.commands.find((args) => args[0] === "ps")).toEqual([
      "ps",
      "--all",
      "--quiet",
      "--no-trunc",
      "--filter",
      `name=^/?${name}$`
    ])
    // The reap stopped once the name was gone rather than polling to its bound.
    const after = host.commands.findIndex((args) => args[0] === "rm" && args[2] === id)
    expect(host.commands.slice(after + 1).map((args) => args[0])).toEqual(["ps"])
  })

  it("stops looking for a late container after one more creation bound", async () => {
    const host = dockerHost({ holdCreateResponse: true, lateCreate: "manual" })
    const spec = await specFor("invocation-a", "/workspace")
    let failed = 0
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      yield* Effect.flip(supervisor.acquire(spec)).pipe(
        Effect.ensuring(Deferred.succeed(host.releaseCreate, undefined))
      )
      failed = Date.now()
    })))
    // Closing the supervisor waited for the reap: a 1s creation bound polls
    // every 250ms for one more second after the failed create, then stops.
    expect(Date.now() - failed).toBeGreaterThanOrEqual(1_000)
    const polls = () => host.commands.filter((args) => args[0] === "ps").length
    const settled = polls()
    expect(settled).toBeGreaterThan(0)
    expect(settled).toBeLessThanOrEqual(4)
    await new Promise((resolve) => setTimeout(resolve, 750))
    expect(polls()).toBe(settled)
    // A create landing after the window is not the supervisor's to find.
    await Effect.runPromise(host.landLateCreates())
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(host.containers.size).toBe(1)
    expect(host.commands.filter((args) => args[0] === "rm")).toHaveLength(1)
  })

  it("does not poll for a late container when the daemon answered the create", async () => {
    const host = dockerHost({ createOutput: "", createCode: 1 })
    const spec = await specFor("invocation-a", "/workspace")
    const failure = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      return yield* Effect.flip(supervisor.acquire(spec))
    })))
    expect(failure).toMatchObject({ key: "//:service", reason: "spawn-failed" })
    expect(host.commands.map((args) => args[0])).toEqual(["create", "rm"])
  })

  it("fails an active consumer when its own container is removed", async () => {
    const host = dockerHost()
    const spec = await specFor("invocation-a", "/workspace")
    await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(spec)
      const consumer = yield* holdConsumer(handle)
      const name = [...host.containers.keys()][0]!
      yield* Effect.scoped(Effect.gen(function*() {
        const removed = yield* ScopedProcess.spawn({ command: "/docker", args: ["rm", "-f", name] })
        expect((yield* ScopedProcess.status(removed)).code).toBe(0)
      }))
      const exit = yield* Fiber.await(consumer.fiber)
      expect(Exit.isFailure(exit)).toBe(true)
      const failure = yield* Effect.flip(Fiber.join(consumer.fiber))
      expect(failure).toMatchObject({ key: "//:service", reason: "exited" })
    })))
    expect(host.containers.size).toBe(0)
  })

  for (const cwd of ["/workspace", "/other-workspace"]) {
    it(`preserves overlapping commands and refcounts with B in ${cwd}`, async () => {
      const host = dockerHost()
      const aSpec = await specFor("invocation-a", "/workspace")
      const bSpec = await specFor("invocation-b", cwd)
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const aScope = yield* Scope.fork(yield* Scope.Scope)
        const a = yield* ServiceSupervisor.make.pipe(Scope.provide(aScope))
        const aHandle = yield* a.acquire(aSpec).pipe(Scope.provide(aScope))
        const b = yield* ServiceSupervisor.make
        const bHandle = yield* b.acquire(bSpec)
        const consumer = yield* holdConsumer(bHandle)
        expect.soft([...host.containers.values()].map((c) => c.pid)).toContain(aHandle.pid)
        expect.soft([...host.containers.values()].map((c) => c.pid)).toContain(bHandle.pid)
        // Resolving again in the same invocation must retain the same spec
        // and share one process, even when a second consumer closes first.
        const again = yield* Effect.promise(() => specFor("invocation-b", cwd))
        yield* Effect.scoped(Effect.gen(function*() {
          const shared = yield* b.acquire(again)
          expect(shared.pid).toBe(bHandle.pid)
        }))
        expect(host.commands.filter((args) => args[0] === "create")).toHaveLength(2)
        yield* Scope.close(aScope, Exit.void)
        expect.soft([...host.containers.values()].map((c) => c.pid)).toEqual([bHandle.pid])
        expect.soft([...host.containers.values()].map((c) => c.initialized)).toEqual([true])
        yield* Deferred.succeed(consumer.resume, "consumer completed")
        expect(yield* Fiber.await(consumer.fiber)).toEqual(Exit.succeed("consumer completed"))
      })))
      expect(host.containers.size).toBe(0)
    })

    it(`preserves B through A's delayed cleanup with B in ${cwd}`, async () => {
      const host = dockerHost()
      const aSpec = await specFor("invocation-a", "/workspace")
      const bSpec = await specFor("invocation-b", cwd)
      await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
        const aScope = yield* Scope.fork(yield* Scope.Scope)
        const a = yield* ServiceSupervisor.make.pipe(Scope.provide(aScope))
        const aHandle = yield* a.acquire(aSpec).pipe(Scope.provide(aScope))
        host.delayStop(aHandle.pid)
        const closing = yield* Scope.close(aScope, Exit.void).pipe(Effect.forkChild)
        yield* Deferred.await(host.stopping)
        const b = yield* ServiceSupervisor.make
        const { bHandle, consumer } = yield* Effect.gen(function*() {
          const bHandle = yield* b.acquire(bSpec)
          const consumer = yield* holdConsumer(bHandle)
          return { bHandle, consumer }
        }).pipe(Effect.ensuring(Deferred.succeed(host.releaseStop, undefined)))
        yield* Fiber.join(closing)
        expect.soft([...host.containers.values()].map((c) => c.pid)).toEqual([bHandle.pid])
        expect.soft([...host.containers.values()].map((c) => c.initialized)).toEqual([true])
        yield* Deferred.succeed(consumer.resume, "consumer completed")
        expect(yield* Fiber.await(consumer.fiber)).toEqual(Exit.succeed("consumer completed"))
      })))
      expect(host.containers.size).toBe(0)
    })
  }
})
