/**
 * PACKAGE.ts GitHub target flavors: `S.Github.Setup`, `S.Github.Workflow`,
 * `S.Github.CiGen`, and `S.Github.Pr`.
 *
 * `S.Github.Workflow` names GitHub's own artifact and is exempt from the
 * naming rule that bans "workflow" for flows concepts.
 *
 * Phase W1 is construct-only; constructors validate attrs by schema and
 * install {@link Target.notImplemented} implementations.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import * as Attr from "./Attr.ts"
import * as Input from "./Input.ts"
import * as Reference from "./Reference.ts"
import * as Secret from "./Secret.ts"
import * as Target from "./Target.ts"

/**
 * The GitHub policy a `.smithers/FACTORY.ts` declares, `S.Github.Policy({ mirror, issues, changes })`.
 *
 * @category constructors
 * @since 1.0.0
 */
export { Policy } from "./Factory.ts"

/**
 * Attrs for {@link Setup}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const SetupAttrs = Schema.Struct({
  cacheUrl: Schema.optional(Secret.Declaration),
  cacheToken: Schema.optional(Secret.Declaration)
})

const setupDefinition = Target.make("Github.Setup", {
  attrs: SetupAttrs,
  kinds: ["run", "lint"],
  implementation: () => Target.notImplemented("Github.Setup")
})

/**
 * The generated shared setup action every generated job starts with.
 *
 * @category targets
 * @since 0.1.0
 */
export const Setup = setupDefinition

/**
 * Schema for a `release` trigger's activity types, GitHub's own set.
 *
 * @category schemas
 * @since 0.1.0
 */
export const ReleaseActivity = Schema.Literals([
  "published",
  "unpublished",
  "created",
  "edited",
  "deleted",
  "prereleased",
  "released"
])

/**
 * A `release` trigger activity type.
 *
 * @category models
 * @since 0.1.0
 */
export type ReleaseActivity = typeof ReleaseActivity.Type

/**
 * Schema for the pull-request activity types accepted by GitHub Actions.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PullRequestActivity = Schema.Literals([
  "assigned",
  "unassigned",
  "labeled",
  "unlabeled",
  "opened",
  "edited",
  "closed",
  "reopened",
  "synchronize",
  "converted_to_draft",
  "locked",
  "unlocked",
  "enqueued",
  "dequeued",
  "milestoned",
  "demilestoned",
  "ready_for_review",
  "review_requested",
  "review_request_removed",
  "auto_merge_enabled",
  "auto_merge_disabled"
])

/**
 * A pull-request activity type accepted by GitHub Actions.
 *
 * @category models
 * @since 0.1.0
 */
export type PullRequestActivity = typeof PullRequestActivity.Type

/**
 * Schema for the issue activity types accepted by GitHub Actions.
 *
 * @category schemas
 * @since 0.1.0
 */
export const IssueActivity = Schema.Literals([
  "opened",
  "edited",
  "deleted",
  "transferred",
  "pinned",
  "unpinned",
  "closed",
  "reopened",
  "assigned",
  "unassigned",
  "labeled",
  "unlabeled",
  "locked",
  "unlocked",
  "milestoned",
  "demilestoned"
])

/**
 * An issue activity type accepted by GitHub Actions.
 *
 * @category models
 * @since 0.1.0
 */
export type IssueActivity = typeof IssueActivity.Type

/**
 * Schema for one typed manual-dispatch input.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WorkflowDispatchInput = Schema.Struct({
  description: Schema.optional(Schema.String),
  required: Schema.optional(Schema.Boolean),
  default: Schema.optional(Schema.Union([Schema.String, Schema.Boolean, Schema.Number])),
  type: Schema.Literals(["boolean", "choice", "environment", "string"]),
  options: Schema.optional(Schema.Array(Schema.String))
})

/**
 * One typed manual-dispatch input.
 *
 * @category models
 * @since 0.1.0
 */
export type WorkflowDispatchInput = typeof WorkflowDispatchInput.Type

/**
 * Schema for a generated workflow's trigger table. `schedule` takes
 * five-field cron expressions (rendered as GitHub's `schedule: [{ cron }]`
 * list); `release` takes the activity types that fire it.
 *
 * @category schemas
 * @since 0.1.0
 */
export const On = Schema.Struct({
  pullRequest: Schema.optional(Schema.Union([
    Schema.Boolean,
    Schema.Struct({
      branches: Schema.optional(Schema.Array(Schema.NonEmptyString)),
      types: Schema.optional(Schema.Array(PullRequestActivity))
    })
  ])),
  pullRequestTarget: Schema.optional(Schema.Union([
    Schema.Boolean,
    Schema.Struct({
      branches: Schema.optional(Schema.Array(Schema.NonEmptyString)),
      types: Schema.optional(Schema.Array(PullRequestActivity))
    })
  ])),
  issues: Schema.optional(Schema.Struct({ types: Schema.optional(Schema.Array(IssueActivity)) })),
  push: Schema.optional(Schema.Struct({ branches: Schema.Array(Schema.NonEmptyString) })),
  schedule: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  release: Schema.optional(Schema.Array(ReleaseActivity)),
  workflowDispatch: Schema.optional(Schema.Union([
    Schema.Boolean,
    Schema.Struct({ inputs: Schema.Record(Schema.String, WorkflowDispatchInput) })
  ]))
})

