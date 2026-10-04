import { afterAll, beforeAll, expect, test } from "bun:test"
import { chromium, type Browser, type Page } from "playwright"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

let browser: Browser
let server: ReturnType<typeof Bun.serve>
beforeAll(async () => {
  // Isolate the browser bundle from Bun's test-module resolver.
  const build = Bun.spawn([process.execPath, fileURLToPath(new URL("./run-trace-phase-strip.build.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" })
  const [script, errors, status] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited])
  if (status !== 0) throw new Error(`Trace browser fixture did not build: ${errors}`)
  const font = await readFile(Bun.resolveSync("@fontsource/inter/files/inter-latin-400-normal.woff2", import.meta.dir))
  const styles = `@font-face{font-family:Inter;font-weight:400;src:url(data:font/woff2;base64,${font.toString("base64")}) format('woff2')}` +
    (await Promise.all(["tokens", "base", "cards", "chat"].map((name) =>
      readFile(new URL(`../../src/mainview/styles/${name}.css`, import.meta.url), "utf8")))).join("\n")
  server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => {
    const path = new URL(request.url).pathname
    if (path === "/fixture.js") return new Response(script, { headers: { "content-type": "text/javascript" } })
    return new Response(`<!doctype html><html><head><style>${styles}</style></head><body style="overflow:auto"><main id="fixture" style="width:400px;margin:24px"></main><script type="module" src="/fixture.js"></script></body></html>`, { headers: { "content-type": "text/html" } })
  } })
  browser = await chromium.launch()
}, 30000)
afterAll(async () => {
  try { await browser?.close() }
  finally { await server?.stop(true) }
}, 15_000)

const open = async (scenario: string): Promise<Page> => {
  const page = await browser.newPage({ viewport: { width: 1100, height: 1000 } })
  page.on("pageerror", (error) => console.error(error))
  page.setDefaultTimeout(10000)
  await page.goto(`${server.url}?scenario=${scenario}`)
  await page.locator(".run-phases").first().waitFor()
  await page.evaluate(() => document.fonts.ready)
  return page
}
const cursor = (page: Page) => page.evaluate(() => String(window.runTraceBrowser.cursor))
const settled = async (page: Page, seq: string) => {
  await page.waitForFunction((value) => String(window.runTraceBrowser?.cursor) === value, seq)
}

test("rendered milestone labels fit without intersections at 360, 400 and 900 pixels, including a resize", async () => {
  const page = await open("labels")
  try {
    for (const width of [400, 360, 900, 360]) {
      await page.locator("#fixture").evaluate((element, size) => { element.style.width = `${size}px` }, width)
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      const measured = await page.locator(".run-phase-pins").evaluate((container) => {
        const axis = container.getBoundingClientRect()
        const boxes = [...container.querySelectorAll(".run-phase-pin-label")].map((label) => {
          const box = label.getBoundingClientRect()
          return { text: label.textContent, x: box.x, y: box.y, right: box.right, bottom: box.bottom }
        })
        const overlaps = boxes.flatMap((box, index) => boxes.slice(index + 1).filter((other) =>
          Math.min(box.right, other.right) > Math.max(box.x, other.x) + 0.1 &&
          Math.min(box.bottom, other.bottom) > Math.max(box.y, other.y) + 0.1
        ).map((other) => [box.text, other.text]))
        const ticks = [...container.querySelectorAll(".run-phase-pin-tick")].map((tick) => {
          const box = tick.getBoundingClientRect()
          return { x: box.x, right: box.right }
        })
        return { boxes, ticks, overlaps, outside: boxes.filter((box) => box.x < axis.x - 0.1 || box.right > axis.right + 0.1 || box.y < axis.y - 0.1 || box.bottom > axis.bottom + 0.1),
          outsideTicks: ticks.filter((tick) => tick.x < axis.x - 0.1 || tick.right > axis.right + 0.1) }
      })
      expect(measured.overlaps, `label intersections at ${width}px`).toEqual([])
      expect(measured.outside, `labels outside their strip at ${width}px`).toEqual([])
      expect(measured.outsideTicks, `ticks outside their strip at ${width}px`).toEqual([])
      const evidence = process.env.STRIP_EVIDENCE_DIR
      if (evidence !== undefined) {
        await mkdir(evidence, { recursive: true })
        await page.locator(".run-phases").screenshot({ path: `${evidence}/strip-${width}.png` })
        await writeFile(`${evidence}/strip-${width}.json`, JSON.stringify(measured, null, 2))
      }
    }
  } finally { await page.close() }
}, 30000)

