import type { InstallModel } from "./InstallModel"
import { MODEL_CREDENTIALS } from "@smthrs/rpc/ConfiguredModel"
export const credentialReceipt = (name = "AI_GATEWAY_API_KEY") => ({ ok: true, credential: {
  name, present: true, managed: true, origins: MODEL_CREDENTIALS.find(credential => credential.name === name)!.origins
} })
export const installFixture = (): InstallModel => ({
  address: { listen: "network", bind: "0.0.0.0:4000", origins: ["http://localhost:4000", "http://mini.local:4000", "https://smithers.example.test"] },
  steps: ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"].map(id => ({ id, state: "done" })) as InstallModel["steps"],
  this_mac: { memory_gb: 48, disk_free_gb: 100, capacity: 3 },
  github: { owner: "smithersai", signed_in: true, app_installed: true, squash_allowed: true },
  repository: { owner: "smithersai", name: "smithers" }, repositories: ["smithersai/smithers"],
  models: [{ role: "fast", provider: "Cerebras", key: "saved" }, { role: "coding", provider: "OpenAI", key: "saved" }, { role: "jev", provider: "AI Gateway", key: "saved" }],
  chatgpt: false, capacity: 2, parallel: 2,
  health: { process: "ok", postgres_bytes: 1024, disk_free_gb: 100, github: { health: "fresh", rate_remaining: 4999, rate_limit: 5000 } }
})
