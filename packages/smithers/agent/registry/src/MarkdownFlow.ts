/**
 * Discovery and prompt rendering for markdown-backed flows.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 *
 * @since 0.1.0
 */

import * as Digest from "@smthrs/core/Digest"
import type * as CoreMarkdown from "@smthrs/core/Markdown"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import {
  BodyRefMarkdown,
  BudgetOnExceeded,
  type DiscoveryWarning,
  type EffectDeclaration,
  FlowBodyPrompt,
  type FlowBudget,
  FlowDescriptor,
  type FlowDescriptor as FlowDescriptorType,
  ModelSelection,
  Placement,
  type Provenance,
  SchemaRefMarkdownArgs,
  SchemaRefMarkdownOutput
} from "./Descriptor.ts"
import type { EffectProblem } from "./internal/Authority.ts"
import { projectEffects, unprojectableDelegation } from "./internal/Authority.ts"
import * as Frontmatter from "./internal/Frontmatter.ts"
import * as Names from "./internal/Names.ts"

/**
 * The fixed decoded input schema for markdown flows.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Input = Schema.Struct({ args: Schema.String })

/**
 * The decoded input accepted by every markdown flow.
 *
 * @category models
 * @since 0.1.0
 */
export type Input = typeof Input.Type

/**
 * The fixed output schema for markdown flows.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Output = Schema.String

/**
 * The prompt text returned by a markdown flow.
 *
 * @category models
 * @since 0.1.0
 */
export type Output = typeof Output.Type

/**
 * Parameters used to derive a descriptor from already-read markdown text.
 *
 * @category models
 * @since 0.1.0
 */
export interface FromMarkdownOptions {
  readonly text: string
  /** SHA-256 of the complete source when the supplied text is a metadata prefix. */
  readonly contentDigest?: string | undefined
  readonly path: string
  readonly baseDirectory: string
  readonly naming: "path" | "frontmatter"
  readonly name: Option.Option<string>
  readonly dirBasename: string
  readonly provenance: Provenance
}

/**
 * The metadata result of markdown flow discovery.
 *
 * @category models
 * @since 0.1.0
 */
export interface FromMarkdownResult {
  readonly descriptor: Option.Option<FlowDescriptorType>
  readonly warnings: ReadonlyArray<DiscoveryWarning>
}

/**
 * Derives a markdown flow descriptor without retaining the prompt body.
 *
 * @category constructors
 * @since 0.1.0
 */
export const fromMarkdown = (options: FromMarkdownOptions): FromMarkdownResult => {
  const parsed = Frontmatter.parse({ text: options.text, path: options.path })
  const warnings = [...parsed.warnings]
  const fields = parsed.fields
  const description = fields.description
  const name = deriveName(options, fields, warnings)

  if (typeof description !== "string" || description.trim() === "") {
    warnings.push({
      code: "missing_description",
      path: options.path,
      name,
      message: "Markdown flows require a non-empty frontmatter description"
    })
    return { descriptor: Option.none(), warnings }
  }
  if ([...description].length > 1024) {
    warnings.push({
      code: "invalid_description",
      path: options.path,
      name,
      message: "Frontmatter description exceeds the 1024-character Agent Skills limit"
    })
  }

  validateStandardFields(fields, options.path, warnings)
  const flows = deriveFlows(fields, options.path, warnings)
  const delegation = flows.length === 0 ? undefined : unprojectableDelegation()
  const capabilities = deriveCapabilities(fields, delegation, options.path, warnings)
  if (capabilities === undefined) return { descriptor: Option.none(), warnings }
  const modelInvocable = deriveModelInvocable(fields, options.path, warnings)
  const effects = deriveEffects(fields, capabilities, options.path, warnings)
  const placement = derivePlacement(fields, options.path, warnings)
  const budget = deriveBudget(fields, options.path, warnings)
  const selected: unknown = fields.model
  const validModels = Schema.is(ModelSelection)(selected) &&
    (typeof selected === "string" ? selected.trim() !== "" : selected.every((seat) => seat.trim() !== ""))
  if (Array.isArray(selected) && !validModels) {
    warnings.push({
      code: "invalid_model",
      path: options.path,
      name,
      message: "model must be a non-empty list of non-empty seat names"
    })
    return { descriptor: Option.none(), warnings }
  }
  const model = validModels ? Option.some(selected) : Option.none<ModelSelection>()
  warnUnsupportedSchema(fields, options.path, warnings)
  warnUnknownFields(fields, options.path, warnings)

  return {
    descriptor: Option.some(
      new FlowDescriptor({
        name,
        description,
        body: new BodyRefMarkdown({
          path: options.path,
          baseDirectory: options.baseDirectory,
          contentDigest: options.contentDigest ?? Digest.digest(options.text)
        }),
        input: new SchemaRefMarkdownArgs({}),
        output: new SchemaRefMarkdownOutput({}),
        model,
        flows,
        capabilities,
        effects,
        placement,
        modelInvocable,
        ...(budget === undefined ? {} : { budget }),
        path: options.path,
        frontmatter: fields,
        provenance: options.provenance
      })
    ),
    warnings
  }
}

