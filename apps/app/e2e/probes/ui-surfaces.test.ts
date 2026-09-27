import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"
import { mkdir, readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { fixtureCards } from "../../src/mainview/cards/fixtures/UiSurfaces"

/*
 * The surfaces smithers-ui-DESIGN.md extends, rendered in a real browser at
 * desktop and phone widths, light and dark: every card mounts with no console
 * error and no horizontal overflow, and `UI_EVIDENCE_DIR` receives one
 * screenshot per card, width and theme.
 */
let browser: Browser
let server: ReturnType<typeof Bun.serve>
const evidence = process.env.UI_EVIDENCE_DIR
beforeAll(async () => {
  const build = Bun.spawn([process.execPath, fileURLToPath(new URL("./ui-surfaces.build.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" })
  const [script, errors, status] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])
  if (status !== 0) throw new Error(`UI surfaces fixture did not build: ${errors}`)
  const font = await readFile(Bun.resolveSync("@fontsource/inter/files/inter-latin-400-normal.woff2", import.meta.dir))
  const mono = await readFile(Bun.resolveSync("@fontsource/ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", import.meta.dir))
  const styles = `@font-face{font-family:Inter;font-weight:400;src:url(data:font/woff2;base64,${font.toString("base64")}) format('woff2')}` +
    `@font-face{font-family:"IBM Plex Mono";font-weight:400;src:url(data:font/woff2;base64,${mono.toString("base64")}) format('woff2')}` +
    (await Promise.all(["tokens", "base", "chat", "cards", "github-cards", "identity", "threads"].map((name) =>
      readFile(new URL(`../../src/mainview/styles/${name}.css`, import.meta.url), "utf8")))).join("\n")
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    const path = new URL(request.url).pathname
    if (path === "/fixture.js") return new Response(script, { headers: { "content-type": "text/javascript" } })
    return new Response(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><style>${styles}
      body { margin: 0; background: var(--bg); } main { padding: 16px; max-width: 900px; margin: 0 auto; box-sizing: border-box; width: 100%; }</style></head>
      <body><main id="fixture"></main><script type="module" src="/fixture.js"></script></body></html>`, { headers: { "content-type": "text/html" } })
  } })
  browser = await chromium.launch()
  if (evidence !== undefined) await mkdir(evidence, { recursive: true })
}, 60_000)
afterAll(async () => {
  try { await browser?.close() }
  finally { await server?.stop(true) }
}, 15_000)

const open = async (width: number, theme: "light" | "dark", card?: string): Promise<{ page: Page; errors: string[] }> => {
  const errors: string[] = []
  const page = await browser.newPage({ viewport: { width, height: 1000 }, colorScheme: theme })
  page.on("pageerror", (error) => errors.push(String(error)))
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()) })
  page.setDefaultTimeout(15_000)
  await page.goto(`${server.url}?theme=${theme}${card === undefined ? "" : `&card=${encodeURIComponent(card)}`}`)
  await page.locator(".smithers-card").first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  return { page, errors }
}

const cards = fixtureCards()
for (const width of [1280, 390]) {
  for (const theme of ["light", "dark"] as const) {
    test(`every surface renders at ${width}px in ${theme} with no console error and no horizontal overflow`, async () => {
      const { page, errors } = await open(width, theme)
      try {
        for (const card of cards) {
          const node = page.getByTestId(`card-${card.id}`)
          await node.waitFor()
          expect(await node.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
          if (evidence !== undefined) await node.screenshot({ path: `${evidence}/${card.kind}-${width}-${theme}.png` })
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
        if (evidence !== undefined) await page.screenshot({ path: `${evidence}/all-${width}-${theme}.png`, fullPage: true })
        expect(errors).toEqual([])
      } finally { await page.close() }
    }, 60_000)
  }
}

test("the surfaces answer the keyboard: a conversation row opens on Enter, a step row expands on Enter, a Runs door names its agent", async () => {
  const { page, errors } = await open(1280, "light")
  try {
    const row = page.locator(".thread-row-btn").first()
    await row.focus()
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => window.uiSurfaces.commands.some((command) => command.name === "issues.view"))
    expect(await page.evaluate(() => window.uiSurfaces.commands.find((command) => command.name === "issues.view")?.args)).toContain("2104 example/app")
    const step = page.locator(".run-step").first()
    await step.focus()
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => document.querySelector(".run-step[aria-expanded='true']") !== null)
    expect(await page.locator(".run-trace-pane").count()).toBe(1)
    const runs = page.getByTestId("agent-runs-engineer")
    await runs.focus()
    await page.keyboard.press("Enter")
    await page.waitForFunction(() => window.uiSurfaces.commands.some((command) => command.name === "runs.list"))
    expect(await page.evaluate(() => window.uiSurfaces.commands.find((command) => command.name === "runs.list")?.args)).toContain("engineer")
    expect(await page.locator(".run-outcome-condition[data-condition='runaway']").first().textContent()).toContain("Runaway")
    expect(errors).toEqual([])
  } finally { await page.close() }
}, 60_000)

test("the subagent grid draws running, waiting and done cards, and answers the keyboard", async () => {
  for (const width of [1280, 390]) {
    for (const theme of ["light", "dark"] as const) {
      const { page, errors } = await open(width, theme)
      try {
        const grid = page.getByTestId("subagents")
        await grid.waitFor()
        await grid.scrollIntoViewIfNeeded()
        expect(await grid.locator(".subagent-card").count()).toBe(3)
        expect(await grid.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true)
        if (width === 1280 && theme === "light") {
          const first = grid.locator(".subagent-card").first()
          expect(await first.locator(".subagent-stop").isVisible()).toBe(false)
          await first.focus()
          expect(await first.locator(".subagent-stop").isVisible()).toBe(true)
          // Cards sharing a row share its height.
          const heights = await grid.locator(".subagent-card").evaluateAll((cards) => cards.map((card) => card.getBoundingClientRect().height))
          expect(new Set(heights).size).toBe(1)
          await page.keyboard.press("ArrowRight")
          await page.keyboard.press("Enter")
          await page.waitForFunction(() => window.uiSurfaces.commands.some((command) => command.name === "runs.open"))
          expect(await page.evaluate(() => window.uiSurfaces.commands.find((command) => command.name === "runs.open")?.args)).toBe("run-db-migrate example/app")
          await first.focus()
        }
        if (evidence !== undefined) await grid.screenshot({ path: `${evidence}/subagents-${width}-${theme}.png` })
        expect(errors).toEqual([])
      } finally { await page.close() }
    }
  }
}, 60_000)
