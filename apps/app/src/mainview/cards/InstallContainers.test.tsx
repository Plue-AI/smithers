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
import { InstallModelSchema } from "../state/seams/InstallModel"
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
  test("served pre-approval default dispatches its typed owner control and stays hidden for members", () => {
    const model = installFixture()
    model.todo_preapprove_default = false
    const h = harness({ model }); h.renderSettings()
    expect(h.settings()!.model.todo_preapprove_default).toBe(false)
    h.settings()!.onAction("settings", { ...h.settings()!.actions.find(action => action.tag === "settings" && action.args?.operation === "preapprove-default")?.args, operation: "preapprove-default", enabled: "true" })
    expect(h.commands).toEqual([{ tag: "settings", input: { operation: "preapprove-default", todo_preapprove_default: true } }])
    expect(h.renderSettings(false)).toBe("")
  })
  test("Settings passes a schema-valid model, member view state and cardActions dispatch", () => {
    const h = harness(); h.renderSettings(); const props = h.settings()!
    expect(SettingsCardSchema.safeParse(props.model).success).toBe(true)
    expect(props.gestures).toEqual({}); expect(props.view).toBe(h.view); props.onView({ tab: "github" }); expect(h.patches).toEqual([{ tab: "github" }])
    expect(props.actions.map(action => [action.tag, action.args])).toEqual([
      ["settings", { operation: "address", field: "address", listen: "mac" }], ["settings", { operation: "address", field: "address", listen: "network" }],
      ["image.add", undefined],
      ["settings", { operation: "capacity", field: "capacity", min: "1", max: "3" }], ["settings", { operation: "parallel", field: "parallel", min: "1", max: "8" }],
      ["settings", { operation: "model-key", field: "key", role: "fast" }], ["settings", { operation: "model-key", field: "key", role: "coding" }], ["settings", { operation: "model-key", field: "key", role: "jev" }],
      ["settings.model.set", { role: "fast" }], ["settings.model.set", { role: "coding" }], ["settings.model.set", { role: "jev" }]
    ])
    props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "capacity")?.args, field: "capacity", operation: "capacity", capacity: "0" }); props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "parallel")?.args, field: "parallel", operation: "parallel", parallel: "1" })
    props.onAction("image.add", { name: "figlet" })
    expect(h.commands).toEqual([{ tag: "settings", input: { operation: "capacity", capacity: 0 } }, { tag: "settings", input: { operation: "parallel", parallel: 1 } }, { tag: "image.add", input: { name: "figlet" } }])
  })
  test("Address sends bind and origins; refused origins remain outside the active list", () => {
    const model = installFixture(); model.address.change_failed = { from: "http://mini.local:4000", to: "http://refused.test", reason: "Address in use" }
    const h = harness({ model }); h.renderSettings(); const props = h.settings()!
    expect(props.model.address.origins).toEqual(model.address.origins)
    expect(props.model.address.bind).toBe(model.address.bind)
    expect(props.model.address.failed).toEqual({ from: "http://mini.local:4000", to: "http://refused.test", reason: { class: "user", message: "Address in use" } })
    expect(props.model.address.origins).not.toContain("http://refused.test")
    props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "address" && action.args?.listen === "network")?.args, operation: "address", field: "address", listen: "network", bind: "0.0.0.0:4000", origins: "http://one.test, https://two.test" })
    expect(h.commands).toEqual([{ tag: "settings", input: { operation: "address", listen: "network", bind: "0.0.0.0:4000", origins: ["http://one.test", "https://two.test"] } }])
  })
  test("a refused Address retries its exact bind and all origins through the shared flow", () => {
    const model = installFixture()
    model.address.change_failed = { from: "http://localhost:4000", to: "http://mini.lan:4100", reason: "Address refused",
      bind: "10.0.0.5:4100", origins: ["http://mini.lan:4100", "http://10.0.0.5:4100"] }
    const h = harness({ model }); h.renderSettings(); const props = h.settings()!
    const retry = props.actions.find(action => action.label === "Retry")!
    expect(retry.tag).toBe("settings")
    expect(retry.args?.operation).toBe("address")
    expect(props.model.address.origins).toEqual(model.address.origins)
    props.onAction(retry.tag, retry.args)
    expect(h.commands).toEqual([{ tag: "settings", input: { operation: "address", listen: "network", bind: "10.0.0.5:4100",
      origins: ["http://mini.lan:4100", "http://10.0.0.5:4100"] } }])
    const member = harness({ model }); member.renderSettings(false)
    expect(member.settings()).toBeUndefined()
  })
  test("a loopback-bound install choosing Network gets Bind and Origins, prefilled for teammates; This Mac only binds loopback", () => {
    const model = installFixture(); model.address = { listen: "mac", bind: "127.0.0.1:4100", origins: ["http://localhost:4100"] }
    const h = harness({ model }); h.renderSettings(); const props = h.settings()!
    const network = props.actions.find(action => action.args?.listen === "network")!
    expect(network.input).toEqual([
      { name: "bind", label: "Bind", kind: "text", required: true, value: "0.0.0.0:4100" },
      { name: "origins", label: "Origins", kind: "text", multiline: true, required: true, value: "http://localhost:4100" }
    ])
    expect(props.actions.find(action => action.args?.listen === "mac")!.input).toBeUndefined()
    props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "address")?.args, operation: "address", field: "address", listen: "network", bind: "0.0.0.0:4100", origins: "https://maya-mini.tail1234.ts.net" })
    props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "address")?.args, operation: "address", field: "address", listen: "network", bind: "", origins: "http://mini.local:4100\nhttps://maya-mini.tail1234.ts.net" })
    props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "address")?.args, operation: "address", field: "address", listen: "mac" })
    expect(h.commands).toEqual([
      { tag: "settings", input: { operation: "address", listen: "network", bind: "0.0.0.0:4100", origins: ["https://maya-mini.tail1234.ts.net"] } },
      { tag: "settings", input: { operation: "address", listen: "network", bind: "0.0.0.0:4100", origins: ["http://mini.local:4100", "https://maya-mini.tail1234.ts.net"] } },
      { tag: "settings", input: { operation: "address", listen: "mac", bind: "127.0.0.1:4100", origins: ["http://localhost:4100"] } }
    ])
  })
  test("a network-bound install keeps its bind in the Network form", () => {
    const h = harness(); h.renderSettings()
    expect(h.settings()!.actions.find(action => action.args?.listen === "network")!.input?.map(field => field.value)).toEqual(["0.0.0.0:4000", "http://localhost:4000\nhttp://mini.local:4000\nhttps://smithers.example.test"])
  })
  test("Setup's model access offers one key control per named role, with no raw role choice", () => {
    const model = installFixture(); model.steps[4]!.state = "pending"
    const h = harness({ model }); h.renderSetup(); const props = h.setup()!
    const keys = props.actions.filter(action => action.tag === "settings" && action.args?.operation === "model-key")
    expect(keys.map(action => ({ args: action.args, label: action.label, input: action.input }))).toEqual([
      { args: { operation: "model-key", step: "models", role: "fast" }, label: "Save", input: [{ name: "value", label: "Cerebras key", kind: "secret", required: true }] },
      { args: { operation: "model-key", step: "models", role: "coding" }, label: "Save", input: [
        { name: "provider", label: "Provider", kind: "choice", required: true, value: "OpenAI", choices: ["OpenAI", "Anthropic", "OpenRouter", "AI Gateway"] },
        { name: "model", label: "Model", kind: "text", required: true },
        { name: "value", label: "API key", kind: "secret", required: true }] },
      { args: { operation: "model-key", step: "models", role: "jev" }, label: "Save", input: [{ name: "value", label: "AI Gateway key", kind: "secret", required: true }] }
    ])
    expect(JSON.stringify(keys.map(action => action.input))).not.toContain("jev")
    props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "model-key")?.args, operation: "model-key", step: "models", role: "coding", provider: "Anthropic", value: "coding-key" })
    props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "model-key")?.args, operation: "model-key", step: "models", role: "jev", value: "gateway-key" })
    expect(h.commands).toEqual([{ tag: "settings", input: { operation: "model-key", role: "coding", provider: "Anthropic" } }, { tag: "settings", input: { operation: "model-key", role: "jev", provider: "AI Gateway" } }])
    expect(h.keys).toEqual(["coding-key", "gateway-key"])
  })
  test.each([0, 2, 3])("saved parallel stays visible at capacity %i", capacity => {
    const model = installFixture(); model.capacity = capacity; model.parallel = 8
    const h = harness({ model }); h.renderSettings()
    expect(h.settings()!.model.capacity).toBe(capacity)
    expect(h.settings()!.model.this_mac.capacity).toBe(3)
    expect(h.settings()!.model.parallel).toBe(8)
    expect(h.settings()!.actions.find(action => action.tag === "settings" && action.args?.operation === "parallel")!.args).toMatchObject({ min: "1", max: "8" })
    h.settings()!.onAction("settings", { ...h.settings()!.actions.find(action => action.tag === "settings" && action.args?.operation === "parallel")?.args, field: "parallel", operation: "parallel", parallel: "8" })
    expect(h.commands).toEqual([{ tag: "settings", input: { operation: "parallel", parallel: 8 } }])
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
  test.each(["pending", "running", "blocked", "failed"] as const)("Setup exposes only the first incomplete %s step's Address choices", state => {
    const model = installFixture(); model.steps[0]!.state = state; model.steps[1]!.state = "pending"
    const h = harness({ model }); h.renderSetup(); const props = h.setup()!
    expect(SetupCardSchema.safeParse(props.model).success).toBe(true)
    expect(props.actions.map(action => [action.label, action.args])).toEqual([["This Mac only", { operation: "setup", step: "address", listen: "mac" }], ["Network", { operation: "setup", step: "address", listen: "network" }]])
    expect(props.actions.map(action => action.disabled !== undefined)).toEqual([state === "running", state === "running"])
    props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "setup")?.args, operation: "setup", step: "app_manifest", bind: "127.0.0.1:4000" })
    props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "setup")?.args, operation: "setup", step: "address", listen: "mac" })
    expect(h.commands).toEqual(state === "running" ? [] : [{ tag: "settings", input: { operation: "setup", step: "address", bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] } }])
  })
  test("Setup's Network binds the chosen address with the teammates' origins, one per line in a multi-line field", () => {
    const model = installFixture(); model.steps[0]!.state = "pending"; model.address = { listen: "mac", bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] }
    const h = harness({ model }); h.renderSetup(); const props = h.setup()!
    expect(props.actions[0]!.input).toBeUndefined()
    expect(props.actions[1]!.input).toEqual([
      { name: "bind", label: "Bind", kind: "text", required: true, value: "0.0.0.0:4000" },
      { name: "origins", label: "Origins", kind: "text", multiline: true, required: true, value: "" }
    ])
    props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "setup")?.args, operation: "setup", step: "address", listen: "network", bind: "0.0.0.0:4000", origins: "http://mini.local:4000\nhttps://box.example\n" })
    props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "setup")?.args, operation: "setup", step: "address", listen: "network", bind: " 10.0.0.5:4000 ", origins: "http://mini.local:4000, http://10.0.0.5:4000" })
    expect(h.commands).toEqual([
      { tag: "settings", input: { operation: "setup", step: "address", bind: "0.0.0.0:4000", origins: ["http://mini.local:4000", "https://box.example"] } },
      { tag: "settings", input: { operation: "setup", step: "address", bind: "10.0.0.5:4000", origins: ["http://mini.local:4000", "http://10.0.0.5:4000"] } }
    ])
  })
  test("an Address step that failed on a network install prefills Network with its bind and teammates' origins", () => {
    const model = installFixture(); model.steps[0] = { id: "address", state: "failed", error: { code: "address_unavailable", class: "user", message: "Can't listen on 10.9.9.9:4000" } }
    model.address = { listen: "network", bind: "10.9.9.9:4000", origins: ["http://localhost:4000", "http://mini.local:4000"] }
    const h = harness({ model }); h.renderSetup()
    expect(h.setup()!.actions[1]!.input?.map(field => field.value)).toEqual(["10.9.9.9:4000", "http://mini.local:4000"])
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
    h.setup()!.onAction("settings", { ...h.setup()!.actions.find(action => action.tag === "settings" && action.args?.operation === "model-key")?.args, operation: "model-key", step: "models", role: "jev", provider: "AI Gateway", value: "private-key" })
    h.settings()!.onAction("settings", { ...h.settings()!.actions.find(action => action.tag === "settings" && action.args?.operation === "model-key")?.args, operation: "model-key", field: "key", role: "fast", provider: "Cerebras", value: "private-key" })
    expect(h.commands).toEqual([{ tag: "settings", input: { operation: "model-key", role: "jev", provider: "AI Gateway" } }, { tag: "settings", input: { operation: "model-key", role: "fast", provider: "Cerebras" } }])
    expect(h.keys).toEqual(["private-key", "private-key"])
    expect(JSON.stringify(h.setup())).not.toContain("private-key"); expect(JSON.stringify(h.settings())).not.toContain("private-key")
  })
  test("a done Address offers Change while setup is unfinished: its two choices again, behind one disclosure", () => {
    const model = installFixture(); for (const step of model.steps.slice(1)) step.state = "pending"
    const h = harness({ model }); h.renderSetup()
    expect(h.setup()!.actions.map(action => [action.label, action.args])).toEqual([
      ["Create GitHub App", { operation: "setup", step: "app_manifest" }],
      ["This Mac only", { operation: "setup", step: "address", listen: "mac" }], ["Network", { operation: "setup", step: "address", listen: "network" }]
    ])
    expect(h.setup()!.actions.find(action => action.args?.listen === "network")!.input?.map(field => field.value))
      .toEqual(["0.0.0.0:4000", "http://mini.local:4000\nhttps://smithers.example.test"])
    h.setup()!.onAction("settings", { ...h.setup()!.actions.find(action => action.tag === "settings" && action.args?.operation === "setup")?.args, operation: "setup", step: "address", listen: "network", bind: "0.0.0.0:4000", origins: "http://williams-mac-mini.local:4000" })
    expect(h.commands).toEqual([{ tag: "settings", input: { operation: "setup", step: "address", bind: "0.0.0.0:4000", origins: ["http://williams-mac-mini.local:4000"] } }])
    const html = renderToStaticMarkup(renderSetupCard({ install: h.install, dispatch: h.dispatch, allowed: true, view: h.view, onView: h.onView }))
    const address = html.slice(html.indexOf('data-step="address"'), html.indexOf('data-step="app_manifest"'))
    expect(address).toContain('<details class="setup-change"><summary>Change</summary>')
    expect(address).toContain(">Network</button>")
    expect(html.match(/<summary>/g)).toHaveLength(1)
  })
  test("finished setup offers no Change: Settings changes the address", () => {
    const h = harness()
    const html = renderToStaticMarkup(renderSetupCard({ install: h.install, dispatch: h.dispatch, allowed: true, view: h.view, onView: h.onView }))
    expect(html).not.toContain("<summary>"); h.renderSetup(); expect(h.setup()!.actions).toEqual([])
  })
  test("completed setup has no step control and callbacks preserve member view state", () => {
    const h = harness(); h.renderSetup(); expect(h.setup()!.actions).toEqual([])
    expect(h.setup()!.view).toBe(h.view); h.setup()!.onView({ maximized: true }); expect(h.patches).toEqual([{ maximized: true }])
    h.setup()!.onAction("settings", { ...h.setup()!.actions.find(action => action.tag === "settings" && action.args?.operation === "parallel")?.args, field: "parallel", operation: "parallel", parallel: "2" }); expect(h.commands).toEqual([])
  })
})


