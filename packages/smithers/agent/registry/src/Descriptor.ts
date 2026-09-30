/**
 * Serializable flow-registry descriptors.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 * `EffectDeclaration` is the fully explicit discovery projection of
 * `packages/smithers/flows/core/src/Effects.ts`; placement literals are lowered by
 * `packages/smithers/flows/core/src/Markdown.ts` into `packages/smithers/flows/core/src/Placement.ts`
 * values. The adapter is implemented by `MarkdownFlow.toCoreFrontmatter`.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import { Option, Schema } from "effect"

/**
 * The reversibility tier declared by a flow.
 *
 * @category models
 * @since 0.1.0
 */
export const EffectTier = Schema.Literals(["sealed", "compensable", "irreversible"])

/**
 * The reversibility tier declared by a flow.
 *
 * @category models
 * @since 0.1.0
 */
export type EffectTier = typeof EffectTier.Type

/**
 * The execution environment selected by a leading placement directive.
 *
 * @category models
 * @since 0.1.0
 */
export const Placement = Schema.Literals(["client", "local", "sandbox", "remote"])

/**
 * The execution environment selected by a leading placement directive.
 *
 * @category models
 * @since 0.1.0
 */
export type Placement = typeof Placement.Type

/**
 * The sandbox providers a flow may name, one per `@smthrs/sandbox` provider
 * module. A name outside this set refuses the flow at discovery, so a typo can
 * never quietly run a flow outside the sandbox its author asked for.
 *
 * @category models
 * @since 1.0.0
 */
export const SandboxProvider = Schema.Literals([
  "aws",
  "cloudflare",
  "command",
  "container",
  "daytona",
  "directory",
  "just-bash",
  "kubernetes",
  "microsandbox",
  "vercel"
])

/**
 * The sandbox providers a flow may name.
 *
 * @category models
 * @since 1.0.0
 */
export type SandboxProvider = typeof SandboxProvider.Type

/**
 * The sandbox a flow selects: the provider, plus the neutral network policy
 * and resource limits every `@smthrs/sandbox` provider accepts
 * (`Sandbox.NetworkPolicy`, `Sandbox.ResourceLimits`).
 *
 * @category models
 * @since 1.0.0
 */
export const SandboxSelection = Schema.Struct({
  provider: SandboxProvider,
  network: Schema.optionalKey(Schema.Union([
    Schema.Literals(["none", "open"]),
    Schema.Struct({ allow: Schema.Array(Schema.String) })
  ])),
  cpus: Schema.optionalKey(Schema.Number),
  memoryMib: Schema.optionalKey(Schema.Number),
  timeoutSecs: Schema.optionalKey(Schema.Number)
})

/**
 * The sandbox a flow selects.
 *
 * @category models
 * @since 1.0.0
 */
export type SandboxSelection = typeof SandboxSelection.Type

/**
 * The canonical effect declaration shared with `/core`.
 *
 * @category models
 * @since 0.1.0
 */
export const EffectDeclaration = Schema.Struct({
  reads: Schema.Array(Schema.String),
  writes: Schema.Array(Schema.String),
  mode: Schema.Literals(["hermetic", "expected"]),
  onConflict: Schema.Literals(["serialize", "lane", "fail"]),
  tier: EffectTier
})

/**
 * The canonical effect declaration shared with `/core`.
 *
 * @category models
 * @since 0.1.0
 */
export type EffectDeclaration = typeof EffectDeclaration.Type

/**
 * The fixed `{ args: string }` input marker used by markdown flows.
 *
 * @category models
 * @since 0.1.0
 */
export class SchemaRefMarkdownArgs
  extends Schema.TaggedClass<SchemaRefMarkdownArgs>("flows/registry/SchemaRef/MarkdownArgs")(
    "MarkdownArgs",
    {}
  )
{}

/**
 * The fixed string output marker used by markdown flows.
 *
 * @category models
 * @since 0.1.0
 */
export class SchemaRefMarkdownOutput
  extends Schema.TaggedClass<SchemaRefMarkdownOutput>("flows/registry/SchemaRef/MarkdownOutput")(
    "MarkdownOutput",
    {}
  )
{}