/**
 * Loads a markdown prompt body after discovery, removing only leading frontmatter.
 *
 * @category constructors
 * @since 0.1.0
 */
export const loadBody = (text: string, baseDirectory: string): FlowBodyPrompt =>
  new FlowBodyPrompt({
    text: Frontmatter.split(text).body,
    baseDirectory
  })

/**
 * Renders decoded markdown-flow arguments using the compatible skill convention.
 *
 * @category rendering
 * @since 0.1.0
 */
export const renderPrompt = (body: FlowBodyPrompt, input: { readonly args: string }): string =>
  [
    body.text,
    "",
    "Supporting skill resources are available relative to this skill directory but are not loaded into context unless needed:",
    "<skill_resources>",
    `- Base directory: ${body.baseDirectory}`,
    "- Resolve relative resource paths from this directory and read only the files you need.",
    "</skill_resources>",
    ...(input.args === "" ? [] : ["", input.args])
  ].join("\n")

/**
 * Projects a registry descriptor into the one authoring value accepted by
 * `/core/Markdown`. This is the deliberate registry-to-core adapter
 * boundary; metadata is not independently reinterpreted downstream.
 *
 * @category conversions
 * @since 0.1.0
 */
export const toCoreFrontmatter = (descriptor: FlowDescriptorType): CoreMarkdown.MarkdownFrontmatter => ({
  name: descriptor.name,
  description: descriptor.description,
  flows: descriptor.flows,
  capabilities: descriptor.capabilities,
  effects: descriptor.effects,
  ...(Option.getOrUndefined(descriptor.model) === undefined
    ? {}
    : { model: Option.getOrThrow(descriptor.model) }),
  ...(Option.getOrUndefined(descriptor.placement) === undefined
    ? {}
    : { placement: Option.getOrThrow(descriptor.placement) })
})

const deriveName = (
  options: FromMarkdownOptions,
  fields: Record<string, unknown>,
  warnings: Array<DiscoveryWarning>
): string => {
  if (options.naming === "frontmatter") {
    const derived = Names.deriveFromFrontmatter({ fields, dirBasename: options.dirBasename, path: options.path })
    warnings.push(...derived.warnings)
    return derived.name
  }

  if (Object.hasOwn(fields, "name")) {
    warnings.push({
      code: "name_field_ignored",
      path: options.path,
      message: "Ignoring frontmatter name because this source uses path-derived names"
    })
  }
  return Option.getOrElse(options.name, () => options.dirBasename)
}

const deriveCapabilities = (
  fields: Record<string, unknown>,
  delegation: ReturnType<typeof unprojectableDelegation> | undefined,
  path: string,
  warnings: Array<DiscoveryWarning>
): ReadonlyArray<string> | undefined => {
  if (!Object.hasOwn(fields, "capabilities")) {
    warnings.push({
      code: "unprojectable_authority",
      path,
      message: delegation === undefined
        ? "Markdown authority is not declared; the flow receives every capability"
        : "Delegated flow authority cannot be projected statically; the flow receives every capability"
    })
    return delegation?.capabilities ?? ["*"]
  }

  const value = fields.capabilities
  let capabilities: ReadonlyArray<string>
  if (typeof value === "string") {
    warnings.push({
      code: "invalid_capabilities",
      path,
      message: "Frontmatter capabilities should be a string array; accepting the space-separated string"
    })
    capabilities = value.split(/\s+/).filter((capability) => capability.length > 0)
  } else if (
    Array.isArray(value) &&
    value.every((capability): capability is string => typeof capability === "string")
  ) {
    capabilities = value
  } else {
    // A typo in a narrow list must not widen it to every capability, so the
    // flow is not discovered until the value is a string array.
    warnings.push({
      code: "invalid_capabilities",
      path,
      message: `Frontmatter capabilities must be a string array, got ${
        JSON.stringify(value)
      }; the flow is not discovered`
    })
    return undefined
  }

  if (delegation !== undefined) {
    warnings.push({
      code: "unprojectable_authority",
      path,
      message: "Delegated flow authority cannot be projected statically; the flow receives every capability"
    })
    return delegation.capabilities
  }
  return capabilities
}

