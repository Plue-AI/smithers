import { expect, test } from "bun:test"
import { Glob } from "bun"
import { act } from "react"
import { createRoot } from "./testDom"
import type { StoryModule } from "./stories"
import { lintCopy } from "../productWords"

const paths = [...new Glob("*.stories.tsx").scanSync({ cwd: import.meta.dir })].sort()
let count = 0
for (const path of paths) {
  const { stories } = await import(new URL(path, import.meta.url).href) as StoryModule
  for (const story of stories) for (const theme of ["light", "dark"]) for (const mode of ["inline", "maximized"]) {
    count++
    test(`C-UI-02 ${path}/${story.name} ${theme} ${mode}`, async () => {
      const host = document.createElement("div"), root = createRoot(host)
      host.dataset.theme = theme
      host.className = mode === "maximized" ? "smithers-card is-maximized" : "smithers-card"
      try {
        await act(async () => root.render(story.render({ onAction: () => {}, onView: () => {} })))
        expect(lintCopy(host)).toEqual([])
      } finally { await act(async () => root.unmount()) }
    }, 30_000)
  }
}
test("C-UI-02 renders every story in four presentation combinations", async () => {
  let stories = 0
  for (const path of paths) stories += ((await import(new URL(path, import.meta.url).href)) as StoryModule).stories.length
  expect(count).toBe(stories * 4)
  expect(count).toBeGreaterThan(0)
})
