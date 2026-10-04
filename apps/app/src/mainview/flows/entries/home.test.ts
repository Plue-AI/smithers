/** Home doors through the production dispatcher; absent providers have no effects. */
import { expect, test } from "bun:test"
import { createAppController } from "../../state/AppController"
import { createAppStore } from "../../state/AppStore"
import { memoryStorage, signupProfileFetch, unavailableAgent } from "../../state/TestFixtures"
import { modelInvocable, nameOf } from "../registry"

const boot = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const profile = signupProfileFetch(async () => new Response("{}", { status: 404 }))
  const controller = createAppController(store, unavailableAgent, { fetchImpl: profile.fetchImpl })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "maya", admin: false, scopesPlain: null }).isPersisted.promise
  return { store, controller }
}
type Harness = Awaited<ReturnType<typeof boot>>
const slash = (h: Harness, name: string, args?: string) => h.controller.runCommandForResult(name, args)
const button = (h: Harness, name: string, payload: Record<string, unknown>) => h.controller.submitCommand({ name, payload, actor: "user" })

test("the Home doors register; Merge is a person's alone", async () => {
  const h = await boot()
  try {
    const entries = h.controller.commands.entries().filter(entry => ["stack", "stack.move", "merge", "background.retry", "background.dismiss", "github"].includes(nameOf(entry)))
    expect(entries.map(nameOf).sort()).toEqual(["background.dismiss", "background.retry", "github", "merge", "stack", "stack.move"])
    expect(Object.fromEntries(entries.map(entry => [nameOf(entry), modelInvocable(entry)]))).toEqual({
      "stack": true, "stack.move": true, "merge": false, "background.retry": true, "background.dismiss": true, "github": true
    })
  } finally { h.controller.dispose() }
})

test("HomeDependencyUnavailable: every production door refuses without changing stack, runs or navigation", async () => {
  const h = await boot()
  try {
    const before = JSON.stringify(h.controller.design.world())
    for (const [name, args, payload] of [
      ["stack", undefined, {}],
      ["stack.move", "T11 up", { n: 11, direction: "up" }],
      ["merge", "T8", { n: 8, reviewed_head_sha: "3f9a2c1" }],
      ["background.retry", "r-release", { id: "r-release" }],
      ["background.dismiss", "r-release", { id: "r-release" }],
      ["github", undefined, {}]
    ] as const) {
      expect(await slash(h, name, args)).toMatchObject({ status: "failed", error: expect.stringContaining("Home provider unavailable") })
      expect(await button(h, name, payload)).toMatchObject({ status: "failed", error: expect.stringContaining("Home provider unavailable") })
      expect(JSON.stringify(h.controller.design.world())).toBe(before)
    }
  } finally { h.controller.dispose() }
})
