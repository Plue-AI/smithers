import type { SettingsCard } from "../../src/SettingsCard.ts"
import { fixtures as setup } from "./Setup.ts"

const base: SettingsCard = {
  ...setup.done,
  machines: 2,
  max_machines: 3,
  obsidian_folder: "/Users/ben/Smithers",
  members: [{ login: "ben", name: "Ben Carter", role: "owner" }],
  notifications_need_https: true,
  parallel: 2,
  laptop_line: "smthrs login http://mac-mini.local:8080"
}
export const fixtures = {
  ready: base,
  configuring: { ...base, ...setup.active, parallel: 1 },
  failed: { ...base, ...setup.failed, parallel: 1, github: { ...base.github, app_error: "App callback URL missing" } },
  upgrade: { ...base, upgrade: { version: "1.0.1" } },
  empty: {
    ...base,
    machines: 0,
    max_machines: 0,
    parallel: 0,
    obsidian_folder: "",
    members: [],
    notifications_need_https: false
  }
} satisfies Record<string, SettingsCard>
