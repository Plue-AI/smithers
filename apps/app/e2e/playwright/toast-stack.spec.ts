import { expect,test,type Page } from "./browserTest"
import { identityRoute } from "./identity"
import { fillComposer } from "./composer"

/** Exercise a real failed toast (a refused repository read) using only this browser profile. */
const boot = async (page: Page) => {
  await page.route("**/api/**", route => route.fulfill({ status: 404, json: { error: "Not part of the notification fixture" } }))
  await page.route("**/api/bootstrap", route => route.fulfill({ json: {
    apiVersion: 1, host: "cloud", version: "test", buildSha: "test",
    capabilities: ["identity", "cloud", "agent"], authFlow: "redirect", sandbox: null,
  } }))
  await page.route("**/api/user", identityRoute(null))
  await page.route("**/api/public/repos", route => route.fulfill({ json: { repos: [{ name: "smithersai/smithers" }] } }))
  await page.route("**/api/repos/smithersai/smithers", route => route.fulfill({ json: { default_bookmark: "main" } }))
  await page.route("**/api/repos/smithersai/smithers/contents/README.md", route => route.fulfill({ status: 500, json: { message: "Not part of the notification fixture" } }))
  await page.goto("/")
  // A signed-out cloud visitor meets the signup, which withholds the Chat door; Control+K opens Chat throughout.
  await fillComposer(page, "/files.read README.md smithersai/smithers")
  await page.getByTestId("composer-send").click()
  await expect(page.locator('.toast-stack .toast[data-toast-status="failed"]')).toBeVisible()
  await page.keyboard.press("Escape")
}

const oneStack = async (page: Page) => {
  const stack = page.locator(".toast-stack")
  await expect(stack).toHaveCount(1)
  await expect(stack).toBeVisible()
  await expect(page.locator(".app-shell .toast:not([data-modal-popover] .toast)")).toHaveCount(0)
  await expect(stack).toHaveJSProperty("popover", "manual")
  await expect.poll(() => stack.evaluate(node => node.matches(":popover-open"))).toBe(true)
  // The whole single toast is visible, below the session's Sign in strip.
  await expect.poll(() => stack.evaluate(node => {
    const rect = node.getBoundingClientRect()
    const header = document.querySelector(".session-navigation")!.getBoundingClientRect()
    return rect.top >= header.bottom && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth
      && node.scrollHeight <= node.clientHeight + 1
  })).toBe(true)
  return stack
}

const viewports = [{ width: 1280, height: 800 }, { width: 390, height: 844 }, { width: 860, height: 480 }]

const modalOverlaps = (page: Page, selector = "dialog:modal") => page.evaluate(selector => {
  const modal = document.activeElement?.closest(selector) ?? document.querySelector(selector)!
  const controls = [...modal.querySelectorAll<HTMLElement>("button, textarea, input")]
    .filter(control => !control.closest("[data-modal-popover]") && control.checkVisibility())
  return [...document.querySelectorAll<HTMLElement>(".toast")].filter(toast => toast.checkVisibility()).flatMap(toast => {
    const t = toast.getBoundingClientRect()
    return controls.flatMap(control => {
      const c = control.getBoundingClientRect()
      return t.left < c.right && t.right > c.left && t.top < c.bottom && t.bottom > c.top
        ? [{ control: control.getAttribute("aria-label") ?? control.dataset.testid ?? control.textContent,
            toast: t.toJSON(), rect: c.toJSON() }] : []
    })
  })
}, selector)

