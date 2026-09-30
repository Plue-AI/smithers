/**
 * ServiceSupervisor lifecycle proofs over a real node HTTP fixture server.
 *
 * Everything here spawns real processes and probes real sockets:
 *
 * 1. Readiness gates a consumer — the consumer's request succeeds even though
 *    the server delays `listen`, because acquire waits for the probe.
 * 2. A service that dies or stops answering mid-consumer fails the consumer
 *    through the health contract, with the tail of captured server output.
 * 3. The stop contract escalates: declared signal, grace, then SIGKILL of the
 *    process group — proven with a server that ignores SIGTERM.
 * 4. Refcounting shares one spawn across two parallel consumers and releases
 *    only after the last consumer's scope closes.
 * 5. SIGINT on the embedding process tears the service down (pgrep proves no
 *    orphan survives).
 */
import * as Secret from "@smthrs/targets/Secret"
import * as Effect from "effect/Effect"
import { execFile, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as NodeNet from "node:net"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as OutputStream from "../src/OutputStream.ts"
import * as ServiceSupervisor from "../src/ServiceSupervisor.ts"

const fixtureDir = NodePath.resolve(import.meta.dirname, "fixtures/service-supervisor")
const serverPath = NodePath.join(fixtureDir, "server.mjs")
const driverPath = NodePath.join(fixtureDir, "sigint-driver.ts")
const packageDir = NodePath.resolve(import.meta.dirname, "..")

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const probe = NodeNet.createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("no port assigned")))
        return
      }
      probe.close(() => resolve(address.port))
    })
    probe.on("error", reject)
  })

/**
 * Whether the OS still knows `pid`.
 *
 * Only ESRCH means the process is gone. EPERM names a process this test may
 * not signal — it is alive — and any other errno is a failed inspection, so
 * reporting it as absence would let a teardown assertion pass on a survivor.
 */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ESRCH") return false
    if (code === "EPERM") return true
    throw error
  }
}

const waitFor = async (predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`condition not reached within ${timeoutMs}ms`)
}

const getText = (url: string): Promise<string> => fetch(url).then((response) => response.text())

/** A failed `pgrep`: a spawn errno, a signal, or an unexpected exit status. */
type ProbeFailure = Error & {
  readonly code?: number | string | undefined
  readonly signal?: NodeJS.Signals | null | undefined
}

/**
 * Pids whose command line carries `pattern`.
 *
 * pgrep exits 0 having named matches and 1 having found none. Every other
 * outcome — a missing binary, a signal, an unexpected status — is a failed
 * inspection, and answering it with "no matches" would let a cleanup
 * assertion pass while the service is still running, so it rejects instead.
 */
const probeProcesses = (command: string, pattern: string): Promise<ReadonlyArray<number>> =>
  new Promise((resolve, reject) => {
    execFile(command, ["-f", pattern], (error, stdout) => {
      const pids = stdout.split("\n").map((line) => line.trim()).filter((line) => line !== "").map(Number)
      if (error === null) {
        if (pids.length === 0) {
          reject(new Error(`${command} -f ${pattern} exited 0 without naming a pid`))
          return
        }
        resolve(pids)
        return
      }
      const failure = error as ProbeFailure
      if (failure.code === 1 && (failure.signal === null || failure.signal === undefined) && pids.length === 0) {
        resolve([])
        return
      }
      reject(
        new Error(`${command} -f ${pattern} could not inspect processes`, { cause: error })
      )
    })
  })

const pgrep = (pattern: string): Promise<ReadonlyArray<number>> => probeProcesses("pgrep", pattern)

/**
 * A process the marker probe must be able to see, alive for the whole file.
 *
 * An absence assertion with no positive observation cannot tell a service
 * that was torn down from a probe that matches nothing at all, so every
 * teardown check re-proves the probe against this control.
 */
const probeControlMarker = `service-supervisor-probe-control-${randomUUID()}`
let probeControl: ReturnType<typeof spawn> | undefined

beforeAll(async () => {
  probeControl = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", probeControlMarker], {
    stdio: "ignore"
  })
  await waitFor(async () => (await pgrep(probeControlMarker)).length > 0, 30_000)
})

afterAll(() => {
  probeControl?.kill("SIGKILL")
})

/** Waits for `marker` to name no process, with the probe proven live after. */
const waitForNoProcesses = async (marker: string, timeoutMs: number): Promise<void> => {
  await waitFor(async () => (await pgrep(marker)).length === 0, timeoutMs)
  expect(await pgrep(probeControlMarker)).not.toHaveLength(0)
}

/** A fixture-server spec; extra argv flags append after the port. */
const serverSpec = (
  key: string,
  port: number,
  flags: ReadonlyArray<string>,
  probes: Pick<ServiceSupervisor.ServiceSpec, "readiness" | "health" | "stop">
): ServiceSupervisor.ServiceSpec => ({
  key,
  cwd: fixtureDir,
  argv: [process.execPath, serverPath, "--port", String(port), ...flags],
  ...probes
})

