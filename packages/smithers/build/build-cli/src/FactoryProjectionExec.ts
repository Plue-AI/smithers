/**
 * The executor's half of the factory projection: registry discovery over the
 * flows directory, joined with the factory's `Smithers.Flow` declarations and
 * written or checked as `.smithers/factory.json`, beside the home pane the
 * same declaration file exports, written or checked as `.smithers/home.json`.
 *
 * The rendering rules live in `@smthrs/targets/Factory` and
 * `@smthrs/targets/FlowCatalog`, which own the projection shape and the row
 * ordering. This module only supplies what a pure module cannot: the
 * discovery walk, which is the same code path `smthrs ls` runs, so the
 * projection can never list a flow the CLI would not, and the publication
 * of the two files.
 *
 * @since 1.0.0
 */

import type { Action, FlowRuntime } from "@smthrs/flow"
import { inputDocument } from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Factory from "@smthrs/targets/Factory"
import * as FlowCatalog from "@smthrs/targets/FlowCatalog"
import * as GeneratedFile from "@smthrs/targets/GeneratedFile"
import * as Home from "@smthrs/targets/Home"
import * as SafeFs from "@smthrs/targets/SafeFs"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import type * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Fs from "node:fs/promises"
import * as NodePath from "node:path"
import { posix } from "./internal/Text.ts"

const kindOf = (entryPath: string): FlowCatalog.Kind | undefined => {
  switch (NodePath.basename(entryPath)) {
    case "flow.ts":
      return "ts"
    case "flow.mdx":
      return "mdx"
    case "SKILL.md":
      return "skill"
    default:
      return undefined
  }
}

/**
 * Discovers every flow under one workspace-relative directory, reduced to the
 * fields the projection carries. Paths are workspace-relative and POSIX.
 *
 * @category effects
 * @since 1.0.0
 */
export const discoverFlows = (
  workspaceRoot: string,
  root: string
): Effect.Effect<
  ReadonlyArray<FlowCatalog.DiscoveredFlow>,
  FlowCatalog.FlowCatalogError,
  FileSystem.FileSystem | Path.Path
> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const absoluteRoot = NodePath.join(workspaceRoot, ...root.split("/"))
    const scan = yield* Discovery.make(fs, path).scan({ source: "project", root: absoluteRoot, naming: "path" }).pipe(
      Effect.mapError((cause) =>
        new FlowCatalog.FlowCatalogError({
          message: `could not discover the flows under ${root}: ${cause.message}`
        })
      )
    )
    const flows: Array<FlowCatalog.DiscoveredFlow> = []
    for (const descriptor of scan.entries) {
      const kind = kindOf(descriptor.body.path)
      if (kind === undefined) {
        return yield* new FlowCatalog.FlowCatalogError({
          message: `discovery reported ${JSON.stringify(descriptor.name)} from an entry the projection does not know: ${
            NodePath.basename(descriptor.body.path)
          }`
        })
      }
      flows.push({
        id: descriptor.name,
        description: descriptor.description,
        kind,
        path: posix(NodePath.relative(workspaceRoot, descriptor.body.path)),
        capabilities: descriptor.capabilities,
        flows: descriptor.flows,
        ...(descriptor.budget === undefined ? {} : {
          budget: {
            ...(descriptor.budget.tokens === undefined ? {} : { tokens: descriptor.budget.tokens }),
            ...(descriptor.budget.milliseconds === undefined ? {} : { milliseconds: descriptor.budget.milliseconds }),
            ...(descriptor.budget.usd === undefined ? {} : { usd: descriptor.budget.usd }),
            ...(descriptor.budget.onExceeded === undefined ? {} : { onExceeded: descriptor.budget.onExceeded })
          }
        }),
        model: Option.getOrNull(descriptor.model),
        modelInvocable: descriptor.modelInvocable,
        ...(inputDocument(descriptor.input) === undefined ? {} : { inputSchema: inputDocument(descriptor.input)! })
      })
    }
    return flows
  })

