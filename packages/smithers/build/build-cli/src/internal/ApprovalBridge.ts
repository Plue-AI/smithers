/**
 * Hands a parent's approval store to the build CLIs it launches.
 *
 * `smthrs watch` runs every cycle in a fresh standalone build CLI, and a
 * `Repo.Target` runs its child repository's target the same way. Those
 * processes have no approval store of their own, so an approved
 * `approval: "required"` target refused there. The parent serves its store on
 * a private local socket and names it, with a per-process token, in the child
 * environment; the child's store asks the parent and fails closed when the
 * answer is missing or malformed.
 *
 * @since 1.0.0
 */

import * as Data from "effect/Data"
import { randomBytes, timingSafeEqual } from "node:crypto"
import * as Fs from "node:fs/promises"
import * as Net from "node:net"
import * as NodeOs from "node:os"
import * as NodePath from "node:path"
import type { TargetApprovalRequest, TargetApprovals } from "./PackageOptions.ts"

/**
 * The child environment variable naming the parent's store: `<token>@<socket>`.
 *
 * @category constants
 * @since 1.0.0
 */
export const environmentName = "SMTHRS_APPROVALS_BRIDGE"

/**
 * The approval bridge could not carry a question or its answer; a child
 * treats it as an unreadable store and refuses.
 *
 * @category errors
 * @since 1.0.0
 */
export class ApprovalBridgeError extends Data.TaggedError("smithers-build/ApprovalBridgeError")<{
  readonly message: string
}> {}

/** Longest request or answer line either side accepts. */
const lineLimit = 64 * 1024

/**
 * One served store: the environment a child needs to reach it.
 *
 * @category models
 * @since 1.0.0
 */
export interface Bridge {
  readonly environment: Readonly<Record<string, string>>
  readonly close: () => Promise<void>
}

const isRequest = (value: unknown): value is TargetApprovalRequest => {
  const request = value as Partial<Record<keyof TargetApprovalRequest, unknown>> | null
  return typeof request === "object" && request !== null && typeof request.root === "string" &&
    typeof request.label === "string" && typeof request.digest === "string"
}

/** Reads one newline-terminated line, bounded; resolves undefined when the peer closes first. */
const readLine = (socket: Net.Socket): Promise<string | undefined> =>
  new Promise((resolve, reject) => {
    let buffered = ""
    const done = (value: string | undefined, error?: Error) => {
      socket.off("data", data)
      socket.off("end", end)
      socket.off("error", failed)
      if (error === undefined) resolve(value)
      else reject(error)
    }
    const data = (chunk: Buffer) => {
      buffered += chunk.toString("utf8")
      const newline = buffered.indexOf("\n")
      if (newline !== -1) done(buffered.slice(0, newline))
      else if (buffered.length > lineLimit) {
        done(undefined, new ApprovalBridgeError({ message: "approval bridge line is too long" }))
      }
    }
    const end = () => done(undefined)
    const failed = (error: Error) => done(undefined, error)
    socket.on("data", data)
    socket.on("end", end)
    socket.on("error", failed)
  })

/**
 * Serves `store` to child processes. Without a store the environment is empty,
 * so children keep refusing approval-required targets.
 *
 * @category execution
 * @since 1.0.0
 */
export const serve = async (store: TargetApprovals | undefined): Promise<Bridge> => {
  if (store === undefined) return { environment: {}, close: async () => {} }
  const token = randomBytes(32).toString("hex")
  const expected = Buffer.from(token)
  let directory: string | undefined
  let path: string
  if (process.platform === "win32") {
    path = `\\\\.\\pipe\\smthrs-approvals-${randomBytes(16).toString("hex")}`
  } else {
    // Socket paths are limited to about 100 bytes; a long TMPDIR falls back to /tmp.
    const base = NodeOs.tmpdir().length > 60 ? "/tmp" : NodeOs.tmpdir()
    directory = await Fs.mkdtemp(NodePath.join(base, "smthrs-approvals-"))
    path = NodePath.join(directory, "s")
  }
  const sockets = new Set<Net.Socket>()
  let closing = false
  const server = Net.createServer((socket) => {
    if (closing) return socket.destroy()
    sockets.add(socket)
    socket.once("close", () => sockets.delete(socket))
    void (async () => {
      let answer: { readonly granted: boolean } | { readonly error: string }
      try {
        const line = await readLine(socket)
        const message = JSON.parse(line ?? "null") as { readonly token?: unknown; readonly request?: unknown } | null
        const presented = Buffer.from(typeof message?.token === "string" ? message.token : "")
        if (presented.length !== expected.length || !timingSafeEqual(presented, expected)) {
          answer = { error: "unauthorized" }
        } else if (!isRequest(message?.request)) {
          answer = { error: "malformed request" }
        } else {
          const { root, label, digest } = message.request
          answer = { granted: (await store.granted({ root, label, digest })) === true }
        }
      } catch (cause) {
        answer = { error: cause instanceof Error ? cause.message : String(cause) }
      }
      // Drain anything further so the peer's close is seen and the socket ends.
      socket.resume()
      socket.end(`${JSON.stringify(answer)}\n`)
    })()
  })
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(path, () => {
      server.off("error", reject)
      resolve()
    })
  })
  return {
    environment: { [environmentName]: `${token}@${path}` },
    close: async () => {
      closing = true
      const closed = new Promise<void>((resolve) => server.close(() => resolve()))
      // A child that never finished its question must not hold the parent open.
      for (const socket of sockets) socket.destroy()
      await closed
      if (directory !== undefined) await Fs.rm(directory, { recursive: true, force: true })
    }
  }
}

/**
 * Serves `store` for the duration of `run`, which receives the child environment.
 *
 * @category execution
 * @since 1.0.0
 */
export const withBridge = async <A>(
  store: TargetApprovals | undefined,
  run: (environment: Readonly<Record<string, string>>) => Promise<A>
): Promise<A> => {
  const bridge = await serve(store)
  try {
    return await run(bridge.environment)
  } finally {
    await bridge.close()
  }
}

/**
 * The store a child reaches through its parent, from the value of
 * {@link environmentName}; `undefined` when the parent served none.
 *
 * @category constructors
 * @since 1.0.0
 */
export const client = (value: string | undefined): TargetApprovals | undefined => {
  const separator = value?.indexOf("@") ?? -1
  if (value === undefined || separator <= 0) return undefined
  const token = value.slice(0, separator)
  const path = value.slice(separator + 1)
  return {
    granted: async (request) => {
      const socket = Net.createConnection(path)
      try {
        await new Promise<void>((resolve, reject) => {
          socket.once("connect", resolve)
          socket.once("error", reject)
        })
        socket.write(`${JSON.stringify({ token, request })}\n`)
        const line = await readLine(socket)
        const answer = JSON.parse(line ?? "null") as { readonly granted?: unknown; readonly error?: unknown } | null
        if (typeof answer?.granted === "boolean") return answer.granted
        throw new ApprovalBridgeError({
          message: `the parent approval store did not answer: ${String(answer?.error ?? "no answer")}`
        })
      } finally {
        socket.destroy()
      }
    }
  }
}