test("a cluster discloses every milestone to the keyboard and its last member selects its own sequence", async () => {
  const page = await open("cluster")
  try {
    const disclosure = page.locator(".run-phase-cluster summary")
    await disclosure.focus()
    await page.keyboard.press("Enter")
    await page.keyboard.press("Escape")
    expect(await disclosure.evaluate((element) => element === document.activeElement)).toBe(true)
    expect(await page.locator(".run-phase-cluster[open]").count()).toBe(0)
    await page.keyboard.press("Space")
    const members = page.locator(".run-phase-cluster[open] button")
    expect(await members.count()).toBeGreaterThan(3)
    const last = members.last()
    expect(await last.getAttribute("aria-label")).toBe("sufficiency · #8")
    for (let index = 0; index < await members.count(); index++) await page.keyboard.press("Tab")
    expect(await last.evaluate((element) => element === document.activeElement)).toBe(true)
    await page.keyboard.press("Enter")
    await settled(page, "8")
    expect(await page.evaluate(() => window.runTraceBrowser.selection)).toBe("frame-1")
    await page.reload()
    await settled(page, "8")
  } finally { await page.close() }
}, 30000)

test("new journal milestones are measured in an already mounted strip", async () => {
  const page = await open("live")
  try {
    await page.locator("#fixture").evaluate((element) => { element.style.width = "360px" })
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    expect(await page.locator(".run-phase-pin-label").count()).toBe(3)
    await page.evaluate(() => window.runTraceBrowser.appendMilestone())
    await page.waitForFunction(() => document.querySelectorAll(".run-phase-pin-label").length === 4)
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const intersections = await page.locator(".run-phase-pin-label").evaluateAll((labels) => {
      const boxes = labels.map((label) => label.getBoundingClientRect())
      return boxes.flatMap((box, index) => boxes.slice(index + 1).filter((other) =>
        Math.min(box.right, other.right) > Math.max(box.left, other.left) + 0.1 &&
        Math.min(box.bottom, other.bottom) > Math.max(box.top, other.top) + 0.1))
    })
    expect(intersections).toEqual([])
  } finally { await page.close() }
}, 30000)

test("every keyboard stop caps the recorded log and all position keys preserve their direction", async () => {
  const page = await open("scrub")
  try {
    const slider = page.getByRole("slider", { name: "Run position" })
    await slider.focus()
    await page.keyboard.press("Home")
    await settled(page, "1")
    for (let seq = 1; seq <= 17; seq++) {
      if (seq > 1) { await page.keyboard.press("ArrowRight"); await settled(page, String(seq)) }
      expect(await slider.getAttribute("aria-valuenow")).toBe(String(seq))
      const lines = [2, 6, 10, 14].filter((firstCall) => firstCall <= seq).length
      expect(await page.locator("[data-frame-line]").count()).toBe(lines)
      for (let frame = 0; frame < lines; frame++) {
        expect(await page.locator("[data-frame-line]").nth(frame).innerText()).toContain(`${frame}.ts`)
        expect(await page.locator("[data-frame-line]").nth(frame).innerText().then((text) => text.includes(`result ${frame}`)))
          .toBe(3 + frame * 4 <= seq)
      }
    }
    for (const [key, seq] of [["ArrowLeft", 16], ["ArrowDown", 15], ["ArrowUp", 16], ["PageDown", 6], ["PageUp", 16], ["End", 17], ["Home", 1]] as const) {
      await page.keyboard.press(key)
      await settled(page, String(seq))
    }
  } finally { await page.close() }
}, 30000)

