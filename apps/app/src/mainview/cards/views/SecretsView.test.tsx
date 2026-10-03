import { createRoot } from "./testDom"
import { fixtures as secretFixtures } from "@smthrs/rpc/fixtures/Secrets"
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test"

import { stories } from "./SecretsView.stories"
import { act } from "react"
import type { ViewStory } from "./stories"

let consoleError: ReturnType<typeof spyOn>
beforeEach(() => { consoleError = spyOn(console, "error").mockImplementation(() => {}) })
afterEach(() => {
  const calls = [...consoleError.mock.calls]
  consoleError.mockRestore()
  expect(calls).toEqual([])
})
async function mounted(story: ViewStory, removed = false) {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const onAction = mock((_tag: string, _args?: Record<string, string>) => {})
  const onView = mock((_patch: Record<string, unknown>) => {})
  await act(async () => root.render(story.render({ onAction, onView }, removed ? story.actions?.slice(1) : undefined)))
  return { host, root, onAction, onView, close: async () => { await act(async () => root.unmount()); host.remove() } }
}

for (const story of stories) for (const theme of ["light", "dark"]) {
  test(`Secrets/${story.name} ${theme} actions`, async () => {
    document.documentElement.dataset.theme = theme
    const { host, onAction, onView, close } = await mounted(story)
    try {
      const fixture = secretFixtures[story.name as keyof typeof secretFixtures]
      const supplied = [...fixture.model.secrets.flatMap(secret => secret.actions), ...fixture.actions]
      const forms = [...host.querySelectorAll<HTMLFormElement>("form")]
      expect(forms.map(form => form.dataset.flow)).toEqual(supplied.map(action => action.tag))
      for (const [index, form] of forms.entries()) {
        const action = supplied[index]!
        const button = form.querySelector<HTMLButtonElement>("button")!
        expect(button.textContent).toBe(action.label)
        expect(button.disabled).toBe(!!action.disabled)
        const values: Record<string, string> = {}
        for (const field of action.input ?? []) {
          const input = form.querySelector<HTMLInputElement | HTMLSelectElement>(`[id$="-${field.name}"]`)!
          const value = field.name === "value" ? "new-secret" : field.name === "name" ? "NEW_TOKEN" : field.value ?? field.choices?.[0] ?? ""
          values[field.name] = value
          await act(async () => {
            Object.getOwnPropertyDescriptor(input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(input, value)
            input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }))
          })
          if (field.name === "value") expect(input.getAttribute("type")).toBe("password")
        }
        onAction.mockClear()
        await act(async () => button.click())
        expect(onAction.mock.calls).toEqual(action.disabled ? [] : [[action.tag, { ...action.args, ...values }]])
        if (!action.disabled) for (const input of form.querySelectorAll<HTMLInputElement>('input[type="password"]')) expect(input.value).toBe("")
        expect(onView).toHaveBeenCalledTimes(0)
      }
      expect(host.textContent).not.toContain("Bind")
      const removed = await mounted(story, true)
      try { expect([...removed.host.querySelectorAll<HTMLElement>("button[data-flow]")].map(button => button.dataset.flow)).toEqual(supplied.slice(1).map(action => action.tag)) }
      finally { await removed.close() }
    } finally { await close() }
  })
}
