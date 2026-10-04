import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "../state/AppState"
import { AnonymousCeilingCardBody, anonymousCeilingCardFamily, RESETS_DAILY } from "./AnonymousCeilingCard"

/*
 * Factory mock 22: the refusal card says what the server said, when the
 * ceiling resets, and offers sign-in as the door. Both server wordings render
 * through the same body, and a body with no reset time says only that the
 * ceiling is daily. Nothing here parses the sentence.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

type CeilingCard = Extract<Card, { kind: "anonymous-ceiling" }>

const PER_ADDRESS =
  "That is 20 turns today without signing in, which is as far as exploring goes. Sign in with GitHub to keep going, or come back in about 6 hours. Nothing was charged."
const FOR_EVERYONE =
  "Exploring without signing in has reached its daily limit for everyone, not just you. Sign in with GitHub to keep going, or come back in about 3 hours. Nothing was charged."

const card = (payload: CeilingCard["payload"]): CeilingCard => ({
  id: "anonymous-ceiling-turn-1",
  kind: "anonymous-ceiling",
  title: "Exploring is paused",
  status: "active",
  createdAt: 0,
  ordinal: 0,
  payload
})

const render = (payload: CeilingCard["payload"]) => {
  let signIns = 0
  const host = document.createElement("div")
  document.body.append(host)
  flushSync(() => {
    createRoot(host).render(<AnonymousCeilingCardBody card={card(payload)} onConnectGitHub={() => { signIns += 1 }} />)
  })
  const text = (id: string) => host.querySelector(`[data-testid="${id}"]`)?.textContent ?? ""
  return { host, text, signIns: () => signIns }
}

describe("the anonymous ceiling card", () => {
  test("renders the per-address sentence verbatim with the Worker's reset time in the local timezone", () => {
    const { text } = render({ message: PER_ADDRESS, retryAt: "2026-09-08T00:00:00.000Z" })
    expect(text("anonymous-ceiling-message")).toBe(PER_ADDRESS)
    expect(text("anonymous-ceiling-reset")).toBe(`Resets at ${new Date("2026-09-08T00:00:00.000Z").toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`)
  })

  test("renders the deployment-wide sentence verbatim and a non-midnight reset", () => {
    const { text } = render({ message: FOR_EVERYONE, retryAt: "2026-09-07T21:05:30.000Z" })
    expect(text("anonymous-ceiling-message")).toBe(FOR_EVERYONE)
    expect(text("anonymous-ceiling-reset")).toBe(`Resets at ${new Date("2026-09-07T21:05:30.000Z").toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`)
  })

  test("says only that the ceiling is daily when the body carried no reset time", () => {
    expect(render({ message: PER_ADDRESS, retryAt: null }).text("anonymous-ceiling-reset")).toBe(RESETS_DAILY)
    expect(render({ message: PER_ADDRESS, retryAt: "not a time" }).text("anonymous-ceiling-reset")).toBe(RESETS_DAILY)
  })

  test("offers Sign in with GitHub as the one door, bound to sign-in", () => {
    const { host, signIns } = render({ message: PER_ADDRESS, retryAt: null })
    const buttons = [...host.querySelectorAll<HTMLButtonElement>("button")]
    expect(buttons.map((button) => [button.textContent, button.dataset.flow])).toEqual([["Sign in with GitHub", "sign-in"]])
    buttons[0]?.click()
    expect(signIns()).toBe(1)
  })

  test("wears a paused pill: the turn was refused, not failed", () => {
    expect(anonymousCeilingCardFamily["anonymous-ceiling"].pill(card({ message: PER_ADDRESS, retryAt: null }))).toBe("paused")
  })
})

test("the answered ceiling keeps its history and no longer renders a sign-in button", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  const before = card({ message: PER_ADDRESS, retryAt: null })
  try {
    flushSync(() => root.render(<AnonymousCeilingCardBody card={before} onConnectGitHub={() => {}} />))
    expect(host.querySelectorAll('[data-flow="sign-in"]').length).toBe(1)
    flushSync(() => root.render(<AnonymousCeilingCardBody card={{ ...before, status: "acted" }} onConnectGitHub={() => {}} />))
    expect(host.querySelectorAll('[data-flow="sign-in"]').length).toBe(0)
    expect(host.textContent).toContain(PER_ADDRESS)
    expect(host.textContent).toContain("Signed in with GitHub.")
  } finally { flushSync(() => root.unmount()) }
})
