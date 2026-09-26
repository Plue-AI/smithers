/**
 * The organization's configuration pages, parsed from the private wiki.
 *
 * Five Markdown pages configure a host. Each keeps its settings in YAML
 * frontmatter and its explanation for people in the body, which the host
 * never reads:
 *
 * - `Org/Organization.md` — {@link Organization}: owner and assistant, where
 *   the roster, skills, cases, and the other pages live, model seats, the VM
 *   defaults, each repository's environment ({@link RepositoryEnvironment}),
 *   spending limits, and generated-output settings;
 * - `Org/Policy/Gates.md` — a `Gates.GatePolicy`. Only Approval and Review
 *   gates run; a policy naming another kind is refused here with a
 *   not-yet-supported error rather than loaded and ignored;
 * - `Org/Connections.md` — {@link Connections}: provider connections by
 *   credential reference name only. A token-shaped reference is refused;
 * - `Org/Meetings.md` — {@link Meetings}: the weekly one-on-one inputs, `null`
 *   until the owner sets them;
 * - `Org/Routines.md` — {@link Routines}: each role's scheduled standing
 *   work, and the one-time onboarding.
 *
 * Unknown keys are refused. An error names the page and the field and says
 * what the field expects; it never repeats a value, because a page can hold a
 * pasted secret in the wrong place.
 *
 * {@link load} reads the pages the organization page names, relative to the
 * wiki root and confined to its real path.
 *
 * @since 1.0.0
 */
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Gates from "./Gates.ts"
import * as Frontmatter from "./internal/frontmatter.ts"
import * as Issues from "./internal/issues.ts"
import * as KnowledgePath from "./internal/knowledgePath.ts"
import * as Meeting from "./Meetings.ts"
import * as Profile from "./Profile.ts"
import * as Workspace from "./Workspace.ts"

/**
 * Stable configuration failure codes.
 *
 * @category schemas
 * @since 1.0.0
 */
export const ConfigErrorCode = Schema.Literals([
  "read",
  "confinement",
  "too-large",
  "frontmatter",
  "schema",
  "unsupported"
])

/**
 * A configuration failure code.
 *
 * @category models
 * @since 1.0.0
 */
export type ConfigErrorCode = typeof ConfigErrorCode.Type

/**
 * A configuration page that could not be read or was refused. `path` is the
 * page, relative to the wiki root when {@link load} found it; `field` names
 * the frontmatter field. The message never contains a value.
 *
 * @category errors
 * @since 1.0.0
 */
export class ConfigError extends Schema.TaggedError<ConfigError>()("@smthrs/organization/Config/ConfigError", {
  code: ConfigErrorCode,
  path: Schema.String,
  field: Schema.optionalKey(Schema.String),
  message: Schema.String
}) {}

/**
 * The largest configuration page {@link load} reads.
 *
 * @category constants
 * @since 1.0.0
 */
export const maxPageBytes = 262_144

/**
 * A wiki path relative to the wiki root: no `..`, no hidden segments, no
 * absolute paths or globs. A trailing `/` is allowed on directories.
 *
 * @category schemas
 * @since 1.0.0
 */
export const WikiPath = Schema.String.check(
  Schema.makeFilter<string>((text) =>
    KnowledgePath.parse(text).ok ? undefined : "must be a relative wiki path without .., hidden segments, or globs"
  )
)

const Count = (minimum: number, maximum: number) => Schema.Int.check(Schema.isBetween({ minimum, maximum }))

const Text = (maximum: number) => Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(maximum))

/**
 * Model seats by name. `default` is required; profiles pin their own.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Seats = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,31}$/, { expected: "a lowercase seat name" })),
  Profile.Seat
).check(
  Schema.makeFilter<Readonly<Record<string, string>>>((seats) =>
    Object.hasOwn(seats, "default") ? undefined : "must name a default seat"
  )
)

/**
 * A repository name as roster grants and the host's repository settings
 * name it: `owner/name` or a bare name.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RepositoryName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,99})?$/, {
    expected: "a repository name (owner/name or name)"
  })
)

/**
 * One check every change to a repository runs: a name and a shell command
 * run in the workspace root of a fresh machine.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RepositoryCheck = Schema.Struct({
  name: Text(100),
  run: Text(4_096),
  timeoutMs: Schema.optionalKey(Count(1, Workspace.maxCheckTimeoutMs))
})

/**
 * One check every change to a repository runs.
 *
 * @category models
 * @since 1.0.0
 */
