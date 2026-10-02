import assert from "node:assert/strict"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { once } from "node:events"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("remote-job-host.ts", import.meta.url))
const launch = (directory: string, mode: string) =>
  spawn(process.execPath, [fixture, directory, mode], { env: process.env })
const receipt = (child: ChildProcessWithoutNullStreams, status: string): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let output = "", errors = ""
    // Module startup and the durable job's real 15s probe both consume this budget.
    const timeout = setTimeout(() => {
      child.kill("SIGKILL")
      reject(new Error(`missing ${status}: ${output}\n${errors}`))
    }, 60_000)
    child.stderr.on("data", (chunk) => {
      errors += String(chunk)
    })
    child.stdout.on("data", (chunk) => {
      output += String(chunk)
      for (const line of output.split("\n")) {
        if (!line.startsWith("{")) continue
        const value = JSON.parse(line) as Record<string, unknown>
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
      reject(new Error(`closed before ${status}: ${output}\n${errors}`))
    })
  })
const stop = async (children: ChildProcessWithoutNullStreams[]) => {
  await Promise.all(children.map(async (child) => {
    if (child.exitCode === null && child.signalCode === null) {
      const closed = once(child, "close")
      child.kill("SIGKILL")
      await closed
    }
  }))
}

test(
  "RemoteFix durable host SIGKILL mid-poll reattaches once and collects original caller's work",
  { timeout: 150_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "remote-fix-restart-"))
    const children: ChildProcessWithoutNullStreams[] = []
    try {
      const first = launch(directory, "start")
      children.push(first)
      await receipt(first, "parked")
      const closed = once(first, "close")
      first.kill("SIGKILL")
      await closed
      assert(!String(await readFile(join(directory, "calls"))).includes("cancel:"))
      await writeFile(join(directory, "exited"), "0")
      const second = launch(directory, "restart")
      children.push(second)
      const completed = await receipt(second, "completed")
      assert.deepEqual((completed.value as { result: unknown }).result, {
        agent: "codex",
        account: "account-1",
        report: "Fixed"
      })
      const calls = (await readFile(join(directory, "calls"), "utf8")).trim().split("\n")
      assert.equal(calls.filter((call) => call.startsWith("start:")).length, 1)
      assert.equal(calls.filter((call) => call.startsWith("launch:")).length, 1)
      assert.equal(calls.filter((call) => call.startsWith("collect:")).length, 1)
      assert.equal(calls.filter((call) => call.startsWith("destroy:")).length, 1)
      assert.equal(await readFile(join(directory, "saved-login"), "utf8"), "rotated-login")
    } finally {
      await stop(children)
      await rm(directory, { recursive: true, force: true })
    }
  }
)

test("RemoteFix durable caller cancellation cancels and destroys retained worker", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "remote-fix-cancel-"))
  const children: ChildProcessWithoutNullStreams[] = []
  try {
    const child = launch(directory, "cancel")
    children.push(child)
    await receipt(child, "cancelled")
    const calls = (await readFile(join(directory, "calls"), "utf8")).trim().split("\n")
    const starts = calls.filter((call) => call.startsWith("start:"))
    assert.equal(starts.length, 1)
    const key = starts[0]!.slice("start:".length)
    assert.deepEqual(calls.filter((call) => call.startsWith("cancel:")), [`cancel:${key}`])
    assert.deepEqual(calls.filter((call) => call.startsWith("destroy:")), [`destroy:${key}`])
    assert.equal(calls.filter((call) => call.startsWith("collect:")).length, 0)
  } finally {
    await stop(children)
    await rm(directory, { recursive: true, force: true })
  }
})
