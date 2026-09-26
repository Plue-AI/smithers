import { describe, expect, it } from "bun:test"
import * as Complete from "../src/complete.ts"
import * as Fuzzy from "../src/fuzzy.ts"
import * as Transcript from "../src/transcript.ts"

const sources: Complete.Sources = {
  models: [
    { seat: "openai:gpt-6-sol", label: "GPT-6 Sol", provider: "Codex subscription" },
    { seat: "openai:gpt-6-astra", label: "GPT-6 Astra", provider: "Codex subscription" },
    { seat: "anthropic:claude-opus-5-5", label: "Claude Opus 5.5", provider: "Anthropic" }
  ],
  files: () => ["README.md", "src/app.tsx", "src/view.tsx", "test/app.test.ts", "docs/my notes.md"]
}

const labels = (completion: Complete.Completion | undefined) => completion?.items.map((item) => item.label)

describe("fuzzy", () => {
  it("matches letters in order and ranks runs and word starts first", () => {
    expect(Fuzzy.score("xyz", "model")).toBeUndefined()
    expect(Fuzzy.filter(["session", "resume", "new"], "se", (each) => each)).toEqual(["session", "resume"])
    expect(Fuzzy.filter(["GPT-6 Astra", "GPT-6 Sol"], "sol", (each) => each)).toEqual(["GPT-6 Sol"])
  })

  it("requires every space-separated token", () => {
    expect(Fuzzy.filter(["claude opus", "claude fable", "gpt opus"], "cl op", (each) => each)).toEqual(["claude opus"])
  })
})

describe("slash completion", () => {
  it("opens on / at the start and fuzzy-matches command names", () => {
    expect(labels(Complete.complete("/", 1, sources))?.[0]).toBe("/model")
    expect(labels(Complete.complete("/rsm", 4, sources))).toEqual(["/resume"])
    const fork = Complete.complete("/fo", 3, sources)!.items[0]!
    expect(fork).toMatchObject({
      label: "/fork",
      insert: "/fork",
      submit: true,
      detail: "Fork from an earlier message"
    })
    expect(Complete.complete("say /model", 10, sources)).toBeUndefined()
  })

  it("lists the directory's flows after the built-in commands", () => {
    const withFlows = { ...sources, flows: () => [{ name: "review", description: "Review a change" }] }
    expect(labels(Complete.complete("/re", 3, withFlows))?.at(-1)).toBe("/flow review")
    expect(Complete.complete("/rev", 4, withFlows)!.items[0]).toMatchObject({
      label: "/flow review",
      hint: "flow",
      detail: "Review a change",
      insert: "/flow review",
      submit: true
    })
    expect(labels(Complete.complete("/flow re", 8, withFlows))).toEqual(["/flow review"])
    expect(labels(Complete.complete("/rev", 4, sources))).toEqual([])
  })

  it("runs a bare command on Enter and inserts one that takes an argument", () => {
    const resume = Complete.complete("/res", 4, sources)!.items[0]!
    expect(resume).toMatchObject({ insert: "/resume", submit: true })
    const named = Complete.complete("/nam", 4, sources)!.items[0]!
    expect(named).toMatchObject({ insert: "/name ", submit: false })
    const thinking = Complete.complete("/thin", 5, sources)!.items[0]!
    expect(thinking).toMatchObject({ insert: "/thinking ", submit: false })
  })

  it("completes /model and /thinking arguments", () => {
    const models = Complete.complete("/model opus", 11, sources)!
    expect(models.kind).toBe("argument")
    expect(models.items.map((item) => item.insert)).toEqual(["/model anthropic:claude-opus-5-5"])
    expect(labels(Complete.complete("/thinking hi", 12, sources))).toEqual(["high", "xhigh"])
    expect(Complete.complete("/name  foo", 10, sources)).toBeUndefined()
  })

  it("replaces the whole typed command, even with the cursor mid-word", () => {
    const completion = Complete.complete("/mo", 2, sources)!
    expect(Complete.apply("/mo", completion, completion.items[0]!)).toEqual({ text: "/model", cursor: 6 })
  })
})

