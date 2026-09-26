/**
 * The two process primitives the TUI needs, over `node:child_process` so the
 * same source runs on Node and Bun: `which` scans `PATH` like `Bun.which`, and
 * `spawn` exposes stdout as a web stream with an `exited` status like
 * `Bun.spawn`.
 */
import { spawn as spawnChild } from "node:child_process"
import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import { Readable } from "node:stream"

/** Stop an owned POSIX process group, including children that closed their pipes. */
export const stopGroup = async (pid: number, graceMs = 1000): Promise<void> => {
  const signal = (value: NodeJS.Signals | 0): boolean => {
    try { process.kill(-pid, value); return true }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false
      throw error
    }
  }
  if (!signal("SIGTERM")) return
  const deadline = Date.now() + graceMs
  while (signal(0)) {
    if (Date.now() >= deadline) { signal("SIGKILL"); return }
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const executable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK)
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The absolute path `command` resolves to on `PATH`, or `null`. */
export const which = (
  command: string,
  environment: Record<string, string | undefined>
): string | null => {
  const extensions = process.platform === "win32"
    ? ["", ...(environment["PATHEXT"] ?? ".EXE;.CMD;.BAT;.COM").split(";")]
    : [""]
  if (command.includes("/") || (process.platform === "win32" && command.includes("\\"))) {
    return extensions.map((extension) => command + extension).find(executable) ?? null
  }
  for (const directory of (environment["PATH"] ?? "").split(delimiter)) {
    if (directory === "") continue
    for (const extension of extensions) {
      const candidate = join(directory, command + extension)
      if (executable(candidate)) return candidate
    }
  }
  return null
}

export interface Child {
  readonly stdout: ReadableStream<Uint8Array>
  /** The exit status; rejects when the program cannot start. */
  readonly exited: Promise<number>
  readonly kill: () => void
}

/** Runs `command` with stdout piped and stdin and stderr ignored. */
export const spawn = (
  command: ReadonlyArray<string>,
  options: { readonly cwd: string; readonly env?: Record<string, string | undefined> }
): Child => {
  const child = spawnChild(command[0]!, command.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "ignore"]
  })
  const exited = new Promise<number>((resolve, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolve(code ?? 1))
  })
  // A start failure also surfaces through the stream; `exited` carries it.
  exited.catch(() => {})
  return {
    stdout: Readable.toWeb(child.stdout) as unknown as ReadableStream<Uint8Array>,
    exited,
    kill: () => {
      child.kill()
    }
  }
}
