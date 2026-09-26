/**
 * The organization host: the three organization flows on the durable native
 * engine, behind the standard control gateway.
 *
 * One composition, one implementation table. The flows' steps are the
 * organization package's actions (roster pinning, composition, role tasks
 * under `Authority.layer`, microVM workspaces, receipts), its gates, this
 * directory's own steps, and Slack replies when a Slack app is configured.
 * Role tasks resolve seats on the owner's subscriptions (or API keys when
 * configured); microVMs are local
 * Microsandbox machines, labelled with this installation and this process,
 * and the machines a dead host process left behind are reaped at startup.
 */
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Agent from "@smthrs/agent/Agent"
import * as SeatResolver from "@smthrs/agent/SeatResolver"
import { Action, Flow, FlowRuntime, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Executable from "@smthrs/registry/Executable"
import * as Registry from "@smthrs/registry/Registry"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"
import * as SlackActions from "../../packages/smithers/agent/integrations/src/slack/Actions.ts"
import * as SlackConnections from "../../packages/smithers/agent/integrations/src/slack/Connections.ts"
import * as Actions from "../../packages/smithers/agent/organization/src/Actions.ts"
import * as Authority from "../../packages/smithers/agent/organization/src/Authority.ts"
import * as Budgets from "../../packages/smithers/agent/organization/src/Budgets.ts"
import * as GatesLive from "../../packages/smithers/agent/organization/src/GatesLive.ts"
import * as RoleHost from "../../packages/smithers/agent/organization/src/RoleHost.ts"
import * as Workspace from "../../packages/smithers/agent/organization/src/Workspace.ts"
import type * as MicrosandboxSandbox from "../../packages/smithers/flows/sandbox/src/MicrosandboxSandbox/index.ts"
import * as NativeControl from "../../packages/smithers/src/internal/NativeControl.ts"
import * as SupervisorMemory from "../../packages/smithers/src/internal/SupervisorMemory.ts"
import * as OrganizationActions from "./actions.ts"
import deliver from "./deliver/flow.ts"
import delegate from "./delegate/flow.ts"
import hire from "./hire/flow.ts"
import intake from "./intake/flow.ts"
import type { Settings } from "./settings.ts"
import * as Subscriptions from "./setup/subscriptions.ts"
import qualify from "./qualify/flow.ts"
import retire from "./retire/flow.ts"
import * as Staff from "./staff.ts"
import * as Meetings from "./meetings.ts"
import meetingsBook from "./meetings-book/flow.ts"
import teamReply from "./team-reply/flow.ts"
import * as TeamChannel from "./team-channel.ts"
import meetingsFollowUp from "./meetings-follow-up/flow.ts"
import meetingsOpen from "./meetings-open/flow.ts"
import meetingsPlan from "./meetings-plan/flow.ts"
import meetingsPrepare from "./meetings-prepare/flow.ts"
import meetingsReply from "./meetings-reply/flow.ts"
import * as Schedule from "./schedule.ts"
import status from "./status/flow.ts"
import * as Autonomy from "./autonomy.ts"
import * as Links from "./links.ts"
import assignment from "./assignment/flow.ts"
import digest from "./digest/flow.ts"
import routine from "./routine/flow.ts"
import work from "./work/flow.ts"
import workItem from "./work-item/flow.ts"
import * as Wiki from "./wiki.ts"

/**
 * The flows a client may start, by the name their paths give them.
 * `organization/deliver` is registered but not listed: it runs only as the
 * child of an intake, whose admission the host decided, so no client can
 * hand it a policy, a branch, or a principal of its own.
 */
export const flows = [
  ["intake", intake],
  ["status", status],
  ["qualify", qualify],
  ["hire", hire],
  ["delegate", delegate],
  ["retire", retire],
  ["meetings-plan", meetingsPlan],
  ["meetings-prepare", meetingsPrepare],
  ["meetings-open", meetingsOpen],
  ["meetings-follow-up", meetingsFollowUp],
  ["meetings-reply", meetingsReply],
  ["meetings-book", meetingsBook],
  ["work", work],
  ["routine", routine],
  ["digest", digest],
  ["team-reply", teamReply]
] as const

/** Every flow the host registers with its engine. */
const registered = [
  intake,
  deliver,
  status,
  qualify,
  hire,
  delegate,
  retire,
  meetingsPlan,
  meetingsPrepare,
  meetingsOpen,
  meetingsFollowUp,
  meetingsReply,
  meetingsBook,
  teamReply,
  work,
  workItem,
  assignment,
  routine,
  digest
] as const

/** Everything the host was started with. */
export interface Options {
  readonly settings: Settings
  /** The Microsandbox SDK module the workspaces boot machines with. */
  readonly sdk: MicrosandboxSandbox.Sdk
  /** This process's holder label; machines carrying another dead holder are reaped. */
  readonly holder: string
  /** Whether a Slack app is configured; its replies need the Slack actions. */
  readonly slack: boolean
  /** The process environment over `.env`: it carries the Slack tokens, so it is never logged. */
  readonly environment: Readonly<Record<string, string | undefined>>
  /** The gateway's bearer credential; its principal may decide what the local operator may. */
  readonly credential: string
  /** Renders what the host posts to Slack with links; {@link linksOf} the settings when absent. */
  readonly links?: Links.Linker | undefined
}

const sha = (value: string) => createHash("sha256").update(value).digest("hex")

/**
 * The repository the durable engine snapshots around each compensable step:
 * an empty jj repository in the state directory, never the organization's
 * wiki. No role acts on the host (a builder works in its microVM, whose own
 * snapshot boundary compensates its edits), so those snapshots must not
 * reach, or restore over, the wiki the receipts are written to. `serve`
 * creates it.
 */
export const executionRoot = (settings: Pick<Settings, "stateDir">) => join(settings.stateDir, "execution")

/** Where the catalog files are now: under the state directory. */
const catalogDirectory = (settings: Pick<Settings, "stateDir">) => join(settings.stateDir, "catalog")

/**
 * Where the catalog's descriptors say their files are: the catalog directory
 * at the host's first start, recorded in `catalog/root`. A descriptor's paths
 * are part of every run's approved flow identity, so a state directory
 * restored somewhere else keeps them, and its parked runs resume.
 */
export const catalogRoot = async (settings: Pick<Settings, "stateDir">) => {
  const directory = catalogDirectory(settings)
  await mkdir(directory, { recursive: true })
  const file = join(directory, "root")
  try {
    await writeFile(file, `${directory}\n`, { flag: "wx", mode: 0o444 })
    return directory
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
    return (await readFile(file, "utf8")).trim()
  }
}

/**
 * The host services, reading a catalog file named under `root` from where
 * the catalog is now. Unchanged when the state directory never moved.
 */
const relocated = (host: Layer.Layer<NodeServices.NodeServices>, root: string, directory: string) =>
  root === directory ? host : Layer.effectContext(
    Effect.map(Effect.context<NodeServices.NodeServices>(), (context) => {
      const fs = Context.get(context, FileSystem.FileSystem)
      const moved = (path: string) => path.startsWith(`${root}/`) ? join(directory, path.slice(root.length + 1)) : path
      return Context.add(context, FileSystem.FileSystem, { ...fs, readFile: (path) => fs.readFile(moved(path)) })
    })
  ).pipe(Layer.provide(host))

/** The host's catalog: one descriptor per organization flow, pinned under the state directory. */
export const catalog = async (options: Pick<Options, "settings">) => {
  const directory = catalogDirectory(options.settings)
  const root = await catalogRoot(options.settings)
  return Promise.all(flows.map(async ([name, declaration]) => {
    const file = join(directory, `${name}.json`)
    const path = join(root, `${name}.json`)
    const source = JSON.stringify({ flow: `organization/${name}`, version: 1 })
    try {
      await writeFile(file, source, { flag: "wx", mode: 0o444 })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      if (await readFile(file, "utf8") !== source) throw new Error("Organization flow identity was modified; refusing to serve")
    }
    const descriptor = new Descriptor.FlowDescriptor({
      name: `organization/${name}`,
      description: declaration.description ?? "",
      path,
      body: new Descriptor.BodyRefModule({ path, contentDigest: sha(source) }),
      input: new Descriptor.SchemaRefInline({
        document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(declaration.payloadSchema)))
      }),
      output: new Descriptor.SchemaRefInline({
        document: JSON.parse(JSON.stringify(Schema.toJsonSchemaDocument(declaration.successSchema)))
      }),
      model: Option.none(),
      flows: [],
      capabilities: Context.get(declaration.annotations, Flow.Capabilities),
      effects: Schema.decodeUnknownSync(Descriptor.EffectDeclaration)(
        Option.getOrThrow(Context.getOption(declaration.annotations, Flow.EffectEnvelope))
      ),
      placement: Option.none(),
      // The declarations say `modelInvocable: false` so another host scanning
      // this repository does not offer them; this host implements them.
      modelInvocable: true,
      frontmatter: {},
      provenance: new Descriptor.Provenance({ source: "organization", root })
    })
    return { descriptor, declaration }
  }))
}

