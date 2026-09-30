import { describe, expect, test } from "bun:test"
import { createActorBindings } from "../ActorBindings"
import { createRunEpochs } from "./RunEpochs"

/*
 * The fence three run-tracking seams share. The invariant that matters is
 * that an epoch is never handed out twice for a key: a settled loop retires
 * only its live marker, never the counter that issues the next one.
 */
describe("createRunEpochs", () => {
  test("a settled key still issues a strictly newer epoch", () => {
    const epochs = createRunEpochs({}, "run-epochs")

    const first = epochs.start("will/smithers")
    epochs.settle("will/smithers", first)
    const second = epochs.start("will/smithers")

    expect(second).toBeGreaterThan(first)
    /* The loop that held the retired epoch stays fenced out forever. */
    expect(epochs.isLive("will/smithers", first)).toBe(false)
    expect(epochs.isLive("will/smithers", second)).toBe(true)
  })

  test("a newer start supersedes the loop before it, and settling the old one leaves it alone", () => {
    const epochs = createRunEpochs({}, "run-epochs")

    const first = epochs.start("will/smithers")
    const second = epochs.start("will/smithers")
    expect(epochs.isLive("will/smithers", first)).toBe(false)

    epochs.settle("will/smithers", first)
    expect(epochs.isLive("will/smithers", second)).toBe(true)
  })

  test("keys are counted apart, and cancel retires whatever is live", () => {
    const epochs = createRunEpochs({}, "run-epochs")

    expect(epochs.start("will/smithers")).toBe(1)
    expect(epochs.start("will/flows")).toBe(1)
    expect(epochs.start("will/smithers")).toBe(2)

    epochs.cancel("will/flows")
    expect(epochs.isLive("will/flows", 1)).toBe(false)
    expect(epochs.isLive("will/smithers", 2)).toBe(true)
  })
})

test("user and agent projections fence the same key while contexts and names remain isolated", () => {
  const context = {}
  const bindings = createActorBindings(() => {})
  const user = bindings.pair(context, ctx => createRunEpochs(ctx, "shared"))
  const agentStart = bindings.select(user.start)
  expect(user.start("repo")).toBe(1)
  expect(agentStart("repo")).toBe(2)
  expect(user.isLive("repo", 1)).toBe(false)
  expect(user.isLive("repo", 2)).toBe(true)
  expect(createRunEpochs(context, "shared").isLive("repo", 2)).toBe(true)
  expect(createRunEpochs(context, "other").start("repo")).toBe(1)
  expect(createRunEpochs({}, "shared").start("repo")).toBe(1)
  expect(user.isLive("repo", 2)).toBe(true)
})

test("cancellation never reissues an epoch or lets a retired settlement cancel its replacement", () => {
  const epochs = createRunEpochs({}, "cancel")
  expect(epochs.isLive("missing", 1)).toBe(false)
  epochs.cancel("missing")
  const old = epochs.start("repo")
  epochs.cancel("repo")
  expect(epochs.isLive("repo", old)).toBe(false)
  const current = epochs.start("repo")
  expect(current).toBe(2)
  epochs.settle("repo", old)
  expect(epochs.isLive("repo", current)).toBe(true)
  epochs.settle("repo", current)
  expect(epochs.isLive("repo", current)).toBe(false)
  expect(epochs.start("repo")).toBe(3)
})
