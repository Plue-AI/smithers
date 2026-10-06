/**
 * The factory a repository declares in `.smithers/FACTORY.ts`, and the
 * projection the app reads: `.smithers/factory.json` and `.smithers/home.json`.
 *
 * `export const factory = S.Factory({...})` is how a repository configures
 * the factory that develops it: one `summary` line, the `flows` it features
 * ({@link Flow.Flow} declarations), the `on` table the Dispatcher listens
 * with, the `github` policy that says who writes `main`, and the `machine`
 * its TODO lanes need. `export const
 * home = S.Factory.Home({ blocks })` in the same file is the homepage
 * (`Home.ts`). The file sits beside `WORKSPACE.ts`, may import it, and never
 * imports a `PACKAGE.ts`: a target it needs is named by label
 * (`S.label("//:ci")`), never by value.
 *
 * `FACTORY.ts` is trusted executable code the build loader evaluates beside
 * the workspace declaration. What the Worker and the signed-out app read is
 * a projection the {@link FactoryProjection} target writes, in the shape the
 * generated `ci.yml` and root `tsconfig.json` already have: `write` renders
 * it, `check` fails on drift, and the `lint` verb never writes. Both files
 * are checked in, so the public mirror serves them through the contents
 * route and a workspace without `node_modules` never evaluates `FACTORY.ts`
 * to render a card.
 *
 * The target declared in a `PACKAGE.ts` carries no reference to the
 * declaration: the planner fills its `factory` and `home` attrs from the
 * loaded `FACTORY.ts` at plan time, the same way it fills a rule's runtime
 * and package manager from `WORKSPACE.ts`. A workspace without a factory
 * declaration fails the projection with the file it is missing.
 *
 * @since 1.0.0
 */

import { Action } from "@smthrs/flow"
import type * as Node from "@smthrs/plan/Node"
import * as Effect from "effect/Effect"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as SchemaIssue from "effect/SchemaIssue"
import * as Flow from "./Flow.ts"
import * as FlowCatalog from "./FlowCatalog.ts"
import { DriftError, resolveOutputPath, WriteFileError } from "./GeneratedFile.ts"
import * as Home from "./Home.ts"
import * as Input from "./Input.ts"
import * as Target from "./Target.ts"

/**
 * Where the declaration lives: beside `WORKSPACE.ts`.
 *
 * @category constants
 * @since 1.0.0
 */
export const declarationPath = ".smithers/FACTORY.ts"

/**
 * Where the factory projection is written.
 *
 * @category constants
 * @since 1.0.0
 */
export const projectionPath = ".smithers/factory.json"

/**
 * Where the homepage projection is written.
 *
 * @category constants
 * @since 1.0.0
 */
export const homePath = ".smithers/home.json"

/**
 * Maximum length of the factory's one-line summary.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumSummaryLength = 140

/**
 * Maximum length of one `on` key.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumEventLength = 256

const noHtml = Schema.makeFilter<string>(
  (text) => Home.htmlPattern.test(text) ? "must not contain HTML; declarations are values, never markup" : true
)

/**
 * The factory's one-line summary, shown on the repository card: non-empty,
 * one line, at most {@link maximumSummaryLength} characters, no HTML.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Summary = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumSummaryLength),
  Schema.isPattern(/^[^\r\n]*$/),
  noHtml
)

/**
 * The shape of an `on` key: a dotted lower-case event name with an optional
 * `:` argument, as the event vocabulary spells them: `issue.opened`,
 * `issue.labeled:smithers`, `change.landed`, `github.push:main`,
 * `schedule:0 9 * * 1-5`, `box.session.ended`, `nomination`, `manual`.
 *
 * @category constants
 * @since 1.0.0
 */
export const eventPattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*(?::[^\r\n]+)?$/

/**
 * One `on` key.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Event = Schema.NonEmptyString.check(
  Schema.isMaxLength(maximumEventLength),
  Schema.isPattern(eventPattern)
)

/**
 * One flow id a rule starts, in the shape discovery derives ids in.
 *
 * @category schemas
 * @since 1.0.0
 */
export const FlowId = Schema.NonEmptyString.check(
  Schema.isMaxLength(Flow.maximumIdLength),
  Schema.isPattern(Flow.idPattern)
)

/**
 * A flow id or a non-empty list of them.
 *
 * @category schemas
 * @since 1.0.0
 */
