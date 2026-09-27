/**
 * The browser-safe half of the authoring surface.
 *
 * Everything here is a type or a plain data constructor, so `routes.gen.ts`
 * can pull it into a Worker or a browser bundle. The Node half lives in
 * {@link module:package}, which imports `@smthrs/targets`.
 *
 * The authoring model has four kinds of file and one rule:
 *
 * - `AGENT.ts`, `SANDBOX.ts`, `TOOLS.ts` are layer files. They export `Agent`,
 *   `Sandbox`, and `Tools` built by {@link defineAgent}, {@link defineSandbox},
 *   and {@link defineTools}.
 * - `flows/<id>/flow.ts` exports `Flow` built by {@link defineFlow}. A flow
 *   never names a model; its seat comes from the resolved `AGENT.ts`.
 * - `app/**\/page.tsx` and `app/panes/<name>.tsx` are the UI, resolved by
 *   `@smthrs/create-app/router`.
 * - The rule: file location alone names the thing, and each layer kind
 *   resolves to its nearest ancestor. Nothing merges.
 *
 * @since 0.1.0
 */

import type * as Capability from "@smthrs/capability/Capability"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import type * as Schema from "effect/Schema"

/**
 * Font stacks a brand may declare.
 *
 * `googleFonts` entries are Google Fonts `family=` specifications, for example
 * `"Geist:wght@400;500"`. Each becomes an `@import` ahead of the brand rule.
 *
 * @category models
 * @since 0.1.0
 */
export interface BrandFonts {
  readonly display?: string
  readonly body?: string
  readonly mono?: string
  readonly wordmark?: string
  readonly googleFonts?: ReadonlyArray<string>
}

/**
 * The house tokens a brand may override.
 *
 * A token the brand does not list keeps the styleguide default, so a brand is
 * a patch rather than a theme. `@smthrs/create-app/vite` maps each one onto
 * the CSS custom properties `@smthrs/ui` reads.
 *
 * @category models
 * @since 0.1.0
 */
export type BrandToken =
  | "primary"
  | "primaryHover"
  | "primaryActive"
  | "primarySubtle"
  | "accent"
  | "accentForeground"
  | "accentSubtle"
  | "accentRing"
  | "secondary"
  | "secondarySubtle"
  | "success"
  | "successSubtle"
  | "warning"
  | "danger"
  | "info"
  | "background"
  | "surface"
  | "surfaceRaised"
  | "border"
  | "borderStrong"
  | "foreground"
  | "foregroundMuted"
  | "foregroundSubtle"
  | "radiusSm"
  | "radiusMd"
  | "radiusLg"
  | "radiusXl"
  | "radiusComposer"
  | "radiusPill"
  | "shadowSm"
  | "shadowMd"
  | "shadowLg"

/**
 * An app's identity: its name, its fonts, and the house tokens it overrides.
 *
 * @category models
 * @since 0.1.0
 */
export interface Brand {
  readonly name: string
  readonly wordmark?: string
  readonly theme?: "light" | "dark" | "system"
  readonly fonts?: BrandFonts
  readonly tokens: Partial<Record<BrandToken, string>>
}

/**
 * One sidebar entry.
 *
 * `href` is an app route, so `/operate/logs` requires
 * `<app>/operate/logs/page.tsx`; the root href `/` is `<app>/page.tsx`.
 * `icon` is a lucide icon name the shell resolves.
 *
 * @category models
 * @since 0.1.0
 */
export interface NavItem {
  readonly label: string
  readonly href: string
  readonly icon?: string
}

/**
 * A labelled group of sidebar entries.
 *
 * @category models
 * @since 0.1.0
 */
export interface NavGroup {
  readonly label: string
  readonly items: ReadonlyArray<NavItem>
}

/**
 * The seat and teaching every flow under an `AGENT.ts` runs with.
 *
 * `seat` is a `<provider>:<model>` string the host's `SeatResolver` turns into
 * a live model, which is why no flow file names a model.
 *
 * @category models
 * @since 0.1.0
 */