export type RepositoryCheck = typeof RepositoryCheck.Type

/**
 * Where a repository's landed change goes: `local` keeps it on its
 * `organization/…` branch; `pr` also pushes that branch to the repository's
 * remote and opens a pull request.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Landing = Schema.Literals(["pr", "local"])

/**
 * A git remote name.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RemoteName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/, { expected: "a git remote name" })
)

/**
 * A GitHub repository: `owner/name`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const GitHubRepository = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/, {
    expected: "a GitHub repository (owner/name)"
  })
)

const Label = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(50))

/**
 * Issue intake for one repository: which open issues are considered.
 * `labels` admits only issues carrying one of them (every open issue when
 * empty or absent); `skipLabels` refuses issues carrying any of them.
 *
 * @category schemas
 * @since 1.0.0
 */
export const IssueIntake = Schema.Struct({
  labels: Schema.optionalKey(Schema.Array(Label)),
  skipLabels: Schema.optionalKey(Schema.Array(Label))
})

/**
 * Issue intake for one repository.
 *
 * @category models
 * @since 1.0.0
 */
export type IssueIntake = typeof IssueIntake.Type

/**
 * A cron schedule in an IANA time zone: five fields, minute to weekday.
 *
 * @category schemas
 * @since 1.0.0
 */
export const CronSchedule = Schema.Struct({
  cron: Schema.String.check(
    Schema.isPattern(/^\S+(?: \S+){4}$/, { expected: "a five-field cron expression" }),
    Schema.isMaxLength(100)
  ),
  timezone: Text(64)
})

/**
 * A cron schedule in an IANA time zone.
 *
 * @category models
 * @since 1.0.0
 */
export type CronSchedule = typeof CronSchedule.Type

/**
 * The organization's autonomous work: who triages issues and proposals, how
 * often issues are taken in, how many autonomous deliveries run at once, when
 * the daily digest goes out, and where the team's pages live.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Autonomy = Schema.Struct({
  /** The principal that triages issues and accepts proposals. */
  triage: Profile.PrincipalId,
  /** Issue and proposal intake. Default every 30 minutes. */
  intake: Schema.optionalKey(CronSchedule),
  /** Autonomous deliveries (issues and proposals) one intake runs at once. Default 1. */
  maxConcurrent: Schema.optionalKey(Count(1, 8)),
  /** The owner's daily digest. Default 18:00 America/Los_Angeles. */
  digest: Schema.optionalKey(CronSchedule),
  /** Each role's onboarding page, the priorities page, and the team channel. Default `Org/Team`. */
  teamDir: Schema.optionalKey(WikiPath),
  /** Proposals. Default `Org/Proposals`. */
  proposalsDir: Schema.optionalKey(WikiPath),
  /** Requests for the owner. Default `Org/Requests`. */
  requestsDir: Schema.optionalKey(WikiPath)
})

/**
 * The organization's autonomous work.
 *
 * @category models
 * @since 1.0.0
 */
export type Autonomy = typeof Autonomy.Type

/**
 * A repository's environment on the organization page: how its prepared
 * base is made (`prepare`: the command, the key paths, and the network the
 * command runs with), the network its builders and checks run with (default
 * `none`), and the checks every change to it runs.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RepositoryEnvironment = Schema.Struct({
  base: Schema.optionalKey(Workspace.BaseRef),
  prepare: Schema.optionalKey(Workspace.Prepare),
  network: Schema.optionalKey(Workspace.Network),
  checks: Schema.optionalKey(Schema.Array(RepositoryCheck)),
  /** Where a landed change goes: a local branch (the default), or that branch pushed and opened as a pull request. */
  landing: Schema.optionalKey(Landing),
  /** The git remote a pull request's branch is pushed to. Default `origin`. */
  remote: Schema.optionalKey(RemoteName),
  /** The GitHub repository pull requests and issues belong to. Default the entry's own name. */
  github: Schema.optionalKey(GitHubRepository),
  /** Issue intake: the repository's open issues are synchronized and triaged. Off when absent. */
  issues: Schema.optionalKey(IssueIntake)
})

/**
 * A repository's environment on the organization page.
 *
 * @category models
 * @since 1.0.0
 */
