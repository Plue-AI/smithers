/**
 * Behavioral projection contract checks for BranchTreeNode.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { type BranchTreeNodeCard, BranchTreeNodeCardSchema } from "../../src/BranchTreeNodeCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures } from "../fixtures/BranchTreeNode.ts"

cardContract("BranchTreeNode", BranchTreeNodeCardSchema, fixtures)

// Literal oracle from ui-components.md T-UI-07 and spec §14.1.
const NODE_KINDS = ["main", "item", "scratch", "earlier"] as const
const main = fixtures.main.model

describe("branch tree", () => {
  test.each(NODE_KINDS)("accepts kind %s", (kind) => {
    expect(BranchTreeNodeCardSchema.parse({ ...fixtures.scratch.model, kind }).kind).toBe(kind)
  })
  test.each(["closed", "branch", "Main", ""])("rejects kind %j", (kind) => {
    expect(BranchTreeNodeCardSchema.safeParse({ ...fixtures.scratch.model, kind }).success).toBe(false)
  })
  test("nests children recursively and validates them", () => {
    const parsed = BranchTreeNodeCardSchema.parse(main)
    expect(parsed.children[0]!.children[0]!.name).toBe("scratch/repro")
    const bad = { ...main, children: [{ ...main.children[0]!, children: [{ ...fixtures.scratch.model, kind: "x" }] }] }
    expect(BranchTreeNodeCardSchema.safeParse(bad).success).toBe(false)
  })
  test("an item node keeps its TODO state and its people and agents present", () => {
    const item = BranchTreeNodeCardSchema.parse(main).children[0]!
    expect(item.state).toBe("working")
    expect(item.present.map((actor) => actor.kind)).toEqual(["person", "agent"])
  })
  test("stories cover every kind", () => {
    const kinds = new Set<string>()
    const visit = (node: BranchTreeNodeCard): void => {
      kinds.add(node.kind)
      node.children.forEach(visit)
    }
    Object.values(fixtures).forEach((story) => visit(story.model))
    expect([...kinds].sort()).toEqual([...NODE_KINDS].sort())
  })
})