/** The role hosts' shared resources: a memory store in the state directory, the wiki, and the judge setting. */
const resources = (platform: NativeControl.Platform, settings: Settings) =>
  Layer.unwrap(Effect.gen(function*() {
    const memory = yield* Layer.build(SupervisorMemory.layer({
      environment: { SMITHERS_MEMORY_DB: join(settings.stateDir, "memory.db") },
      database: platform.database,
      crypto: platform.crypto
    }))
    const files = yield* Layer.build(NodeServices.layer)
    return RoleHost.layerResources({
      memory,
      // Role edits never reach an authority or configuration page, never
      // overwrite the owner's uncommitted work, and are committed as theirs.
      wiki: {
        root: settings.root,
        services: files,
        protected: RoleHost.protectedWikiPaths(settings.organization),
        journal: Wiki.journal(settings.root, settings.organization.wiki.commit)
      },
      retrieval: { logDir: join(settings.stateDir, "retrieval") },
      // A role result is an answer, not a workspace claim, when no judge is configured.
      ...(settings.organization.judge === "none" ? { claimCap: 0 } : {})
    })
  }))

/** Runs `effect` with the completion brake that demands a workspace change disarmed. */
const withoutUnmoved = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.flatMap(Effect.serviceOption(Agent.Agent), (agent) =>
    Option.isNone(agent) ? effect : effect.pipe(Effect.provideService(Agent.Agent, {
      ...agent.value,
      run: (options: Agent.Options) => agent.value.run({ ...options, unmovedCap: 0 })
    })))