const deriveFlows = (
  fields: Record<string, unknown>,
  path: string,
  warnings: Array<DiscoveryWarning>
): ReadonlyArray<string> => {
  const value = fields.flows ?? fields["allowed-tools"]
  if (value === undefined) return []
  if (typeof value === "string") {
    return value.split(/\s+/).filter((flow) => flow.length > 0)
  }
  if (Array.isArray(value) && value.every((flow): flow is string => typeof flow === "string")) {
    return value
  }
  warnings.push({
    code: "invalid_allowed_tools",
    path,
    message: "Ignoring malformed flows; expected a string array or Agent Skills allowed-tools string"
  })
  return []
}

const deriveModelInvocable = (
  fields: Record<string, unknown>,
  path: string,
  warnings: Array<DiscoveryWarning>
): boolean => {
  if (!Object.hasOwn(fields, "disable-model-invocation")) {
    return true
  }
  if (
    fields["disable-model-invocation"] === true ||
    fields["disable-model-invocation"] === "true"
  ) {
    return false
  }
  if (
    fields["disable-model-invocation"] === false ||
    fields["disable-model-invocation"] === "false"
  ) {
    return true
  }

  warnings.push({
    code: "invalid_model_invocation",
    path,
    message: "Ignoring disable-model-invocation; expected a boolean"
  })
  return true
}

const effectWarning = (problem: EffectProblem, path: string): DiscoveryWarning => {
  switch (problem._tag) {
    case "unreadableDeclaration":
      return {
        code: "invalid_effect_declaration",
        path,
        message: "Frontmatter effects must be an object; using conservative effects"
      }
    case "unreadableMember":
      return {
        code: "invalid_effect_declaration",
        path,
        message: `Frontmatter effects.${problem.member} must be a string array; using the conservative wildcard`
      }
    case "invalidMode":
      return {
        code: "invalid_effect_declaration",
        path,
        message: "Frontmatter effects.mode must be hermetic or expected; using expected"
      }
    case "invalidOnConflict":
      return {
        code: "invalid_effect_declaration",
        path,
        message: "Frontmatter effects.onConflict must be serialize, lane, or fail; using serialize"
      }
    case "invalidTier":
      return {
        code: "invalid_effect_tier",
        path,
        message: "Ignoring invalid effects.tier; using irreversible"
      }
    case "underClassifiedTier":
      return {
        code: "invalid_effect_tier",
        path,
        message: `Effect tier ${problem.declared} under-classifies declared authority; using ${problem.projected}`
      }
  }
}

const deriveEffects = (
  fields: Record<string, unknown>,
  capabilities: ReadonlyArray<string>,
  path: string,
  warnings: Array<DiscoveryWarning>
): EffectDeclaration => {
  const value = fields.effects
  const object = typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
  const paths = (key: "reads" | "writes"): ReadonlyArray<string> | "unreadable" | undefined => {
    const candidate = object?.[key]
    if (candidate === undefined) return undefined
    return Array.isArray(candidate) && candidate.every((item): item is string => typeof item === "string")
      ? candidate
      : "unreadable"
  }
  const literal = (key: "mode" | "onConflict" | "tier"): string | undefined => {
    const candidate = object?.[key]
    if (candidate === undefined) return undefined
    return typeof candidate === "string" ? candidate : "unreadable"
  }
  const projection = projectEffects({
    capabilities,
    declaration: value === undefined
      ? undefined
      : object === undefined
      ? "unreadable"
      : {
        reads: paths("reads"),
        writes: paths("writes"),
        mode: literal("mode"),
        onConflict: literal("onConflict"),
        tier: literal("tier")
      }
  })
  for (const problem of projection.problems) {
    warnings.push(effectWarning(problem, path))
  }
  return projection.effects
}

/** The accepted placements, spelled the way the warning reads them back. */
const placements = `${Placement.literals.slice(0, -1).join(", ")}, or ${Placement.literals.at(-1)}`

const isPlacement = Schema.is(Placement)

const derivePlacement = (
  fields: Record<string, unknown>,
  path: string,
  warnings: Array<DiscoveryWarning>
): Option.Option<Placement> => {
  const value = fields.placement
  if (value === undefined) return Option.none()
  if (isPlacement(value)) return Option.some(value)
  warnings.push({
    code: "invalid_placement",
    path,
    message: `Ignoring invalid placement; expected ${placements}`
  })
  return Option.none()
}

/**
 * Reads the frontmatter budget: the tokens and milliseconds this flow asks a
 * control plane to approve for one of its runs, and what exceeding them does.
 *
 * ```yaml
 * budget:
 *   tokens: 120000
 *   milliseconds: 900000
 *   onExceeded: park
 * ```
 *
 * A malformed budget is dropped rather than tightened, which is the opposite of
 * how every other field here reads a malformed value. The other fields have a
 * conservative reading to fall back on; a budget has none. Its conservative
 * number is zero, and a zero ceiling refuses the run's first call, so a typo
 * would be reported as a spending decision. An unreadable declaration therefore
 * leaves the flow exactly where an undeclared one leaves it, unbounded, and
 * says so in a warning an operator reads back through `registry.warnings()`.
 */
