/**
 * Structured memory namespaces and tag-group matching.
 *
 * @since 0.1.0
 */

import * as Schema from "effect/Schema"

/**
 * Stable namespace lifetimes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Kind = Schema.Literals(["flow", "agent", "user", "global"])

/**
 * Stable namespace lifetime.
 *
 * @category models
 * @since 0.1.0
 */
export type Kind = typeof Kind.Type

/**
 * Structured memory namespace.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Namespace = Schema.Struct({
  kind: Kind,
  id: Schema.NonEmptyString
})

/**
 * Structured memory namespace.
 *
 * @category models
 * @since 0.1.0
 */
export type Namespace = typeof Namespace.Type

/**
 * Maximum number of tags accepted on one record or tag-group leaf.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_TAGS = 16

/**
 * Maximum root-inclusive depth of one tag-group expression.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_TAG_GROUP_DEPTH = 8

/**
 * Maximum number of expression nodes in one tag-group tree.
 *
 * @category constants
 * @since 0.1.0
 */
export const MAX_TAG_GROUP_NODES = 64

/**
 * Stable tag prefixes.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TagPrefix = Schema.Literals(["branch:", "stream:", "source:", "scope:"])

/**
 * Stable tag prefix.
 *
 * @category models
 * @since 0.1.0
 */
export type TagPrefix = typeof TagPrefix.Type

/**
 * A vocabulary-constrained memory tag.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Tag = Schema.TemplateLiteral([TagPrefix, Schema.NonEmptyString])

/**
 * A vocabulary-constrained memory tag.
 *
 * @category models
 * @since 0.1.0
 */
export type Tag = typeof Tag.Type

/**
 * A bounded collection of memory tags.
 *
 * @category schemas
 * @since 0.1.0
 */
export const Tags = Schema.Array(Tag).pipe(
  Schema.check(Schema.isMaxLength(MAX_TAGS)),
  Schema.check(
    Schema.makeFilter(
      (tags) => new Set(tags).size === tags.length ? undefined : "invalid_tag: memory tags must be unique",
      { identifier: "invalid_tag" }
    )
  )
)

/**
 * A bounded collection of memory tags.
 *
 * @category models
 * @since 0.1.0
 */
export type Tags = typeof Tags.Type

/**
 * Tag comparison modes inherited from the Smithers memory contract.
 *
 * @category schemas
 * @since 0.1.0
 */
export const MatchMode = Schema.Literals(["any", "all", "any_strict", "all_strict", "exact"])

/**
 * Tag comparison mode.
 *
 * @category models
 * @since 0.1.0
 */
export type MatchMode = typeof MatchMode.Type

/**
 * Recursive tag-group query expression.
 *
 * @category models
 * @since 0.1.0
 */
export type TagGroup =
  | {
    readonly tags: Tags
    readonly match?: MatchMode | undefined
  }
  | {
    readonly and: ReadonlyArray<TagGroup>
  }
  | {
    readonly or: ReadonlyArray<TagGroup>
  }
  | {
    readonly not: TagGroup
  }

const TagGroupSchema: Schema.Codec<TagGroup> = Schema.suspend(
  (): Schema.Codec<TagGroup> =>
    Schema.Union([
      Schema.Struct({
        tags: Tags,
        match: Schema.optional(MatchMode)
      }),
      Schema.Struct({
        and: Schema.Array(TagGroupSchema)
      }),
      Schema.Struct({
        or: Schema.Array(TagGroupSchema)
      }),
      Schema.Struct({
        not: TagGroupSchema
      })
    ])
)

const isTags = Schema.is(Tags)
const isMatchMode = Schema.is(MatchMode)

/** A tag-group leaf with its match mode resolved to the default. */
type Leaf = {
  readonly tags: Tags
  readonly match: MatchMode
}

/** The operators a tag group folds its children with. */
type Operator = "and" | "or" | "not"

/**
 * Why a tag-group tree was refused: `shape` for a value that is not a tag
 * group, `budget` for one that overruns a ceiling, carrying the message the
 * schema filter reports.
 */
type Refusal =
  | { readonly kind: "shape" }
  | { readonly kind: "budget"; readonly message: string }

const shapeRefusal: Refusal = { kind: "shape" }

const depthRefusal: Refusal = {
  kind: "budget",
  message: `invalid_tag: tag-group depth exceeds ${MAX_TAG_GROUP_DEPTH}`
}

const nodesRefusal: Refusal = {
  kind: "budget",
  message: `invalid_tag: tag-group node count exceeds ${MAX_TAG_GROUP_NODES}`
}

const ignore = () => {}

/**
 * The one traversal of a tag-group tree.
 *
 * The walk is iterative, so an arbitrarily deep untrusted tree cannot grow the
 * call stack, and it charges every node against {@link MAX_TAG_GROUP_DEPTH} and
 * {@link MAX_TAG_GROUP_NODES} exactly once. The schema preflight, the budget
 * filter and {@link matches} all read their answer from this walk, so none of
 * them can drift from the others on the budget rule or the operator set.
 *
 * `onLeaf` sees each leaf in pre-order; `onOperator` sees each operator after
 * its children, which is the hook {@link matches} folds child values with.
 * Returns the first refusal, or `undefined` for a well-formed tag group within
 * budget.
 */
