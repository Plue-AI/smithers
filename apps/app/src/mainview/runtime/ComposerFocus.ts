// Keyboard focus is transient and shared by the shell and navigation shortcuts.
const origins = new WeakMap<Document, HTMLElement>()
const restorations = new WeakMap<Document, HTMLElement>()

/** A requested form may continue the dismissal that just restored its opener. */
export function takeComposerRestoration(doc: Document): HTMLElement | undefined {
  const target = restorations.get(doc)
  restorations.delete(doc)
  return target === doc.activeElement ? target : undefined
}

const restored = (doc: Document, target: HTMLElement): void => {
  if (doc.activeElement !== target) return
  restorations.set(doc, target)
  // Any later focus choice cancels the handoff before a delayed form arrives.
  doc.addEventListener("focusin", () => restorations.delete(doc), { once: true })
}

export function rememberComposerFocus(doc: Document): void {
  restorations.delete(doc)
  const active = doc.activeElement
  if (active instanceof HTMLElement && !active.matches("body, html") && !active.closest(".composer-wrap")) origins.set(doc, active)
  else origins.delete(doc)
}

export function restoreComposerFocus(doc: Document, fallback: HTMLElement | null): void {
  const origin = origins.get(doc)
  origins.delete(doc)
  if (origin?.isConnected && !origin.closest('[hidden], [inert], [aria-hidden="true"]') && !origin.matches(":disabled") && origin.getClientRects().length > 0) {
    origin.focus()
    if (doc.activeElement === origin) { restored(doc, origin); return }
  }
  fallback?.focus()
  if (fallback) restored(doc, fallback)
}
