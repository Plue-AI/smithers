/* MOCK: the existing design terminal fallback. Disabled DesignWorld has no terminals. */
import type { TerminalStream, TerminalWriter } from "@smthrs/ui/adapters/terminal"
import { designTerminalPrompt, designTerminalText } from "./branch"
import type { DesignWorld } from "./index"

/** Replay stored output, then append only fresh lines; the adapter owns detachment. */
export const designTerminalStream = (design: DesignWorld, id: string, onWriter: (write: TerminalWriter) => void): TerminalStream => write => {
  onWriter(write)
  let written = 0
  const flush = (first: boolean) => {
    const world = design.world()
    const terminal = world.terminals.find(each => each.id === id)
    if (!terminal) return
    const fresh = terminal.lines.slice(written)
    if (!first && !fresh.length) return
    for (const line of fresh) write(designTerminalText(line) + "\r\n")
    written = terminal.lines.length
    write(designTerminalPrompt(world, terminal))
  }
  flush(true)
  return design.subscribe(() => flush(false))
}

/** Seed-only line editing; Enter uses the same typed terminal flow as the slash door. */
export const ownerInput = (write: () => TerminalWriter | undefined, send: (command: string) => void) => {
  let buffer = ""
  return (data: string) => {
    for (const char of data) {
      if (char === "\r") {
        const command = buffer
        buffer = ""
        write()?.("\r\x1b[2K")
        send(command)
      } else if (char === "\x7f") {
        if (!buffer.length) continue
        buffer = buffer.slice(0, -1)
        write()?.("\b \b")
      } else if (char === "\x03") {
        buffer = ""
        write()?.("^C\r\n")
      } else if (char >= " ") {
        buffer += char
        write()?.(char)
      }
    }
  }
}

