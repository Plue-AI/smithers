import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { mock } from "bun:test"

GlobalRegistrator.register()
const calls: string[] = []
const initialUrl = window.location.href
const fakeStore = { savedStoreUnavailable: true, dispose: async () => { calls.push("store.dispose") } }
const fakeController = {
  dispose: async () => { calls.push("controller.dispose") },
  adoptSession: async () => { calls.push("identity.adopt") },
  loadSession: async () => { calls.push("identity.load") },
  observeModels: () => { calls.push("models.observe") },
  runCommand: () => { calls.push("command.run") },
  handleInstallReturn: () => { calls.push("install.return"); return false },
  handleAuthReturn: () => { calls.push("auth.return"); return false }
}
const fetchImpl = async () => Response.json({})
mock.module("./runtime/ApplicationTransport", () => ({
  loadRuntimeApplicationClient: async () => ({ fetch: fetchImpl, baseUrl: "https://smithers.sh", target: { kind: "hosted" } })
}))
mock.module("./runtime/Runtime", () => ({
  warmBootstrap: () => Promise.resolve({ host: "cloud", capabilities: ["identity"] }),
  createRuntime: () => ({ backend: { agent: {} }, http: fetchImpl, shell: { kind: "web" }, bootstrap: { host: "cloud", capabilities: ["identity"] } }),
  unavailableAgent: () => ({}),
  BootstrapFailure: class BootstrapFailure extends Error {}
}))
mock.module("./state/AppStore", () => ({ createAppStore: async () => fakeStore }))
mock.module("./state/AppController", () => ({ createAppController: () => fakeController }))
mock.module("./RepoLink", () => ({
  requestedRepo: () => "roninjin10/smithers",
  beginRepositoryEntry: () => { calls.push("repository.entry"); return "entry" },
  openRequestedRepo: async () => { calls.push("repository.open") },
  withoutRepoParam: () => "/roninjin10/smithers"
}))
mock.module("./runtime/FrameHistory", () => ({ createBrowserFrameHistory: () => ({}) }))
mock.module("./runtime/TurnErasure", () => ({ createTurnEraser: () => async () => {} }))
mock.module("./native/NativeBridge", () => ({
  nativeShellAvailable: false,
  nativeApplicationBootstrapToken: undefined,
  nativeOpenExternal: undefined
}))
const { runControllerBoot } = await import("./ControllerBoot.client")
const controller = await runControllerBoot()
if ((controller as unknown) !== fakeController) throw new Error("boot did not return the recovery controller")
if (calls.length !== 0) throw new Error(`boot started actions: ${calls.join(",")}`)
if (window.location.href !== initialUrl) throw new Error("boot changed the recovery URL")
console.log("recovery boot stopped before repository, identity, or URL actions")
process.exit(0)
