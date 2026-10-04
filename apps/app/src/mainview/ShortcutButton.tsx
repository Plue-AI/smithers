import type { ComponentProps, ReactNode } from "react"

/** Shared keyboard hints for Chat and input mode. */
export const SHORTCUT_KEYS = { mode: "m", chat: "⌘K" } as const

export function guideShortcut(shortcut: string): string | undefined {
  if (shortcut.toLowerCase() === "escape") return "Escape"
  if (shortcut.toLowerCase() === "enter") return "Enter"
  if (shortcut === "⌘K") return "Meta+K Control+K"
  if (shortcut === "Tab ↵") return undefined
  return shortcut.toLowerCase() === "arrowright" ? "ArrowRight" : shortcut.toLowerCase()
}

export function ShortcutKey({ shortcut }: { shortcut: string }) {
  const label = shortcut === "⌘K" ? "⌘ K" : shortcut === "ArrowRight" ? "→" : shortcut
  return <kbd className="guide-button-key" aria-hidden="true"
    title={shortcut === "Tab ↵" ? "Tab to this button, then press Enter" : undefined}>{label}</kbd>
}

type ShortcutButtonProps = Omit<ComponentProps<"button">, "aria-keyshortcuts"> & {
  shortcut?: string
  children: ReactNode
}

/** One control presentation keeps the visible hint and accessible shortcut in sync. */
export function ShortcutButton({ shortcut, children, className = "", type = "button", ...props }: ShortcutButtonProps) {
  return <button {...props} type={type} className={`guide-button ${className}`.trim()}
    aria-keyshortcuts={shortcut === undefined ? undefined : guideShortcut(shortcut)}>
    <span className="guide-button-content">{children}</span>{" "}
    {shortcut !== undefined && <ShortcutKey shortcut={shortcut} />}
  </button>
}