const run = <A>(effect: Effect.Effect<A, unknown, never>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, never, never>).catch((error) => {
    throw error
  })

const acquireFlipped = (
  spec: ServiceSupervisor.ServiceSpec
): Promise<ServiceSupervisor.ServiceError> =>
  run(Effect.scoped(Effect.gen(function*() {
    const supervisor = yield* ServiceSupervisor.make
    return yield* Effect.flip(supervisor.acquire(spec))
  }))) as Promise<ServiceSupervisor.ServiceError>

describe("service progress", () => {
  it("streams service progress without changing the captured service tail", async () => {
    const lines: Array<string> = []
    const tail = await run(
      Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire({
          key: "//:streamed-service",
          cwd: fixtureDir,
          argv: [process.execPath, "-e", "console.log('ready private-value'); setInterval(() => {}, 1000)"],
          stop: { signal: "SIGTERM", grace: "100ms" }
        })
        yield* Effect.tryPromise(() => waitFor(() => handle.outputTail().includes("ready private-value"), 10_000))
        return handle.outputTail()
      })).pipe(Effect.provideService(ServiceSupervisor.Output, () =>
        OutputStream.make({
          write: (_stream, text) => lines.push(text),
          environment: { TOKEN: "private-value" }
        })))
    )
    expect(tail).toContain("ready private-value")
    expect(lines.join("")).toContain("ready [REDACTED]")
    expect(lines.join("")).not.toContain("private-value")
  })

  it("keeps draining and capturing when an optional output observer throws", async () => {
    let closed = false
    const tail = await run(
      Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire({
          key: "//:failed-service-observer",
          cwd: fixtureDir,
          argv: [
            process.execPath,
            "-e",
            "console.log('service ready');setTimeout(()=>console.log('still draining'),100);setInterval(()=>{},1000)"
          ],
          stop: { signal: "SIGTERM", grace: "100ms" }
        })
        yield* handle.whileHealthy(
          Effect.tryPromise(() => waitFor(() => handle.outputTail().includes("still draining"), 10_000))
        )
        return handle.outputTail()
      })).pipe(Effect.provideService(ServiceSupervisor.Output, () => ({
        onStdout: () => {
          throw new Error("observer failed")
        },
        onStderr: () => {},
        close: () => {
          closed = true
          throw new Error("observer close failed")
        }
      })))
    )
    expect(tail).toContain("service ready")
    expect(tail).toContain("still draining")
    expect(closed).toBe(true)
  })
})

describe("parseDurationMs", () => {
  it("parses ms, s, m, and h", () => {
    expect(ServiceSupervisor.parseDurationMs("500ms", "t")).toBe(500)
    expect(ServiceSupervisor.parseDurationMs("15s", "t")).toBe(15_000)
    expect(ServiceSupervisor.parseDurationMs("90s", "t")).toBe(90_000)
    expect(ServiceSupervisor.parseDurationMs("2m", "t")).toBe(120_000)
    expect(ServiceSupervisor.parseDurationMs("1h", "t")).toBe(3_600_000)
    expect(ServiceSupervisor.parseDurationMs("1.5s", "t")).toBe(1_500)
  })

  it("refuses everything else loudly", () => {
    for (const bad of ["", "15", "15sec", "s15", "-1s", "0ms", "1 5s", "1d"]) {
      expect(() => ServiceSupervisor.parseDurationMs(bad, "t")).toThrowError(/duration/)
    }
  })
})

