/**
 * Spawning and reading the engine incarnation the crash family kills.
 *
 * @since 1.0.0
 */
import { type ChildProcess, spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { fileURLToPath } from "node:url"
import type { FlowOptions } from "./killResumeFlow.ts"

const runner = fileURLToPath(new URL("../fixtures/engineChild.ts", import.meta.url))

/**
 * What the child prints on the way out.
 *
 * @since 1.0.0
 * @category models
 */
export type ChildMode = "probe" | "execute"

/**
 * A spawned engine incarnation.
 *
 * @since 1.0.0
 * @category models
 */
export interface EngineChild {
  readonly process: ChildProcess
  readonly pid: number
  /** The nonce this incarnation must echo in its handshake. */
  readonly nonce: string
  readonly stdout: () => string
  readonly stderr: () => string
  /** Resolves with the exit code. */
  readonly exited: Promise<number | null>
  /** Resolves once the handshake line for `mode` has been printed. */
  readonly handshake: Promise<void>
}

/**
 * Spawns one engine incarnation.
 *
 * @since 1.0.0
 * @category constructors
 */
export const spawnEngineChild = (
  options: FlowOptions & { readonly executionId: string; readonly mode: ChildMode }
): EngineChild => {
  const nonce = randomUUID()
  const child = spawn(
    process.execPath,
    [
      runner,
      options.filename,
      options.executionId,
      options.mode,
      options.markerDir,
      options.counterFile,
      String(options.secondSleepMs),
      nonce,
      options.hostId,
      options.crossing ?? "default"
    ],
    { stdio: ["ignore", "pipe", "pipe"] }
  )
  const pid = child.pid
  if (pid === undefined) throw new Error("engine child has no pid")

  let out = ""
  let err = ""
  child.stdout?.setEncoding("utf8")
  child.stderr?.setEncoding("utf8")

  const expected = `SMITHERS_ENGINE_HANDSHAKE=${options.mode}:${nonce}`
  let announce: () => void = () => {}
  let refuse: (cause: unknown) => void = () => {}
  const handshake = new Promise<void>((resolve, reject) => {
    announce = resolve
    refuse = reject
  })
  child.stdout?.on("data", (chunk: string) => {
    out += chunk
    if (out.includes(expected)) announce()
  })
  child.stderr?.on("data", (chunk: string) => {
    err += chunk
  })

  const exited = new Promise<number | null>((resolve) => {
    child.once("exit", (code) => {
      if (!out.includes(expected)) {
        refuse(new Error(`engine child exited (${String(code)}) before its ${options.mode} handshake\n${err}`))
      }
      resolve(code)
    })
  })

  return {
    process: child,
    pid,
    nonce,
    stdout: () => out,
    stderr: () => err,
    exited,
    handshake
  }
}

/**
 * Runs the admission probe and returns once it has proved the runner boots the
 * product. Throws with the child's output when it does not.
 *
 * @since 1.0.0
 * @category constructors
 */
export const probeEngineChild = async (options: FlowOptions & { readonly executionId: string }): Promise<void> => {
  const child = spawnEngineChild({ ...options, mode: "probe" })
  const code = await child.exited
  if (code !== 0 || !child.stdout().includes("PROBE_STATUS=ok")) {
    throw new Error(`engine admission probe failed (${String(code)})\n${child.stdout()}\n${child.stderr()}`)
  }
  if (!child.stdout().includes(`SMITHERS_ENGINE_HANDSHAKE=probe:${child.nonce}`)) {
    throw new Error("engine admission probe did not echo its nonce")
  }
}