export type RepositoryEnvironment = typeof RepositoryEnvironment.Type

/**
 * The workspace environment a repository's page entry declares: each check
 * runs as `sh -c <run>`.
 *
 * @category conversions
 * @since 1.0.0
 */
export const environmentOf = (entry: RepositoryEnvironment): Workspace.Environment => ({
  ...(entry.base === undefined ? {} : { base: entry.base }),
  ...(entry.prepare === undefined ? {} : { prepare: entry.prepare }),
  ...(entry.network === undefined ? {} : { network: entry.network }),
  ...(entry.checks === undefined ? {} : {
    checks: entry.checks.map((check) => ({
      name: check.name,
      argv: ["sh", "-c", check.run] as const,
      ...(check.timeoutMs === undefined ? {} : { timeoutMs: check.timeoutMs })
    }))
  })
})

/**
 * The organization page: `Org/Organization.md`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Organization = Schema.Struct({
  organization: Schema.optionalKey(Profile.ReferenceName),
  version: Schema.optionalKey(Profile.Version),
  owner: Schema.Literal("owner"),
  assistant: Profile.PrincipalId,
  rosterDir: WikiPath,
  commonFile: Schema.optionalKey(WikiPath),
  skillsDir: Schema.optionalKey(WikiPath),
  casesDir: Schema.optionalKey(WikiPath),
  policyFile: Schema.optionalKey(WikiPath),
  connectionsFile: Schema.optionalKey(WikiPath),
  meetingsFile: Schema.optionalKey(WikiPath),
  /** The routines page: each role's scheduled standing work. */
  routinesFile: Schema.optionalKey(WikiPath),
  weeklyMeeting: Schema.optionalKey(Schema.Boolean),
  /** Seats a hire may hold besides its hirer's own. */
  hireSeats: Schema.optionalKey(Schema.Array(Profile.Seat)),
  seats: Seats,
  judge: Profile.Seat,
  vm: Schema.Struct({
    provider: Schema.Literal("microsandbox"),
    image: Schema.NullOr(Text(256)),
    cpus: Count(1, 64),
    memoryMib: Count(256, 1_048_576),
    /** Root disk of an image-booted machine, in MiB. Default `Workspace.defaultDiskMib`. */
    diskMib: Schema.optionalKey(Count(1_024, 1_048_576)),
    maxConcurrentVMs: Count(1, 64),
    /** Guest networking for a repository without an environment. Default off. */
    network: Schema.optionalKey(Schema.Boolean)
  }),
  repositories: Schema.optionalKey(Schema.Record(RepositoryName, RepositoryEnvironment)),
  autonomy: Schema.optionalKey(Autonomy),
  limits: Schema.optionalKey(Schema.Struct({
    usdPerMonth: Schema.NullOr(Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)))
  })),
  wiki: Schema.Struct({
    generatedDir: WikiPath,
    statusFile: WikiPath,
    commit: Schema.Boolean,
    push: Schema.Boolean,
    /**
     * `push`: after each commit, and on a timer, the host pulls the wiki's
     * upstream with a rebase and pushes to its tracking branch; a conflict is
     * aborted and reported, never forced. Default `off`.
     */
    sync: Schema.optionalKey(Schema.Literals(["push", "off"])),
    /**
     * The wiki's web address that a page path is appended to, such as
     * `https://github.com/owner/wiki/blob/main`. Default: derived from a
     * GitHub upstream remote.
     */
    webUrl: Schema.optionalKey(Schema.String.check(
      Schema.isPattern(/^https:\/\/[^\s<>|]+[^/\s<>|]$/, { expected: "an https URL without a trailing slash" })
    ))
  })
})

/**
 * The organization page.
 *
 * @category models
 * @since 1.0.0
 */
export type Organization = typeof Organization.Type

const Alias = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, { expected: "an alias name" }))

