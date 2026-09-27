/**
 * Drives the TUI in a real PTY through zmux and reads the screen back.
 *
 * `zmuxd` owns the PTY; this client creates one session over its JSON-RPC
 * socket, feeds every `pane_output` byte into a headless xterm, and answers
 * `screen()` from that emulator. Keys go in as raw bytes, exactly what a
 * terminal sends.
 *
 * The daemon binary comes from `$ZMUXD`, then `zmuxd` on `PATH`, then
 * `~/zmux/zig-out/bin/zmuxd`. Releases: https://github.com/smithersai/zmux.
 */
import { Terminal } from "@xterm/headless"
import { type ChildProcess, spawn, spawnSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { createConnection, type Socket } from "node:net"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export const zmuxd = (): string | undefined => {
  if (process.env.ZMUXD !== undefined) return process.env.ZMUXD
  const found = (spawnSync("which", ["zmuxd"], { encoding: "utf8" }).stdout ?? "").trim()
  if (found !== "") return found
  const built = join(homedir(), "zmux", "zig-out", "bin", "zmuxd")
  return existsSync(built) ? built : undefined
}

/**
 * Host settings every TUI child keeps whatever `env` a case passes. Flows
 * need `smithers-jj-export`; a fresh checkout has no `target/release` copy,
 * so its override must reach the child.
 */
const passthrough = (): Record<string, string> => {
  const helper = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY
  return {
    // The TUI's own temporary files stay inside the suite's private root.
    TMPDIR: tmpdir(),
    ...(helper === undefined || helper === "" ? {} : { SMITHERS_WORKSPACE_JJ_EXPORT_BINARY: helper })
  }
}

/**
 * Every daemon not yet stopped. A case that times out never reaches
 * `stop()`, so the process kills what is left when it exits.
 */
const live = new Set<ChildProcess>()
process.once("exit", () => {
  for (const daemon of live) daemon.kill("SIGKILL")
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
  up: "\x1b[A",
  down: "\x1b[B",
  tab: "\t",
  backspace: "\x7f"
} as const

interface Pending {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
}

export class Tui {
  private readonly terminal: Terminal
  private readonly pending = new Map<number, Pending>()
  private next = 1
  private buffered = ""
  private sessionId = ""
  exited: { readonly code: number | null } | undefined

  private constructor(
    private readonly daemon: ChildProcess,
    private readonly socket: Socket,
    private readonly directory: string,
    public rows: number,
    public cols: number
  ) {
    this.terminal = new Terminal({ rows, cols, allowProposedApi: true })
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => this.receive(chunk))
  }

  /** Starts a private daemon and runs `command` in a new session. */
  static async start(options: {
    readonly command: string
    readonly cwd: string
    readonly env?: Readonly<Record<string, string>>
    readonly rows?: number
    readonly cols?: number
  }): Promise<Tui> {
    const binary = zmuxd()
    if (binary === undefined) throw new Error("zmuxd not found: set ZMUXD or build ~/zmux (zig build)")
    const directory = mkdtempSync(join(tmpdir(), "tui-zmux-"))
    const path = join(directory, "z.sock")
    // macOS caps a socket path at 104 bytes; past it zmuxd never listens.
    if (Buffer.byteLength(path) > 103) {
      rmSync(directory, { recursive: true, force: true })
      throw new Error(`zmuxd socket path is ${Buffer.byteLength(path)} bytes, over the 103 macOS allows: ${path}`)
    }
    const daemon = spawn(binary, ["--socket", path, "--idle-seconds", "0"], { stdio: "ignore" })
    live.add(daemon)
    daemon.once("exit", () => live.delete(daemon))
    await waitFor(() => existsSync(path), 5_000, "zmuxd socket")
    // The socket path can precede listen(); wait for a connection, not just stat().
    let socket: Socket
    const deadline = Date.now() + 5_000
    for (;;) {
      try {
        socket = await new Promise<Socket>((resolve, reject) => {
          const connection = createConnection(path, () => resolve(connection))
          connection.once("error", (error) => {
            connection.destroy()
            reject(error)
          })
        })
        break
      } catch (error) {
        if (Date.now() >= deadline) {
          daemon.kill()
          live.delete(daemon)
          rmSync(directory, { recursive: true, force: true })
          throw error
        }
        await sleep(25)
      }
    }
    const tui = new Tui(daemon, socket, directory, options.rows ?? 40, options.cols ?? 110)
    const created = await tui.call("session.create", {
      id: "tui",
      rows: tui.rows,
      cols: tui.cols,
      cwd: options.cwd,
      command: options.command,
      env: { TERM: "xterm-256color", COLORTERM: "truecolor", ...passthrough(), ...options.env }
    }) as { sessionId?: string; id?: string }
    tui.sessionId = created.sessionId ?? created.id ?? "tui"
    return tui
  }

  call(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = this.next++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    })
  }

  private receive(chunk: string) {
    this.buffered += chunk
    let newline = this.buffered.indexOf("\n")
    while (newline >= 0) {
      const line = this.buffered.slice(0, newline)
      this.buffered = this.buffered.slice(newline + 1)
      newline = this.buffered.indexOf("\n")
      if (line.trim() === "") continue
      const message = JSON.parse(line) as {
        id?: number
        method?: string
        params?: Record<string, unknown>
        result?: unknown
        error?: { message: string }
      }
      if (message.id !== undefined) {
        const waiting = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error !== undefined) waiting?.reject(new Error(message.error.message))
        else waiting?.resolve(message.result)
      } else if (message.method === "pane_output") {
        this.terminal.write(Buffer.from(String(message.params?.data_base64 ?? ""), "base64"))
      } else if (message.method === "session_exited") {
        this.exited = { code: (message.params?.exit_code as number | null | undefined) ?? null }
      }
    }
  }

  /** Resize both the terminal emulator and its real PTY. */
  async resize(cols: number, rows: number): Promise<void> {
    this.cols = cols
    this.rows = rows
    this.terminal.resize(cols, rows)
    await this.call("session.resize", { sessionId: this.sessionId, cols, rows })
  }

  /** Sends raw bytes to the PTY. */
  async press(bytes: string): Promise<void> {
    await this.call("session.send", { sessionId: this.sessionId, dataBase64: Buffer.from(bytes).toString("base64") })
    await sleep(150)
  }

  /** Clicks the first visible `text`, as an SGR mouse press and release. */
  async click(text: string): Promise<void> {
    const lines = this.screen().split("\n")
    const row = lines.findIndex((line) => line.includes(text))
    if (row < 0) throw new Error(`no "${text}" on screen:\n${lines.join("\n")}`)
    const at = `${lines[row]!.indexOf(text) + 1};${row + 1}`
    await this.press(`\x1b[<0;${at}M\x1b[<0;${at}m`)
  }

  /** Types text one character at a time, as a person does. */
  async type(text: string): Promise<void> {
    for (const character of text) {
      await this.call("session.send", {
        sessionId: this.sessionId,
        dataBase64: Buffer.from(character).toString("base64")
      })
    }
    await sleep(150)
  }

  /** The visible screen as a standalone HTML page with its colors, for looking at. */
  html(background = "#011627", foreground = "#d6deeb"): string {
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

  /** The visible screen, one string per row, trailing spaces trimmed. */
  screen(): string {
    const buffer = this.terminal.buffer.active
    const lines: Array<string> = []
    for (let row = 0; row < this.terminal.rows; row++) {
      lines.push(buffer.getLine(buffer.viewportY + row)?.translateToString(true) ?? "")
    }
    return lines.join("\n")
  }

  /** Waits until the screen satisfies `predicate`, or throws with the screen. */
  async until(predicate: (screen: string) => boolean, timeoutMs = 15_000, label = "screen"): Promise<string> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      await new Promise<void>((resolve) => this.terminal.write("", resolve))
      const screen = this.screen()
      if (predicate(screen)) return screen
      await sleep(100)
    }
    throw new Error(`timed out waiting for ${label}; screen:\n${this.screen()}`)
  }

  async waitForExit(timeoutMs = 5_000): Promise<{ readonly code: number | null }> {
    await waitFor(() => this.exited !== undefined, timeoutMs, "process exit")
    return this.exited!
  }

  async stop(): Promise<void> {
    await this.call("daemon.shutdown", {}).catch(() => undefined)
    this.socket.destroy()
    this.daemon.kill()
    live.delete(this.daemon)
    this.terminal.dispose()
    rmSync(this.directory, { recursive: true, force: true })
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const waitFor = async (check: () => boolean, timeoutMs: number, label: string) => {
  const deadline = Date.now() + timeoutMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`)
    await sleep(50)
  }
}
