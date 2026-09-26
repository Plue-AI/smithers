/**
 * The flow catalog: discovered flows joined with their declarations.
 *
 * A repository's flows are discovered from `flows/` by the registry, and how
 * the repository presents them is declared in `.smithers/FACTORY.ts` with
 * {@link Flow.Flow} under the factory's `flows` key. Neither side alone is a
 * listing a reader can trust without running discovery: the Worker that
 * serves smithers.sh reads the public mirror and imports nothing, and a
 * workspace without `node_modules` cannot evaluate `FACTORY.ts`. The
 * `FactoryProjection` target (`Factory.ts`) projects both into the `flows`
 * rows of the checked-in `.smithers/factory.json`.
 *
 * This module is the pure half: the shape of a catalog row and the rules
 * that order the rows, testable without a filesystem. The discovery runs in
 * the executor, which hands {@link rows} the discovered flows.
 *
 * @since 1.0.0
 */
import * as Schema from "effect/Schema"
import type * as Flow from "./Flow.ts"

/**
 * The entry file a flow was discovered from: a `flow.ts` module, a
 * `flow.mdx` prompt, or a foreign `SKILL.md`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Kind = Schema.Literals(["ts", "mdx", "skill"])

/**
 * The entry file a flow was discovered from.
 *
 * @category models
 * @since 1.0.0
 */
export type Kind = typeof Kind.Type

/**
 * One flow as discovery reports it, reduced to what the catalog carries.
 *
 * `path` is workspace-relative and POSIX, so the same file renders the same
 * row on every host.
 *
 * @category schemas
 * @since 1.0.0
 */
export const DiscoveredFlow = Schema.Struct({
  id: Schema.NonEmptyString,
  description: Schema.String,
  kind: Kind,
  path: Schema.NonEmptyString,
  capabilities: Schema.Array(Schema.String),
  model: Schema.NullOr(Schema.Union([Schema.String, Schema.NonEmptyArray(Schema.String)])),
  modelInvocable: Schema.Boolean,
  inputSchema: Schema.optional(Schema.Json),
  flows: Schema.optional(Schema.Array(Schema.String)),
  budget: Schema.optional(Schema.Json)
})

/**
 * One flow as discovery reports it.
 *
 * @category models
 * @since 1.0.0
 */
export type DiscoveredFlow = typeof DiscoveredFlow.Type

/**
 * One catalog row: the discovered flow joined with its declaration.
 *
 * `summary` is `null` and `featured` is `false` for a flow no declaration
 * names, so a consumer reads every row the same way.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Row = Schema.Struct({
  id: Schema.NonEmptyString,
  description: Schema.String,
  summary: Schema.NullOr(Schema.String),
  featured: Schema.Boolean,
  kind: Kind,
  path: Schema.NonEmptyString,
  capabilities: Schema.Array(Schema.String),
  model: DiscoveredFlow.fields.model,
  modelInvocable: Schema.Boolean,
  inputSchema: Schema.optional(Schema.Json),
  flows: Schema.optional(Schema.Array(Schema.String)),
  budget: Schema.optional(Schema.Json)
})

/**
 * One catalog row.
 *
 * @category models
 * @since 1.0.0
 */
export type Row = typeof Row.Type

/**
 * The catalog could not be joined: a declaration names no discovered flow,
 * two declarations name one flow, or the flows directory could not be read.
 *
 * @category errors
 * @since 1.0.0
 */
export class FlowCatalogError extends Schema.TaggedError<FlowCatalogError>()(
  "smithers-build/FlowCatalogError",
  {
    message: Schema.NonEmptyString
  }
) {}

/**
 * Joins the discovered flows with the declarations into catalog rows.
 *
 * Rows are ordered featured first, in declaration order; then the remaining
 * declared flows, in declaration order; then every other discovered flow by
 * id. A declaration that names no discovered flow, or a flow two declarations
 * name, is a failure carrying the id: a recommendation for a flow that does
 * not exist must never be written.
 *
 * @category constructors
 * @since 1.0.0
 */
export const rows = (
  discovered: ReadonlyArray<DiscoveredFlow>,
  declarations: ReadonlyArray<Flow.Declaration>
): ReadonlyArray<Row> => {
  const byId = new Map<string, DiscoveredFlow>()
  for (const flow of discovered) {
    if (byId.has(flow.id)) {
      throw new FlowCatalogError({ message: `discovery reported the flow ${JSON.stringify(flow.id)} twice` })
    }
    byId.set(flow.id, flow)
  }
  const declared = new Map<string, Flow.Declaration>()
  const unknown: Array<string> = []
  for (const declaration of declarations) {
    if (declared.has(declaration.flow)) {
      throw new FlowCatalogError({
        message: `FACTORY.ts declares the flow ${JSON.stringify(declaration.flow)} twice`
      })
    }
    declared.set(declaration.flow, declaration)
    if (!byId.has(declaration.flow)) unknown.push(declaration.flow)
  }
  if (unknown.length > 0) {
    throw new FlowCatalogError({
      message: `FACTORY.ts declares ${unknown.length === 1 ? "a flow" : "flows"} discovery did not find: ${
        unknown.map((id) => JSON.stringify(id)).join(", ")
      }`
    })
  }
  const row = (flow: DiscoveredFlow, declaration: Flow.Declaration | undefined): Row => ({
    id: flow.id,
    description: flow.description,
    summary: declaration?.summary ?? null,
    featured: declaration?.featured ?? false,
    kind: flow.kind,
    path: flow.path,
    capabilities: flow.capabilities,
    model: flow.model,
    modelInvocable: flow.modelInvocable,
    ...(flow.flows === undefined ? {} : { flows: flow.flows }),
    ...(flow.budget === undefined ? {} : { budget: flow.budget }),
    ...(flow.inputSchema === undefined ? {} : { inputSchema: flow.inputSchema })
  })
  const featured: Array<Row> = []
  const declaredOnly: Array<Row> = []
  for (const declaration of declared.values()) {
    const built = row(byId.get(declaration.flow)!, declaration)
    if (declaration.featured) featured.push(built)
    else declaredOnly.push(built)
  }
  const rest = [...byId.values()]
    .filter((flow) => !declared.has(flow.id))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
    .map((flow) => row(flow, undefined))
  return [...featured, ...declaredOnly, ...rest]
}
