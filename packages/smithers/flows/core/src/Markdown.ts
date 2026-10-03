/**
 * Parses Agent Skills documents and lowers markdown prompts into ordinary
 * flows.
 *
 * General markdown discovery belongs to `/registry`. Agent Skills
 * frontmatter is parsed with the complete failsafe YAML schema, then checked
 * against the intrinsic rules of the Agent Skills specification
 * (https://agentskills.io/specification), before this module lowers the
 * document to the ordinary flow shape. The one rule that needs the file
 * system, that `name` equals the skill directory name, stays with the
 * registry.
 *
 * Governing contract: `packages/smithers/flows/core/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/core.
 *
 * @since 0.0.0
 */

import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as Annotations from "./Annotations.ts"
import * as Effects from "./Effects.ts"
import * as Flow from "./Flow.ts"
import { build } from "./internal/Signature.ts"
import * as skillFrontmatter from "./internal/skillFrontmatter.ts"
import * as Placement from "./Placement.ts"

/**
 * Separates leading YAML frontmatter from the markdown body without parsing it.
 * @category parsing
 * @since 1.0.0
 */
export { split as splitFrontmatter } from "./internal/skillFrontmatter.ts"

const input = Schema.Struct({ args: Schema.String })
const output = Schema.String

/**
 * Already-parsed metadata accepted by the markdown flow loader.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface MarkdownFrontmatter {
  /**
   * The flow's name, which becomes its tag.
   *
   * It is required because the tag is what a host binds an implementation to
   * and what a plan records; a registry derives it from the frontmatter or
   * from the document's path before lowering.
   */
  readonly name: string
  readonly description?: string | undefined
  readonly model?: string | readonly [string, ...Array<string>] | undefined
  readonly flows?: ReadonlyArray<string> | undefined
  readonly capabilities?: ReadonlyArray<string> | undefined
  readonly effects?: {
    readonly reads?: ReadonlyArray<string> | undefined
    readonly writes?: ReadonlyArray<string> | undefined
    readonly mode?: Effects.Declaration["mode"] | undefined
    readonly onConflict?: Effects.Declaration["onConflict"] | undefined
    readonly tier?: Effects.Declaration["tier"]
  } | undefined
  readonly placement?: "sandbox" | "remote" | "client" | "local" | undefined
}

/**
 * Agent Skills frontmatter that passed {@link validateSkillFrontmatter}.
 *
 * `allowedTools` is the specification's space-separated `allowed-tools`
 * scalar, split into tool names. `extra` holds every other field, including
 * the validated optional `license`, `compatibility`, and `metadata`, as a
 * frozen null-prototype record.
 *
 * @category models
 * @since 1.0.0-rc.0
 */
export interface SkillFrontmatter {
  readonly name: string
  readonly description: string
  readonly allowedTools: ReadonlyArray<string>
  readonly extra: Record<string, unknown>
}

/**
 * Parsed Agent Skills document.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export interface SkillDocument extends SkillFrontmatter {
  readonly body: string
}

/**
 * Stable code emitted by markdown loader failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export const MarkdownErrorCode = Schema.Literals([
  "skill_missing_frontmatter",
  "skill_invalid_frontmatter",
  "skill_missing_name",
  "skill_invalid_name",
  "skill_missing_description",
  "skill_invalid_description",
  "skill_invalid_allowed_tools",
  "skill_invalid_compatibility",
  "skill_invalid_metadata",
  "skill_invalid_license"
])

/**
 * Stable code emitted by markdown loader failures.
 *
 * @category models
 * @since 0.0.0
 * @slop
 */
export type MarkdownErrorCode = typeof MarkdownErrorCode.Type

/**
 * A typed markdown loader failure.
 *
 * @category errors
 * @since 0.0.0
 * @slop
 */
export class MarkdownError extends Schema.TaggedError<MarkdownError>()("flows/core/MarkdownError", {
  code: MarkdownErrorCode,
  message: Schema.String
}) {}