describe("spec validation", () => {
  /**
   * Every refusal the descriptor-only snapshot can raise, so the copy that
   * exists to keep caller code out of validation is itself covered rather than
   * trusted. Each case names one shape a hostile or malformed caller can hand
   * `acquire`.
   */
  it("names the exact shape it refuses", async () => {
    const base = { key: "//x:shape", cwd: fixtureDir, argv: [process.execPath, serverPath] }
    const refusal = async (
      spec: unknown,
      expected: string
    ): Promise<void> => {
      const error = await acquireFlipped(spec as ServiceSupervisor.ServiceSpec)
      expect(error.reason, expected).toBe("invalid-spec")
      expect(error.message).toContain(expected)
    }

    await refusal([], "a service spec must be a plain object")
    await refusal(Object.create({ inherited: 1 }), "a service spec must be a plain object")
    await refusal({ ...base, extra: 1 }, "a service spec contains an unknown property: extra")
    await refusal({ ...base, [Symbol("s")]: 1 }, "a service spec must not contain symbol properties")
    await refusal({ ...base, toJSON: () => base }, "a service spec must not define toJSON")

    const sparse = { ...base, argv: [process.execPath, serverPath] as Array<unknown> }
    Object.defineProperty(sparse.argv, "tagged", { enumerable: true, value: 1 })
    await refusal(sparse, "service spec argv must be a dense array without extra properties")

    await refusal({ ...base, env: [] }, "service spec env must be a plain object")
    await refusal({ ...base, env: { PATH: 1 } }, "env must be a record of strings")
    await refusal(
      { ...base, readiness: { port: 1, nope: true } },
      "service spec readiness contains an unknown property: nope"
    )
    await refusal({ ...base, prepare: new Proxy([], {}) }, "service spec prepare must not be a proxy")

    const nonEnumerable = { cwd: fixtureDir, argv: base.argv }
    Object.defineProperty(nonEnumerable, "key", { enumerable: false, value: "//x:hidden" })
    await refusal(nonEnumerable, "service spec key must be an enumerable data property")
  })

  it("rejects an argv getter without running it", async () => {
    let reads = 0
    const caller = { key: "//x:argv-getter", cwd: fixtureDir } as unknown as ServiceSupervisor.ServiceSpec
    Object.defineProperty(caller, "argv", {
      enumerable: true,
      get: () => {
        reads += 1
        return [process.execPath, serverPath]
      }
    })
    const error = await acquireFlipped(caller)
    expect(error.reason).toBe("invalid-spec")
    expect(error.message).toContain("argv must be an enumerable data property")
    expect(reads).toBe(0)
  })

  it("reports the argv shape error after snapshotting a non-array value", async () => {
    const error = await acquireFlipped({
      key: "//x:argv-shape",
      cwd: fixtureDir,
      argv: "node" as never
    })
    expect(error.reason).toBe("invalid-spec")
    expect(error.message).toBe("service //x:argv-shape requires a non-empty argv of strings")
  })

  it("rejects a proxied env record", async () => {
    const error = await acquireFlipped({
      key: "//x:env-proxy",
      cwd: fixtureDir,
      argv: [process.execPath, serverPath],
      env: new Proxy({ MARKER: "value" }, {})
    })
    expect(error.reason).toBe("invalid-spec")
    expect(error.message).toContain("env must not be a proxy")
  })

  it("rejects a readiness JSON hook without running it", async () => {
    let calls = 0
    const error = await acquireFlipped({
      key: "//x:readiness-json",
      cwd: fixtureDir,
      argv: [process.execPath, serverPath],
      readiness: {
        port: 1,
        toJSON: () => {
          calls += 1
          return { port: 1 }
        }
      } as ServiceSupervisor.Readiness
    })
    expect(error.reason).toBe("invalid-spec")
    expect(error.message).toContain("readiness must not define toJSON")
    expect(calls).toBe(0)
  })

  it("starts the validated argv when the caller mutates during prepare", async () => {
    const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-service-snapshot-"))
    const marker = NodePath.join(directory, "prepare-started")
    const program = "process.stdout.write(process.argv[1]); setInterval(() => {}, 1000)"
    const caller: {
      key: string
      cwd: string
      argv: [string, ...Array<string>]
      prepare: Array<[string, ...Array<string>]>
    } = {
      key: "//x:snapshot",
      cwd: directory,
      argv: [process.execPath, "-e", program, "validated"],
      prepare: [[
        process.execPath,
        "-e",
        `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'started'); setTimeout(() => {}, 500)`
      ]]
    }
    try {
      const acquisition = run(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire(caller)
        yield* Effect.tryPromise(() => waitFor(() => Promise.resolve(handle.outputTail().includes("validated")), 5_000))
        return handle.outputTail()
      })))
      await waitFor(() => Fs.access(marker).then(() => true, () => false), 5_000)
      caller.argv[3] = "mutated-entry"
      caller.argv = [process.execPath, "-e", program, "mutated-array"]
      const output = await acquisition
      expect(output).toContain("validated")
      expect(output).not.toContain("mutated")
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("refuses a bad readiness timeout format", async () => {
    const error = await acquireFlipped({
      key: "//x:bad-timeout",
      cwd: fixtureDir,
      argv: [process.execPath, serverPath],
      readiness: { http: "http://127.0.0.1:1/health", timeout: "15sec" }
    })
    expect(error.reason).toBe("invalid-spec")
    expect(error.message).toContain("readiness.timeout")
  })

  it("refuses health without readiness", async () => {
    const error = await acquireFlipped({
      key: "//x:health-no-readiness",
      cwd: fixtureDir,
      argv: [process.execPath, serverPath],
      health: { interval: "15s" }
    })
    expect(error.reason).toBe("invalid-spec")
    expect(error.message).toContain("health")
  })

  it("refuses a relative cwd, an empty argv, a bad signal, a bad port, and a bad URL", async () => {
    const base = {
      cwd: fixtureDir,
      argv: [process.execPath, serverPath] as const
    }
    const cases: Array<ServiceSupervisor.ServiceSpec> = [
      { key: "//x:rel", ...base, cwd: "relative/dir" },
      { key: "//x:argv", ...base, argv: [""] },
      { key: "//x:sig", ...base, stop: { signal: "TERM", grace: "5s" } },
      { key: "//x:port", ...base, readiness: { port: 0 } },
      { key: "//x:url", ...base, readiness: { http: "not a url", timeout: "5s" } }
    ]
    for (const spec of cases) {
      const error = await acquireFlipped(spec)
      expect(error.reason).toBe("invalid-spec")
    }
  })

  it("refuses two acquires of one key with different specs", async () => {
    const port = await freePort()
    const error = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      yield* supervisor.acquire(serverSpec("//x:drift", port, [], { readiness: { port } }))
      return yield* Effect.flip(
        supervisor.acquire(serverSpec("//x:drift", port, ["--extra-flag"], { readiness: { port } }))
      )
    }))) as ServiceSupervisor.ServiceError
    expect(error.reason).toBe("spec-drift")
  })
})

