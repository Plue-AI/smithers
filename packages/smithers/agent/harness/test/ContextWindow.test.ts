import * as Digest from "@smthrs/core/Digest"
import * as CanonicalJson from "@smthrs/model/CanonicalJson"
import * as Request from "@smthrs/model/ModelRequest"
import * as Result from "effect/Result"
import { describe, expect, expectTypeOf, it } from "vitest"
import * as ContextWindow from "../src/ContextWindow.ts"
import * as Tokens from "../src/Tokens.ts"

const system = Request.SystemPart.make({ text: "Be concise." })
const tool = Request.ToolDefinition.make({ name: "read", description: "Read", parameters: {} })
const lazyTool = Request.ToolDefinition.make({
  name: "write",
  description: "Write",
  parameters: {},
  deferred: true
})

/** The window with a lazily loaded tool declared but not yet activated. */
const lazy = () =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [system] },
      { kind: "tools", zone: "prefix", content: [tool, lazyTool] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("load a tool")] }
    ],
    activeTools: []
  })

/** The same window with the lazily loaded tool active. */
const lazyActivated = () =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [system] },
      { kind: "tools", zone: "prefix", content: [tool, lazyTool] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("load a tool")] }
    ],
    activeTools: ["write"]
  })

/** The identity a provider caches: the digests of the prefix-zone segments. */
const sealedPrefix = (value: ContextWindow.ContextWindow) =>
  value.segments.filter((segment) => segment.zone === "prefix").map((segment) => segment.digest)

const base = () =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [system] },
      { kind: "instructions", zone: "prefix", content: [Request.SystemPart.make({ text: "Follow instructions" })] },
      { kind: "tools", zone: "prefix", content: [tool] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("first")] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("second")] }
    ],
    activeTools: ["read"]
  })

/** A window whose only compactable content is one transcript segment. */
const single = () =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [system] },
      { kind: "transcript", zone: "tail", content: [Request.Message.user("only")] }
    ]
  })

/** A window with nothing compaction is allowed to replace. */
const sealedOnly = () =>
  ContextWindow.make({
    modelId: "test-model",
    segments: [
      { kind: "system", zone: "prefix", content: [system] },
      { kind: "tools", zone: "prefix", content: [tool] }
    ],
    activeTools: ["read"]
  })

const texts = (request: Request.ModelRequest) =>
  request.messages.map((message) => message.content.find((part) => "text" in part)?.text)

