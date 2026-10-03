import { expect, test } from "bun:test"
import { stories } from "./PrimitivesView.stories"
import { fixtures } from "@smthrs/rpc/fixtures/ActorChip"

test("actor stories retain the model-carried RPC oracle", () => {
  expect(fixtures.system.expect).toEqual(["system"])
  for (const [key, fixture] of Object.entries(fixtures)) {
    expect(stories.find(story => story.name === `actor-fixture-${key}`)!.expect).toBe(fixture.expect)
  }
})
test("every step story commits the complete expected label", () => {
  const labels = ["Queued · Implement", "Starting · Implement", "Working · Implement", "Needs you · Implement", "Paused · Implement", "Failed · Implement", "In review · Implement", "Merged · Implement", "Dropped · Implement"]
  expect(stories.filter(story => story.name.startsWith("state-") && story.name.endsWith("-step")).map(story => story.expect)).toEqual(labels.map(label => [label]))
})