describe("prepare", () => {
  it("runs prepare before the process is spawned, and a failing prepare does not block the spawn", async () => {
    const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-service-prepare-"))
    const marker = NodePath.join(directory, "prepared")
    try {
      await run(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        // The service refuses to run unless the marker already exists, so a
        // live handle is only possible if prepare ran first. The second
        // prepare command exits non-zero: prepare is best-effort, like
        // cleanup, and must not turn a stale-state sweep into a failure.
        const handle = yield* supervisor.acquire({
          key: "//x:prepared",
          cwd: directory,
          argv: [
            process.execPath,
            "-e",
            `if (!require('node:fs').existsSync(${
              JSON.stringify(marker)
            })) process.exit(3); setInterval(() => {}, 1000)`
          ],
          prepare: [
            [process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ok')`],
            [process.execPath, "-e", "process.exit(1)"]
          ]
        })
        expect(alive(handle.pid)).toBe(true)
      })))
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  it("refuses a prepare entry that is not a non-empty argv", async () => {
    const error = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      return yield* Effect.flip(supervisor.acquire({
        key: "//x:bad-prepare",
        cwd: process.cwd(),
        argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
        prepare: [[]] as unknown as ReadonlyArray<readonly [string, ...Array<string>]>
      }))
    }))) as ServiceSupervisor.ServiceError
    expect(error.reason).toBe("invalid-spec")
  })
})

describe("readiness", () => {
  it("supports exec readiness and runs init only after readiness", async () => {
    const port = await freePort()
    const directory = await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-service-init-"))
    const marker = NodePath.join(directory, "ready")
    try {
      await run(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire({
          ...serverSpec("//x:exec-ready", port, ["--delay-listen", "300"], {}),
          readiness: {
            exec: [
              process.execPath,
              "-e",
              `fetch('http://127.0.0.1:${port}/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))`
            ],
            timeout: "10s"
          },
          init: [[process.execPath, "-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ok')`]]
        })
        expect(alive(handle.pid)).toBe(true)
        const contents = yield* Effect.promise(() => Fs.readFile(marker, "utf8"))
        expect(contents).toBe("ok")
      })))
    } finally {
      await Fs.rm(directory, { recursive: true, force: true })
    }
  })

  /**
   * The exec probe used to run with no `cwd` (so it inherited the CLI
   * process's directory) and with `serviceEnvironment(undefined)` rather than
   * the resolved declared environment the service itself runs under. A probe
   * naming a relative executable, or one reading a declared variable, failed
   * even though the identical command worked in the service's own context —
   * and `healthLoop` reuses the probe, so a healthy service was reported
   * unhealthy and torn down.
   */
  it("runs an exec probe in the service's cwd under the service's environment", async () => {
    const port = await freePort()
    await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire({
        ...serverSpec("//x:probe-context", port, [], {}),
        env: { SMTHRS_PROBE_MARKER: "declared" },
        readiness: {
          exec: [
            process.execPath,
            "-e",
            // Both facts at once: the relative path resolves only from the
            // service's cwd, and the variable exists only in its environment.
            "const fs=require('node:fs');" +
            "if(!fs.existsSync('./server.mjs'))process.exit(1);" +
            "process.exit(process.env.SMTHRS_PROBE_MARKER==='declared'?0:1)"
          ],
          timeout: "10s"
        }
      })
      expect(alive(handle.pid)).toBe(true)
    })))
  })

  it("http readiness gates a consumer behind a delayed listen", async () => {
    const port = await freePort()
    const started = Date.now()
    const body = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(serverSpec("//x:http-ready", port, ["--delay-listen", "500"], {
        readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "30s" }
      }))
      expect(alive(handle.pid)).toBe(true)
      return yield* handle.whileHealthy(
        Effect.promise(() => getText(`http://127.0.0.1:${port}/instance`))
      )
    })))
    expect(body).toMatch(/^instance-/)
    expect(Date.now() - started).toBeGreaterThanOrEqual(400)
  })

  it("port readiness gates a consumer behind a delayed listen", async () => {
    const port = await freePort()
    const body = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(
        serverSpec("//x:port-ready", port, ["--delay-listen", "300"], { readiness: { port } })
      )
      return yield* handle.whileHealthy(
        Effect.promise(() => getText(`http://127.0.0.1:${port}/instance`))
      )
    })))
    expect(body).toMatch(/^instance-/)
  })

  it("fails acquisition when readiness never comes, and still stops the child", async () => {
    const port = await freePort()
    const marker = `service-supervisor-timeout-proof-${randomUUID()}`
    const error = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      return yield* Effect.flip(supervisor.acquire(
        serverSpec("//x:never-ready", port, ["--delay-listen", "60000", "--marker", marker], {
          readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "1s" }
        })
      ))
    }))) as ServiceSupervisor.ServiceError
    expect(error).toBeInstanceOf(ServiceSupervisor.ServiceError)
    expect(error.reason).toBe("readiness-timeout")
    expect(error.message).toContain("was not ready within 1000ms")
    await waitForNoProcesses(marker, 10_000)
  })
})

