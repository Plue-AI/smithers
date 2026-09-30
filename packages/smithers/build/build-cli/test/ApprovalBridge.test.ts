/**
 * The approval bridge a parent CLI serves its store through: a child's
 * `granted` reaches the parent's store for the exact request, and every
 * failure (no store, wrong token, a store error, a closed bridge, a malformed
 * answer) refuses rather than approving.
 */
import * as Fs from "node:fs/promises"
import * as Net from "node:net"
import * as Path from "node:path"
import { describe, expect, it } from "vitest"
import * as ApprovalBridge from "../src/internal/ApprovalBridge.ts"
import type * as PackageExec from "../src/PackageExec.ts"

const request: PackageExec.TargetApprovalRequest = { root: "/work", label: "//:push", digest: "a".repeat(64) }

const recording = (answer: (request: PackageExec.TargetApprovalRequest) => Promise<boolean>) => {
  const asked: Array<PackageExec.TargetApprovalRequest> = []
  const store: PackageExec.TargetApprovals = {
    granted: (request) => {
      asked.push(request)
      return answer(request)
    }
  }
  return { store, asked }
}

const address = (environment: Readonly<Record<string, string>>) => {
  const value = environment[ApprovalBridge.environmentName]!
  return { token: value.slice(0, value.indexOf("@")), path: value.slice(value.indexOf("@") + 1) }
}

/** Sends one raw line to the bridge and returns its raw answer. */
const raw = (path: string, line: string) =>
  new Promise<string>((resolve, reject) => {
    const socket = Net.createConnection(path, () => socket.write(line))
    let text = ""
    socket.on("data", (chunk) => text += chunk.toString("utf8"))
    socket.on("end", () => resolve(text))
    socket.on("error", reject)
  })

describe("approval bridge", () => {
  it("serves no store as an empty environment, and a child without one has no store", async () => {
    const bridge = await ApprovalBridge.serve(undefined)
    expect(bridge.environment).toEqual({})
    await bridge.close()
    for (const value of [undefined, "", "@/path", "no-separator"]) expect(ApprovalBridge.client(value)).toBeUndefined()
  })

  it("answers a child's question from the parent's store, for the exact request", async () => {
    const { store, asked } = recording(async (asking) => asking.digest === request.digest)
    await ApprovalBridge.withBridge(store, async (environment) => {
      const client = ApprovalBridge.client(environment[ApprovalBridge.environmentName])!
      expect(await client.granted(request)).toBe(true)
      expect(await client.granted({ ...request, digest: "b".repeat(64) })).toBe(false)
      // Concurrent questions each get their own answer.
      expect(await Promise.all([client.granted(request), client.granted({ ...request, label: "//:x" })]))
        .toEqual([true, true])
    })
    expect(asked[0]).toEqual(request)
    expect(asked).toHaveLength(4)
  })

  it("keeps the socket in a private directory and removes it on close", async () => {
    const bridge = await ApprovalBridge.serve(recording(async () => true).store)
    const { path } = address(bridge.environment)
    if (process.platform !== "win32") {
      expect(path.length).toBeLessThan(100)
      expect((await Fs.stat(Path.dirname(path))).mode & 0o077).toBe(0)
    }
    await bridge.close()
    await expect(ApprovalBridge.client(bridge.environment[ApprovalBridge.environmentName])!.granted(request))
      .rejects.toThrow()
    if (process.platform !== "win32") await expect(Fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" })
  })

  it("refuses a wrong token and never asks the store", async () => {
    const { store, asked } = recording(async () => true)
    await ApprovalBridge.withBridge(store, async (environment) => {
      const { path, token } = address(environment)
      const forged = ApprovalBridge.client(`${"0".repeat(token.length)}@${path}`)!
      await expect(forged.granted(request)).rejects.toThrow("unauthorized")
      await expect(ApprovalBridge.client(`short@${path}`)!.granted(request)).rejects.toThrow("unauthorized")
    })
    expect(asked).toEqual([])
  })

  it("fails closed when the parent's store fails", async () => {
    for (
      const answer of [
        () => Promise.reject(new Error("store unreadable")),
        () => Promise.reject("not an error")
      ]
    ) {
      await ApprovalBridge.withBridge(recording(answer).store, async (environment) => {
        const client = ApprovalBridge.client(environment[ApprovalBridge.environmentName])!
        await expect(client.granted(request)).rejects.toThrow("did not answer")
      })
    }
  })

  it("refuses malformed requests and answers only a boolean", async () => {
    const { store, asked } = recording(async () => "yes" as unknown as boolean)
    await ApprovalBridge.withBridge(store, async (environment) => {
      const { path, token } = address(environment)
      expect(JSON.parse(await raw(path, `${JSON.stringify({ token, request: { label: 1 } })}\n`)))
        .toEqual({ error: "malformed request" })
      expect(JSON.parse(await raw(path, `${JSON.stringify({ token, request: null })}\n`)))
        .toEqual({ error: "malformed request" })
      expect(JSON.parse(await raw(path, "not json\n"))).toMatchObject({ error: expect.any(String) })
      expect(JSON.parse(await raw(path, `${"x".repeat(70 * 1024)}`))).toEqual({
        error: "approval bridge line is too long"
      })
      // A store answering anything but true is not an approval.
      expect(JSON.parse(await raw(path, `${JSON.stringify({ token, request })}\n`))).toEqual({ granted: false })
    })
    expect(asked).toHaveLength(1)
  })

  it("closes while a child holds an unfinished question", async () => {
    const bridge = await ApprovalBridge.serve(recording(async () => true).store)
    const { path } = address(bridge.environment)
    const socket = Net.createConnection(path).resume()
    await new Promise((resolve) => socket.once("connect", resolve))
    const dropped = new Promise((resolve) => socket.once("close", resolve))
    socket.write("{\"token\":")
    await bridge.close()
    await dropped
  })

  it("rejects an answer that is not a verdict", async () => {
    const directory = await Fs.mkdtemp("/tmp/smthrs-bridge-test-")
    const path = `${directory}/s`
    for (const reply of ["{}\n", "null\n", ""]) {
      const server = Net.createServer((socket) => {
        socket.resume()
        socket.end(reply)
      })
      await new Promise<void>((resolve) => server.listen(path, resolve))
      try {
        await expect(ApprovalBridge.client(`token@${path}`)!.granted(request)).rejects.toThrow("did not answer")
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
      }
    }
    await Fs.rm(directory, { recursive: true, force: true })
  })
})
