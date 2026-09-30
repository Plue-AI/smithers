import { describe, expect, it } from "@effect/vitest"
import { spawn, spawnSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { EventEmitter, once } from "node:events"
import { createInterface } from "node:readline"
import { runInNewContext } from "node:vm"
import { Control } from "../src/internal/ProcessSupervisor.ts"
import { source } from "../src/internal/SupervisorProgram.ts"

const schedules = ["target exit", "status EOF", "request EOF"] as const

// Execute the shipped source with manual event/timer delivery. No OS signals
// occur here; recorded calls expose escalation before the grace timer runs.
const program = (
  killSignal: string,
  escaped = true,
  platform = "linux",
  standardFds?: ReadonlyArray<number | "ignore">,
  identityResult?: unknown,
  acknowledgeCleanup = false
) => {
  const statusFrames: Array<unknown> = []
  const observations: Array<unknown> = []
  const released: Array<number> = []
  const replacements: Array<readonly [string, string]> = []
  const signals: Array<readonly [number, string]> = []
  const timers: Array<{ run: () => void; millis: number }> = []
  const socket = () =>
    Object.assign(new EventEmitter(), {
      writable: true,
      destroyed: false,
      setEncoding: () => {},
      write: (_data: string, done: () => void) => done()
    })
  const status = socket()
  status.write = (data: string, done: () => void) => {
    statusFrames.push(JSON.parse(data))
    done()
  }
  const requests = socket()
  // One process table, published as Linux `/proc` stat lines and as `ps` rows.
  const table: Array<readonly [pid: number, parent: number, group: number, state: string]> = [
    [4102, 4101, 4101, "S"],
    ...(escaped ? [[4103, 4102, 4103, "S"] as const] : [])
  ]
  const proc = new Map<string, string | Error>(
    table.map(([pid, parent, group, state]) => [
      String(pid),
      `${pid} (node worker) ${state} ${parent} ${group} ${Array(16).fill(0).join(" ")} 7000 0 0\n`
    ])
  )
  const listing: { error?: Error } = {}
  const target = Object.assign(new EventEmitter(), { pid: 4102 })
  const runtime = Object.assign(new EventEmitter(), {
    pid: 4101,
    platform,
    env: identityResult === undefined ? {} : { SMITHERS_PROCESS_JOB_HELPER: "/trusted/helper" },
    argv: ["/fixture/s", "group"],
    kill: (pid: number, signal: string) => signals.push([pid, signal])
  })
  const modules: Record<string, unknown> = {
    "node:os": { devNull: platform === "win32" ? "\\\\.\\nul" : "/dev/null" },
    "node:fs": {
      closeSync: (fd: number) => released.push(fd),
      openSync: (path: string, flags: string) => {
        replacements.push([path, flags])
        return replacements.length - 1
      },
      readdirSync: (path: string) => {
        expect(path).toBe("/proc")
        if (listing.error !== undefined) throw listing.error
        return ["self", "sys", ...proc.keys()]
      },
      readFileSync: (path: string, encoding: string) => {
        expect(encoding).toBe("utf8")
        const entry = proc.get(/^\/proc\/([0-9]+)\/stat$/.exec(path)![1]!)
        if (entry instanceof Error) throw entry
        return entry
      }
    },
    "node:net": { connect: (path: string) => path.endsWith("/s") ? status : requests },
    "node:child_process": {
      spawn: () => target,
      spawnSync: (...args: ReadonlyArray<unknown>) => {
        observations.push(args)
        return identityResult ?? ({
          status: 0,
          stdout: table.map(([pid, parent, group, state]) =>
            `${pid} ${parent} ${group} ${state} Mon Sep 14 12:00:00 2026\n`
          ).join("")
        })
      }
    }
  }
  runInNewContext(source, {
    require: (name: string) => modules[name],
    process: runtime,
    Buffer,
    setTimeout: (run: () => void, millis: number) => {
      const timer = { run, millis }
      timers.push(timer)
      return timer
    },
    clearTimeout: () => {}
  })
  const send = (message: unknown) => requests.emit("data", JSON.stringify(message) + "\n")
  send({
    type: "configure",
    command: "fixture",
    args: [],
    userFds: [],
    standardFds,
    killSignal,
    graceMs: 25,
    acknowledgeCleanup
  })
  send({ type: "start" })
  return {
    signals,
    timers,
    status,
    requests,
    target,
    send,
    released,
    replacements,
    statusFrames,
    observations,
    runtime,
    proc,
    listing
  }
}

describe("supervisor stop policy", () => {
  it("keeps flushed terminal status alive until the host acknowledges receipt", () => {
    const helper = program("SIGKILL", false, "linux", undefined, undefined, true)
    helper.target.emit("exit", 0, null)
    expect(helper.statusFrames).toEqual([{ type: "exit", code: 0, signal: null }, { type: "cleanup" }])
    expect(helper.signals).toEqual([])
    helper.send({ type: "cleanup_ack" })
    expect(helper.signals).toEqual([[-4101, "SIGKILL"]])
  })

  it("still bounds cleanup to 100 ms when the host never acknowledges", () => {
    const helper = program("SIGKILL", false, "linux", undefined, undefined, true)
    helper.target.emit("exit", 0, null)
    expect(helper.signals).toEqual([])
    expect(helper.timers.map((timer) => timer.millis)).toEqual([100])
    helper.timers[0]!.run()
    expect(helper.signals).toEqual([[-4101, "SIGKILL"]])
  })

  it("rejects an acknowledgment before cleanup or without negotiated receipts", () => {
    const pending = program("SIGKILL", false, "linux", undefined, undefined, true)
    expect(() => pending.send({ type: "cleanup_ack" })).toThrow("Unexpected cleanup acknowledgment")
    const unnegotiated = program("SIGKILL", false)
    unnegotiated.target.emit("exit", 0, null)
    expect(() => unnegotiated.send({ type: "cleanup_ack" })).toThrow("Unexpected cleanup acknowledgment")
  })

  const observed = { status: 0, signal: null, stdout: "{\"status\":\"started\",\"created\":\"123456789012345678\"}" }
  it("reports its own exact Windows identity and removes the private helper setting", () => {
    const helper = program("SIGTERM", false, "win32", [3, 4, 5], observed)
    helper.status.emit("connect")
    expect(helper.statusFrames).toContainEqual({ type: "ready", version: 1, pid: 4101, created: "123456789012345678" })
    expect(helper.observations).toEqual([["/trusted/helper", ["--process-identity", "4101"], {
      encoding: "utf8",
      timeout: 5000,
      killSignal: "SIGKILL",
      maxBuffer: 4096,
      env: {}
    }]])
    expect(helper.runtime.env).toEqual({})
  })
  for (
    const result of [
      { ...observed, error: new Error("refused") },
      { ...observed, signal: "SIGKILL" },
      { ...observed, status: 1 },
      { ...observed, stdout: "bad JSON" },
      { ...observed, stdout: "null" },
      { ...observed, stdout: "{\"status\":\"gone\"}" },
      { ...observed, stdout: "{\"status\":\"started\",\"created\":1}" },
      { ...observed, stdout: "{\"status\":\"started\",\"created\":\"0\"}" }
    ]
  ) {
    it(`refuses to report an unverified Windows identity ${JSON.stringify(result)}`, () => {
      expect(() => program("SIGTERM", false, "win32", [3, 4, 5], result)).toThrow()
    })
  }

  it("closes remapped Windows caller pipes without touching reserved CRT slots", () => {
    const helper = program("SIGTERM", false, "win32", [3, "ignore", 5])
    helper.target.emit("spawn")
    expect(helper.released).toEqual([3, 5])
    expect(helper.replacements).toEqual([])
  })
  for (const platform of ["linux", "darwin", "win32"]) {
    it(`releases inherited pipes into the native null device on ${platform}`, () => {
      const helper = program("SIGTERM", false, platform)
      helper.target.emit("spawn")
      const device = platform === "win32" ? "\\\\.\\nul" : "/dev/null"
      expect(helper.released).toEqual([0, 1, 2])
      expect(helper.replacements).toEqual([[device, "r"], [device, "w"], [device, "w"]])
    })
  }

  for (const defaultSignal of ["SIGTERM", "SIGKILL"]) {
    for (const schedule of [...schedules, "status error", "request error", "repeated stop", "fast stop"] as const) {
      it(`preserves explicit TERM/5000 after ${schedule} with default ${defaultSignal}`, () => {
        const helper = program(defaultSignal)
        helper.send({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs: 5000 })
        expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"]])
        expect(helper.timers.map((timer) => timer.millis)).toEqual([5000])
        if (schedule === "target exit") helper.target.emit("exit", 0, null)
        else if (schedule === "status EOF") helper.status.emit("end")
        else if (schedule === "request EOF") helper.requests.emit("end")
        else if (schedule === "status error") helper.status.emit("error", new Error("closed"))
        else if (schedule === "request error") helper.requests.emit("error", new Error("closed"))
        else helper.send({ type: "stop", killSignal: "SIGKILL", fast: schedule === "fast stop" })
        expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"]])
        expect(helper.timers.map((timer) => timer.millis)).toEqual([5000])
        helper.timers[0]!.run()
        expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"], [4103, "SIGKILL"]])
      })
    }
  }

  it("still permits the host's verified fast stop after natural target exit", () => {
    const helper = program("SIGTERM")
    // An orphan still in the owner's group keeps the grace window open.
    helper.proc.set("4105", `4105 (node worker) S 1 4101 ${Array(16).fill(0).join(" ")} 7000 0 0\n`)
    helper.target.emit("exit", 0, null)
    expect(helper.signals).toEqual([[-4101, "SIGTERM"]])
    helper.send({ type: "stop", killSignal: "SIGKILL", fast: true })
    expect(helper.signals).toEqual([[-4101, "SIGTERM"], [-4101, "SIGKILL"]])
  })

  it("preserves an explicit stop even when no descendant escaped", () => {
    const helper = program("SIGKILL", false)
    // An orphan still in the owner's group keeps the grace window open.
    helper.proc.set("4105", `4105 (node worker) S 1 4101 ${Array(16).fill(0).join(" ")} 7000 0 0\n`)
    helper.send({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs: 5000 })
    helper.target.emit("exit", 0, null)
    helper.send({ type: "stop", killSignal: "SIGKILL", fast: true })
    expect(helper.signals).toEqual([[-4101, "SIGTERM"]])
    expect(helper.timers.map((timer) => timer.millis)).toEqual([5000])
    helper.timers[0]!.run()
    expect(helper.signals).toEqual([[-4101, "SIGTERM"], [-4101, "SIGKILL"]])
  })
})

describe("supervisor vacant-group settlement", () => {
  it("finishes an explicit stop at once when the exited target left no live group member", () => {
    const helper = program("SIGKILL", false)
    helper.send({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs: 5000 })
    expect(helper.timers.map((timer) => timer.millis)).toEqual([5000])
    helper.proc.set("4102", `4102 (node worker) Z 4101 4101 ${Array(16).fill(0).join(" ")} 7000 0 0\n`)
    helper.target.emit("exit", null, "SIGTERM")
    // Cleanup is reported and the owner's group ends without the grace timer.
    expect(helper.statusFrames).toContainEqual({ type: "cleanup" })
    expect(helper.signals).toEqual([[-4101, "SIGTERM"], [-4101, "SIGKILL"]])
    expect(helper.timers.map((timer) => timer.millis)).toEqual([5000, 100])
  })

  it("finishes a natural grouped exit at once when the group is empty", () => {
    const helper = program("SIGTERM", false)
    helper.proc.delete("4102")
    helper.target.emit("exit", 0, null)
    expect(helper.signals).toEqual([[-4101, "SIGTERM"], [-4101, "SIGKILL"]])
    expect(helper.statusFrames).toContainEqual({ type: "cleanup" })
  })

  it("keeps the grace window while another group member is alive", () => {
    const helper = program("SIGKILL", false)
    helper.send({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs: 5000 })
    helper.proc.delete("4102")
    helper.proc.set("4104", `4104 (node worker) S 4102 4101 ${Array(16).fill(0).join(" ")} 7000 0 0\n`)
    helper.target.emit("exit", null, "SIGTERM")
    expect(helper.statusFrames).not.toContainEqual({ type: "cleanup" })
    expect(helper.timers.map((timer) => timer.millis)).toEqual([5000])
  })

  it("ignores the owner's own ps child when the system ps answers the snapshot", () => {
    const helper = program("SIGKILL", false, "darwin")
    helper.send({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs: 5000 })
    // The table the fake ps prints still names 4102 as the owner's child, as
    // the ps process answering a real snapshot is.
    helper.target.emit("exit", null, "SIGTERM")
    expect(helper.statusFrames).toContainEqual({ type: "cleanup" })
  })

  it("keeps the grace window for a captured escaped descendant", () => {
    const helper = program("SIGKILL", true)
    helper.send({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs: 5000 })
    helper.proc.delete("4102")
    helper.target.emit("exit", null, "SIGTERM")
    expect(helper.statusFrames).not.toContainEqual({ type: "cleanup" })
    expect(helper.timers.map((timer) => timer.millis)).toEqual([5000])
  })

  it("keeps the grace window when the process table cannot be read", () => {
    const helper = program("SIGKILL", false)
    helper.send({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs: 5000 })
    helper.proc.delete("4102")
    helper.listing.error = new Error("EACCES")
    helper.target.emit("exit", null, "SIGTERM")
    expect(helper.statusFrames).not.toContainEqual({ type: "cleanup" })
    expect(helper.timers.map((timer) => timer.millis)).toEqual([5000])
  })
})

describe("supervisor descendant observation", () => {
  const stat = (pid: number, comm: string, state: string, parent: number, group: number, start: number) =>
    `${pid} (${comm}) ${state} ${parent} ${group} ${Array(16).fill(0).join(" ")} ${start} 0 0\n`
  const gone = (code: string) => Object.assign(new Error(code), { code })
  const stopped = (helper: ReturnType<typeof program>) =>
    helper.send({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs: 5000 })
  const faults = (helper: ReturnType<typeof program>) =>
    helper.statusFrames.filter((frame) => (frame as { type: string }).type === "cleanup_error")

  it("captures and signals an escaped descendant from /proc on Linux without running ps", () => {
    const helper = program("SIGKILL")
    stopped(helper)
    expect(helper.observations).toEqual([])
    expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"]])
    helper.timers[0]!.run()
    expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"], [4103, "SIGKILL"]])
    expect(faults(helper)).toEqual([])
  })

  it("stops a Linux target with no escaped descendant and no ps", () => {
    const helper = program("SIGKILL", false)
    stopped(helper)
    helper.target.emit("exit", null, "SIGTERM")
    expect(helper.observations).toEqual([])
    // The vacant group settles at once from /proc, still without ps.
    expect(helper.signals).toEqual([[-4101, "SIGTERM"], [-4101, "SIGKILL"]])
    expect(faults(helper)).toEqual([])
  })

  for (const platform of ["darwin", "freebsd"]) {
    it(`asks the system ps on ${platform}`, () => {
      const helper = program("SIGKILL", true, platform)
      stopped(helper)
      expect(helper.observations.map((call) => (call as ReadonlyArray<unknown>).slice(0, 2))).toEqual([
        ["/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="]],
        ["/bin/ps", ["-A", "-o", "pid=,ppid=,pgid=,stat=,lstart="]]
      ])
      expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"]])
    })
  }

  it("reads fields after the last parenthesis of a command name with spaces and parentheses", () => {
    const helper = program("SIGKILL")
    helper.proc.set("4103", stat(4103, "a) S 1 1 (b", "S", 4102, 4103, 7000))
    stopped(helper)
    expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"]])
    expect(faults(helper)).toEqual([])
  })

  for (const code of ["ENOENT", "ESRCH"]) {
    it(`skips a process that ended between listing and reading (${code})`, () => {
      const helper = program("SIGKILL")
      helper.proc.set("4999", gone(code))
      stopped(helper)
      expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"]])
      expect(faults(helper)).toEqual([])
    })
  }

  it("ignores a descendant that is already a zombie", () => {
    const helper = program("SIGKILL")
    helper.proc.set("4103", stat(4103, "node", "Z", 4102, 4103, 7000))
    stopped(helper)
    expect(helper.signals).toEqual([[-4101, "SIGTERM"]])
  })

  const failures: ReadonlyArray<readonly [string, (helper: ReturnType<typeof program>) => void, string]> = [
    ["an unlistable table", (helper) => {
      helper.listing.error = gone("EACCES")
    }, "Descendant observation unavailable"],
    ["an unreadable stat file", (helper) => {
      helper.proc.set("4103", gone("EACCES"))
    }, "Descendant observation unavailable"],
    ["a stat line without a command name", (helper) => {
      helper.proc.set("4103", "4103 S 4102 4103\n")
    }, "Invalid descendant observation"],
    ["a stat line for another pid", (helper) => {
      helper.proc.set("4103", stat(4104, "node", "S", 4102, 4103, 7000))
    }, "Invalid descendant observation"],
    ["a truncated stat line", (helper) => {
      helper.proc.set("4103", "4103 (node) S 4102 4103 0\n")
    }, "Invalid descendant observation"],
    ["a non-numeric identity", (helper) => {
      helper.proc.set("4103", stat(4103, "node", "S", 4102, 4103, 7000).replace(" 7000 ", " soon "))
    }, "Invalid descendant identity"]
  ]
  for (const [label, corrupt, message] of failures) {
    it(`reports ${label} as a cleanup fault instead of claiming the stop verified`, () => {
      const helper = program("SIGKILL")
      corrupt(helper)
      stopped(helper)
      expect(faults(helper)).toContainEqual({ type: "cleanup_error", message })
      expect(helper.signals).toEqual([[-4101, "SIGTERM"]])
    })
  }

  it("refuses to signal a pid whose /proc start time changed after capture", () => {
    const helper = program("SIGKILL")
    stopped(helper)
    helper.proc.set("4103", stat(4103, "node", "S", 4102, 4103, 7001))
    helper.timers[0]!.run()
    expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"], [-4101, "SIGKILL"]])
    expect(faults(helper)).toContainEqual({
      type: "cleanup_error",
      message: "Escaped descendant identity changed before signalling"
    })
  })

  it("settles an escaped descendant once /proc no longer lists it", () => {
    const helper = program("SIGKILL")
    stopped(helper)
    helper.proc.delete("4103")
    helper.timers[0]!.run()
    expect(helper.signals).toEqual([[4103, "SIGTERM"], [-4101, "SIGTERM"], [-4101, "SIGKILL"]])
    expect(faults(helper)).toEqual([])
  })
})