describe("health", () => {
  it("fails the consumer when the server dies mid-consumer", async () => {
    const port = await freePort()
    let pid = -1
    const error = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(serverSpec("//x:killed", port, [], {
        readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "30s" },
        health: { interval: "150ms", failures: 2 }
      }))
      pid = handle.pid
      return yield* Effect.flip(handle.whileHealthy(Effect.gen(function*() {
        yield* Effect.sync(() => process.kill(handle.pid, "SIGKILL"))
        yield* Effect.sleep(20_000)
      })))
    }))) as ServiceSupervisor.ServiceError
    expect(error).toBeInstanceOf(ServiceSupervisor.ServiceError)
    expect(error.reason).toBe("exited")
    expect(error.outputTail).toContain("listening")
    await waitFor(() => !alive(pid), 5_000)
  })

  it("fails the consumer via consecutive probe failures when the server stops answering", async () => {
    const port = await freePort()
    const started = Date.now()
    const error = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(serverSpec("//x:wedged", port, [], {
        readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "30s" },
        health: { interval: "150ms", failures: 2 }
      }))
      return yield* Effect.flip(handle.whileHealthy(Effect.gen(function*() {
        yield* Effect.promise(() => getText(`http://127.0.0.1:${port}/wedge`))
        yield* Effect.sleep(30_000)
      })))
    }))) as ServiceSupervisor.ServiceError
    expect(error).toBeInstanceOf(ServiceSupervisor.ServiceError)
    expect(error.reason).toBe("unhealthy")
    expect(error.message).toContain("2 consecutive health probes")
    expect(error.message).toContain("answered 500")
    expect(error.outputTail).toContain("wedged")
    // Failed through the health contract, not by exhausting the consumer.
    expect(Date.now() - started).toBeLessThan(20_000)
  })

  it("tolerates probe flaps below the failures threshold", async () => {
    const port = await freePort()
    const result = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(serverSpec("//x:flappy", port, [], {
        readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "30s" },
        health: { interval: "100ms", failures: 3 }
      }))
      return yield* handle.whileHealthy(Effect.gen(function*() {
        yield* Effect.promise(() => getText(`http://127.0.0.1:${port}/flap?n=1`))
        yield* Effect.sleep(700)
        return "survived"
      }))
    })))
    expect(result).toBe("survived")
  })
})

describe("stop contract", () => {
  it("escalates to SIGKILL of the group when the server ignores the stop signal", async () => {
    const port = await freePort()
    let pid = -1
    let releaseStarted = 0
    await run(Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire(serverSpec("//x:stubborn", port, ["--ignore-sigterm"], {
          readiness: { port },
          stop: { signal: "SIGTERM", grace: "400ms" }
        }))
        pid = handle.pid
        releaseStarted = Date.now()
      }))
    }))
    const releaseElapsed = Date.now() - releaseStarted
    expect(releaseElapsed).toBeGreaterThanOrEqual(400)
    await waitFor(() => !alive(pid), 5_000)
  })

  it("completes cooperative server cleanup after preserving the explicit grace", async () => {
    const port = await freePort()
    let pid = -1
    let releaseStarted = 0
    await run(Effect.gen(function*() {
      yield* Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire(serverSpec("//x:cooperative", port, [], {
          readiness: { port },
          stop: { signal: "SIGTERM", grace: "400ms" }
        }))
        pid = handle.pid
        releaseStarted = Date.now()
      }))
    }))
    // platform-node/docs/concepts/process-containment.md: an explicit stop
    // retains its deadline after target exit so descendant cleanup keeps the
    // accepted signal and grace. Only natural completion may take a shortcut.
    const releaseElapsed = Date.now() - releaseStarted
    expect(releaseElapsed).toBeGreaterThanOrEqual(400)
    expect(releaseElapsed).toBeLessThan(10_000)
    await waitFor(() => !alive(pid), 5_000)
  })

  it("stops the service when the consumer fails", async () => {
    const port = await freePort()
    let pid = -1
    const error = await run(Effect.flip(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire(serverSpec("//x:consumer-fails", port, [], {
        readiness: { port }
      }))
      pid = handle.pid
      return yield* handle.whileHealthy(Effect.fail(new Error("consumer exploded")))
    }))))
    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toBe("consumer exploded")
    await waitFor(() => !alive(pid), 5_000)
  })
})

