/**
 * Conservative effect-tier inference for statically projected authority.
 *
 * Governing contract: `packages/smithers/agent/registry/docs/api.md`, published as
 * https://smithers.sh/docs/reference/api/registry.
 *
 * @since 0.1.0
 */

import type { EffectDeclaration, EffectTier } from "../Descriptor.ts"

const tierRank: Record<EffectTier, number> = {
  sealed: 0,
  compensable: 1,
  irreversible: 2
}

const sealedActions = ["fs:read", "net:get", "model:call", "jj:status", "jj:diff"] as const

/**
 * Returns the more conservative of two effect tiers.
 *
 * @category authority
 * @since 0.1.0
 */
export const maxTier = (left: EffectTier, right: EffectTier): EffectTier =>
  tierRank[left] >= tierRank[right] ? left : right

/**
 * The one projection that cannot understate authority discovery could not
 * read: wildcard reads and writes, an incomplete effect set, a serialized
 * conflict policy, and an irreversible tier.
 *
 * @category authority
 * @since 1.0.0-rc.0
 */
export const conservativeEffects: EffectDeclaration = {
  reads: ["**"],
  writes: ["**"],
  mode: "expected",
  onConflict: "serialize",
  tier: "irreversible"
}

/**
 * Projects the README's conservative authority for a non-empty delegate list
 * whose authority discovery cannot independently resolve.
 *
 * @category authority
 * @since 1.0.0-rc.0
 */
export const unprojectableDelegation = (): EffectDeclaration & {
  readonly capabilities: ReadonlyArray<string>
} => ({
  capabilities: ["*"],
  ...conservativeEffects
})

/**
 * Bounds a delegating flow's declared capabilities by its delegate grant. The
 * declaration is the ceiling: a capability survives only when the grant is the
 * wildcard or names it exactly, so a declaration may narrow the grant and can
 * never widen it.
 *
 * @category authority
 * @since 1.0.0-rc.1
 */
export const narrowDelegation = (
  grant: ReadonlyArray<string>,
  declared: ReadonlyArray<string>
): ReadonlyArray<string> =>
  grant.includes("*")
    ? [...new Set(declared)]
    : [...new Set(declared.filter((capability) => grant.includes(capability)))]

const tierForCapability = (capability: string): EffectTier => {
  const normalized = capability.toLowerCase()
  if (
    normalized === "read" ||
    normalized === "grep" ||
    normalized === "glob" ||
    normalized === "ls" ||
    sealedActions.some((action) => normalized === action || normalized.startsWith(`${action}:`))
  ) {
    return "sealed"
  }
  if (normalized.startsWith("fs:write:")) {
    const resource = capability.slice("fs:write:".length).trim().replaceAll("\\", "/")
    const segments = resource.split("/")
    const firstSegment = segments.find((segment) => segment !== "" && segment !== ".")
    if (
      resource.length > 0 &&
      !resource.startsWith("/") &&
      !/^[A-Za-z]:\//.test(resource) &&
      !/^[A-Za-z][A-Za-z0-9+.-]*:/.test(resource) &&
      firstSegment?.startsWith("~") !== true &&
      !segments.some((segment) => segment.startsWith("$") || segment.includes("${") || /^%[^%]+%$/.test(segment))
    ) {
      let depth = 0
      for (const segment of segments) {
        if (segment === "" || segment === ".") {
          continue
        }
        if (segment === "..") {
          if (depth === 0) {
            return "irreversible"
          }
          depth--
        } else {
          depth++
        }
      }
      return "compensable"
    }
  }
  return "irreversible"
}

/**
 * Infers a conservative tier from projected capabilities. Unknown authority,
 * including wildcard, shell tools, and unscoped writes, is irreversible. Only
 * an explicit relative `fs:write:<resource>` path with no home marker, no
 * variable reference, and no scheme proves that a file write is compensable
 * during registry discovery.
 *
 * @category authority
 * @since 0.1.0
 */
export const inferEffectTier = (capabilities: ReadonlyArray<string>): EffectTier =>
  capabilities.reduce<EffectTier>(
    (tier, capability) => maxTier(tier, tierForCapability(capability)),
    "sealed"
  )