const deriveBudget = (
  fields: Record<string, unknown>,
  path: string,
  warnings: Array<DiscoveryWarning>
): FlowBudget | undefined => {
  const value = fields.budget
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    warnings.push({
      code: "invalid_budget",
      path,
      message: "Frontmatter budget must be an object of tokens and milliseconds; ignoring it"
    })
    return undefined
  }

  const declared = value as Record<string, unknown>
  // YAML's failsafe schema supplies strings, while already-sanitized JSON may
  // supply numbers. Both must become positive safe integers so the durable
  // envelope preserves them exactly.
  const ceiling = (key: "tokens" | "milliseconds"): number | undefined => {
    const candidate = declared[key]
    if (candidate === undefined) return undefined
    const parsed = typeof candidate === "number"
      ? candidate
      : typeof candidate === "string"
      ? Number(candidate)
      : Number.NaN
    if (Number.isSafeInteger(parsed) && parsed > 0) return parsed
    warnings.push({
      code: "invalid_budget",
      path,
      message: `Frontmatter budget.${key} must be a positive safe integer; ignoring it`
    })
    return undefined
  }

  const tokens = ceiling("tokens")
  const milliseconds = ceiling("milliseconds")
  // An unreadable choice falls back to the budget's default, `fail`, which is
  // what an undeclared one means: the ceilings still bind.
  const choice = (): BudgetOnExceeded | undefined => {
    const candidate = declared.onExceeded
    if (candidate === undefined || Schema.is(BudgetOnExceeded)(candidate)) return candidate
    warnings.push({
      code: "invalid_budget",
      path,
      message: `Frontmatter budget.onExceeded must be one of ${BudgetOnExceeded.literals.join(", ")}; ignoring it`
    })
    return undefined
  }
  const onExceeded = choice()
  // A misspelled ceiling is the failure mode this catches: `budget.token` reads
  // as no declaration at all, and an unbounded run is the last thing an author
  // who wrote a budget expects to get back in silence.
  for (const key of Object.keys(declared)) {
    if (key === "tokens" || key === "milliseconds" || key === "onExceeded") continue
    warnings.push({
      code: "invalid_budget",
      path,
      message: `Unknown frontmatter budget key: ${key}`
    })
  }
  if (tokens === undefined && milliseconds === undefined) return undefined
  return {
    ...(tokens === undefined ? {} : { tokens }),
    ...(milliseconds === undefined ? {} : { milliseconds }),
    ...(onExceeded === undefined ? {} : { onExceeded })
  }
}

const validateStandardFields = (
  fields: Record<string, unknown>,
  path: string,
  warnings: Array<DiscoveryWarning>
): void => {
  if (Object.hasOwn(fields, "license") && typeof fields.license !== "string") {
    warnings.push({
      code: "invalid_license",
      path,
      message: "Frontmatter license must be a string when provided"
    })
  }

  if (Object.hasOwn(fields, "compatibility")) {
    const compatibility = fields.compatibility
    if (typeof compatibility !== "string" || [...compatibility].length > 500) {
      warnings.push({
        code: "invalid_compatibility",
        path,
        message: "Frontmatter compatibility must be a string of at most 500 characters"
      })
    }
  }

  if (Object.hasOwn(fields, "metadata")) {
    const metadata = fields.metadata
    if (
      typeof metadata !== "object" ||
      metadata === null ||
      Array.isArray(metadata) ||
      !Object.values(metadata).every((value) => typeof value === "string")
    ) {
      warnings.push({
        code: "invalid_metadata",
        path,
        message: "Frontmatter metadata must be a string-to-string mapping"
      })
    }
  }
}

const warnUnsupportedSchema = (
  fields: Record<string, unknown>,
  path: string,
  warnings: Array<DiscoveryWarning>
): void => {
  for (const key of ["input", "schema"]) {
    if (Object.hasOwn(fields, key)) {
      warnings.push({
        code: "unsupported_input_schema",
        path,
        message: `Ignoring unsupported markdown flow ${key} frontmatter`
      })
    }
  }
}

const knownFields = new Set([
  "name",
  "description",
  "license",
  "compatibility",
  "allowed-tools",
  "flows",
  "model",
  "effort",
  "capabilities",
  "effects",
  "placement",
  "budget",
  "metadata",
  "disable-model-invocation",
  "input",
  "schema"
])

const warnUnknownFields = (fields: Record<string, unknown>, path: string, warnings: Array<DiscoveryWarning>): void => {
  for (const key of Object.keys(fields)) {
    if (!knownFields.has(key)) {
      warnings.push({
        code: "unknown_frontmatter_key",
        path,
        message: `Unknown frontmatter key: ${key}`
      })
    }
  }
}
