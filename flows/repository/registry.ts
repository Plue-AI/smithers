/** Bundled declarations are available before a repository has written any flows. */
import * as Digest from "@smthrs/core/Digest"
import * as CoreFlow from "@smthrs/core/Flow"
import type * as RuntimeFlow from "@smthrs/flow/Flow"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as MarkdownFlow from "@smthrs/registry/MarkdownFlow"
import * as Registry from "@smthrs/registry/Registry"
import { registryError } from "@smthrs/registry/RegistryError"
import { Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { fileURLToPath } from "node:url"
import {
  FLOW_AUTHORING_ENTRY,
  FLOW_AUTHORING_PACK,
  FLOW_AUTHORING_STAGES
} from "../../packages/rpc/src/FlowAuthoring.ts"
import Dispatch from "../coding/dispatch/flow.ts"
import ImplementPlan from "../coding/flow.ts"
import ImplementAtoms from "../coding/implementation/flow.ts"
import Register from "../register-repository/flow.ts"
import { deploymentMinutes, deploymentTokens } from "./inspection.ts"
import { JobInput, JobResult, OperationResult, SetupInput, TriggerRequest } from "./schema.ts"
import { TriggerOutcome } from "./triggers.ts"

declare const __SMITHERS_CODING_ARTIFACT_DIGEST__: string | undefined
/**
 * The built-in prompt bodies, compiled into the deployed host.
 *
 * They are `.mdx` files in this repository, and the deployment is one esbuild
 * bundle that carries no repository tree, so `flows/coding/build.mjs` inlines
 * them here — before it hashes the artifact, so the artifact's own digest
 * covers the prompts a workspace will run. Undefined means "running from
 * source", where {@link authoringBodies} reads the same files from disk.
 */
declare const __SMITHERS_CREATE_FLOW_PACK__: Readonly<Record<string, string>> | undefined
/** Where each pack body lives, relative to this module, in source and in the bundler. */
const authoringSource = (name: string) => `../${name}/flow.mdx`
const issueFlows = ["issue/repro", "issue/poc"] as const
const policySources = [
  "schema.ts",
  "remote.ts",
  "inspection.ts",
  "jobs.ts",
  "execution.ts",
  "events.ts",
  "intake.ts",
  "retention.ts",
  "evaluation.ts",
  "setup.ts",
  "registry.ts",
  "receipts.ts",
  "activation.ts",
  "source.ts",
  "checks.ts",
  "check-context.ts",
  "changes.ts",
  "replies.ts",
  "delivery.ts",
  "ci-policy.ts",
  "check-receipt.ts",
  "triggers.ts",
  "../coding/host.ts",
  "../coding/native.ts",
  "../coding/native-schema.ts",
  "../coding/schema.ts",
  "../coding/dispatch.ts",
  "../coding/flow.ts",
  "../coding/dispatch/flow.ts",
  "../coding/implementation/flow.ts",
  "../coding/planning-authority.ts",
  "../coding/immutable-source.ts",
  ...[
    "flow.ts",
    "setup/flow.ts",
    "workflow.ts",
    "schema.ts",
    "host.ts",
    "tree.ts",
    "history.ts",
    "readiness.ts",
    "cleanup.ts",
    "pulls.ts",
    "jev.ts",
    "link.ts"
  ].map((name) => `../register-repository/${name}`),
  "../../packages/rpc/src/RepositorySetup.ts",
  "../../pnpm-lock.yaml",
  // A prompt a workspace runs is policy: editing one changes what every
  // built-in body tells a model to do.
  ...FLOW_AUTHORING_PACK.map(authoringSource),
  ...issueFlows.map(authoringSource)
]
export const runningRepositoryPolicy = Effect.gen(function*() {
  if (typeof __SMITHERS_CODING_ARTIFACT_DIGEST__ !== "undefined") {
    if (!/^[0-9a-f]{64}$/.test(__SMITHERS_CODING_ARTIFACT_DIGEST__)) {
      return yield* Effect.fail(new Error("Invalid repository host fingerprint"))
    }
    return __SMITHERS_CODING_ARTIFACT_DIGEST__
  }
  const fs = yield* FileSystem.FileSystem
  const sources = yield* Effect.forEach(policySources, (name) =>
    Effect.gen(function*() {
      const path = fileURLToPath(new URL(name, import.meta.url)), stat = yield* fs.stat(path)
      if (stat.size > 2_000_000n) return yield* Effect.fail(new Error("Repository policy source exceeds its bound"))
      return { name, digest: Digest.digest(yield* fs.readFileString(path)) }
    }))
  return Digest.digest(Digest.canonical(sources))
})
/**
 * The flow-authoring and issue prompt bodies this host installs on every workspace.
 *
 * From the bundle they are the constant compiled into it; from source they are
 * the repository's own files. A missing body is a startup failure rather than
 * a workspace that silently cannot author a flow — which is exactly the state
 * production was in, because nothing installed these at all.
 */
export const authoringBodies: Effect.Effect<ReadonlyMap<string, string>, Error, FileSystem.FileSystem> = Effect.gen(
  function*() {
    const compiled = typeof __SMITHERS_CREATE_FLOW_PACK__ === "undefined" ? undefined : __SMITHERS_CREATE_FLOW_PACK__
    const fs = yield* FileSystem.FileSystem
    const bodies = new Map<string, string>()
    for (const name of [...FLOW_AUTHORING_PACK, ...issueFlows]) {
      const text = compiled === undefined
        ? yield* fs.readFileString(fileURLToPath(new URL(authoringSource(name), import.meta.url))).pipe(
          Effect.mapError((cause) => new Error(`The built-in flow ${name} could not be read: ${cause.message}`))
        )
        : Object.hasOwn(compiled, name) && typeof compiled[name] === "string" ?
        compiled[name]
        : yield* Effect.fail(new Error(`The deployed host carries no body for the built-in flow ${name}`))
      if (text.trim() === "") return yield* Effect.fail(new Error(`The built-in flow ${name} has an empty body`))
      bodies.set(name, text)
    }
    // A control session cannot start another agent inside one cell call: that
    // nested run would join the journal transaction held by the parent call.
    // Ship the same stage instructions in the entry prompt so the parent can
    // work through them and use its own durable `ask` approval boundary.
    const entry = bodies.get(FLOW_AUTHORING_ENTRY)!
    const stages = FLOW_AUTHORING_STAGES.map((name, index) =>
      `## Stage ${index + 1}: ${name}\n\n${MarkdownFlow.loadBody(bodies.get(name)!, "").text.trim()}`
    )
    bodies.set(FLOW_AUTHORING_ENTRY, `${entry.trimEnd()}\n\n${stages.join("\n\n")}\n`)
    return bodies
  }
)

export const provisionBuiltins = (stateRoot: string, policy: string) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
    const root = path.join(stateRoot, "builtin-flows", policy)
    /*
     * The bundled flows a workspace has before its repository writes any.
     *
     * `flow` is the `@smthrs/flow` flow this entry IS: one file, no delegate
     * name, and the value the bundle hands the loader. `delegate` is the older
     * shape, still used by the repository doors whose work is chosen per
     * invocation from the registry envelope rather than declared by the entry.
     */
    const entries: ReadonlyArray<
      & { readonly name: string; readonly description: string }
      & ({ readonly delegate: string; readonly flow?: undefined } | {
        readonly delegate?: undefined
        readonly flow: RuntimeFlow.Any
      })
    > = [
      {
        name: "repository/setup",
        delegate: "repository/RunSetup",
        description: "Configure, evaluate and activate one repository responsibility."
      },
      {
        name: "repository/trigger",
        delegate: "repository/RunTrigger",
        description: "Register one repository flow to run on a reviewed schedule."
      },
      ...(["issues", "review", "ci", "feature", "chores"] as const).map((job) => ({
        name: `repository-jobs/${job}`,
        delegate: "repository/RunJob",
        description: `Run the reviewed ${job} responsibility with recorded evidence.`
      })),
      { name: "coding", flow: ImplementPlan, description: "Execute a native coding plan with its required checks." },
      { name: "coding/dispatch", flow: Dispatch, description: "Run one dispatched agent turn in this workspace." },
      { name: "coding/implementation", flow: ImplementAtoms, description: "Implement one native coding atom." },
      {
        name: "register-repository",
        flow: Register,
        description: "Analyze this repository from its link, wait for Smithers review, then set it up."
      }
    ]
    const modules = new Map<string, { body: string; declaration: unknown }>()
    for (const entry of entries) {
      const directory = path.join(root, entry.name)
      yield* fs.makeDirectory(directory, { recursive: true })
      const header = `// Bundled repository policy ${policy}.`
      const body = entry.flow === undefined
        ? `import { Flow } from "@smthrs/core"\nimport { Schema } from "effect"\n${header}\nexport default Flow.make({ name: ${
          JSON.stringify(entry.name)
        }, description: ${JSON.stringify(entry.description)}, capabilities: ["*"], flows: [${
          JSON.stringify(entry.delegate)
        }], budget: { tokens: ${deploymentTokens}, milliseconds: ${
          deploymentMinutes * 60000
        } }, input: Schema.Unknown, output: Schema.Unknown })\n`
        : `import { Flow } from "@smthrs/flow"\nimport { Schema } from "effect"\n${header}\nexport default Flow.make(${
          JSON.stringify(entry.flow._tag)
        }, { description: ${
          JSON.stringify(entry.description)
        }, capabilities: ["*"], budget: { tokens: ${deploymentTokens}, milliseconds: ${
          deploymentMinutes * 60000
        } }, payload: Schema.Unknown, success: Schema.Unknown })\n`
      const file = path.join(directory, "flow.ts")
      const previous = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
      if (previous !== body) yield* fs.writeFileString(file, body)
      // Discovery reads ordinary modern declaration bytes. The deployed bundle
      // supplies their exact Flow value; target repos need no package imports.
      // The budget rides the written bytes, which is where a catalog reads it.
      // `Flow.make` has no `budget` option, so the value carries none either.
      modules.set(path.resolve(file), {
        body,
        declaration: entry.flow ?? CoreFlow.make({
          name: entry.name,
          description: entry.description,
          capabilities: ["*"],
          flows: [entry.delegate],
          input: Schema.Unknown,
          output: Schema.Unknown
        })
      })
    }
    /*
     * The authoring pack, written beside the module built-ins as ordinary
     * prompt bodies.
     *
     * A workspace's catalog is its repository's own `flows/` tree plus what is
     * written here, and a freshly imported repository has no `flows/` tree. So
     * before this, every workspace carried nine flows and all nine were module
     * flows — no prompt body existed anywhere in production, which is both why
     * `/flow.create` had nothing to launch and why no run could show a person an
     * agent's frames (`AgentSession` runs only a Prompt body through its trace
     * and pump). A repository that writes its own `create-flow` still wins:
     * `bindRepositoryRegistry` reserves only the repository-job names.
     */
    for (const [name, text] of yield* authoringBodies) {
      const directory = path.join(root, name)
      yield* fs.makeDirectory(directory, { recursive: true })
      const file = path.join(directory, "flow.mdx")
      const previous = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
      if (previous !== text) yield* fs.writeFileString(file, text)
    }
    const registry = yield* Registry.make({
      sources: [{ root, source: "repository-host", naming: "path", system: true }]
    }).pipe(Effect.provide(Discovery.layer))
    const load: NonNullable<Executable.Options["load"]> = (file, source) => {
      const entry = modules.get(path.resolve(file))
      return entry !== undefined && new TextDecoder().decode(source.bytes) === entry.body &&
          Digest.digest(entry.body) === source.contentDigest
        ? Effect.succeed({ default: entry.declaration }) :
        Effect.fail(new Error("Bundled declaration bytes changed"))
    }
    return { registry, load }
  })

