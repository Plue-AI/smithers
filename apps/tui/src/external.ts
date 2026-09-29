/**
 * Leaving the TUI for another program: Ctrl+G's external editor, and the
 * bounded wait on quit.
 */
import { spawn } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Readable } from "node:stream"
import { stopGroup } from "./subprocess.ts"

/**
 * Runs shell `snippet` with `positional` as `$1…` as a foreground job on the
 * real terminal, and resolves with its exit status once it and its whole
 * group are gone. Arguments are never spliced into the snippet.
 */
export const foreground = async (
  snippet: string,
  positional: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly signal?: AbortSignal } = {}
): Promise<number | null> => {
  const { signal } = options
  const interactive = process.stdin.isTTY === true
  // A foreground job owns its own group while keeping the real terminal.
  // fd 3 reports that group; fd 4 preserves the program's stderr while the
  // supervising shell's job announcements stay hidden. Inherit stderr until
  // the shell initializes job control; redirecting it at spawn breaks fg.
  const program =
    `exec 2>/dev/null\nset -m\n( exec 3>&- 2>&4 4>&-; ${snippet} ) &\n__smthrs_editor_pid=$!\nprintf '%s\\n' "$__smthrs_editor_pid" >&3\nexec 3>&-\nfg %1 >/dev/null`
  const child = interactive
    ? spawn("/bin/sh", ["-i", "-c", program, "sh", ...positional], {
      stdio: ["inherit", "inherit", "inherit", "pipe", 2],
      env: { ...process.env, ENV: "" },
      ...(options.cwd === undefined ? {} : { cwd: options.cwd })
    })
    : spawn("/bin/sh", ["-c", snippet, "sh", ...positional], {
      stdio: "inherit",
      detached: true,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd })
    })
  let group = interactive ? undefined : child.pid
  let stopping: Promise<void> | undefined
  const cancel = () => {
    if (group !== undefined && stopping === undefined) {
      stopping = stopGroup(group)
      // Keep a rejection observed while the child is still closing.
      void stopping.catch(() => {})
    }
  }
  let reported = ""
  if (interactive) {
    ;(child.stdio[3] as Readable).on("data", (chunk: Buffer) => {
      reported += chunk.toString()
      if (!reported.includes("\n")) return
      const pid = Number(reported.trim())
      if (Number.isSafeInteger(pid) && pid > 1) group = pid
      if (signal?.aborted) cancel()
    })
  }
  signal?.addEventListener("abort", cancel, { once: true })
  if (signal?.aborted) cancel()
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once("error", reject)
    child.once("close", resolve)
  })
  try {
    const status = await closed
    // A shell can exit while its program is stopped (Ctrl+Z), or while a
    // background child remains. The foreground job owns the whole group.
    if (group !== undefined) stopping ??= stopGroup(group)
    await stopping
    return status
  } finally {
    signal?.removeEventListener("abort", cancel)
  }
}

/**
 * Edits `text` in `editor` (`$VISUAL`/`$EDITOR`, which may carry arguments),
 * in an owner-only temporary file removed afterwards. The file path is passed
 * to the shell as `$1`, never spliced into the command. `undefined` when the
 * editor cancels; shell execution failures reject.
 */
export const edit = async (
  text: string,
  editor: string,
  parent = tmpdir(),
  signal?: AbortSignal
): Promise<string | undefined> => {
  if (signal?.aborted) return undefined
  const folder = mkdtempSync(join(parent, "smithers-editor-"))
  try {
    const file = join(folder, "prompt.md")
    writeFileSync(file, text, { mode: 0o600 })
    const status = await foreground(`${editor} "$1"`, [file], signal === undefined ? {} : { signal })
    if (!signal?.aborted && (status === 126 || status === 127)) throw new Error(`Editor unavailable (exit ${status})`)
    return !signal?.aborted && status === 0 ? readFileSync(file, "utf8").replace(/\n$/, "") : undefined
  } finally {
    rmSync(folder, { recursive: true, force: true })
  }
}

let holder: Promise<unknown> = Promise.resolve()
/**
 * Runs `work` once no other program holds the terminal: the external editor and a taken-over
 * vendor's TUI take turns, never both at once.
 */
export const exclusive = <A>(work: () => Promise<A>): Promise<A> => {
  const next = holder.then(work, work)
  holder = next.catch(() => {})
  return next
}

/** Runs `command` with `args` as a foreground job on the real terminal: taking over a wrapped worker. */
export const run = (
  command: string,
  args: ReadonlyArray<string>,
  cwd: string
): Promise<number | null> => foreground(`exec "$@"`, [command, ...args], { cwd })

/** How long quit waits for turns, flows and the host to close before exiting anyway. */
export const quitMs = 3000

/** Settles when `work` does or after `ms`, whichever is first: a hung close never keeps the process alive. */
export const bounded = (work: Promise<unknown>, ms = quitMs): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    const done = () => {
      clearTimeout(timer)
      resolve()
    }
    work.then(done, done)
  })
