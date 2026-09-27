/**
 * The featured flows a project declares, read from the `flows` rows of its
 * generated `.smithers/factory.json` and folded into the `ls` listing, and
 * the apps its generated `.smithers/home.json` declares (PRODUCT.md D-18: an
 * app is a featured flow with a picture), listed after the flows.
 *
 * The projection is what `//:factoryProjection` writes from the
 * `.smithers/FACTORY.ts` declarations over the discovered flows. `ls` never
 * evaluates `FACTORY.ts`; it reads the file when it is checked in and lists
 * the flows unchanged when it is not. An unreadable or malformed projection
 * is treated as absent here: `doctor` owns diagnostics, and a listing that
 * refused to print because a generated file drifted would hide the flows
 * behind the drift.
 *
 * @since 1.0.0
 */
import * as Factory from "@smthrs/targets/Factory"
import type * as FlowCatalog from "@smthrs/targets/FlowCatalog"
import * as Home from "@smthrs/targets/Home"
import { readFileSync } from "node:fs"
import { join } from "node:path"

/**
 * The catalog a projection carries: its `flows` rows.
 *
 * @category models
 * @since 1.0.0
 */
export interface Catalog {
  readonly flows: ReadonlyArray<FlowCatalog.Row>
}

/**
 * One app the homepage declares: the flow it opens, its title, its picture.
 *
 * @category models
 * @since 1.0.0
 */
export interface App {
  readonly flow: string
  readonly title: string
  readonly picture: string
}

/**
 * Reads the project's projected homepage apps, or none when the project has
 * no `.smithers/home.json` or it does not parse.
 *
 * @category constructors
 * @since 1.0.0
 */
export const apps = (projectRoot: string): ReadonlyArray<App> => {
  let text: string
  try {
    text = readFileSync(join(projectRoot, ".smithers", "home.json"), "utf8")
  } catch {
    return []
  }
  const parsed = Home.parse(text)
  if (typeof parsed === "string") return []
  return parsed.blocks.flatMap((block) =>
    block.type === "app" ? [{ flow: block.flow, title: block.title, picture: block.picture }] : []
  )
}

/**
 * One listed flow, with the presentation the catalog declares when it does.
 *
 * `featured` and `summary` are present only when the catalog says so, so a
 * project without a catalog lists exactly what it listed before.
 *
 * @category models
 * @since 1.0.0
 */
export interface Presented {
  readonly flowId: string
  readonly description: string
  readonly featured?: true
  readonly summary?: string
}

/**
 * Reads the project's projected catalog, or nothing when the project has
 * no `.smithers/factory.json`.
 *
 * @category constructors
 * @since 1.0.0
 */
export const read = (projectRoot: string): Catalog | undefined => {
  let text: string
  try {
    text = readFileSync(join(projectRoot, ...Factory.projectionPath.split("/")), "utf8")
  } catch {
    return undefined
  }
  const parsed = Factory.parseProjection(text)
  return typeof parsed === "string" ? undefined : { flows: parsed.flows }
}

/**
 * Folds the catalog's presentation into the listed flows: featured flows
 * first, in catalog order, each carrying `featured` and its summary; then
 * every other flow in listing order, with a summary where the catalog
 * declares one. A catalog row naming no listed flow contributes nothing.
 *
 * @category constructors
 * @since 1.0.0
 */
export const present = (
  items: ReadonlyArray<{ readonly flowId: string; readonly description: string }>,
  catalog: Catalog | undefined
): ReadonlyArray<Presented> => {
  if (catalog === undefined) return items
  const rows = new Map(catalog.flows.map((row) => [row.id, row] as const))
  const decorate = (item: { readonly flowId: string; readonly description: string }): Presented => {
    const row = rows.get(item.flowId)
    return {
      flowId: item.flowId,
      description: item.description,
      ...(row?.featured === true ? { featured: true as const } : {}),
      ...(row?.summary === undefined || row.summary === null ? {} : { summary: row.summary })
    }
  }
  const listed = new Map(items.map((item) => [item.flowId, item] as const))
  const featured = catalog.flows
    .filter((row) => row.featured && listed.has(row.id))
    .map((row) => decorate(listed.get(row.id)!))
  const featuredIds = new Set(featured.map((item) => item.flowId))
  return [...featured, ...items.filter((item) => !featuredIds.has(item.flowId)).map(decorate)]
}

/**
 * Whether a rendered value is a flow page this module can present.
 *
 * @category guards
 * @since 1.0.0
 */
export const isFlowPage = (
  value: unknown
): value is { readonly _tag: "flows"; readonly items: ReadonlyArray<Presented> } =>
  typeof value === "object" && value !== null && (value as { _tag?: unknown })._tag === "flows" &&
  Array.isArray((value as { items?: unknown }).items) &&
  (value as { items: ReadonlyArray<unknown> }).items.every((item) =>
    typeof item === "object" && item !== null &&
    typeof (item as { flowId?: unknown }).flowId === "string" &&
    typeof (item as { description?: unknown }).description === "string"
  )

/**
 * The apps a rendered listing carries, when it carries any.
 *
 * @category guards
 * @since 1.0.0
 */
export const appsOf = (value: unknown): ReadonlyArray<App> => {
  const apps = (value as { apps?: unknown }).apps
  return Array.isArray(apps)
    ? apps.flatMap((app) =>
      typeof app === "object" && app !== null && typeof (app as { flow?: unknown }).flow === "string" &&
        typeof (app as { title?: unknown }).title === "string"
        ? [{
          flow: (app as App).flow,
          title: (app as App).title,
          picture: typeof (app as { picture?: unknown }).picture === "string" ? (app as App).picture : ""
        }]
        : []
    )
    : []
}

/**
 * The human listing: one line per flow, a leading `*` on featured rows, the
 * id, then the declared summary or the flow's own description; then the
 * homepage's apps, one line each, when the project declares any.
 *
 * @category rendering
 * @since 1.0.0
 */
export const human = (items: ReadonlyArray<Presented>, apps: ReadonlyArray<App> = []): string => {
  const flows = items.length === 0 ? "No flows discovered under flows/.\n" : (() => {
    const width = Math.max(...items.map((item) => item.flowId.length))
    return items
      .map((item) =>
        `${item.featured === true ? "* " : "  "}${item.flowId.padEnd(width)}  ${item.summary ?? item.description}`
      )
      .join("\n") + "\n"
  })()
  if (apps.length === 0) return flows
  // The homepage's apps: one line per app, its title then the flow it opens.
  const width = Math.max(...apps.map((app) => app.title.length))
  return `${flows}apps:\n${apps.map((app) => `  ${app.title.padEnd(width)}  ${app.flow}`).join("\n")}\n`
}