export interface AgentSpec {
  readonly _tag: "AgentSpec"
  readonly seat: string
  readonly system: ReadonlyArray<string>
  /** Maximum host calls one cell may make. Defaults to {@link defaultCallLimit}. */
  readonly limits?: { readonly calls?: number }
  /** Maximum agent frames per run. Defaults to {@link defaultMaxFrames}. */
  readonly maxFrames?: number
}

/**
 * Declares the `Agent` export of an `AGENT.ts` layer file.
 *
 * @example
 * ```ts
 * import { defineAgent } from "@smthrs/create-app/app"
 *
 * export const Agent = defineAgent({
 *   seat: "anthropic:claude-sonnet-4-5",
 *   system: ["You answer questions about the ledger."],
 *   limits: { calls: 32 }
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const defineAgent = (options: Omit<AgentSpec, "_tag">): AgentSpec => ({ _tag: "AgentSpec", ...options })

/**
 * The sandbox budget every cell of every flow under a `SANDBOX.ts` runs under.
 *
 * `@smthrs/harness/Sandbox`'s `Limits` has six fields: `calls`, `memoryBytes`,
 * `steps`, `timeMs`, `totalMs`, and `callMs`. Four are reachable from an app.
 * Three are named here: `heapBytes` is `memoryBytes`, `interruptChecks` is
 * `steps`, and `wallClockMs` is `totalMs`, the whole-evaluation backstop with
 * host calls included. `calls` is declared on the agent layer instead, because
 * how many tools a step may reach for is a property of the agent.
 *
 * `timeMs` (per-cell compute) and `callMs` (per-call wall clock) stay
 * host-owned and have no author-facing name: they bound one QuickJS evaluation
 * and one host call rather than the app's policy, and a host that embeds this
 * runtime sets them from its own request deadline.
 *
 * Every limit is optional and an omitted one is not zero: the harness fills it
 * from `Sandbox.defaultLimits`, which at rc.0 is 64 calls, 128 MiB, 1000
 * steps, 30 s `timeMs`, 900 s `totalMs`, and 120 s `callMs`. So
 * `defineSandbox({ limits: {} })` accepts every default rather than declaring
 * no budget.
 *
 * @category models
 * @since 0.1.0
 */
export interface SandboxSpec {
  readonly _tag: "SandboxSpec"
  readonly limits: {
    readonly heapBytes?: number
    readonly interruptChecks?: number
    readonly wallClockMs?: number
  }
}

/**
 * Declares the `Sandbox` export of a `SANDBOX.ts` layer file.
 *
 * @example
 * ```ts
 * import { defineSandbox } from "@smthrs/create-app/app"
 *
 * export const Sandbox = defineSandbox({
 *   limits: { heapBytes: 128 * 1024 * 1024, wallClockMs: 30_000 }
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const defineSandbox = (options: Omit<SandboxSpec, "_tag">): SandboxSpec => ({ _tag: "SandboxSpec", ...options })

/**
 * The flow-binding sources every flow under a `TOOLS.ts` reaches as
 * `ctx.call("<source>/<flow>", input)`.
 *
 * @category models
 * @since 0.1.0
 */
export interface ToolsSpec {
  readonly _tag: "ToolsSpec"
  readonly sources: ReadonlyArray<FlowBinding.Source>
  /**
   * The capability envelope every cell of every flow runs under.
   *
   * The default is the empty envelope: the harness refuses every call that
   * declares a capability, `tevm/*` included, until `TOOLS.ts` grants it.
   * Grant the patterns the bound tools declare. The all-action grant
   * `[{ action: "*", resource: "*" }]` is an opt-in for trusted local use.
   *
   * The field is required here and defaulted by {@link defineTools}: a spec
   * built by hand — which the aomi Worker does when it re-binds a routed
   * table's sources — must state its envelope rather than inherit one
   * silently.
   */
  readonly grant: ReadonlyArray<ToolsGrant>
}

