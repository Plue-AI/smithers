import { ModelError } from "@smthrs/model/ModelError"
import { ModelRequest } from "@smthrs/model/ModelRequest"
import { Effect, Stream } from "effect"
import { expect, test } from "vitest"
import { fastModelFallback } from "../src/FastModelFallback.ts"

const request = new ModelRequest({ modelId: "gateway", system: [], messages: [], tools: [], params: {} })
const answer = { type: "text-delta", id: "text", text: "answer" } as const

test.each(
  ["authentication", "rate_limited", "quota_exceeded", "transport", "call_timeout", "provider_internal"] as const
)("%s falls through gateway, team and coding with each source's model", async (code) => {
  const seen: string[] = []
  const fail = (modelId: string) => ({
    modelId,
    model: {
      stream: (input: ModelRequest) => {
        seen.push(input.modelId)
        return Stream.fail(new ModelError({ code, message: "fixture" }))
      }
    }
  })
  const model = fastModelFallback([fail("gateway"), fail("team"), {
    modelId: "coding",
    model: {
      stream: (input) => {
        seen.push(input.modelId)
        return Stream.succeed(answer)
      }
    }
  }])
  expect(await Effect.runPromise(Stream.runCollect(model.stream(request)))).toEqual([answer])
  expect(seen).toEqual(["gateway", "team", "coding"])
})
test.each(["invalid_request", "context_overflow", "content_policy", "invalid_provider_output"] as const)(
  "%s keeps its own failure",
  async (code) => {
    let backup = false
    const error = new ModelError({ code, message: "fixture" })
    const model = fastModelFallback([{ modelId: "gateway", model: { stream: () => Stream.fail(error) } }, {
      modelId: "team",
      model: {
        stream: () => {
          backup = true
          return Stream.succeed(answer)
        }
      }
    }])
    await expect(Effect.runPromise(Stream.runCollect(model.stream(request)))).rejects.toThrow("fixture")
    expect(backup).toBe(false)
  }
)
test("partial output is never replayed on another source", async () => {
  let backup = false
  const model = fastModelFallback([{
    modelId: "gateway",
    model: {
      stream: () =>
        Stream.concat(
          Stream.succeed(answer),
          Stream.fail(new ModelError({ code: "transport", message: "disconnected" }))
        )
    }
  }, {
    modelId: "coding",
    model: {
      stream: () => {
        backup = true
        return Stream.succeed(answer)
      }
    }
  }])
  await expect(Effect.runPromise(Stream.runCollect(model.stream(request)))).rejects.toThrow("disconnected")
  expect(backup).toBe(false)
})
test("a primary answer does not spend fallback keys and calls reset independently", async () => {
  let count = 0, backup = false
  const model = fastModelFallback([{
    modelId: "gateway",
    model: {
      stream: () => {
        count++
        return Stream.succeed(answer)
      }
    }
  }, {
    modelId: "coding",
    model: {
      stream: () => {
        backup = true
        return Stream.succeed(answer)
      }
    }
  }])
  for (let i = 0; i < 2; i++) {
    expect(await Effect.runPromise(Stream.runCollect(model.stream(request)))).toEqual([answer])
  }
  expect(count).toBe(2)
  expect(backup).toBe(false)
})

test("a ChatGPT fallback omits its unsupported output limit", async () => {
  let params: unknown
  const model = fastModelFallback([{
    modelId: "gateway",
    model: { stream: () => Stream.fail(new ModelError({ code: "transport", message: "down" })) }
  }, {
    modelId: "chatgpt",
    outputTokenLimitSupported: false,
    model: {
      stream: (input) => {
        params = input.params
        return Stream.succeed(answer)
      }
    }
  }])
  await Effect.runPromise(
    Stream.runCollect(model.stream(new ModelRequest({ ...request, params: { maxTokens: 4096, temperature: 0.2 } })))
  )
  expect(params).toEqual({ temperature: 0.2 })
})
test("an empty host source list refuses as a missing route", async () => {
  await expect(Effect.runPromise(Stream.runCollect(fastModelFallback([]).stream(request)))).rejects.toThrow(
    "Fast model unavailable"
  )
})
