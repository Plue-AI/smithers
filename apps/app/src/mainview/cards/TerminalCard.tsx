/*
 * The Terminal card (T-APP-12): maps one terminal to TerminalView's props and
 * mounts the shared emulator in the View's app-only slot. The owner types;
 * everyone else watches an inert emulator and sends nothing. MOCK: metadata
 * and output come from the seeded design world (state/seams/DesignWorld/
 * branch.ts) until topic `branch:<id>` and CloudTerminalClient's byte stream
 * land; the owner's Enter then becomes an input frame instead of
 * `terminal.send`.
 */
import { useMemo, useRef, type ReactNode } from "react"
import { Terminal, type TerminalStream, type TerminalWriter } from "@smthrs/ui/adapters/terminal"
import { useController } from "../ControllerContext"
import { cardActions, type CardCommandDispatch } from "../flows/cardActions"
import type { CardActions, CardFamily, CardOf } from "./CardFamily"
import type { TerminalCard } from "@smthrs/rpc/TerminalCard"
import { TerminalView } from "./views/TerminalView"
import { useDesign, useDesignWorld } from "../state/seams/DesignWorld/hooks"
import { designTerminalModel, designTerminalPrompt, designTerminalText } from "../state/seams/DesignWorld/branch"
import type { DesignWorld } from "../state/seams/DesignWorld"

const CRLF = "\r\n"
/** Erase the echoed line; the seed's own prompt line replaces it. */
const ERASE_LINE = "\r\x1b[2K"

/** Replays the stored lines, then writes each line the seed appends, each time followed by the prompt. */
export const designTerminalStream = (design: DesignWorld, id: string, onWriter?: (write: TerminalWriter) => void): TerminalStream =>
  write => {
    onWriter?.(write)
    let written = 0
    const flush = (first: boolean) => {
      const world = design.world()
      const terminal = world.terminals.find(each => each.id === id)
      if (terminal === undefined) return
      const fresh = terminal.lines.slice(written)
      if (!first && fresh.length === 0) return
      for (const line of fresh) write(designTerminalText(line) + CRLF)
      written = terminal.lines.length
      write(designTerminalPrompt(world, terminal))
    }
    flush(true)
    return design.subscribe(() => flush(false))
  }

/** The owner's keys: echo until Enter, which sends the line as `terminal.send`. */
export const ownerInput = (write: () => TerminalWriter | undefined, send: (command: string) => void) => {
  let buffer = ""
  return (data: string): void => {
    for (const char of data) {
      if (char === "\r") {
        const command = buffer
        buffer = ""
        write()?.(ERASE_LINE)
        send(command)
      } else if (char === "\x7f") {
        if (buffer.length === 0) continue
        buffer = buffer.slice(0, -1)
        write()?.("\b \b")
      } else if (char === "\x03") {
        buffer = ""
        write()?.(`^C${CRLF}`)
      } else if (char >= " ") {
        buffer += char
        write()?.(char)
      }
    }
  }
}

/**
 * The owner's keys for one mounted card. The buffer lives for the card, not the render: a seed update
 * mid-typing re-renders the card and must not drop the half-typed command its echo still shows.
 */
export const useOwnerInput = (write: () => TerminalWriter | undefined, send: (command: string) => void): ((data: string) => void) => {
  const input = useRef<((data: string) => void) | undefined>(undefined)
  input.current ??= ownerInput(write, send)
  return input.current
}

/**
 * TerminalView's emulator slot (T-UI-17). Only the owner of a live terminal binds input; a watcher's or frozen
 * terminal is read-only with no `onData`, and the View's inert wrapper keeps focus out.
 */
export const terminalSlot = (model: TerminalCard, stream: TerminalStream | undefined, typed: (data: string) => void): ReactNode => {
  const readOnly = !model.viewer_is_owner || model.frozen
  return <Terminal key={model.id} stream={stream} onData={readOnly ? undefined : typed} readOnly={readOnly}
    palette="paper" fontSize={12.5} cursorBlink={!readOnly} aria-label={`${model.title} terminal`} />
}

export const TerminalCardBody = ({ card, actions }: { readonly card: CardOf<"terminal">; readonly actions: CardActions }) => {
  const controller = useController()
  const design = useDesign()
  const world = useDesignWorld()
  const writer = useRef<TerminalWriter | undefined>(undefined)
  const id = card.payload.id
  const stream = useMemo(() => designTerminalStream(design, id, write => { writer.current = write }), [design, id])
  const typed = useOwnerInput(() => writer.current, command =>
    controller.commands.submit({ name: "terminal.send", payload: { id, command }, actor: "user", originCardId: card.id }))
  const terminal = world.terminals.find(each => each.id === id)
  if (terminal === undefined) return null
  const dispatch: CardCommandDispatch = (tag, input) =>
    controller.commands.submit({ name: tag, payload: (input ?? {}) as Record<string, unknown>, actor: "user", originCardId: card.id })
  const model = designTerminalModel(world, terminal, design.viewer())
  return <TerminalView model={model} actions={[]} gestures={{}} onAction={cardActions(dispatch, []).onAction}
    view={{ maximized: actions.presentation === "maximized" }} onView={() => {}}
    terminal={terminalSlot(model, stream, typed)} />
}

/** The `terminal` kind: a subject-only card (card-kinds.md), one per member session. */
export const terminalCardFamily: CardFamily<"terminal"> = {
  terminal: { render: (card, actions) => <TerminalCardBody card={card} actions={actions} />, pill: () => "" }
}
