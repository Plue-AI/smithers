import { createRoot } from "./testDom"
import { expect, test } from "bun:test"
import { act } from "react"
import { fixtures } from "@smthrs/rpc/fixtures/ActorChip"
import { ActorChip, actorName, type Actor } from "./ActorChip"

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
for (const [agent, participant] of [["smithers", "Smithers"], ["coding", "Coding agent"], ["reviewer", "Reviewer"], ["claude-code", "Claude Code"], ["codex", "Codex"], ["external", "External agent"]] as const) for (const delegated of [false, true]) test(`${agent} ${delegated ? "delegated" : "independent"}`, async () => {
  const actor: Actor = { kind: "agent", id: agent, agent, avatar_url: "", color_index: delegated ? 1 : 6, ...(delegated ? { for_member: ben } : {}) }
  const label = delegated ? `${participant} for Ben` : participant
  expect(actorName(actor)).toBe(label)
  if (agent !== "external") for (const name of ["implementer", "planner"]) expect(actorName({ ...actor, name })).toBe(label)
  await withActor(actor, node => {
    expect(node.getAttribute("aria-label")).toBe(label)
    expect(node.getAttribute("title")).toBe(label)
    expect(node.querySelector("img")).toBeNull()
    if (agent === "coding") expect(node.querySelector("svg.lucide-bot")).not.toBeNull()
    else expect(node.textContent).toBe({ smithers: "S", reviewer: "R", "claude-code": "C", codex: "C", external: "E" }[agent])
    expect(node.hasAttribute("data-agent")).toBe(true)
    expect(node.hasAttribute("data-live")).toBe(true)
    expect(node.hasAttribute("data-for")).toBe(delegated)
    expect(node.style.getPropertyValue("--who")).toBe(delegated ? "var(--lane-1)" : agent === "smithers" ? "var(--text)" : "var(--lane-6)")
  })
})
for (const delegated of [false, true]) test(`named external agent ${delegated ? "delegated" : "independent"}`, async () => {
  const actor: Actor = { kind: "agent", id: "external", agent: "external", name: "Build assistant", avatar_url: "", color_index: delegated ? 1 : 6, ...(delegated ? { for_member: ben } : {}) }
  const label = delegated ? "Build assistant for Ben" : "Build assistant"
  expect(actorName(actor)).toBe(label)
  await withActor(actor, node => expect(node.getAttribute("aria-label")).toBe(label))
})
test("shared labels retain first names and non-agent identities", () => {
  expect(actorName({ kind: "person", ...ben })).toBe("Ben")
  expect(actorName({ kind: "person", ...ben, name: "  Ben Park  ", via: "ssh" })).toBe("Ben via SSH")
  expect(actorName({ kind: "person", ...ben, via: "cli" })).toBe("Ben via CLI")
  expect(actorName({ kind: "person", ...ben, via: "terminal" })).toBe("Ben's terminal")
  expect(actorName({ kind: "github", login: "ben", color_index: 7 })).toBe("@ben")
  expect(actorName({ kind: "outside", color_index: 7 })).toBe("Changed outside Smithers")
  expect(actorName({ kind: "system", color_index: 7 })).toBe("Install event")
})
for (const via of ["ssh", "terminal", "cli"] as const) test(`${via} retains person identity and badge`, async () => {
  await withActor({ kind: "person", ...ben, via }, node => {
    expect(node.dataset.kind).toBe("person")
    expect(node.dataset.agent).toBeUndefined()
    expect(node.querySelector(".avatar-badge")).not.toBeNull()
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
    expect(host.querySelector(".avatar")!.textContent).toBe("BP")
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