/**
 * Schema for a generated workflow's concurrency policy.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Concurrency = Schema.Struct({
  group: Schema.NonEmptyString,
  cancelInProgress: Schema.Union([Schema.Boolean, Schema.NonEmptyString])
})

/**
 * Schema for one repository permission level in a generated workflow.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Permission = Schema.Literals(["read", "write", "none"])

/**
 * One repository permission level in a generated workflow.
 *
 * @category models
 * @since 0.1.0
 */
export type Permission = typeof Permission.Type

const stepBase = {
  name: Schema.optional(Schema.NonEmptyString),
  id: Schema.optional(Schema.NonEmptyString),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  if: Schema.optional(Schema.NonEmptyString)
}

/**
 * Schema for one raw GitHub Actions step in declaration order.
 *
 * An action step names `uses`; a shell step names `run`, either as one string
 * or as lines the renderer joins with newlines. The two forms are exclusive so
 * a declaration cannot emit a step GitHub would reject for naming both.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Step = Schema.Union([
  Schema.Struct({
    ...stepBase,
    uses: Schema.NonEmptyString,
    with: Schema.optional(Schema.Record(Schema.String, Schema.String))
  }),
  Schema.Struct({
    ...stepBase,
    run: Schema.Union([Schema.NonEmptyString, Schema.NonEmptyArray(Schema.String)]),
    shell: Schema.optional(Schema.NonEmptyString),
    workingDirectory: Schema.optional(Schema.NonEmptyString)
  })
])

/**
 * One raw GitHub Actions step.
 *
 * @category models
 * @since 0.1.0
 */
export type Step = typeof Step.Type

/**
 * Attrs for {@link Workflow}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const WorkflowAttrs = Schema.Struct({
  name: Schema.NonEmptyString,
  on: On,
  concurrency: Schema.optional(Concurrency),
  permissions: Schema.optional(Schema.Record(Schema.String, Permission)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  environment: Schema.optional(Schema.NonEmptyString),
  condition: Schema.optional(Schema.NonEmptyString),
  jobName: Schema.optional(Schema.NonEmptyString),
  runsOn: Schema.optional(Schema.NonEmptyString),
  steps: Schema.optional(Schema.NonEmptyArray(Step)),
  setup: Schema.optional(Target.Target),
  affected: Schema.optional(Schema.Boolean),
  run: Schema.Array(Target.Target).pipe(
    Schema.withConstructorDefault(Effect.succeed<ReadonlyArray<Target.AnyTarget>>([]))
  )
})

const workflowDefinition = Target.make("Github.Workflow", {
  attrs: WorkflowAttrs,
  kinds: ["run", "lint"],
  implementation: () => Target.notImplemented("Github.Workflow")
})

/**
 * One generated GitHub Actions workflow running the named targets.
 *
 * @category targets
 * @since 0.1.0
 */
export const Workflow = workflowDefinition

/**
 * Attrs for {@link CiGen}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const CiGenAttrs = Schema.Struct({
  workflows: Schema.Array(Target.Target),
  preserve: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  changes: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

const ciGenDefinition = Target.make("Github.CiGen", {
  attrs: CiGenAttrs,
  kinds: ["run", "lint"],
  implementation: () => Target.notImplemented("Github.CiGen")
})

/**
 * The drift-checked renderer for the declared workflows; hand-written files
 * in `preserve` are kept verbatim.
 *
 * @category targets
 * @since 0.1.0
 */
export const CiGen = ciGenDefinition

/**
 * Attrs for {@link Pr}.
 *
 * @category schemas
 * @since 0.1.0
 */
export const PrAttrs = Schema.Struct({
  gates: Attr.Gates,
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Schema.optional(Attr.Approval)
})

const prDefinition = Target.make("Github.Pr", {
  attrs: PrAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Github.Pr")
})

/**
 * Opens a pull request after fresh gates; outward, so it runs only when
 * named explicitly.
 *
 * @category targets
 * @since 0.1.0
 */
export const Pr = prDefinition

/** Attrs for publishing a generated site through GitHub Pages.
 *
 * @category targets
 * @since 0.1.0
 */
export const PagesAttrs = Schema.Struct({
  site: Target.Target,
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Schema.optional(Attr.Approval)
})

const pagesDefinition = Target.make("Github.Pages", {
  attrs: PagesAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Github.Pages")
})