test("after App conversion Setup offers the existing browser sign-in flow", () => {
  const model = installFixture(); model.steps[2] = { id: "sign_in", state: "pending" }
  const h = harness({ model }); h.renderSetup()
  expect(h.setup()!.actions.filter(action => action.args?.step !== "address")).toEqual([expect.objectContaining({ tag: "sign-in", label: "Sign in", args: { step: "sign_in" } })])
  h.setup()!.onAction("sign-in", { step: "sign_in" })
  expect(h.commands).toEqual([{ tag: "sign-in", input: undefined }])
})

test("a refused GitHub sign-in shows its reason on the card and offers Sign in again", async () => {
  const { SetupView } = await import("./views/SetupView")
  const model = installFixture()
  model.steps[2] = { id: "sign_in", state: "failed", error: { code: "unauthenticated", class: "permission", message: "GitHub App needs Email addresses read access" } }
  const h = harness({ model }); h.renderSetup()
  expect(h.setup()!.actions.filter(action => action.args?.step !== "address")).toEqual([expect.objectContaining({ tag: "sign-in", label: "Sign in", args: { step: "sign_in" } })])
  const markup = renderToStaticMarkup(<SetupView {...h.setup()!} />)
  expect(markup).toContain("GitHub App needs Email addresses read access")
  expect(markup).toContain("role=\"alert\"")
})

