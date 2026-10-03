import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { ActorChip, type Actor } from "./ActorChip"

GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
afterAll(() => GlobalRegistrator.unregister())
async function withActor(actor: Actor, check: (node: HTMLElement) => void, live = true) {
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  try {
    await act(async () => root.render(<ActorChip actor={actor} size="m" live={live} />))
    check(host.firstElementChild as HTMLElement)
  } finally { await act(async () => root.unmount()); host.remove() }
}
const ben = { login: "ben", name: "Ben Park", avatar_url: "", color_index: 1 }
for (let color_index = 0; color_index < 6; color_index++) test(`person color ${color_index}; no live pulse`, async () => {
  await withActor({ kind: "person", ...ben, color_index }, node => {
    expect(node.style.getPropertyValue("--who")).toBe(`var(--lane-${color_index})`)
    expect(node.textContent).toBe("BP")
    expect(node.dataset.agent).toBeUndefined()
    expect(node.dataset.live).toBeUndefined()
    expect(node.style.getPropertyValue("--size")).toBe("28px")
  })
})
for (const agent of ["smithers", "coding", "reviewer", "claude-code", "codex", "external"] as const) for (const delegated of [false, true]) test(`${agent} ${delegated ? "delegated" : "independent"}`, async () => {
  await withActor({ kind: "agent", id: agent, agent, avatar_url: "", color_index: delegated ? 1 : 6, ...(delegated ? { for_member: ben } : {}) }, node => {
    expect(node.hasAttribute("data-agent")).toBe(true)
    expect(node.hasAttribute("data-live")).toBe(true)
    expect(node.hasAttribute("data-for")).toBe(delegated)
    expect(node.style.getPropertyValue("--who")).toBe(delegated ? "var(--lane-1)" : agent === "smithers" ? "var(--text)" : "var(--lane-6)")
  })
})
for (const via of ["ssh", "terminal", "cli"] as const) test(`${via} retains person identity and badge`, async () => {
  await withActor({ kind: "person", ...ben, via }, node => {
    expect(node.dataset.kind).toBe("person")
    expect(node.dataset.agent).toBeUndefined()
    expect(node.querySelector(".mvp-avatar-badge")).not.toBeNull()
  })
})
test("failed avatar reveals initials without changing identity", async () => {
  await withActor({ kind: "person", ...ben, avatar_url: "https://example.com/avatar.png" }, node => {
    const image = node.querySelector("img")!
    image.dispatchEvent(new Event("error"))
    expect(image.hidden).toBe(true)
    expect(node.querySelector(".mvp-avatar-fallback")!.textContent).toBe("BP")
    expect(node.getAttribute("aria-label")).toBe("Ben")
  })
})