/**
 * One capability pattern of a {@link ToolsSpec} grant.
 *
 * `action` is `@smthrs/capability`'s closed `PatternAction` union rather than a
 * string, so an action the kernel does not know is a compile error in the
 * `TOOLS.ts` that declares it. It used to be `string`, and an unknown action
 * type-checked and then failed inside `layerFor` with an anonymous schema
 * message naming neither the grant nor the field. `resource` stays a string
 * because its only constraint is a length bound `@smthrs/create-app/runtime`
 * checks when it builds the envelope.
 *
 * @category models
 * @since 0.1.0
 */
export interface ToolsGrant {
  readonly action: Capability.PatternAction
  readonly resource: string
}

/**
 * Declares the `Tools` export of a `TOOLS.ts` layer file.
 *
 * @example
 * ```ts
 * import { defineTools } from "@smthrs/create-app/app"
 * import { ledger } from "./tools/ledger.ts"
 *
 * export const Tools = defineTools({ sources: [ledger] })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const defineTools = (
  options: Omit<ToolsSpec, "_tag" | "grant"> & { readonly grant?: ReadonlyArray<ToolsGrant> }
): ToolsSpec => ({
  _tag: "ToolsSpec",
  sources: options.sources,
  grant: options.grant ?? []
})

/**
 * One flow: a payload, an output schema, and the prompt that opens the run.
 *
 * A flow declares no seat and no system prompt of its own beyond `system`,
 * which is appended after the resolved `AGENT.ts` teaching.
 *
 * `chat` is routing metadata and nothing else: it decides which endpoint a
 * host offers the flow on. A host reports it on its flow listing and sends a
 * `chat: true` flow to its turn endpoint rather than its flow-run endpoint;
 * the aomi template's Worker refuses a chat flow on `POST /api/flows/run` for
 * exactly that reason. Nothing in `@smthrs/create-app/runtime` reads it, and
 * no execution in this package carries a conversation across turns: each turn
 * opens its own execution from its own payload. A host that wants continuity
 * owns the history it replays into the next turn's payload.
 *
 * @category models
 * @since 0.1.0
 */
export interface FlowSpec<P extends Schema.Struct.Fields, O extends Schema.Top> {
  readonly _tag: "FlowSpec"
  readonly description: string
  readonly payload: P
  readonly output: O
  readonly prompt: (payload: Schema.Struct.Type<P>) => string
  readonly system?: ReadonlyArray<string>
  readonly chat?: boolean
}

/**
 * Declares the `Flow` export of a `flows/<id>/flow.ts` file.
 *
 * @example
 * ```ts
 * import { defineFlow } from "@smthrs/create-app/app"
 * import * as Schema from "effect/Schema"
 *
 * export const Flow = defineFlow({
 *   description: "Answers a question about the ledger.",
 *   payload: { message: Schema.String },
 *   output: Schema.Struct({ answer: Schema.String }),
 *   prompt: ({ message }) => message,
 *   chat: true
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const defineFlow = <P extends Schema.Struct.Fields, O extends Schema.Top>(
  options: Omit<FlowSpec<P, O>, "_tag">
): FlowSpec<P, O> => ({ _tag: "FlowSpec", ...options })

/**
 * A {@link FlowSpec} with its payload type erased, which is what a route table
 * holds once the router has stopped knowing each flow's fields.
 *
 * `prompt` takes `never` rather than the erased payload: a heterogeneous table
 * cannot hand back a typed prompt builder, and `prompt` is contravariant in its
 * payload, so any other erasure would refuse every concrete flow.
 *
 * @category models
 * @since 0.1.0
 */
export interface AnyFlowSpec {
  readonly _tag: "FlowSpec"
  readonly description: string
  readonly payload: Schema.Struct.Fields
  readonly output: Schema.Top
  readonly prompt: (payload: never) => string
  readonly system?: ReadonlyArray<string>
  readonly chat?: boolean
}

/**
 * One routed page: the URL path and the file that renders it.
 *
 * @category models
 * @since 0.1.0
 */
export interface PageRoute {
  readonly route: string
  readonly file: string
}

/**
 * One routed pane: the name the agent renders it by and the file that owns it.
 *
 * @category models
 * @since 0.1.0
 */
