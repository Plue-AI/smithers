import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

const fixture = fileURLToPath(new URL("../../src/mainview/codexSession/fixtures/rollout.jsonl", import.meta.url))
let browser: Browser
let directory: string
let file: string

beforeAll(async () => {
  // The CLI builds the page in its own process, away from Bun's test-module resolver.
  directory = await mkdtemp(join(tmpdir(), "codex-session-"))
  file = join(directory, "session.html")
  const build = Bun.spawn([process.execPath, fileURLToPath(new URL("../../scripts/codex-session.ts", import.meta.url)), fixture, "--out", file, "--no-open"],
    { stdout: "pipe", stderr: "pipe" })
  const [output, errors, status] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])
  if (status !== 0) throw new Error(`The session page did not build: ${errors}`)
  expect(output).toContain(file)
  browser = await chromium.launch()
}, 60_000)
afterAll(async () => {
  try { await browser?.close() } finally { await rm(directory, { recursive: true, force: true }) }
}, 15_000)

const open = async (width = 1600): Promise<{ page: Page; errors: string[] }> => {
  const page = await browser.newPage({ viewport: { width, height: 1000 } })
  const errors: string[] = []
  page.on("pageerror", error => errors.push(String(error)))
  page.setDefaultTimeout(10_000)
  await page.goto(`file://${file}`)
  await page.locator(".cx-page").waitFor()
  return { page, errors }
}
const scrub = (page: Page, selector: string, value: number) => page.locator(selector).evaluate((input: HTMLInputElement, next) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, String(next))
  input.dispatchEvent(new Event("input", { bubbles: true }))
}, value)

test("the latest position shows every entry, a line for each, and the live turn", async () => {
  const { page, errors } = await open()
  try {
    await expect(page.locator(".cx-chat .mvp-entry").count()).resolves.toBe(6)
    await expect(page.locator(".mvp-timeline li").count()).resolves.toBe(6)
    await expect(page.locator(".mvp-entry").last().innerText()).resolves.toContain("Checking jj status.")
    await expect(page.locator(".mvp-run-state").innerText()).resolves.toBe("Working")
    await expect(page.locator(".mvp-timeline li").last().getAttribute("data-tone")).resolves.toBe("live")
    await expect(page.locator(".cx-scrub button").isDisabled()).resolves.toBe(true)
    // The band marks what the conversation shows; the conversation opens at its end.
    await expect(page.locator(".mvp-timeline li").last().getAttribute("data-in-view")).resolves.toBe("true")
    expect(errors).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("scrubbing re-projects the conversation, rail and run; Latest returns", async () => {
  const { page, errors } = await open()
  try {
    // Seq 14 is the first turn's completion in the fixture.
    await scrub(page, ".cx-scrub input", 14)
    await expect(page.locator(".cx-scrub span").innerText()).resolves.toMatch(/^14 \/ \d+$/)
    await expect(page.locator(".cx-chat .mvp-entry").count()).resolves.toBe(2)
    await expect(page.locator(".mvp-timeline li").count()).resolves.toBe(2)
    await expect(page.locator(".mvp-run-state").innerText()).resolves.toBe("Waiting for a person")
    await page.locator(".cx-scrub button").click()
    await expect(page.locator(".cx-chat .mvp-entry").count()).resolves.toBe(6)
    await expect(page.locator(".mvp-run-state").innerText()).resolves.toBe("Working")
    expect(errors).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("a timeline line jumps to its entry and selects that turn's last act in the run", async () => {
  const { page, errors } = await open()
  try {
    await page.locator('.mvp-timeline li[data-entry="turn-1"] > button').click()
    await expect(page.locator(".mvp-run-detail .mvp-run-explain").innerText()).resolves.toBe("Fixed the retry bug.")
    await expect(page.locator(".mvp-run-detail blockquote").innerText()).resolves.toContain("Tests pass in [retry]")
    expect(errors).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("the run's own journal scrubber moves the whole page", async () => {
  const { page, errors } = await open()
  try {
    await page.locator('.mvp-run-tab[data-tab="journal"]').click()
    await scrub(page, ".mvp-run-scrub input", 3)
    await expect(page.locator(".cx-scrub span").innerText()).resolves.toMatch(/^3 \/ \d+$/)
    // Seq 3 is the first prompt: the turn it opened works, with nothing said yet.
    await expect(page.locator(".cx-chat .mvp-entry").count()).resolves.toBe(2)
    await expect(page.locator(".mvp-entry-title").last().innerText()).resolves.toBe("Working")
    await expect(page.locator(".mvp-run-journal li[data-after]").count()).resolves.toBeGreaterThan(20)
    expect(errors).toEqual([])
  } finally { await page.close() }
}, 30_000)

test("a narrow window drops the rail and keeps the conversation and run", async () => {
  const { page, errors } = await open(900)
  try {
    await expect(page.locator(".mvp-rail").isVisible()).resolves.toBe(false)
    await expect(page.locator(".cx-chat .mvp-entry").count()).resolves.toBe(6)
    await expect(page.locator(".mvp-run").isVisible()).resolves.toBe(true)
    expect(errors).toEqual([])
  } finally { await page.close() }
}, 30_000)