export const FlowIds = Schema.Union([FlowId, Schema.NonEmptyArray(FlowId)])

/**
 * The static payload a `schedule:` rule hands the flow it starts: a JSON
 * object, the same every time the schedule fires.
 *
 * @category schemas
 * @since 1.0.0
 */
export const SchedulePayload = Schema.Record(Schema.String, Schema.Json)

/**
 * One value of the `on` table: the flow or flows the event starts, bare or
 * with the sentence the Dispatcher card shows for the rule, and, on a
 * `schedule:` rule, the static `payload` each run starts with.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RuleValue = Schema.Union([
  FlowIds,
  Schema.Struct({
    flow: FlowIds,
    description: Schema.optional(Home.Title),
    payload: Schema.optional(SchedulePayload)
  })
])

/**
 * One value of the `on` table.
 *
 * @category models
 * @since 1.0.0
 */
export type RuleValue = typeof RuleValue.Type

/**
 * The `on` table: event key to the flow or flows it starts.
 *
 * @category schemas
 * @since 1.0.0
 */
export const On = Schema.Record(Event, RuleValue)

/**
 * Who writes `main` on GitHub: `push` when Smithers Cloud lands `main` and
 * pushes it to GitHub after every landing (ours), `pull` when GitHub writes
 * `main` and Smithers Cloud mirrors it (a third-party repository), `none`
 * when the repository has no GitHub remote.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Mirror = Schema.Literals(["push", "pull", "none"])

/**
 * How GitHub issues take part: read into the factory, two-way, or not at all.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Issues = Schema.Literals(["read", "two-way", "none"])

/**
 * What happens to a Change: `land` on Smithers Cloud (needs `mirror: "push"`),
 * `send-upstream` as a GitHub pull request a maintainer merges on GitHub
 * (refused with `mirror: "push"`), or `none`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Changes = Schema.Literals(["land", "send-upstream", "none"])

/**
 * An agent source that files issues under a person's account without that
 * person writing them: `run` (an agent run's credential), `linear` (the Linear
 * import) or `trial` (a repository job's live trial nobody pressed). Such an
 * issue starts credentialed work only with a maintainer's trigger label, or
 * when the policy lists its source in `agentIssueSources`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const AgentIssueSource = Schema.Literals(["run", "linear", "trial"])

/**
 * The GitHub policy, `S.Github.Policy({...})`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const GithubPolicy = Schema.TaggedStruct("GithubPolicy", {
  mirror: Mirror,
  issues: Issues,
  changes: Changes,
  protectedPaths: Schema.Array(Schema.String),
  reviewerAgents: Schema.Array(Schema.String),
  agentIssueSources: Schema.Array(AgentIssueSource),
  maintainers: Schema.Array(Schema.String),
  todoSince: Schema.optional(Schema.String),
  dailyTokens: Schema.optional(Schema.Int)
})

/**
 * The GitHub policy.
 *
 * @category models
 * @since 1.0.0
 */
export type GithubPolicy = typeof GithubPolicy.Type

/**
 * What a `FACTORY.ts` writes for the GitHub policy. Every field defaults to
 * the third-party posture: `mirror: "pull"`, `issues: "read"`,
 * `changes: "send-upstream"`. `protectedPaths` adds paths to the built-in
 * trust roots (CI, Smithers and agent configuration, the `FACTORY.ts`,
 * `PACKAGE.ts` and `AGENTS.md` declarations, the root install files, and the
 * local actions, scripts and workspace packages main's workflows run with
 * elevated trust) that a change started from an
 * outsider's issue never touches: a name without `/` matches at any depth, a
 * path with `/` matches from the repository root down. `reviewerAgents` names
 * the agent accounts whose LGTM counts toward `require_agent_lgtm`; no other
 * agent's does. `agentIssueSources` lets issues an agent source files start
 * credentialed work without a maintainer's trigger label. `maintainers` names
 * the GitHub logins the factory takes `todo` and `automerge` labels from;
 * anyone else's `todo` is taken off again. An issue one of them writes on or
 * after `todoSince` (an RFC 3339 time) becomes a TODO without the label: the
 * factory applies it, and the backlog from before stays proposals.
 * `dailyTokens` bounds the tokens the factory's lanes spend per UTC day; new
 * work waits for the next day.
 *
 * @category models
 * @since 1.0.0
 */
