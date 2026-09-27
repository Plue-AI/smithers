import { Terminal } from "@smthrs/ui/adapters/terminal"
import { useRef } from "react"
import { useController } from "../ControllerContext"

/*
 * A workspace terminal (docs/LOCAL-APP.md "Cards", the workspace card's
 * Terminal facet): the shipped `@smthrs/ui` xterm adapter (@xterm/xterm +
 * @xterm/addon-fit) attached to the cloud workspace session through the
 * `/api/cloud-ws/` tunnel. A terminal is always a workspace terminal: the
 * local PTY retired with the local backend (docs/LOCAL-BACKEND-RETIREMENT.md).
 *
 * xterm needs a DOM node to open into, and this package writes no lifecycle
 * effect for it: the adapter owns the mount and the fit addon, and this
 * component only hands it the three seams — the output stream (which
 * returns its own detach), the keystrokes, and the geometry. The card that
 * renders this stays mounted while hidden, so the emulator and its
 * scrollback live as long as the card does.
 */
export function TerminalView({ repo, sessionId }: { readonly repo: string; readonly sessionId: string }) {
  const controller = useController()
  /* The last geometry sent, so a refit that changed nothing sends nothing. */
  const lastGeometry = useRef("")
  return (
    <Terminal
      key={`${repo}:${sessionId}`}
      className="tab-terminal"
      data-testid={`terminal-${sessionId}`}
      /* Control focus (state/controller/controlFocus.ts): the xterm helper textarea's focusin finds this marker. */
      data-control-focus-id={`terminal:${sessionId}`}
      data-control-focus-kind="terminal"
      stream={(write) => controller.cloudTerminal.attach(repo, sessionId, { onOutput: write })}
      onData={(data) => controller.cloudTerminal.input(sessionId, data)}
      onResize={({ cols, rows }) => {
        // The adapter refits on every host resize; only a changed geometry reaches the server.
        const geometry = `${repo}:${sessionId}:${cols}x${rows}`
        if (geometry === lastGeometry.current || cols === 0 || rows === 0) return
        lastGeometry.current = geometry
        controller.cloudTerminal.resize(sessionId, cols, rows)
      }}
    />
  )
}