/** Project modules retain their normal verified import loader; built-ins use
 * the value compiled into this same host bundle after exact-byte admission. */
export const repositoryCatalog = (options: Executable.Options, load: NonNullable<Executable.Options["load"]>) =>
  Effect.gen(function*() {
    const registry = yield* Registry.Registry, descriptors = yield* registry.list()
    const selected = (bundled: boolean) =>
      Registry.Registry.of({
        ...registry,
        list: () =>
          Effect.succeed(descriptors.filter((entry) => (entry.provenance.source === "repository-host") === bundled))
      })
    const project = yield* Executable.catalog(options).pipe(Effect.provideService(Registry.Registry, selected(false)))
    const builtins = yield* Executable.catalog({ ...options, load }).pipe(
      Effect.provideService(Registry.Registry, selected(true))
    )
    return {
      executables: [...project.executables, ...builtins.executables],
      refused: [...project.refused, ...builtins.refused]
    }
  })

/**
 * The registration layer this host serves its catalog through.
 *
 * Everything the catalog holds is registered, and the catalog itself is served
 * rebuildable one entry at a time so a run of this host can author
 * `flows/<id>/flow.ts` and have the next plan draw it. `refreshableEntry`
 * decides which half may be rebuilt.
 *
 * It is one function rather than a composition spelled out at the host's call
 * site because the rule it encodes is the thing under test:
 * `flows/test/coding-catalog-refresh.test.ts` builds THIS, so a change to what
 * the host serves its catalog through is a change a test sees.
 */
