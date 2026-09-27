/*
 * The first-party plugin catalog: the shelf `/plugins` browses.
 *
 * A catalog entry is an `AppPlugin` — the manifest a person reads plus the
 * activation that decorates the app. Every flow named here is a flow this app
 * already registers (catalog.test.ts pins that against the registry), so
 * installing a plugin never promises an affordance the runtime cannot honour:
 * it collects flows that already exist into a named, installable capability
 * and puts its entries on the workspace rail.
 *
 * Order is the shelf order: `recommended` states the rank the gallery leads
 * with. It is a stated recommendation, never a popularity number this app has
 * no way to measure.
 */
import { Effect } from "effect"
import { availableRail, contribute } from "./AppPlugin"
import type { AppPlugin, PluginManifest } from "./AppPlugin"

/** The Librarian: the Wiki and the mythical history, the first thing to add. */
const librarian: AppPlugin = {
  manifest: {
    id: "librarian",
    name: "Librarian",
    publisher: "Smithers",
    version: "1.0.0",
    summary: "Reads your codebase and keeps a Wiki you can both cite.",
    description:
      "The Librarian learns a repository in the background and writes what it learns into the Wiki: pages, links and a graph you and Smithers read from the same place. It also tells the mythical history — the order the code would have been written in if it had been written once, foundations first.",
    icon: "book-open",
    tags: ["knowledge", "wiki", "background"],
    recommended: 1,
    gettingStarted: [
      "Open the Wiki to see what Smithers understands so far.",
      "Ask it to build the wiki and the mythical history for a connected repository.",
      "Cite a page in the conversation: Smithers answers with the page, never a summary of it."
    ]
  },
  activate: (ctx) =>
    Effect.flatMap(
      availableRail([
        { flow: "wiki", label: "Wiki", icon: "book-open" },
        { flow: "history.show", label: "Mythical history", icon: "history" }
      ]),
      (rail) => contribute(ctx, { rail, flows: ["wiki", "wiki.graph", "wiki.create", "history.show", "history.bootstrap"] })
    )
}

/** The Dispatcher: what starts work when something happens. */
const dispatcher: AppPlugin = {
  manifest: {
    id: "dispatcher",
    name: "Dispatcher",
    publisher: "Smithers",
    version: "1.0.0",
    summary: "Decides what runs when something happens in your repository.",
    description:
      "The Dispatcher watches the events a repository produces — a push, an issue, a review, a schedule — and orders the flows that answer them. Register a dispatcher once and the work starts without you opening the app.",
    icon: "radio-tower",
    tags: ["automation", "events"],
    recommended: 2,
    gettingStarted: [
      "List the dispatchers already watching your workspace.",
      "Register one for the event you keep answering by hand."
    ]
  },
  activate: (ctx) =>
    Effect.flatMap(
      availableRail([{ flow: "triggers.list", label: "Dispatchers", icon: "radio-tower" }]),
      (rail) => contribute(ctx, { rail, flows: ["triggers.list", "triggers.register"] })
    )
}

/** The Factory: the idea → prototype → change → delivery path. */
const factory: AppPlugin = {
  manifest: {
    id: "factory",
    name: "Factory",
    publisher: "Smithers",
    version: "1.0.0",
    summary: "Turns an idea into a reviewed change, one stage at a time.",
    description:
      "The Factory is the path this app walks with you: try the idea as a disposable prototype, keep the feedback rather than the code, plan the change with hindsight, then implement, review and deliver it. Each stage is a flow you can watch and interrupt.",
    icon: "factory",
    tags: ["delivery", "review"],
    recommended: 3,
    dependsOn: ["librarian"],
    gettingStarted: [
      "Start a prototype for the smallest version of the idea."
    ]
  },
  activate: (ctx) =>
    contribute(ctx, { flows: ["feature.prototype"] })
}

/** Box: the per-branch sandbox the work actually runs in. */
const box: AppPlugin = {
  manifest: {
    id: "box",
    name: "Box",
    publisher: "Smithers",
    version: "1.0.0",
    summary: "One sandbox per branch: files, terminal and services.",
    description:
      "A box is where a branch's work runs — its files, its terminal, its services, its snapshots. One box per branch, so two pieces of work never share a working copy, and a box you suspend is waiting exactly as you left it.",
    icon: "box",
    tags: ["sandbox", "runtime"],
    gettingStarted: [
      "List the boxes on your workspace.",
      "Open one to browse its files or attach a terminal."
    ]
  },
  activate: (ctx) =>
    Effect.flatMap(
      availableRail([{ flow: "box.list", label: "Boxes", icon: "box" }]),
      (rail) => contribute(ctx, { rail, flows: ["box.list", "box.open", "box.terminal"] })
    )
}

/** Secrets: a grant to one act, never to a whole flow. */
const secrets: AppPlugin = {
  manifest: {
    id: "secrets",
    name: "Secrets",
    publisher: "Smithers",
    version: "1.0.0",
    summary: "Credentials granted to one act inside a flow, never the whole run.",
    description:
      "A secret is held by the workspace, not by the agent: the value is substituted at the egress the granted act makes, so a token reaches the one request it was granted for and nothing else can read it back.",
    icon: "key-round",
    tags: ["security", "credentials"],
    gettingStarted: [
      "List what this workspace already holds.",
      "Grant a secret to the act that needs it, not to the flow around it."
    ]
  },
  activate: (ctx) =>
    Effect.flatMap(
      availableRail([{ flow: "secrets.list", label: "Secrets", icon: "key-round" }]),
      (rail) => contribute(ctx, { rail, flows: ["secrets.list"] })
    )
}

/** The shelf, in catalog order. */
export const CATALOG: ReadonlyArray<AppPlugin> = [librarian, dispatcher, factory, box, secrets]

/** The recommended plugins first, in the rank the catalog states, then the rest. */
export const shelfOrder = (
  plugins: ReadonlyArray<AppPlugin> = CATALOG
): ReadonlyArray<AppPlugin> =>
  [...plugins].sort((left, right) =>
    (left.manifest.recommended ?? Number.MAX_SAFE_INTEGER) -
      (right.manifest.recommended ?? Number.MAX_SAFE_INTEGER) ||
    left.manifest.name.localeCompare(right.manifest.name)
  )

/** The plugin with this id, or undefined when the catalog has never heard of it. */
export const pluginById = (id: string): AppPlugin | undefined =>
  CATALOG.find((plugin) => plugin.manifest.id === id)

/** The manifests, for the gallery and for what a person reads before installing. */
export const manifests = (): ReadonlyArray<PluginManifest> => CATALOG.map((plugin) => plugin.manifest)

/**
 * The plugins to load for an installed set, in CATALOG order with every
 * dependency ahead of its dependent: install order is a person's clicking
 * order, and load order is the catalog's.
 */
export const installedPlugins = (installed: ReadonlyArray<string>): ReadonlyArray<AppPlugin> =>
  CATALOG.filter((plugin) => installed.includes(plugin.manifest.id))