export interface GithubPolicyOptions {
  readonly mirror?: GithubPolicy["mirror"] | undefined
  readonly issues?: GithubPolicy["issues"] | undefined
  readonly changes?: GithubPolicy["changes"] | undefined
  readonly protectedPaths?: ReadonlyArray<string> | undefined
  readonly reviewerAgents?: ReadonlyArray<string> | undefined
  readonly agentIssueSources?: ReadonlyArray<typeof AgentIssueSource.Type> | undefined
  readonly maintainers?: ReadonlyArray<string> | undefined
  readonly todoSince?: string | undefined
  readonly dailyTokens?: number | undefined
}

/**
 * Declares the GitHub policy. `changes: "land"` is refused without
 * `mirror: "push"`, and `changes: "send-upstream"` with it: landing on
 * Smithers Cloud while GitHub writes `main`, or merging pull requests on
 * GitHub while Smithers Cloud pushes `main`, would be two writers of one
 * branch.
 *
 * @example
 * ```ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * const github = S.Github.Policy({ mirror: "push", issues: "two-way", changes: "land" })
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export const Policy = (options: GithubPolicyOptions = {}): GithubPolicy => {
  const plain = Home.plainOptions(
    "Github.Policy",
    options,
    new Set([
      "mirror",
      "issues",
      "changes",
      "protectedPaths",
      "reviewerAgents",
      "agentIssueSources",
      "maintainers",
      "todoSince",
      "dailyTokens"
    ])
  )
  const policy = Home.decode("Github.Policy", GithubPolicy, {
    _tag: "GithubPolicy",
    mirror: plain["mirror"] ?? "pull",
    issues: plain["issues"] ?? "read",
    changes: plain["changes"] ?? "send-upstream",
    protectedPaths: plain["protectedPaths"] ?? [],
    reviewerAgents: plain["reviewerAgents"] ?? [],
    agentIssueSources: plain["agentIssueSources"] ?? [],
    maintainers: plain["maintainers"] ?? [],
    ...(plain["todoSince"] === undefined ? {} : { todoSince: plain["todoSince"] }),
    ...(plain["dailyTokens"] === undefined ? {} : { dailyTokens: plain["dailyTokens"] })
  })
  if (
    policy.todoSince !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T[^ ]*(Z|[+-]\d{2}:\d{2})$/.test(policy.todoSince) ||
      Number.isNaN(Date.parse(policy.todoSince)))
  ) {
    throw new TypeError(`Github.Policy: todoSince ${JSON.stringify(policy.todoSince)} is not an RFC 3339 time`)
  }
  if (policy.dailyTokens !== undefined && policy.dailyTokens <= 0) {
    throw new TypeError("Github.Policy: dailyTokens must be positive")
  }
  for (
    const [field, logins] of [["reviewerAgents", policy.reviewerAgents], ["maintainers", policy.maintainers]] as const
  ) {
    for (const login of logins) {
      if (login.trim() !== login || login === "") {
        throw new TypeError(`Github.Policy: ${field} entry ${JSON.stringify(login)} is not a login`)
      }
    }
  }
  for (const entry of policy.protectedPaths) {
    if (entry.trim() !== entry || entry === "" || entry.startsWith("/") || entry.split("/").includes("..")) {
      throw new TypeError(
        `Github.Policy: protectedPaths entry ${JSON.stringify(entry)} is not a repository-relative path`
      )
    }
  }
  if (policy.changes === "land" && policy.mirror !== "push") {
    throw new TypeError(
      `Github.Policy: changes "land" requires mirror "push"; with mirror ${
        JSON.stringify(policy.mirror)
      } GitHub writes main and a Change is sent upstream`
    )
  }
  if (policy.changes === "send-upstream" && policy.mirror === "push") {
    throw new TypeError(
      `Github.Policy: changes "send-upstream" refuses mirror "push"; GitHub merges the pull request and writes main`
    )
  }
  return Home.freezeDeep(policy)
}

/**
 * The machine the factory's TODO lanes need: at least `vcpus` vCPUs and
 * `memoryMiB` MiB of memory, and the `tools` (executable names) the
 * repository's `.smithers/environment.nix` puts on `PATH`. A TODO runs only
 * on a lane machine that meets it: one booted from the repository's own
 * NixOS environment when the repository declares one, and never a smaller
 * machine. When none matches, the TODO stops with the reason.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Machine = Schema.Struct({
  vcpus: Schema.optionalKey(Schema.Int),
  memoryMiB: Schema.optionalKey(Schema.Int),
  tools: Schema.optionalKey(Schema.Array(Schema.String))
})

/**
 * The machine the factory's TODO lanes need.
 *
 * @category models
 * @since 1.0.0
 */
