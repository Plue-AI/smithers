import type { Page } from "./browserTest"
import { expect,test } from "./browserTest"

/*
 * Control focus ("spotlight"): taking a card's embedded surface dims the rest
 * of the app modal-style — ONE layer on the body with a hole cut where the
 * surface shows — but the layer is pointer-events:none, so hover and wheel
 * still reach the dimmed content. Clicking out releases exactly like a modal
 * backdrop: the releasing click is swallowed (it does not activate what it
 * landed on) and only the NEXT click acts.
 *
 * Three of the four things asserted here are invisible to a unit test and were
 * shipped broken: the dim composited two and three deep in visible bands, the
 * release affordance was scrolled out of reach while `toBeVisible()` still
 * passed (a bounding box is not a hit test), and its own styling lost every
 * declaration to `.sui-button-ghost` and `.setup-checklist button`.
 *
 * The surface used to be a Wiki note's editor. The browser card is the
 * other card-shaped surface the module detects (state/controller/controlFocus.ts KINDS), so the geometry the tests
 * measure — the box, its header, the inner element focus lands on — is the
 * same shape, and every assertion below is the one it always made.
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    try {
      window.localStorage.clear()
    } catch {
      // Storage the browser refuses is the empty store already.
    }
  })
})

/*
 * The page the card embeds. A browser card frames only an absolute http(s)
 * URL on another origin (packages/rpc Cards.ts, ConversationCards.tsx
 * `foreignHttpUrl`), so it is a foreign origin this spec answers itself: the
 * frame reaches no network.
 */
const PAGE_URL = "https://embedded.example/"