test("a cancelled pointer gesture restores the persisted cursor without dispatching", async () => {
  const page = await open("scrub")
  try {
    const track = page.locator(".run-phase-track")
    const box = (await track.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.75, box.y + box.height / 2)
    await track.dispatchEvent("pointercancel", { pointerId: 1 })
    await page.mouse.up()
    expect(await cursor(page)).toBe("latest")
    expect(await page.evaluate(() => window.runTraceBrowser.commands)).toEqual([])
    expect(await track.evaluate((element) => element.style.getPropertyValue("--scrub-preview"))).toBe("")
  } finally { await page.close() }
}, 30000)

test("dragging within one phase commits once on release, caps the log, reloads and can move forward or return to Latest", async () => {
  const page = await open("scrub")
  try {
    expect(await page.locator("[data-phase-band]").count()).toBe(1)
    const slider = page.getByRole("slider", { name: "Run position" })
    const box = (await slider.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.1, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 20 })
    expect(await cursor(page)).toBe("latest")
    expect(await page.evaluate(() => window.runTraceBrowser.commands)).toEqual([])
    await page.mouse.up()
    await page.waitForFunction(() => window.runTraceBrowser.cursor !== "latest")
    expect(await page.evaluate(() => window.runTraceBrowser.commands)).toHaveLength(1)
    const parked = (await cursor(page))!
    expect(Number(parked)).toBeGreaterThan(4)
    expect(Number(parked)).toBeLessThan(14)
    const rows = await page.locator("[data-frame-line]").count()
    expect(rows).toBeLessThan(4)
    await page.reload()
    await settled(page, parked)
    expect(await page.locator("[data-frame-line]").count()).toBe(rows)
    await slider.focus()
    await page.keyboard.press("ArrowRight")
    await settled(page, String(Number(parked) + 1))
    await page.keyboard.press("End")
    await settled(page, "17")
    expect(await page.locator("[data-frame-line]").count()).toBe(4)
    await page.keyboard.press("Home")
    await settled(page, "1")
    expect(await page.locator("[data-frame-line]").count()).toBe(0)
    await page.getByRole("button", { name: "Latest", exact: true }).click()
    await settled(page, "latest")
    await page.reload()
    await settled(page, "latest")
    expect(await page.locator("[data-frame-line]").count()).toBe(4)
  } finally { await page.close() }
}, 30000)

test("interleaved native steps keep every pin, cluster member and slider position on its own step", async () => {
  const page = await open("interleaved")
  try {
    // The scope word comes from the fixture's own step coordinates, so a
    // selection that names it is evidence independent of the fold's ids.
    const owner = async () => {
      const selection = await page.evaluate(() => window.runTraceBrowser.selection)
      return [selection.includes(encodeURIComponent('"left"')), selection.includes(encodeURIComponent('"right"'))]
    }
    await page.locator('.run-phase-pin[aria-label="read-only · #3"]').click()
    await settled(page, "3")
    expect(await owner()).toEqual([true, false])
    await page.locator('.run-phase-pin[aria-label="repeat · #4"]').click()
    await settled(page, "4")
    expect(await owner()).toEqual([false, true])
    const cluster = page.locator(".run-phase-cluster")
    await cluster.locator("summary").click()
    await cluster.locator('button[aria-label="sufficiency · #6"]').click()
    await settled(page, "6")
    expect(await owner()).toEqual([false, true])
    const slider = page.getByRole("slider", { name: "Run position" })
    await slider.focus()
    await page.keyboard.press("Home")
    await settled(page, "1")
    expect(await owner()).toEqual([true, false])
    await page.keyboard.press("ArrowRight")
    await settled(page, "2")
    expect(await owner()).toEqual([false, true])
    // The persisted cursor and its owning frame both survive a reload.
    await page.reload()
    await settled(page, "2")
    expect(await owner()).toEqual([false, true])
  } finally { await page.close() }
}, 30000)

