import { test, expect } from "bun:test"
import { chromium } from "@playwright/test"
import { keyboardJourneyInput, registerKeyboardJourney, journeyActivate, journeyReach, journeyEnter, journeyChecked, journeySelect } from "./keyboard-journey-input"
import { installReleasedHost } from "./release-install"

test("keyboard journey traversal refuses a page outside the declared install", async () => {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    // Supplemental DOM proof only. No mocked install or passing journey receipt.
    await page.goto("data:text/html,keyboard")
    await page.setContent(`<style>:root{--ring-border:rgb(12,34,56)}:focus-visible{outline:2px solid var(--ring-border)}</style>
      <input aria-label="Title"><select aria-label="Place"><option>Insert</option><option>Append</option></select>
      <button type="button">Commit</button>`)
    // Guard refuses data URLs: tests may not manufacture an app origin for qualification.
    const keys = keyboardJourneyInput(page, "http://127.0.0.1:47400")
    await expect(keys.enter(page.getByLabel("Title"), "First TODO")).rejects.toThrow("keyboard guard refused")
    expect(() => keys.finish()).toThrow("refused input")
  } finally { await browser.close() }
}, 30_000)

test("released installation refuses this Linux host before Homebrew or launcher execution", async () => {
  if (process.platform === "darwin") return
  await expect(installReleasedHost({} as Parameters<typeof installReleasedHost>[0])).rejects.toThrow("release_host_required")
})

// Local DOM transport tests physical input only; it supplies no release receipt.
test("Tab traversal types, selects and activates native controls without a pointer", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`
    <style>:root{--ring-border:rgb(12,34,56)}:focus-visible{outline:2px solid var(--ring-border)}</style>
    <input aria-label="Title"><select aria-label="Place"><option>Insert</option><option>Append</option></select>
    <button type="button" onclick="document.querySelector('output').textContent=document.querySelector('input').value">Commit</button><output></output>
  `, { headers: { "Content-Type": "text/html" } }) })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const origin = `http://127.0.0.1:${server.port}`
    await page.goto(origin)
    const keys = keyboardJourneyInput(page, origin)
    await keys.enter(page.getByLabel("Title"), "First TODO")
    await keys.select(page.getByLabel("Place"), "Append")
    await keys.activate(page.getByRole("button", { name: "Commit" }))
    expect(await page.locator("output").textContent()).toBe("First TODO")
    expect(await page.getByLabel("Place").inputValue()).toBe("Append")
    const evidence = keys.finish()
    expect(evidence.inputs.every(input => input.result === "allowed")).toBe(true)
    expect(evidence.focus).toHaveLength(3)
    expect(JSON.stringify(evidence)).not.toContain("First TODO")
  } finally { await browser.close(); server.stop(true) }
}, 30_000)


test("shared real journey doors traverse before typing, preserve editor text, and reject direct shortcuts", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`
    <style>:root{--ring-border:rgb(12,34,56)}:focus-visible{outline:2px solid var(--ring-border)}</style>
    <input aria-label="Title"><select aria-label="Place"><option>Append</option><option>Before T2</option></select>
    <input type="checkbox" aria-label="Fixes"><textarea aria-label="File">Original</textarea>
    <button onclick="document.querySelector('output').textContent=document.querySelector('input').value">Commit</button><output></output>
  `, { headers: { "Content-Type": "text/html" } }) })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    const origin = `http://127.0.0.1:${server.port}`
    await page.goto(origin)
    const keys = registerKeyboardJourney(page, origin)
    await journeyEnter(page.getByLabel("Title"), "Reviewed literal")
    await journeySelect(page.getByLabel("Place"), "Before T2")
    await journeyChecked(page.getByLabel("Fixes"), true)
    await journeyChecked(page.getByLabel("Fixes"), true)
    expect(await page.getByLabel("Fixes").isChecked()).toBe(true)
    await journeyChecked(page.getByLabel("Fixes"), false)
    await journeyReach(page.getByLabel("File"))
    expect(await page.getByLabel("File").inputValue()).toBe("Original")
    await journeyActivate(page.getByRole("button", { name: "Commit" }))
    expect(await page.locator("output").textContent()).toBe("Reviewed literal")
    expect(await page.getByLabel("Place").inputValue()).toBe("Before T2")
    keys.finish()
    expect(() => page.getByLabel("Title").fill("Bypass")).toThrow("keyboard guard refused")
    expect(() => keys.finish()).toThrow("refused input")
  } finally { await browser.close(); server.stop(true) }
}, 30_000)