/**
 * A schema field on a module's default `Flow.make` value. Discovery records
 * the field location without evaluating the module.
 *
 * @category models
 * @since 0.1.0
 */
export class SchemaRefModule extends Schema.TaggedClass<SchemaRefModule>("flows/registry/SchemaRef/Module")("Module", {
  path: Schema.String,
  field: Schema.Literals(["input", "output"])
}) {}

/**
 * A flow with no declared input or output schema.
 *
 * @category models
 * @since 0.1.0
 */
export class SchemaRefNone extends Schema.TaggedClass<SchemaRefNone>("flows/registry/SchemaRef/None")("None", {}) {}

/**
 * A schema carried by value, as a JSON Schema document.
 *
 * The other three variants are *locators*: they say where a schema lives so
 * discovery can record it without evaluating the module that defines it. A
 * host that binds a declaration it already holds — `@smthrs/harness`'s
 * `FlowBinding` — has the schema itself and nothing to locate, and a locator
 * pointing at a synthetic `binding://` path is unreadable by anything
 * downstream. That is what left `ctx.flows` describing every standard flow by
 * name, tier, and prose alone: a cell had to guess `command` versus `cmd`,
 * then discover `reads` and `writes` one rejected frame at a time.
 *
 * The document is `Schema.toJsonSchemaDocument` output, kept as plain JSON so
 * a descriptor stays serializable and comparable.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export class SchemaRefInline extends Schema.TaggedClass<SchemaRefInline>("flows/registry/SchemaRef/Inline")(
  "Inline",
  { document: Schema.Json }
) {}

/**
 * Input metadata available without evaluating a repository module.
 * @category accessors
 * @since 1.0.0
 */
export const inputDocument = (ref: SchemaRef | undefined): Schema.Json | undefined =>
  ref?._tag === "Inline" ? ref.document : ref?._tag === "MarkdownArgs"
    ? Schema.decodeUnknownSync(Schema.Json)(Schema.toJsonSchemaDocument(Schema.Struct({ args: Schema.String })))
    : undefined

/**
 * A serializable locator for a flow input or output schema.
 *
 * @category models
 * @since 0.1.0
 */
export const SchemaRef = Schema.Union([
  SchemaRefMarkdownArgs,
  SchemaRefMarkdownOutput,
  SchemaRefModule,
  SchemaRefNone,
  SchemaRefInline
])

/**
 * A serializable locator for a flow input or output schema.
 *
 * @category models
 * @since 0.1.0
 */
export type SchemaRef = typeof SchemaRef.Type

/**
 * A markdown body stored at a source path.
 *
 * @category models
 * @since 0.1.0
 */
export class BodyRefMarkdown
  extends Schema.TaggedClass<BodyRefMarkdown>("flows/registry/BodyRef/Markdown")("Markdown", {
    path: Schema.String,
    baseDirectory: Schema.String,
    /**
     * SHA-256 of the complete source bytes measured during discovery.
     *
     * Optional only so descriptors journaled before rc.0 still decode. Every
     * current discovery and executable-binding constructor supplies it.
     * Registry.loadBody and Executable.fromDescriptor refuse it when absent.
     */
    contentDigest: Schema.optional(
      Schema.String.check(
        Schema.isPattern(/^[0-9a-f]{64}$/, {
          expected: "a 64-character lowercase hexadecimal SHA-256 digest"
        })
      )
    )
  })
{}

/**
 * One module a flow's entry file loads from beside itself.
 *
 * `path` is the module's location relative to the entry file's directory, with
 * `/` separators, which is what the loader resolves a relative specifier
 * against and is therefore stable wherever the project is checked out.
 *
 * `contentDigest` is absent for a specifier discovery could not pin, and `path`
 * then carries the reason instead of a location: a specifier that resolves to
 * no file, a module that could not be read, a load whose target is computed
 * or made through a renamed loader, a mapping the walk does not follow, or a
 * closure past its bound. Such an entry is not a location and
 * must not be treated as one; it exists so the refusal can say what stopped it.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export class ModuleImport extends Schema.Class<ModuleImport>("flows/registry/ModuleImport")({
  path: Schema.String,
  contentDigest: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^[0-9a-f]{64}$/, {
        expected: "a 64-character lowercase hexadecimal SHA-256 digest"
      })
    )
  )
}) {}

/**
 * A module body stored at a source path.
 *
 * @category models
 * @since 0.1.0
 */