/** Open a browser card showing its embedded page: the surface control focus dresses. */
const openControlledSurface = async (page: Page) => {
  /*
   * The T1 host runs offline, so it advertises no page reader and answers no
   * fetch. Both reads are answered here — the real bootstrap plus the one
   * capability the flow needs, and the reader's own reply — because what is
   * under test is the client's dim, not the service behind the frame.
   */
  await page.route("**/api/bootstrap", async (route) => {
    const bootstrap = await (await route.fetch()).json() as { readonly capabilities: ReadonlyArray<string> }
    await route.fulfill({ json: { ...bootstrap, capabilities: [...new Set([...bootstrap.capabilities, "browser.read"])] } })
  })
  await page.route("**/api/tools/browser-fetch", (route) =>
    route.fulfill({ json: { status: 200, finalUrl: PAGE_URL, contentType: "application/json", text: "ok", frameable: true, blockReason: null } }))
  await page.route(PAGE_URL, (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><title>Embedded</title><p>Embedded page</p>" }))
  await page.goto("/")
  await expect(page.locator(".app-shell")).toBeVisible()
  await page.keyboard.press("Control+k")
  const composer = page.getByTestId("composer-input")
  await expect(composer).toBeVisible()

  /* A page embedded as a browser card; its frame is the surface. */
  await composer.fill(`/browser.open ${PAGE_URL}`)
  await composer.press("Enter")
  const card = page.locator(".smithers-card[data-kind='browser']").last()
  await expect(card).toBeVisible()
  const surface = card.locator("iframe[class~='browser-card-frame']")
  await expect(surface).toBeVisible({ timeout: 15_000 })
  /* The composer dock is a fixed layer over the transcript while open; Escape closes it (2026-09-08 brief). */
  await page.keyboard.press("Escape")
  await expect(composer).toBeHidden()
  return { card, composer, surface }
}

/** Where the release affordance actually answers a pointer, which `toBeVisible()` never asks. */
const releaseIsReachable = async (page: Page): Promise<boolean> =>
  page.evaluate(() => {
    const button = document.querySelector("[data-control-focus-release]")
    if (button === null) return false
    const rect = button.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
    return hit === button || button.contains(hit)
  })

/*
 * The invariant, measured in pixels rather than argued from stacking rules:
 * every pixel outside the controlled surface is darkened EXACTLY once. The
 * shipped ladder failed it in three bands at this very viewport — the window's
 * top strip untouched, one layer over the lesson header, two below it.
 *
 * The experiment holds the DOM still and toggles only the layer, so nothing
 * but the dim can move a pixel; two frames of the undimmed state mask off what
 * the page animates on its own (the embedded page, the help bubble).
 */
test("the dim is one layer: every pixel outside the surface is darkened exactly once", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 520 })
  const { surface } = await openControlledSurface(page)
  await surface.click()
  await expect(page.locator(".control-focus-dim")).toHaveCount(1)

  const setDim = async (shown: boolean) => {
    await page.evaluate((shown) => {
      for (const layer of document.querySelectorAll<HTMLElement>(".control-focus-dim")) {
        layer.style.display = shown ? "" : "none"
      }
    }, shown)
    await page.waitForTimeout(250)
  }
  await setDim(false)
  const plainA = (await page.screenshot({ animations: "disabled" })).toString("base64")
  const plainB = (await page.screenshot({ animations: "disabled" })).toString("base64")
  await setDim(true)
  const dimmed = (await page.screenshot({ animations: "disabled" })).toString("base64")

  const alpha = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-focus-dim")) / 100
  )
  expect(alpha).toBeGreaterThan(0)

  const survey = await page.evaluate(
    async ({ plainA, plainB, dimmed, alpha }) => {
      const load = async (b64: string) => {
        const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob())
        const canvas = new OffscreenCanvas(bitmap.width, bitmap.height)
        const context = canvas.getContext("2d")!
        context.drawImage(bitmap, 0, 0)
        return { width: bitmap.width, height: bitmap.height, data: context.getImageData(0, 0, bitmap.width, bitmap.height).data }
      }
      const a = await load(plainA)
      const b = await load(plainB)
      const d = await load(dimmed)
      const luma = (image: typeof a, x: number, y: number) => {
        const i = (image.width * y + x) << 2
        return 0.2126 * image.data[i]! + 0.7152 * image.data[i + 1]! + 0.0722 * image.data[i + 2]!
      }
      /* One layer of rgb(20 17 12) at the token's alpha over luma L. */
      const ink = 0.2126 * 20 + 0.7152 * 17 + 0.0722 * 12
      const once = (l: number) => l * (1 - alpha) + ink * alpha
      const hole = document.querySelector("[data-control-focus]")!.getBoundingClientRect()
      const scale = a.width / window.innerWidth
      const counts = { once: 0, untouched: 0, twice: 0, other: 0 }
      const examples: Array<Record<string, number>> = []
      for (let y = 8; y < a.height - 8; y += 4) {
        for (let x = 8; x < a.width - 8; x += 4) {
          if (x >= (hole.x - 8) * scale && x <= (hole.right + 8) * scale && y >= (hole.y - 8) * scale && y <= (hole.bottom + 8) * scale) continue
          const base = luma(a, x, y)
          /* Only pixels the page itself holds still, and only where the 1.5px blur cannot move ink in. */
          let steady = Math.abs(luma(b, x, y) - base) <= 1
          for (let dy = -3; steady && dy <= 3; dy++) {
            for (let dx = -3; steady && dx <= 3; dx++) steady = Math.abs(luma(a, x + dx, y + dy) - base) <= 1
          }
          if (!steady) continue
          const lit = luma(d, x, y)
          if (Math.abs(lit - once(base)) <= 2.5) counts.once++
          else if (Math.abs(lit - base) <= 2.5) {
            counts.untouched++
            if (examples.length < 5) examples.push({ x, y, base: Math.round(base), lit: Math.round(lit) })
          } else if (Math.abs(lit - once(once(base))) <= 2.5) {
            counts.twice++
            if (examples.length < 5) examples.push({ x, y, base: Math.round(base), lit: Math.round(lit) })
          } else {
            counts.other++
            if (examples.length < 5) examples.push({ x, y, base: Math.round(base), lit: Math.round(lit) })
          }
        }
      }
      return { counts, examples }
    },
    { plainA, plainB, dimmed, alpha }
  )

  const { once, untouched, twice, other } = survey.counts
  /* A survey this small would prove nothing; the window holds thousands of steady pixels. */
  expect(once + untouched + twice + other).toBeGreaterThan(2000)
  expect({ untouched, twice, other, examples: survey.examples }).toEqual({ untouched: 0, twice: 0, other: 0, examples: [] })
})

/*
 * The BOX, not the element that took focus. Will's words are "we show the box
 * it's in expand just a tad": the hole, the ring and the affordance all dress
 * the card, so its title row and its footer stay bright with the rest of it.
 * The embedded frame is what focus lands on and what names the surface, and
 * it must never be what the geometry is measured from — this viewport is tall
 * enough that the whole card is on screen, so the two are plainly different
 * rectangles and a regression cannot hide behind a scroller's clipping.
 */