test("the band a moment is in is the one that recorded it, not the one that started last", async () => {
  const page = await open("interleaved")
  try {
    const current = page.locator("[data-phase-band][aria-current=location]")
    await page.locator('.run-phase-pin[aria-label="read-only · #3"]').click()
    await settled(page, "3")
    expect(await current.count()).toBe(1)
    expect(await current.getAttribute("data-phase-band")).toBe("researching")
    await page.locator('.run-phase-pin[aria-label="repeat · #4"]').click()
    await settled(page, "4")
    expect(await current.count()).toBe(1)
    expect(await current.getAttribute("data-phase-band")).toBe("implementing")
  } finally { await page.close() }
}, 30000)

test("a band door commits its own sequence, including the band the journal's last record opened", async () => {
  const page = await open("tail")
  try {
    const bands = page.locator("button[data-phase-band]")
    const seqs = await bands.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-seq")))
    expect(seqs).toEqual(["1", "5", "9"])
    const latest = await page.evaluate(() => Number(document.querySelector('[role="slider"]')!.getAttribute("aria-valuemax")))
    expect(latest, "the last band must open at the journal's last position").toBe(9)
    const door = (seq: string) => page.locator(`button[data-phase-band][data-seq="${seq}"]`)
    await door("1").focus()
    await door("1").press("Enter")
    await settled(page, "1")
    await door("5").focus()
    await door("5").press("Space")
    await settled(page, "5")
    await door("9").focus()
    await door("9").press("Space")
    expect(await page.evaluate(() => window.runTraceBrowser.refusals)).toEqual([])
    await settled(page, "9")
  } finally { await page.close() }
}, 30000)

test("a band door still commits when its own band grows under the keypress", async () => {
  const page = await open("tail-live")
  try {
    const door = page.locator('button[data-phase-band][data-seq="9"]')
    const last = () => page.evaluate(() => Number(document.querySelector('[role="slider"]')!.getAttribute("aria-valuemax")))
    const bands = () => page.locator("button[data-phase-band]").count()
    expect(await door.count()).toBe(1)
    expect(await last()).toBe(9)
    await door.focus()
    // Space activates a button on keyup. A live run appends to its last band
    // between the two, which is the one band a keypress can outlive.
    await page.keyboard.down("Space")
    await page.evaluate(() => window.runTraceBrowser.appendFrame())
    await page.waitForFunction(() => document.querySelector('[role="slider"]')!.getAttribute("aria-valuemax") === "10")
    await page.keyboard.up("Space")
    // The band grew under the key; it was not replaced by another one.
    expect(await bands()).toBe(3)
    expect(await last()).toBe(10)
    expect(await page.evaluate(() => window.runTraceBrowser.refusals)).toEqual([])
    await settled(page, "9")
  } finally { await page.close() }
}, 30000)


test("a pointer release inside a band commits a position inside that band, even where nothing was recorded", async () => {
  const page = await open("gap")
  try {
    const seqs = await page.locator("button[data-phase-band]").evaluateAll((nodes) => nodes.map((node) => Number(node.getAttribute("data-seq"))))
    expect(seqs).toEqual([1, 5, 6])
    const band = page.locator('button[data-phase-band][data-seq="5"]')
    const box = (await band.boundingBox())!
    const y = box.y + box.height / 2
    await page.mouse.move(box.x + box.width * 0.15, y)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.9, y, { steps: 8 })
    await page.mouse.up()
    await page.waitForFunction(() => window.runTraceBrowser.cursor !== "latest")
    const parked = Number(await cursor(page))
    // The band the pointer was released in runs from 5 up to the next band at 6.
    expect(parked, "a release inside one band commits inside it").toBeGreaterThanOrEqual(5)
    expect(parked, "a release inside one band commits inside it").toBeLessThan(6)
  } finally { await page.close() }
}, 30000)
