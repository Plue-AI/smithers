import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { CardSchema } from "@smthrs/rpc/Cards"
import { ControllerTestProvider } from "../ControllerContext"
import { payloadFor } from "../flows/SlashPayload"
import type { Card } from "../state/AppState"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import { memoryStorage, unavailableAgent } from "../state/TestFixtures"
import ready from "./fixtures/register-repository-ready.json"
import { RegistrationCardBody } from "./RegistrationCard"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const createController = scopedControllers()
type RegistrationCard = Extract<Card, { kind: "registration" }>

const recordedReport = (value: unknown): Record<string, unknown> | undefined => {
  if (typeof value !== "object" || value === null) return undefined
  const report = (value as { report?: unknown }).report
  if (typeof report === "object" && report !== null && "clone" in report) return report as Record<string, unknown>
  for (const child of Object.values(value)) {
    const found = recordedReport(child)
    if (found !== undefined) return found
  }
  return undefined
}
const cached = { commit: "fc3f257b643b41dd8de24d4b0d3248253ab411c5", report: recordedReport(ready)! }

const withCard = async (link: string, phase: RegistrationCard["payload"]["phase"], check: (host: HTMLElement, calls: Array<[string, string | undefined]>) => void) => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const paths: string[] = []
  const controller = createController(store, unavailableAgent, { fetchImpl: async input => {
    paths.push(String(input))
    return new Response(null, { status: 404 })
  } })
  const card: RegistrationCard = {
    id: "registration", kind: "registration", title: "Register repository", status: "active", createdAt: 1, ordinal: 1,
    payload: { link, repo: "acme/widgets", cloudRepo: "mirror/other", phase, startedAt: 1, error: null, replay: 0, accountOwner: "owner", cached }
  }
  expect(CardSchema.parse(card)).toEqual(card)
  const calls: Array<[string, string | undefined]> = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(<ControllerTestProvider controller={controller}>
      <RegistrationCardBody card={card} onRunCommand={(name, args) => { calls.push([name, args]) }} />
    </ControllerTestProvider>))
    expect(calls).toEqual([])
    check(host, calls)
    expect(paths).toEqual([])
  } finally {
    flushSync(() => root.unmount())
    host.remove()
    await controller.dispose()
    await store.dispose?.()
  }
}

for (const link of ["acme/widgets", "https://github.com/acme/widgets", "https://github.com/acme/widgets.git"]) {
  test(`cached Analyze again preserves the original ${link} through the typed register grammar`, async () => {
    await withCard(link, "cached", (host, calls) => {
      expect(host.querySelector(".registration-go")?.textContent).toBe("Cached · fc3f257")
      const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find(node => node.textContent === "Analyze again")
      expect(button).toBeDefined()
      expect(button?.dataset.flow).toBe("repository.register")
      expect(button?.disabled).toBe(false)
      flushSync(() => button!.click())
      expect(calls).toEqual([["repository.register", link]])
      expect(payloadFor(calls[0]![0], calls[0]![1])).toEqual({ payload: { link } })
      expect(host.querySelector('[data-flow="repo.select"]')).toBeNull()
    })
  })
}

for (const phase of ["importing", "launching", "launched", "failed"] as const) {
  test(`${phase} does not expose cached Analyze again even with an older cached report`, async () => {
    await withCard("https://github.com/acme/widgets", phase, (host, calls) => {
      expect(host.textContent).not.toContain("Analyze again")
      expect(host.querySelector('[data-flow="repository.register"]')).toBeNull()
      expect(calls).toEqual([])
    })
  })
}