/** Role tasks this host runs at once when `SMITHERS_ORG_MAX_CONCURRENT_TASKS` does not say. */
export const defaultMaxConcurrentTasks = 4

/** The host's cap on concurrent role tasks, from `SMITHERS_ORG_MAX_CONCURRENT_TASKS`. */
export const maxConcurrentTasks = (environment: Readonly<Record<string, string | undefined>>): number => {
  const text = environment.SMITHERS_ORG_MAX_CONCURRENT_TASKS
  if (text === undefined || text.trim() === "") return defaultMaxConcurrentTasks
  const parsed = Number(text)
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 64) {
    throw new Error("SMITHERS_ORG_MAX_CONCURRENT_TASKS must be an integer from 1 to 64")
  }
  return parsed
}

/**
 * Role tasks under their principal's budget (`Budgets.layer`: daily tasks
 * charged up the hiring chain, tokens per task over the run's budget, the
 * principal's and the host's concurrency), with the unmoved brake disarmed.
 * The brake measures the host's served root, where no role acts: a builder
 * acts in its machine and every other role answers. The flow checks each
 * result against its charter, and the diff and the checks are what judge a
 * build.
 */
const roleTasks = (tasks: number) => Authority.layer(Budgets.layer(Actions.RoleTask.layer, { maxConcurrentTasks: tasks })).pipe(
  Layer.provide(Layer.unwrap(Effect.gen(function*() {
    const runtime = yield* FlowRuntime.FlowRuntime
    const table = yield* Action.Implementations
    return Layer.mergeAll(
      Layer.succeed(FlowRuntime.FlowRuntime)({
        ...runtime,
        register: (flow, handler) =>
          runtime.register(
            flow,
            flow._tag === Authority.roleTaskTag
              ? (payload, executionId) => withoutUnmoved(handler(payload, executionId))
              : handler
          )
      }),
      Layer.succeed(Action.Implementations)({
        ...table,
        add: (implementation, options) =>
          table.add(
            implementation.name === Authority.roleTaskTag
              ? { ...implementation, action: (payload) => withoutUnmoved(implementation.action(payload)) }
              : implementation,
            options
          )
      })
    )
  })))
)