test("Setup prints whole free GB and the owner's typed refusal beside the owner field", async () => {
  const { SetupView } = await import("./views/SetupView")
  const model = installFixture(); model.this_mac.disk_free_gb = 74.1594467163086
  model.steps[1] = { id: "app_manifest", state: "failed", error: { code: "bad_request", class: "user", message: "GitHub owner not found" } }
  const h = harness({ model }); h.renderSetup()
  const markup = renderToStaticMarkup(<SetupView {...h.setup()!} />)
  expect(markup).toContain("74 GB free"); expect(markup).not.toContain("74.159")
  expect(markup).toContain("GitHub owner not found"); expect(markup).toContain('>Owner</label>')
})

test("a running App step keeps its own control, prefilled, so the person's press can continue to GitHub", () => {
  const model = installFixture(); model.github = { owner: "acme", signed_in: false, app_installed: false }
  model.steps[1] = { id: "app_manifest", state: "running" }; model.steps[2] = { id: "sign_in", state: "pending" }
  const h = harness({ model }); h.renderSetup(); const props = h.setup()!
  expect(props.actions.filter(action => action.args?.step !== "address").map(({ tag, label, args, input, disabled }) => ({ tag, label, args, input, disabled }))).toEqual([{ tag: "settings", label: "Create GitHub App",
    args: { operation: "setup", step: "app_manifest" }, input: [{ name: "owner", label: "Owner", kind: "text", required: true, value: "acme" }], disabled: undefined }])
  props.onAction("settings", { ...props.actions.find(action => action.tag === "settings" && action.args?.operation === "setup")?.args, operation: "setup", step: "app_manifest", owner: "acme" })
  expect(h.commands).toEqual([{ tag: "settings", input: { operation: "setup", step: "app_manifest", owner: "acme" } }])
})

 test("Repository has only the App installation fix when no choices are installed (#3455)", () => {
   const model = installFixture(); model.steps[3] = { id: "repository", state: "blocked", blocked: { line: "Install the GitHub App", fix_url: "https://github.com/apps/smithers/installations/new" } }; model.repositories = []; delete model.repository
   const h = harness({ model })
   const html = renderToStaticMarkup(renderSetupCard({ install: h.install, dispatch: h.dispatch, allowed: true, view: h.view, onView: h.onView }))
   expect(html).toContain('href="https://github.com/apps/smithers/installations/new"')
   expect(html).not.toContain('aria-label="Repository"')
 })
 test("Repository choice dispatches the installed slug through the card flow (#3455)", () => {
   const model = installFixture(); model.steps[3]!.state = "pending"; model.repositories = ["acme/real"]; delete model.repository
   const h = harness({ model }); h.renderSetup()
   expect(h.setup()!.actions[0]!.input?.[0]?.choices).toEqual(["acme/real"])
   h.setup()!.onAction("settings", { ...h.setup()!.actions.find(action => action.tag === "settings" && action.args?.operation === "setup")?.args, operation: "setup", step: "repository", repository: "acme/real" })
   expect(h.commands).toEqual([{ tag: "settings", input: { operation: "setup", step: "repository", repository: "acme/real" } }])
 })

 test("coding row carries the model choice with its write-only key; the seed keeps its original inputs (#3455)", () => {
   const model = installFixture(); model.steps[4]!.state = "pending"
   const h = harness({ model }); h.renderSetup()
   h.setup()!.onAction("settings", { ...h.setup()!.actions.find(action => action.tag === "settings" && action.args?.operation === "model-key")?.args, operation: "model-key", step: "models", role: "coding", provider: "Anthropic", model: "claude-sonnet-4-5", value: "secret" })
   expect(h.commands).toEqual([{ tag: "settings", input: { operation: "model-key", role: "coding", provider: "Anthropic", model: "claude-sonnet-4-5" } }]); expect(h.keys).toEqual(["secret"])
   const seed = harness({ model, seed: true }); seed.renderSetup(); seed.renderSettings()
   for (const props of [seed.setup()!, seed.settings()!]) expect(props.actions.filter(action => action.tag === "settings" && action.args?.operation === "model-key").flatMap(action => action.input ?? []).some(input => input.name === "model")).toBe(false)
 })