test("capture sees a transient card before activation dismisses it", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`
    <style>:root{--ring-border:rgb(12,34,56)}:focus-visible{outline:2px solid var(--ring-border)}</style>
    <section class="smithers-card">Decision <button onclick="this.parentElement.remove(); document.querySelector('input').focus()">Confirm</button></section>
    <input aria-label="Chat">
  `, { headers: { "Content-Type": "text/html" } }) })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage(), observed: string[] = []
    await page.goto(`http://127.0.0.1:${server.port}`)
    const keys = registerKeyboardJourney(page, `http://127.0.0.1:${server.port}`, async () => {
      observed.push(await page.locator(".smithers-card").count() ? "decision" : "dismissed")
    })
    await journeyActivate(page.getByRole("button", { name: "Confirm" }))
    expect(observed).toEqual(["decision", "dismissed"])
    expect(await page.getByLabel("Chat").evaluate(element => element === document.activeElement)).toBe(true)
    keys.finish()
  } finally { await browser.close(); server.stop(true) }
}, 30_000)

test("headed operator pointer input is blocked even through a pre-guard mouse reference", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`
    <style>:root{--ring-border:rgb(12,34,56)}:focus-visible{outline:2px solid var(--ring-border)}</style>
    <button onclick="document.querySelector('output').textContent='1'">Commit</button><output>0</output>
  `, { headers: { "Content-Type": "text/html" } }) })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage()
    await page.goto(`http://127.0.0.1:${server.port}`)
    // This bypasses only the automation wrapper, just as physical OS input does.
    const nativeClick = page.mouse.click.bind(page.mouse)
    const keys = registerKeyboardJourney(page, `http://127.0.0.1:${server.port}`)
    await keys.ready()
    const button = page.getByRole("button", { name: "Commit" })
    const box = await button.boundingBox()
    await nativeClick(box!.x + box!.width / 2, box!.y + box!.height / 2)
    expect(await page.locator("output").textContent()).toBe("0")
    await journeyActivate(button)
    expect(await page.locator("output").textContent()).toBe("1")
    expect(keys.snapshot().inputs.some(input => input.method === "dom.pointerdown" && input.result === "refused")).toBe(true)
    expect(keys.snapshot().inputs.some(input => input.method === "dom.keydown" && input.result === "allowed")).toBe(true)
    expect(() => keys.finish()).toThrow("refused input")
    expect(JSON.stringify(keys.snapshot())).not.toContain("Commit")
  } finally { await browser.close(); server.stop(true) }
}, 30_000)

// Locator.press focuses its target internally. It cannot prove Tab reachability.
test("locator key shortcuts refuse before moving focus to an unreachable control", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`
    <style>:root{--ring-border:rgb(12,34,56)}:focus-visible{outline:2px solid var(--ring-border)}</style>
    <input aria-label="Chat"><button tabindex="-1" onclick="document.querySelector('output').textContent='1'">Hidden door</button><output>0</output>
  `, { headers: { "Content-Type": "text/html" } }) })
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage(), origin = `http://127.0.0.1:${server.port}`
    await page.goto(origin)
    const keys = registerKeyboardJourney(page, origin)
    await journeyEnter(page.getByLabel("Chat"), "Keep focus")
    const target = page.getByRole("button", { name: "Hidden door" })
    expect(() => target.press("Enter")).toThrow("keyboard guard refused")
    expect(() => target.pressSequentially("Bypass")).toThrow("keyboard guard refused")
    expect(await page.getByLabel("Chat").evaluate(element => element === document.activeElement)).toBe(true)
    expect(await page.locator("output").textContent()).toBe("0")
    expect(() => keys.finish()).toThrow("refused input")
  } finally { await browser.close(); server.stop(true) }
}, 30_000)