/**
 * Lowers parsed markdown metadata and a markdown body to an ordinary flow.
 *
 * The prompt is the markdown body. Harnesses append non-empty runtime `args`
 * when rendering that prompt, preserving the markdown-flow calling convention.
 * The lowered flow declares no body, so it carries the action a host supplies
 * the implementation for; the collaborators it names stay declarations, and no
 * flow implementation is resolved while lowering. The `smart` model seat is
 * the explicit fallback when frontmatter declares no `model`.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const lowerMarkdown = (
  frontmatter: MarkdownFrontmatter,
  body: string
): Flow.Flow<typeof input, typeof output> => {
  const flow = build({
    error: Schema.Never,
    annotations: Annotations.empty,
    body: undefined,
    name: frontmatter.name,
    description: frontmatter.description,
    input,
    output,
    capabilities: [...new Set(frontmatter.capabilities ?? [])].sort(),
    effects: undefined,
    ...(frontmatter.effects === undefined
      ? {}
      : {
        effects: Effects.make({
          reads: frontmatter.effects.reads ?? [],
          writes: frontmatter.effects.writes ?? [],
          mode: frontmatter.effects.mode ?? "hermetic",
          onConflict: frontmatter.effects.onConflict ?? "serialize",
          tier: frontmatter.effects.tier
        })
      }),
    model: frontmatter.model ?? "smart",
    flows: frontmatter.flows ?? [],
    prompt: body
  })

  switch (frontmatter.placement) {
    case "sandbox":
      return Flow.within(flow, Placement.sandbox())
    case "remote":
      return Flow.within(flow, Placement.remote())
    case "client":
      return Flow.within(flow, Placement.client())
    case "local":
      return Flow.within(flow, Placement.local())
    default:
      return flow
  }
}

const fail = (code: MarkdownErrorCode, message: string): Result.Result<never, MarkdownError> =>
  Result.fail(new MarkdownError({ code, message }))

// The specification's name grammar: lowercase ASCII letters and digits joined
// by single hyphens, so a leading, trailing, or doubled hyphen fails here.
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/**
 * Whether `name` is a valid Agent Skills name: 1 to 64 lowercase ASCII
 * letters, digits, or single hyphens, not starting or ending with a hyphen.
 *
 * {@link validateSkillFrontmatter} applies this rule, and `@smthrs/registry`
 * reads the same predicate when it warns about a discovered skill's name, so
 * the rule has one definition.
 *
 * @category validation
 * @since 1.0.0-rc.1
 */
export const isSkillName = (name: string): boolean => name.length <= 64 && skillNamePattern.test(name)

// The specification measures a field in characters. Counting UTF-16 units
// would reject a 600-emoji description the specification accepts, so the
// count walks code points.
const codePoints = (value: string): number => [...value].length

const isBlank = (value: string): boolean => value.trim() === ""

const isScalarMapping = (value: unknown): boolean =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  Object.values(value).every((member) => typeof member === "string")

/**
 * Checks already-parsed Agent Skills frontmatter against the specification's
 * intrinsic rules and lowers the fields this package reads.
 *
 * `name` is 1 to 64 lowercase ASCII letters, digits, or single hyphens and
 * cannot start or end with a hyphen. `description` is 1 to 1024 characters.
 * `allowed-tools`, when present, is one space-separated scalar. `license` is
 * a scalar, `compatibility` is 1 to 500 characters, and `metadata` maps
 * string keys to scalar values. A field that is absent reports a `missing`
 * code; a field that is present but malformed reports its own `invalid` code
 * without echoing the offending value. The registry keeps the one rule that
 * needs the file system: `name` must equal the skill directory name.
 *
 * @category validation
 * @since 1.0.0-rc.0
 */