export const repositoryRegistration = <ROut, E, RIn>(
  options: Executable.Options,
  built: Executable.Catalog,
  leaves: Layer.Layer<ROut, E, RIn>
) =>
  Layer.mergeAll(leaves, ...built.executables.map((entry) => entry.layer)).pipe(
    Layer.provideMerge(Executable.layerRefreshable(built, { ...options, refreshable: refreshableEntry }))
  )

/**
 * Which of this host's catalog entries may be rebuilt from the working tree.
 *
 * A run this host serves can write anything into that tree, so the reserved
 * declarations that came from the measured bundle are never rebuilt out of it:
 * their bytes are the image this host shipped as. Everything the repository
 * owns is, which is what lets `create-flow` write `flows/<id>/flow.ts` and have
 * the next plan draw it.
 */
export const refreshableEntry = (descriptor: Descriptor.FlowDescriptor): boolean =>
  descriptor.provenance.source !== "repository-host"

/** Reserved job declarations always come from the measured host bundle. */
export const bindRepositoryRegistry = (
  base: Registry.Registry,
  builtins: Registry.Registry,
  policy: string
): Registry.Registry => {
  const reserved = (name: string) =>
    name === "repository/setup" || name === "repository/trigger" ||
    /^repository-jobs\/(issues|review|ci|feature|chores)$/.test(name)
  const reservedSchemas = (name: string) =>
    name === "repository/setup" ?
      { input: SetupInput, output: OperationResult }
      : name === "repository/trigger"
      ? { input: TriggerRequest, output: TriggerOutcome }
      : { input: JobInput, output: JobResult }
  const derived = (descriptor: Descriptor.FlowDescriptor) =>
    reserved(descriptor.name) ?
      new Descriptor.FlowDescriptor({
        ...descriptor,
        budget: { tokens: deploymentTokens, milliseconds: deploymentMinutes * 60000 },
        input: new Descriptor.SchemaRefInline({
          document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(reservedSchemas(descriptor.name).input)))
        }),
        output: new Descriptor.SchemaRefInline({
          document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(reservedSchemas(descriptor.name).output)))
        }),
        frontmatter: { ...descriptor.frontmatter, repositoryHostPolicy: policy }
      }) :
      descriptor
  const owned = (name: string) =>
    reserved(name)
      ? Effect.succeed(builtins)
      : base.getOption(name).pipe(Effect.map((found) => Option.isSome(found) ? base : builtins))
  const get = (name: string) => owned(name).pipe(Effect.flatMap((registry) => registry.get(name)), Effect.map(derived))
  const list = () =>
    Effect.all([base.list(), builtins.list()]).pipe(Effect.map(([project, defaults]) =>
      [
        ...project.filter((entry) => !reserved(entry.name)),
        ...defaults.filter((entry) =>
          reserved(entry.name) || !project.some((candidate) => candidate.name === entry.name)
        )
      ].map(derived)
    ))
  const loadBody: Registry.Registry["loadBody"] = (name, expected) =>
    Effect.gen(function*() {
      const registry = yield* owned(name), original = yield* registry.get(name), descriptor = derived(original)
      if (expected !== undefined && Descriptor.executionDigest(descriptor) !== expected) {
        return yield* registryError({
          code: "execution_changed",
          method: "loadBody",
          path: descriptor.path,
          description: "Repository host policy changed after planning"
        })
      }
      return yield* registry.loadBody(name, Descriptor.executionDigest(original))
    })
  return Registry.Registry.of({
    list,
    visible: () => list().pipe(Effect.map((entries) => entries.filter((entry) => entry.modelInvocable))),
    get,
    getOption: (name) => get(name).pipe(Effect.map(Option.some), Effect.catch(() => Effect.succeedNone)),
    loadBody,
    runPrompt: (name, input) =>
      loadBody(name).pipe(Effect.flatMap((body) =>
        body._tag === "Prompt" ?
          Effect.succeed(MarkdownFlow.renderPrompt(body, input))
          : Effect.fail(
            registryError({
              code: "not_prompt_flow",
              method: "runPrompt",
              description: "The selected flow is module-backed"
            })
          )
      )),
    refresh: () => Effect.all([base.refresh(), builtins.refresh()]).pipe(Effect.asVoid),
    warnings: () => Effect.all([base.warnings(), builtins.warnings()]).pipe(Effect.map((values) => values.flat()))
  })
}
