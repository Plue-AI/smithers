import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Detect from "../src/Detect.ts"
import * as PromptHints from "../src/PromptHints.ts"
import { copyFixture, nodeLayer } from "./fixtures/helpers.ts"

/** Renders a printed template body with a payload, the way the flow will. */
const render = (template: string, payload: Record<string, unknown>): string => {
  const build = new Function("payload", `return \`${template}\``) as (payload: Record<string, unknown>) => string
  return build(payload)
}

describe("PromptHints.classify", () => {
  it("accepts a prompt whose only expressions read props", () => {
    expect(PromptHints.classify("Research this topic: {props.topic}")).toBe("interpolation-only")
    expect(PromptHints.classify("Points: {JSON.stringify(props.keyPoints)}")).toBe("interpolation-only")
  })

  it("rejects a prompt that imports or renders", () => {
    expect(PromptHints.classify("import Shared from \"./shared.mdx\"\n\nHello")).toBe("jsx")
    expect(PromptHints.classify("Hello <Callout>note</Callout>")).toBe("jsx")
    expect(PromptHints.classify("Total: {props.items.length}")).toBe("jsx")
  })
})

describe("PromptHints.print", () => {
  it("renders the same text the MDX prompt rendered", () => {
    const template = PromptHints.print("Research this topic and provide a summary: {props.topic}")

    expect(template).toBe("Research this topic and provide a summary: ${payload.topic}")
    expect(render(template, { topic: "durable workflows" })).toBe(
      "Research this topic and provide a summary: durable workflows"
    )
  })

  it("keeps JSON.stringify in the interpolation", () => {
    const template = PromptHints.print("Key Points: {JSON.stringify(props.keyPoints)}")

    expect(render(template, { keyPoints: ["a", "b"] })).toBe("Key Points: [\"a\",\"b\"]")
  })

  it("escapes backticks and backslashes in the prose", () => {
    const template = PromptHints.print("Run `bun test` and match \\n exactly: {props.note}")

    expect(render(template, { note: "ok" })).toBe("Run `bun test` and match \\n exactly: ok")
  })

  it("keeps a currency sign next to an interpolation literal", () => {
    const template = PromptHints.print("Budget: ${props.amount}")

    expect(render(template, { amount: 5 })).toBe("Budget: $5")
  })

  it("renames the payload when asked", () => {
    expect(PromptHints.print("Topic: {props.topic}", "input")).toBe("Topic: ${input.topic}")
  })

  it("preserves literal tails and incomplete braces without creating a template interpolation", () => {
    expect(PromptHints.print("Run `test` \\ and show $5")).toBe("Run \\`test\\` \\\\ and show $5")
    expect(PromptHints.print("A plain prompt")).toBe("A plain prompt")
    expect(PromptHints.print("Unfinished {props.topic")).toBe("Unfinished {props.topic")
    const template = PromptHints.print("First: {props.first}; second: {props.second}.")
    expect(render(template, { first: "one", second: "two" })).toBe("First: one; second: two.")
  })
})

describe("PromptHints.hints", () => {
  it.effect("converts both jsx-single prompts", () =>
    Effect.gen(function*() {
      const detection = yield* Detect.scan(copyFixture("jsx-single"))
      const found = PromptHints.hints(detection)

      expect(found.map((hint) => hint.file)).toEqual([
        "prompts/simple-workflow/research.mdx",
        "prompts/simple-workflow/write.mdx"
      ])
      expect(found[0]?.props).toEqual(["topic"])
      expect(render(found[0]!.template!, { topic: "durable workflows" })).toBe(
        "Research this topic and provide a summary with 3-5 key points: durable workflows"
      )
      expect(render(found[1]!.template!, { summary: "s", keyPoints: ["a"] })).toBe(
        "Write a short article based on this research:\n\nSummary: s\nKey Points: [\"a\"]"
      )
    }).pipe(Effect.provide(nodeLayer)))

  it.effect("converts every plue-pack prompt that only interpolates", () =>
    Effect.gen(function*() {
      const detection = yield* Detect.scan(copyFixture("plue-pack"))
      const found = PromptHints.hints(detection)

      expect(found.length).toBe(5)
      for (const hint of found) {
        if (hint.classification === "interpolation-only") expect(hint.template).toBeDefined()
        else expect(hint.template).toBeUndefined()
      }
    }).pipe(Effect.provide(nodeLayer)))

  it.effect("keeps a classified prompt without inventing template text when its source is unavailable", () =>
    Effect.gen(function*() {
      const detection = yield* Detect.scan(copyFixture("jsx-single"))
      const missing = detection.prompts[0]?.path
      if (missing === undefined) throw new Error("the fixture has no prompt")
      const sources = new Map(detection.sources)
      sources.delete(missing)
      const found = PromptHints.hints({ ...detection, sources })
      expect(found.find((hint) => hint.file === missing)).toEqual({
        file: missing,
        classification: "interpolation-only",
        props: ["topic"],
        template: undefined
      })
      expect(found.find((hint) => hint.file !== missing)?.template).toBeDefined()
    }).pipe(Effect.provide(nodeLayer)))
})