/**
 * One provider connection, by reference. `credential` and `appCredential`
 * name secrets the host's credential broker holds; they are never the secret.
 * A `null` container alias is not yet mapped and is unusable.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Connection = Schema.Struct({
  id: Profile.ReferenceName,
  provider: Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/, { expected: "a provider name" })),
  label: Schema.optionalKey(Text(200)),
  principal: Schema.optionalKey(Profile.PrincipalId),
  personal: Schema.Boolean,
  credential: Profile.ReferenceName,
  appCredential: Schema.optionalKey(Profile.ReferenceName),
  scopes: Schema.Array(Text(256)),
  appScopes: Schema.optionalKey(Schema.Array(Text(256))),
  containers: Schema.optionalKey(Schema.Array(Profile.Container)),
  containerAliases: Schema.optionalKey(Schema.Record(Alias, Schema.NullOr(Profile.Container))),
  status: Schema.optionalKey(Schema.Literals(["not-connected", "connected"]))
})

/**
 * One provider connection, by reference.
 *
 * @category models
 * @since 1.0.0
 */
export type Connection = typeof Connection.Type

/**
 * The connections page: `Org/Connections.md`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Connections = Schema.Struct({
  connections: Schema.Array(Connection).check(
    Schema.makeFilter<ReadonlyArray<Connection>>((connections) =>
      new Set(connections.map((connection) => connection.id)).size === connections.length
        ? undefined
        : "connection ids must be unique"
    )
  ),
  identities: Schema.optionalKey(Schema.Record(
    Profile.ReferenceName,
    Schema.Struct({
      address: Schema.NullOr(Text(320)),
      status: Schema.Literals(["not-provisioned", "provisioned"])
    })
  ))
})

/**
 * The connections page.
 *
 * @category models
 * @since 1.0.0
 */
export type Connections = typeof Connections.Type

/**
 * The meetings page: `Org/Meetings.md`. `timezone`, `start`, and `firstDate`
 * stay `null` until the owner sets them.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Meetings = Schema.Struct({
  seriesId: Meeting.SeriesId,
  weekday: Meeting.Weekday,
  slotMinutes: Count(1, 1440),
  order: Schema.Array(Profile.PrincipalId),
  timezone: Schema.NullOr(Text(64)),
  start: Schema.NullOr(Meeting.LocalTime),
  firstDate: Schema.NullOr(Meeting.LocalDate),
  calendarConnection: Schema.optionalKey(Profile.ReferenceName),
  slackDelivery: Schema.optionalKey(Text(200))
})

/**
 * The meetings page.
 *
 * @category models
 * @since 1.0.0
 */
export type Meetings = typeof Meetings.Type

/**
 * The weekly request the meetings page describes, or `undefined` while any
 * owner input is still `null`.
 *
 * @category combinators
 * @since 1.0.0
 */
export const weeklyRequest = (meetings: Meetings): Meeting.WeeklyRequest | undefined =>
  meetings.timezone === null || meetings.start === null || meetings.firstDate === null
    ? undefined
    : {
      seriesId: meetings.seriesId,
      timezone: meetings.timezone,
      weekday: meetings.weekday,
      start: meetings.start,
      slotMinutes: meetings.slotMinutes,
      order: meetings.order,
      firstDate: meetings.firstDate
    }

/**
 * The host-gathered context a routine's task may carry, read on the host
 * when the task starts: the repository's commits since the last occurrence,
 * its open issues, the organization's recent receipts, the proposals, the
 * team channel, and the repository's documentation file list.
 *
 * @category schemas
 * @since 1.0.0
 */
export const RoutineContext = Schema.Literals(["commits", "issues", "receipts", "proposals", "channel", "docs"])

/**
 * One kind of routine context.
 *
 * @category models
 * @since 1.0.0
 */
export type RoutineContext = typeof RoutineContext.Type

const RoutineId = Schema.String.check(
  Schema.isPattern(/^[a-z][a-z0-9-]{0,62}$/, { expected: "a lowercase routine id" })
)

const Instant = Schema.String.check(
  Schema.makeFilter<string>((text) =>
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(text) &&
      Number.isFinite(Date.parse(text))
      ? undefined
      : "must be an ISO date and time with a zone offset"
  )
)

