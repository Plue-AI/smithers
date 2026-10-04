import { z } from "zod"
import { SetupCardSchema, SetupStepIdSchema, SETUP_STEP_IDS, type SetupStepId, type SetupCard } from "@smthrs/rpc/SetupCard"
import { SettingsCardSchema, type SettingsCard } from "@smthrs/rpc/SettingsCard"
import { HttpUrlSchema } from "@smthrs/rpc/WebUrl"
import { ActionSchema } from "@smthrs/rpc/CardAction"

// T-APP-03: T-INS-06 wire states are mapped only at the View boundary.
export const InstallErrorSchema = z.object({
  code: z.string(), class: z.enum(["user", "permission", "capacity", "github", "infra", "conflict", "never"]),
  message: z.string(), retry_at: z.string().optional(), fix: z.string().optional()
})
export type InstallError = z.infer<typeof InstallErrorSchema>
export type InstallStepId = SetupStepId
const state = z.enum(["pending", "running", "done", "blocked", "failed"])
const role = z.object({ role: z.enum(["fast", "coding", "jev"]), provider: z.string(),
  key: z.enum(["none", "validating", "saved", "failed"]), error: z.string().optional() })
export const InstallModelSchema = z.object({
  address: z.object({ listen: z.enum(["mac", "network"]), bind: z.string(), origins: z.array(HttpUrlSchema),
    change_failed: z.object({ from: z.string(), to: z.string(), reason: z.string() }).optional() }),
  steps: z.array(z.object({ id: SetupStepIdSchema, state, pct: z.number().min(0).max(100).optional(),
    blocked: z.object({ line: z.string(), fix_url: z.string().url() }).optional(),
    error: InstallErrorSchema.omit({ code: true }).extend({ code: z.string().optional() }).optional() })),
  this_mac: z.object({ memory_gb: z.number().nonnegative(), disk_free_gb: z.number().nonnegative(),
    capacity: z.number().int().nonnegative(), limit: z.object({ term: z.string(), fix: ActionSchema }).optional() }),
  github: z.object({ owner: z.string().optional(), signed_in: z.boolean(), app_installed: z.boolean(),
    squash_allowed: z.boolean().optional(), app_error: z.string().optional() }),
  repository: z.object({ owner: z.string(), name: z.string() }).optional(),
  repositories: z.array(z.string()).optional(), models: z.array(role), chatgpt: z.boolean(),
  capacity: z.number().int().nonnegative(), parallel: z.number().int().min(1).max(8).optional(),
  wiki_sync: z.object({ obsidian: SettingsCardSchema.shape.obsidian }).optional(),
  health: z.object({ process: z.enum(["ok", "degraded"]), postgres_bytes: z.number().nonnegative(),
    disk_free_gb: z.number().nonnegative(), github: z.object({ health: z.enum(["fresh", "stale", "limited", "refused"]),
      cause: z.string().optional(), retry_at: z.string().optional(), rate_remaining: z.number().nonnegative(),
      rate_limit: z.number().nonnegative() }) }).optional()
}).superRefine((model, ctx) => {
  if (model.steps.length !== SETUP_STEP_IDS.length || model.steps.some((step, index) => step.id !== SETUP_STEP_IDS[index]))
    ctx.addIssue({ code: "custom", message: "Setup steps must follow install order" })
  if (model.models.length !== 3 || new Set(model.models.map(model => model.role)).size !== 3)
    ctx.addIssue({ code: "custom", message: "Three model roles required" })
  if (model.capacity > model.this_mac.capacity)
    ctx.addIssue({ code: "custom", message: "Install limits exceeded" })
})
export type InstallModel = z.infer<typeof InstallModelSchema>
export const setupCardModel = (model: InstallModel): SetupCard => SetupCardSchema.parse({
  ...model,
  models: ["fast", "coding", "jev"].map(role => model.models.find(model => model.role === role)!)
})
export const settingsCardModel = (model: InstallModel, origin: string): SettingsCard => {
  const url = new URL(origin)
  const setup = setupCardModel(model)
  const refused = model.address.change_failed
  return SettingsCardSchema.parse({ ...setup,
    address: { ...setup.address, ...(refused ? { failed: { from: refused.from, to: refused.to,
      reason: { class: "user", message: refused.reason } } } : {}) },
    capacity: model.capacity, parallel: model.parallel, health: model.health, obsidian: model.wiki_sync?.obsidian,
    laptop_lines: model.address.origins.map(origin => `smthrs login ${origin}`),
    notifications_need_https: url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  })
}

// Setup writes return admission or browser-handoff receipts, never completion.
export const InstallManifestSchema = z.object({ action_url: z.string().url(), manifest: z.record(z.string(), z.unknown()), state: z.string().min(1) })
export const InstallReceiptSchema = z.union([
  z.object({ operationId: z.string().min(1), requestId: z.string().min(1), kind: z.string().min(1), state: z.literal("accepted") }),
  InstallManifestSchema
])
export type InstallManifest = z.infer<typeof InstallManifestSchema>