test("the hole is the card's box, not the inner element that took focus", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 })
  const { card, surface } = await openControlledSurface(page)
  await surface.click()
  await expect(page.locator(".control-focus-dim")).toHaveCount(1)

  /*
   * The card element comes from the locator the test clicked into: during the
   * app the controls can appear both in cards and the live shell
   * behind it, at `opacity: 0`), so a fresh `querySelector` can pick the copy
   * the user never sees.
   */
  const geometry = await card.evaluate((cardElement) => {
    const rect = (element: Element) => {
      const box = element.getBoundingClientRect()
      return [Math.round(box.left), Math.round(box.top), Math.round(box.right), Math.round(box.bottom)]
    }
    const dim = document.querySelector<HTMLElement>(".control-focus-dim")!
    /* Whatever wears the ring, named rather than assumed, so a regression reads as itself. */
    const marked = document.querySelector("[data-control-focus]")!
    const card = cardElement
    /* The layer's path is the viewport, then the hole; the hole is the second subpath. */
    const hole = (getComputedStyle(dim).clipPath.split("Z")[1]!.match(/-?[\d.]+/g) ?? []).slice(0, 4).map(Number)
    return {
      hole,
      card: rect(card),
      header: rect(card.querySelector(".smithers-card-header")!),
      surface: rect(card.querySelector("iframe[class~='browser-card-frame']")!),
      outset: Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--control-focus-outset")),
      marked: `${marked.tagName.toLowerCase()}.${(marked.className || "").toString().split(" ")[0] ?? ""}`,
      markedIsTheCard: marked === card,
      markers: document.querySelectorAll("[data-control-focus]").length,
      surfaceIsMarked: card.querySelector("iframe[class~='browser-card-frame']")!.hasAttribute("data-control-focus")
    }
  })

  /* One box wears the ring, and it is the card. */
  expect(geometry.markers).toBe(1)
  expect({ marked: geometry.marked, isTheCard: geometry.markedIsTheCard }).toEqual({ marked: "section.smithers-card", isTheCard: true })
  expect(geometry.surfaceIsMarked).toBe(false)
  /* The hole IS the card, grown by the ring's own outset so the ring is not dimmed either. */
  const { card: box, outset } = geometry
  expect(geometry.hole).toEqual([box[0]! - outset, box[1]! - outset, box[2]! + outset, box[3]! + outset])
  /* Which is strictly bigger than the element focus landed on, and covers the card's title row. */
  expect(geometry.surface[1]!).toBeGreaterThan(geometry.hole[1]!)
  expect(geometry.header[1]!).toBeGreaterThanOrEqual(geometry.hole[1]!)
  expect(geometry.header[3]!).toBeLessThanOrEqual(geometry.hole[3]!)
  /* The whole card is on screen at this viewport, so nothing above is a scroller's doing. */
  expect(box[3]! - box[1]!).toBeGreaterThan(geometry.surface[3]! - geometry.surface[1]!)

  await expect(card).toHaveAttribute("data-control-focus", "human")
})

/*
 * The affordance is the ONLY way out of a focused cross-origin frame — that
 * surface swallows every key, Escape included — so "reachable" has to mean a
 * pointer lands on it, at every viewport. `toBeVisible()` checks a bounding
 * box and passed while the card's own scroller had scrolled the button away.
 */
test("the release affordance is reachable at every viewport, and reads as a control", async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 520 })
  const { card, surface } = await openControlledSurface(page)
  await surface.click()
  const release = card.locator("[data-control-focus-release]")
  await expect(release).toHaveText("Release control")

  for (const size of [
    { width: 1100, height: 520 },
    { width: 980, height: 700 },
    { width: 1440, height: 900 },
    { width: 1280, height: 460 },
    { width: 760, height: 600 }
  ]) {
    await page.setViewportSize(size)
    await expect.poll(async () => releaseIsReachable(page), { timeout: 5_000 }).toBe(true)
  }

  /* And it looks like a control: its own recipe, not the ghost button's transparent one. */
  const style = await release.evaluate((element) => {
    const computed = getComputedStyle(element)
    return {
      fontSize: computed.fontSize,
      background: computed.backgroundColor,
      borderColor: computed.borderTopColor,
      borderWidth: computed.borderTopWidth
    }
  })
  expect(style.fontSize).toBe("11px")
  expect(style.borderWidth).toBe("1px")
  for (const colour of [style.background, style.borderColor]) {
    expect(colour).not.toBe("rgba(0, 0, 0, 0)")
    expect(colour).not.toBe("transparent")
  }
  /* An opaque fill, so the label is legible over a terminal or a frame. */
  expect(style.background).toMatch(/^rgb\(/)

  /* It releases, and takes the dim with it. */
  await release.click()
  await expect(page.locator(".control-focus-dim")).toHaveCount(0)
  await expect(card).not.toHaveAttribute("data-control-focus", /./)
})

test('first-sight help does not take keyboard focus', async ({ page }) => {
  await page.goto('/')
  const dismiss = page.getByRole('button', { name: 'Dismiss', exact: true })
  await dismiss.focus()
  await expect(dismiss).toBeFocused()
  await expect(page.locator('.help-bubble')).toHaveCount(1)
  await expect(dismiss).toBeFocused()
})
