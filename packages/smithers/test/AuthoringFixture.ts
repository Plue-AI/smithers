/**
 * Scripted authoring, real filesystem transactions, and the host's own
 * registry.
 *
 * The author is scripted — no provider is involved — and everything under it
 * is the production path: the write goes through the engine's workspace
 * sandbox and copy-back, the file it lands on is a `@smthrs/flow` GRAPH file
 * shaped the way `flows/create-flow/scaffold/flow.mdx` teaches an authoring
 * agent to write one, and nothing here registers the flow that file declares.
 * The host discovers it, `@smthrs/registry` `Executable` loads it, and
 * `Executable.Refresh` registers the rebuilt body while the host serves
 * (D-081).
 *
 * @since 1.0.0
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as NodePath from "@effect/platform-node/NodePath"
import * as NodeServices from "@effect/platform-node/NodeServices"
import type { DurableFlow } from "@smthrs/control/SqlControlRuntime"
import * as StepBoundary from "@smthrs/engine-store/StepBoundary"
import * as WorkspaceSandbox from "@smthrs/engine-store/WorkspaceSandbox"
import { Action, Flow } from "@smthrs/flow"
import * as Graph from "@smthrs/flow/Graph"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as KernelWorkspace from "@smthrs/kernel/Workspace"
import { Plan } from "@smthrs/plan"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Registry from "@smthrs/registry/Registry"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as ArtifactStore from "../flows/artifacts/src/ArtifactStore.ts"

/**
 * The flow the scripted author writes, named the way discovery names it: by
 * the directory its entry file sits in.
 *
 * @since 1.0.0
 * @category constants
 */
export const authoredFlowId = "authoring-demo"

/**
 * Where that file lands, relative to the project the host serves.
 *
 * @since 1.0.0
 * @category constants
 */
export const authoredPath = `flows/${authoredFlowId}/flow.ts`

/** The step the first version dispatches. The host implements it by name. */
const Read = Action.make("authoring/Read", { payload: {}, success: Schema.String })

/** The step the edited version adds. The host implements it by name. */
const Validate = Action.make("authoring/Validate", { payload: {}, success: Schema.String })

/**
 * The bytes the author writes, in the shape the scaffold teaches.
 *
 * One `@smthrs/flow` flow, default-exported, stating its metadata literally
 * because discovery parses the file without importing it, and dispatching
 * actions the host resolves by NAME. Nothing in it imports this module or any
 * other file beside itself: a flow's entry may only run code the host can
 * measure, and a bare specifier resolves into the host's own installed code.
 *
 * Version 2 is version 1 plus a second arm, which is what a reader of the
 * canvas sees appear when the author is asked to add validation.
 */
const source = (version: number) =>
  `import { Action, Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import { Schema } from "effect"

// The steps this flow dispatches. A declaration carries no code: the host
// resolves the implementation by name when the step is dispatched.
const Read = Action.make("authoring/Read", {
  payload: {},
  success: Schema.String
})
${
    version === 2
      ? `const Validate = Action.make("authoring/Validate", {
  payload: {},
  success: Schema.String
})
`
      : ""
  }
class AuthoringFailure extends Schema.TaggedError<AuthoringFailure>()(
  "authoring/AuthoringFailure",
  { message: Schema.String }
) {}

export default Flow.make("authoring/Demo", {
  description: "Reads the workspace and reports what it found.",
  capabilities: ["fs:read:**"],
  payload: {},
  success: Schema.Unknown,
  error: AuthoringFailure,
  body: () => Node.all({ read: Read.call({})${version === 2 ? ", validate: Validate.call({})" : ""} })
})
`

/**
 * The one sealed write the scripted author performs.
 *
 * Its write set is the entry file, with a hard boundary, so the engine
 * captures a diff bundle for it and copies it back into the workspace — which
 * is the record `AuthoredSources` pairs and the host rebuilds the catalog on.
 */
const WriteSource = Action.make("authoring/WriteSource", {
  payload: { version: Schema.Number },
  success: Schema.String,
  implementationVersion: "1",
  fileBoundary: { readSet: [], writeSet: [authoredPath], boundaryMode: "hard" },
  idempotencyKey: ({ version }: { readonly version: number }) => `author-source:${version}`
})

