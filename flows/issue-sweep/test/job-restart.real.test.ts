import type { Sandbox } from "@smthrs/sandbox"
import assert from "node:assert/strict"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("job-host.ts", import.meta.url))
const launch = (directory: string, backend: string, mode: string, key: string) =>
  spawn(process.execPath, [fixture, directory, backend, mode, key], { env: process.env })
interface Receipt {
  status: string
  handle: Sandbox.JobHandle
  result: Sandbox.JobResult
  cached: Sandbox.JobResult
  removed: Sandbox.JobStatus
}
const receipt = (child: ChildProcessWithoutNullStreams, status: string): Promise<Receipt> =>
  new Promise((resolve, reject) => {
    let out = ""
    let err = ""
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`missing ${status}: ${err}`))
    }, 20 * 60_000)
    child.stderr.on("data", (data) => {
      err += String(data)
    })
    child.stdout.on("data", (data) => {
      out += String(data)
      for (const line of out.split("\n")) {
        if (!line.startsWith("{")) continue
        const value = JSON.parse(line) as Receipt
        if (value.status === status) {
          clearTimeout(timeout)
          resolve(value)
          return
        }
      }
    })
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", () => {
      clearTimeout(timeout)
      reject(new Error(`closed before ${status}: ${err}`))
    })
  })

// Run these serially: one retained VM at a time on low-disk development hosts.
for (const backend of ["vm", "cloud"]) {
  test(`${backend} job survives host SIGKILL, starts once, collects durably and removes its machine`, {
    skip: process.env[backend === "vm" ? "SMITHERS_VM_JOB_RESTART" : "SMITHERS_CLOUD_JOB_RESTART"] !== "1",
    timeout: 25 * 60_000
  }, async () => {
    const directory = await mkdtemp(join(tmpdir(), `job-restart-${backend}-`))
    const key = `restart-real-${backend}-${process.pid}-${Date.now()}#g1`
    const children: ChildProcessWithoutNullStreams[] = []
    let completed = false
    try {
      const first = launch(directory, backend, "start", key)
      children.push(first)
      const ready = await receipt(first, "ready")
      const closed = once(first, "close")
      first.kill("SIGKILL")
      await closed
      const second = launch(directory, backend, "restart", key)
      children.push(second)
      const result = await receipt(second, "completed")
      assert.deepEqual(result.handle, ready.handle)
      assert.equal(result.result.exitCode, 0)
      assert.equal(result.result.stderr, "")
      assert.equal(result.result.stdout, "launch-once\nfinished\n")
      assert.equal(result.result.work._tag, "Changed")
      assert.equal(result.result.work.patch.split("+job-edit-once").length - 1, 1)
      assert.deepEqual(result.removed, { _tag: "Lost" })
      assert.deepEqual(result.cached, result.result, "receipt survives machine deletion")
      completed = true
      assert.deepEqual(JSON.parse(await readFile(join(directory, "handle.json"), "utf8")), ready.handle)
    } finally {
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, "close")
          child.kill("SIGKILL")
          await closed
        }
      }
      if (!completed && await readFile(join(directory, "handle.json"), "utf8").then(() => true, () => false)) {
        const cleanup = launch(directory, backend, "cleanup", key)
        await receipt(cleanup, "removed")
      }
      await rm(directory, { recursive: true, force: true })
    }
  })
}
