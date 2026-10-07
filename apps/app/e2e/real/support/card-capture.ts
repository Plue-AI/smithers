import { createHash } from "node:crypto"
import type { Page } from "@playwright/test"

export type CardCapture = {
  actor: string; theme: "light" | "dark"; checkpoint: number; card: number
  kind: string | null; testId: string | null; attachment: string; sha256: string; at: string
}

/** Supplemental capture inventory, never a check receipt. IDs describe DOM
 * instances, so replacing a card at the same transcript position is retained.
 * Field text and markup are used only for deduplication and never logged. */
export function cardCaptureInventory(attach: (name: string, bytes: Buffer) => Promise<void>) {
  const rows: CardCapture[] = []
  const fingerprints = new Map<string, string>()
  let checkpoint = 0
  return {
    snapshot: (): readonly CardCapture[] => rows.map(row => ({ ...row })),
    async capture(page: Page, actor: string, theme: "light" | "dark") {
      if (await page.locator("html").getAttribute("data-theme") !== theme) throw new Error("Card capture theme does not match the journey")
      const step = ++checkpoint
      // Browser-side WeakMap retains identity across reordering without modifying
      // the app DOM, focus or application state. It resets after navigation.
      const cards = page.locator(".smithers-card:visible")
      for (const card of await cards.all()) {
        const handle = await card.elementHandle()
        if (!handle) throw new Error("Card disappeared before capture")
        try {
          const observed = await handle.evaluate(element => {
            const host = window as typeof window & { __smithersCaptureIds?: WeakMap<Element, number>; __smithersCaptureNext?: number }
            const ids = host.__smithersCaptureIds ??= new WeakMap()
            let id = ids.get(element)
            if (id === undefined) { id = host.__smithersCaptureNext = (host.__smithersCaptureNext ?? 0) + 1; ids.set(element, id) }
            const markup = element.cloneNode(true) as Element
            // Playwright restores hidden carets with an empty style attribute.
            // Normalize that capture artifact without changing the live card.
            for (const node of [markup, ...markup.querySelectorAll('[style=""]')]) {
              if (node.getAttribute("style") === "") node.removeAttribute("style")
            }
            return { id, kind: element.getAttribute("data-kind"), testId: element.getAttribute("data-testid"), fingerprint: JSON.stringify({
              html: markup.outerHTML,
              fields: Array.from(element.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("input,textarea,select")).map(field => ({
                value: field.value, checked: field instanceof HTMLInputElement ? field.checked : undefined,
                selected: field instanceof HTMLSelectElement ? field.selectedIndex : undefined, focused: field === document.activeElement
              }))
            }) }
          })
          // Include the document identity: a navigation may reuse browser IDs.
          const documentEpoch = await page.evaluate(() => performance.timeOrigin)
          const key = `${actor}:${theme}:${documentEpoch}:${observed.id}`
          const fingerprint = createHash("sha256").update(observed.fingerprint).digest("hex")
          if (fingerprints.get(key) === fingerprint) continue
          const bytes = await handle.screenshot()
          const attachment = `card-${theme}-${actor}-${rows.length + 1}`
          await attach(attachment, bytes)
          rows.push({ actor, theme, checkpoint: step, card: observed.id, kind: observed.kind, testId: observed.testId,
            attachment, sha256: createHash("sha256").update(bytes).digest("hex"), at: new Date().toISOString() })
          fingerprints.set(key, fingerprint)
        } finally { await handle.dispose() }
      }
    }
  }
}
