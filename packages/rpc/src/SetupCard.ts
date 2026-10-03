/**
 * Setup data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks, CardProps } from "./CardAction.ts"
import { CardErrorSchema, MODEL_ROLES, ModelRoleIdSchema } from "./CardPrimitives.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

/**
 * The setup steps in spec §16.2 order (T-INS-06 steps 0–6). Each is stored under `setup.<id>`.
 * @since 1.0.0
 * @category constants
 */
export const SETUP_STEP_IDS = [
  "address",
  "app_manifest",
  "sign_in",
  "repository",
  "models",
  "source",
  "machine"
] as const

/**
 * A setup step's identity.
 * @since 1.0.0
 * @category schemas
 */
export const SetupStepIdSchema = z.enum(SETUP_STEP_IDS)

/**
 * The value decoded by {@link SetupStepIdSchema}.
 * @since 1.0.0
 * @category models
 */
export type SetupStepId = z.infer<typeof SetupStepIdSchema>

/**
 * One setup step as T-INS-06 reports it. A step's control enables when the step before it is done; a blocked step
 * shows its fix link, and a failed step shows Retry.
 * @since 1.0.0
 * @category schemas
 */
export const SetupStepSchema = z.object({
  id: SetupStepIdSchema,
  state: z.enum(["pending", "running", "done", "blocked", "failed"]),
  blocked: z.object({ line: z.string(), fix_url: HttpUrlSchema }).optional(),
  error: CardErrorSchema.optional(),
  pct: z.number().min(0).max(100).optional()
})

/**
 * The value decoded by {@link SetupStepSchema}.
 * @since 1.0.0
 * @category models
 */
export type SetupStep = z.infer<typeof SetupStepSchema>

/**
 * One model role's provider and key state; jev's key field reads "AI Gateway key".
 * @since 1.0.0
 * @category schemas
 */
export const ModelRoleSchema = z.object({
  role: ModelRoleIdSchema,
  provider: z.string(),
  key: z.enum(["none", "validating", "saved", "failed"]),
  error: z.string().optional()
})

/**
 * The value decoded by {@link ModelRoleSchema}.
 * @since 1.0.0
 * @category models
 */
export type ModelRole = z.infer<typeof ModelRoleSchema>

/**
 * Setup projection fields from spec §14.3 and ui-components.md v0.4 (T-UI-02).
 * @since 1.0.0
 * @category schemas
 */
export const SetupCardSchema = z.object({
  address: z.object({ listen: z.enum(["mac", "network"]), bind: z.string(), origins: z.array(HttpUrlSchema) }),
  steps: z.array(SetupStepSchema).refine(
    (steps) => steps.map((step) => step.id).join() === SETUP_STEP_IDS.join(),
    { message: "Setup lists all seven steps in §16.2 order." }
  ),
  this_mac: z.object({
    memory_gb: z.number().nonnegative(),
    disk_free_gb: z.number().nonnegative(),
    capacity: z.number().int().nonnegative(),
    limit: z.object({ term: z.string(), fix: z.string() }).optional()
  }),
  github: z.object({
    owner: z.string().optional(),
    signed_in: z.boolean(),
    app_installed: z.boolean(),
    squash_allowed: z.boolean().optional()
  }),
  repository: z.object({ owner: z.string(), name: z.string() }).optional(),
  repositories: z.array(z.string()).optional(),
  models: z.array(ModelRoleSchema).refine(
    (models) => models.map((model) => model.role).join() === MODEL_ROLES.join(),
    { message: "Setup lists the fast, coding and jev roles once each, in order." }
  ),
  chatgpt: z.boolean()
})

/**
 * The value decoded by {@link SetupCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type SetupCard = z.infer<typeof SetupCardSchema>

/**
 * The Setup View's props (ui-components.md T-UI-02).
 * @since 1.0.0
 * @category models
 */
export type SetupViewProps = CardProps<SetupCard>

/**
 * Typed catalog callbacks for Setup.
 * @since 1.0.0
 * @category models
 */
export type SetupCardCallbacks = CardCallbacks<"settings" | "github" | "sign-in">
