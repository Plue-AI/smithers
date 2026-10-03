/**
 * Setup data contract shared by the View and its Container.
 * @since 1.0.0
 */

import { z } from "zod"
import type { CardCallbacks } from "./CardAction.ts"
import { StepStateSchema } from "./CardPrimitives.ts"
import { HttpUrlSchema } from "./WebUrl.ts"

const ModelAccessSchema = z.object({
  state: z.enum(["missing", "validating", "saved", "failed"]),
  provider: z.string(),
  error: z.string().optional()
})

/**
 * Setup projection fields from spec §14.3 and ui-components.md.
 * @since 1.0.0
 * @category schemas
 */
export const SetupCardSchema = z.object({
  address: z.object({
    listen: z.enum(["mac", "network"]),
    addresses: z.array(HttpUrlSchema),
    change_failed: z.object({ from: z.string(), to: z.string(), reason: z.string() }).optional()
  }),
  steps: z.array(
    z.object({
      id: z.enum(["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"]),
      state: StepStateSchema,
      error: z.object({ code: z.string(), message: z.string(), fix: z.string().optional() }).optional()
    })
  ),
  this_mac: z.object({
    memory_gb: z.number().nonnegative(),
    machines: z.number().int().nonnegative(),
    max_machines: z.number().int().nonnegative()
  }),
  github: z.object({
    owner: z.string(),
    signed_in: z.boolean(),
    app_installed: z.boolean(),
    squash_allowed: z.boolean()
  }),
  repository: z.object({ owner: z.string(), name: z.string() }).optional(),
  repositories: z.array(z.object({ owner: z.string(), name: z.string() })),
  models: z.object({ fast: ModelAccessSchema, coding: ModelAccessSchema, jev: ModelAccessSchema }),
  source: z.object({ state: StepStateSchema, pct: z.number().min(0).max(100) }),
  machine: z.object({
    state: StepStateSchema,
    pct: z.number().min(0).max(100),
    minutes_left: z.number().nonnegative().optional()
  })
})

/**
 * The value decoded by {@link SetupCardSchema}.
 * @since 1.0.0
 * @category models
 */
export type SetupCard = z.infer<typeof SetupCardSchema>

/**
 * Typed catalog callbacks for Setup.
 * @since 1.0.0
 * @category models
 */
export type SetupCardCallbacks = CardCallbacks<"settings" | "github" | "sign-in">
