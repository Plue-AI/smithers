/**
 * A native Windows job guardian, attached before the owner can launch a target.
 * @since 1.0.0
 */
import { spawn } from "node:child_process"
import type { Socket } from "node:net"
import { parse } from "node:path"
import { packageRoot, resolveConfiguredExecutable, resolveDefaultExecutable } from "./AtomicFileSystemExecutable.ts"

const deferred = <A>() => {
  let resolve!: (value: A) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<A>((yes, no) => {
    resolve = yes
    reject = no
  })
  void promise.catch(() => {})
  return { promise, resolve, reject }
}

/**
 * Resolve the same trusted helper for the owner's self-observation and guardian.
 * @private
 * @since 1.0.0
 */
export const resolveJobExecutable = (): string => {
  const configured = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
  return configured === undefined
    ? resolveDefaultExecutable(packageRoot, undefined)
    : resolveConfiguredExecutable(configured, undefined)
}

/**
 * Retains the guardian's dedicated control pipe until cleanup. EOF, including
 * host death, terminates the job independently of the Node owner's event loop.
 * @private
 * @since 1.0.0
 */
export class WindowsProcessJob {
  readonly ready = deferred<void>()
  readonly settled = deferred<void>()
  private readonly child
  private receivedReady = false
  private receivedSettled = false
  private failed = false

  constructor(ownerPid: number, created: unknown, executable: string) {
    if (typeof created !== "string" || !/^[1-9][0-9]{0,19}$/.test(created)) {
      throw new Error("Windows process owner has no exact creation identity")
    }
    const options = { cwd: parse(process.execPath).root, env: {}, windowsHide: true }
    this.child = spawn(executable, ["--process-job", String(ownerPid), created], {
      ...options,
      stdio: ["pipe", "pipe", "pipe"]
    })
    let buffer = ""
    this.child.stdout.setEncoding("utf8")
    this.child.stdout.on("data", (data: string) => {
      if (this.failed) return
      try {
        buffer += data
        if (Buffer.byteLength(buffer) > 4096) throw new Error("Windows job status exceeds its bound")
        for (;;) {
          const end = buffer.indexOf("\n")
          if (end < 0) break
          const frame = JSON.parse(buffer.slice(0, end)) as { status?: unknown; ownerPid?: unknown } | null
          buffer = buffer.slice(end + 1)
          if (frame?.status === "ready" && frame.ownerPid === ownerPid && !this.receivedReady) {
            this.receivedReady = true
            this.ready.resolve()
          } else if (frame?.status === "settled" && this.receivedReady && !this.receivedSettled) {
            this.receivedSettled = true
          } else throw new Error("Invalid Windows job status")
        }
      } catch (cause) {
        this.fail(cause)
      }
    })
    // Drain diagnostics without retaining unbounded native output.
    this.child.stderr.resume()
    this.child.once("error", (cause) => this.fail(cause))
    this.child.stdin.on("error", (cause) => this.fail(cause))
    this.child.stdout.on("error", (cause) => this.fail(cause))
    this.child.stderr.on("error", (cause) => this.fail(cause))
    this.child.once("close", (code, signal) => {
      if (!this.failed && code === 0 && signal === null && this.receivedSettled && buffer === "") {
        this.settled.resolve()
      } else this.fail(new Error("Windows job cleanup could not be verified"))
    })
  }

  private fail(cause: unknown): void {
    this.failed = true
    this.ready.reject(cause)
    this.settled.reject(cause)
    this.stop()
  }

  /** Closing this pipe asks the native guardian to terminate its job. */
  stop(): void {
    this.child.stdin.destroy()
  }

  /** Keep the guardian and all three pipes consistent with the host handle. */
  reference(referenced: boolean): void {
    const method = referenced ? "ref" : "unref"
    this.child[method]()
    for (const pipe of [this.child.stdin, this.child.stdout, this.child.stderr]) (pipe as Socket)[method]()
  }
}
