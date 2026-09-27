import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as Payload from "../src/github/Payload.ts"

describe("payload schemas", () => {
  const decodeWith = <A>(schema: Schema.Schema<A>, value: unknown) =>
    Effect.runPromise(
      Effect.exit(Schema.decodeUnknownEffect(schema)(value) as Effect.Effect<A, unknown>)
    )

  it("passes unmodelled fields through untouched", async () => {
    const delivery = {
      action: "opened",
      pull_request: { number: 12, some_new_field: true },
      repository: { full_name: "o/r" },
      unheard_of: { nested: 1 }
    }
    const exit = await decodeWith(Payload.PullRequestEvent, delivery)
    expect(exit._tag).toBe("Success")
    expect(exit._tag === "Success" ? exit.value : undefined).toEqual(delivery)
  })

  it("still rejects a modelled field of the wrong type", async () => {
    const exit = await decodeWith(Payload.PullRequestEvent, {
      action: "opened",
      pull_request: { number: "twelve" },
      repository: { full_name: "o/r" }
    })
    expect(exit._tag).toBe("Failure")
  })

  it("types the issue, comment, and push deliveries", async () => {
    expect(
      (await decodeWith(Payload.IssuesEvent, {
        action: "opened",
        issue: { number: 1 },
        repository: { full_name: "o/r" }
      }))._tag
    ).toBe("Success")
    expect(
      (await decodeWith(Payload.IssueCommentEvent, {
        action: "created",
        issue: { number: 1 },
        comment: { body: "hi" },
        repository: { full_name: "o/r" }
      }))._tag
    ).toBe("Success")
    expect(
      (await decodeWith(Payload.PushEvent, {
        ref: "refs/heads/main",
        repository: { full_name: "o/r" },
        commits: [{ id: "abc", message: "m" }],
        pusher: { name: "will" }
      }))._tag
    ).toBe("Success")
  })
})