/** A configured repository's GitHub repository: the page's `github`, else its own name when that is `owner/name`. */
const githubOf = (settings: Settings, name: string): string | undefined => {
  const entry = settings.organization.repositories?.[name]
  return entry?.github ?? (/^[^/]+\/[^/]+$/.test(name) ? name : undefined)
}

/** The configured repositories whose landed branches become pull requests. */
export const pullsOf = (settings: Settings): Record<string, { readonly remote: string; readonly github: string }> =>
  Object.fromEntries(Object.keys(settings.repositories).flatMap((name) => {
    const entry = settings.organization.repositories?.[name]
    const github = githubOf(settings, name)
    return entry?.landing === "pr" && github !== undefined ? [[name, { remote: entry.remote ?? "origin", github }]] : []
  }))

/**
 * The host's linker (`links.ts`): the wiki's pages at `wiki.webUrl` or its
 * GitHub upstream, pushed first when the page has `wiki.commit` and
 * `wiki.sync: push`; the configured repositories' issues, pull requests,
 * commits and branches on GitHub.
 */
export const linksOf = (settings: Settings): Links.Linker => {
  const wiki = settings.organization.wiki
  return Links.make({
    root: settings.root,
    stateDir: settings.stateDir,
    generatedDir: wiki.generatedDir,
    webUrl: wiki.webUrl,
    publish: wiki.commit && wiki.sync === "push" ? Wiki.hostPaths(settings.organization) : undefined,
    repositories: Object.fromEntries(Object.entries(settings.repositories).map(([name, path]) => [name, {
      path,
      github: githubOf(settings, name),
      remote: settings.organization.repositories?.[name]?.remote
    }]))
  })
}

/** The teams' pages, where the organization page does not say otherwise. */
export const teamDirs = (settings: Settings) => ({
  teamDir: settings.organization.autonomy?.teamDir ?? "Org/Team",
  proposalsDir: settings.organization.autonomy?.proposalsDir ?? "Org/Proposals",
  requestsDir: settings.organization.autonomy?.requestsDir ?? "Org/Requests"
})

/** What the organization's own work needs from the host's settings. */
const autonomyOf = (settings: Settings, options: Options): Autonomy.Options => ({
  root: settings.root,
  stateDir: settings.stateDir,
  generatedDir: settings.organization.wiki.generatedDir,
  statusFile: settings.organization.wiki.statusFile,
  assistant: settings.organization.assistant,
  triage: settings.organization.autonomy?.triage,
  ...teamDirs(settings),
  repositories: settings.repositories,
  bases: Object.fromEntries(Object.entries(settings.environments).flatMap(([name, environment]) => environment.base === undefined ? [] : [[name, environment.base]])),
  autonomy: Object.fromEntries(Object.keys(settings.repositories).flatMap((name) => {
    const github = githubOf(settings, name)
    const issues = settings.organization.repositories?.[name]?.issues
    return github === undefined ? [] : [[name, { github, ...(issues === undefined ? {} : { issues }) }]]
  })),
  environment: options.environment,
  owner: options.slack ? settings.owners[0] : undefined,
  links: options.links ?? linksOf(settings)
})

/**
 * The schedule of the organization's own work: the intake and the digest
 * when the organization page has an autonomy section, and every routine. A
 * once or onboarding routine fires at its instant (an onboarding routine
 * without one a minute after the host first saw it), or at the next minute
 * when that passed while the host was down; one that ran is registered
 * disabled.
 */
