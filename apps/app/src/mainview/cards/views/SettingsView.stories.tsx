import { fixtures } from "@smthrs/rpc/fixtures/Settings"
import { SettingsView } from "./SettingsView"
export const settingsStories = Object.entries(fixtures).map(([id, story]) => ({ id: `settings-${id}`, name: story.name, render: () => <SettingsView {...story} onAction={() => {}} onView={() => {}} /> }))