describe("file completion", () => {
  it("opens on @ after whitespace and ranks by file name", () => {
    const completion = Complete.complete("look at @view", 13, sources)!
    expect(completion.kind).toBe("file")
    expect(labels(completion)?.[0]).toBe("src/view.tsx")
    expect(Complete.complete("mail me@home", 12, sources)).toBeUndefined()
  })

  it("offers shallow files first when nothing is typed", () => {
    expect(labels(Complete.complete("@", 1, sources))?.[0]).toBe("README.md")
  })

  it("inserts the path with a trailing space, quoting one that has spaces", () => {
    const text = "see @app and more"
    const completion = Complete.complete(text, 8, sources)!
    expect(Complete.apply(text, completion, completion.items[0]!)).toEqual({
      text: "see @src/app.tsx and more",
      cursor: 17
    })
    const quoted = Complete.complete("@notes", 6, sources)!.items[0]!
    expect(quoted.insert).toBe("@\"docs/my notes.md\" ")
  })
  it("encodes a path a bare or naively quoted mention would misname, keeping Unicode readable", () => {
    expect(Complete.mention("docs/café 日本.md")).toBe("@\"docs/café 日本.md\" ")
    expect(Complete.mention("café.txt")).toBe("@café.txt ")
    expect(Complete.mention("say \"hi\".txt")).toBe("@\"say \\\"hi\\\".txt\" ")
    expect(Complete.mention("back\\slash")).toBe("@\"back\\\\slash\" ")
    expect(Complete.mention("new\nline\tbell\u0007")).toBe("@\"new\\nline\\tbell\\u0007\" ")
    expect(Complete.mention("para\u2028sep\u00a0nb")).toBe("@\"para\\u2028sep\\u00a0nb\" ")
    expect(Complete.mention("line.ts:12")).toBe("@\"line.ts:12\" ")
    expect(Complete.mention("line.ts:12", 4)).toBe("@\"line.ts:12\":4 ")
    expect(Complete.display("new\nline\u0007 café")).toBe("new\\nline\\u0007 café")
  })
})

describe("edit diffs", () => {
  it("reads the change an edit or write call makes", () => {
    expect(Transcript.change("edit", { path: "a.js", oldString: "x", newString: "y" })).toEqual({
      path: "a.js",
      removed: "x",
      added: "y"
    })
    expect(Transcript.change("write", { path: "b.js", content: "z\n" })).toEqual({
      path: "b.js",
      removed: "",
      added: "z\n",
      line: 1
    })
    expect(Transcript.change("read", { path: "a.js" })).toBeUndefined()
  })

  it("draws a change as a unified hunk at its start line", () => {
    expect(Transcript.unified({ path: "a.js", removed: "a\nb", added: "c", line: 7 })).toBe(
      "--- a/a.js\n+++ b/a.js\n@@ -7,2 +7,1 @@\n-a\n-b\n+c"
    )
    expect(Transcript.unified({ path: "n.js", removed: "", added: "x\n", line: 1 })).toBe(
      "--- a/n.js\n+++ b/n.js\n@@ -0,0 +1,1 @@\n+x"
    )
  })

  it("takes the start line an edit reports when it settles", () => {
    const at = 0
    let transcript = Transcript.apply(Transcript.empty, { _tag: "model-requested" } as never, at)
    transcript = Transcript.apply(
      transcript,
      { _tag: "model-delta", delta: { type: "text-delta", text: "```js\nx\n```" } } as never,
      at
    )
    transcript = Transcript.apply(transcript, {
      _tag: "cell-call-started",
      call: {
        flowName: "edit",
        input: { path: "a.js", oldString: "x", newString: "y" },
        presentation: { verb: { pending: "editing", success: "edited", failure: "failed to edit" } }
      }
    } as never, at)
    transcript = Transcript.apply(transcript, {
      _tag: "cell-call-settled",
      flowName: "edit",
      result: { outcome: "success", value: { startLine: 12 } }
    } as never, at)
    const cell = transcript.items.find((item) => item.kind === "cell")
    expect(cell?.kind === "cell" ? cell.calls[0] : undefined).toMatchObject({
      status: "ok",
      verb: { success: "edited" },
      change: { path: "a.js", line: 12 }
    })
  })
})

it("replaces only the argument token and preserves the draft after the cursor", () => {
  const draft = "/model gpt trailing draft"
  const completion = Complete.complete(draft, "/model gp".length, sources)!
  expect(completion).toBeDefined()
  const item = completion.items.find((item) => item.insert.includes("gpt-6-sol"))!
  expect(draft.slice(0, completion.start) + item.insert + draft.slice(completion.end))
    .toBe("/model openai:gpt-6-sol trailing draft")
})
