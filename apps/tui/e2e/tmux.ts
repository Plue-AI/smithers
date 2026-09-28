/**
 * Drives the production TUI in a private tmux server: raw keys in, screen out.
 * No user tmux configuration, sessions, environment, or sockets are modified.
 */
import { Terminal } from "@xterm/headless"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stopDaemons } from "../test/scratch.ts"

const quote = (value: string): string => "'" + value.replaceAll("'", "'\\''") + "'"
const binary = (): string => process.env.TMUX_BIN ?? "tmux"
const live = new Set<Tui>()
process.once("exit", () => {
  for (const tui of live) tui.dispose()
})

export const key = {
  enter: "\r",
  escape: "\x1b",
  ctrlC: "\x03",
  ctrlD: "\x04",
  ctrlO: "\x0f",
  ctrlS: "\x13",
  ctrlK: "\x0b",
  ctrlA: "\x01",
  ctrlBracket: "\x1d",
  ctrlBackslash: "\x1c",
  ctrlLeft: "\x1b[1;5D",
  up: "\x1b[A",
  down: "\x1b[B",
  tab: "\t",
  backspace: "\x7f"
} as const

/** A process's exit status, or the signal that killed it. */
export type Exit = { readonly code: number } | { readonly code: null; readonly signal: number }

/**
 * Reads `#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}`. tmux marks a
 * pane dead at PTY EOF, which can precede reaping its process; until then
 * neither the status nor the signal is known, so the process has not exited.
 */
export const exitOf = (format: string): Exit | undefined => {
  const [dead, status, signal] = format.split(":")
  if (dead !== "1" || (status === "" && signal === "")) return undefined
  return status === "" ? { code: null, signal: Number(signal) } : { code: Number(status) }
}

export class Tui {
  private readonly terminal: Terminal
  private stopped = false

  private constructor(
    private readonly directory: string,
    private readonly socket: string,
    public rows: number,
    public cols: number
  ) {
    this.terminal = new Terminal({ rows, cols, allowProposedApi: true })
  }

  private run(args: Array<string>): string {
    const result = spawnSync(binary(), ["-S", this.socket, ...args], {
      encoding: "utf8",
      timeout: 5_000,
      env: { ...process.env, TMUX: "", TMUX_PANE: "" }
    })
    if (result.error !== undefined) throw result.error
    if (result.status !== 0) throw new Error(`tmux ${args[0]}: ${result.stderr.trim()}`)
    return result.stdout
  }

  static async start(options: {
    readonly command: string
    readonly cwd: string
    readonly env?: Readonly<Record<string, string>>
    readonly rows?: number
    readonly cols?: number
  }): Promise<Tui> {
    const directory = mkdtempSync(join(tmpdir(), "tui-tmux-"))
    const socket = join(directory, "t.sock")
    const tui = new Tui(directory, socket, options.rows ?? 40, options.cols ?? 110)
    live.add(tui)
    try {
      // macOS limits Unix socket paths to 103 bytes plus the terminating NUL.
      if (Buffer.byteLength(socket) > 103) throw new Error(`tmux socket path exceeds 103 bytes: ${socket}`)
      const config = join(directory, "tmux.conf")
      writeFileSync(
        config,
        "set -g status off\nset -g remain-on-exit on\nset -g default-shell /bin/sh\nset -s escape-time 0\n"
      )
      const helper = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
      const env = {
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
        TMPDIR: tmpdir(),
        ...(helper === undefined || helper === "" ? {} : { SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: helper }),
        ...options.env
      }
      const command = `exec env -i ${
        Object.entries(env).map(([key, value]) => quote(`${key}=${value}`)).join(" ")
      } /bin/sh -c ${quote(`exec ${options.command}`)}`
      tui.run([
        "-f",
        config,
        "new-session",
        "-d",
        "-s",
        "tui",
        "-x",
        String(tui.cols),
        "-y",
        String(tui.rows),
        "-c",
        options.cwd,
        command
      ])
      return tui
    } catch (error) {
      tui.dispose()
      throw error
    }
  }

  /** PID of the process owning the pane's PTY (also its process group). */
  get pid(): number {
    return Number(this.run(["display-message", "-p", "#{pane_pid}"]).trim())
  }

