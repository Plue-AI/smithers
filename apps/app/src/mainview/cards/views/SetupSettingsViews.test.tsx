import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { act } from "react"
import type { Root } from "react-dom/client"
import { fixtures as setup } from "@smthrs/rpc/fixtures/Setup"
import { fixtures as settings } from "@smthrs/rpc/fixtures/Settings"
import { SetupView } from "./SetupView"
import { SettingsView } from "./SettingsView"
GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot } = await import("react-dom/client")
let root: Root | undefined
function render(element: React.ReactNode) { const host = document.createElement("div"); document.body.append(host); root = createRoot(host); act(() => root!.render(element)); return host }
afterEach(() => { act(() => root?.unmount()); document.body.innerHTML = "" })
afterAll(() => GlobalRegistrator.unregister())
for (const [id, story] of Object.entries(setup)) test(`Setup ${id}`, () => {
  const host = render(<SetupView {...story} onAction={() => {}} onView={() => {}} />)
  for (const text of story.expect) expect(host.textContent).toContain(text)
  expect([...host.querySelectorAll("[data-step]")].map(row => row.getAttribute("data-step"))).toEqual(["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"])
  expect(host.textContent).toContain("Decisions")
  expect(host.querySelector('input[aria-label="AI Gateway key"]')?.getAttribute("type")).toBe("password")
})
for (const [id, story] of Object.entries(settings)) test(`Settings ${id}`, () => {
  const host = render(<SettingsView {...story} onAction={() => {}} onView={() => {}} />)
  for (const text of story.expect) expect(host.textContent).toContain(text)
  expect(host.textContent).toContain("734003200 bytes")
})
test("Address submits literal bound step and edited fields once", () => {
  const calls: unknown[] = []
  const host = render(<SetupView {...setup.fresh} onAction={(...args) => calls.push(args)} onView={() => { throw new Error("Unexpected view patch") }} />)
  const input = host.querySelector('input[id$="-bind"]') as HTMLInputElement
  act(() => { const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; setter.call(input, "0.0.0.0:8080"); input.dispatchEvent(new Event("input", { bubbles: true })); input.dispatchEvent(new Event("change", { bubbles: true })) })
  act(() => host.querySelector<HTMLButtonElement>('button[data-flow="settings"]')!.click())
  expect(calls).toEqual([["settings", { step: "address", listen: "mac", bind: "0.0.0.0:8080" }]])
})
test("Missing actions omit controls; disabled reason stays visible", () => {
  const host = render(<SetupView {...setup.fresh} actions={[]} onAction={() => { throw new Error("Unexpected dispatch") }} onView={() => {}} />)
  expect(host.querySelector("button")).toBeNull()
  act(() => root!.render(<SetupView {...setup.fresh} actions={[{ tag: "settings", label: "Save address", disabled: { reason: "Address unavailable" } }]} onAction={() => { throw new Error("Unexpected dispatch") }} onView={() => {}} />))
  expect(host.textContent).toContain("Address unavailable")
  expect(host.querySelector<HTMLButtonElement>("button")!.disabled).toBe(true)
})
test("Blocked repository links to the supplied fix; capacity explains limit", () => {
  const host = render(<SetupView {...setup.squash_blocked} onAction={() => {}} onView={() => {}} />)
  expect(host.querySelector("a")!.href).toBe("https://github.com/smithersai/smithers/settings")
  act(() => root!.render(<SetupView {...setup.no_capacity} onAction={() => {}} onView={() => {}} />))
  expect(host.textContent).toContain("No machine fits · memory · Close apps to free 6 GB")
})
test("Model keys stay masked and submit only supplied fields", () => {
  const calls: unknown[] = []
  const host = render(<SetupView {...setup.models_validating} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  const input = host.querySelector('input[id$="-jev"]') as HTMLInputElement
  expect(input.type).toBe("password")
  act(() => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "private-key"); input.dispatchEvent(new Event("input", { bubbles: true })) })
  act(() => host.querySelector<HTMLButtonElement>('button[data-flow="settings"]')!.click())
  expect(calls).toEqual([["settings", { step: "models", fast: "", coding: "", jev: "private-key" }]])
  expect(host.textContent).not.toContain("private-key")
})
test("Machines stepper dispatches the supplied field and string values", () => {
  const calls: unknown[] = []
  const host = render(<SettingsView {...settings.ready} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="More Machines"]')!.click())
  act(() => host.querySelector<HTMLButtonElement>('button[aria-label="Fewer Machines"]')!.click())
  expect(calls).toEqual([["settings", { field: "capacity", value: "3" }], ["settings", { field: "capacity", value: "1" }]])
})
test("Settings shows literal sync health and Obsidian receipts", () => {
  const host = render(<SettingsView {...settings.obsidian} onAction={() => {}} onView={() => {}} />)
  expect(host.textContent).toContain("2026-10-02T17:40:00.000Z")
  expect(host.textContent).toContain("GitHub rate budget · 4812/5000")
  expect(host.textContent).toContain("Disk free · 412 GB")
  expect(host.textContent).toContain("Process · ok")
})
test("Owner action forms retain literal order and model arguments", () => {
  const calls: unknown[] = []
  const host = render(<SettingsView {...settings.ready} onAction={(...args) => calls.push(args)} onView={() => {}} />)
  expect([...host.querySelectorAll('.setup-action')].map(form => form.getAttribute('data-flow'))).toEqual(['settings.model.set', 'settings.model.set', 'settings.model.set', 'github', 'settings', 'settings', 'settings'])
  for (const button of host.querySelectorAll<HTMLButtonElement>('.setup-action button[type="submit"]')) act(() => button.click())
  expect(calls).toEqual([
    ['settings.model.set', { role: 'fast', model: 'llama-4-scout' }],
    ['settings.model.set', { role: 'coding', model: 'gpt-6.1-sol' }],
    ['settings.model.set', { role: 'jev', model: 'typesafe-ai/jev' }],
    ['github', {}],
    ['settings', { field: 'obsidian', path: '' }]
  ])
})