export const validateSkillFrontmatter = (
  fields: Record<string, unknown>
): Result.Result<SkillFrontmatter, MarkdownError> => {
  const name = fields.name
  if (name === undefined || (typeof name === "string" && isBlank(name))) {
    return fail("skill_missing_name", "SKILL.md requires a non-empty frontmatter name")
  }
  if (typeof name !== "string" || !isSkillName(name)) {
    return fail(
      "skill_invalid_name",
      "SKILL.md name must be 1 to 64 lowercase ASCII letters, digits, or single hyphens, and cannot start or end with a hyphen"
    )
  }

  const description = fields.description
  if (description === undefined || (typeof description === "string" && isBlank(description))) {
    return fail("skill_missing_description", "SKILL.md requires a non-empty frontmatter description")
  }
  if (typeof description !== "string" || codePoints(description) > 1024) {
    return fail("skill_invalid_description", "SKILL.md description must be a scalar of 1 to 1024 characters")
  }

  const allowedToolsValue = fields["allowed-tools"]
  if (allowedToolsValue !== undefined && typeof allowedToolsValue !== "string") {
    return fail("skill_invalid_allowed_tools", "SKILL.md allowed-tools must be a space-separated scalar")
  }
  const allowedTools = allowedToolsValue === undefined
    ? []
    : allowedToolsValue.split(/\s+/).filter((tool) => tool.length > 0)

  const license = fields.license
  if (license !== undefined && typeof license !== "string") {
    return fail("skill_invalid_license", "SKILL.md license must be a scalar")
  }

  const compatibility = fields.compatibility
  if (
    compatibility !== undefined &&
    (typeof compatibility !== "string" || codePoints(compatibility) < 1 || codePoints(compatibility) > 500)
  ) {
    return fail("skill_invalid_compatibility", "SKILL.md compatibility must be a scalar of 1 to 500 characters")
  }

  const metadata = fields.metadata
  if (metadata !== undefined && !isScalarMapping(metadata)) {
    return fail("skill_invalid_metadata", "SKILL.md metadata must be a mapping from string keys to scalar values")
  }

  const extra = Object.create(null) as Record<string, unknown>
  for (const [key, value] of Object.entries(fields)) {
    if (key !== "name" && key !== "description" && key !== "allowed-tools") {
      Object.defineProperty(extra, key, {
        value,
        enumerable: true,
        writable: false,
        configurable: false
      })
    }
  }
  Object.freeze(extra)

  return Result.succeed({ name, description, allowedTools, extra })
}

/**
 * Parses an Agent Skills document with failsafe-schema YAML semantics and
 * validates its frontmatter with {@link validateSkillFrontmatter}.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const parseSkill = (text: string): Result.Result<SkillDocument, MarkdownError> => {
  const split = skillFrontmatter.split(text)
  if (split.frontmatter === undefined) {
    return fail("skill_missing_frontmatter", "SKILL.md requires leading frontmatter")
  }

  const parsed = skillFrontmatter.parse(split.frontmatter)
  if (Result.isFailure(parsed)) {
    return fail("skill_invalid_frontmatter", parsed.failure)
  }

  return Result.map(validateSkillFrontmatter(parsed.success), (frontmatter) => ({
    ...frontmatter,
    body: split.body
  }))
}

/**
 * Parses and lowers an Agent Skills document to an ordinary flow.
 *
 * Only `name`, `description`, and `allowed-tools` are lowered. Every other
 * frontmatter field remains in {@link parseSkill}'s `extra` record for the
 * caller to interpret. Agent Skills frontmatter is untyped failsafe YAML;
 * coercing extra fields such as `model` or `placement` here would duplicate
 * the flow-level frontmatter typing owned by `@smthrs/registry`.
 *
 * @category constructors
 * @since 0.0.0
 * @slop
 */
export const lowerSkill = (
  text: string
): Result.Result<Flow.Flow<typeof input, typeof output>, MarkdownError> =>
  Result.map(parseSkill(text), (skill) =>
    lowerMarkdown({
      name: skill.name,
      description: skill.description,
      flows: skill.allowedTools
    }, skill.body))
