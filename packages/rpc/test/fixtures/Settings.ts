import type { Action } from "../../src/CardAction.ts"
import type { SettingsCard } from "../../src/SettingsCard.ts"
import { type Story, story } from "./_story.ts"
import { fixtures as setup } from "./Setup.ts"

const memberBase: SettingsCard = {
  ...setup.done.model,
  address: { ...setup.done.model.address, origins_unencrypted: ["http://mac-mini.local:8080"] },
  capacity: 2,
  laptop_lines: ["smthrs login http://mac-mini.local:8080", "smthrs login https://smithers.example.test"],
  notifications_need_https: false,
  health: {
    process: "ok",
    postgres_bytes: 734_003_200,
    disk_free_gb: 412,
    github: { health: "fresh", rate_remaining: 4_812, rate_limit: 5_000 }
  }
}
// todo_daily_admissions is owner-only (spec §14.3 Settings, §10.4.1b): the default allowance is 12.
const base: SettingsCard = { ...memberBase, todo_daily_admissions: 12 }
const stepper = (
  field: "capacity" | "parallel" | "todo_daily_admissions",
  label: string,
  value: number
): Action => ({
  tag: "settings",
  label,
  args: { field },
  input: [{ name: "value", label, kind: "text", required: true, value: String(value) }]
})
// The owner's controls (T-UI-02): Change per model role (settings.model.set, owner only), Repair (GitHub), the
// steppers and the Obsidian folder field.
const owner: Action[] = [
  ...([["fast", "Fast model", "llama-4-scout"], ["coding", "Coding model", "gpt-6.1-sol"], [
    "jev",
    "Decisions",
    "typesafe-ai/jev"
  ]] as const).map(([role, label, model]): Action => ({
    tag: "settings.model.set",
    label: "Change",
    args: { role },
    input: [{ name: "model", label, kind: "text", required: true, value: model }]
  })),
  { tag: "github", label: "Repair" },
  stepper("capacity", "Machines", 2),
  stepper("todo_daily_admissions", "TODOs per day", 12),
  {
    tag: "settings",
    label: "Obsidian folder",
    args: { field: "obsidian" },
    input: [{ name: "path", label: "Obsidian folder", kind: "text", required: false }]
  }
]
const https: Action = {
  tag: "docs",
  label: "Notifications need HTTPS ↗",
  args: { page: "quickstart#put-https-in-front" }
}

export const fixtures = {
  ready: story("Settings for the owner", base, {
    actions: owner,
    expect: ["smthrs login http://mac-mini.local:8080", "Machines", "TODOs per day"]
  }),
  squash_blocked: story(
    "Repository blocked until squash merging is on",
    { ...base, steps: setup.squash_blocked.model.steps, github: setup.squash_blocked.model.github },
    { actions: owner, expect: ["Enable squash merging on GitHub ↗"] }
  ),
  address_failed: story(
    "Address apply failed; the previous bind remains active",
    {
      ...base,
      address: {
        ...base.address,
        failed: {
          from: "0.0.0.0:8080",
          to: "0.0.0.0:9090",
          reason: { class: "infra", message: "Address already in use" }
        }
      }
    },
    { actions: [{ tag: "settings", label: "Retry", args: { step: "address" }, input: [{ name: "bind", label: "Address", kind: "text", required: true, value: "0.0.0.0:9090" }] }, ...owner], expect: ["0.0.0.0:8080", "Address already in use", "Retry"] }
  ),
  notifications_need_https: story(
    "Notifications need HTTPS on a plain-HTTP origin",
    { ...base, notifications_need_https: true },
    { actions: [...owner, https], expect: ["Notifications need HTTPS ↗"] }
  ),
  github_stale: story(
    "GitHub sync stale",
    {
      ...base,
      health: { ...base.health, github: { ...base.health.github, health: "stale", cause: "Webhook delayed" } }
    },
    { actions: owner, expect: ["Webhook delayed"] }
  ),
  github_limited: story(
    "GitHub rate limited until a retry time",
    {
      ...base,
      health: {
        ...base.health,
        github: {
          health: "limited",
          cause: "GitHub rate limit",
          retry_at: "2026-10-02T18:00:00.000Z",
          rate_remaining: 0,
          rate_limit: 5_000
        }
      }
    },
    { actions: owner, expect: ["GitHub rate limit", "2026-10-02T18:00:00.000Z"] }
  ),
  github_refused: story(
    "GitHub refused: Repair",
    {
      ...base,
      github: { ...base.github, app_installed: false },
      health: {
        ...base.health,
        github: { health: "refused", cause: "GitHub App uninstalled", rate_remaining: 0, rate_limit: 0 }
      }
    },
    { actions: owner, expect: ["GitHub App uninstalled", "Repair"] }
  ),
  degraded: story(
    "Degraded process with little disk left",
    { ...base, health: { ...base.health, process: "degraded", disk_free_gb: 3.5 } },
    { actions: owner, expect: ["Change"] }
  ),
  obsidian: story(
    "Obsidian folder syncing",
    { ...base, obsidian: { path: "/Users/ben/Smithers", last_sync_at: "2026-10-02T17:40:00.000Z" } },
    { actions: owner, expect: ["/Users/ben/Smithers"] }
  ),
  obsidian_error: story(
    "Obsidian folder failing",
    { ...base, obsidian: { path: "/Users/ben/Missing", error: "Folder not found" } },
    { actions: owner, expect: ["Folder not found"] }
  ),
  no_capacity: story(
    "No machine capacity",
    { ...base, ...setup.no_capacity.model, address: base.address, capacity: 0 },
    { actions: owner, expect: ["Close apps to free 6 GB"] }
  ),
  // TODOs at once binds only after T-STK-03's S2 guard; S1 projections omit parallel (C-J4-01).
  parallel_s2: story("TODOs at once, from S2", { ...base, parallel: 2 }, {
    actions: [...owner, stepper("parallel", "TODOs at once", 2)],
    expect: ["TODOs at once"]
  }),
  raised_daily_admissions: story(
    "The owner raised the daily TODO allowance",
    { ...base, todo_daily_admissions: 20 },
    { actions: owner, expect: ["20", "TODOs per day"] }
  ),
  member_view: story("Settings as a member, read-only", memberBase, {
    expect: ["smthrs login https://smithers.example.test"]
  })
} satisfies Record<string, Story<SettingsCard>>