export type Machine = typeof Machine.Type

/** The largest vCPU count a machine may declare. */
const maximumMachineVcpus = 1024
/** The most memory a machine may declare, in MiB (4 TiB). */
const maximumMachineMemoryMiB = 4 * 1024 * 1024
/** The most tools a machine may name. */
const maximumMachineTools = 64
/** One executable name on `PATH`. */
const machineTool = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/

const decodeMachine = (value: unknown): Machine => {
  const plain = Home.plainOptions("Factory machine", value, new Set(["vcpus", "memoryMiB", "tools"]))
  const machine = Home.decode("Factory machine", Machine, plain)
  if (machine.vcpus !== undefined && (machine.vcpus < 1 || machine.vcpus > maximumMachineVcpus)) {
    throw new TypeError(`Factory machine: vcpus must be between 1 and ${maximumMachineVcpus}`)
  }
  if (machine.memoryMiB !== undefined && (machine.memoryMiB < 1 || machine.memoryMiB > maximumMachineMemoryMiB)) {
    throw new TypeError(`Factory machine: memoryMiB must be between 1 and ${maximumMachineMemoryMiB}`)
  }
  const tools = machine.tools ?? []
  if (tools.length > maximumMachineTools) {
    throw new TypeError(`Factory machine: tools names more than ${maximumMachineTools} tools`)
  }
  tools.forEach((tool, index) => {
    if (!machineTool.test(tool)) {
      throw new TypeError(`Factory machine: tools entry ${JSON.stringify(tool)} is not a tool name`)
    }
    if (tools.indexOf(tool) !== index) throw new TypeError(`Factory machine: tools names ${JSON.stringify(tool)} twice`)
  })
  return machine
}

/**
 * A saved issue view: a named filter over the repository's issue list, shown
 * in the app, TUI, CLI and API. `state` narrows the list to one state (`all`
 * or none keeps every state); `labels` keeps issues that carry every named
 * label. The id is how a surface selects it (`issues?view=<id>`).
 *
 * @category schemas
 * @since 1.0.0
 */
export const IssueView = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,63}$/)),
  title: Home.Title,
  state: Schema.optionalKey(Schema.Literals(["open", "closed", "fixed", "verified", "all"])),
  labels: Schema.optionalKey(Schema.Array(Schema.String))
})

/**
 * A saved issue view.
 *
 * @category models
 * @since 1.0.0
 */
export type IssueView = typeof IssueView.Type

/**
 * The most views a factory may declare.
 *
 * @category constants
 * @since 1.0.0
 */
export const maximumIssueViews = 32
/** The most labels one view may require. */
const maximumIssueViewLabels = 16

const decodeIssueViews = (value: unknown): ReadonlyArray<IssueView> => {
  if (!Array.isArray(value)) throw new TypeError("Factory issueViews must be an array of views")
  if (value.length > maximumIssueViews) {
    throw new TypeError(`Factory issueViews declares more than ${maximumIssueViews} views`)
  }
  const seen = new Set<string>()
  return value.map((entry, index) => {
    const name = `Factory issueViews[${index}]`
    const plain = Home.plainOptions(name, entry, new Set(["id", "title", "state", "labels"]))
    const view = Home.decode(name, IssueView, plain)
    if (seen.has(view.id)) throw new TypeError(`Factory issueViews declares the view ${JSON.stringify(view.id)} twice`)
    seen.add(view.id)
    const labels = view.labels ?? []
    if (labels.length > maximumIssueViewLabels) {
      throw new TypeError(`${name}: labels names more than ${maximumIssueViewLabels} labels`)
    }
    labels.forEach((label, at) => {
      if (label.trim() !== label || label === "" || label.length > 255) {
        throw new TypeError(`${name}: labels entry ${JSON.stringify(label)} is not a label name`)
      }
      if (labels.findIndex((other) => other.toLowerCase() === label.toLowerCase()) !== at) {
        throw new TypeError(`${name}: labels names ${JSON.stringify(label)} twice`)
      }
    })
    return view
  })
}

