/*
 * The plugin seam: the ONE way this app is customized.
 *
 * The model is TypeScript's own language-service plugin, restated in Effect.
 * A `tsserver` plugin is handed the language service every plugin before it
 * left behind and returns the service the next plugin will see; load order is
 * therefore meaningful, a plugin can read (and wrap) what an earlier plugin
 * contributed, and nothing can reach past the object it was given. Here the
 * decorated thing is the app itself — `AppSurface`, the record of everything
 * a plugin may add to the workspace — and activation is an `Effect`, so a
 * plugin can fail with a typed reason and can ask the host for services
 * through the environment instead of importing the app.
 *
 * What a plugin may add is deliberately narrow. Every rail entry names a
 * REGISTERED flow (the three-doors law: a button is a flow, a slash command
 * is that same flow, the agent's door is that same flow), so a plugin cannot
 * invent an affordance the registry has never heard of. Metadata stays on the
 * manifest; the behaviour is flows that already exist.
 */
import { Context, Data, Effect } from "effect"

/** The lucide glyph for a plugin and its UI contributions. */
export type PluginIcon =
  | "book-open"
  | "history"
  | "library"
  | "radio-tower"
  | "key-round"
  | "box"
  | "factory"
  | "compass"
  | "puzzle"

/** Portable plugin metadata, independent of a discovery storefront. */
export interface PluginManifest {
  /** Stable installation id and store key. */
  readonly id: string
  readonly name: string
  /** Who publishes it. First-party plugins say "Smithers". */
  readonly publisher: string
  readonly version: string
  /** Short summary. */
  readonly summary: string
  /** Description. */
  readonly description: string
  readonly icon: PluginIcon
  readonly tags: ReadonlyArray<string>
  /**
   * The recommended shelf's rank (1 first). Absent means the plugin is listed
   * but not recommended: the shelf is an ordering the catalog states, never a
   * popularity number this app cannot measure.
   */
  readonly recommended?: number
  /** Plugin ids that must already be loaded; activation fails otherwise. */
  readonly dependsOn?: ReadonlyArray<string>
  /** What a person does first once it is installed. Shown in the detail pane. */
  readonly gettingStarted: ReadonlyArray<string>
}

/** One entry a plugin adds to the workspace rail; `flow` is a registered flow. */
export interface RailEntry {
  readonly flow: string
  readonly label: string
  readonly icon: PluginIcon
}

/**
 * The app as the loaded plugins have left it. This is the value each plugin
 * decorates: it arrives as `ctx.app` and a plugin returns the next one.
 */
export interface AppSurface {
  /** Manifests in load order. The loader appends; a plugin cannot forge it. */
  readonly loaded: ReadonlyArray<PluginManifest>
  /** The workspace rail, in the order it renders. */
  readonly rail: ReadonlyArray<RailEntry>
  /** Flow names the loaded plugins own, for "what it adds" and featured flows. */
  readonly flows: ReadonlyArray<string>
}

/** The empty app: no plugin loaded, no rail, no flows. */
export const emptySurface: AppSurface = { loaded: [], rail: [], flows: [] }

/**
 * What the host lends a plugin during activation: which flows this runtime
 * actually registered. A plugin contributes a rail entry only for a flow that
 * exists here, which is why activation is an Effect and not a constant.
 */
export class PluginHost extends Context.Service<PluginHost, {
  readonly hasFlow: (name: string) => boolean
}>()("smithers/PluginHost") {}

/** A plugin named a dependency that is not loaded before it. */
export class MissingDependency extends Data.TaggedError("MissingDependency")<{
  readonly plugin: string
  readonly requires: string
}> {}

/** Two plugins claim the same id, so the second would silently shadow the first. */
export class DuplicatePlugin extends Data.TaggedError("DuplicatePlugin")<{
  readonly plugin: string
}> {}

/** A plugin's rail entry names a flow this runtime has never registered. */
export class UnknownFlow extends Data.TaggedError("UnknownFlow")<{
  readonly plugin: string
  readonly flow: string
}> {}

export type PluginError = MissingDependency | DuplicatePlugin | UnknownFlow

/** What a plugin is handed: itself, and the app the plugins before it built. */
export interface PluginContext {
  readonly self: PluginManifest
  /** Every plugin loaded before this one, in load order. */
  readonly loaded: ReadonlyArray<PluginManifest>
  /** The app as those plugins left it. Decorate this and return it. */
  readonly app: AppSurface
}

/**
 * A plugin: its catalog entry and its activation.
 *
 * `activate` receives the accumulated app and returns the app the NEXT plugin
 * will receive. Appending is the common case (`contribute` below); wrapping,
 * reordering or replacing what an earlier plugin added is the same return.
 */
export interface AppPlugin {
  readonly manifest: PluginManifest
  readonly activate: (ctx: PluginContext) => Effect.Effect<AppSurface, PluginError, PluginHost>
}

/**
 * The append helper every first-party plugin uses: add rail entries and the
 * flows they run to the app you were given, keeping everything already there.
 * Entries whose flow this runtime never registered are refused, not dropped
 * silently, so a plugin that promises a button the host cannot honour fails
 * where a person can read the reason.
 */
export const contribute = (
  ctx: PluginContext,
  addition: { readonly rail?: ReadonlyArray<RailEntry>; readonly flows?: ReadonlyArray<string> }
): Effect.Effect<AppSurface, UnknownFlow, PluginHost> =>
  Effect.flatMap(PluginHost, (host) => {
    const rail = addition.rail ?? []
    const missing = rail.find((entry) => !host.hasFlow(entry.flow))
    if (missing !== undefined) {
      return Effect.fail(new UnknownFlow({ plugin: ctx.self.id, flow: missing.flow }))
    }
    return Effect.succeed({
      loaded: ctx.app.loaded,
      rail: [...ctx.app.rail, ...rail],
      flows: [...ctx.app.flows, ...(addition.flows ?? rail.map((entry) => entry.flow))]
    })
  })

/**
 * The rail entries this runtime can honour, for a plugin that offers more than
 * one host provides: the Librarian's Wiki entry exists wherever the `wiki`
 * flow registered, and the entry is simply absent where it did not. A plugin
 * that names a flow NOTHING registers is a typo, and `contribute` refuses it.
 */
export const availableRail = (
  entries: ReadonlyArray<RailEntry>
): Effect.Effect<ReadonlyArray<RailEntry>, never, PluginHost> =>
  Effect.map(PluginHost, (host) => entries.filter((entry) => host.hasFlow(entry.flow)))

/**
 * Load plugins in order, each decorating what the ones before it produced.
 *
 * The fold is sequential on purpose: "the plugins before this one" is the
 * whole contract, and a parallel load would make `ctx.app` depend on timing.
 */
export const load = (
  plugins: ReadonlyArray<AppPlugin>,
  base: AppSurface = emptySurface
): Effect.Effect<AppSurface, PluginError, PluginHost> =>
  Effect.reduce(plugins, () => base, (app, plugin) => {
    const self = plugin.manifest
    if (app.loaded.some((loaded) => loaded.id === self.id)) {
      return Effect.fail(new DuplicatePlugin({ plugin: self.id }))
    }
    const missing = (self.dependsOn ?? []).find(
      (required) => !app.loaded.some((loaded) => loaded.id === required)
    )
    if (missing !== undefined) {
      return Effect.fail(new MissingDependency({ plugin: self.id, requires: missing }))
    }
    return Effect.map(
      plugin.activate({ self, loaded: app.loaded, app }),
      /* The load record is the loader's, never the plugin's: it appends here. */
      (next) => ({ ...next, loaded: [...app.loaded, self] })
    )
  })
