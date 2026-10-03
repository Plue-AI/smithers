import { describe, expect, it } from "@effect/vitest"
import { Effect, Stream } from "effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { once } from "node:events"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs"
import type { Socket } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Tls from "node:tls"
import * as PipedProcess from "../src/internal/PipedProcess.ts"
import { policy } from "../src/internal/ProcessCleanup.ts"
import { Control, prepare } from "../src/internal/ProcessSupervisor.ts"

const bounded = async <A>(promise: Promise<A>): Promise<A> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Private protocol did not settle within two seconds")), 2000)
      })
    ])
  } finally {
    clearTimeout(timer)
  }
}

const connected = async (control: Control, requests = false): Promise<Socket> => {
  const socket = control.connect(requests)
  // Protocol-refusal tests deliberately destroy the other end of this socket.
  socket.on("error", () => {})
  await bounded(once(socket, "connect"))
  return socket
}

const send = (socket: Socket, ...values: ReadonlyArray<unknown>): Promise<void> =>
  bounded(
    new Promise((resolve, reject) => {
      socket.write(values.map((value) => JSON.stringify(value)).join("\n") + "\n", (error) =>
        error ? reject(error) : resolve())
    })
  )

const sessionWith = async (
  transport: "native" | "tls",
  use: (control: Control, socket: Socket, requests: Socket) => Promise<void>
): Promise<void> => {
  const control = new Control(transport)
  let socket: Socket | undefined
  let requests: Socket | undefined
  try {
    await bounded(control.listening)
    socket = await connected(control)
    requests = await connected(control, true)
    await bounded(control.requestsReady.promise)
    await use(control, socket, requests)
  } finally {
    socket?.destroy()
    requests?.destroy()
    control.dispose()
  }
}

const ready = { type: "ready", version: 1, pid: 4242 }
const spawned = { type: "spawned", pid: 4243 }
const exited = { type: "exit", code: 0, signal: null }

