import { fixtures as rpcFixtures } from "@smthrs/rpc/fixtures/Settings"
import { SettingsView } from "./SettingsView"
import { fixtureStories } from "./stories"
export const fixtures = { ...rpcFixtures, degraded: { ...rpcFixtures.degraded, expect: ["Process · degraded"] } }
export const stories = [
  ...fixtureStories(fixtures, (story, callbacks) => <SettingsView {...story} {...callbacks} />),
  {
    name: "Supplied model slot", expect: ["Fast model"],
    render: (callbacks: import("./stories").StoryCallbacks) => <SettingsView {...fixtures.ready} {...callbacks}
      modelSlot={<><dt>Fast model</dt><dd><button type="button" onClick={() => callbacks.onAction("settings.model.set", { role: "fast", model: "llama-4-scout" })}>Change model</button></dd></>} />
  }
]