export class BodyRefModule extends Schema.TaggedClass<BodyRefModule>("flows/registry/BodyRef/Module")("Module", {
  path: Schema.String,
  /**
   * SHA-256 of the complete module source bytes measured during discovery.
   * Optional for older journaled descriptors to decode; Registry.loadBody and
   * Executable.fromDescriptor refuse an absent digest with body_unavailable.
   *
   * It measures the ENTRY FILE. What the entry loads from beside itself is
   * {@link BodyRefModule.imports}.
   */
  contentDigest: Schema.optional(
    Schema.String.check(
      Schema.isPattern(/^[0-9a-f]{64}$/, {
        expected: "a 64-character lowercase hexadecimal SHA-256 digest"
      })
    )
  ),
  /**
   * Every module the entry reaches through relative specifiers, and through
   * bare specifiers a loader maps onto project files (package.json `imports`,
   * tsconfig `paths` or `baseUrl`), sorted by path.
   *
   * ABSENT means the entry loads nothing from beside itself, which is why it is
   * optional rather than an empty array: a module with no relative imports
   * hashes exactly as it did before this field existed, so its approvals and
   * its recorded step keys do not move.
   *
   * It rides {@link executionDigest} through the ordinary schema encoding, so a
   * changed sibling is a changed executable identity and cannot reuse an
   * approval granted for the old one.
   */
  imports: Schema.optional(Schema.Array(ModuleImport))
}) {}

/**
 * A serializable locator and content address for a flow body, which is loaded
 * only on demand.
 *
 * @category models
 * @since 0.1.0
 */
export const BodyRef = Schema.Union([BodyRefMarkdown, BodyRefModule])

/**
 * A serializable locator and content address for a flow body, which is loaded
 * only on demand.
 *
 * @category models
 * @since 0.1.0
 */
export type BodyRef = typeof BodyRef.Type

/**
 * A loaded markdown prompt body.
 *
 * @category models
 * @since 0.1.0
 */
export class FlowBodyPrompt extends Schema.TaggedClass<FlowBodyPrompt>("flows/registry/FlowBody/Prompt")("Prompt", {
  text: Schema.String,
  baseDirectory: Schema.String
}) {}

/**
 * A loaded module flow body.
 *
 * @category models
 * @since 0.1.0
 */
export class FlowBodyModule extends Schema.TaggedClass<FlowBodyModule>("flows/registry/FlowBody/Module")("Module", {
  path: Schema.String
}) {}

/**
 * The body returned after an entry is loaded on demand.
 *
 * @category models
 * @since 0.1.0
 */
export const FlowBody = Schema.Union([FlowBodyPrompt, FlowBodyModule])

/**
 * The body returned after an entry is loaded on demand.
 *
 * @category models
 * @since 0.1.0
 */
export type FlowBody = typeof FlowBody.Type

/**
 * The pack a descriptor was discovered in, when it came from one.
 *
 * `origin` is what decided a name collision: a `local` pack shadows an
 * `installed` one, so an operator reading a descriptor can tell which half of
 * the merge it survived.
 *
 * @category models
 * @since 0.1.0
 */
export const PackRef = Schema.Struct({
  name: Schema.NonEmptyString,
  version: Schema.NonEmptyString,
  origin: Schema.Literals(["local", "installed"])
})

/**
 * The pack a descriptor was discovered in.
 *
 * @category models
 * @since 0.1.0
 */
export type PackRef = typeof PackRef.Type

/**
 * Opaque source information retained with each discovered entry.
 *
 * `pack` is absent for a descriptor discovered from a plain source, which is
 * every source the single-source registry scans. It is present only when a
 * pack manifest named the directory the entry was found in.
 *
 * @category models
 * @since 0.1.0
 */
export class Provenance extends Schema.Class<Provenance>("flows/registry/Provenance")({
  source: Schema.String,
  root: Schema.String,
  pack: Schema.optional(PackRef)
}) {}

/**
 * Registry source configuration. `source` is opaque caller-supplied metadata.
 *
 * @category models
 * @since 0.1.0
 */