  get exited(): Exit | undefined {
    return exitOf(this.run(["display-message", "-p", "#{pane_dead}:#{pane_dead_status}:#{pane_dead_signal}"]).trim())
  }

  async resize(cols: number, rows: number): Promise<void> {
    this.cols = cols
    this.rows = rows
    this.terminal.resize(cols, rows)
    this.run(["resize-window", "-x", String(cols), "-y", String(rows)])
  }

  /** A single tmux command preserves bursts across native-editor focus changes. */
  async press(bytes: string): Promise<void> {
    this.run(["send-keys", "-H", ...Array.from(Buffer.from(bytes), (byte) => byte.toString(16).padStart(2, "0"))])
    await sleep(150)
  }

  async click(text: string): Promise<void> {
    const lines = this.screen().split("\n")
    const row = lines.findIndex((line) => line.includes(text))
    if (row < 0) throw new Error(`no "${text}" on screen:\n${lines.join("\n")}`)
    const at = `${lines[row]!.indexOf(text) + 1};${row + 1}`
    await this.press(`\x1b[<0;${at}M\x1b[<0;${at}m`)
  }

  async type(text: string): Promise<void> {
    for (const character of text) {
      this.run(["send-keys", "-H", ...Array.from(Buffer.from(character), (byte) => byte.toString(16).padStart(2, "0"))])
    }
    await sleep(150)
  }

  /** The visible screen as a standalone HTML page with its colors, for looking at. */
  async html(background = "#011627", foreground = "#d6deeb"): Promise<string> {
    await new Promise<void>((resolve) =>
      this.terminal.write(
        "\x1b[2J\x1b[H" + this.run(["capture-pane", "-p", "-e", "-N"]).replace(/\n$/, "").replaceAll("\n", "\r\n"),
        resolve
      )
    )
    const buffer = this.terminal.buffer.active
    const hex = (value: number) => `#${value.toString(16).padStart(6, "0")}`
    const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;")
    const rows: Array<string> = []
    for (let row = 0; row < this.terminal.rows; row++) {
      const line = buffer.getLine(buffer.viewportY + row)
      let html = ""
      for (let column = 0; column < this.cols; column++) {
        const cell = line?.getCell(column)
        if (cell === undefined || cell.getWidth() === 0) continue
        const fg = cell.isFgRGB() ? hex(cell.getFgColor()) : foreground
        const bg = cell.isBgRGB() ? hex(cell.getBgColor()) : "transparent"
        const weight = cell.isBold() ? "font-weight:700;" : ""
        const style = cell.isItalic() ? "font-style:italic;" : ""
        html += `<span style="color:${fg};background:${bg};${weight}${style}">${escape(cell.getChars() || " ")}</span>`
      }
      rows.push(`<div>${html}</div>`)
    }
    return `<!doctype html><meta charset="utf-8"><style>div{height:17px;white-space:pre}span{display:inline-block;height:17px;vertical-align:top}</style><body style="margin:0;background:${background}"><pre style="margin:0;padding:8px;font:13px/17px 'JetBrains Mono','SF Mono',Menlo,monospace;color:${foreground}">${
      rows.join("")
    }</pre></body>`
  }

  /** The visible pane, with one line per terminal row. */
  screen(): string {
    return this.run(["capture-pane", "-p", "-N"]).replace(/\n$/, "")
  }

  async until(predicate: (screen: string) => boolean, timeoutMs = 15_000, label = "screen"): Promise<string> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const screen = this.screen()
      if (predicate(screen)) return screen
      await sleep(100)
    }
    throw new Error(`timed out waiting for ${label}; screen:\n${this.screen()}`)
  }

  async waitForExit(timeoutMs = 5_000): Promise<Exit> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const exited = this.exited
      if (exited !== undefined) return exited
      await sleep(50)
    }
    throw new Error(`timed out waiting for process exit; screen:\n${this.screen()}`)
  }

  dispose(): void {
    if (this.stopped) return
    this.stopped = true
    // The socket still identifies the whole process tree here. A pane can ignore
    // kill-server's HUP and escape that tree once the server exits.
    stopDaemons(this.directory)
    try {
      this.run(["kill-server"])
    } catch { /* Already exited or failed to start. */ }
    live.delete(this)
    this.terminal.dispose()
    rmSync(this.directory, { recursive: true, force: true })
  }

  async stop(): Promise<void> {
    this.dispose()
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
