import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const native = vi.hoisted(() => ({ spawn: vi.fn(), resolve: vi.fn(), usable: vi.fn() }))
vi.mock("node:child_process", () => ({ spawn: native.spawn }))
// The real configured-helper resolver runs over the mocked `usableExecutable`.
vi.mock("../src/internal/AtomicFileSystemExecutable.ts", async (load) => ({
  ...await load<typeof import("../src/internal/AtomicFileSystemExecutable.ts")>(),
  packageRoot: "/package",
  resolveDefaultExecutable: native.resolve
}))
vi.mock("../src/internal/AtomicFileSystemTransport.ts", () => ({ usableExecutable: native.usable }))
import { resolveJobExecutable, WindowsProcessJob } from "../src/internal/WindowsProcessJob.ts"

const pipe = () => Object.assign(new PassThrough(), { ref: vi.fn(), unref: vi.fn() })
const child = () =>
  Object.assign(new EventEmitter(), {
    stdin: pipe(),
    stdout: pipe(),
    stderr: pipe(),
    ref: vi.fn(),
    unref: vi.fn()
  })
let processChild: ReturnType<typeof child>
const identity = "123456789012345678"
const frame = (value: unknown) => processChild.stdout.write(JSON.stringify(value) + "\n")
const ready = { status: "ready", ownerPid: 4321 }
const settled = { status: "settled" }

beforeEach(() => {
  vi.stubEnv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", undefined)
  native.resolve.mockReturnValue("/trusted/helper")
  native.usable.mockReturnValue("/configured/helper")
  processChild = child()
  native.spawn.mockReturnValue(processChild)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

describe("Windows native job connection", () => {
  it("pins the exact identity before attachment and requires an empty-job receipt plus successful close", async () => {
    const job = new WindowsProcessJob(4321, identity, resolveJobExecutable())
    expect(native.resolve).toHaveBeenCalledWith("/package", undefined)
    expect(native.spawn).toHaveBeenCalledWith(
      "/trusted/helper",
      ["--process-job", "4321", "123456789012345678"],
      expect.objectContaining({ env: {}, stdio: ["pipe", "pipe", "pipe"] })
    )
    let done = false
    void job.settled.promise.then(() => {
      done = true
    })
    processChild.stdout.write("{\"status\":\"rea")
    processChild.stdout.write("dy\",\"ownerPid\":4321}\n{\"status\":\"settled\"}\n")
    await job.ready.promise
    expect(done).toBe(false)
    processChild.emit("close", 0, null)
    await job.settled.promise
    expect(done).toBe(true)
    for (const value of [false, true]) {
      job.reference(value)
      const method = value ? "ref" : "unref"
      for (const object of [processChild, processChild.stdin, processChild.stdout, processChild.stderr]) {
        expect(object[method]).toHaveBeenCalledOnce()
      }
    }
    job.stop()
    expect(processChild.stdin.destroyed).toBe(true)
  })

  it("names the variable and the install hint when the configured helper is unusable", () => {
    vi.stubEnv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", "/config/helper")
    native.usable.mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory")
    })
    expect(() => resolveJobExecutable()).toThrow(
      /^smithers-jj-export is unusable at SMITHERS_WORKSPACE_JJ_EXPORT_BINARY=\/config\/helper: ENOENT.*cargo build --locked/
    )
    expect(native.spawn).not.toHaveBeenCalled()
  })

  it("validates an explicitly configured native helper", async () => {
    vi.stubEnv("SMITHERS_WORKSPACE_JJ_EXPORT_BINARY", "/config/helper")
    const job = new WindowsProcessJob(4321, identity, resolveJobExecutable())
    expect(native.usable).toHaveBeenCalledWith("/config/helper", undefined)
    expect(native.resolve).not.toHaveBeenCalled()
    frame(ready)
    frame(settled)
    processChild.emit("close", 0, null)
    await job.settled.promise
  })

  for (const created of [undefined, null, 123, "", "0", "-1", "1e10", "123456789012345678901"]) {
    it(`refuses an unverified owner-reported identity ${String(created)}`, () => {
      expect(() => new WindowsProcessJob(4321, created, "/trusted/helper")).toThrow()
      expect(native.spawn).not.toHaveBeenCalled()
    })
  }

  for (
    const frames of [
      [settled],
      [{ ...ready, ownerPid: 999 }],
      [ready, ready],
      [ready, settled, settled],
      [null],
      [{ status: "unknown" }]
    ]
  ) {
    it(`refuses out-of-order or malformed status ${JSON.stringify(frames)}`, async () => {
      const job = new WindowsProcessJob(4321, identity, resolveJobExecutable())
      for (const message of frames) frame(message)
      await expect(job.settled.promise).rejects.toThrow("Invalid Windows job status")
      expect(processChild.stdin.destroyed).toBe(true)
      // Further frames cannot rehabilitate an already failed guardian.
      frame(ready)
      processChild.emit("close", 0, null)
    })
  }

  for (const output of ["x".repeat(4097), "invalid\n"]) {
    it("refuses oversized or unparseable output", async () => {
      const job = new WindowsProcessJob(4321, identity, resolveJobExecutable())
      processChild.stdout.write(output)
      await expect(job.ready.promise).rejects.toThrow()
      await expect(job.settled.promise).rejects.toThrow()
    })
  }

  for (const source of ["child", "stdin", "stdout", "stderr"] as const) {
    it(`retains failure from ${source}`, async () => {
      const job = new WindowsProcessJob(4321, identity, resolveJobExecutable())
      const error = new Error("native failure")
      const emitter: EventEmitter = source === "child" ? processChild : processChild[source]
      emitter.emit("error", error)
      await expect(job.ready.promise).rejects.toBe(error)
      await expect(job.settled.promise).rejects.toBe(error)
    })
  }

  for (
    const [code, signal, receipt, trailing] of [
      [1, null, true, ""],
      [null, "SIGKILL", true, ""],
      [0, null, false, ""],
      [0, null, true, "partial"]
    ] as const
  ) {
    it(`requires verified close ${code}/${signal}/${receipt}/${trailing}`, async () => {
      const job = new WindowsProcessJob(4321, identity, resolveJobExecutable())
      frame(ready)
      if (receipt) frame(settled)
      processChild.stdout.write(trailing)
      processChild.emit("close", code, signal)
      await expect(job.settled.promise).rejects.toThrow("cleanup could not be verified")
    })
  }
})