describe("refcounting", () => {
  it("shares one spawn across two parallel consumers and releases after the last", async () => {
    const port = await freePort()
    const spec = serverSpec("//x:shared", port, [], {
      readiness: { http: `http://127.0.0.1:${port}/health`, timeout: "30s" }
    })
    const observed: Array<{ readonly pid: number; readonly instance: string }> = []
    let sharedPid = -1
    await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const consumer = (holdMs: number, checkAliveAt?: number) =>
        Effect.scoped(Effect.gen(function*() {
          const handle = yield* supervisor.acquire(spec)
          sharedPid = handle.pid
          const instance = yield* Effect.promise(() => getText(`http://127.0.0.1:${port}/instance`))
          observed.push({ pid: handle.pid, instance })
          if (checkAliveAt !== undefined) {
            yield* Effect.sleep(checkAliveAt)
            // The short-lived sibling has released by now; the shared spawn
            // must still be alive because this consumer still holds it.
            expect(alive(handle.pid)).toBe(true)
            yield* Effect.sleep(Math.max(holdMs - checkAliveAt, 0))
            return
          }
          yield* Effect.sleep(holdMs)
        }))
      yield* Effect.all([consumer(200), consumer(1_500, 1_000)], { concurrency: 2 })
    })))
    expect(observed).toHaveLength(2)
    expect(observed[0]!.pid).toBe(observed[1]!.pid)
    expect(observed[0]!.instance).toBe(observed[1]!.instance)
    await waitFor(() => !alive(sharedPid), 5_000)
  })
})

describe("spawn failure", () => {
  it("refuses loudly when the executable does not exist", async () => {
    const error = await run(Effect.flip(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const handle = yield* supervisor.acquire({
        key: "//x:missing-binary",
        cwd: fixtureDir,
        argv: ["/nonexistent-service-supervisor-binary"]
      })
      return yield* handle.whileHealthy(Effect.sleep(10_000))
    })))) as ServiceSupervisor.ServiceError
    expect(error).toBeInstanceOf(ServiceSupervisor.ServiceError)
    expect(["spawn-failed", "exited"]).toContain(error.reason)
  })
})

