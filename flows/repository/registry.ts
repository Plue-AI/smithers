/** Bundled declarations are available before a repository has written any flows. */
import { Request, Vibe } from "@smthrs/coding"
import * as Digest from "@smthrs/core/Digest"
import type * as RuntimeFlow from "@smthrs/flow/Flow"
import type * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Discovery from "@smthrs/registry/Discovery"
import * as Executable from "@smthrs/registry/Executable"
import * as MarkdownFlow from "@smthrs/registry/MarkdownFlow"
import * as Registry from "@smthrs/registry/Registry"
import { type RegistryError, registryError } from "@smthrs/registry/RegistryError"
import { Context, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { fileURLToPath } from "node:url"
import {
  FLOW_AUTHORING_ENTRY,
  FLOW_AUTHORING_PACK,
  FLOW_AUTHORING_STAGES
} from "../../packages/rpc/src/FlowAuthoring.ts"
import Dispatch from "../coding/dispatch/flow.ts"
import FlowLoad from "../coding/flow-load/flow.ts"
import ImplementPlan from "../coding/flow.ts"
import ImplementAtoms from "../coding/implementation/flow.ts"
import Verify from "../coding/verify/flow.ts"
import CodingWiki from "../coding/wiki/flow.ts"
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
const firstPartyPrompts = ["issue/repro", "issue/poc", "pr-triage", "review/change"] as const
const policySources = [
  "../coding/host.ts",
  "../coding/native.ts",
  "../coding/native-schema.ts",
  "../coding/schema.ts",
  "../coding/dispatch.ts",
  "../coding/flow.ts",
  "../coding/dispatch/flow.ts",
  "../coding/implementation/flow.ts",
  "../coding/request/flow.ts",
  "../coding/todo.ts",
  "../coding/todo-route.ts",
  "../coding/steps.ts",
  "../coding/package.json",
  "../coding/flow-load.ts",
  "../coding/flow-load/flow.ts",
  "../todo/flow.ts",
  "../coding/verify/flow.ts",
  "../coding/vibe/flow.ts",
  "../coding/wiki/flow.ts",
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
  ...firstPartyPrompts.map(authoringSource)
]
export const runningRepositoryPolicy = Effect.gen(function*() {
  if (typeof __SMITHERS_CODING_ARTIFACT_DIGEST__ !== "undefined") {
    if (!/^[0-9a-f]{64}$/.test(__SMITHERS_CODING_ARTIFACT_DIGEST__)) {
      return yield* Effect.fail(new Error("Invalid repository host fingerprint"))
    }
    return __SMITHERS_CODING_ARTIFACT_DIGEST__
  }
  const fs = yield* FileSystem.FileSystem
  // Every repository helper runs with this host's authority. Discovering the
  // source directory keeps new judge and check modules in the policy identity.
  const repositorySources = (yield* fs.readDirectory(fileURLToPath(new URL(".", import.meta.url))))
    .filter((name) => name.endsWith(".ts"))
    .sort()
  const sources = yield* Effect.forEach([...repositorySources, ...policySources], (name) =>
    Effect.gen(function*() {
      const path = fileURLToPath(new URL(name, import.meta.url)), stat = yield* fs.stat(path)
      if (stat.size > 2_000_000n) return yield* Effect.fail(new Error("Repository policy source exceeds its bound"))
      return { name, digest: Digest.digest(yield* fs.readFileString(path)) }
    }))
  return Digest.digest(Digest.canonical(sources))
})
/**
 * The flow-authoring, issue and review prompt bodies this host installs on every workspace.
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
    for (const name of [...FLOW_AUTHORING_PACK, ...firstPartyPrompts]) {
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

/**
 * The optional coding routes a configured host serves (`configuredCodingRoutes`).
 * They ship as built-ins like `coding/implementation`, so a repository with
 * `.smithers/coding-project.json` and no `flows/coding/` tree still serves them
 * and never vendors coding bundles. The backend catalog decides which names
 * require the packaged implementation.
 */
const codingRoutes = {
  "coding/request": { flow: Request, description: "Plan and implement one coding request." },
  "coding/verify": { flow: Verify, description: "Re-run a Change's required checks on a rebased candidate." },
  "coding/vibe": { flow: Vibe, description: "Land one approved coding request." },
  "coding/wiki": { flow: CodingWiki, description: "Refresh the repository wiki after a fold." },
  "flow-load": { flow: FlowLoad, description: "Load every overridable flow at a main commit and answer its versions." }
} as const satisfies Record<string, { readonly flow: RuntimeFlow.Any; readonly description: string }>
export type CodingRoute = keyof typeof codingRoutes

/**
 * A check command the host registers as a built-in `checks/<name>` flow: a
 * repository's detected command (`detectChecks`, `flows/coding/project-config.ts`).
 */
export interface BuiltinCheck {
  readonly flow: string
  readonly argv: ReadonlyArray<string>
  readonly timeoutMs: number
}
const builtinCheckName = /^checks\/[a-z][a-z0-9-]{0,63}$/

/** The registered body `coding/CommandCheck` runs: its first body line is the JSON command (`flows/coding/checks.ts`). */
const checkBody = (check: BuiltinCheck) =>
  [
    "---",
    `description: ${JSON.stringify(`Run the detected command ${check.argv.join(" ")}.`)}`,
    "flows: [coding/CommandCheck]",
    `capabilities: ${JSON.stringify(["fs:read:**", `proc:spawn:${check.argv.join(" ")}`])}`,
    "---",
    JSON.stringify({ argv: check.argv, cwd: ".", timeoutMs: check.timeoutMs }),
    ""
  ].join("\n")

export const provisionBuiltins = (
  stateRoot: string,
  policy: string,
  routes: ReadonlyArray<CodingRoute> = [],
  checks: ReadonlyArray<BuiltinCheck> = []
) =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem, path = yield* Path.Path
    const root = path.join(stateRoot, "builtin-flows", policy)
    for (const check of checks) {
      if (
        !builtinCheckName.test(check.flow) || check.argv.length === 0 ||
        check.argv.some((part) => part === "" || /[\0\r\n]/.test(part))
      ) {
        return yield* Effect.die(
          new Error(`A built-in check must be checks/<name> with a nonempty argv: ${check.flow}`)
        )
      }
    }
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
      ...routes.map((name) => ({ name, ...codingRoutes[name] })),
      {
        name: "register-repository",
        flow: Register,
        description: "Analyze this repository from its link, wait for Smithers review, then set it up."
      }
    ]
    // The policy root outlives a configuration change (landing unbound, wiki
    // off), so a route this host no longer serves must not stay discoverable.
    for (const name of Object.keys(codingRoutes) as ReadonlyArray<CodingRoute>) {
      if (!routes.includes(name)) yield* fs.remove(path.join(root, name), { recursive: true, force: true })
    }
    const modules = new Map<string, { body: string; declaration: unknown }>()
    for (const entry of entries) {
      const directory = path.join(root, entry.name)
      yield* fs.makeDirectory(directory, { recursive: true })
      const header = `// Bundled repository policy ${policy}.`
      const body = entry.flow === undefined
        ? `import type * as FlowBinding from "@smthrs/harness/FlowBinding"\nimport { Schema } from "effect"\n${header}\nexport default ({ name: ${
          JSON.stringify(entry.name)
        }, description: ${JSON.stringify(entry.description)}, capabilities: ["*"], flows: [${
          JSON.stringify(entry.delegate)
        }], budget: { tokens: ${deploymentTokens}, milliseconds: ${
          deploymentMinutes * 60000
        } }, effects: undefined, input: Schema.Unknown, output: Schema.Unknown } satisfies FlowBinding.Declared)\n`
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
        declaration: entry.flow ??
          ({
            effects: undefined,
            name: entry.name,
            description: entry.description,
            capabilities: ["*"],
            flows: [entry.delegate],
            input: Schema.Unknown,
            output: Schema.Unknown
          } satisfies FlowBinding.Declared)
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
     * `bindRepositoryRegistry` reserves the backend's system names.
     */
    for (const [name, text] of yield* authoringBodies) {
      const directory = path.join(root, name)
      yield* fs.makeDirectory(directory, { recursive: true })
      const file = path.join(directory, "flow.mdx")
      const previous = yield* fs.readFileString(file).pipe(Effect.orElseSucceed(() => ""))
      if (previous !== text) yield* fs.writeFileString(file, text)
    }
    /*
     * The detected checks of a repository that declares none, written beside
     * the authoring bodies the same way. `checks/` under this root holds only
     * them, so a check this host no longer provisions is removed.
     */
    const checksRoot = path.join(root, "checks")
    const provisioned = new Set(checks.map((check) => check.flow))
    for (const entry of yield* fs.readDirectory(checksRoot).pipe(Effect.orElseSucceed(() => []))) {
      if (!provisioned.has(`checks/${entry}`)) {
        yield* fs.remove(path.join(checksRoot, entry), { recursive: true, force: true })
      }
    }
    for (const check of checks) {
      const directory = path.join(root, check.flow)
      yield* fs.makeDirectory(directory, { recursive: true })
      const file = path.join(directory, "flow.mdx"), text = checkBody(check)
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
    const reserved = yield* reservedRefusals(registry)
    yield* Effect.forEach(reserved, (failure) =>
      Effect.logWarning("repository flow name is reserved", {
        flow: failure.flow,
        path: failure.path,
        code: failure.code
      }))
    return {
      executables: [...project.executables, ...builtins.executables],
      refused: [...reserved, ...project.refused, ...builtins.refused]
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
    Layer.provideMerge(Layer.unwrap(Effect.gen(function*() {
      const registry = yield* Registry.Registry
      const services = yield* Layer.build(
        Executable.layerRefreshable(built, { ...options, refreshable: refreshableEntry })
      )
      const catalog = Context.get(services, Executable.Catalog)
      const refresh = Context.get(services, Executable.Refresh)
      let reserved = yield* reservedRefusals(registry)
      // Executable refresh preserves Fixed entries. Reconcile their collision
      // metadata separately, against the snapshot that refresh just discovered.
      const flow: Executable.Refresh["flow"] = (name) =>
        refresh.flow(name).pipe(
          Effect.tap(() =>
            reservedRefusals(registry).pipe(Effect.map((next) => {
              reserved = next
            }))
          )
        )
      const load: NonNullable<Executable.Catalog["load"]> = (name) =>
        Effect.suspend(() => {
          const refusal = reserved.find((entry) => entry.flow === name)
          return refusal !== undefined && !catalog.executables.some((entry) => entry.descriptor.name === name)
            ? Effect.fail(refusal)
            : catalog.load!(name)
        })
      return Layer.merge(
        Layer.succeed(Executable.Catalog, {
          get executables() {
            return catalog.executables
          },
          get refused() {
            return [...reserved, ...catalog.refused.filter((entry) => entry.code !== "reserved_name")]
          },
          load
        }),
        Layer.succeed(Executable.Refresh, { flow })
      )
    })))
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

/**
 * System names supplied by the backend always come from the measured host
 * bundle. Keep collision metadata separate from executable descriptors so a
 * reserved repository module is never passed to an import loader.
 */
const repositoryRefusals = Symbol("repositoryRefusals")
type RepositoryRegistry = Registry.Registry & {
  readonly [repositoryRefusals]?: Effect.Effect<ReadonlyArray<Executable.ExecutableError>>
}
// Keep the metadata on the service so structural wrappers retain it, rather
// than depending on the exact object identity a host supplied to the catalog.
const reservedRefusals = (registry: Registry.Registry) =>
  (registry as RepositoryRegistry)[repositoryRefusals] ?? Effect.succeed([])

export const bindRepositoryRegistry = (
  base: Registry.Registry,
  builtins: Registry.Registry,
  policy: string,
  systemFlows: ReadonlyArray<string>
): Registry.Registry => {
  // The `todo` composition (flows/todo/flow.ts) runs only from stack admission
  // with the real pinned-source and current-attempt providers (T-FLW-03/04,
  // T-FLW-11). Until they bind a launch to its attempt, no generic route may
  // reach it: refuse before module import, packaged or repository alike.
  const dark = (name: string) => name === "todo"
  const names = new Set(systemFlows)
  const bundled = (name: string) => names.has(name)
  // Legacy packaged delegates retain their codecs and policy fence. These
  // describe builtin schemas; they do not reserve repository names.
  const reservedSchemas = (descriptor: Descriptor.FlowDescriptor) =>
    descriptor.provenance.source !== "repository-host" ?
      undefined :
      descriptor.flows.includes("repository/RunSetup") ?
      { input: SetupInput, output: OperationResult }
      : descriptor.flows.includes("repository/RunTrigger")
      ? { input: TriggerRequest, output: TriggerOutcome }
      : descriptor.flows.includes("repository/RunJob")
      ? { input: JobInput, output: JobResult }
      : undefined
  const derived = (descriptor: Descriptor.FlowDescriptor) => {
    const schemas = reservedSchemas(descriptor)
    return schemas !== undefined ?
      new Descriptor.FlowDescriptor({
        ...descriptor,
        budget: { tokens: deploymentTokens, milliseconds: deploymentMinutes * 60000 },
        input: new Descriptor.SchemaRefInline({
          document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(schemas.input)))
        }),
        output: new Descriptor.SchemaRefInline({
          document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(schemas.output)))
        }),
        frontmatter: { ...descriptor.frontmatter, repositoryHostPolicy: policy }
      }) :
      descriptor
  }
  const owned = (name: string): Effect.Effect<Registry.Registry, RegistryError> =>
    dark(name)
      ? Effect.fail(
        registryError({
          code: "body_unavailable",
          method: "get",
          description: "TODO pinned-source activation is unavailable"
        })
      )
      : bundled(name)
      ? Effect.succeed(builtins)
      : base.getOption(name).pipe(Effect.map((found) => Option.isSome(found) ? base : builtins))
  const get = (name: string) => owned(name).pipe(Effect.flatMap((registry) => registry.get(name)), Effect.map(derived))
  const list = () =>
    Effect.all([base.list(), builtins.list()]).pipe(Effect.map(([project, defaults]) =>
      [
        ...project.filter((entry) => !dark(entry.name) && !bundled(entry.name)),
        ...defaults.filter((entry) =>
          !dark(entry.name) && (bundled(entry.name) || !project.some((candidate) => candidate.name === entry.name))
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
  const registry = Registry.Registry.of({
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
  return Object.assign(registry, {
    [repositoryRefusals]: base.list().pipe(
      Effect.map((entries) =>
        entries.filter((entry) => dark(entry.name) || bundled(entry.name)).map((entry) =>
          new Executable.ExecutableError({
            code: dark(entry.name) ? "missing_service" : "reserved_name",
            flow: entry.name,
            path: entry.path,
            available: [],
            message: dark(entry.name)
              ? "TODO pinned-source activation is unavailable"
              : `Repository flow "${entry.name}" uses a reserved system name`
          })
        )
      )
    )
  })
}
