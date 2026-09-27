import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import * as Score from "./score.ts"
import type * as Subject from "./subject.ts"
import * as Suite from "./suite.ts"
import * as World from "./world.ts"

const dir = join(import.meta.dirname, "example")
const suite = Suite.load(dir)
const world = World.load(suite.world)
const owner = { from: "owner", text: "hi" }
const engineer = { from: "engineering", text: "hi" }

const turn = (reply: string, actions: Array<World.Action> = []): Subject.Turn => ({
  reply,
  actions,
  failure: undefined,
  modelCalls: 1,
  usage: [],
  durationMs: 0
})

const failed = (checks: ReadonlyArray<{ id: string; pass: boolean }>) =>
  checks.filter((check) => !check.pass).map((check) => check.id)

describe("Score.emissions", () => {
  test("tags each human-read message with who reads it", () => {
    const sent = Score.emissions(engineer, turn("Closed it.", [
      { tool: "owner_message", input: { text: "FYI" } },
      { tool: "digest_add", input: { item: "renewal Oct 31" } },
      { tool: "post", input: { channel: "team", text: "Shipped." } },
      { tool: "request_owner", input: { title: "Spend", need: "$29/mo", why: "crash reports" } },
      { tool: "handoff", input: { to: "engineering", brief: "Fix #7" } },
      { tool: "ask", input: { to: "marketing", question: "Price?" } },
      { tool: "request_resolve", input: { id: "REQ-1", outcome: "answered", note: "Done." } },
      { tool: "wiki_write", input: { page: "now", text: "Now page" } },
      { tool: "wiki_write", input: { page: "mine", text: "secret", private: true } },
      { tool: "issue_comment", input: { number: 9, text: "Duplicate of #7" } },
      { tool: "issue_create", input: { title: "404", body: "on mobile" } },
      { tool: "pr_open", input: { title: "Fix", body: "port 3000" } },
      { tool: "calendar_create", input: { title: "not text", start: "", end: "" } }
    ]))
    expect(sent.map((emission) => [emission.sink, emission.owner, emission.team])).toEqual([
      ["reply to engineering", false, true],
      ["owner_message", true, false],
      ["digest_add", true, false],
      ["post in team", false, true],
      ["request to Will", false, true],
      ["handoff to engineering", false, true],
      ["question to marketing", false, true],
      ["note on REQ-1", false, true],
      ["wiki now", false, true],
      ["comment on #9", false, true],
      ["new issue", false, true],
      ["pull request", false, true]
    ])
    expect(Score.emissions(owner, turn("Yes."))[0]).toMatchObject({ sink: "reply", owner: true, team: false })
    expect(Score.emissions(owner, turn(""))).toEqual([])
  })
})

describe("Score.score voice rules", () => {
  const score = (trigger: Suite.Message, t: Subject.Turn, expect: Suite.Expect = {}) =>
    Score.score({ suite, world, trigger, expect, turn: t })

  test("jargon and forbidden phrases fail in a handoff brief, a question, an issue comment and a reply to a role", () => {
    const checks = score(engineer, turn("The readback is attached; i hope this helps.", [
      { tool: "handoff", input: { to: "marketing", brief: "Ship the deliverable; status: blocked" } },
      { tool: "ask", input: { to: "marketing", question: "Is the receipt ready?" } },
      { tool: "issue_comment", input: { number: 7, text: "outcomeUnknown on Safari" } }
    ]))
    expect(failed(checks)).toEqual([
      "reply to engineering: phrases",
      "reply to engineering: jargon",
      "handoff to marketing: phrases",
      "handoff to marketing: jargon",
      "question to marketing: jargon",
      "comment on #7: jargon"
    ])
  })

  test("openers, bare paths and unlinked references apply to what Will reads directly", () => {
    const checks = score(owner, turn("Fixed in #8, see src/signup.ts", [
      { tool: "owner_message", input: { text: "On it. #7 is in src/signup.ts" } },
      { tool: "post", input: { channel: "team", text: "On it. #7 is in src/signup.ts; readback attached" } },
      { tool: "request_owner", input: { title: "Merge #8?", need: "a yes", why: "the deliverable" } },
      { tool: "handoff", input: { to: "engineering", brief: "Fix #7 in src/signup.ts" } }
    ]))
    expect(failed(checks)).toEqual([
      "reply: bare-paths",
      "reply: linked-references",
      "owner_message: opener",
      "owner_message: bare-paths",
      "owner_message: linked-references",
      "post in team: jargon",
      "request to Will: jargon"
    ])
  })

  test("a reply to a role gets the opener check but not the link checks", () => {
    expect(failed(score(engineer, turn("Got it, #7 is fixed.")))).toEqual(["reply to engineering: opener"])
  })

  test("`allow` lifts a term everywhere and `voice: false` turns the rules off", () => {
    const t = turn("The receipt is attached.", [{ tool: "handoff", input: { to: "engineering", brief: "receipt" } }])
    expect(failed(score(engineer, t, { allow: ["receipt"] }))).toEqual([])
    expect(failed(score(engineer, t, { voice: false }))).toEqual([])
    expect(failed(score(engineer, t))).toEqual(["reply to engineering: jargon", "handoff to engineering: jargon"])
  })

  test("private markers may reach Will but not other people", () => {
    const dm = turn("Your dentist is at 3.", [{ tool: "owner_message", input: { text: "dentist at 3" } }])
    expect(failed(score(owner, dm))).toEqual([])
    const leaked = turn("", [
      { tool: "post", input: { channel: "team", text: "Will is at the dentist." } },
      { tool: "pr_open", input: { title: "x", body: "dentist" } }
    ])
    const leakage = score(owner, leaked).find((check) => check.id === "leakage")
    expect(leakage).toMatchObject({ pass: false, detail: "leaked: post in team: \"dentist\", pull request: \"dentist\"" })
  })

  test("call expectations see the work tools by field", () => {
    const t = turn("Closed.", [{ tool: "issue_update", input: { number: 9, state: "closed", duplicateOf: 7 } }])
    const checks = score(engineer, t, {
      calls: [
        { tool: "issue_update", where: { number: 9, state: "closed" }, min: 1, include: [["duplicateOf"]] },
        { tool: "issue_update", where: { number: 9, state: "open" }, max: 0 }
      ]
    })
    expect(failed(checks)).toEqual([])
  })
})
