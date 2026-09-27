/**
 * The billing contract the account and upgrade doors read: what a sandbox plan
 * entitles, what each purchasable plan costs and caps, and what the account is
 * using right now. Wire field names are snake_case because the billing service
 * owns them; the app never rewrites them on the way through.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/**
 * What one account's sandbox plan entitles and how much of it is spent. The
 * usage fields are observations, never a grant: the server decides admission.
 *
 * @since 1.0.0
 * @category schemas
 */
export const SandboxEntitlementSchema = z.object({
  concurrentSandboxes: z.number().int(),
  concurrentInUse: z.number().int().nonnegative(),
  idleTimeoutSecs: z.number().int().nonnegative(),
  hoursPerDay: z.number().int(),
  secondsUsedToday: z.number().nonnegative(),
  dayResetsAt: z.string()
})
/**
 * One purchasable plan as the billing service states it: its key, its price, and
 * the caps it carries. `checkout_available` is false when the plan exists but
 * this account cannot buy it here.
 *
 * @since 1.0.0
 * @category schemas
 */
export const BillingPlanSchema = z.object({
  key: z.enum(["free", "pro", "max"]),
  display_name: z.string(),
  price_cents: z.number().int().nonnegative(),
  interval: z.string(),
  limits: z.object({
    concurrent_sandboxes: z.number().int(),
    idle_timeout_secs: z.number().int().nonnegative(),
    hours_per_day: z.number().int(),
    private_repos: z.number(),
    storage_bytes: z.number(),
    ci_minutes: z.number(),
    agent_runs: z.number(),
    seats: z.number(),
    /** Model credit the plan grants each billing month, integer cents. */
    monthly_credit_cents: z.number().int().nonnegative().optional()
  }),
  checkout_available: z.boolean()
})
/**
 * The plan list a `billing.plans` answer carries, with the key of the plan the
 * account is on so the upgrade door can mark it.
 *
 * @since 1.0.0
 * @category schemas
 */
export const BillingPlansResponseSchema = z.object({
  plans: z.array(BillingPlanSchema),
  current_plan_key: z.string()
})
/**
 * The account's current sandbox standing: its plan key, its caps, and today's
 * spend against them.
 *
 * @since 1.0.0
 * @category schemas
 */
export const BillingOverviewSchema = z.object({
  sandbox: z.object({
    plan_key: z.string(),
    concurrent_sandboxes: z.number().int(),
    concurrent_in_use: z.number().int().nonnegative(),
    idle_timeout_secs: z.number().int().nonnegative(),
    hours_per_day: z.number().int(),
    seconds_used_today: z.number().nonnegative(),
    day_resets_at: z.string()
  }),
  /** When the current usage month ends and the next monthly credit grant lands. */
  usage_period_end: z.string().optional()
})