export const declarations = (settings: Settings, now: number): ReadonlyArray<Schedule.Declaration> => {
  const autonomy = settings.organization.autonomy
  const snapshot = settings.snapshot
  const core = [...snapshot.roster.profiles.values()]
    .filter((profile) => profile.status === "active" && profile.kind === "core")
    .map((profile) => profile.id)
  const triage = autonomy?.triage ?? settings.organization.assistant
  const next = now + 60_000
  const routines = settings.routines.map((entry) => {
    const input = { routine: entry, roles: entry.onboarding === true ? entry.roles ?? core : [], triage }
    if (entry.cron !== undefined) return { routine: entry, input }
    const ledger = Autonomy.readLedger(settings.stateDir)
    if (ledger.routines[entry.id] !== undefined) return { routine: entry, input, at: null }
    const declared = entry.once === undefined
      ? Autonomy.updateLedger(settings.stateDir, (current) => current.firstSeen[entry.id] ??= next)
      : Date.parse(entry.once)
    return { routine: entry, input, at: Math.max(declared, Math.ceil(next / 60_000) * 60_000) }
  })
  return Schedule.autonomyTriggers({
    ...(autonomy === undefined ? {} : {
      intake: { ...(autonomy.intake ?? { cron: "*/30 * * * *", timezone: "UTC" }), max: autonomy.maxConcurrent ?? 1 },
      digest: autonomy.digest ?? { cron: "0 18 * * *", timezone: "America/Los_Angeles" }
    }),
    routines
  })
}

/** The organization's actions, gates, role tasks, and flows, registered over one implementation table. */
const registrations = (
  platform: NativeControl.Platform,
  options: Options,
  triggers: ReturnType<typeof Schedule.store>
) => {
  const { settings } = options
  const organization = settings.organization
  const machines = Workspace.microsandbox({
    sdk: options.sdk,
    image: organization.vm.image ?? "node:26-bookworm",
    cpus: organization.vm.cpus,
    memoryMib: organization.vm.memoryMib,
    diskMib: organization.vm.diskMib,
    network: organization.vm.network === true,
    owner: settings.installation,
    holder: options.holder
  })
  const slack = options.slack
    ? SlackActions.layer.pipe(
      Layer.provide(SlackConnections.layerFromEnvironment({ containers: ["*"] }, options.environment))
    )
    : Layer.empty
  const links = options.links ?? linksOf(settings)
  return Layer.mergeAll(
    Actions.layer({
      repositories: settings.repositories,
      wiki: { root: settings.root, generatedDir: organization.wiki.generatedDir }
    }),
    roleTasks(maxConcurrentTasks(options.environment)),
    GatesLive.layer({ review: Actions.reviewHandler() }),
    OrganizationActions.layer({
      root: settings.root,
      assistant: organization.assistant,
      repositories: settings.repositories,
      gates: settings.policy,
      checks: settings.checks,
      owners: settings.owners,
      maxRounds: settings.maxRounds,
      generatedDir: organization.wiki.generatedDir,
      statusFile: organization.wiki.statusFile,
      pulls: pullsOf(settings),
      environment: options.environment,
      links
    }),
    Autonomy.layer(autonomyOf(settings, { ...options, links }), platform),
    Staff.layer({
      root: settings.root,
      rosterDir: organization.rosterDir,
      weeklyMeeting: organization.weeklyMeeting ?? false,
      hireSeats: organization.hireSeats,
      generatedDir: organization.wiki.generatedDir
    }),
    Meetings.layer({
      root: settings.root,
      stateDir: settings.stateDir,
      generatedDir: organization.wiki.generatedDir,
      meetingsFile: organization.meetingsFile,
      assistant: organization.assistant,
      owner: options.slack ? settings.owners[0] : undefined,
      environment: options.environment,
      calendar: Meetings.calendarOf(options.environment),
      links
    }),
    slack,
    TeamChannel.layer({
      root: settings.root,
      stateDir: settings.stateDir,
      teamDir: organization.autonomy?.teamDir ?? "Org/Team",
      environment: options.environment,
      assistant: organization.assistant,
      links
    }),
    ...registered.map((declaration) => Interpreter.layer(declaration as never))
  ).pipe(
    Layer.provideMerge(Layer.mergeAll(
      Authority.layerRegistry(settings.snapshot),
      triggers,
      Budgets.layerLedgerFile({ file: join(settings.stateDir, "budget-ledger.json") }).pipe(
        Layer.provide(NodeServices.layer)
      ),
      resources(platform, settings),
      Workspace.layer({
        machines,
        maxConcurrentVMs: settings.maxConcurrentVMs,
        // The workspaces know repositories by host path; the page names them.
        environments: Object.fromEntries(
          Object.entries(settings.environments).map(([name, environment]) => [settings.repositories[name]!, environment])
        )
      }).pipe(
        Layer.provide(NodeServices.layer)
      )
    )),
    Layer.provide(NodeServices.layer)
  )
}

