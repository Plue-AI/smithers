import { describe, expect, test } from "bun:test"
import { ALICE, BEN, MAYA, RETRY_FILE, createDesignWorld } from "./index"
import {
  commentIssue, designDefinition, designDiffCard, designDiffs, designFileCard, designHover, ensureReview, findBranch, findFile, findWikiPage, isDesignCard, issueNumberOf,
  newIssue, newWikiPage, subjectOf
} from "./subjects"

const make = () => createDesignWorld({ timers: { set: () => 0, clear: () => {} }, viewer: MAYA })
const RETRY_ID = `b-retry:${RETRY_FILE}`

describe("design card ids", () => {
  test("subjectOf splits at the kind only, so a file id keeps its branch and path", () => {
    expect(subjectOf({ id: `design:file:${RETRY_ID}` })).toEqual({ kind: "file", subject: RETRY_ID })
    expect(subjectOf({ id: "design:issues" })).toEqual({ kind: "issues", subject: "" })
    expect(subjectOf({ id: "todo:12" })).toBeUndefined()
    expect(isDesignCard({ id: "design:pr:88" })).toBe(true)
  })
  test("issueNumberOf reads #n, n and numbers; refuses the rest", () => {
    expect([issueNumberOf("#231"), issueNumberOf(" 212 "), issueNumberOf(5), issueNumberOf("T9"), issueNumberOf(undefined)]).toEqual([231, 212, 5, undefined, undefined])
  })
})

describe("seed code intelligence for the File card's gestures", () => {
  test("definition reveals the declaration in the same file; hover shows its line; a parameter hovers as itself", () => {
    const file = make().row("files", RETRY_ID)!
    expect(file.lines.find(each => each.n === 15)?.text).toBe("  return deliver(event)")
    expect(designDefinition(file, 15, 9)).toEqual({ line: 4, col: 22 })
    expect(designHover(file, 15, 9)).toEqual({ line: 15, col: 9, markdown: "`export async function deliver(event: WebhookEvent)`" })
    expect(designDefinition(file, 14, 8)).toEqual({ line: 2, col: 15 })
    expect(designHover(file, 14, 8)?.markdown).toBe("`import { post, sleep } from \"../lib/http\"`")
    expect(designDefinition(file, 15, 17)).toBeUndefined()
    expect(designHover(file, 15, 17)).toEqual({ line: 15, col: 17, markdown: "`event`" })
    expect(designDefinition(file, 15, 0)).toBeUndefined()
    expect(designHover(file, 15, 0)).toBeUndefined()
    expect(designHover(file, 99, 0)).toBeUndefined()
  })
})

describe("lookups", () => {
  test("findFile takes a path, a basename or branch:path, preferring the asked branch, then the viewer's", () => {
    const world = make().world()
    expect(findFile(world, "retry.ts")?.id).toBe(RETRY_ID)
    expect(findFile(world, "reset.ts", "main")?.branch).toBe("main")
    expect(findFile(world, `main:src/mail/reset.ts`)?.branch).toBe("main")
    expect(findFile(world, "retry.ts", undefined, ALICE)?.branch).toBe("b-retry")
    expect(findFile(world, "nope.ts")).toBeUndefined()
  })
  test("findBranch answers an id, a name or the TODO ref it works", () => {
    const world = make().world()
    expect([findBranch(world, "b-retry")?.id, findBranch(world, "retry-webhooks")?.id, findBranch(world, "T9")?.id, findBranch(world, "t9")?.id]).toEqual(["b-retry", "b-retry", "b-retry", "b-retry"])
    expect(findBranch(world, "nope")).toBeUndefined()
  })
  test("findWikiPage matches id, title, then a title fragment", () => {
    const world = make().world()
    expect(findWikiPage(world, "webhook-retries")?.id).toBe("webhook-retries")
    expect(findWikiPage(world, "Payments Testing")?.id).toBe("payments-testing")
    expect(findWikiPage(world, "payments")?.id).toBe("payments-testing")
  })
})