/**
 * The factory declaration `.smithers/FACTORY.ts` exports as `factory`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Declaration = Schema.TaggedStruct("FactoryDeclaration", {
  /** One line, shown on the repository card. */
  summary: Summary,
  /** The flows the repository presents, in declaration order. */
  flows: Schema.Array(Flow.Declaration),
  /** The Dispatcher table. */
  on: On,
  /** Who writes `main` and how Changes and issues move. */
  github: GithubPolicy,
  /** The machine the factory's TODO lanes need, when declared. */
  machine: Schema.optionalKey(Machine),
  /** The saved issue views, in declaration order, when declared. */
  issueViews: Schema.optionalKey(Schema.Array(IssueView))
})

/**
 * The factory declaration.
 *
 * @category models
 * @since 1.0.0
 */
export type Declaration = typeof Declaration.Type

/**
 * Reports whether a value is a factory declaration.
 *
 * @category guards
 * @since 1.0.0
 */
export const isFactoryDeclaration: (value: unknown) => value is Declaration = Schema.is(Declaration)

/**
 * What a `FACTORY.ts` writes for one `on` value: a flow id, a list of them,
 * or either under `flow` with the sentence the Dispatcher card shows. An
 * empty list is refused where it is written.
 *
 * @category models
 * @since 1.0.0
 */
export type RuleOptions =
  | string
  | ReadonlyArray<string>
  | {
    readonly flow: string | ReadonlyArray<string>
    readonly description?: string | undefined
    readonly payload?: Readonly<Record<string, unknown>> | undefined
  }

/**
 * What a `FACTORY.ts` writes for the factory.
 *
 * @category models
 * @since 1.0.0
 */
export interface FactoryOptions {
  readonly summary: string
  readonly flows?: ReadonlyArray<Flow.Declaration> | undefined
  readonly on?: Readonly<Record<string, RuleOptions>> | undefined
  readonly github?: GithubPolicy | undefined
  readonly machine?: Machine | undefined
  readonly issueViews?: ReadonlyArray<IssueView> | undefined
}

/**
 * Declares the factory.
 *
 * Every `flows` entry has to be a `Smithers.Flow` value, and no two may name
 * one flow; the `on` table's keys and values are validated against the event
 * and flow id shapes where they are written, a `machine` against its
 * bounds, and each `issueViews` entry against the view shape, with no id
 * declared twice. Whether a featured flow exists is decided when the projection is
 * rendered, because only discovery knows.
 *
 * @example
 * ```ts
 * // .smithers/FACTORY.ts
 * import { Smithers as S } from "@smthrs/targets"
 *
 * export const review = S.Flow({ flow: "review", summary: "Review the change.", featured: true })
 *
 * export const factory = S.Factory({
 *   summary: "How this repository develops itself.",
 *   flows: [review],
 *   on: { "change.opened": "review", "manual": ["review"] },
 *   github: S.Github.Policy({ mirror: "push", issues: "two-way", changes: "land" }),
 *   issueViews: [{ id: "bugs", title: "Open bugs", state: "open", labels: ["bug"] }]
 * })
 *
 * export const home = S.Factory.Home({ blocks: [S.Home.Flows({ title: "Try first" })] })
 * ```
 *
 * @category constructors
 * @since 1.0.0
 */