/**
 * The author itself: one flow the host registers, standing where a real
 * `create-flow` run stands.
 *
 * @since 1.0.0
 * @category models
 */
export const ScriptedAuthor = Flow.make("create-flow", {
  payload: { args: Schema.String },
  success: Schema.Unknown,
  error: Schema.Unknown,
  body: ({ args }) => WriteSource.call({ version: args.startsWith("Add validation") ? 2 : 1 })
})

/**
 * Builds the authoring half over one scratch project root.
 *
 * The root is the workspace the engine's sandbox copies back into AND the
 * project the host's registry scans, because that is the arrangement the
 * rebuild exists for: a run of this host writes into the `flows/` directory
 * this host serves.
 *
 * @since 1.0.0
 * @category constructors
 */
export const makeAuthoringFixture = (root: string) => {
  mkdirSync(join(root, "flows"), { recursive: true })
  writeFileSync(join(root, "package.json"), "{\"type\":\"module\"}\n")
  // So the authored entry's bare `@smthrs/flow` and `effect` specifiers resolve
  // into the host's own installed code, which is the one thing a flow file may
  // load that nothing measures.
  symlinkSync(fileURLToPath(new URL("../node_modules", import.meta.url)), join(root, "node_modules"), "dir")
  const envelope = { capabilities: [], flows: [], budget: {} }
  /** The one flow this fixture hands the control plane. The author's own. */
  const flows: ReadonlyArray<DurableFlow> = [
    {
      flowId: ScriptedAuthor._tag,
      description: "Scripted source authoring fixture",
      deployClass: false,
      envelope,
      plan: (input, planId) =>
        Effect.suspend(() => {
          const built = Graph.build(ScriptedAuthor, input as { readonly args: string })
          return Plan.compile({ planId, flow: ScriptedAuthor._tag, nodes: Graph.drafts(built) }).pipe(
            Effect.map((plan) => ({ plan, graph: { edges: Graph.edges(built) } }))
          )
        }).pipe(Effect.provide(NodeCrypto.layer), Effect.orDie)
    }
  ]
  const host = KernelFileSystem.layer.pipe(
    Layer.provide(AtomicFileSystem.layer),
    Layer.provideMerge(NodePath.layer),
    Layer.provide(KernelWorkspace.layer(root)),
    Layer.provide(GrantStore.layerNoop)
  )
  /**
   * The project registry this host discovers its flows with, as
   * `NativeControl.layerRegistry` builds one: `Registry` over the project's
   * `flows/` directory, scanned through the kernel-guarded platform pinned to
   * the project root. The directory is created above, so the scan finds an
   * empty project rather than refusing a missing root.
   */
  const registry = Registry.layer({
    sources: [{ source: "project", root: join(root, "flows"), naming: "path" }]
  }).pipe(Layer.provide([Discovery.layer.pipe(Layer.provide(host)), host]), Layer.orDie)
  /**
   * What `@smthrs/registry` `Executable` reads and writes with: the host's own
   * filesystem. Discovery walks absolute paths under the project root and the
   * loader writes a digest-named sibling beside an entry before importing it,
   * neither of which is an action's workspace-scoped view.
   */
  const platform = NodeServices.layer
  const artifacts = ArtifactStore.layerMemory.pipe(Layer.provideMerge(host))
  const filesystem = Layer.mergeAll(
    StepBoundary.layer.pipe(Layer.provide(artifacts)),
    WorkspaceSandbox.layerFileSystem().pipe(Layer.provide(artifacts), Layer.provide(KernelWorkspace.layer(root)))
  ).pipe(Layer.provideMerge(artifacts))
  const implementations = Layer.mergeAll(
    Read.toLayer(() => Effect.succeed("read")),
    Validate.toLayer(() => Effect.succeed("validated")),
    WriteSource.toLayer(({ version }: { readonly version: number }) =>
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(authoredPath, source(version))
        return authoredPath
      }).pipe(Effect.orDie), { implementationVersion: "1" })
  )
  return { root, flows, filesystem, implementations, registry, platform }
}
