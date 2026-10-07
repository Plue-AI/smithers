// Keyboard focus is transient and shared by the shell and navigation shortcuts.
const origins = new WeakMap<Document, HTMLElement>()

export function rememberComposerFocus(doc: Document): void {
  const active = doc.activeElement
  if (active instanceof HTMLElement && !active.matches("body, html") && !active.closest(".composer-wrap")) origins.set(doc, active)
  else origins.delete(doc)
}

export function restoreComposerFocus(doc: Document, fallback: HTMLElement | null): void {
  const origin = origins.get(doc)
  origins.delete(doc)
  if (origin?.isConnected && !origin.closest('[hidden], [inert], [aria-hidden="true"]') && !origin.matches(":disabled") && origin.getClientRects().length > 0) {
    origin.focus()
    if (doc.activeElement === origin) return
  }
  fallback?.focus()
}