/**
 * A declared `effects` object as a body decoder reads it, before any
 * conservative widening. An absent member is `undefined`. A member whose
 * spelling discovery cannot project is `"unreadable"`, which no valid mode,
 * conflict policy, or tier matches, so it takes the same branch as an invalid
 * literal.
 *
 * @category authority
 * @since 1.0.0-rc.0
 */
export type DeclaredEffects = {
  readonly reads: ReadonlyArray<string> | "unreadable" | undefined
  readonly writes: ReadonlyArray<string> | "unreadable" | undefined
  readonly mode: string | undefined
  readonly onConflict: string | undefined
  readonly tier: string | undefined
}

/**
 * What a projection found wrong with a declaration. Each body kind spells
 * these in its own warning vocabulary.
 *
 * @category authority
 * @since 1.0.0-rc.0
 */
export type EffectProblem =
  | { readonly _tag: "unreadableDeclaration" }
  | { readonly _tag: "unreadableMember"; readonly member: "reads" | "writes" }
  | { readonly _tag: "invalidMode" }
  | { readonly _tag: "invalidOnConflict" }
  | { readonly _tag: "invalidTier" }
  | { readonly _tag: "underClassifiedTier"; readonly declared: EffectTier; readonly projected: EffectTier }

/**
 * Projects one declaration into the effects a descriptor carries, and the
 * problems the caller reports. Markdown and module bodies decode different
 * syntax into the same input, so the rule that widens a declaration is decided
 * here once rather than per body kind.
 *
 * Wildcard capabilities force the whole conservative projection, whether the
 * flow declared them or discovery projected them because it could not read the
 * authority. An omitted `reads` or `writes` in a readable declaration is the
 * empty set; an unreadable one is the wildcard.
 *
 * @category authority
 * @since 1.0.0-rc.0
 */
export const projectEffects = (input: {
  readonly capabilities: ReadonlyArray<string>
  readonly declaration: DeclaredEffects | "unreadable" | undefined
}): { readonly effects: EffectDeclaration; readonly problems: ReadonlyArray<EffectProblem> } => {
  const problems: Array<EffectProblem> = []
  const declaration = input.declaration === "unreadable" ? undefined : input.declaration
  let conservative = input.capabilities.includes("*") || input.declaration === "unreadable"
  if (input.declaration === "unreadable") {
    problems.push({ _tag: "unreadableDeclaration" })
  }

  const paths = (member: "reads" | "writes"): ReadonlyArray<string> => {
    const declared = declaration?.[member]
    if (declared === undefined) return []
    if (declared === "unreadable") {
      conservative = true
      problems.push({ _tag: "unreadableMember", member })
      return conservativeEffects[member]
    }
    return declared
  }
  const reads = paths("reads")
  const writes = paths("writes")

  const inferred = inferEffectTier(input.capabilities)
  let tier = inferred
  const declaredTier = declaration?.tier
  if (declaredTier === "sealed" || declaredTier === "compensable" || declaredTier === "irreversible") {
    tier = maxTier(declaredTier, inferred)
    if (tier !== declaredTier) {
      problems.push({ _tag: "underClassifiedTier", declared: declaredTier, projected: tier })
    }
  } else if (declaredTier !== undefined) {
    tier = "irreversible"
    problems.push({ _tag: "invalidTier" })
  }

  const mode = declaration?.mode
  if (mode !== undefined && mode !== "hermetic" && mode !== "expected") {
    conservative = true
    problems.push({ _tag: "invalidMode" })
  }
  const onConflict = declaration?.onConflict
  if (
    onConflict !== undefined &&
    onConflict !== "serialize" &&
    onConflict !== "lane" &&
    onConflict !== "fail"
  ) {
    conservative = true
    problems.push({ _tag: "invalidOnConflict" })
  }

  return {
    effects: {
      reads: conservative ? conservativeEffects.reads : reads,
      writes: conservative ? conservativeEffects.writes : writes,
      mode: conservative || mode === "expected" ? "expected" : "hermetic",
      onConflict: onConflict === "lane" || onConflict === "fail" ? onConflict : conservativeEffects.onConflict,
      tier: conservative ? conservativeEffects.tier : tier
    },
    problems
  }
}