export interface Source {
  readonly source: string
  readonly root: string
  readonly naming: "path" | "frontmatter"
  readonly system?: boolean | undefined
  /** A missing root produces an empty scan; other root failures still fail. */
  readonly optionalRoot?: boolean | undefined
  /** Pack root whose real path bounds discovery when the host can resolve it. */
  readonly confinementRoot?: string | undefined
}

/**
 * Stable codes for non-fatal source-discovery diagnostics.
 *
 * @category models
 * @since 0.1.0
 */
export const DiscoveryWarningCode = Schema.Literals([
  "missing_description",
  "invalid_description",
  "missing_name",
  "invalid_name",
  "directory_name_mismatch",
  "name_field_ignored",
  "unknown_frontmatter_key",
  "unknown_pack_key",
  "invalid_allowed_tools",
  "invalid_capabilities",
  "invalid_budget",
  "unprojectable_authority",
  "invalid_model_invocation",
  "invalid_model",
  "invalid_placement",
  "invalid_sandbox",
  "invalid_compatibility",
  "invalid_license",
  "invalid_metadata",
  "non_serializable_frontmatter",
  "invalid_effect_declaration",
  "invalid_effect_tier",
  "unsupported_input_schema",
  "unsupported_module_metadata",
  "multiple_entry_files",
  "duplicate_name",
  "frontmatter_parse_error",
  "root_level_entry",
  "shadowed",
  "symlink_cycle",
  "outside_root",
  "max_depth_exceeded",
  "entry_too_large",
  "unreadable"
])

/**
 * Stable codes for non-fatal source-discovery diagnostics.
 *
 * @category models
 * @since 0.1.0
 */
export type DiscoveryWarningCode = typeof DiscoveryWarningCode.Type

/**
 * A non-fatal source-discovery diagnostic.
 *
 * @category models
 * @since 0.1.0
 */
export class DiscoveryWarning extends Schema.Class<DiscoveryWarning>("flows/registry/DiscoveryWarning")({
  code: DiscoveryWarningCode,
  path: Schema.String,
  name: Schema.optional(Schema.String),
  message: Schema.String,
  cause: Schema.optional(Schema.Defect())
}) {}

/**
 * A positive safe-integer control-plane budget ceiling.
 *
 * Tokens are indivisible, and millisecond envelopes use the same finite,
 * lossless representation so both fields survive durable JSON unchanged.
 *
 * @category schemas
 * @since 0.1.0
 */
export const BudgetCeiling = Schema.Int.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)
)

/**
 * A positive safe-integer control-plane budget ceiling.
 *
 * @category models
 * @since 0.1.0
 */
export type BudgetCeiling = typeof BudgetCeiling.Type

/**
 * A positive, finite control-plane dollar ceiling.
 *
 * Dollars are divisible, so unlike {@link BudgetCeiling} a fraction is a
 * ceiling: `0.5` is fifty cents.
 *
 * @category schemas
 * @since 1.0.0
 */
export const UsdCeiling = Schema.Finite.check(Schema.isGreaterThan(0))

/**
 * A positive, finite control-plane dollar ceiling.
 *
 * @category models
 * @since 1.0.0
 */
export type UsdCeiling = typeof UsdCeiling.Type

/**
 * What a run does when a model call would exceed one of its ceilings.
 *
 * `fail` fails the call, `warn` journals a warning and makes it,
 * `skip-remaining` refuses it and every later call in the run, and `park`
 * suspends the run until an operator approves a raised ceiling.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export const BudgetOnExceeded = Schema.Literals(["fail", "warn", "skip-remaining", "park"])

/**
 * What a run does when a model call would exceed one of its ceilings.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export type BudgetOnExceeded = typeof BudgetOnExceeded.Type

/**
 * The tokens, milliseconds and dollars a flow declares that a control plane
 * should approve for one of its runs, and what exceeding them does.
 *
 * Tokens and milliseconds are positive safe integers; `usd` is a positive,
 * finite dollar amount. Every field is projected into a control-plane
 * `Envelope.budget` without reinterpretation, and `@smthrs/agent` enforces
 * them at the model boundary.
 *
 * An absent field is not a zero. It is the absence of that ceiling, which is
 * what {@link budgetUnbounded} spells out for a flow that declares none.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export const FlowBudget = Schema.Struct({
  tokens: Schema.optional(BudgetCeiling),
  milliseconds: Schema.optional(BudgetCeiling),
  usd: Schema.optional(UsdCeiling),
  onExceeded: Schema.optional(BudgetOnExceeded)
})

/**
 * The tokens, milliseconds and dollars a flow declares.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export type FlowBudget = typeof FlowBudget.Type

/**
 * The budget of a flow that declares none: no token ceiling and no latency
 * ceiling.
 *
 * It is a named value rather than a `{}` written at each host for the reason
 * `@smthrs/agent`'s `Budget.layerUnbounded` is a named layer rather than an
 * omitted service: giving up spending enforcement is a decision, and a reader
 * has to be able to see that a host made it. A host that projects this into an
 * envelope has decided the flow may spend what it likes.
 *
 * @category constructors
 * @since 1.0.0-rc.0
 */
