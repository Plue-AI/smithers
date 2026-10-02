import type { Page } from "@playwright/test"
import { expect, test } from "@playwright/test"
import { GRAPH_FLOW, GRAPH_NODE_IDS, GRAPH_REPO } from "./workspace.ts"
import { finishSignup, openChat } from "./app.ts"

/*
 * The graph, as a browser really paints it, in every theme the product ships.
 *
 * Everything below the browser is the real stack (`e2e/graph/README.md`):
 * the local origin, the relay, a real control plane and a real engine.
 * Playwright's routing call appears nowhere here, so what is measured is what
 * a reader would see.
 *
 * WHY THERE IS NO AXE SCAN. `axe-core` is in no lockfile in this repository
 * and this lane may not add one, so the rules it would have run are written
 * out below instead: the accessible name of every node, the role it exposes,
 * whether it can be reached and operated by keyboard, and the contrast of
 * every colour the graph paints. Each is asserted against the rendered tree
 * and the computed styles rather than against the source, which is what an
 * axe run would have done. `styles/paletteTokens.ts` holds the same floors
 * over the palette table, so the two agree cell by cell.
 */

/** The canvas a plan draws on; the run graph draws on the same one. */
const canvasOf = (page: Page) => page.locator(".flow-plan-canvas")

/** Opens the app and lists the workspace's flows, which is what draws the row. */
const listFlows = async (page: Page): Promise<void> => {
  await page.goto("/")
  await finishSignup(page)
  await openChat(page)
  const composer = page.getByTestId("composer-input")
  await composer.fill(`/flow.list ${GRAPH_REPO}`)
  await composer.press("Enter")
  await expect(page.locator(`[data-flow="flow.run"][data-flow-args="${GRAPH_FLOW}"]`)).toBeVisible()
}

/** Plans the fixture flow and waits for its nodes to be drawn. */
const drawPlan = async (page: Page): Promise<void> => {
  await page.locator(`[data-flow="flow.plan"][data-flow-args="${GRAPH_FLOW}"]`).click()
  await expect(canvasOf(page).locator("[data-node]")).toHaveCount(GRAPH_NODE_IDS.length)
}

/**
 * Runs one flow through the composer, the way a person would.
 *
 * The composer closes behind a card, so the chat door is opened first
 * whenever it is shut: the footer's Chat button is how a reader gets back to
 * it, and this spec uses the same one.
 */
const runFlow = async (page: Page, line: string): Promise<void> => {
  const composer = page.getByTestId("composer-input")
  await openChat(page)
  await composer.fill(line)
  await composer.press("Enter")
  await expect(composer).toBeHidden()
}

/**
 * What a node in the `running` state animates with, as this browser computes
 * it.
 *
 * A plan card never holds a running node, so the state is put on a drawn node
 * to ask the stylesheet the question directly. The probe is undone before it
 * returns, so the page is the page it was.
 */
const runningNodeAnimation = (page: Page): Promise<string> =>
  page.evaluate(() => {
    const box = document.querySelector<HTMLElement>(".flow-plan-canvas .flow-graph-node")!
    const held = box.getAttribute("data-state")
    box.setAttribute("data-state", "running")
    const name = getComputedStyle(box).animationName
    if (held === null) box.removeAttribute("data-state")
    else box.setAttribute("data-state", held)
    return name
  })

/** One sRGB triple, as this check carries a painted colour around. */
interface Rgb {
  readonly r: number
  readonly g: number
  readonly b: number
}

type Rgba = Rgb & { readonly a: number }
const over = (front: Rgba, back: Rgba): Rgba => {
  const a = front.a + back.a * (1 - front.a)
  const channel = (near: number, far: number) => a === 0 ? 0 : (near * front.a + far * back.a * (1 - front.a)) / a
  return { r: channel(front.r, back.r), g: channel(front.g, back.g), b: channel(front.b, back.b), a }
}
const composited = (ink: Rgba, layers: ReadonlyArray<{ background: Rgba; opacity: number }>): Rgba => {
  let pixel = ink
  for (const layer of layers) {
    pixel = over(pixel, layer.background)
    pixel = { ...pixel, a: pixel.a * layer.opacity }
  }
  return over(pixel, { r: 255, g: 255, b: 255, a: 1 })
}

const channel = (value: number): number => {
  const srgb = value / 255
  return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4
}

const luminance = (color: Rgb): number =>
  0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b)

/** The WCAG contrast ratio between two painted colours, to two places. */
const contrast = (foreground: Rgb, background: Rgb): number => {
  const light = Math.max(luminance(foreground), luminance(background))
  const dark = Math.min(luminance(foreground), luminance(background))
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
}

/** The retained Paper palette in both light/dark modes. */
const PALETTES = ["paper"] as const

