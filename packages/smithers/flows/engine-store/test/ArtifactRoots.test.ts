/**
 * An artifact root this build cannot decode is a tagged refusal naming only
 * the table, so backup routes it by tag and never echoes the row.
 */
import * as Effect from "effect/Effect"
import { describe, expect, it } from "vitest"
import * as ArtifactRoots from "../src/internal/ArtifactRoots.ts"

const route = <A>(effect: Effect.Effect<A, ArtifactRoots.ArtifactRootDecodeError>) =>
  Effect.runPromise(
    effect.pipe(
      Effect.map(() => "decoded"),
      Effect.catchTag("@smthrs/engine-store/ArtifactRootDecodeError", (failure) =>
        Effect.succeed(`${failure.table}: ${failure.message}`))
    )
  )

describe("ArtifactRootDecodeError", () => {
  it("refuses unreadable metadata JSON with the table and without the row text", async () => {
    const routed = await route(ArtifactRoots.rootDigests("flows_step_cache", "{\"secret-row"))
    expect(routed).toBe(
      "flows_step_cache: a flows_step_cache row carries artifact evidence this build cannot decode"
    )
    expect(routed).not.toContain("secret-row")
  })

  it("refuses boundary evidence that does not decode and keeps the decode cause", async () => {
    const failure = await Effect.runPromise(
      Effect.flip(ArtifactRoots.rootDigests("flows_attempts", JSON.stringify({ boundary: 7 })))
    )
    expect(failure).toMatchObject({ _tag: "@smthrs/engine-store/ArtifactRootDecodeError", table: "flows_attempts" })
    expect(failure.cause).toBeDefined()
  })

  it("refuses an unreadable checkpoint under its column name", async () => {
    expect(await route(ArtifactRoots.checkpointDigests("not json"))).toBe(
      "flows_attempts.checkpoint_json: a flows_attempts.checkpoint_json row carries artifact evidence this build cannot decode"
    )
    expect(await route(ArtifactRoots.checkpointDigests(null))).toBe("decoded")
  })
})
