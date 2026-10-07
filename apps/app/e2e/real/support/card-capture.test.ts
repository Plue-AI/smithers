import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { chromium } from "@playwright/test"
import { cardCaptureInventory } from "./card-capture"
import { registerKeyboardJourney, journeyActivate, journeyEnter } from "./keyboard-journey-input"

// HTTP-served browser capture proof only; never reference-install qualification.
for (const theme of ["light", "dark"] as const) test(`${theme} inventory retains transient, edited and replaced cards through keyboard doors`, async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`
    <html data-theme="${theme}"><style>:root{--ring-border:rgb(12,34,56)}:focus-visible{outline:2px solid var(--ring-border)}</style>
    <section class="smithers-card" data-kind="draft"><input aria-label="Prompt" value="private literal">
    <button onclick="this.parentElement.outerHTML='<section class=smithers-card data-kind=todo>Queued</section>';document.querySelector('#chat').focus()">Commit</button></section>
    <input id="chat" aria-label="Chat"></html>`, { headers: { "Content-Type": "text/html" } }) })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const origin = `http://127.0.0.1:${server.port}`
    await page.goto(origin)
    const attachments = new Map<string, Buffer>()
    const inventory = cardCaptureInventory(async (name, bytes) => { attachments.set(name, bytes) })
    const capture = () => inventory.capture(page, "Ben", theme)
    const keys = registerKeyboardJourney(page, origin, capture)
    await capture()
    await capture()
    expect(inventory.snapshot()).toHaveLength(1)
    await journeyEnter(page.getByLabel("Prompt"), "changed private literal")
    const edited = inventory.snapshot()
    expect(edited.length).toBeGreaterThan(1)
    expect(edited.every(row => row.card === edited[0]!.card)).toBe(true)
    await journeyActivate(page.getByRole("button", { name: "Commit" }))
    keys.finish()
    const rows = inventory.snapshot()
    expect(rows.at(-1)!.kind).toBe("todo")
    expect(rows.at(-1)!.card).not.toBe(rows[0]!.card)
    for (const row of rows) {
      expect(row.theme).toBe(theme)
      expect(row.actor).toBe("Ben")
      expect(Date.parse(row.at)).not.toBeNaN()
      expect(row.sha256).toBe(createHash("sha256").update(attachments.get(row.attachment)!).digest("hex"))
    }
    expect(JSON.stringify(rows)).not.toContain("private literal")
    const snapshot = inventory.snapshot()
    snapshot[0]!.actor = "altered"
    expect(inventory.snapshot()[0]!.actor).toBe("Ben")
    await page.evaluate(() => document.documentElement.dataset.theme = "other")
    await expect(capture()).rejects.toThrow("theme does not match")
    expect(inventory.snapshot()).toEqual(rows)
  } finally { await browser.close(); server.stop(true) }
}, 30_000)

test("failed attachment is retried rather than marked captured", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response('<html data-theme="light"><section class="smithers-card">Retry</section></html>', { headers: { "Content-Type": "text/html" } }) })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.port}`)
    let attempts = 0
    const inventory = cardCaptureInventory(async () => { if (++attempts === 1) throw new Error("storage unavailable") })
    await expect(inventory.capture(page, "Will", "light")).rejects.toThrow("storage unavailable")
    expect(inventory.snapshot()).toEqual([])
    await inventory.capture(page, "Will", "light")
    expect(inventory.snapshot()).toHaveLength(1)
    expect(attempts).toBe(2)
  } finally { await browser.close(); server.stop(true) }
}, 30_000)