describe("the File and Diff projections", () => {
  test("a seeded file reads read-only with its text, branch name and nobody editing", () => {
    const design = make()
    const model = designFileCard(design.world(), design.row("files", RETRY_ID)!, 10)
    expect(model).toMatchObject({ path: RETRY_FILE, branch: "retry-webhooks", mode: "read_only", reveal: { line: 10 }, saved: "saved", editors: [], authors: [] })
    expect(model.content).toEqual({ kind: "text", text: design.row("files", RETRY_ID)!.lines.map(each => each.text).join("\n") })
    expect(model.github_url).toBe("https://github.com/acme/api/blob/retry-webhooks/src/webhooks/retry.ts")
  })
  test("an edit shows its author on the line and the diff as one hunk with context", () => {
    const design = make()
    expect(designDiffs(design.world(), "b-retry")).toEqual([])
    const before = design.row("files", RETRY_ID)!.lines[4]!.text
    expect(design.editFile(RETRY_ID, 5, "    const response = await post(event.url, event.body);", BEN).ok).toBe(true)
    const world = design.world()
    const model = designFileCard(world, design.row("files", RETRY_ID)!)
    expect(model.editors).toEqual([{ actor: expect.objectContaining({ kind: "person", login: "benortiz" }), line: 5 }])
    expect(model.authors.map(each => each.kind === "person" ? each.login : each.kind)).toEqual(["benortiz"])
    expect(model.saved).toBe("saving")
    const diff = designDiffCard(world, design.row("files", RETRY_ID)!)
    expect(diff.against).toEqual({ kind: "item_base", rev: "main" })
    expect(diff.hunks).toHaveLength(1)
    expect(diff.hunks[0]).toMatchObject({ old_start: 3, new_start: 3 })
    expect(diff.hunks[0]!.lines.map(each => each.op).join("")).toBe("  -+  ")
    expect(diff.hunks[0]!.lines[2]).toEqual({ op: "-", text: before })
    expect(designDiffs(world, "b-retry")).toHaveLength(1)
  })
  test("T8's diff is the seeded Stripe evidence, by TODO id or branch", () => {
    const world = make().world()
    expect(designDiffs(world, "t-stripe").map(each => each.path)).toEqual(["package.json", "src/webhooks/verify.ts"])
    expect(designDiffs(world, "b-stripe")).toHaveLength(2)
  })
})

describe("the subject writes", () => {
  test("ensureReview seeds T9's three findings once and reads another branch clean", () => {
    const design = make()
    const review = ensureReview(design)
    expect(review.findings.map(each => [each.severity, each.line])).toEqual([["blocker", 14], ["fix", 8], ["note", 10]])
    expect(ensureReview(design).id).toBe(review.id)
    expect(design.rows("reviews")).toHaveLength(1)
    expect(ensureReview(design, "b-stripe")).toMatchObject({ id: "review-b-stripe", verdict: "clean", findings: [] })
    expect(design.actOnFinding(review.id, 0, "fix", MAYA)).toMatchObject({ ok: true, ack: "Steered T9" })
    expect(design.row("reviews", review.id)?.findings[0]?.acted).toBe("fix")
  })
  test("newIssue takes the next number; commentIssue appends; newWikiPage slugs the name", () => {
    const design = make()
    expect(newIssue(design, "A title", "A body", MAYA)).toBe(236)
    expect(design.row("issues", 236)).toMatchObject({ title: "A title", body: "A body", author: MAYA, open: true, comments: [] })
    expect(commentIssue(design, 236, "First", BEN)).toBe(true)
    expect(commentIssue(design, 999, "Lost", BEN)).toBe(false)
    expect(design.row("issues", 236)?.comments).toEqual([{ who: BEN, text: "First", age: "now" }])
    expect(newWikiPage(design, " Checkout test race! ", BEN)).toBe("checkout-test-race")
    expect(design.row("wiki", "checkout-test-race")).toMatchObject({ title: "Checkout test race!", rev: 1, authors: [BEN], lines: [{ n: 1, text: "" }] })
  })
})