/** Publishes a declared site to GitHub Pages.
 *
 * @category targets
 * @since 0.1.0
 */
export const Pages = pagesDefinition

/** Attrs for creating one GitHub release.
 *
 * @category targets
 * @since 0.1.0
 */
export const ReleaseAttrs = Schema.Struct({
  manifest: Input.File,
  notes: Schema.Union([Schema.NonEmptyString, Reference.AgentSelection]),
  data: Schema.optional(Attr.Data),
  gates: Attr.Gates,
  secrets: Schema.optional(Attr.Secrets),
  sandbox: Schema.optional(Attr.Sandbox),
  approval: Schema.optional(Attr.Approval)
})

const releaseDefinition = Target.make("Github.Release", {
  attrs: ReleaseAttrs,
  kinds: ["run"],
  implementation: () => Target.notImplemented("Github.Release")
})

/** Creates a GitHub release for the version in a manifest.
 *
 * @category targets
 * @since 0.1.0
 */
export const Release = releaseDefinition

/** Trigger syntax accepted by compact {@link Ci}.
 *
 * @category targets
 * @since 0.1.0
 */
export const CompactOn = Schema.Struct({
  pullRequest: Schema.optional(Schema.Boolean),
  push: Schema.optional(Schema.Array(Schema.NonEmptyString)),
  dispatch: Schema.optional(Schema.Boolean)
})

/** One compact workflow entry.
 *
 * @category targets
 * @since 0.1.0
 */
export const CompactWorkflow = Schema.Struct({
  on: CompactOn,
  run: Schema.Union([Target.Target, Schema.Array(Target.Target)])
})

/** Attrs for the compact CI sugar.
 *
 * @category targets
 * @since 0.1.0
 */
export const CiAttrs = Schema.Struct({
  workflows: Schema.Record(Schema.String, CompactWorkflow),
  changes: Schema.optional(Schema.Array(Schema.NonEmptyString))
})

// This definition is validation-only. Ci returns the existing CiGen object so
// rendering, checking, writing, caching, and refusal behavior have one path.
const compactCiDefinition = Target.make("Github.Ci", {
  attrs: CiAttrs,
  kinds: ["run", "lint"],
  implementation: () => Target.notImplemented("Github.Ci")
})

/**
 * Compact map-form sugar for the existing Workflow + CiGen pair.
 * The returned value is the CiGen target itself, never a wrapper copy.
 *
 * @category targets
 * @since 0.1.0
 */
export const Ci = (attrs: (typeof CiAttrs)["~type.make.in"]): Target.AnyTarget => {
  const validated = Target.metadata(compactCiDefinition(attrs)).attrs as (typeof CiAttrs)["Type"]
  const workflows = Object.entries(validated.workflows).map(([name, declaration]) =>
    Workflow({
      name,
      on: {
        ...(declaration.on.pullRequest === undefined ? {} : { pullRequest: declaration.on.pullRequest }),
        ...(declaration.on.push === undefined ? {} : { push: { branches: [...declaration.on.push] } }),
        ...(declaration.on.dispatch === undefined ? {} : { workflowDispatch: declaration.on.dispatch })
      },
      run: Target.isTarget(declaration.run) ? [declaration.run] : [...declaration.run]
    })
  )
  return CiGen({
    workflows,
    ...(validated.changes === undefined ? {} : { changes: [...validated.changes] })
  })
}

/** Reads validated attrs back out of one target of the named rule. */
const attrsOf = <A>(target: Target.AnyTarget, rule: string): A => {
  const metadata = Target.metadata(target)
  if (metadata.target !== rule) {
    throw new TypeError(`expected a ${rule} target, received ${metadata.target}`)
  }
  return metadata.attrs as A
}

/**
 * The validated attrs of one `Github.Setup` target.
 *
 * @category accessors
 * @since 0.1.0
 */
export const setupAttrsOf = (target: Target.AnyTarget): (typeof SetupAttrs)["Type"] => attrsOf(target, "Github.Setup")

/**
 * The validated attrs of one `Github.Workflow` target.
 *
 * @category accessors
 * @since 0.1.0
 */
export const workflowAttrsOf = (target: Target.AnyTarget): (typeof WorkflowAttrs)["Type"] =>
  attrsOf(target, "Github.Workflow")

/**
 * The validated attrs of one `Github.CiGen` target.
 *
 * @category accessors
 * @since 0.1.0
 */
export const ciGenAttrsOf = (target: Target.AnyTarget): (typeof CiGenAttrs)["Type"] => attrsOf(target, "Github.CiGen")

/**
 * The validated attrs of one `Github.Pr` target.
 *
 * @category accessors
 * @since 0.1.0
 */
export const prAttrsOf = (target: Target.AnyTarget): (typeof PrAttrs)["Type"] => attrsOf(target, "Github.Pr")