export const Factory = (options: FactoryOptions): Declaration => {
  const plain = Home.plainOptions(
    "Factory",
    options,
    new Set(["summary", "flows", "on", "github", "machine", "issueViews"])
  )
  const flows = plain["flows"] ?? []
  if (!Array.isArray(flows)) throw new TypeError("Factory flows must be an array of Smithers.Flow declarations")
  const seen = new Set<string>()
  flows.forEach((flow, index) => {
    if (!Flow.isFlowDeclaration(flow)) {
      throw new TypeError(`Factory flows[${index}] must be a Smithers.Flow declaration`)
    }
    if (seen.has(flow.flow)) throw new TypeError(`Factory declares the flow ${JSON.stringify(flow.flow)} twice`)
    seen.add(flow.flow)
  })
  const on = plain["on"] ?? {}
  if (typeof on !== "object" || on === null || Array.isArray(on)) {
    throw new TypeError("Factory on must be a record of event keys to flow ids")
  }
  // A record schema validates its values; the keys are the event vocabulary
  // and are checked one by one so a mis-spelt event is refused where it is
  // written, by name.
  for (const [event, value] of Object.entries(on)) {
    Home.decode(`Factory on key ${JSON.stringify(event)}`, Event, event)
    Home.decode(`Factory on[${JSON.stringify(event)}]`, RuleValue, value)
    if (
      typeof value === "object" && value !== null && !Array.isArray(value) &&
      (value as { readonly payload?: unknown }).payload !== undefined && !event.startsWith("schedule:")
    ) {
      throw new TypeError(
        `Factory on[${
          JSON.stringify(event)
        }] carries a payload; only a schedule: rule can (an event starts a flow with the event itself)`
      )
    }
  }
  const github = plain["github"] ?? Policy()
  if (!Schema.is(GithubPolicy)(github)) throw new TypeError("Factory github must be a Smithers.Github.Policy value")
  const machine = plain["machine"] === undefined ? undefined : decodeMachine(plain["machine"])
  const issueViews = plain["issueViews"] === undefined ? undefined : decodeIssueViews(plain["issueViews"])
  return Home.freezeDeep(Home.decode("Factory", Declaration, {
    _tag: "FactoryDeclaration",
    summary: plain["summary"],
    flows,
    on,
    github,
    ...(machine === undefined ? {} : { machine }),
    ...(issueViews === undefined ? {} : { issueViews })
  }))
}

/**
 * One row of the projected Dispatcher table: the event, the flow or flows it
 * starts, and the sentence the card shows when the declaration names one.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Rule = Schema.Struct({
  event: Event,
  flow: FlowIds,
  description: Schema.optional(Home.Title),
  payload: Schema.optional(SchedulePayload)
})

/**
 * One row of the projected Dispatcher table.
 *
 * @category models
 * @since 1.0.0
 */
export type Rule = typeof Rule.Type

/**
 * Flattens the `on` table to rows, in declaration order.
 *
 * @category constructors
 * @since 1.0.0
 */
export const rules = (declaration: Declaration): ReadonlyArray<Rule> =>
  Object.entries(declaration.on).map(([event, value]) =>
    typeof value === "string" || Array.isArray(value)
      ? { event, flow: value as Rule["flow"] }
      : {
        event,
        flow: (value as { readonly flow: Rule["flow"] }).flow,
        ...((value as { readonly description?: string }).description === undefined
          ? {}
          : { description: (value as { readonly description: string }).description }),
        ...((value as { readonly payload?: Rule["payload"] }).payload === undefined
          ? {}
          : { payload: (value as { readonly payload: NonNullable<Rule["payload"]> }).payload })
      }
  )

/**
 * The GitHub policy as the projection carries it: the fields without the tag.
 *
 * @category schemas
 * @since 1.0.0
 */
export const GithubProjection = Schema.Struct({
  mirror: Mirror,
  issues: Issues,
  changes: Changes,
  protectedPaths: Schema.optionalKey(Schema.Array(Schema.String)),
  reviewerAgents: Schema.optionalKey(Schema.Array(Schema.String)),
  agentIssueSources: Schema.optionalKey(Schema.Array(AgentIssueSource)),
  maintainers: Schema.optionalKey(Schema.Array(Schema.String)),
  todoSince: Schema.optionalKey(Schema.String),
  dailyTokens: Schema.optionalKey(Schema.Int)
})

/**
 * The document `.smithers/factory.json` holds: the summary, the flow catalog
 * rows (featured first, see {@link FlowCatalog.rows}), the Dispatcher rows,
 * the GitHub policy, the machine when one is declared, and the saved issue
 * views when any are.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Projection = Schema.Struct({
  summary: Summary,
  flows: Schema.Array(FlowCatalog.Row),
  on: Schema.Array(Rule),
  github: GithubProjection,
  machine: Schema.optionalKey(Machine),
  issueViews: Schema.optionalKey(Schema.Array(IssueView))
})

/**
 * The document `.smithers/factory.json` holds.
 *
 * @category models
 * @since 1.0.0
 */
export type Projection = typeof Projection.Type

const formatIssue = SchemaIssue.makeFormatterDefault()

/**
 * Renders the factory projection: two-space indentation and a trailing
 * newline, so the checked-in file diffs like a hand-written one.
 *
 * @category rendering
 * @since 1.0.0
 */