export const budgetUnbounded: FlowBudget = Object.freeze({})

/**
 * A flow's declared activity, independent of its effect envelope or a plan's
 * required coverage. Absence means unknown; `other` explicitly claims none
 * of the four named activities.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const FlowActivity = Schema.Literals(["reads", "writes", "checks", "tests", "other"])

/**
 * A flow's declared activity.
 * @category models
 * @since 1.0.0-rc.0
 */
export type FlowActivity = typeof FlowActivity.Type

/**
 * Serializable call presentation. Verbs describe the recorded settlement;
 * subject and result select known input and output shapes. Result formats
 * read measured fields only, never infer counts or diffs from input. An
 * unsupported result stays available as raw output in the call details.
 *
 * These display hints grant no authority and are excluded from declaration,
 * execution and model-prompt identities.
 *
 * @category schemas
 * @since 1.0.0-rc.0
 */
export const CallPresentation = Schema.Struct({
  verb: Schema.Struct({ pending: Schema.String, success: Schema.String, failure: Schema.String }),
  subject: Schema.Literals(["path", "command", "patch", "selection", "pattern", "none"]),
  result: Schema.Literals([
    "text",
    "read",
    "write",
    "edit",
    "patch",
    "tests",
    "command",
    "matches",
    "paths",
    "entries",
    "none"
  ])
})

/**
 * Serializable call presentation.
 * @category models
 * @since 1.0.0-rc.0
 */
export type CallPresentation = typeof CallPresentation.Type

/**
 * One model seat or an ordered, non-empty fallback list.
 * @category schemas
 * @since 1.0.0
 */
export const ModelSelection = Schema.Union([Schema.String, Schema.NonEmptyArray(Schema.String)])

/**
 * One primary seat or an ordered primary and fallback list.
 *
 * @category models
 * @since 1.0.0
 */
export type ModelSelection = typeof ModelSelection.Type

/**
 * The discovered metadata for one flow, excluding its unloaded body content.
 *
 * `budget` is absent for a flow that declares none, and {@link budgetOf} is how
 * a host reads it, so the absence is answered with {@link budgetUnbounded}
 * rather than with an empty object nobody named.
 *
 * @category models
 * @since 0.1.0
 */
export class FlowDescriptor extends Schema.Class<FlowDescriptor>("flows/registry/FlowDescriptor")({
  name: Schema.String,
  description: Schema.String,
  body: BodyRef,
  input: SchemaRef,
  output: SchemaRef,
  model: Schema.Option(ModelSelection),
  flows: Schema.Array(Schema.String),
  capabilities: Schema.Array(Schema.String),
  effects: EffectDeclaration,
  placement: Schema.Option(Placement),
  sandbox: Schema.optionalKey(SandboxSelection),
  modelInvocable: Schema.Boolean,
  budget: Schema.optional(FlowBudget),
  activity: Schema.optional(FlowActivity),
  presentation: Schema.optional(CallPresentation),
  path: Schema.String,
  frontmatter: Schema.Record(Schema.String, Schema.Json),
  provenance: Provenance
}) {}

const executionDigests = new WeakMap<FlowDescriptor, string>()