export interface PaneRoute {
  readonly name: string
  readonly file: string
}

/**
 * One routed flow with its three resolved layer files, app-root relative.
 *
 * @category models
 * @since 0.1.0
 */
export interface FlowRoute {
  readonly id: string
  readonly file: string
  readonly agent: string
  readonly sandbox: string
  readonly tools: string
}

/**
 * Everything the router found: the shell layout, the pages, the panes, and the
 * flows with their layers resolved.
 *
 * @category models
 * @since 0.1.0
 */
export interface AppRoutes {
  readonly layout: string | undefined
  readonly pages: ReadonlyArray<PageRoute>
  readonly panes: ReadonlyArray<PaneRoute>
  readonly flows: ReadonlyArray<FlowRoute>
}

/**
 * The three source directories an app is routed from.
 *
 * @category models
 * @since 0.1.0
 */
export interface AppDirs {
  readonly app: string
  readonly flows: string
  readonly tools: string
}

/**
 * The directory layout an app gets when it declares none.
 *
 * @category models
 * @since 0.1.0
 */
export const defaultDirs: AppDirs = { app: "app", flows: "flows", tools: "tools" }

const SEGMENT = /^[a-z][a-z0-9-]*$/

/**
 * Whether `value` may be one segment of a route: a flow directory, a page
 * directory, or a pane file's base name.
 *
 * Lowercase letters, digits and hyphens, starting with a letter. A route
 * segment reaches both a generated import specifier and a URL path, so the
 * grammar is what keeps the two unambiguous, and
 * `@smthrs/create-app/router` refuses a tree that breaks it.
 *
 * It sits here, in the browser-safe half, rather than in the router, because
 * anything that predicts what the router will accept has to ask for the rule
 * and most of those callers cannot import a filesystem walk:
 * `template/aomi/tools/promote.ts` runs inside a Worker and refuses a flow id
 * the router would refuse, before writing `flows/<id>/flow.ts` for it. It kept
 * its own copy of this expression to do that. Two spellings of one grammar
 * drift, and the one that drifts is never the router's.
 *
 * @example
 * ```ts
 * import { isRouteSegment } from "@smthrs/create-app/app"
 *
 * isRouteSegment("build-plan") // true
 * isRouteSegment("Build")      // false
 * ```
 *
 * @category predicates
 * @since 0.1.0
 */
export const isRouteSegment = (value: string): boolean => SEGMENT.test(value)

/**
 * {@link isRouteSegment}'s grammar as text, for a refusal that states the rule.
 *
 * A string rather than the `RegExp` itself: a caller cannot reassign its
 * `lastIndex` or otherwise reach the predicate through it.
 *
 * @category models
 * @since 0.1.0
 */
export const routeSegmentGrammar: string = String(SEGMENT)

/**
 * How many host calls one cell may make when the agent layer declares no
 * limit.
 *
 * @category models
 * @since 0.1.0
 */
export const defaultCallLimit = 16

/**
 * How many agent frames one run may take when the agent layer declares none.
 *
 * @category models
 * @since 0.1.0
 */
export const defaultMaxFrames = 8

/**
 * Where an app deploys on Cloudflare.
 *
 * `domain` is bound by wrangler's `routes[].custom_domain`, so the DNS record
 * and the certificate are created on the first deploy.
 *
 * @category models
 * @since 0.1.0
 */
export interface CloudflareDeploy {
  readonly workerName: string
  readonly domain: string
  /** wrangler config path relative to the app root. Default `worker/wrangler.jsonc`. */
  readonly config?: string
}

/**
 * The serializable half of an app: what the Vite plugin serves and the shell
 * reads from `virtual:smthrs-app/manifest`.
 *
 * @category models
 * @since 0.1.0
 */
export interface AppManifest {
  readonly name: string
  readonly brand: Brand
  readonly nav: ReadonlyArray<NavGroup>
  readonly dirs: AppDirs
  readonly deploy: { readonly cloudflare: Required<CloudflareDeploy> }
}