export const renderProjection = (declaration: Declaration, catalog: ReadonlyArray<FlowCatalog.Row>): string => {
  checkSchedulePayloads(declaration, catalog)
  return `${
    JSON.stringify(
      Schema.encodeSync(Projection)({
        summary: declaration.summary,
        flows: catalog,
        on: rules(declaration),
        github: {
          mirror: declaration.github.mirror,
          issues: declaration.github.issues,
          changes: declaration.github.changes,
          ...(declaration.github.protectedPaths.length > 0 ?
            { protectedPaths: declaration.github.protectedPaths }
            : {}),
          ...(declaration.github.reviewerAgents.length > 0 ?
            { reviewerAgents: declaration.github.reviewerAgents }
            : {}),
          ...(declaration.github.agentIssueSources.length > 0 ?
            { agentIssueSources: declaration.github.agentIssueSources }
            : {}),
          ...(declaration.github.maintainers.length > 0 ? { maintainers: declaration.github.maintainers } : {}),
          ...(declaration.github.todoSince === undefined ? {} : { todoSince: declaration.github.todoSince }),
          ...(declaration.github.dailyTokens === undefined ? {} : { dailyTokens: declaration.github.dailyTokens })
        },
        ...(declaration.machine === undefined ? {} : { machine: declaration.machine }),
        ...(declaration.issueViews === undefined || declaration.issueViews.length === 0 ?
          {}
          : { issueViews: declaration.issueViews })
      }),
      null,
      2
    )
  }\n`
}

/**
 * Refuses a `schedule:` payload the flow it starts could not accept, by the
 * schema the catalog carries for it: a Markdown flow takes `{ args: string }`
 * and nothing else. A module flow's payload schema is not in the catalog, so
 * its payload is decoded against that schema when the run is admitted, and a
 * mismatch fails the run there by name.
 */
const checkSchedulePayloads = (declaration: Declaration, catalog: ReadonlyArray<FlowCatalog.Row>) => {
  for (const rule of rules(declaration)) {
    if (rule.payload === undefined) continue
    const ids = typeof rule.flow === "string" ? [rule.flow] : rule.flow
    for (const id of ids) {
      const found = catalog.find((flow) => flow.id === id)
      if (found === undefined || found.kind !== "mdx") continue
      const fields = Object.keys(rule.payload)
      if (
        fields.some((field) => field !== "args") || (fields.length === 1 && typeof rule.payload["args"] !== "string")
      ) {
        throw new FlowCatalog.FlowCatalogError({
          message: `Factory on[${JSON.stringify(rule.event)}] payload does not fit the flow ${
            JSON.stringify(id)
          }: a Markdown flow takes { args: string } and nothing else`
        })
      }
    }
  }
}

/**
 * Reads a rendered projection back, or reports why the text is not one.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseProjection = (text: string): Projection | string => {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (cause) {
    return `the factory projection is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`
  }
  const result = Schema.decodeUnknownResult(Projection)(value)
  return Result.isFailure(result)
    ? `the factory projection does not have the ${projectionPath} shape: ${formatIssue(result.failure.issue)}`
    : result.success
}

/**
 * The projection could not be rendered: the workspace declares no factory,
 * or the homepage file disagrees with the declaration's exports.
 *
 * @category errors
 * @since 1.0.0
 */
export class FactoryProjectionError extends Schema.TaggedError<FactoryProjectionError>()(
  "smithers-build/FactoryProjectionError",
  {
    message: Schema.NonEmptyString
  }
) {}

/**
 * Output handling for the projection. `check` is the default: only a target
 * that asks to `write`, or an executor run with `--write`, touches the files.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Mode = Schema.Literals(["write", "check"]).pipe(
  Schema.withConstructorDefault(Effect.succeed("check" as const))
)

/**
 * Output handling for the projection.
 *
 * @category models
 * @since 1.0.0
 */
export type Mode = typeof Mode.Type

/**
 * Payload for one projection: where discovery walks, where the two files go,
 * whether to write or check, and the loaded declarations. `factory` is null
 * when the workspace has no `FACTORY.ts`; `home` is null when the file
 * exports none.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Payload = Schema.Struct({
  root: Schema.NonEmptyString,
  output: Schema.NonEmptyString,
  homeOutput: Schema.NonEmptyString,
  mode: Schema.Literals(["write", "check"]),
  factory: Schema.NullOr(Declaration),
  home: Schema.NullOr(Home.Declaration)
})

/**
 * Payload for one projection.
 *
 * @category models
 * @since 1.0.0
 */
export type Payload = typeof Payload.Type