describe("secret boundary", () => {
  it("keeps the value out of the service and substitutes it at HTTP egress", async () => {
    let authorization: string | undefined
    const upstream = (await import("node:http")).createServer((request, response) => {
      authorization = request.headers.authorization
      response.end("ok")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    const secret = "service-boundary-secret"
    process.env["SMITHERS_SERVICE_BOUNDARY_SECRET"] = secret
    let tail = ""
    try {
      const program = String.raw`
const http = require("node:http")
const value = process.env.SMITHERS_SERVICE_BOUNDARY_SECRET || ""
if (!value.startsWith("smithers-build-secret-")) process.exit(91)
const proxy = new URL(process.env.HTTP_PROXY)
const target = "http://127.0.0.1:${port}/"
const request = http.request({
  host: proxy.hostname,
  port: proxy.port,
  path: target,
  headers: { authorization: "Bearer " + value }
}, (response) => {
  response.resume()
  response.on("end", () => setInterval(() => {}, 1000))
})
request.on("error", () => process.exit(92))
request.end()
`
      await run(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire({
          key: "//x:secret-boundary",
          cwd: fixtureDir,
          argv: [process.execPath, "-e", program],
          secrets: [Secret.HttpSecret(
            Secret.Secret("SMITHERS_SERVICE_BOUNDARY_SECRET"),
            [`http://127.0.0.1:${port}`]
          )]
        })
        yield* Effect.promise(() => waitFor(() => authorization !== undefined, 5_000))
        tail = handle.outputTail()
        expect(alive(handle.pid)).toBe(true)
      })))
      expect(authorization).toBe(`Bearer ${secret}`)
      expect(tail).not.toContain(secret)
    } finally {
      delete process.env["SMITHERS_SERVICE_BOUNDARY_SECRET"]
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it("resolves brokered-origin tokens in service argv and env to the substituting origin", async () => {
    const seen: Array<string | undefined> = []
    const upstream = (await import("node:http")).createServer((request, response) => {
      seen.push(request.headers.authorization)
      response.end("ok")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    const audience = `http://127.0.0.1:${port}`
    process.env["SMITHERS_SERVICE_ORIGIN_SECRET"] = "service-origin-secret"
    try {
      const program = String.raw`
const http = require("node:http")
const call = (base) => new Promise((resolve) => {
  if (base.includes("{smthrs:") || base === ${JSON.stringify(audience)}) process.exit(96)
  http.get(base + "/x", { headers: { authorization: process.env.SMITHERS_SERVICE_ORIGIN_SECRET } }, (response) => {
    response.resume()
    response.on("end", resolve)
  }).on("error", () => process.exit(97))
})
call(process.env.API).then(() => call(process.argv[1])).then(() => setInterval(() => {}, 1000))
`
      await run(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        yield* supervisor.acquire({
          key: "//x:secret-origin",
          cwd: fixtureDir,
          argv: [process.execPath, "-e", program, Secret.SecretOrigin(audience)],
          env: { API: Secret.SecretOrigin(audience) },
          secrets: [Secret.HttpSecret(Secret.Secret("SMITHERS_SERVICE_ORIGIN_SECRET"), [audience])]
        })
        yield* Effect.promise(() => waitFor(() => seen.length === 2, 5_000))
      })))
      expect(seen).toEqual(["service-origin-secret", "service-origin-secret"])
    } finally {
      delete process.env["SMITHERS_SERVICE_ORIGIN_SECRET"]
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it("replaces a secret URL argv slot with a loopback egress capability", async () => {
    let requested = false
    const upstream = (await import("node:http")).createServer((_request, response) => {
      requested = true
      response.end("ok")
    })
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve))
    const address = upstream.address()
    const port = typeof address === "object" && address !== null ? address.port : 0
    const target = `http://127.0.0.1:${port}/rpc`
    process.env["SMITHERS_SERVICE_DESTINATION"] = target
    let tail = ""
    try {
      const program = String.raw`
const http = require("node:http")
const destination = process.argv[1]
if (new URL(destination).hostname !== "127.0.0.1") process.exit(93)
if (process.env.SMITHERS_SERVICE_DESTINATION) process.exit(94)
http.get(destination, (response) => {
  response.resume()
  response.on("end", () => setInterval(() => {}, 1000))
}).on("error", () => process.exit(95))
`
      await run(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire({
          key: "//x:secret-destination",
          cwd: fixtureDir,
          argv: [process.execPath, "-e", program, "{secret-url:SMITHERS_SERVICE_DESTINATION}"],
          secretUrls: [{ index: 3, secret: Secret.Secret("SMITHERS_SERVICE_DESTINATION") }]
        })
        yield* Effect.promise(() => waitFor(() => requested, 5_000))
        tail = handle.outputTail()
        expect(alive(handle.pid)).toBe(true)
      })))
      expect(requested).toBe(true)
      expect(tail).not.toContain(target)
    } finally {
      delete process.env["SMITHERS_SERVICE_DESTINATION"]
      await new Promise<void>((resolve) => upstream.close(() => resolve()))
    }
  })

  it("refuses malformed and duplicate secret URL argv bindings", async () => {
    const base = {
      key: "//x:secret-url",
      cwd: fixtureDir,
      argv: [process.execPath, serverPath, "placeholder"] as [string, ...Array<string>]
    }
    for (
      const secretUrls of [
        [null],
        [{ index: 0, secret: Secret.Secret("BOUNDARY_URL") }],
        [
          { index: 2, secret: Secret.Secret("BOUNDARY_URL") },
          { index: 2, secret: Secret.Secret("OTHER_BOUNDARY_URL") }
        ]
      ]
    ) {
      const error = await acquireFlipped({ ...base, secretUrls } as never)
      expect(error.reason).toBe("invalid-spec")
      expect(error.message).toContain("secretUrls")
    }
  })
})

describe("SIGINT teardown", () => {
  it("kills the service process group when the embedding process gets SIGINT (pgrep proves no orphan)", async () => {
    const port = await freePort()
    const marker = `service-supervisor-sigint-proof-${randomUUID()}`
    const driver = spawn(process.execPath, ["--import", "tsx", driverPath, String(port), serverPath, marker], {
      cwd: packageDir,
      stdio: ["ignore", "pipe", "pipe"]
    })
    let output = ""
    driver.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString("utf8")
    })
    let errors = ""
    driver.stderr.on("data", (chunk: Buffer) => {
      errors += chunk.toString("utf8")
    })
    const exited = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
      (resolve) => {
        driver.on("close", (code, signal) => resolve({ code, signal }))
      }
    )
    try {
      await waitFor(() => /READY \d+/.test(output), 30_000).catch(() => {
        throw new Error(`driver never became ready.\nstdout: ${output}\nstderr: ${errors}`)
      })
      const serverPid = Number(/READY (\d+)/.exec(output)![1])
      expect(alive(serverPid)).toBe(true)
      expect(await pgrep(marker)).not.toHaveLength(0)
      driver.kill("SIGINT")
      const outcome = await exited
      // The backstop re-raises, so the driver dies of SIGINT itself.
      expect(outcome.signal).toBe("SIGINT")
      await waitFor(() => !alive(serverPid), 10_000)
      await waitForNoProcesses(marker, 10_000)
    } finally {
      driver.kill("SIGKILL")
    }
  })
})

