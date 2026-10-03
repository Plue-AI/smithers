import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { act } from "react"
import { createRoot } from "react-dom/client"
import { fixtures } from "@smthrs/rpc/fixtures/ActorChip"
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
    expect(node.querySelector("img")).toBeNull()
    if (agent === "coding") expect(node.querySelector("svg.lucide-bot")).not.toBeNull()
    else expect(node.textContent).toBe({ smithers: "S", reviewer: "R", "claude-code": "C", codex: "C", external: "E" }[agent])
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
test("failed avatar reveals initials and a replacement URL renders an image", async () => {
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host)
  const actor: Actor = { kind: "person", ...ben, avatar_url: "https://example.com/broken.png" }
  try {
    await act(async () => root.render(<ActorChip actor={actor} size="m" />))
    await act(async () => host.querySelector("img")!.dispatchEvent(new Event("error")))
    expect(host.querySelector("img")).toBeNull()
    expect(host.querySelector(".mvp-avatar")!.textContent).toBe("BP")
    expect(host.firstElementChild!.getAttribute("aria-label")).toBe("Ben")
    await act(async () => root.render(<ActorChip actor={{ ...actor, avatar_url: "https://example.com/working.png" }} size="m" />))
    expect(host.querySelector("img")!.getAttribute("src")).toBe("https://example.com/working.png")
    expect(host.querySelector("img")!.hidden).toBe(false)
    await act(async () => root.render(<ActorChip actor={actor} size="m" />))
    expect(host.querySelector("img")!.getAttribute("src")).toBe(actor.avatar_url!)
  } finally { await act(async () => root.unmount()); host.remove() }
})

for (const [name, { model }] of Object.entries(fixtures)) {
  const actor = model.actor
  if (actor.kind !== "agent") continue
  test(`agent fixture ${name} draws its glyph without an avatar image`, async () => {
    await withActor(actor, node => {
      expect(node.querySelector("img")).toBeNull()
      if (actor.agent === "coding") expect(node.querySelector("svg.lucide-bot")).not.toBeNull()
      else expect(node.textContent).toBe(actor.agent === "smithers" ? "S" : actor.agent === "reviewer" ? "R" : (actor.name || { "claude-code": "Claude Code", codex: "Codex", external: "External agent" }[actor.agent])[0])
    })
  })
}