describe.skipIf(process.platform === "win32")("native process control temporary directory", () => {
  it("creates private control sockets in the selected TMPDIR", async () => {
    const previous = process.env.TMPDIR
    const directory = mkdtempSync(join(tmpdir(), "owner-temp-"))
    let control: Control | undefined
    try {
      process.env.TMPDIR = directory
      control = new Control()
      await bounded(control.listening)
      expect(control.directory.startsWith(directory + "/")).toBe(true)
      expect(statSync(control.directory).mode & 0o777).toBe(0o700)
      expect(existsSync(control.path)).toBe(true)
    } finally {
      control?.dispose()
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it.each(["darwin", "linux"])(
    "refuses an overlong %s private socket path without creating state elsewhere",
    (platform) => {
      const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!
      const previous = process.env.TMPDIR
      const directory = mkdtempSync(join(tmpdir(), "owner-long-"))
      const long = join(directory, "private-".repeat(16))
      mkdirSync(long)
      let control: Control | undefined
      try {
        process.env.TMPDIR = long
        Object.defineProperty(process, "platform", { value: platform, configurable: true })
        expect(() => {
          control = new Control()
        }).toThrow(/private TMPDIR.*Unix socket/)
        expect(readdirSync(long)).toEqual([])
      } finally {
        control?.dispose()
        if (previous === undefined) delete process.env.TMPDIR
        else process.env.TMPDIR = previous
        rmSync(directory, { recursive: true, force: true })
        Object.defineProperty(process, "platform", originalPlatform)
      }
    }
  )

  it("connects through the same Unix transport in a deep private workspace directory", async () => {
    const previous = process.env.TMPDIR
    const base = join(process.cwd(), ".artifacts")
    mkdirSync(base, { recursive: true })
    const directory = mkdtempSync(join(base, "native-control-"))
    const deep = join(directory, "nested", "private", "tmp")
    mkdirSync(deep, { recursive: true })
    let control: Control | undefined
    let socket: Socket | undefined
    try {
      process.env.TMPDIR = deep
      control = new Control()
      await bounded(control.listening)
      expect(Buffer.byteLength(control.path)).toBeGreaterThan(103)
      expect(control.directory.startsWith(deep + "/")).toBe(true)
      socket = await connected(control)
      expect(control.ownerLocation().cwd).toBe(control.directory)
      expect(Buffer.byteLength(control.ownerLocation().path)).toBeLessThanOrEqual(103)
    } finally {
      socket?.destroy()
      control?.dispose()
      if (previous === undefined) delete process.env.TMPDIR
      else process.env.TMPDIR = previous
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe.each(process.platform === "win32" ? ["native" as const] : ["native", "tls"] as const)(
  "private process lifetime protocol (%s)",
  (transport) => {
    const session = (use: (control: Control, socket: Socket, requests: Socket) => Promise<void>) =>
      sessionWith(transport, use)

    it("stores an early READY and withdraws the owned socket before activation", () =>
      session(async (control, socket, requests) => {
        if (transport === "native" && process.platform !== "win32") {
          expect(statSync(control.directory).mode & 0o777).toBe(0o700)
        } else expect(readdirSync(control.directory)).toEqual([])
        await send(socket, ready)
        expect(await bounded(control.ready.promise)).toBe(4242)
        expect(() => control.withdraw(4242, 4244)).toThrowError(
          expect.objectContaining({ _tag: "@smthrs/platform-node/ProcessFault", code: "identity_mismatch" })
        )
        expect(existsSync(control.directory)).toBe(true)
        // Node's server.close() may already unlink this UNIX socket. Withdrawing
        // it must still succeed, and an accepted connection remains usable.
        control.withdraw(4242, 4242)
        expect(existsSync(control.path)).toBe(false)
        expect(existsSync(control.requestPath)).toBe(false)
        expect(existsSync(control.directory)).toBe(false)
        const received = once(requests, "data")
        await control.write({ type: "configure", command: "literal", args: ["a b"] })
        expect(String((await bounded(received))[0])).toBe(
          "{\"type\":\"configure\",\"command\":\"literal\",\"args\":[\"a b\"]}\n"
        )
        control.activationSent = true
        await send(socket, spawned, exited)
        await bounded(control.started.promise)
        expect(control.targetPid).toBe(4243)
        expect(await bounded(control.exited.promise)).toBe(0)
      }))

    it("acknowledges cleanup only after consuming the preceding terminal status", () =>
      session(async (control, socket, requests) => {
        let delivered: Promise<void> | undefined
        control.onCleanup = () => {
          expect(control.targetDone).toBe(true)
          delivered = control.write({ type: "cleanup_ack" })
        }
        control.activationSent = true
        const receipt = once(requests, "data")
        await send(socket, ready, spawned, exited, { type: "cleanup" })
        expect(String((await bounded(receipt))[0])).toBe("{\"type\":\"cleanup_ack\"}\n")
        await bounded(delivered!)
        expect(await bounded(control.exited.promise)).toBe(0)
      }))

    it("accepts fragmented frames and preserves a target exit buffered after raw owner exit", () =>
      session(async (control, socket) => {
        let exits = 0
        control.onTargetExit = () => {
          exits++
        }
        socket.write("{\"type\":\"rea")
        socket.write("dy\",\"version\":1,\"pid\":4242}\n")
        expect(await bounded(control.ready.promise)).toBe(4242)
        control.activationSent = true
        control.rawEnded()
        expect(control.ownerDone).toBe(true)
        await send(socket, spawned, { ...exited, code: 23 })
        socket.end()
        expect(await bounded(control.exited.promise)).toBe(23)
        await bounded(control.ended.promise)
        expect(exits).toBe(1)
        expect(control.fault).toBeUndefined()
      }))

    it("rejects a second connection without displacing the accepted owner", () =>
      session(async (control, socket) => {
        await send(socket, ready)
        await bounded(control.ready.promise)
        const second = await connected(control)
        try {
          await bounded(once(second, "close"))
          control.activationSent = true
          await send(socket, spawned, exited)
          expect(await bounded(control.exited.promise)).toBe(0)
        } finally {
          second.destroy()
        }
      }))

    it("rejects a second request connection without displacing the accepted owner", () =>
      session(async (control, _socket, requests) => {
        const second = await connected(control, true)
        try {
          await bounded(once(second, "close"))
          const received = once(requests, "data")
          await control.write({ type: "stop" })
          expect(String((await bounded(received))[0])).toBe("{\"type\":\"stop\"}\n")
        } finally {
          second.destroy()
        }
      }))

    it("keeps receiving exit and cleanup after the request channel closes", () =>
      session(async (control, socket, requests) => {
        control.activationSent = true
        await send(socket, ready, spawned)
        await bounded(control.started.promise)
        const closed = once(control.requestSocket!, "close")
        requests.end()
        await bounded(closed)
        await expect(control.write({ type: "stop" })).rejects.toMatchObject({
          _tag: "@smthrs/platform-node/ProcessFault",
          code: "control_channel_closed"
        })
        expect(control.socket!.destroyed).toBe(false)
        await send(socket, exited, { type: "cleanup" })
        socket.end()
        expect(await bounded(control.exited.promise)).toBe(0)
        await bounded(control.ended.promise)
        expect(control.cleanupAcknowledged).toBe(true)
      }))

    it("settles every pending outcome when the raw owner exits before connecting", async () => {
      const control = new Control(transport)
      try {
        await bounded(control.listening)
        control.rawEnded()
        await bounded(control.ended.promise)
        await expect(control.ready.promise).rejects.toMatchObject({
          _tag: "@smthrs/platform-node/ProcessFault",
          code: "outcome_missing"
        })
        await expect(control.started.promise).rejects.toThrow("closed before reporting")
        await expect(control.exited.promise).rejects.toThrow("closed before reporting")
        await expect(control.write({ type: "start" })).rejects.toThrow("channel closed")
        expect(control.ownerDone).toBe(true)
      } finally {
        control.dispose()
      }
    })

    it("preserves a native status socket failure for pending readers", () =>
      session(async (control, socket) => {
        control.activationSent = true
        await send(socket, ready, spawned)
        await bounded(control.started.promise)
        const failure = Object.assign(new Error("status connection reset"), { code: "ECONNRESET" })
        control.socket!.destroy(failure)
        await bounded(control.ended.promise)
        await expect(control.exited.promise).rejects.toBe(failure)
        await expect(control.lost.promise).rejects.toBe(failure)
        expect(control.fault).toBe(failure)
        expect(control.requestSocket!.destroyed).toBe(true)
        expect(control.cleanupAcknowledged).toBe(false)
      }))

    it("rejects unreported outcomes when an accepted channel closes", () =>
      session(async (control, socket) => {
        await send(socket, ready)
        expect(await bounded(control.ready.promise)).toBe(4242)
        socket.end()
        await bounded(control.ended.promise)
        await expect(control.started.promise).rejects.toThrow("closed before reporting")
        await expect(control.exited.promise).rejects.toThrow("closed before reporting")
        await expect(control.write({ type: "start" })).rejects.toThrow("channel closed")
      }))

    it("retains a native spawn failure and resolves termination after its channel closes", () =>
      session(async (control, socket) => {
        await send(socket, ready)
        await bounded(control.ready.promise)
        control.activationSent = true
        const failure = { type: "spawn_error", code: "ENOENT", message: "missing command", syscall: "spawn literal" }
        await send(socket, failure)
        await expect(bounded(control.started.promise)).rejects.toEqual(failure)
        await expect(control.exited.promise).rejects.toEqual(failure)
        expect(control.spawnFailed).toBe(true)
        expect(control.targetPid).toBeUndefined()
        socket.end()
        await bounded(control.ended.promise)
        expect(control.fault).toEqual(failure)
      }))

    it("preserves a target signal as a failure and notifies automatic cleanup once", () =>
      session(async (control, socket) => {
        let exits = 0
        control.onTargetExit = () => {
          exits++
        }
        control.activationSent = true
        await send(socket, ready, spawned, { type: "exit", code: null, signal: "SIGINT" })
        await bounded(control.started.promise)
        await expect(bounded(control.exited.promise)).rejects.toMatchObject({ signal: "SIGINT" })
        expect(control.targetDone).toBe(true)
        expect(exits).toBe(1)
      }))

    it("reports a helper fault to all still-pending launch and exit waiters", () =>
      session(async (control, socket) => {
        const fault = { type: "fault", message: "configuration refused", code: "EINVAL" }
        await send(socket, fault)
        await expect(bounded(control.started.promise)).rejects.toEqual(fault)
        await expect(control.exited.promise).rejects.toEqual(fault)
        socket.end()
        await bounded(control.ended.promise)
        await expect(control.ready.promise).rejects.toEqual(fault)
      }))

    it("does not treat a cleanup announcement as proof that the target exited", () =>
      session(async (control, socket) => {
        await send(socket, { type: "cleanup" }, ready)
        await bounded(control.ready.promise)
        expect(control.cleanupAcknowledged).toBe(true)
        expect(control.targetDone).toBe(false)
        expect(control.ownerDone).toBe(false)
        control.activationSent = true
        await send(socket, spawned, exited)
        expect(await bounded(control.exited.promise)).toBe(0)
      }))

    it("keeps cleanup failure separate from the target's reported exit status", () =>
      session(async (control, socket) => {
        control.activationSent = true
        const failure = { type: "cleanup_error", message: "An escaped child could not be verified" }
        await send(socket, ready, spawned, exited, failure)
        expect(await bounded(control.exited.promise)).toBe(0)
        socket.end()
        await bounded(control.ended.promise)
        expect(control.cleanupFailed).toBe(true)
        expect(control.fault).toEqual(failure)
        expect(control.targetDone).toBe(true)
      }))

    const invalid: ReadonlyArray<{
      readonly name: string
      readonly values: ReadonlyArray<unknown>
      readonly activated?: boolean
      readonly message: string
    }> = [
      { name: "null", values: [null], message: "Invalid process status" },
      { name: "primitive", values: [1], message: "Invalid process status" },
      { name: "unknown type", values: [{ type: "unknown" }], message: "Unknown process status" },
      { name: "wrong ready version", values: [{ ...ready, version: 2 }], message: "Invalid process readiness" },
      { name: "unsafe ready pid", values: [{ ...ready, pid: 2 ** 53 }], message: "Invalid process readiness" },
      { name: "reserved ready pid", values: [{ ...ready, pid: 1 }], message: "Invalid process readiness" },
      { name: "duplicate ready", values: [ready, ready], message: "Invalid process readiness" },
      { name: "startup before activation", values: [ready, spawned], message: "Invalid target startup" },
      {
        name: "unsafe target pid",
        values: [{ ...spawned, pid: 2 ** 53 }],
        activated: true,
        message: "Invalid target startup"
      },
      {
        name: "reserved target pid",
        values: [{ ...spawned, pid: 1 }],
        activated: true,
        message: "Invalid target startup"
      },
      {
        name: "duplicate startup",
        values: [ready, spawned, spawned],
        activated: true,
        message: "Invalid target startup"
      },
      {
        name: "spawn failure before activation",
        values: [{ type: "spawn_error" }],
        message: "Invalid target spawn failure"
      },
      {
        name: "spawn failure after startup",
        values: [spawned, { type: "spawn_error" }],
        activated: true,
        message: "Invalid target spawn failure"
      },
      { name: "exit before startup", values: [exited], message: "Invalid target exit status" },
      {
        name: "duplicate exit",
        values: [spawned, exited, exited],
        activated: true,
        message: "Invalid target exit status"
      },
      {
        name: "negative exit status",
        values: [spawned, { ...exited, code: -1 }],
        activated: true,
        message: "Invalid target exit status"
      },
      {
        name: "fractional exit status",
        values: [spawned, { ...exited, code: 0.5 }],
        activated: true,
        message: "Invalid target exit status"
      },
      {
        name: "status and signal",
        values: [spawned, { ...exited, signal: "SIGINT" }],
        activated: true,
        message: "Invalid target exit status"
      },
      {
        name: "missing signal",
        values: [spawned, { ...exited, code: null }],
        activated: true,
        message: "Invalid target exit status"
      },
      {
        name: "malformed signal",
        values: [spawned, { code: null, signal: "TERM", type: "exit" }],
        activated: true,
        message: "Invalid target exit status"
      }
    ]
    for (const test of invalid) {
      it(`closes the channel on ${test.name}`, () =>
        session(async (control, socket) => {
          control.activationSent = test.activated ?? false
          await send(socket, ...test.values)
          await bounded(control.ended.promise)
          expect(control.fault).toBeInstanceOf(Error)
          expect((control.fault as Error).message).toBe(test.message)
          expect(control.socket?.destroyed).toBe(true)
        }))
    }

    for (const frame of ["{broken json}\n", "x".repeat(16 * 1024 + 1), "é".repeat(8 * 1024 + 1)]) {
      it(`bounds and refuses malformed raw data (${Buffer.byteLength(frame)} bytes)`, () =>
        session(async (control, socket) => {
          socket.write(frame)
          await bounded(control.ended.promise)
          expect(control.fault).toBeInstanceOf(Error)
          await expect(control.ready.promise).rejects.toBe(control.fault)
          await expect(control.started.promise).rejects.toBe(control.fault)
          await expect(control.exited.promise).rejects.toBe(control.fault)
        }))
    }

    it("rejects excessive configuration locally while preserving the usable channel", () =>
      session(async (control, socket, requests) => {
        await send(socket, ready)
        await bounded(control.ready.promise)
        await expect(control.write({ type: "configure", command: "x".repeat(4 * 1024 * 1024) }))
          .rejects.toMatchObject({ _tag: "@smthrs/platform-node/ProcessFault", code: "configuration_too_large" })
        const received = once(requests, "data")
        await control.write({ type: "stop" })
        expect(String((await bounded(received))[0])).toBe("{\"type\":\"stop\"}\n")
      }))
  }
)

describe("authenticated loopback process channels", () => {
  it("starts a real isolated owner without passing its channel key to the target", async () => {
    const result = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
      const prepared = yield* prepare(
        { platform: process.platform, snapshot: () => undefined, vacant: () => false },
        policy,
        "tls"
      )(
        ChildProcess.make(process.execPath, [
          "-e",
          "process.stdout.write(JSON.stringify([process.env.ONLY,process.env.SMITHERS_PROCESS_CHANNEL??null,process.env.SMITHERS_PROCESS_JOB_HELPER??null]))"
        ], {
          detached: false,
          env: { ONLY: "target" },
          extendEnv: false
        }),
        (command) => PipedProcess.spawn(command as ChildProcess.StandardCommand, undefined, true)
      )
      yield* prepared.activate
      return yield* Effect.all([
        prepared.handle.stdout.pipe(Stream.decodeText(), Stream.mkString),
        prepared.handle.exitCode
      ], { concurrency: "unbounded" })
    })))
    expect(result).toEqual(["[\"target\",null,null]", 0])
  })

  it.each(["wrong-key", "wrong-identity"])("refuses %s before exposing protocol data", async (fault) => {
    const control = new Control("tls")
    try {
      await bounded(control.listening)
      const config = JSON.parse(control.environment().SMITHERS_PROCESS_CHANNEL!) as { key: string; status: number }
      const socket = Tls.connect({
        minVersion: "TLSv1.3",
        maxVersion: "TLSv1.3",
        ciphers: "TLS_AES_128_GCM_SHA256",
        host: "127.0.0.1",
        port: config.status,
        pskCallback: () => ({
          identity: fault === "wrong-identity" ? "intruder" : "smithers-owner",
          psk: fault === "wrong-key" ? Buffer.alloc(32) : Buffer.from(config.key, "hex")
        })
      })
      const data: Buffer[] = []
      socket.on("data", (chunk) => data.push(Buffer.from(chunk)))
      socket.on("error", () => {})
      await bounded(new Promise<void>((resolve) => socket.once("close", () => resolve())))
      expect(data).toEqual([])
      expect(control.socket).toBeUndefined()
      const owner = await connected(control)
      await send(owner, ready)
      expect(await bounded(control.ready.promise)).toBe(4242)
      owner.destroy()
    } finally {
      control.dispose()
    }
  })
})