/**
 * One routine: a role's standing work. Exactly one of `cron` (with its
 * `timezone`), `once` (an instant), or `onboarding: true` says when it runs.
 * A cron or once routine names its `role` and its `task`; an onboarding
 * routine runs every listed role's first-week sequence (every active core
 * role when `roles` is absent) once, one step at a time. `run: qualify`
 * runs the organization's qualification first and hands the role its
 * scorecard. The role's report is written under `output` (a directory) as
 * `<date>.md`, or under the generated directory when absent.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Routine = Schema.Struct({
  id: RoutineId,
  role: Schema.optionalKey(Profile.PrincipalId),
  cron: Schema.optionalKey(CronSchedule.fields.cron),
  timezone: Schema.optionalKey(Text(64)),
  once: Schema.optionalKey(Instant),
  onboarding: Schema.optionalKey(Schema.Boolean),
  roles: Schema.optionalKey(Schema.Array(Profile.PrincipalId)),
  task: Schema.optionalKey(Text(4_000)),
  repository: Schema.optionalKey(RepositoryName),
  context: Schema.optionalKey(Schema.Array(RoutineContext)),
  workspace: Schema.optionalKey(Schema.Boolean),
  run: Schema.optionalKey(Schema.Literal("qualify")),
  output: Schema.optionalKey(WikiPath),
  enabled: Schema.Boolean
}).check(
  Schema.makeFilter<{
    readonly cron?: string
    readonly timezone?: string
    readonly once?: string
    readonly onboarding?: boolean
    readonly role?: string
    readonly roles?: ReadonlyArray<string>
    readonly task?: string
    readonly run?: string
  }>((routine) => {
    const kinds = [routine.cron !== undefined, routine.once !== undefined, routine.onboarding === true]
    if (kinds.filter(Boolean).length !== 1) return "must set exactly one of cron, once, or onboarding: true"
    if (routine.cron !== undefined && routine.timezone === undefined) return "a cron routine names its timezone"
    if (routine.onboarding === true) {
      return routine.role === undefined && routine.task === undefined && routine.run === undefined
        ? undefined
        : "an onboarding routine names roles, not a role, a task, or a run"
    }
    if (routine.roles !== undefined) return "only an onboarding routine names roles"
    return routine.role !== undefined && routine.task !== undefined
      ? undefined
      : "a routine names its role and its task"
  })
)

/**
 * One routine.
 *
 * @category models
 * @since 1.0.0
 */
export type Routine = typeof Routine.Type

/**
 * The routines page: the organization's `routinesFile`.
 *
 * @category schemas
 * @since 1.0.0
 */
export const Routines = Schema.Struct({
  routines: Schema.Array(Routine).check(
    Schema.makeFilter<ReadonlyArray<Routine>>((routines) =>
      new Set(routines.map((routine) => routine.id)).size === routines.length ? undefined : "routine ids must be unique"
    )
  )
})

/**
 * The routines page.
 *
 * @category models
 * @since 1.0.0
 */
export type Routines = typeof Routines.Type

const strict = { onExcessProperty: "error" } as const

const frontmatterOf = (path: string, text: string): Effect.Effect<Record<string, unknown>, ConfigError> => {
  const split = Frontmatter.split(text.replace(/\r\n?/g, "\n"))
  if (split.frontmatter === undefined) {
    return Effect.fail(new ConfigError({ code: "frontmatter", path, message: "a page starts with --- frontmatter" }))
  }
  const parsed = Frontmatter.parse(split.frontmatter, "core")
  return parsed.ok
    ? Effect.succeed(parsed.value)
    : Effect.fail(new ConfigError({ code: "frontmatter", path, message: parsed.error }))
}

const decodePage = <S extends Schema.Codec<unknown, unknown>>(schema: S) => {
  const decode = Schema.decodeUnknownEffect(schema, strict)
  return (path: string, text: string): Effect.Effect<S["Type"], ConfigError> =>
    frontmatterOf(path, text).pipe(
      Effect.flatMap((value) =>
        decode(value).pipe(Effect.mapError((error) => {
          const problems = Issues.problems(error)
          return new ConfigError({
            code: "schema",
            path,
            // Every schema issue names at least one field, the root included.
            field: problems[0]!.field,
            message: Issues.summary(problems)
          })
        }))
      )
    )
}

/**
 * Parses the organization page. `path` only names the page in errors.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseOrganization: (path: string, text: string) => Effect.Effect<Organization, ConfigError> = decodePage(
  Organization
)

/**
 * Parses the connections page. `path` only names the page in errors.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseConnections: (path: string, text: string) => Effect.Effect<Connections, ConfigError> = decodePage(
  Connections
)

/**
 * Parses the meetings page. `path` only names the page in errors.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseMeetings: (path: string, text: string) => Effect.Effect<Meetings, ConfigError> = decodePage(
  Meetings
)

/**
 * Parses the routines page. `path` only names the page in errors.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseRoutines: (path: string, text: string) => Effect.Effect<Routines, ConfigError> = decodePage(
  Routines
)

const decodePolicy = decodePage(Gates.GatePolicy)

/**
 * Parses the gate policy page, refusing any gate kind that cannot run yet.
 * `path` only names the page in errors.
 *
 * @category parsing
 * @since 1.0.0
 */
