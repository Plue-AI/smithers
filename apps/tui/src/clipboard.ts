/**
 * The system clipboard, and copy-on-select.
 *
 * The renderer captures the mouse, so the terminal's own selection never
 * starts. opentui tracks the drag itself and emits `selection` on mouse-up;
 * {@link copyOnSelect} writes that text to the clipboard the way a terminal
 * with copy-on-select would.
 */
import { spawn } from "node:child_process"

/** Clipboard commands to try in order: macOS, Windows, then Wayland before X11. */
export const commands = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv
): ReadonlyArray<readonly [string, ReadonlyArray<string>]> =>
  platform === "darwin"
    ? [["pbcopy", []]]
    : platform === "win32"
    ? [["clip", []]]
    : [
      ...(env.WAYLAND_DISPLAY === undefined ? [] : [["wl-copy", []] as const]),
      ["xclip", ["-selection", "clipboard"]],
      ["xsel", ["--clipboard", "--input"]]
    ]

const pipe = (command: string, args: ReadonlyArray<string>, text: string): Promise<boolean> =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["pipe", "ignore", "ignore"] })
    child.on("error", () => resolve(false))
    child.on("close", (code) => resolve(code === 0))
    child.stdin.on("error", () => {})
    child.stdin.end(text)
  })

/** Writes `text` to the system clipboard without blocking the render loop; false when no command took it. */
export const write = async (text: string, candidates: ReadonlyArray<readonly [string, ReadonlyArray<string>]>): Promise<boolean> => {
  for (const [command, args] of candidates) if (await pipe(command, args, text)) return true
  return false
}

/** The part of the renderer this module needs. */
export interface SelectionSource {
  on(event: "selection", listener: (selection: { getSelectedText(): string }) => void): unknown
  off(event: "selection", listener: (selection: { getSelectedText(): string }) => void): unknown
}

/**
 * Copies every finished non-empty selection through `copy` and reports it to
 * `onCopied`, or to `onFailed` when no clipboard took it. Returns the unsubscribe.
 */
export const copyOnSelect = (
  source: SelectionSource,
  copy: (text: string) => boolean | Promise<boolean>,
  onCopied: (text: string) => void,
  onFailed: (text: string) => void = () => {}
): () => void => {
  const listener = (selection: { getSelectedText(): string }) => {
    const text = selection.getSelectedText()
    if (text.trim() === "") return
    void Promise.resolve(copy(text)).then((copied) => (copied ? onCopied(text) : onFailed(text)), () => onFailed(text))
  }
  source.on("selection", listener)
  return () => source.off("selection", listener)
}