type ProjectionError =
  | FlowCatalog.FlowCatalogError
  | Factory.FactoryProjectionError
  | GeneratedFile.WriteFileError
  | GeneratedFile.DriftError

/** Reports whether a workspace-relative file exists as a regular file. */
const present = (workspaceRoot: string, path: string): Effect.Effect<boolean, Factory.FactoryProjectionError> =>
  Effect.tryPromise({
    try: async () => {
      const root = await SafeFs.canonicalRoot(workspaceRoot)
      try {
        return (await Fs.lstat(NodePath.join(root, ...path.split("/")))).isFile()
      } catch {
        return false
      }
    },
    catch: (cause) =>
      new Factory.FactoryProjectionError({
        message: `${path} could not be read: ${GeneratedFile.failureMessage(cause)}`
      })
  })

/**
 * The home pane's publication. A factory that exports no `home` owns no
 * pane: `write` removes a stale file, `check` fails while one is checked in,
 * so the tree never carries a pane the declaration stopped exporting.
 */
const publishHome = (
  workspaceRoot: string,
  payload: Factory.Payload
): Effect.Effect<void, ProjectionError> =>
  Effect.gen(function*() {
    if (payload.home !== null) {
      const file = { path: payload.homeOutput, contents: Home.render(payload.home) }
      return yield* payload.mode === "write"
        ? GeneratedFile.writeGeneratedFile(workspaceRoot, file)
        : GeneratedFile.checkGeneratedFile(workspaceRoot, file)
    }
    const exists = yield* present(workspaceRoot, payload.homeOutput)
    if (!exists) return
    if (payload.mode === "write") {
      return yield* Effect.tryPromise({
        try: async () => {
          const root = await SafeFs.canonicalRoot(workspaceRoot)
          await Fs.rm(NodePath.join(root, ...payload.homeOutput.split("/")), { force: true })
        },
        catch: (cause) =>
          new GeneratedFile.WriteFileError({ path: payload.homeOutput, message: GeneratedFile.failureMessage(cause) })
      })
    }
    return yield* new Factory.FactoryProjectionError({
      message:
        `${payload.homeOutput} is checked in but FACTORY.ts exports no home; export one or run the projection with --write to remove the file`
    })
  })

/**
 * Discovers, joins, and writes or checks both projection files.
 *
 * @category effects
 * @since 1.0.0
 */
export const renderProjection = (
  workspaceRoot: string,
  payload: Factory.Payload
): Effect.Effect<void, ProjectionError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const factory = payload.factory
    if (factory === null) {
      return yield* new Factory.FactoryProjectionError({
        message:
          `the workspace declares no factory: create ${Factory.declarationPath} beside WORKSPACE.ts and export const factory = S.Factory({ ... })`
      })
    }
    const discovered = yield* discoverFlows(workspaceRoot, payload.root)
    const contents = yield* Effect.try({
      try: () => Factory.renderProjection(factory, FlowCatalog.rows(discovered, factory.flows)),
      catch: (cause) =>
        cause instanceof FlowCatalog.FlowCatalogError
          ? cause
          : new FlowCatalog.FlowCatalogError({ message: GeneratedFile.failureMessage(cause) })
    })
    const file = { path: payload.output, contents }
    yield* payload.mode === "write"
      ? GeneratedFile.writeGeneratedFile(workspaceRoot, file)
      : GeneratedFile.checkGeneratedFile(workspaceRoot, file)
    yield* publishHome(workspaceRoot, payload)
  })

/**
 * Implements the projection action over the registry's discovery and the
 * shared generated-file publication.
 *
 * @category layers
 * @since 1.0.0
 */
export const FactoryProjectionLive = (options: {
  readonly workspaceRoot: string
}): Layer.Layer<
  Action.Requirement<"smithers-build/factory-projection">,
  never,
  FlowRuntime.FlowRuntime | FileSystem.FileSystem | Path.Path
> => Factory.FactoryProjectionAction.toLayer((payload) => renderProjection(options.workspaceRoot, payload))
