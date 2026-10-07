/*
 * Flag reads survive a snapshot that answers nothing.
 *
 * Registration-only callers - the payload gate, the search fixture - pass
 * inert actions whose every member answers `undefined`, `snapshot` included.
 * A flag read that guards only the missing method, `actions.snapshot?.().flag`,
 * throws there and takes the whole registry down with it. Every read guards
 * the answer too, `actions.snapshot?.()?.flag`, so an absent snapshot reads
 * exactly as an empty one: flag-off.
 */
import { describe, expect, test } from "bun:test"
import type { CommandActions } from "./Flows"
import { adminFlows, baseFlows } from "./Flows"
import { nameOf } from "./registry"
import { debugApiFlows } from "./entries/debug"

/** Every controller call answers with nothing, `snapshot` included. */
const noSnapshot = new Proxy({}, { get: () => () => undefined }) as CommandActions

/** A snapshot that answers, carrying no flags: the flag-off reading. */
const emptySnapshot = new Proxy({}, {
  get: (_, key) => key === "snapshot" ? () => ({}) : () => undefined
}) as CommandActions

const names = (actions: CommandActions): ReadonlyArray<string> =>
  [...baseFlows(actions), ...adminFlows(actions)].map(nameOf)

describe("a snapshot that answers nothing", () => {
  test("builds the registry instead of throwing", () => {
    expect(names(noSnapshot)).toContain("flow.run")
  })

  test("registers exactly what an empty snapshot does, so every flag reads off", () => {
    expect(names(noSnapshot)).toEqual(names(emptySnapshot))
    expect(names(noSnapshot)).not.toContain("plugins")
  })
})

describe("Debug API availability at registration", () => {
  for (const [label, debugApi, hidden] of [
    ["absent provider", undefined, true],
    ["inert provider", () => undefined, true],
    ["disabled provider", { available: () => false }, true],
    ["enabled provider", { available: () => true }, false]
  ] as const) {
    test(label, () => {
      const entries = debugApiFlows({ debugApi } as unknown as CommandActions)
      expect(entries.map(nameOf)).toEqual(["debug-api"])
      expect(entries.map(entry => entry.metadata.hidden)).toEqual([hidden])
      expect(entries.every(entry => entry.binding.descriptor.modelInvocable === false)).toBe(true)
    })
  }
})
