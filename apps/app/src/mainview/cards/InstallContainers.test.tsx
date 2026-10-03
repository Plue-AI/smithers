import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { CardProps } from "@smthrs/rpc/CardAction"
import type { SetupCard } from "@smthrs/rpc/SetupCard"
import type { SettingsCard } from "@smthrs/rpc/SettingsCard"
import { SetupCardSchema } from "@smthrs/rpc/SetupCard"
import { SettingsCardSchema } from "@smthrs/rpc/SettingsCard"
import { SetupContainer } from "./SetupContainer"
import { SettingsContainer } from "./SettingsContainer"
import { installFixture } from "../state/seams/InstallFixtures.test-support"
import type { InstallSnapshot, InstallSnapshots } from "../state/seams/InstallSeam"
import type { InstallCardDispatch } from "./InstallCardActions"

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
  let setup: CardProps<SetupCard> | undefined, settings: CardProps<SettingsCard> | undefined
  const SetupView = (props: CardProps<SetupCard>) => { setup = props; return null }
  const SettingsView = (props: CardProps<SettingsCard>) => { settings = props; return null }
  return { commands, keys, patches, view, onView, install, dispatch, SetupView, SettingsView, setup: () => setup, settings: () => settings,
    renderSetup: (allowed = true) => renderToStaticMarkup(<SetupContainer View={SetupView} install={install} dispatch={dispatch} allowed={allowed} view={view} onView={onView} />),
    renderSettings: (owner = true) => renderToStaticMarkup(<SettingsContainer View={SettingsView} install={install} dispatch={dispatch} owner={owner} origin="http://mini.local:4000" view={view} onView={onView} />) }
}
describe("T-APP-03 Containers with recording Views", () => {
  test("Settings passes a schema-valid model, member view state and cardActions dispatch", () => {
    const h = harness(); h.renderSettings(); const props = h.settings()!
    expect(SettingsCardSchema.safeParse(props.model).success).toBe(true)
    expect(props.gestures).toEqual({}); expect(props.view).toBe(h.view); props.onView({ tab: "github" }); expect(h.patches).toEqual([{ tab: "github" }])
    expect(props.actions.map(action => action.tag)).toEqual(["settings.address", "settings.capacity", "settings.parallel", "settings.model-key"])
    props.onAction("settings.capacity", { capacity: "3" }); props.onAction("settings.parallel", { parallel: "1" })
    expect(h.commands).toEqual([{ tag: "settings.capacity", input: { capacity: 3 } }, { tag: "settings.parallel", input: { parallel: 1 } }])
  })
  test("Address sends bind and origins; refused origins remain outside the active list", () => {
    const model = installFixture(); model.address.change_failed = { from: "http://mini.local:4000", to: "http://refused.test", reason: "Address in use" }
    const h = harness({ model }); h.renderSettings(); const props = h.settings()!
    expect(props.model.address.origins).toEqual(model.address.origins)
    expect(props.model.address.bind).toBe(model.address.bind)
    expect(props.model.address.origins).not.toContain("http://refused.test")
    props.onAction("settings.address", { listen: "network", bind: "0.0.0.0:4000", origins: "http://one.test\nhttps://two.test" })
    expect(h.commands).toEqual([{ tag: "settings.address", input: { listen: "network", bind: "0.0.0.0:4000", origins: ["http://one.test", "https://two.test"] } }])
  })
  test.each([0, 2, 3])("stepper limits remain formula-bound at capacity %i", capacity => {
    const model = installFixture(); model.capacity = capacity; model.parallel = capacity
    const h = harness({ model }); h.renderSettings()
    expect(h.settings()!.model.capacity).toBe(capacity)
    expect(h.settings()!.model.this_mac.capacity).toBe(3)
    expect(h.settings()!.model.parallel).toBeLessThanOrEqual(h.settings()!.model.capacity)
  })
  test("a non-owner and an unloaded projection never mount either View", () => {
    const h = harness(); expect(h.renderSettings(false)).toBe(""); expect(h.renderSetup(false)).toBe("")
    expect(h.settings()).toBeUndefined(); expect(h.setup()).toBeUndefined()
    const empty = harness({}); empty.renderSettings(); empty.renderSetup()
    expect(empty.settings()).toBeUndefined(); expect(empty.setup()).toBeUndefined()
  })
  test.each(["pending", "running", "blocked", "failed"] as const)("Setup exposes only the first incomplete %s control", state => {
    const model = installFixture(); model.steps[0]!.state = state; model.steps[1]!.state = "pending"
    const h = harness({ model }); h.renderSetup(); const props = h.setup()!
    expect(SetupCardSchema.safeParse(props.model).success).toBe(true)
    expect(props.actions).toHaveLength(1); expect(props.actions[0]!.disabled !== undefined).toBe(state === "running")
    props.onAction("settings.setup", { step: "app", bind: "127.0.0.1:4000" })
    expect(h.commands).toEqual(state === "running" ? [] : [{ tag: "settings.setup", input: { step: "address", bind: "127.0.0.1:4000" } }])
    if (state === "failed" || state === "blocked") expect(props.actions[0]!.label).toBe("Retry")
  })
  test.each(["pending", "running", "failed", "ready"] as const)("Source %s never announces ready before its receipt", state => {
    const model = installFixture(); model.source = { state, pct: state === "ready" ? 100 : 40 }
    model.machine = { state: "running", pct: 5 }
    const h = harness({ model }); h.renderSetup()
    expect(h.setup()!.model.steps.find(step => step.id === "source")!.pct).toBe(model.source.pct)
    expect(h.setup()!.model.steps.find(step => step.id === "source")!.state === "done").toBe(state === "ready")
    expect(h.setup()!.model.steps.find(step => step.id === "machine")).toMatchObject({ state: "running", pct: 5 })
  })
  test("Source and machine launch controls do not claim readiness", () => {
    for (const id of ["source", "machine"] as const) {
      const model = installFixture(); model.steps.find(step => step.id === id)!.state = "pending"
      model[id] = { state: "pending", pct: 0 }
      const h = harness({ model }); h.renderSetup()
      expect(h.setup()!.actions[0]!.label).toBe(id === "source" ? "Mirror" : "Build image")
      expect(h.setup()!.actions[0]!.label).not.toContain("ready")
    }
  })
  test("model key actions strip values and preserve only role/provider for the write-only form", () => {
    const model = installFixture(); model.steps[4]!.state = "pending"
    const h = harness({ model }); h.renderSetup(); h.renderSettings()
    h.setup()!.onAction("settings.model-key", { role: "jev", provider: "AI Gateway", value: "private-key" })
    h.settings()!.onAction("settings.model-key", { role: "fast", provider: "Cerebras", value: "private-key" })
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
