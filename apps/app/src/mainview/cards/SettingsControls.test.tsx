import { createRoot } from "./views/testDom"
import { act } from "react"
import { expect, test } from "bun:test"
import { SettingsContainer } from "./SettingsContainer"
import { SettingsView } from "./views/SettingsView"
import { installFixture } from "../state/seams/InstallFixtures.test-support"
import type { InstallModel } from "../state/seams/InstallModel"
import type { InstallCardDispatch } from "./installKeyAction"

async function mount(model: InstallModel, dispatch: InstallCardDispatch = () => {}, tab?: "mac" | "network") {
  const host = document.createElement("div")
  document.body.append(host)
  const snapshot = { model }
  const root = createRoot(host)
  const render = () => root.render(<SettingsContainer View={SettingsView} owner install={{ get: () => snapshot, subscribe: () => () => {} }} dispatch={dispatch}
    origin="http://mini.local:4000" view={{ maximized: false, tab }} onView={patch => {
      if (patch.tab === "mac" || patch.tab === "network") tab = patch.tab
      render()
    }} />)
  await act(async () => render())
  return host
}

test.each([0, 2, 3])("Machines buttons enforce the served formula at %i", async capacity => {
  const model = installFixture(); model.capacity = capacity; delete model.parallel
  const commands: unknown[] = []
  const host = await mount(model, (tag, input) => { commands.push({ tag, input }) })
  const fewer = host.querySelector<HTMLButtonElement>('[aria-label="Fewer Machines"]')!
  const more = host.querySelector<HTMLButtonElement>('[aria-label="More Machines"]')!
  expect(fewer.disabled).toBe(capacity === 0)
  expect(more.disabled).toBe(capacity === 3)
  await act(async () => { fewer.click(); more.click() })
  expect(commands).toEqual([
    ...(capacity === 0 ? [] : [{ tag: "settings.capacity", input: { capacity: capacity - 1 } }]),
    ...(capacity === 3 ? [] : [{ tag: "settings.capacity", input: { capacity: capacity + 1 } }])
  ])
})

test("Address keeps all origins and the bind input; LAN HTTP is marked per origin", async () => {
  const model = installFixture()
  model.address.origins.push("http://127.0.0.1:4000", "http://[::1]:4000")
  const expectedOrigins = [
    "http://localhost:4000", "http://mini.local:4000", "https://smithers.example.test",
    "http://127.0.0.1:4000", "http://[::1]:4000"
  ]
  const commands: unknown[] = []
  const host = await mount(model, (tag, input) => { commands.push({ tag, input }) }, "mac")
  const choice = host.querySelector('[role="group"][aria-label="Who can reach it"]')!
  const [mac, network] = [...choice.querySelectorAll<HTMLButtonElement>("button")]
  expect(mac!.textContent).toBe("This Mac only")
  expect(network!.textContent).toBe("Network")
  expect(mac!.getAttribute("aria-pressed")).toBe("true")
  expect(network!.getAttribute("aria-pressed")).toBe("false")
  expect(host.querySelector('textarea[id$="-origins"]')).toBeNull()
  await act(async () => network!.click())
  expect(mac!.getAttribute("aria-pressed")).toBe("false")
  expect(network!.getAttribute("aria-pressed")).toBe("true")
  const origins = host.querySelector<HTMLTextAreaElement>('textarea[id$="-origins"]')!
  expect(origins.value).toBe(expectedOrigins.join("\n"))
  const form = origins.closest("form")!
  expect(form.dataset.flow).toBe("settings.address")
  expect(form.querySelector<HTMLInputElement>('input[id$="-bind"]')!.value).toBe("0.0.0.0:4000")
  for (const origin of expectedOrigins) {
    const rendered = [...host.querySelectorAll("code")].find(code => code.textContent === origin)!
    expect(rendered).toBeDefined()
    expect(rendered.parentElement!.textContent!.includes("unencrypted")).toBe(origin === "http://mini.local:4000")
  }
  expect(commands).toEqual([])
  await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click())
  expect(commands).toEqual([{ tag: "settings.address", input: {
    listen: "network", bind: "0.0.0.0:4000", origins: expectedOrigins
  } }])
})

test("Each model key stays on its role row, clears on submission and carries only a transient gesture", async () => {
  const model = installFixture()
  model.models[1] = { role: "coding", provider: "OpenAI", key: "failed", error: "Key is invalid" }
  const commands: unknown[] = [], secrets: string[] = []
  const host = await mount(model, (tag, input, gesture) => {
    commands.push({ tag, input }); secrets.push(gesture!.takeWriteOnly!("value")!); gesture!.release()
  })
  const rows = host.querySelectorAll<HTMLElement>(".settings-model-row")
  expect(rows).toHaveLength(3)
  for (const [index, row] of [...rows].entries()) {
    const input = row.querySelector<HTMLInputElement>('input[type="password"]')!
    const nativeSet = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!
    await act(async () => { nativeSet.call(input, `sentinel-${index}`); input.dispatchEvent(new Event("input", { bubbles: true })) })
    await act(async () => input.closest("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })))
    expect(input.value).toBe("")
    expect(row.querySelector("button")!.textContent).toBe("Save")
  }
  expect(commands).toEqual(model.models.map(role => ({ tag: "settings.model-key", input: { role: role.role, provider: role.provider } })))
  expect(secrets).toEqual(["sentinel-0", "sentinel-1", "sentinel-2"])
  expect(host.innerHTML).not.toContain("sentinel")
  expect(JSON.stringify(commands)).not.toContain("sentinel")
  expect(rows[1]!.textContent).toContain("Key is invalid")
})

test("Zero formula disables both Machines buttons; At once keeps its 1-8 request apart from capacity", async () => {
  // #3572: the saved parallel request survives capacity 0, and Settings accepts 1-8 independently of capacity.
  const model = installFixture(); model.capacity = 0; model.this_mac.capacity = 0; model.parallel = 2
  const commands: unknown[] = []
  const host = await mount(model, (tag, input) => { commands.push({ tag, input }) })
  for (const label of ["Fewer Machines", "More Machines"]) {
    const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
    expect(button.disabled).toBe(true)
    await act(async () => button.click())
  }
  expect(commands).toEqual([])
  for (const label of ["Fewer TODOs at once", "More TODOs at once"]) {
    const button = host.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!
    expect(button.disabled).toBe(false)
    await act(async () => button.click())
  }
  expect(commands).toEqual([{ tag: "settings.parallel", input: { parallel: 1 } }, { tag: "settings.parallel", input: { parallel: 3 } }])
})
