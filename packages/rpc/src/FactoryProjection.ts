/**
 * The factory projection: `.smithers/factory.json`, the committed JSON that
 * `//:factoryProjection` writes from `S.Factory({...})` in
 * `.smithers/FACTORY.ts` (Factory design session 2026-09-07 §4; spec 08 §1;
 * RULINGS 21, 23). The public mirror serves it through the contents route
 * that is already allowlisted for signed-out reads, so the Dispatcher card
 * renders the declared rules and the homepage lists the featured flows
 * before anyone signs in.
 *
 * Only the part the app reads is typed here. Field names are the
 * declaration's own: `summary`; `flows`, the flow catalog (one row per
 * discovered flow, featured rows first, each with the `summary` the factory
 * declares under `S.Flow`); `on`, the Dispatcher table; and `github`, the
 * policy pair of RULINGS 23. `on` is a record in the declaration (event key
 * to a flow id or a list of them); the projection flattens it to rows so
 * each row can carry the "Visible as" sentence of design §7 as
 * `description`. A row's `event` is a key of the event vocabulary (spec 08
 * §3): `issue.opened`, `issue.labeled:<label>`, `change.landed`,
 * `github.push:<branch>`, `schedule:<cron>`, `box.session.ended`,
 * `nomination`, `manual`. The declaring side is `@smthrs/targets`
 * `Factory.ts`; a real projection of this repository is pinned against
 * this module in `test/FactoryProjection.test.ts`.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/**
 * Where the projection lives in the repository tree.
 *
 * @since 1.0.0
 * @category constants
 */
export const FACTORY_PROJECTION_PATH = ".smithers/factory.json"

/**
 * One row of the Dispatcher table: the event, the flow or flows it starts,
 * and the sentence the card shows for it when the declaration names one.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FactoryRuleSchema = z.object({
  event: z.string().min(1),
  flow: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  description: z.string().optional()
})

/**
 * The decoded value accepted by {@link FactoryRuleSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type FactoryRule = z.infer<typeof FactoryRuleSchema>

/**
 * One row of the flow catalog: a discovered flow with the presentation the
 * factory declares. `summary` is the declared one-line summary or null;
 * `featured` is whether the repository recommends it first.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FactoryFlowSchema = z.object({
  id: z.string().min(1),
  description: z.string(),
  summary: z.string().nullable(),
  featured: z.boolean(),
  kind: z.enum(["ts", "mdx", "skill"]),
  path: z.string().min(1),
  capabilities: z.array(z.string()),
  model: z.string().nullable(),
  modelInvocable: z.boolean(),
  inputSchema: z.unknown().optional()
})

/**
 * The decoded value accepted by {@link FactoryFlowSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type FactoryFlow = z.infer<typeof FactoryFlowSchema>

/**
 * The GitHub policy pair (RULINGS 23): who writes `main` (`push` when
 * Smithers Cloud lands and pushes to GitHub, `pull` when GitHub writes it,
 * `none` without a remote), how issues take part, and what a Change does.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FactoryGithubSchema = z.object({
  mirror: z.enum(["push", "pull", "none"]),
  issues: z.enum(["read", "two-way", "none"]),
  changes: z.enum(["land", "send-upstream", "none"]),
  protectedPaths: z.array(z.string()).optional(),
  reviewerAgents: z.array(z.string()).optional()
})

/**
 * The projection the app reads. `summary`, `flows`, and `github` are
 * optional so a projection that carries only the Dispatcher table still
 * decodes.
 *
 * @since 1.0.0
 * @category schemas
 */
export const FactoryProjectionSchema = z.object({
  summary: z.string().optional(),
  flows: z.array(FactoryFlowSchema).optional(),
  on: z.array(FactoryRuleSchema),
  github: FactoryGithubSchema.optional()
})

/**
 * The decoded value accepted by {@link FactoryProjectionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type FactoryProjection = z.infer<typeof FactoryProjectionSchema>

/**
 * The flow ids one rule starts, in declaration order.
 *
 * @since 1.0.0
 * @category accessors
 */
export const ruleFlows = (rule: FactoryRule): ReadonlyArray<string> =>
  typeof rule.flow === "string" ? [rule.flow] : rule.flow

/**
 * The featured rows of a projection, in catalog order: the id and the
 * declared summary a listing shows under it.
 *
 * @since 1.0.0
 * @category accessors
 */
export const featuredFlows = (
  projection: FactoryProjection
): ReadonlyArray<{ readonly id: string; readonly summary: string | null }> =>
  (projection.flows ?? []).filter((flow) => flow.featured).map((flow) => ({ id: flow.id, summary: flow.summary }))
