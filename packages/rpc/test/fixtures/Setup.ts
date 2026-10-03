import type { Action } from "../../src/CardAction.ts"
import type { SetupCard, SetupStep } from "../../src/SetupCard.ts"
import { type Story, story } from "./_story.ts"

type StepPatch = Partial<Record<SetupStep["id"], Omit<SetupStep, "id">>>
const ids = ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"] as const
/** All seven steps in order: those before `current` done, the rest pending, with per-step overrides. */
const steps = (current: number, patch: StepPatch = {}): SetupStep[] =>
  ids.map((id, index) => ({ id, state: index < current ? "done" : "pending", ...patch[id] }))

const done: SetupCard = {
  address: {
    listen: "network",
    bind: "0.0.0.0:8080",
    origins: ["http://mac-mini.local:8080", "https://smithers.example.test"]
  },
  steps: steps(7),
  this_mac: { memory_gb: 48, disk_free_gb: 412, capacity: 3 },
  github: { owner: "smithersai", signed_in: true, app_installed: true, squash_allowed: true },
  repository: { owner: "smithersai", name: "smithers" },
  models: [
    { role: "fast", provider: "Cerebras", key: "saved" },
    { role: "coding", provider: "OpenAI", key: "saved" },
    { role: "jev", provider: "AI Gateway", key: "saved" }
  ],
  chatgpt: true
}
const fresh: SetupCard = {
  address: { listen: "mac", bind: "127.0.0.1:4000", origins: ["http://localhost:4000"] },
  steps: steps(0, { address: { state: "running" } }),
  this_mac: { memory_gb: 48, disk_free_gb: 412, capacity: 3 },
  github: { signed_in: false, app_installed: false },
  models: [
    { role: "fast", provider: "Cerebras", key: "none" },
    { role: "coding", provider: "OpenAI", key: "none" },
    { role: "jev", provider: "AI Gateway", key: "none" }
  ],
  chatgpt: false
}
const step = (id: SetupStep["id"], label: string, parts: Partial<Action> = {}): Action => ({
  tag: id === "sign_in" ? "sign-in" : id === "app_manifest" || id === "repository" ? "github" : "settings",
  label,
  args: { step: id },
  primary: true,
  ...parts
})
const retry = (id: SetupStep["id"]): Action => step(id, "Retry")

export const fixtures = {
  fresh: story("A fresh install choosing its address", fresh, {
    actions: [step("address", "Save address", {
      input: [
        { name: "listen", label: "Listen", kind: "choice", choices: ["mac", "network"], required: true, value: "mac" },
        { name: "bind", label: "Bind", kind: "text", required: true, value: "127.0.0.1:4000" }
      ]
    })],
    expect: ["http://localhost:4000", "Save address"]
  }),
  app: story(
    "Creating the GitHub App",
    {
      ...fresh,
      steps: steps(1, { app_manifest: { state: "running" } }),
      github: { owner: "smithersai", ...fresh.github }
    },
    {
      actions: [step("app_manifest", "Create GitHub App", {
        input: [{ name: "owner", label: "Owner", kind: "text", required: true, value: "smithersai" }]
      })],
      expect: ["Create GitHub App", "smithersai"]
    }
  ),
  sign_in: story(
    "Signing in with GitHub",
    {
      ...fresh,
      steps: steps(2, { sign_in: { state: "running" } }),
      github: { owner: "smithersai", signed_in: false, app_installed: true }
    },
    { actions: [step("sign_in", "Sign in with GitHub")], expect: ["Sign in with GitHub"] }
  ),
  choosing_repository: story(
    "Choosing the repository",
    {
      ...fresh,
      steps: steps(3, { repository: { state: "running" } }),
      github: { owner: "smithersai", signed_in: true, app_installed: true },
      repositories: ["smithersai/smithers", "smithersai/plue"]
    },
    {
      actions: [step("repository", "Choose repository", {
        input: [{
          name: "repository",
          label: "Repository",
          kind: "choice",
          choices: ["smithersai/smithers", "smithersai/plue"],
          required: true
        }]
      })],
      expect: ["smithersai/smithers", "smithersai/plue"]
    }
  ),
  squash_blocked: story(
    "Repository blocked until squash merging is on",
    {
      ...fresh,
      steps: steps(3, {
        repository: {
          state: "blocked",
          blocked: {
            line: "Enable squash merging on GitHub ↗",
            fix_url: "https://github.com/smithersai/smithers/settings"
          }
        }
      }),
      github: { owner: "smithersai", signed_in: true, app_installed: true, squash_allowed: false },
      repository: { owner: "smithersai", name: "smithers" }
    },
    { expect: ["Enable squash merging on GitHub ↗"] }
  ),
  models_validating: story(
    "Validating the coding model key",
    {
      ...done,
      steps: steps(4, { models: { state: "running" } }),
      models: [
        { role: "fast", provider: "Cerebras", key: "saved" },
        { role: "coding", provider: "OpenAI", key: "validating" },
        { role: "jev", provider: "AI Gateway", key: "none" }
      ],
      chatgpt: false
    },
    {
      actions: [step("models", "Save keys", {
        input: [
          { name: "fast", label: "Fast model", kind: "secret", required: false },
          { name: "coding", label: "Coding model", kind: "secret", required: false },
          { name: "jev", label: "AI Gateway key", kind: "secret", required: true }
        ]
      })],
      expect: ["OpenAI", "AI Gateway key"]
    }
  ),
  models_failed: story(
    "A rejected AI Gateway key",
    {
      ...done,
      steps: steps(4, { models: { state: "failed", error: { class: "model_key_rejected", message: "Key rejected" } } }),
      models: [
        { role: "fast", provider: "Cerebras", key: "saved" },
        { role: "coding", provider: "OpenAI", key: "saved" },
        { role: "jev", provider: "AI Gateway", key: "failed", error: "401 from the gateway" }
      ]
    },
    {
      actions: [step("models", "Retry", {
        tag: "settings.model-key",
        args: { role: "jev", provider: "AI Gateway" },
        input: [{ name: "key", label: "AI Gateway key", kind: "secret", required: true }]
      })],
      expect: ["Key rejected", "401 from the gateway", "AI Gateway key", "Retry"]
    }
  ),
  source_running: story("Copying the source", { ...done, steps: steps(5, { source: { state: "running", pct: 45 } }) }, {
    expect: ["smithers"]
  }),
  machine_failed: story(
    "The first machine failed to start",
    {
      ...done,
      steps: steps(6, {
        machine: { state: "failed", pct: 60, error: { class: "disk_full", message: "Free disk space" } }
      })
    },
    { actions: [retry("machine")], expect: ["Free disk space", "Retry"] }
  ),
  no_capacity: story(
    "This Mac has no room for a machine",
    {
      ...done,
      steps: steps(6),
      this_mac: {
        memory_gb: 8,
        disk_free_gb: 18,
        capacity: 0,
        limit: { term: "memory", fix: { tag: "settings", label: "Close apps to free 6 GB", args: { step: "machine" } } }
      }
    },
    { expect: ["Close apps to free 6 GB"] }
  ),
  done: story("Setup done", done, { expect: ["https://smithers.example.test", "Cerebras"] })
} satisfies Record<string, Story<SetupCard>>

// Key entry is person-only; the agent projection carries no retry form.
export const personOnlyFixtures = {
  models_failed_agent: story("A rejected key viewed by an agent", fixtures.models_failed.model, {
    expect: ["Key rejected", "401 from the gateway"]
  })
} satisfies Record<string, Story<SetupCard>>