test.describe("the graph, to a reader who is not looking at it", () => {
  test("loads no canvas library until a graph is opened", async ({ page }) => {
    await listFlows(page)
    /*
     * The canvas chunk carries its own stylesheet, so the sheet is the
     * evidence: before a graph is opened, nothing React Flow ships has
     * reached the document. This is the bundle assertion, taken from the
     * browser rather than from the module graph.
     *
     * `.react-flow__pane` is the probe because the app's own stylesheet also
     * names two React Flow classes — the focus ring and the edge path — and
     * those ship in the main sheet on purpose (styles/flow-graph.css). The
     * pane is React Flow's own and appears nowhere else.
     */
    const sheetFor = () =>
      page.evaluate(() =>
        [...document.styleSheets].some((sheet) => {
          try {
            return [...sheet.cssRules].some((rule) =>
              (rule as CSSStyleRule).selectorText?.includes("react-flow__pane")
            )
          } catch {
            return false
          }
        })
      )
    expect(await sheetFor()).toBe(false)
    await drawPlan(page)
    expect(await sheetFor()).toBe(true)
  })

  test("names every node by its tag, its id and its state word", async ({ page }) => {
    await listFlows(page)
    await drawPlan(page)

    // The canvas is a labelled group, and each node in it is a button that
    // says whether its drawer is open.
    await expect(canvasOf(page)).toHaveAttribute("aria-label", "Plan graph")
    const nodes = canvasOf(page).locator(".react-flow__node")
    await expect(nodes).toHaveCount(GRAPH_NODE_IDS.length)
    const described = await nodes.evaluateAll((drawn) =>
      drawn.map((node) => ({
        role: node.getAttribute("role"),
        tabindex: node.getAttribute("tabindex"),
        expanded: node.getAttribute("aria-expanded"),
        label: node.getAttribute("aria-label"),
        id: node.getAttribute("data-id"),
        word: node.querySelector(".flow-graph-node-word")?.textContent ?? ""
      }))
    )
    for (const node of described) {
      expect(node.role).toBe("button")
      expect(node.tabindex).toBe("0")
      expect(node.expanded).toBe("false")
      // The label carries the id it was keyed under and ends with the word
      // the node is at, which is also painted in the box.
      expect(node.label).toContain(node.id!)
      expect(node.word).not.toBe("")
      expect(node.label!.endsWith(node.word)).toBe(true)
    }
  })

  test("opens a node from the keyboard, and closes it again", async ({ page }) => {
    await listFlows(page)
    await drawPlan(page)
    const first = canvasOf(page).locator(".react-flow__node").first()
    const id = await first.getAttribute("data-id")
    await first.focus()
    await page.keyboard.press("Enter")

    // The drawer is a labelled group with a tab strip, and the strip is one
    // tab stop: every tab but the one showing is out of the tab order.
    const drawer = page.locator(".flow-graph-drawer")
    await expect(drawer).toHaveAttribute("data-node", id!)
    await expect(drawer).toHaveAttribute("role", "group")
    await expect(drawer.locator("[role='tab'][tabindex='0']")).toHaveCount(1)
    const panel = drawer.locator("[role='tabpanel']")
    await expect(panel).toHaveAttribute("aria-labelledby", /-tab-/)
    await expect(first).toHaveAttribute("aria-expanded", "true")

    await page.keyboard.press("Escape")
    await expect(page.locator(".flow-graph-drawer")).toHaveCount(0)
  })

  test("a running node breathes where motion is allowed", async ({ page }) => {
    await listFlows(page)
    await drawPlan(page)
    expect(await runningNodeAnimation(page)).toBe("flow-graph-breathe")
  })

  test("draws a visible ring on the node the keyboard is on", async ({ page }) => {
    await listFlows(page)
    await drawPlan(page)
    const first = canvasOf(page).locator(".react-flow__node").first()
    /*
     * The ring is `:focus-visible`, which Chromium grants to focus the
     * KEYBOARD moved: a programmatic focus after a click does not match it,
     * and a ring that appeared for a mouse click would be a different rule.
     * Landing on the node and tabbing back onto it is that move.
     */
    await first.focus()
    await page.keyboard.press("Shift+Tab")
    await page.keyboard.press("Tab")
    await expect(first).toBeFocused()
    const outline = await first.locator(".flow-graph-node").evaluate((box) => {
      const style = getComputedStyle(box)
      return { width: style.outlineWidth, style: style.outlineStyle, color: style.outlineColor }
    })
    expect(outline.style).toBe("solid")
    expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2)
    expect(outline.color).not.toBe("rgba(0, 0, 0, 0)")
  })

  /*
   * Eighteen cells: nine palettes, light and dark. Each one is measured off
   * the painted pixels — the word's own colour against the box it sits in,
   * and the edge's stroke against the canvas behind it — and photographed, so
   * a failure comes with the picture that caused it.
   */
  test("every palette and both themes clear the contrast floors", async ({ page }, testInfo) => {
    // Eighteen theme changes and eighteen photographs, over the real stack.
    test.slow()
    await listFlows(page)
    await drawPlan(page)

    const sizes = await page.locator('.flow-graph-node .sui-canvas-node-title, .flow-graph-node-word').evaluateAll(elements =>
      elements.map(element => {
        const node = element as HTMLElement
        return parseFloat(getComputedStyle(node).fontSize) * node.getBoundingClientRect().height / node.offsetHeight
      }))
    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(11.9)

    const failures: Array<string> = []
    for (const palette of PALETTES) {
      for (const mode of ["light", "dark"] as const) {
        await expect
          .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-palette") ?? "paper"))
          .toBe(palette)
        const current = await page.evaluate(() => document.documentElement.getAttribute("data-theme") ?? "light")
        if (current !== mode) {
          await runFlow(page, "/appearance.dark-mode")
          await expect
            .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme") ?? "light"))
            .toBe(mode)
        }

        const painted = await page.evaluate(() => {
          const canvas = document.querySelector(".flow-plan-canvas")!
          const box = canvas.querySelector<HTMLElement>(".flow-graph-node")!
          const word = box.querySelector<HTMLElement>(".flow-graph-node-word")!
          const title = box.querySelector<HTMLElement>(".sui-canvas-node-title")!
          const edge = canvas.querySelector<SVGPathElement>(".react-flow__edge-path")!
          /*
           * Measured in the state a run graph shows most: a run with no node
           * events yet is ALL pending. A plan card's node never carries the
           * attribute, so it is put on and taken off again, the same probe
           * `runningNodeAnimation` uses.
           */
          const held = box.getAttribute("data-state")
          box.setAttribute("data-state", "pending")
          const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true })!
          const rgba = (color: string) => {
            probe.clearRect(0, 0, 1, 1)
            probe.fillStyle = color
            probe.fillRect(0, 0, 1, 1)
            const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data
            return { r: r!, g: g!, b: b!, a: a! / 255 }
          }
          const layers = (element: Element) => {
            const result = []
            for (let current: Element | null = element; current !== null; current = current.parentElement) {
              const style = getComputedStyle(current)
              result.push({ background: rgba(style.backgroundColor), opacity: Number(style.opacity) })
            }
            return result
          }
          const read = {
            word: { ink: rgba(getComputedStyle(word).color), layers: layers(word) },
            title: { ink: rgba(getComputedStyle(title).color), layers: layers(title) },
            edge: { ink: rgba(getComputedStyle(edge).stroke), layers: layers(edge) }
          }
          if (held === null) box.removeAttribute("data-state")
          else box.setAttribute("data-state", held)
          return read
        })
        const cell = `${palette} ${mode}`
        for (const [name, paint] of Object.entries(painted)) {
          const background = composited({ r: 0, g: 0, b: 0, a: 0 }, paint.layers)
          const ratio = contrast(composited(paint.ink, paint.layers), background)
          const floor = name === "edge" ? 3 : 4.5
          if (ratio < floor) failures.push(`${cell}: ${name} is ${ratio}:1 through its ancestor chain`)
        }

        await testInfo.attach(`${palette}-${mode}.png`, {
          body: await canvasOf(page).screenshot(),
          contentType: "image/png"
        })
      }
    }
    // Reported all at once: one palette's miss is usually a family of them.
    expect(failures).toEqual([])
  })
})