describe("ContextWindow", () => {
  it("does not count a reasoning signature the provider does not bill", () => {
    // Terminal-Bench 4.0 mp-checkpoint-consolidation (2026-09-24): on the
    // ChatGPT route every turn's encrypted reasoning rides in a thinking
    // part's signature and is replayed verbatim. Counting those bytes put the
    // estimate past the compaction threshold while the provider billed 31k to
    // 41k input tokens, so the run compacted three times at a tenth of its
    // window and re-read what compaction dropped.
    const window = ContextWindow.make({
      modelId: "gpt-6-sol",
      segments: [{
        kind: "transcript",
        zone: "tail",
        content: [
          Request.Message.assistant([
            Request.ThinkingPart.make({ text: "checked the layout", signature: "x".repeat(400_000) }),
            Request.TextPart.make({ text: "a".repeat(1_000) })
          ])
        ]
      }]
    })
    expect(window.tokens.total.value).toBeLessThan(2_000)
  })

  it("has a deterministic digest and never mutates its input", () => {
    const first = base()
    const second = base()
    const next = ContextWindow.appendTurn(first, Request.Message.assistant("working"))
    expect(first.digest).toBe(second.digest)
    expect(next.digest).not.toBe(first.digest)
    expect(first.segments).toHaveLength(5)
  })

  it("copies caller-owned arrays so later input mutation cannot invalidate its digest", () => {
    const content = [Request.Message.user("first")]
    const segments: Array<ContextWindow.SegmentInput> = [{ kind: "transcript", zone: "tail", content }]
    const activeTools = ["read"]
    const value = ContextWindow.make({ modelId: "test-model", segments, activeTools })
    const before = ContextWindow.render(value)
    const digest = value.digest

    content.push(Request.Message.user("injected"))
    segments.push({ kind: "transcript", zone: "tail", content: [Request.Message.user("also injected")] })
    activeTools.push("write")

    expect(ContextWindow.render(value)).toEqual(before)
    expect(value.digest).toBe(digest)
    expect(value.activeTools).toEqual(["read"])
  })

  it("freezes every array exposed by a context window", () => {
    const value = base()

    expect(() => (value.segments as Array<ContextWindow.Segment>).push(value.segments[0]!)).toThrow(TypeError)
    expect(() => (value.activeTools as Array<string>).push("write")).toThrow(TypeError)
    expect(() => (value.segments[0]!.content as Array<typeof system>).push(system)).toThrow(TypeError)
  })

  it("freezes the segments, messages and parts behind those arrays", () => {
    // The digest is taken once, at construction, and it is what the sealed step
    // is keyed on. Freezing only the outer arrays left every value inside them
    // editable in place, so a window could render content its own identity no
    // longer described.
    const message = Request.Message.user("first")
    const declaration = Request.ToolDefinition.make({
      name: "read",
      description: "Read",
      // A JSON `null` inside the declaration, because the walk has to reach
      // one: it is the value a naive `typeof value === "object"` test freezes
      // by calling `Object.values` on it.
      parameters: { type: "object", properties: null }
    })
    const value = ContextWindow.make({
      modelId: "test-model",
      segments: [
        { kind: "tools", zone: "prefix", content: [declaration] },
        { kind: "transcript", zone: "tail", content: [message] }
      ]
    })
    const rendered = ContextWindow.render(value)
    const digest = value.digest
    const segment = value.segments[1]!
    const projected = segment.content[0] as Request.UserMessage

    expect(() => ((segment as { digest: string }).digest = "forged")).toThrow(TypeError)
    expect(() => ((projected as { role: string }).role = "assistant")).toThrow(TypeError)
    expect(() => ((projected.content as Array<never>).length = 0)).toThrow(TypeError)
    expect(() => ((projected.content[0] as { text: string }).text = "rewritten")).toThrow(TypeError)
    expect(() => {
      ;(value.segments[0]!.content[0] as { name: string }).name = "write"
    }).toThrow(TypeError)

    // The value handed in is the value frozen: a caller holding its own
    // reference to a message cannot edit the copy the window rendered.
    expect(Object.isFrozen(message)).toBe(true)
    expect(ContextWindow.render(value)).toEqual(rendered)
    expect(value.digest).toBe(digest)
  })

  it("freezes what a caller froze only shallowly", () => {
    // A caller's frozen array says nothing about the message and part below it.
    // Treating that outer marker as a completed walk left both mutable, so the
    // rendered request could move while its construction-time digest stood still.
    const message = Request.Message.user("before")
    const content = Object.freeze([message])
    const segment = new ContextWindow.Segment({
      kind: "transcript",
      zone: "tail",
      digest: "caller-derived",
      tokens: Tokens.count("before"),
      content
    })
    const value = ContextWindow.make({
      modelId: "test-model",
      segments: [segment]
    })
    const rendered = ContextWindow.render(value)
    const digest = value.digest
    const projected = value.segments[0]!.content[0] as Request.UserMessage

    expect(() => ((projected.content[0] as { text: string }).text = "after")).toThrow(TypeError)
    expect(ContextWindow.render(value)).toEqual(rendered)
    expect(value.digest).toBe(digest)
  })

  it("never executes an accessor while freezing", () => {
    // `Object.values` invoked enumerable accessors while looking for children.
    // Freezing is structural work, so a getter could otherwise make an ordinary
    // window construction run caller code and throw for reasons outside it.
    let reads = 0
    const trapped = {}
    Object.defineProperty(trapped, "trap", {
      enumerable: true,
      get() {
        reads += 1
        throw new Error("read")
      }
    })
    const message = Request.Message.user("safe")
    Object.defineProperty(message.content, "trapped", { enumerable: true, value: trapped })

    const value = ContextWindow.make({
      modelId: "test-model",
      segments: [{ kind: "transcript", zone: "tail", content: [message] }]
    })

    expect(value.segments).toHaveLength(1)
    expect(reads).toBe(0)
  })

  it("uses the canonical keys SHA-256 digest for window identity", () => {
    const value = base()
    expect(value.digest).toBe(
      Digest.digest(CanonicalJson.stringify({
        modelId: value.modelId,
        segments: value.segments.map((segment) => segment.digest),
        activeTools: value.activeTools
      }))
    )
  })

  it("normalizes the declared active tool set", () => {
    // One entry per distinct tool, blanks dropped, first spelling kept: the
    // window's digest covers this array, so two windows that declare the same
    // set in different words must not disagree about their identity.
    const value = ContextWindow.make({ modelId: "test-model", activeTools: ["read", "READ", "", "  ", " write "] })
    expect(value.activeTools).toEqual(["read", " write "])
    expect(ContextWindow.make({ modelId: "test-model", activeTools: ["read", " write "] }).digest).toBe(value.digest)
  })

  it("declares an active tool set without changing the stable prefix", () => {
    const value = lazy()
    const activated = lazyActivated()

    expect(value.activeTools).toEqual([])
    expect(activated.activeTools).toEqual(["write"])
    expect(activated.digest).not.toBe(value.digest)

    // The active set never rewrites a sealed segment, so the cached prefix survives.
    expect(sealedPrefix(activated)).toEqual(sealedPrefix(value))
    expect(activated.tokens.prefix).toEqual(value.tokens.prefix)
  })

  it("renders the same prefix when a lazily loaded tool is active", () => {
    const value = lazy()
    const activated = lazyActivated()
    const before = ContextWindow.render(value)
    const after = ContextWindow.render(activated)

    // A deferred declaration is advertised before and after activation, so the
    // prefix the provider caches is unchanged by loading the tool.
    expect(after.tools.map((definition) => definition.name)).toEqual(["write"])
    expect(after.modelId).toBe(before.modelId)
    expect(after.system).toEqual(before.system)
    expect(after.messages).toEqual(before.messages)
    expect(after.tools).toEqual(before.tools)
  })

  it("appends the settled assistant turn to the tail", () => {
    const assistant = Request.Message.assistant("working", { stopReason: "stop" })
    const next = ContextWindow.appendTurn(base(), assistant)

    const appended = next.segments[next.segments.length - 1]
    expect(appended?.kind).toBe("transcript")
    expect(appended?.zone).toBe("tail")
    expect(appended?.content).toEqual([assistant])

    const request = ContextWindow.render(next)
    expect(request.messages[request.messages.length - 1]).toEqual(assistant)
  })

  it("keeps token accounting aligned with segments", () => {
    const value = base()
    const sum = value.tokens.bySegment.reduce((total, segment) => total + segment.tokens.value, 0)
    expect(value.tokens.total.value).toBe(sum)
    expect(value.tokens.total.estimated).toBe(true)
  })

  it("compacts the transcript prefix and renders a valid request", () => {
    const compacted = Result.getOrThrow(ContextWindow.compact(base(), Request.Message.user("summary")))
    const request = ContextWindow.render(compacted)
    expect(compacted.replaced).toBeDefined()
    expect(request.messages.map((message) => message.content.find((part) => "text" in part)?.text)).toEqual([
      "summary",
      "second"
    ])
    expect(request.tools.map((definition) => definition.name)).toEqual(["read"])
  })

  it("returns a stable typed error for an invalid compaction prefix", () => {
    const result = ContextWindow.prefixDigest(base(), -1)
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toMatchObject({
        code: "invalid_compaction_prefix"
      })
    }
  })

  describe("construction boundaries", () => {
    it("builds an empty window with no segments, no tools, and a zero accounting", () => {
      const value = ContextWindow.empty("test-model")
      expect(value.modelId).toBe("test-model")
      expect(value.segments).toEqual([])
      expect(value.activeTools).toEqual([])
      expect(value.replaced).toBeUndefined()
      expect(value.tokens.total.value).toBe(0)
      expect(value.tokens.prefix.value).toBe(0)
      expect(value.tokens.tail.value).toBe(0)
      // Nothing was estimated, because nothing was counted.
      expect(value.tokens.total.estimated).toBe(false)
    })

    it("treats omitted segments and tools the same as empty ones", () => {
      expect(ContextWindow.make({ modelId: "test-model" }).digest).toBe(
        ContextWindow.make({ modelId: "test-model", segments: [], activeTools: [] }).digest
      )
      expect(ContextWindow.empty("test-model").digest).toBe(ContextWindow.make({ modelId: "test-model" }).digest)
    })

    it("separates windows that differ only by model id", () => {
      expect(ContextWindow.empty("a").digest).not.toBe(ContextWindow.empty("b").digest)
    })

    it("folds a declared replacement digest into window identity", () => {
      const plain = ContextWindow.make({ modelId: "test-model" })
      const replaced = ContextWindow.make({ modelId: "test-model", replaced: "prior" })
      expect(replaced.replaced).toBe("prior")
      expect(replaced.digest).not.toBe(plain.digest)
    })

    it("keeps an already-built segment, digest and all", () => {
      const built = ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content: [] })
      expect(ContextWindow.makeSegment(built)).toBe(built)
      expect(ContextWindow.make({ modelId: "test-model", segments: [built] }).segments[0]?.digest).toBe(built.digest)
    })

    it("counts a segment with empty content without failing", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [{ kind: "transcript", zone: "tail", content: [] }]
      })
      expect(value.segments[0]?.content).toEqual([])
      expect(value.tokens.total.value).toBeGreaterThanOrEqual(0)
      expect(ContextWindow.render(value).messages).toEqual([])
    })

    it("uses a supplied token count instead of estimating one", () => {
      const declared = ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [Request.Message.user("a much longer body than seven tokens")],
        tokens: { value: 7, estimated: false }
      })
      expect(declared.tokens).toEqual({ value: 7, estimated: false })
      const estimated = ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [Request.Message.user("a much longer body than seven tokens")]
      })
      expect(estimated.tokens.estimated).toBe(true)
      // The declared count is not part of segment identity.
      expect(declared.digest).toBe(estimated.digest)
    })

    it("folds a declared digest into segment identity", () => {
      const content = [Request.Message.user("same")]
      const plain = ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content })
      const declared = ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content,
        declaredDigest: "upstream"
      })
      expect(declared.digest).not.toBe(plain.digest)
      expect(
        ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content, declaredDigest: undefined }).digest
      ).toBe(plain.digest)
    })

    it("separates segments that differ only by kind or zone", () => {
      const content = [Request.Message.user("same")]
      const digests = new Set([
        ContextWindow.makeSegment({ kind: "transcript", zone: "tail", content }).digest,
        ContextWindow.makeSegment({ kind: "summary", zone: "tail", content }).digest,
        ContextWindow.makeSegment({ kind: "transcript", zone: "prefix", content }).digest
      ])
      expect(digests.size).toBe(3)
    })

    it("digests an explicitly undefined field the same as an absent one", () => {
      const explicit = ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [Request.Message.assistant(Request.ThinkingPart.make({ text: "t" }), { stopReason: "stop" })]
      })
      const absent = ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [Request.Message.assistant([{ type: "thinking", text: "t" }], { stopReason: "stop" })]
      })
      expect(explicit.digest).toBe(absent.digest)
    })

    it("digests a null inside a tool parameter document as null", () => {
      const nullable = Request.ToolDefinition.make({
        name: "nullable",
        description: "Nullable",
        parameters: { fallback: null }
      })
      const missing = Request.ToolDefinition.make({ name: "nullable", description: "Nullable", parameters: {} })
      const digestOf = (definition: Request.ToolDefinition) =>
        ContextWindow.makeSegment({ kind: "tools", zone: "prefix", content: [definition] }).digest
      expect(digestOf(nullable)).not.toBe(digestOf(missing))
    })

    it("drops blank and duplicate tool names when normalizing the active set", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        activeTools: ["read", "", "   ", "READ", " read ", "write"]
      })
      expect(value.activeTools).toEqual(["read", "write"])
    })

    it("keeps the first spelling of a tool name that repeats in another case", () => {
      expect(ContextWindow.make({ modelId: "test-model", activeTools: [" Read ", "read"] }).activeTools).toEqual([
        " Read "
      ])
    })

    it("splits the accounting by cache zone", () => {
      const value = base()
      const zone = (name: "prefix" | "tail") =>
        value.segments.filter((segment) => segment.zone === name).reduce(
          (total, segment) => total + segment.tokens.value,
          0
        )
      expect(value.tokens.prefix.value).toBe(zone("prefix"))
      expect(value.tokens.tail.value).toBe(zone("tail"))
      expect(value.tokens.bySegment.map((segment) => segment.digest)).toEqual(
        value.segments.map((segment) => segment.digest)
      )
    })
  })

  describe("the class surface", () => {
    it("delegates every static to the standalone combinator", () => {
      const value = ContextWindow.ContextWindow.make({
        modelId: "test-model",
        segments: [{ kind: "transcript", zone: "tail", content: [Request.Message.user("first")] }]
      })
      expect(value.digest).toBe(
        ContextWindow.make({
          modelId: "test-model",
          segments: [{ kind: "transcript", zone: "tail", content: [Request.Message.user("first")] }]
        }).digest
      )
      expect(ContextWindow.ContextWindow.empty("test-model").digest).toBe(ContextWindow.empty("test-model").digest)

      const assistant = Request.Message.assistant("working", { stopReason: "stop" })
      expect(ContextWindow.ContextWindow.appendTurn(value, assistant).digest).toBe(
        ContextWindow.appendTurn(value, assistant).digest
      )
      expect(ContextWindow.ContextWindow.render(value)).toEqual(ContextWindow.render(value))

      const summary = Request.Message.user("summary")
      expect(Result.getOrThrow(ContextWindow.ContextWindow.compact(value, summary)).digest).toBe(
        Result.getOrThrow(ContextWindow.compact(value, summary)).digest
      )
    })

    it("threads the data-last combinators through the instance pipe", () => {
      const value = base()
      const assistant = Request.Message.assistant("working", { stopReason: "stop" })

      const request = value.pipe(ContextWindow.appendTurn(assistant), ContextWindow.render)

      // Pins the inferred output: a regression to a `pipe` declared with no
      // operators and an `unknown` result fails the typecheck here.
      expectTypeOf(request).toEqualTypeOf<Request.ModelRequest>()
      expect(request).toEqual(ContextWindow.render(ContextWindow.appendTurn(value, assistant)))
      expect(request.messages.at(-1)).toEqual(assistant)
    })

    it("returns itself from an empty pipe", () => {
      const value = base()
      expectTypeOf(value.pipe()).toEqualTypeOf<ContextWindow.ContextWindow>()
      expect(value.pipe()).toBe(value)
    })

    it("reaches the same window through the data-last form of every combinator", () => {
      const value = base()
      const assistant = Request.Message.assistant("working", { stopReason: "stop" })
      expect(ContextWindow.appendTurn(assistant)(value).digest).toBe(
        ContextWindow.appendTurn(value, assistant).digest
      )

      const summary = Request.Message.user("summary")
      expect(Result.getOrThrow(ContextWindow.compact(summary)(value)).digest).toBe(
        Result.getOrThrow(ContextWindow.compact(value, summary)).digest
      )
    })
  })

  describe("appendTurn", () => {
    it("appends one segment holding only the assistant message", () => {
      const assistant = Request.Message.assistant("done", { stopReason: "stop" })
      const next = ContextWindow.appendTurn(base(), assistant)
      expect(next.segments.at(-1)?.content).toEqual([assistant])
      expect(next.segments).toHaveLength(base().segments.length + 1)
    })

    it("carries the active tools and the replacement digest onto the new window", () => {
      const compacted = Result.getOrThrow(ContextWindow.compact(base(), Request.Message.user("summary")))
      const next = ContextWindow.appendTurn(compacted, Request.Message.assistant("more"))
      expect(next.replaced).toBe(compacted.replaced)
      expect(next.activeTools).toEqual(compacted.activeTools)
    })

    it("appends onto an empty window", () => {
      const assistant = Request.Message.assistant("first words")
      const next = ContextWindow.appendTurn(ContextWindow.empty("test-model"), assistant)
      expect(next.segments).toHaveLength(1)
      expect(ContextWindow.render(next).messages).toEqual([assistant])
    })
  })

  describe("prefixDigest", () => {
    it("digests the empty prefix of any window identically", () => {
      const expected = Digest.digest(CanonicalJson.stringify([]))
      expect(Result.getOrThrow(ContextWindow.prefixDigest(base(), 0))).toBe(expected)
      expect(Result.getOrThrow(ContextWindow.prefixDigest(ContextWindow.empty("test-model"), 0))).toBe(expected)
    })

    it("digests the whole compactable set at its exact length", () => {
      expect(Result.isSuccess(ContextWindow.prefixDigest(base(), 2))).toBe(true)
    })

    it("fails one segment past the compactable set", () => {
      const result = ContextWindow.prefixDigest(base(), 3)
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) {
        expect(result.failure.code).toBe("invalid_compaction_prefix")
        expect(result.failure.message).toBe("Compaction prefix length exceeds the compactable context")
      }
    })

    it("counts only compactable segments toward the prefix length", () => {
      // `base()` holds five segments but only two the prefix may reach.
      expect(Result.isFailure(ContextWindow.prefixDigest(base(), 5))).toBe(true)
      expect(Result.isFailure(ContextWindow.prefixDigest(sealedOnly(), 1))).toBe(true)
    })

    it("rejects a prefix length that is not a non-negative safe integer", () => {
      for (const length of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
        const result = ContextWindow.prefixDigest(base(), length)
        expect(Result.isFailure(result)).toBe(true)
        if (Result.isFailure(result)) {
          expect(result.failure.message).toBe("Compaction prefix length must be a non-negative safe integer")
        }
      }
    })

    it("changes when the prefix content changes and not when the suffix does", () => {
      const value = base()
      const appended = ContextWindow.appendTurn(value, Request.Message.assistant("later"))
      expect(Result.getOrThrow(ContextWindow.prefixDigest(appended, 1))).toBe(
        Result.getOrThrow(ContextWindow.prefixDigest(value, 1))
      )
      expect(Result.getOrThrow(ContextWindow.prefixDigest(value, 2))).not.toBe(
        Result.getOrThrow(ContextWindow.prefixDigest(value, 1))
      )
    })
  })

  describe("compactPrefix", () => {
    it("returns the identical window for a zero-length prefix", () => {
      const value = base()
      expect(Result.getOrThrow(ContextWindow.compactPrefix(value, 0, Request.Message.user("summary")))).toBe(value)
    })

    it("returns the identical window when nothing is compactable", () => {
      const value = sealedOnly()
      expect(Result.getOrThrow(ContextWindow.compactPrefix(value, 0, Request.Message.user("summary")))).toBe(value)
    })

    it("fails past the compactable set instead of compacting what it can", () => {
      expect(Result.isFailure(ContextWindow.compactPrefix(base(), 3, Request.Message.user("s")))).toBe(true)
    })

    it("inserts the summary where the first replaced segment sat, keeping sealed segments in place", () => {
      const compacted = Result.getOrThrow(ContextWindow.compactPrefix(base(), 1, Request.Message.user("summary")))
      expect(compacted.segments.map((segment) => segment.kind)).toEqual([
        "system",
        "instructions",
        "tools",
        "summary",
        "transcript"
      ])
      expect(compacted.segments.find((segment) => segment.kind === "summary")?.zone).toBe("tail")
      expect(texts(ContextWindow.render(compacted))).toEqual(["summary", "second"])
    })

    it("keeps a reused segment in the suffix when compacting a prefix", () => {
      const shared = ContextWindow.makeSegment({
        kind: "transcript",
        zone: "tail",
        content: [Request.Message.user("repeat")]
      })
      const value = ContextWindow.make({ modelId: "test-model", segments: [shared, shared] })
      const summary = Request.Message.user("summary of first occurrence")
      expect(texts(ContextWindow.render(value))).toEqual(["repeat", "repeat"])

      const compacted = Result.getOrThrow(ContextWindow.compactPrefix(value, 1, summary))
      expect(compacted.segments).toHaveLength(2)
      expect(compacted.segments[0]?.content).toEqual([summary])
      expect(compacted.segments[1]).toBe(shared)
      expect(texts(ContextWindow.render(compacted))).toEqual(["summary of first occurrence", "repeat"])
    })

    it("replaces the whole compactable set when the prefix covers it", () => {
      const compacted = Result.getOrThrow(ContextWindow.compactPrefix(base(), 2, Request.Message.user("all of it")))
      expect(compacted.segments.filter((segment) => segment.kind === "transcript")).toEqual([])
      expect(texts(ContextWindow.render(compacted))).toEqual(["all of it"])
    })

    it("accepts a list of summary messages", () => {
      const compacted = Result.getOrThrow(
        ContextWindow.compactPrefix(base(), 2, [Request.Message.user("part one"), Request.Message.user("part two")])
      )
      expect(texts(ContextWindow.render(compacted))).toEqual(["part one", "part two"])
    })

    it("accepts an empty list of summary messages, dropping the prefix outright", () => {
      const compacted = Result.getOrThrow(ContextWindow.compactPrefix(base(), 2, []))
      expect(compacted.segments.map((segment) => segment.kind)).toEqual([
        "system",
        "instructions",
        "tools",
        "summary"
      ])
      expect(ContextWindow.render(compacted).messages).toEqual([])
    })

    it("records the digest of exactly what it replaced", () => {
      const value = base()
      const compacted = Result.getOrThrow(ContextWindow.compactPrefix(value, 1, Request.Message.user("summary")))
      expect(compacted.replaced).toBe(Result.getOrThrow(ContextWindow.prefixDigest(value, 1)))
    })

    it("grows the accounting when the summary is larger than what it replaced", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [{
          kind: "transcript",
          zone: "tail",
          content: [Request.Message.user("hi")],
          tokens: { value: 1, estimated: false }
        }]
      })
      const compacted = Result.getOrThrow(
        ContextWindow.compactPrefix(value, 1, Request.Message.user("verbose ".repeat(200)))
      )
      expect(compacted.tokens.total.value).toBeGreaterThan(value.tokens.total.value)
    })

    it("compacts a window that is already a summary plus a tail", () => {
      const once = Result.getOrThrow(
        ContextWindow.compactPrefix(base(), 1, Request.Message.assistant("first summary", { stopReason: "stop" }))
      )
      expect(ContextWindow.render(once).messages[0]?.role).toBe("user")

      const twice = Result.getOrThrow(
        ContextWindow.compactPrefix(once, 2, Request.Message.assistant("second summary", { stopReason: "stop" }))
      )
      expect(twice.segments.filter((segment) => segment.kind === "summary")).toHaveLength(1)
      expect(texts(ContextWindow.render(twice))).toEqual(["second summary"])
      expect(ContextWindow.render(twice).messages[0]?.role).toBe("user")
      expect(twice.replaced).not.toBe(once.replaced)
    })
  })

  describe("compactMarked", () => {
    const turn = (text: string) =>
      ({ kind: "transcript", zone: "tail", content: [Request.Message.user(text)] }) as const
    const four = () =>
      ContextWindow.make({
        modelId: "test-model",
        segments: [
          { kind: "system", zone: "prefix", content: [system] },
          turn("one"),
          turn("two"),
          turn("three"),
          turn("four")
        ],
        activeTools: []
      })

    it("orders the summary, then the kept segments, then the suffix, and drops what is removed", () => {
      const value = four()
      const compacted = Result.getOrThrow(
        ContextWindow.compactMarked(value, 3, ["squash", "keep", "remove"], Request.Message.user("summary"))
      )
      expect(compacted.segments.map((segment) => segment.kind)).toEqual([
        "system",
        "summary",
        "transcript",
        "transcript"
      ])
      expect(texts(ContextWindow.render(compacted))).toEqual(["summary", "two", "four"])
      expect(compacted.segments[2]).toBe(value.segments[2])
      expect(compacted.segments[2]?.digest).toBe(value.segments[2]?.digest)
      expect(compacted.replaced).toBe(Result.getOrThrow(ContextWindow.prefixDigest(value, 3)))
    })

    it("applies keep, squash, and remove marks to occurrences, not shared identities", () => {
      const shared = ContextWindow.makeSegment(turn("repeat"))
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [shared, shared, shared, shared]
      })
      const summary = Request.Message.user("summary")
      const compacted = Result.getOrThrow(
        ContextWindow.compactMarked(value, 3, ["keep", "squash", "remove"], summary)
      )
      expect(compacted.segments).toHaveLength(3)
      expect(compacted.segments[1]).toBe(shared)
      expect(compacted.segments[2]).toBe(shared)
      expect(texts(ContextWindow.render(compacted))).toEqual(["summary", "repeat", "repeat"])
      expect(compacted.replaced).toBe(Result.getOrThrow(ContextWindow.prefixDigest(value, 3)))
    })

    it("adds no summary segment when nothing is squashed", () => {
      const value = four()
      const compacted = Result.getOrThrow(ContextWindow.compactMarked(value, 2, ["keep", "remove"], undefined))
      expect(compacted.segments.some((segment) => segment.kind === "summary")).toBe(false)
      expect(texts(ContextWindow.render(compacted))).toEqual(["one", "three", "four"])
      expect(compacted.segments[1]).toBe(value.segments[1])
    })

    it("returns the identical window for a zero-length prefix", () => {
      const value = four()
      expect(Result.getOrThrow(ContextWindow.compactMarked(value, 0, [], undefined))).toBe(value)
    })

    it("refuses marks that do not fit the prefix or the summary", () => {
      for (
        const [marks, summary, message] of [
          [["keep"], undefined, "Compaction marks must name every prefix segment once"],
          [
            ["keep", "remove"],
            Request.Message.user("s"),
            "A compaction summary is required exactly when a prefix segment is squashed"
          ],
          [["keep", "squash"], undefined, "A compaction summary is required exactly when a prefix segment is squashed"]
        ] as const
      ) {
        const result = ContextWindow.compactMarked(four(), 2, marks, summary)
        expect(Result.isFailure(result) && result.failure).toMatchObject({ code: "invalid_compaction_marks", message })
      }
      expect(Result.isFailure(ContextWindow.compactMarked(four(), 9, [], undefined))).toBe(true)
    })

    it("squashes every segment exactly as compactPrefix did", () => {
      // compactPrefix before marks: the summary where the first replaced
      // segment sat, then every other segment in order.
      const previous = (
        self: ContextWindow.ContextWindow,
        prefixLength: number,
        summary: ReadonlyArray<Request.Message>
      ) => {
        const replacedSegments = self.segments.filter((segment) =>
          segment.kind === "transcript" || segment.kind === "summary" || segment.kind === "steering"
        ).slice(0, prefixLength)
        const first = self.segments.findIndex((segment) => replacedSegments.includes(segment))
        return ContextWindow.make({
          modelId: self.modelId,
          segments: [
            ...self.segments.slice(0, first),
            ContextWindow.makeSegment({ kind: "summary", zone: "tail", content: summary }),
            ...self.segments.slice(first).filter((segment) => !replacedSegments.includes(segment))
          ],
          activeTools: self.activeTools,
          replaced: Result.getOrThrow(ContextWindow.prefixDigest(self, prefixLength))
        })
      }
      const interleaved = ContextWindow.make({
        modelId: "test-model",
        segments: [
          { kind: "system", zone: "prefix", content: [system] },
          turn("one"),
          { kind: "instructions", zone: "prefix", content: [Request.SystemPart.make({ text: "Mid" })] },
          turn("two"),
          turn("three")
        ],
        activeTools: ["read"]
      })
      for (const [value, length] of [[base(), 1], [base(), 2], [four(), 3], [interleaved, 2]] as const) {
        const summary = [Request.Message.user("summary")]
        const marked = Result.getOrThrow(
          ContextWindow.compactMarked(value, length, Array.from({ length }, () => "squash" as const), summary)
        )
        const golden = previous(value, length, summary)
        expect(marked.digest).toBe(golden.digest)
        expect(marked).toEqual(golden)
        expect(Result.getOrThrow(ContextWindow.compactPrefix(value, length, summary))).toEqual(golden)
      }
    })
  })

  describe("compact", () => {
    it("retains the last compactable segment when more than one exists", () => {
      const compacted = Result.getOrThrow(ContextWindow.compact(base(), Request.Message.user("summary")))
      expect(texts(ContextWindow.render(compacted))).toEqual(["summary", "second"])
    })

    it("replaces the only compactable segment when just one exists", () => {
      const compacted = Result.getOrThrow(ContextWindow.compact(single(), Request.Message.user("summary")))
      expect(compacted.segments.map((segment) => segment.kind)).toEqual(["system", "summary"])
      expect(texts(ContextWindow.render(compacted))).toEqual(["summary"])
      expect(compacted.replaced).toBeDefined()
    })

    it("returns the identical window when there is nothing compactable", () => {
      const value = sealedOnly()
      expect(Result.getOrThrow(ContextWindow.compact(value, Request.Message.user("summary")))).toBe(value)
      expect(Result.getOrThrow(ContextWindow.compact(ContextWindow.empty("m"), Request.Message.user("s"))).segments)
        .toEqual([])
    })

    it("treats summary and steering segments as compactable", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [
          { kind: "summary", zone: "tail", content: [Request.Message.user("prior summary")] },
          { kind: "steering", zone: "tail", content: [Request.Message.user("steer")] },
          { kind: "transcript", zone: "tail", content: [Request.Message.user("latest")] }
        ]
      })
      const compacted = Result.getOrThrow(ContextWindow.compact(value, Request.Message.user("merged")))
      expect(compacted.segments.map((segment) => segment.kind)).toEqual(["summary", "transcript"])
      expect(texts(ContextWindow.render(compacted))).toEqual(["merged", "latest"])
    })
  })

  describe("render", () => {
    it("renders an empty window as an empty request", () => {
      const request = ContextWindow.render(ContextWindow.empty("test-model"))
      expect(request.modelId).toBe("test-model")
      expect(request.system).toEqual([])
      expect(request.messages).toEqual([])
      expect(request.tools).toEqual([])
      expect(request.params).toEqual(Request.GenerationParams.make())
    })

    it("carries the window's model id, whatever it is", () => {
      for (const modelId of ["", "claude-sonnet-4-5", "gpt-5.6-sol"]) {
        expect(ContextWindow.render(ContextWindow.empty(modelId)).modelId).toBe(modelId)
      }
    })

    it("collects system parts, messages, and tools by their shape, in segment order", () => {
      const request = ContextWindow.render(base())
      expect(request.system.map((part) => part.text)).toEqual(["Be concise.", "Follow instructions"])
      expect(texts(request)).toEqual(["first", "second"])
      expect(request.tools.map((definition) => definition.name)).toEqual(["read"])
    })

    it("omits a declared tool that is neither deferred nor active", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [{ kind: "tools", zone: "prefix", content: [tool] }],
        activeTools: []
      })
      expect(ContextWindow.render(value).tools).toEqual([])
    })

    it("keeps the last declaration when the same tool name is declared twice", () => {
      const upper = Request.ToolDefinition.make({ name: "Read", description: "first", parameters: {} })
      const lower = Request.ToolDefinition.make({ name: " read ", description: "second", parameters: {} })
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [{ kind: "tools", zone: "prefix", content: [upper, lower] }],
        activeTools: ["READ"]
      })
      expect(ContextWindow.render(value).tools).toEqual([lower])
    })

    it("matches an active name against a declaration regardless of case and padding", () => {
      const value = ContextWindow.make({
        modelId: "test-model",
        segments: [{ kind: "tools", zone: "prefix", content: [tool] }],
        activeTools: [" ReAd "]
      })
      expect(ContextWindow.render(value).tools).toEqual([tool])
    })
  })

  describe("an active tool set and compaction together", () => {
    it("holds the sealed prefix steady across a compaction", () => {
      const value = lazy()
      const compacted = Result.getOrThrow(ContextWindow.compact(lazyActivated(), Request.Message.user("summary")))

      // Compaction only ever rewrites tail segments, so the cached prefix and
      // the deferred declaration both survive the round trip.
      expect(sealedPrefix(compacted)).toEqual(sealedPrefix(value))
      expect(compacted.tokens.prefix).toEqual(value.tokens.prefix)
      expect(compacted.activeTools).toEqual(["write"])
      expect(ContextWindow.render(compacted).tools.map((definition) => definition.name)).toEqual(["write"])
    })
  })
})
