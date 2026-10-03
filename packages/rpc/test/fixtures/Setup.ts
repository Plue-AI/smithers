import type { SetupCard } from "../../src/SetupCard.ts"

const base: SetupCard = {
  address: { listen: "network", addresses: ["http://mac-mini.local:8080"] },
  steps: [
    { id: "address", state: "done" },
    { id: "app_manifest", state: "done" },
    { id: "sign_in", state: "done" },
    { id: "repository", state: "done" },
    { id: "models", state: "done" },
    { id: "source", state: "done" },
    { id: "machine", state: "done" }
  ],
  this_mac: { memory_gb: 48, machines: 2, max_machines: 3 },
  github: { owner: "smithersai", signed_in: true, app_installed: true, squash_allowed: true },
  repository: { owner: "smithersai", name: "smithers" },
  repositories: [{ owner: "smithersai", name: "smithers" }],
  models: {
    fast: { state: "saved", provider: "openai" },
    coding: { state: "saved", provider: "openai" },
    jev: { state: "saved", provider: "vercel" }
  },
  source: { state: "done", pct: 100 },
  machine: { state: "done", pct: 100 }
}
export const fixtures = {
  done: base,
  next: {
    ...base,
    address: { listen: "mac", addresses: ["http://localhost:4000"] },
    steps: [{ id: "address", state: "next" }],
    this_mac: { memory_gb: 48, machines: 0, max_machines: 3 },
    github: { owner: "smithersai", signed_in: false, app_installed: false, squash_allowed: false },
    repository: undefined,
    repositories: [],
    models: {
      fast: { state: "missing", provider: "openai" },
      coding: { state: "missing", provider: "openai" },
      jev: { state: "missing", provider: "vercel" }
    },
    source: { state: "next", pct: 0 },
    machine: { state: "next", pct: 0 }
  },
  active: {
    ...base,
    steps: [{ id: "source", state: "active" }, { id: "machine", state: "next" }],
    models: { ...base.models, coding: { state: "validating", provider: "openai" } },
    source: { state: "active", pct: 45 },
    machine: { state: "next", pct: 0, minutes_left: 6 }
  },
  failed: {
    ...base,
    steps: [{
      id: "machine",
      state: "failed",
      error: { code: "disk_full", message: "Free disk space", fix: "Remove unused machines" }
    }],
    machine: { state: "failed", pct: 60 }
  },
  address_failed: {
    ...base,
    address: {
      ...base.address,
      change_failed: {
        from: "http://mac-mini.local:8080",
        to: "https://smithers.example.test",
        reason: "Address in use"
      }
    }
  },
  error_without_fix: {
    ...base,
    steps: [{ id: "models", state: "failed", error: { code: "model_unavailable", message: "Model unavailable" } }],
    models: { ...base.models, jev: { state: "failed", provider: "vercel", error: "Key rejected" } }
  }
} satisfies Record<string, SetupCard>
