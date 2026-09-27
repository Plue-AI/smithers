import { describe, expect, test } from "bun:test"
import * as Rubric from "./rubric.ts"
import type * as Subject from "./subject.ts"
import type * as Suite from "./suite.ts"

const turn = (reply: string, actions: Array<{ tool: string; input: Record<string, unknown> }> = []): Subject.Turn => ({
  reply,
  actions,
  failure: undefined,
  modelCalls: 1,
  usage: [],
  durationMs: 0
})

const caseWith = (...turns: Array<Suite.Expect>): Pick<Suite.Case, "turns"> => ({
  turns: turns.map((expect) => ({ trigger: { from: "owner", text: "hi" }, expect }))
})

describe("rubric", () => {
  test("is role-neutral: the ideal comes from the focus note, not a job title", () => {
    const text = JSON.stringify(Rubric.criteria) + Rubric.instructions
    expect(text).not.toMatch(/chief of staff|assistant|their boss/iu)
    expect(Rubric.criteria.find((criterion) => criterion.id === "judgment")!.high).toContain("this role")
    expect(Rubric.instructions).toContain("not from any job title")
    expect(Rubric.instructions).toContain("every message to a teammate or customer")
  })

  test("judgedOutput shows every human-read message in full, the reply first", () => {
    const brief = "Fix the duplicate issues from multi-reference PRs (#212). ".repeat(12)
    const out = Rubric.judgedOutput({ from: "quality", text: "hi" }, turn("Taking it.", [
      { tool: "handoff", input: { to: "engineering", brief } },
      { tool: "request_owner", input: { title: "Spend", need: "$29/mo for Faultline", why: "crash reports" } },
      { tool: "post", input: { channel: "eng", text: "PR #91 is ready for review." } },
      { tool: "wiki_write", input: { page: "now", text: "Now: #91 in review" } },
      { tool: "issue_comment", input: { number: 233, text: "Duplicate of #212." } },
      { tool: "request_resolve", input: { id: "REQ-7", outcome: "answered", note: "Closed as answered." } },
      { tool: "calendar_freebusy", input: { from: "a", to: "b" } }
    ]))
    expect(out.startsWith("Reply posted where the event arrived (to quality):\nTaking it.")).toBe(true)
    expect(out).toContain(`Handoff to engineering:\n${brief.trim()}`)
    expect(out).toContain("Request to Will:\nSpend $29/mo for Faultline crash reports")
    expect(out).toContain("Post in eng:\nPR #91 is ready for review.")
    expect(out).toContain("Wiki page now:\nNow: #91 in review")
    expect(out).toContain("Comment on #233:\nDuplicate of #212.")
    expect(out).toContain("Note to the requester of REQ-7:\nClosed as answered.")
    expect(out).not.toContain("calendar")
    expect(Rubric.judgedOutput({ from: "owner", text: "hi" }, turn(""))).toBe(
      "Reply posted where the event arrived (to Will):\n(no reply)"
    )
  })

  test("judgeKey changes with a turn's focus note or judge flag and with the rubric version", () => {
    const base = Rubric.judgeKey(caseWith({ focus: "Say no." }, { focus: "Then link #8." }))
    expect(Rubric.judgeKey(caseWith({ focus: "Say no." }, { focus: "Then link #8." }))).toBe(base)
    expect(Rubric.judgeKey(caseWith({ focus: "Say no, plainly." }, { focus: "Then link #8." }))).not.toBe(base)
    expect(Rubric.judgeKey(caseWith({ focus: "Say no." }, { focus: "Then link #8.", judge: false }))).not.toBe(base)
    expect(Rubric.judgeKey(caseWith({ focus: "Say no.", reply: { words: { max: 5 } } }, { focus: "Then link #8." }))).toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/u)
    expect(Rubric.version).not.toBe("1")
  })

  test("needsJudge: no verdict, failed checks, changed notes, or a run saved without a key", () => {
    const key = Rubric.judgeKey(caseWith({ focus: "Say no." }))
    const old = Rubric.judgeKey(caseWith({ focus: "Say yes." }))
    expect(Rubric.needsJudge({ checksPass: true, judge: "turn 1: pass", judgeKey: key }, key)).toBe(false)
    expect(Rubric.needsJudge({ checksPass: true, judge: "turn 1: pass", judgeKey: old }, key)).toBe(true)
    expect(Rubric.needsJudge({ checksPass: true, judge: "turn 1: pass" }, key)).toBe(true)
    expect(Rubric.needsJudge({ checksPass: true, judgeKey: key }, key)).toBe(true)
    expect(Rubric.needsJudge({ checksPass: false, judge: undefined, judgeKey: key }, key)).toBe(true)
  })
})
