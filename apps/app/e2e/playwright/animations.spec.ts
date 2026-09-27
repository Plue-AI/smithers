import { expect, test } from "./browserTest"
import { settleAnimations } from "./animations"

test("layout waits accept cancellation and still await the remaining animation", async ({ page }) => {
  await page.setContent("<button>Chat</button>")
  await page.evaluate(() => {
    const button = document.querySelector("button")!
    const cancelled = button.animate({ opacity: [0, 1] }, 60_000)
    const remaining = button.animate({ transform: ["translateX(10px)", "translateX(0)"] }, 60_000)
    remaining.id = "remaining"
    remaining.pause()
    const getAnimations = document.getAnimations.bind(document)
    document.getAnimations = () => {
      const animations = getAnimations()
      // Cancel after the wait captures finished, as disappearing UI does.
      queueMicrotask(() => {
        cancelled.cancel()
        document.getAnimations = getAnimations
        button.dataset.cancelled = "true"
      })
      return animations
    }
  })
  let settled = false
  const waiting = page.evaluate(settleAnimations).then(() => { settled = true })
  // Observe a rejection even while inspecting the still-running animation.
  void waiting.catch(() => {})
  await expect(page.locator("button")).toHaveAttribute("data-cancelled", "true")
  expect(settled).toBe(false)
  await page.evaluate(() => document.getAnimations().find(animation => animation.id === "remaining")!.finish())
  await waiting
  expect(settled).toBe(true)
})

test("layout waits retain unexpected animation failures", async ({ page }) => {
  await page.setContent("<button>Chat</button>")
  await page.evaluate(() => {
    const animation = document.querySelector("button")!.animate({ opacity: [0, 1] }, 60_000)
    Object.defineProperty(animation, "finished", { get: () => Promise.reject(new Error("Unexpected animation failure")) })
  })
  await expect(page.evaluate(settleAnimations)).rejects.toThrow("Unexpected animation failure")
})
