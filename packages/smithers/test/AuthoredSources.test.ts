/**
 * Which native records mean "a flow's entry file changed", and which do not.
 *
 * Getting this wrong is not a cosmetic error. Acting on a capture alone
 * rebuilds a host's catalog from bytes no run ever applied; acting on a path
 * without checking it lets whatever an agent chose to write decide which flow
 * a host reloads. Both are decisions made from evidence, so the evidence is
 * what this suite is about.
 */
import { describe, expect, it } from "vitest"
import * as AuthoredSources from "../src/internal/AuthoredSources.ts"

const captured = (paths: ReadonlyArray<unknown>, overrides: Record<string, unknown> = {}) => ({
  runId: "execution-1",
  eventType: "flows.engine.diff-bundle-captured",
  payload: {
    runId: "execution-1",
    stepKeyDigest: "digest-1",
    attempt: 1,
    bundleIdentity: "bundle-1",
    changedPaths: paths,
    ...overrides
  }
})

const settled = (overrides: Record<string, unknown> = {}) => ({
  runId: "execution-1",
  eventType: "flows.engine.copy-back-settled",
  payload: {
    runId: "execution-1",
    stepKeyDigest: "digest-1",
    attempt: 1,
    bundleIdentity: "bundle-1",
    rebases: 0,
    ...overrides
  }
})

describe("matching a settled copy-back to the bundle it applied", () => {
  it("names the flow only once both halves of the receipt are in", () => {
    const matcher = AuthoredSources.make()
    expect(matcher.observe(captured(["flows/authored/flow.ts"]), 0)).toEqual([])
    expect(matcher.observe(settled(), 0)).toEqual(["authored"])
  })

  it("names nothing for a settlement whose capture never arrived", () => {
    expect(AuthoredSources.make().observe(settled(), 0)).toEqual([])
  })

  it("names nothing when the settled bundle is not the captured one", () => {
    const matcher = AuthoredSources.make()
    matcher.observe(captured(["flows/authored/flow.ts"]), 0)
    expect(matcher.observe(settled({ bundleIdentity: "bundle-2" }), 0)).toEqual([])
  })

  it("names nothing when the settlement belongs to another attempt", () => {
    const matcher = AuthoredSources.make()
    matcher.observe(captured(["flows/authored/flow.ts"]), 0)
    expect(matcher.observe(settled({ attempt: 2 }), 0)).toEqual([])
  })

  it("names nothing when the journal rewound between the two halves", () => {
    const matcher = AuthoredSources.make()
    matcher.observe(captured(["flows/authored/flow.ts"]), 0)
    expect(matcher.observe(settled(), 1)).toEqual([])
  })

  it("consumes the capture, so a rewound settlement cannot replay it", () => {
    const matcher = AuthoredSources.make()
    matcher.observe(captured(["flows/authored/flow.ts"]), 0)
    expect(matcher.observe(settled(), 0)).toEqual(["authored"])
    expect(matcher.observe(settled(), 0)).toEqual([])
  })

  it("reads a nested directory as the nested flow name discovery gives it", () => {
    const matcher = AuthoredSources.make()
    matcher.observe(captured(["flows/coding/request/flow.ts", "flows/skill/SKILL.md", "flows/prompt/flow.mdx"]), 0)
    expect(matcher.observe(settled(), 0)).toEqual(["coding/request", "skill", "prompt"])
  })

  it("names each flow once however many of its files one bundle changed", () => {
    const matcher = AuthoredSources.make()
    matcher.observe(captured(["flows/authored/flow.ts", "flows/authored/SKILL.md"]), 0)
    expect(matcher.observe(settled(), 0)).toEqual(["authored"])
  })

  for (
    const path of [
      "../flows/escape/flow.ts",
      "flows/../../elsewhere/flow.ts",
      "flows//flow.ts",
      "flows/./flow.ts",
      "flows/authored/flow.ts\u0000",
      "flows\\authored\\flow.ts",
      "/flows/absolute/flow.ts",
      "flows/authored/helper.ts",
      "flows/authored/flow.tsx",
      "docs/authored/flow.ts"
    ]
  ) {
    it(`refuses ${JSON.stringify(path)} as a flow to rebuild`, () => {
      const matcher = AuthoredSources.make()
      matcher.observe(captured([path]), 0)
      expect(matcher.observe(settled(), 0)).toEqual([])
    })
  }

  it("ignores a record whose identity fields are not what the engine writes", () => {
    const matcher = AuthoredSources.make()
    matcher.observe(captured(["flows/authored/flow.ts"], { attempt: "1" }), 0)
    expect(matcher.observe(settled(), 0)).toEqual([])
  })

  it("ignores every other native record", () => {
    const matcher = AuthoredSources.make()
    expect(matcher.observe({ ...captured([]), eventType: "flows.engine.node-settled" }, 0)).toEqual([])
    expect(matcher.observe({ runId: "execution-1", eventType: "flows.engine.node-settled", payload: null }, 0))
      .toEqual([])
  })
})

/**
 * What closes a capture that never settled.
 *
 * A matcher lives as long as the observation, which follows a run and every
 * run below it, so a bundle that was proposed and never applied would sit in
 * it until that whole tree ended. The attempt is the boundary: the engine
 * records a settled copy-back inside the attempt that produced it and
 * finishes that attempt after, and a failed attempt returns before the
 * settlement block runs at all.
 */
describe("closing a capture the attempt never applied", () => {
  const finished = (overrides: Record<string, unknown> = {}) => ({
    runId: "execution-1",
    eventType: "flows.engine.attempt-finished",
    payload: { runId: "execution-1", stepKeyDigest: "digest-1", attempt: 1, state: "failed", ...overrides }
  })

  it("drops a capture whose attempt finished, so a later settlement names nothing", () => {
    const matcher = AuthoredSources.make()
    matcher.observe(captured(["flows/authored/flow.ts"]), 0)
    expect(matcher.observe(finished(), 0)).toEqual([])
    expect(matcher.observe(settled(), 0)).toEqual([])
  })

  it("leaves a capture its own attempt has not finished yet", () => {
    const matcher = AuthoredSources.make()
    matcher.observe(captured(["flows/authored/flow.ts"]), 0)
    matcher.observe(finished({ attempt: 2 }), 0)
    expect(matcher.observe(settled(), 0)).toEqual(["authored"])
  })

  it("keeps the other bundles of an attempt that applied one of them", () => {
    const matcher = AuthoredSources.make()
    matcher.observe(captured(["flows/first/flow.ts"]), 0)
    matcher.observe(captured(["flows/second/flow.ts"], { bundleIdentity: "bundle-2" }), 0)
    expect(matcher.observe(settled(), 0)).toEqual(["first"])
    expect(matcher.observe(settled({ bundleIdentity: "bundle-2" }), 0)).toEqual(["second"])
  })

  it("ignores an attempt-finished record whose identity is not what the engine writes", () => {
    const matcher = AuthoredSources.make()
    matcher.observe(captured(["flows/authored/flow.ts"]), 0)
    expect(matcher.observe(finished({ attempt: "1" }), 0)).toEqual([])
    expect(matcher.observe(settled(), 0)).toEqual(["authored"])
  })
})
