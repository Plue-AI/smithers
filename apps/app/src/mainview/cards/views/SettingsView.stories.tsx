import { fixtures } from "@smthrs/rpc/fixtures/Settings"
import { SettingsView } from "./SettingsView"
export const settingsStories = Object.entries(fixtures).map(([id, story]) => ({ id: `settings-${id}`, name: story.name, render: () => <SettingsView {...story} onAction={() => {}} onView={() => {}} /> }))
// The failed draft comes through supplied form inputs; the model retains the live address.
const failedAddress = {
  ...fixtures.ready,
  model: {
    ...fixtures.ready.model,
    steps: fixtures.ready.model.steps.map(step => step.id === "address" ? { ...step, state: "failed" as const, error: { class: "address_apply_failed", message: "Address is unreachable from this Mac" } } : step)
  },
  actions: [{ tag: "settings" as const, label: "Retry", args: { step: "address" }, input: [{ name: "bind", label: "Address", kind: "text" as const, required: true, value: "192.168.1.40:8080" }] }]
}
settingsStories.push({ id: "settings-address_failed", name: "Address failed to apply", render: () => <SettingsView {...failedAddress} onAction={() => {}} onView={() => {}} /> })
