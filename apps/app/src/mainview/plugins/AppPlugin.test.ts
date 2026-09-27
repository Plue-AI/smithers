import { expect, test } from "bun:test"
import { Effect } from "effect"
import {
  availableRail,
  contribute,
  DuplicatePlugin,
  emptySurface,
  load,
  MissingDependency,
  PluginHost,
  UnknownFlow
} from "./AppPlugin"
import type { AppPlugin, AppSurface, PluginManifest } from "./AppPlugin"

const manifest = (id: string, extra: Partial<PluginManifest> = {}): PluginManifest => ({
  id,
  name: id,
  publisher: "Smithers",
  version: "1.0.0",
  summary: `${id} summary`,
  description: `${id} description`,
  icon: "puzzle",
  tags: [],
  gettingStarted: [],
  ...extra
})

/** A host that registered exactly these flows. */
const host = (...flows: ReadonlyArray<string>) => ({ hasFlow: (name: string) => flows.includes(name) })

const run = <A, E>(effect: Effect.Effect<A, E, PluginHost>, ...flows: ReadonlyArray<string>) =>
  Effect.runPromise(Effect.provideService(effect, PluginHost, host(...flows)))

/** The typed reason a load refused, for the tests that assert on it. */
const refusal = async <A, E>(
  effect: Effect.Effect<A, E, PluginHost>,
  ...flows: ReadonlyArray<string>
): Promise<E> => {
  const result = await run(Effect.result(effect), ...flows)
  if (result._tag !== "Failure") throw new Error("expected the load to be refused")
  return result.failure
}

const adds = (id: string, flow: string, extra: Partial<PluginManifest> = {}): AppPlugin => ({
  manifest: manifest(id, extra),
  activate: (ctx) => contribute(ctx, { rail: [{ flow, label: id, icon: "puzzle" as const }] })
})

test("plugins load in order and each one sees the app the ones before it left", async () => {
  const seen: Array<ReadonlyArray<string>> = []
  const watcher: AppPlugin = {
    manifest: manifest("watcher"),
    activate: (ctx) => {
      seen.push(ctx.loaded.map((loaded) => loaded.id))
      return contribute(ctx, { rail: [] })
    }
  }
  const surface = await run(load([adds("first", "wiki"), watcher, adds("third", "flows")]), "wiki", "flows")
  expect(seen).toEqual([["first"]])
  expect(surface.loaded.map((loaded) => loaded.id)).toEqual(["first", "watcher", "third"])
  expect(surface.rail.map((entry) => entry.flow)).toEqual(["wiki", "flows"])
  expect(surface.flows).toEqual(["wiki", "flows"])
})

test("a plugin decorates what an earlier plugin contributed, language-service style", async () => {
  /* The whole point of handing over `ctx.app`: a later plugin may rewrite it. */
  const shouting: AppPlugin = {
    manifest: manifest("shouting"),
    activate: (ctx): Effect.Effect<AppSurface, never, never> =>
      Effect.succeed({
        ...ctx.app,
        rail: ctx.app.rail.map((entry) => ({ ...entry, label: entry.label.toUpperCase() }))
      })
  }
  const surface = await run(load([adds("first", "wiki"), shouting]), "wiki")
  expect(surface.rail.map((entry) => entry.label)).toEqual(["FIRST"])
})

test("a dependency that is not loaded first fails the load with the reason", async () => {
  const failure = await refusal(load([adds("factory", "flows", { dependsOn: ["librarian"] })]), "flows")
  expect(failure).toBeInstanceOf(MissingDependency)
  expect((failure as MissingDependency).requires).toBe("librarian")
})

test("a dependency loaded before its dependent satisfies it", async () => {
  const surface = await run(
    load([adds("librarian", "wiki"), adds("factory", "flows", { dependsOn: ["librarian"] })]),
    "wiki",
    "flows"
  )
  expect(surface.loaded.map((loaded) => loaded.id)).toEqual(["librarian", "factory"])
})

test("the same plugin twice is refused rather than silently shadowed", async () => {
  expect(await refusal(load([adds("box", "wiki"), adds("box", "wiki")]), "wiki")).toBeInstanceOf(DuplicatePlugin)
})

test("a rail entry naming a flow this runtime never registered is refused", async () => {
  const failure = await refusal(load([adds("typo", "wiki.grpah")]), "wiki")
  expect(failure).toBeInstanceOf(UnknownFlow)
  expect((failure as UnknownFlow).flow).toBe("wiki.grpah")
})

test("availableRail keeps only the entries this runtime can honour", async () => {
  const rail = await run(
    availableRail([
      { flow: "wiki", label: "Wiki", icon: "book-open" },
      { flow: "history.show", label: "History", icon: "history" }
    ]),
    "wiki"
  )
  expect(rail.map((entry) => entry.flow)).toEqual(["wiki"])
})

test("loading nothing leaves the app exactly as it was", async () => {
  expect(await run(load([]))).toEqual(emptySurface)
})