/**
 * Discovers the flows under `root`, joins the factory's declarations, and
 * writes or checks both projection files. Implemented by the executor, which
 * owns the registry's discovery.
 *
 * @category actions
 * @since 1.0.0
 */
export const FactoryProjectionAction = Action.make("smithers-build/factory-projection", {
  payload: Payload,
  error: Schema.Union([WriteFileError, DriftError, FlowCatalog.FlowCatalogError, FactoryProjectionError]),
  tier: "sealed"
})

/**
 * Attributes for {@link FactoryProjection}.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Attrs = Schema.Struct({
  /** The workspace-relative directory discovery walks. @default "flows" */
  root: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed("flows"))),
  /** The workspace-relative declaration file the check is keyed on. @default ".smithers/FACTORY.ts" */
  declaration: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(declarationPath))),
  /** The workspace-relative file the factory projection is written to. @default ".smithers/factory.json" */
  output: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(projectionPath))),
  /** The workspace-relative file the homepage is written to. @default ".smithers/home.json" */
  homeOutput: Schema.NonEmptyString.pipe(Schema.withConstructorDefault(Effect.succeed(homePath))),
  /** Whether to write the files or verify the checked-in copies. @default "check" */
  mode: Mode,
  /** The loaded factory declaration; filled by the planner from `FACTORY.ts`, never written in a `PACKAGE.ts`. */
  factory: Schema.optional(Declaration),
  /** The loaded home declaration; filled by the planner from `FACTORY.ts`, never written in a `PACKAGE.ts`. */
  home: Schema.optional(Home.Declaration)
})

/**
 * Attributes for {@link FactoryProjection}.
 *
 * @category models
 * @since 1.0.0
 */
export type Attrs = typeof Attrs.Type

const entryGlobs = (root: string): ReadonlyArray<Input.Declared> =>
  ["flow.ts", "flow.mdx", "SKILL.md"].map((entry) => Input.glob(`//${resolveOutputPath(root)}/**/${entry}`))

/**
 * The factory projection target.
 *
 * `check` is cacheable and keyed on the declaration file, the entry files
 * discovery reads, and both checked-in projections, so editing any of them
 * re-keys the check. The `lint` verb maps `write` to `check`, so no lint or
 * `ci` run mutates the files; the executor's `--write` flips `check` to
 * `write`. The declaration itself is not an attr a `PACKAGE.ts` writes: the
 * planner fills `factory` and `home` from the loaded `FACTORY.ts`.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * const factoryProjection = Smithers.FactoryProjection({
 *   summary: "Regenerate and drift-check .smithers/factory.json and .smithers/home.json from FACTORY.ts.",
 *   featured: true
 * })
 * ```
 *
 * @category targets
 * @since 1.0.0
 */
export const FactoryProjection = Target.make("FactoryProjection", {
  attrs: Attrs,
  kinds: ["build", "lint"],
  error: Schema.Union([WriteFileError, DriftError, FlowCatalog.FlowCatalogError, FactoryProjectionError]),
  cache: (attrs) => attrs.mode !== "write",
  inputs: (attrs) => [
    ...entryGlobs(attrs.root),
    Input.file(`//${resolveOutputPath(attrs.declaration)}`),
    ...(attrs.mode === "write"
      ? []
      : [
        Input.file(`//${resolveOutputPath(attrs.output)}`),
        Input.file(`//${resolveOutputPath(attrs.homeOutput)}`)
      ])
  ],
  outputs: (attrs) => ({
    cwd: ".",
    paths: attrs.mode === "write" ? [resolveOutputPath(attrs.output), resolveOutputPath(attrs.homeOutput)] : []
  }),
  attrsForKind: (kind, attrs) =>
    kind === "lint" && attrs.mode === "write" ? { ...attrs, mode: "check" as const } : attrs,
  implementation: (
    attrs
  ): Node.Node<
    void,
    WriteFileError | DriftError | FlowCatalog.FlowCatalogError | FactoryProjectionError,
    Action.Requirement<"smithers-build/factory-projection">
  > =>
    FactoryProjectionAction.call({
      root: resolveOutputPath(attrs.root),
      output: resolveOutputPath(attrs.output),
      homeOutput: resolveOutputPath(attrs.homeOutput),
      mode: attrs.mode,
      factory: attrs.factory ?? null,
      home: attrs.home ?? null
    })
})