const walkTagGroup = (
  root: unknown,
  onLeaf: (leaf: Leaf) => void,
  onOperator: (operator: Operator, arity: number) => void
): Refusal | undefined => {
  type Frame =
    | { readonly close: false; readonly value: unknown; readonly depth: number }
    | { readonly close: true; readonly operator: Operator; readonly arity: number }
  const pending: Array<Frame> = [{ close: false, depth: 1, value: root }]
  let nodes = 0
  // Close frames wait on `pending` for their children's values and are never
  // charged, so the child-count look-ahead counts unvisited frames instead of
  // `pending.length`.
  let unvisited = 1
  while (pending.length > 0) {
    const frame = pending.pop()!
    if (frame.close) {
      onOperator(frame.operator, frame.arity)
      continue
    }
    const value = frame.value
    nodes += 1
    unvisited -= 1
    if (frame.depth > MAX_TAG_GROUP_DEPTH) return depthRefusal
    if (nodes > MAX_TAG_GROUP_NODES) return nodesRefusal
    if (typeof value !== "object" || value === null) return shapeRefusal
    if ("tags" in value) {
      const match = "match" in value ? value.match : undefined
      if (!isTags(value.tags)) return shapeRefusal
      if (match !== undefined && !isMatchMode(match)) return shapeRefusal
      onLeaf({ match: match ?? "any", tags: value.tags })
      continue
    }
    const node = "and" in value
      ? { children: value.and, operator: "and" as const }
      : "or" in value
      ? { children: value.or, operator: "or" as const }
      : "not" in value
      ? { children: [value.not], operator: "not" as const }
      : undefined
    if (node === undefined) return shapeRefusal
    const children = node.children
    if (!Array.isArray(children)) return shapeRefusal
    // `and` and `or` can overrun the ceiling in a single step, so their whole
    // child array is charged before it is pushed. `not` adds the one node that
    // the next pop charges, against the depth ceiling first.
    if (node.operator !== "not" && nodes + unvisited + children.length > MAX_TAG_GROUP_NODES) return nodesRefusal
    pending.push({ arity: children.length, close: true, operator: node.operator })
    for (let index = children.length - 1; index >= 0; index--) {
      pending.push({ close: false, depth: frame.depth + 1, value: children[index] })
    }
    unvisited += children.length
  }
  return undefined
}

// A tree over budget is accepted here and refused by the filter below, which is
// the only place that can report why.
const isTagGroupShape = (input: unknown): input is TagGroup => walkTagGroup(input, ignore, ignore)?.kind !== "shape"

const tagGroupBudgetIssue = (root: TagGroup): string | undefined => {
  const refusal = walkTagGroup(root, ignore, ignore)
  return refusal?.kind === "budget" ? refusal.message : undefined
}

const TagGroupPreflight = Schema.declare<TagGroup>(isTagGroupShape, {
  identifier: "TagGroup"
}).pipe(
  Schema.check(
    Schema.makeFilter(
      tagGroupBudgetIssue,
      { identifier: "invalid_tag" },
      true
    )
  )
)

/**
 * Recursive Schema for tag-group queries.
 *
 * @category schemas
 * @since 0.1.0
 */
export const TagGroup = TagGroupPreflight.pipe(Schema.decodeTo(TagGroupSchema))

const matchesLeaf = (leaf: Leaf, tags: ReadonlyArray<string>, actual: ReadonlySet<string>): boolean => {
  switch (leaf.match) {
    case "all":
      return tags.length === 0 || leaf.tags.every((tag) => actual.has(tag))
    case "any_strict":
      return tags.length > 0 && leaf.tags.some((tag) => actual.has(tag))
    case "all_strict":
      return tags.length > 0 && leaf.tags.every((tag) => actual.has(tag))
    case "exact":
      return actual.size === new Set(leaf.tags).size && leaf.tags.every((tag) => actual.has(tag))
    case "any":
      return tags.length === 0 || leaf.tags.some((tag) => actual.has(tag))
  }
}

/**
 * Evaluates a tag-group against a record's tags.
 *
 * Non-strict `any` and `all` preserve Smithers' wildcard behavior for
 * untagged records. Strict modes require the record to carry at least one tag.
 * Evaluation rides {@link walkTagGroup}, so it shares one budget rule with the
 * schema and returns `false` for an undecoded expression that is malformed or
 * exceeds {@link MAX_TAG_GROUP_DEPTH} or {@link MAX_TAG_GROUP_NODES}, keeping
 * the boolean signature used by store consumers without exposing a defect.
 *
 * @category predicates
 * @since 0.1.0
 */
export const matches = (tagGroup: TagGroup, tags: ReadonlyArray<string>): boolean => {
  const actual = new Set(tags)
  const values: Array<boolean> = []
  const refusal = walkTagGroup(
    tagGroup,
    (leaf) => {
      values.push(matchesLeaf(leaf, tags, actual))
    },
    (operator, arity) => {
      const children = values.splice(values.length - arity, arity)
      values.push(
        operator === "and"
          ? children.every(Boolean)
          : operator === "or"
          ? children.some(Boolean)
          : !children[0]
      )
    }
  )
  return refusal === undefined && values.length === 1 ? values[0]! : false
}