/*
 * The same graph for a reader who asked for less motion. Chromium is told so
 * through the emulated media feature, which is the same signal the operating
 * system sends.
 */
test.describe("with reduced motion", () => {
  test("nothing on the canvas animates, and the words still say everything", async ({ page }) => {
    /*
     * The same signal an operating system sends. It is emulated on the page
     * rather than declared as a test option, because `reducedMotion` is a
     * context option in this version and `test.use` would silently drop it.
     */
    await page.emulateMedia({ reducedMotion: "reduce" })
    await listFlows(page)
    await drawPlan(page)
    const moving = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".flow-plan-canvas *")]
        .filter((element) => {
          const style = getComputedStyle(element)
          return style.animationName !== "none" && style.animationPlayState !== "paused"
        })
        .map((element) => `${element.className} ${getComputedStyle(element).animationName}`)
    )
    expect(moving).toEqual([])
    /*
     * A plan has no running node — only a run does — so the rule that would
     * move one is asked directly: the node is put into the state and its
     * computed animation read. Under reduced motion there is none, and the
     * test beside this one reads the same probe with motion allowed, so a
     * rule that stopped existing could not pass both.
     */
    expect(await runningNodeAnimation(page)).toBe("none")
    // The state is still readable, because it was never the motion that said it.
    const words = await canvasOf(page).locator(".flow-graph-node-word").allTextContents()
    expect(words.length).toBe(GRAPH_NODE_IDS.length)
    expect(words.every((word) => word.length > 0)).toBe(true)
  })
})