/**
 * The host layer: the native control plane and gateway over the state
 * directory, with the organization flows registered. `seats` replaces the
 * environment's seat resolver, for an offline composition.
 */
export const layer = (platform: NativeControl.Platform, options: Options, seats?: SeatResolver.Service) => {
  const { settings } = options
  // The engine's per-step jj snapshots go to the execution repository, so
  // they never reach, or restore over, the wiki the receipts are written to.
  const native = NativeControl.make(
    { ...platform, jj: () => platform.jj(executionRoot(settings)) },
    // Seats resolve on the owner's subscriptions unless the host was told to
    // use API keys (`setup/subscriptions.ts`), from the host's own environment.
    () =>
      seats === undefined
        ? Layer.effect(SeatResolver.SeatResolver)(
          Effect.map(RequestExecutor.RequestExecutor, (executor) => Subscriptions.resolver(options.environment, executor))
        )
        : SeatResolver.layer(seats)
  )
  const judge = settings.organization.judge === "none"
    ? Evaluator.layerUnavailable()
    : Evaluator.layerFromEnvironment(options.environment, "smithers organization serve").pipe(
      Layer.provide(platform.httpClient)
    )
  const catalogued = Effect.promise(async () => ({
    entries: await catalog(options),
    root: await catalogRoot(settings)
  }))
  const triggers = Schedule.store(platform, settings.stateDir)
  return Layer.unwrap(catalogued.pipe(Effect.map(({ entries, root }) => {
    const host = relocated(platform.host, root, catalogDirectory(settings))
    const registry = Registry.layerFromDescriptors(entries.map((entry) => entry.descriptor)).pipe(
      Layer.provide(host)
    )
    // Each module default-exports the flow it declares, so nothing is
    // registered by name and nothing is loaded from disk.
    const executableOptions: Executable.RefreshOptions = {
      delegates: [],
      refreshable: () => false,
      load: (path) => {
        const entry = entries.find((candidate) => candidate.descriptor.path === path)
        return entry === undefined
          ? Effect.fail(new Error("Unknown organization flow"))
          : Effect.succeed({ default: entry.declaration })
      }
    }
    const modules = Layer.unwrap(Executable.catalog(executableOptions).pipe(
      Effect.provide(host),
      Effect.map((built) =>
        Layer.mergeAll(
          Executable.layerRefreshable(built, executableOptions),
          ...built.executables.map((executable) => executable.layer)
        )
      )
    )).pipe(
      Layer.provideMerge(registrations(platform, options, triggers)),
      Layer.provide(registry),
      Layer.orDie
    )
    // The dynamically built catalog layer erases its requirement set; every
    // service it names is one the registration phase provides.
    const served = native.layerHost(
      { root: settings.root, stateRoot: settings.stateDir, evaluator: judge, credential: options.credential },
      modules as unknown as NativeControl.ModuleRegistration,
      registry
    )
    // The scheduler launches through the served control plane.
    return Schedule.layer({ declarations: declarations(settings, Date.now()) }).pipe(Layer.provide(triggers), Layer.provideMerge(served))
  })))
}
