import { fixtures } from "@smthrs/rpc/fixtures/Settings"
import { SettingsView } from "./SettingsView"
import { fixtureStories } from "./stories"
export const stories = fixtureStories(fixtures, (story, callbacks) => <SettingsView {...story} {...callbacks} />)