for (const viewport of viewports) {
  test(`failed toast clears modal controls and a real Send click at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport)
    await page.emulateMedia({ reducedMotion: "reduce" })
    await boot(page)
    await fillComposer(page, "/files.read README.md smithersai/smithers")
    // The nonmodal composer must leave Send reachable while work is pending.
    await expect(page.locator(".composer-wrap")).toBeVisible()
    await expect(page.locator('.toast[data-toast-status="failed"]')).toBeVisible()
    await expect.poll(() => modalOverlaps(page, ".composer-wrap")).toEqual([])
    await expect(page.locator('.toast[data-toast-status="failed"]')).toBeVisible()
    const send = page.getByTestId("composer-send")
    await expect(send).toBeEnabled()
    // PressActions activates on release; observe the trusted mouse gesture at
    // Send, then assert its normal submission completed.
    await send.evaluate(button => button.addEventListener("pointerdown", event => {
      button.setAttribute("data-real-pointer", String(event.isTrusted))
    }, { once: true }))
    const rect = (await send.boundingBox())!
    await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2)
    await expect(send).toHaveAttribute("data-real-pointer", "true")
    await expect(page.getByTestId("composer-input")).toHaveValue("")

    // Exercise the same guarantee for a native modal, independently of Chat.
    await page.evaluate(() => {
      const dialog = document.createElement("dialog")
      dialog.id = "send-modal"
      dialog.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0"
      dialog.innerHTML = '<form style="position:absolute;top:96px;left:12px;width:calc(100% - 24px);height:200px;display:flex;flex-direction:column"><textarea aria-label="Modal draft" style="flex:1"></textarea><button>Send modal</button></form>'
      dialog.querySelector("form")!.addEventListener("submit", event => {
        event.preventDefault()
        dialog.dataset.sent = String(event.isTrusted)
      })
      document.body.append(dialog)
      dialog.showModal()
    })
    await expect(page.locator("#send-modal .toast-stack")).toHaveCount(1)
    await oneStack(page)
    await expect.poll(() => modalOverlaps(page)).toEqual([])
    const modalSend = page.getByRole("button", { name: "Send modal", exact: true })
    const modalRect = (await modalSend.boundingBox())!
    await page.mouse.click(modalRect.x + modalRect.width / 2, modalRect.y + modalRect.height / 2)
    await expect(page.locator("#send-modal")).toHaveAttribute("data-sent", "true")
  })
}

/* #3419: an open failure detail ran past the toast's right edge and was clipped mid-sentence. */
test("an open failure detail wraps inside its toast and a long body scrolls in place", async ({ page }) => {
  await boot(page)
  const toast = page.locator('.toast-stack .toast[data-toast-status="failed"]')
  await toast.locator("details.toast-detail > summary").click()
  await expect(toast.locator("details.toast-detail")).toHaveJSProperty("open", true)
  await expect.poll(() => toast.evaluate(node => {
    const pre = node.querySelector<HTMLElement>("details.toast-detail pre")!
    const text = document.createRange()
    text.selectNodeContents(pre)
    return { inside: text.getBoundingClientRect().right <= node.getBoundingClientRect().right, scrollsSideways: pre.scrollWidth > pre.clientWidth }
  })).toEqual({ inside: true, scrollsSideways: false })
  // A caught stack trace stands in for any long body: it scrolls inside the detail and the toast stays on screen.
  await toast.evaluate(node => {
    node.querySelector("details.toast-detail pre")!.textContent =
      Array.from({ length: 60 }, (_, line) => `    at frame${line} (runs.ts:${line})`).join("\n")
  })
  await expect.poll(() => toast.evaluate(node => {
    const pre = node.querySelector<HTMLElement>("details.toast-detail pre")!
    return { scrolls: pre.scrollHeight > pre.clientHeight, onScreen: node.getBoundingClientRect().bottom <= innerHeight }
  })).toEqual({ scrolls: true, onScreen: true })
})

test("the same stack follows any modal, including dialogs opened out of DOM order in one task", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "no-preference" })
  await boot(page)
  const stack = await oneStack(page)
  const original = await stack.elementHandle()
  // Hold the entrance mid-motion: reparenting must not clip the toast inside
  // the measured modal region, even before an animation would normally end.
  await page.addStyleTag({ content: ".toast-stack .toast { animation-duration: 60s; }" })
  await stack.locator(".toast").evaluate(toast => {
    for (const animation of toast.getAnimations()) {
      animation.currentTime = 0
      animation.pause()
    }
  })
  await page.evaluate(() => {
    for (const id of ["first-modal", "second-modal"]) {
      const dialog = document.createElement("dialog")
      dialog.id = id
      dialog.innerHTML = "<button>Modal control</button>"
      // A small, filtered modal must not capture or clip the fixed toast.
      dialog.style.cssText = "width:160px;height:100px;overflow:hidden;backdrop-filter:blur(6px)"
      document.body.append(dialog)
    }
    document.querySelector<HTMLDialogElement>("#second-modal")!.showModal()
    document.querySelector<HTMLDialogElement>("#first-modal")!.showModal()
  })
  await expect(page.locator("#first-modal .toast-stack")).toHaveCount(1)
  await oneStack(page)
  await page.evaluate(() => document.querySelector<HTMLDialogElement>("#first-modal")!.close())
  await expect(page.locator("#second-modal .toast-stack")).toHaveCount(1)
  expect(await original!.evaluate(node => node === document.querySelector(".toast-stack"))).toBe(true)
  await stack.getByRole("button", { name: "Dismiss: Loading repository…", exact: true }).click()
  await expect(stack).toHaveCount(0)
  await page.evaluate(() => document.querySelector<HTMLDialogElement>("#second-modal")!.close())
})