export const parseGatePolicy = (path: string, text: string): Effect.Effect<Gates.GatePolicy, ConfigError> =>
  Effect.flatMap(decodePolicy(path, text), (policy) => {
    const index = policy.gates.findIndex((gate) => Gates.unsupported(gate.spec) !== undefined)
    if (index === -1) return Effect.succeed(policy)
    return Effect.fail(
      new ConfigError({
        code: "unsupported",
        path,
        field: `gates[${index}].spec`,
        message: Gates.unsupported(policy.gates[index]!.spec)!
      })
    )
  })

/**
 * Everything the organization page names, loaded and checked. A page the
 * organization page does not name is `undefined`; with no `policyFile` the
 * policy is empty.
 *
 * @category models
 * @since 1.0.0
 */
export interface Loaded {
  readonly organization: Organization
  readonly policy: Gates.GatePolicy
  readonly connections: Connections | undefined
  readonly meetings: Meetings | undefined
  readonly routines: Routines | undefined
}

/**
 * The organization page's default location under the wiki root.
 *
 * @category constants
 * @since 1.0.0
 */
export const defaultOrganizationFile = "Org/Organization.md"

/**
 * Reads and checks the organization page at `file` (relative to `root`) and
 * the policy, connections, meetings, and routines pages it names. Every page must
 * resolve, through any symlinks, inside the real path of `root`, be a regular
 * file, and be at most {@link maxPageBytes}.
 *
 * @category loading
 * @since 1.0.0
 */
export const load = (
  root: string,
  file: string = defaultOrganizationFile
): Effect.Effect<Loaded, ConfigError, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const readError = (relative: string, message: string) => new ConfigError({ code: "read", path: relative, message })
    const realRoot = yield* fs.realPath(path.resolve(root)).pipe(
      Effect.mapError(() => readError(".", "the wiki root could not be resolved"))
    )
    // `join` keeps exactly one separator, so a root of `/` is its own prefix.
    const inside = (candidate: string) => candidate.startsWith(path.join(realRoot, path.sep))
    const read = (relative: string) =>
      Effect.gen(function*() {
        if (!KnowledgePath.parse(relative).ok) {
          return yield* new ConfigError({
            code: "confinement",
            path: relative,
            message: "is not a relative wiki path"
          })
        }
        const real = yield* fs.realPath(path.join(realRoot, relative)).pipe(
          Effect.mapError(() => readError(relative, "the page could not be resolved"))
        )
        if (!inside(real)) {
          return yield* new ConfigError({
            code: "confinement",
            path: relative,
            message: "the page resolves outside the wiki root"
          })
        }
        const info = yield* fs.stat(real).pipe(Effect.mapError(() => readError(relative, "the page could not be read")))
        if (info.type !== "File") return yield* readError(relative, "is not a regular file")
        if (Number(info.size) > maxPageBytes) {
          return yield* new ConfigError({
            code: "too-large",
            path: relative,
            message: `pages are at most ${maxPageBytes} bytes`
          })
        }
        return yield* fs.readFileString(real).pipe(
          Effect.mapError(() => readError(relative, "the page could not be read"))
        )
      })
    const organization = yield* Effect.flatMap(read(file), (text) => parseOrganization(file, text))
    const page = <A>(
      relative: string | undefined,
      parse: (path: string, text: string) => Effect.Effect<A, ConfigError>
    ): Effect.Effect<A | undefined, ConfigError> =>
      relative === undefined
        ? Effect.succeed(undefined)
        : Effect.flatMap(read(relative), (text) => parse(relative, text))
    return {
      organization,
      policy: (yield* page(organization.policyFile, parseGatePolicy)) ?? Gates.empty("none"),
      connections: yield* page(organization.connectionsFile, parseConnections),
      meetings: yield* page(organization.meetingsFile, parseMeetings),
      routines: yield* page(organization.routinesFile, parseRoutines)
    }
  })
