import { renderSetupCard } from "./CardRenderers"
import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { CardProps } from "@smthrs/rpc/CardAction"
import type { SetupCard as SetupModel } from "@smthrs/rpc/SetupCard"
import type { SettingsCard } from "@smthrs/rpc/SettingsCard"
import { SetupCardSchema } from "@smthrs/rpc/SetupCard"
import { SettingsCardSchema } from "@smthrs/rpc/SettingsCard"
import { SetupCard } from "./SetupCard"
import { SettingsContainer } from "./SettingsContainer"
import { installFixture } from "../state/seams/InstallFixtures.test-support"
import type { InstallSnapshot, InstallSnapshots } from "../state/seams/InstallSeam"
import type { InstallCardDispatch } from "./installKeyAction"

const harness = (snapshot: InstallSnapshot = { model: installFixture() }) => {
  const commands: Array<{ tag: string; input: unknown }> = []
  const keys: string[] = []
  const patches: unknown[] = []
  const install: InstallSnapshots = { get: () => snapshot, subscribe: () => () => {} }
  const dispatch: InstallCardDispatch = (tag, input, gesture) => {
    commands.push({ tag, input })
    const key = gesture?.takeWriteOnly?.("value")
    if (key) keys.push(key)
    gesture?.release()
  }
  const view = { maximized: false, tab: "setup" }
  const onView = (patch: Partial<typeof view>) => { patches.push(patch) }
  let setup: CardProps<SetupModel> | undefined, settings: CardProps<SettingsCard> | undefined
  const SetupView = (props: CardProps<SetupModel>) => { setup = props; return null }
  const SettingsView = (props: CardProps<SettingsCard>) => { settings = props; return null }
  return { commands, keys, patches, view, onView, install, dispatch, SetupView, SettingsView, setup: () => setup, settings: () => settings,
    renderSetup: (allowed = true) => renderToStaticMarkup(<SetupCard View={SetupView} install={install} dispatch={dispatch} allowed={allowed} view={view} onView={onView} />),
    renderSettings: (owner = true) => renderToStaticMarkup(<SettingsContainer View={SettingsView} install={install} dispatch={dispatch} owner={owner} origin="http://mini.local:4000" view={view} onView={onView} />) }
}
describe("T-APP-03 Containers with recording Views", () => {
  test("CardRenderers mounts the real Setup View with independent progress and fix", () => {
    const model = installFixture()
    model.steps[5] = { id: "source", state: "done", pct: 100 }
    model.steps[6] = { id: "machine", state: "blocked", pct: 25, blocked: { line: "Free disk space", fix_url: "https://example.test/disk" } }
    const h = harness({ model })
    const html = renderToStaticMarkup(renderSetupCard({ install: h.install, dispatch: h.dispatch, allowed: true, view: h.view, onView: h.onView }))
    expect(html).toContain('data-kind="setup"')
    expect(html).toContain("Source ready"); expect(html).not.toContain("Machine ready")
    expect(html).toContain("Free disk space"); expect(html).toContain("Retry")
  })
  test("Settings passes a schema-valid model, member view state and cardActions dispatch", () => {
    const h = harness(); h.renderSettings(); const props = h.settings()!
    expect(SettingsCardSchema.safeParse(props.model).success).toBe(true)
    expect(props.gestures).toEqual({}); expect(props.view).toBe(h.view); props.onView({ tab: "github" }); expect(h.patches).toEqual([{ tab: "github" }])
    expect(props.actions.map(action => [action.tag, action.args])).toEqual([
      ["settings.address", { field: "address", listen: "mac" }], ["settings.address", { field: "address", listen: "network" }],
      ["settings.capacity", { field: "capacity" }], ["settings.parallel", { field: "parallel" }],
      ["settings.model-key", { field: "key", role: "fast" }], ["settings.model-key", { field: "key", role: "coding" }], ["settings.model-key", { field: "key", role: "jev" }]
    ])
    props.onAction("settings.capacity", { capacity: "3" }); props.onAction("settings.parallel", { parallel: "1" })
    expect(h.commands).toEqual([{ tag: "settings.capacity", input: { capacity: 3 } }, { tag: "settings.parallel", input: { parallel: 1 } }])
  })
  test("Address sends bind and origins; refused origins remain outside the active list", () => {
    const model = installFixture(); model.address.change_failed = { from: "http://mini.local:4000", to: "http://refused.test", reason: "Address in use" }
    const h = harness({ model }); h.renderSettings(); const props = h.settings()!
    expect(props.model.address.origins).toEqual(model.address.origins)
    expect(props.model.address.bind).toBe(model.address.bind)
    expect(props.model.address.failed).toEqual({ from: "http://mini.local:4000", to: "http://refused.test", reason: { class: "user", message: "Address in use" } })
    expect(props.model.address.origins).not.toContain("http://refused.test")
    props.onAction("settings.address", { field: "address", listen: "network", bind: "0.0.0.0:4000", origins: "http://one.test, https://two.test" })
    expect(h.commands).toEqual([{ tag: "settings.address", input: { listen: "network", bind: "0.0.0.0:4000", origins: ["http://one.test", "https://two.test"] } }])
  })
  test("a loopback-bound install choosing Network gets Bind and Origins, prefilled for teammates; This Mac only binds loopback", () => {
    const model = installFixture(); model.address = { listen: "mac", bind: "127.0.0.1:4100", origins: ["http://localhost:4100"] }
    const h = harness({ model }); h.renderSettings(); const props = h.settings()!
    const network = props.actions.find(action => action.args?.listen === "network")!
    expect(network.input).toEqual([
      { name: "bind", label: "Bind", kind: "text", required: true, value: "0.0.0.0:4100" },
      { name: "origins", label: "Origins", kind: "text", required: true, value: "http://localhost:4100" }
    ])
    expect(props.actions.find(action => action.args?.listen === "mac")!.input).toBeUndefined()
    props.onAction("settings.address", { field: "address", listen: "network", bind: "0.0.0.0:4100", origins: "https://maya-mini.tail1234.ts.net" })
    props.onAction("settings.address", { field: "address", listen: "network", bind: "", origins: "http://mini.local:4100\nhttps://maya-mini.tail1234.ts.net" })
    props.onAction("settings.address", { field: "address", listen: "mac" })
    expect(h.commands).toEqual([
      { tag: "settings.address", input: { listen: "network", bind: "0.0.0.0:4100", origins: ["https://maya-mini.tail1234.ts.net"] } },
      { tag: "settings.address", input: { listen: "network", bind: "0.0.0.0:4100", origins: ["http://mini.local:4100", "https://maya-mini.tail1234.ts.net"] } },
      { tag: "settings.address", input: { listen: "mac", bind: "127.0.0.1:4100", origins: ["http://localhost:4100"] } }
    ])
  })
  test("a network-bound install keeps its bind in the Network form", () => {
    const h = harness(); h.renderSettings()
    expect(h.settings()!.actions.find(action => action.args?.listen === "network")!.input?.map(field => field.value)).toEqual(["0.0.0.0:4000", "http://localhost:4000, http://mini.local:4000, https://smithers.example.test"])
  })
  test("Setup's model access offers one key control per named role, with no raw role choice", () => {
    const model = installFixture(); model.steps[4]!.state = "pending"
    const h = harness({ model }); h.renderSetup(); const props = h.setup()!
    const keys = props.actions.filter(action => action.tag === "settings.model-key")
    expect(keys.map(action => ({ args: action.args, label: action.label, input: action.input }))).toEqual([
      { args: { step: "models", role: "fast" }, label: "Save", input: [{ name: "value", label: "Cerebras key", kind: "secret", required: true }] },
      { args: { step: "models", role: "coding" }, label: "Save", input: [
        { name: "provider", label: "Provider", kind: "choice", required: true, value: "OpenAI", choices: ["OpenAI", "Anthropic", "OpenRouter"] },
        { name: "value", label: "API key", kind: "secret", required: true }] },
      { args: { step: "models", role: "jev" }, label: "Save", input: [{ name: "value", label: "AI Gateway key", kind: "secret", required: true }] }
    ])
    expect(JSON.stringify(keys.map(action => action.input))).not.toContain("jev")
    props.onAction("settings.model-key", { step: "models", role: "coding", provider: "Anthropic", value: "coding-key" })
    props.onAction("settings.model-key", { step: "models", role: "jev", value: "gateway-key" })
    expect(h.commands).toEqual([{ tag: "settings.model-key", input: { role: "coding", provider: "Anthropic" } }, { tag: "settings.model-key", input: { role: "jev", provider: "AI Gateway" } }])
    expect(h.keys).toEqual(["coding-key", "gateway-key"])
  })
  test.each([0, 2, 3])("stepper limits remain formula-bound at capacity %i", capacity => {
    const model = installFixture(); model.capacity = capacity; model.parallel = capacity
    const h = harness({ model }); h.renderSettings()
    expect(h.settings()!.model.capacity).toBe(capacity)
    expect(h.settings()!.model.this_mac.capacity).toBe(3)
    expect(h.settings()!.model.parallel!).toBeLessThanOrEqual(h.settings()!.model.capacity)
  })
  test("a non-owner and an unloaded projection never mount either View", () => {
    const h = harness(); expect(h.renderSettings(false)).toBe(""); expect(h.renderSetup(false)).toBe("")
    expect(h.settings()).toBeUndefined(); expect(h.setup()).toBeUndefined()
    const empty = harness({}); empty.renderSettings(); empty.renderSetup()
    expect(empty.settings()).toBeUndefined(); expect(empty.setup()).toBeUndefined()
  })
  test("Setup stays mounted while Settings waits for its health provider", () => {
    const model = installFixture(); delete model.health
    const h = harness({ model })
    expect(h.renderSettings()).toBe("")
    expect(h.settings()).toBeUndefined()
    h.renderSetup(); expect(h.setup()!.model.steps).toEqual(model.steps)
  })
  test.each(["pending", "running", "blocked", "failed"] as const)("Setup exposes only the first incomplete %s control", state => {
    const model = installFixture(); model.steps[0]!.state = state; model.steps[1]!.state = "pending"
    const h = harness({ model }); h.renderSetup(); const props = h.setup()!
    expect(SetupCardSchema.safeParse(props.model).success).toBe(true)
    expect(props.actions[0]!.args).toEqual({ step: "address" })
    expect(props.actions[0]!.input?.map(field => field.name)).toEqual(["bind", "origins"])
    expect(props.actions).toHaveLength(1); expect(props.actions[0]!.disabled !== undefined).toBe(state === "running")
    props.onAction("settings.setup", { step: "app_manifest", bind: "127.0.0.1:4000" })
    expect(h.commands).toEqual(state === "running" ? [] : [{ tag: "settings.setup", input: { step: "address", bind: "127.0.0.1:4000" } }])
    if (state === "failed" || state === "blocked") expect(props.actions[0]!.label).toBe("Retry")
  })
  test.each(["pending", "running", "failed", "done"] as const)("Source %s never announces ready before its receipt", state => {
    const model = installFixture(); model.steps[5] = { id: "source", state, pct: state === "done" ? 100 : 40 }
    model.steps[6] = { id: "machine", state: "running", pct: 5 }
    const h = harness({ model }); h.renderSetup()
    expect(h.setup()!.model.steps.find(step => step.id === "source")!.pct).toBe(model.steps[5]!.pct)
    expect(h.setup()!.model.steps.find(step => step.id === "source")!.state === "done").toBe(state === "done")
    expect(h.setup()!.model.steps.find(step => step.id === "machine")).toMatchObject({ state: "running", pct: 5 })
  })
  test("Source and machine launch controls do not claim readiness", () => {
    for (const id of ["source", "machine"] as const) {
      const model = installFixture(); model.steps.find(step => step.id === id)!.state = "pending"
      const h = harness({ model }); h.renderSetup()
      expect(h.setup()!.actions[0]!.label).toBe(id === "source" ? "Mirror" : "Build image")
      expect(h.setup()!.actions[0]!.label).not.toContain("ready")
    }
  })
  test("model key actions strip values and preserve only role/provider for the write-only form", () => {
    const model = installFixture(); model.steps[4]!.state = "pending"
    const h = harness({ model }); h.renderSetup(); h.renderSettings()
    h.setup()!.onAction("settings.model-key", { step: "models", role: "jev", provider: "AI Gateway", value: "private-key" })
    h.settings()!.onAction("settings.model-key", { field: "key", role: "fast", provider: "Cerebras", value: "private-key" })
    expect(h.commands).toEqual([{ tag: "settings.model-key", input: { role: "jev", provider: "AI Gateway" } }, { tag: "settings.model-key", input: { role: "fast", provider: "Cerebras" } }])
    expect(h.keys).toEqual(["private-key", "private-key"])
    expect(JSON.stringify(h.setup())).not.toContain("private-key"); expect(JSON.stringify(h.settings())).not.toContain("private-key")
  })
  test("completed setup has no step control and callbacks preserve member view state", () => {
    const h = harness(); h.renderSetup(); expect(h.setup()!.actions).toEqual([])
    expect(h.setup()!.view).toBe(h.view); h.setup()!.onView({ maximized: true }); expect(h.patches).toEqual([{ maximized: true }])
    h.setup()!.onAction("settings.parallel", { parallel: "2" }); expect(h.commands).toEqual([])
  })
})