/** GET /api/install as the Go host serves a host that fits no machine (host_status_integration_test: 32 GiB, 10 cores, 60 GiB free). */
const noMachineFits = () => {
  const model = installFixture()
  model.capacity = 0; model.parallel = undefined
  model.this_mac = InstallModelSchema.shape.this_mac.parse({ memory_gb: 32, disk_free_gb: 60, capacity: 0, perf_cores: 10, limit: { term: "disk", fix: "free 12 GiB on the state volume" } })
  return model
}
test("Settings' This Mac row names the host's limiting term and fix, and the fix re-reads the install (#3658)", async () => {
  const { SettingsView } = await import("./views/SettingsView")
  const h = harness({ model: noMachineFits() }); h.renderSettings(); const props = h.settings()!
  expect(props.model.this_mac).toEqual({ memory_gb: 32, disk_free_gb: 60, capacity: 0,
    limit: { term: "disk", fix: { tag: "settings", label: "free 12 GiB on the state volume" } } })
  // The fix is the row's own control, never a second loose action under the list.
  expect(props.actions.filter(action => action.tag === "settings" && action.args?.operation === undefined)).toEqual([])
  props.onAction("settings", {})
  expect(h.commands).toEqual([{ tag: "settings", input: undefined }])
  const markup = renderToStaticMarkup(<SettingsView {...props} />)
  expect(markup).toContain("No machine fits · disk · ")
  expect(markup.match(/free 12 GiB on the state volume/g)).toHaveLength(1)
})
test("a host that fits a machine shows no limit on Settings (#3658)", () => {
  const h = harness(); h.renderSettings()
  expect(h.settings()!.model.this_mac.limit).toBeUndefined()
  expect(() => h.settings()!.onAction("settings", {})).not.toThrow()
  expect(h.commands).toEqual([])
})