describe.skipIf(process.platform === "win32")("real supervisor stop policy", () => {
  for (const schedule of schedules) {
    it(`preserves explicit grace after ${schedule} with a SIGKILL default`, async () => {
      const control = new Control()
      const token = randomUUID()
      // The escaped child keeps stdout open until it is actually killed. Its
      // TERM acknowledgement is the barrier before target exit or socket EOF.
      const descendant = `const token=${JSON.stringify(token)};
        process.on('SIGTERM',()=>process.stdout.write('term\\n'));
        process.send('ready');setInterval(()=>{},1000)`
      const leader = `process.on('SIGTERM',()=>{});
        const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],
          {detached:true,stdio:['ignore',1,2,'ipc']});
        child.once('message',()=>process.stdout.write(child.pid+'\\n'));
        process.stdin.once('data',()=>process.exit(0));`
      await control.listening
      const owner = spawn(process.execPath, ["-e", source, control.path, "group"], {
        detached: true,
        stdio: ["pipe", "pipe", "pipe"]
      })
      const exited = once(owner, "exit")
      const drained = once(owner.stdout, "end")
      const lines = createInterface({ input: owner.stdout })[Symbol.asyncIterator]()
      let rejectFailure!: (error: Error) => void
      const failed = new Promise<never>((_, reject) => {
        rejectFailure = reject
      })
      // Fail inside the test's outer 30-second bound so finally still releases
      // the real fixture. A helper refusal must not become an opaque EOF hang.
      const deadline = setTimeout(() => rejectFailure(new Error("Real supervisor fixture exceeded 25 seconds")), 25_000)
      const checked = <A>(value: Promise<A>) => Promise.race([value, failed])
      let escapedPid: number | undefined
      try {
        expect(await checked(control.ready.promise)).toBe(owner.pid)
        control.socket!.on("data", () => {
          if (control.cleanupFailed) {
            rejectFailure(new Error(`Helper refused cleanup: ${JSON.stringify(control.fault)}`))
          }
        })
        await checked(control.requestsReady.promise)
        await checked(control.write({
          type: "configure",
          command: process.execPath,
          args: ["-e", leader],
          userFds: [],
          killSignal: "SIGKILL",
          graceMs: 25
        }))
        control.activationSent = true
        await checked(control.write({ type: "start" }))
        await checked(control.started.promise)
        const ready = await checked(lines.next())
        expect(ready.done).toBe(false)
        escapedPid = Number(ready.value)
        expect(Number.isSafeInteger(escapedPid) && escapedPid > 1).toBe(true)
        const graceMs = 1000
        const stoppingAt = performance.now()
        await checked(control.write({ type: "stop", explicit: true, killSignal: "SIGTERM", graceMs }))
        expect(await checked(lines.next())).toMatchObject({ value: "term", done: false })
        if (schedule === "target exit") {
          owner.stdin.end("exit\n")
          expect(await checked(control.exited.promise)).toBe(0)
        } else if (schedule === "status EOF") control.socket!.end()
        else control.requestSocket!.end()
        // No test sleep: inherited stdout EOF proves all its writers exited.
        await checked(drained)
        const elapsed = performance.now() - stoppingAt
        expect(await checked(exited)).toEqual([null, "SIGKILL"])
        expect(elapsed).toBeGreaterThanOrEqual(graceMs)
        await checked(control.ended.promise)
        if (schedule !== "status EOF") {
          expect(control.cleanupAcknowledged).toBe(true)
          expect(control.cleanupFailed).toBe(false)
        }
        const observed = spawnSync("/bin/ps", ["-o", "stat=", "-p", String(escapedPid)], { encoding: "utf8" })
        expect(observed.status !== 0 || observed.stdout.trim().startsWith("Z"), observed.stdout).toBe(true)
      } finally {
        clearTimeout(deadline)
        control.dispose()
        // The native child handle and UUID-validated fixture PIDs remain ours
        // even when a failed observation prevented the helper's own sweep.
        owner.kill("SIGKILL")
        for (const pid of [control.targetPid, escapedPid]) {
          if (pid === undefined) continue
          const identity = spawnSync("/bin/ps", ["-ww", "-o", "command=", "-p", String(pid)], {
            encoding: "utf8"
          })
          if (identity.stdout.includes(token)) process.kill(pid, "SIGKILL")
        }
        await exited
      }
    })
  }
})