describe("process probes", () => {
  it("rejects a failed process inspection instead of reporting an absence", async () => {
    await expect(probeProcesses("pgrep-does-not-exist", probeControlMarker)).rejects.toThrow(
      /could not inspect processes/
    )
  })

  it("reads a process it may not signal as alive", () => {
    // pid 1 is launchd: `process.kill` raises EPERM there for an unprivileged
    // test, which is a permission failure, not a dead process.
    expect(alive(1)).toBe(true)
  })

  it("reads an unused pid as absent", () => {
    expect(alive(2_147_483)).toBe(false)
  })
})

/** A minimal running service, one per identity case. */
// A short grace keeps eleven stops from each waiting out the 5 s default (#3055).
const identityBase = (key: string): ServiceSupervisor.ServiceSpec => ({
  key,
  cwd: fixtureDir,
  argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
  readiness: { exec: ["true"], timeout: "10s" },
  stop: { signal: "SIGTERM", grace: "100ms" }
})

/** Every canonicalized field, changed away from the base spec. */
const identityDrift: ReadonlyArray<
  readonly [string, (base: ServiceSupervisor.ServiceSpec) => ServiceSupervisor.ServiceSpec]
> = [
  ["cwd", (base) => ({ ...base, cwd: Os.tmpdir() })],
  ["argv", (base) => ({ ...base, argv: [...base.argv, "--extra"] as [string, ...Array<string>] })],
  ["env", (base) => ({ ...base, env: { CANONICAL: "1" } })],
  ["secrets", (base) => ({
    ...base,
    secrets: [Secret.HttpSecret(Secret.Secret("CANONICAL_SECRET"), ["http://127.0.0.1:1"])]
  })],
  ["secretUrls", (base) => ({
    ...base,
    secretUrls: [{ index: 1, secret: Secret.Secret("CANONICAL_URL") }]
  })],
  ["readiness", (base) => ({ ...base, readiness: { exec: ["true"], timeout: "20s" } })],
  ["health", (base) => ({ ...base, health: { interval: "1h" } })],
  ["stop", (base) => ({ ...base, stop: { signal: "SIGTERM", grace: "200ms" } })],
  ["stop signal", (base) => ({ ...base, stop: { signal: "SIGINT", grace: "100ms" } })],
  ["stop removal", (base) => ({ ...base, stop: undefined })],
  ["prepare", (base) => ({ ...base, prepare: [["true"]] })],
  ["init", (base) => ({ ...base, init: [["true"]] })],
  ["cleanup", (base) => ({ ...base, cleanup: [["true"]] })]
]

describe("spec identity", () => {
  it("counts a change in any canonicalized field as drift under one key", async () => {
    await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      for (const [field, drift] of identityDrift) {
        const base = identityBase(`//x:identity-${field}`)
        yield* supervisor.acquire(base)
        const error = yield* Effect.flip(supervisor.acquire(drift(base)))
        expect([field, error.reason]).toEqual([field, "spec-drift"])
      }
    })))
  }, 120_000)

  it("keeps the lookup key out of the identity: another key is another service", async () => {
    const pids = await run(Effect.scoped(Effect.gen(function*() {
      const supervisor = yield* ServiceSupervisor.make
      const base = identityBase("//x:identity-key-a")
      const first = yield* supervisor.acquire(base)
      const second = yield* supervisor.acquire({ ...base, key: "//x:identity-key-b" })
      return [first.pid, second.pid] as const
    })))
    expect(pids[0]).not.toBe(pids[1])
  }, 60_000)

  it("accepts a spec that declares every field", async () => {
    process.env["CANONICAL_FULL_SECRET"] = "full-secret-value"
    process.env["CANONICAL_FULL_URL"] = "http://127.0.0.1:1"
    try {
      const tail = await run(Effect.scoped(Effect.gen(function*() {
        const supervisor = yield* ServiceSupervisor.make
        const handle = yield* supervisor.acquire({
          key: "//x:every-field",
          cwd: fixtureDir,
          argv: [process.execPath, "-e", "console.log('up'); setInterval(() => {}, 1000)", "placeholder"],
          env: { CANONICAL_FULL: "1" },
          secrets: [Secret.HttpSecret(Secret.Secret("CANONICAL_FULL_SECRET"), ["http://127.0.0.1:1"])],
          secretUrls: [{ index: 3, secret: Secret.Secret("CANONICAL_FULL_URL") }],
          readiness: { exec: ["true"], timeout: "10s" },
          health: { interval: "1h", failures: 5 },
          stop: { signal: "SIGTERM", grace: "100ms" },
          prepare: [["true"]],
          init: [["true"]],
          cleanup: [["true"]]
        })
        yield* Effect.tryPromise(() => waitFor(() => handle.outputTail().includes("up"), 20_000))
        return handle.outputTail()
      })))
      expect(tail).toContain("up")
    } finally {
      delete process.env["CANONICAL_FULL_SECRET"]
      delete process.env["CANONICAL_FULL_URL"]
    }
  }, 60_000)
})