test("C-FM-01 Setup and Settings bind Smithers source controls and retain the team key",()=>{
 const model=installFixture();model.fast_model={signed_in:false,source:"team key"};model.steps[4]={id:"models",state:"pending"}
 const h=harness({model});h.renderSetup();h.renderSettings()
 const setup=h.setup()!,settings=h.settings()!
 expect(setup.model.fast_model).toEqual(model.fast_model);expect(settings.model.fast_model).toEqual(model.fast_model)
 expect(setup.actions.filter(action=>action.tag==="settings.fast-model")).toEqual([expect.objectContaining({label:"Sign in to Smithers",args:{step:"models",role:"fast"}})])
 setup.onAction("settings.fast-model",{step:"models",role:"fast"})
 expect(h.commands.at(-1)).toEqual({tag:"settings.fast-model",input:{action:"sign-in"}})
 expect(setup.actions.some(action=>action.tag==="settings"&&action.args?.operation==="model-key"&&action.args?.role==="fast")).toBe(true)
 model.fast_model={signed_in:true,source:"team key",cause:"capacity",remaining:0,reset_at:"2026-10-08T00:00:00Z"};h.renderSettings()
 h.settings()!.onAction("settings.fast-model",{role:"fast"})
 expect(h.commands.at(-1)).toEqual({tag:"settings.fast-model",input:{action:"sign-out"}})
 const html=renderToStaticMarkup(renderSetupCard({install:h.install,dispatch:h.dispatch,allowed:true,view:h.view,onView:h.onView}))
 expect(html).toContain("daily Smithers quota used; using team key until 00:00 UTC");expect(html).toContain("Smithers keeps token counts only")
 expect(html.match(/>Sign out</g)).toHaveLength(1)
 expect(html).not.toMatch(/credit card|billing/i)
})