/**
 * The executable identity a host binds into a reviewed plan.
 *
 * Includes the complete source digest and all executable metadata, so changing
 * the model, parameters, body location, or authority cannot reuse an approval.
 * A descriptor without measured source bytes has no executable identity; it
 * may still be displayed, but a prompt executor must refuse to run it.
 *
 * The answer is memoized on descriptor identity. A host maps this over every
 * descriptor it lists, and one call encodes the descriptor, canonicalizes the
 * result, and hashes it; a registry hands out frozen copies, so identity is
 * what the value cannot change behind. A descriptor a caller mutates after
 * asking for its digest keeps the first answer, which is what mutating a value
 * a registry already copied does everywhere else.
 *
 * @category hashing
 * @since 1.0.0
 */
export const executionDigest = (descriptor: FlowDescriptor): string | undefined => {
  if (descriptor.body.contentDigest === undefined) return undefined
  const memoized = executionDigests.get(descriptor)
  if (memoized !== undefined) return memoized
  const { activity: _activity, presentation: _presentation, ...executable } = Schema.encodeSync(FlowDescriptor)(
    descriptor
  )
  const digest = Digest.digest(Digest.canonical(executable))
  executionDigests.set(descriptor, digest)
  return digest
}

/**
 * The canonical digest of one flow's complete declaration.
 *
 * This is the single declaration identity for `FlowDescriptor`, owned by the
 * package that owns the type. `@smthrs/chain` keys its catalog entries with it
 * and `@smthrs/harness` folds it into every call identity, so one declaration
 * is one number everywhere and adding a descriptor field is one edit here
 * rather than a field two packages must each remember.
 *
 * Display-only `activity` and `presentation` are excluded, so enriching a
 * descriptor cannot invalidate call replay or a cached prompt. Within
 * `provenance`, `pack` is excluded: it describes where discovery found the
 * declaration, not what the call depends on.
 *
 * `capabilities` is sorted because a set is what it means; every other array is
 * hashed in declaration order, because order is part of what was declared.
 * `Option` and optional fields hash as `null` when absent so an omitted field
 * and a field that is present and null are one value, which is what they are
 * once the descriptor has crossed JSON.
 *
 * `BodyRef.contentDigest` is the source identity discovery or `FlowBinding.make`
 * measured. It makes an in-place body edit material even when the locator is
 * unchanged.
 *
 * Unlike {@link executionDigest} this is always defined: it identifies what was
 * declared, not whether the source bytes were measured, so a descriptor with no
 * `contentDigest` still has a declaration identity to key against.
 *
 * @category hashing
 * @since 1.0.0-rc.0
 */
export const declarationDigest = (descriptor: FlowDescriptor): string =>
  Digest.digest(Digest.canonical({
    body: { ...descriptor.body },
    budget: descriptor.budget ?? null,
    capabilities: [...descriptor.capabilities].sort(),
    description: descriptor.description,
    effects: { ...descriptor.effects },
    flows: [...descriptor.flows],
    frontmatter: { ...descriptor.frontmatter },
    input: { ...descriptor.input },
    model: Option.getOrNull(descriptor.model),
    modelInvocable: descriptor.modelInvocable,
    name: descriptor.name,
    output: { ...descriptor.output },
    path: descriptor.path,
    placement: Option.getOrNull(descriptor.placement),
    provenance: { root: descriptor.provenance.root, source: descriptor.provenance.source },
    // Spread only when present: hashing an absent selection as `null` would
    // move the identity of every declaration that selects none.
    ...(descriptor.sandbox === undefined ? {} : { sandbox: descriptor.sandbox })
  }))

/**
 * The budget one descriptor declared, or {@link budgetUnbounded}.
 *
 * Every host that builds an envelope goes through this rather than reading the
 * field, so "this flow declared nothing" is stated once and answered the same
 * way everywhere.
 *
 * @category accessors
 * @since 1.0.0-rc.0
 */
export const budgetOf = (descriptor: FlowDescriptor): FlowBudget =>
  descriptor.budget === undefined ? budgetUnbounded : Object.freeze({ ...descriptor.budget })

/**
 * The result of scanning one source.
 *
 * @category models
 * @since 0.1.0
 */
export class SourceScan extends Schema.Class<SourceScan>("flows/registry/SourceScan")({
  entries: Schema.Array(FlowDescriptor),
  warnings: Schema.Array(DiscoveryWarning)
}) {}
