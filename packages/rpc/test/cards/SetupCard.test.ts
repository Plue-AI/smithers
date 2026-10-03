/**
 * Behavioral projection contract checks for Setup.
 * @since 1.0.0
 */

import { describe, expect, test } from "vitest"
import { ActionSchema } from "../../src/CardAction.ts"
import { SetupCardSchema } from "../../src/SetupCard.ts"
import { cardContract } from "../cardContract.ts"
import { fixtures, personOnlyFixtures } from "../fixtures/Setup.ts"

cardContract("Setup", SetupCardSchema, { ...fixtures, ...personOnlyFixtures })

// Literal oracles: spec §16.2 step order, T-INS-06 states and mvp.md §6.5 model roles; never read from the schema.
const STEP_IDS = ["address", "app_manifest", "sign_in", "repository", "models", "source", "machine"] as const
const STEP_STATES = ["pending", "running", "done", "blocked", "failed"] as const
const MODEL_ROLES = ["fast", "coding", "jev"] as const
const KEY_STATES = ["none", "validating", "saved", "failed"] as const
const done = fixtures.done.model
const withStep = (index: number, patch: Record<string, unknown>) => ({
  ...done,
  steps: done.steps.map((step, at) => (at === index ? { ...step, ...patch } : step))
})

describe("Setup steps", () => {
  test("lists all seven steps in §16.2 order", () => {
    expect(SetupCardSchema.parse(done).steps.map((step) => step.id)).toEqual([...STEP_IDS])
  })
  test("refuses a missing, extra or reordered step", () => {
    expect(SetupCardSchema.safeParse({ ...done, steps: done.steps.slice(1) }).success).toBe(false)
    expect(SetupCardSchema.safeParse({ ...done, steps: [...done.steps, done.steps[0]] }).success).toBe(false)
    const swapped = [done.steps[1], done.steps[0], ...done.steps.slice(2)]
    expect(SetupCardSchema.safeParse({ ...done, steps: swapped }).success).toBe(false)
  })
  test.each(["app", "github_app", "repo_owner", "squash", ""])("refuses step id %j", (id) => {
    expect(SetupCardSchema.safeParse(withStep(1, { id })).success).toBe(false)
  })
  test.each(STEP_STATES)("accepts step state %s", (state) => {
    expect(SetupCardSchema.parse(withStep(6, { state })).steps[6]!.state).toBe(state)
  })
  test.each(["next", "active", "waiting", "Done", ""])("refuses step state %j", (state) => {
    expect(SetupCardSchema.safeParse(withStep(6, { state })).success).toBe(false)
  })
  test("stories show every step state, a blocked fix link and a failed step's error", () => {
    const steps = Object.values(fixtures).flatMap((story) => story.model.steps)
    expect([...new Set(steps.map((step) => step.state))].sort()).toEqual([...STEP_STATES].sort())
    expect(steps.find((step) => step.state === "blocked")?.blocked).toEqual({
      line: "Enable squash merging on GitHub ↗",
      fix_url: "https://github.com/smithersai/smithers/settings"
    })
    expect(steps.find((step) => step.id === "machine" && step.state === "failed")?.error).toEqual({
      class: "disk_full",
      message: "Free disk space"
    })
  })
  test("a failed step offers Retry and a blocked step offers only its fix link", () => {
    expect(fixtures.machine_failed.actions.map((action) => [action.label, action.args])).toEqual([
      ["Retry", { step: "machine" }]
    ])
    expect(fixtures.squash_blocked.actions).toEqual([])
  })
  test("progress stays within zero to one hundred", () => {
    for (const pct of [0, 0.5, 100, -0.001, 100.001, NaN, Infinity]) {
      expect(SetupCardSchema.safeParse(withStep(5, { state: "running", pct })).success).toBe(pct >= 0 && pct <= 100)
    }
  })
  test.each(["javascript:alert(1)", "data:text/html,unsafe", "file:///etc/passwd", "ftp://example.com"])(
    "refuses unsafe links %s",
    (url) => {
      expect(SetupCardSchema.safeParse({ ...done, address: { ...done.address, origins: [url] } }).success).toBe(false)
      expect(
        SetupCardSchema.safeParse(withStep(3, { state: "blocked", blocked: { line: "Fix", fix_url: url } })).success
      )
        .toBe(false)
    }
  )
})

describe("Setup models", () => {
  test("lists fast, coding and jev once each, in order", () => {
    expect(SetupCardSchema.parse(done).models.map((model) => model.role)).toEqual([...MODEL_ROLES])
    expect(SetupCardSchema.safeParse({ ...done, models: done.models.slice(0, 2) }).success).toBe(false)
    expect(SetupCardSchema.safeParse({ ...done, models: [...done.models].reverse() }).success).toBe(false)
  })
  test.each(["gateway", "app", "Jev", ""])("refuses model role %j", (role) => {
    expect(
      SetupCardSchema.safeParse({ ...done, models: [done.models[0], done.models[1], { ...done.models[2], role }] })
        .success
    ).toBe(false)
  })
  test.each(KEY_STATES)("accepts key state %s", (key) => {
    const models = done.models.map((model) => ({ ...model, key }))
    expect(SetupCardSchema.parse({ ...done, models }).models.map((model) => model.key)).toEqual([key, key, key])
  })
  test.each(["missing", "valid", "rejected", ""])("refuses key state %j", (key) => {
    expect(
      SetupCardSchema.safeParse({ ...done, models: [{ ...done.models[0], key }, ...done.models.slice(1)] }).success
    )
      .toBe(false)
  })
  test("each role keeps its own key state and error", () => {
    expect(SetupCardSchema.parse(fixtures.models_failed.model).models).toEqual([
      { role: "fast", provider: "Cerebras", key: "saved" },
      { role: "coding", provider: "OpenAI", key: "saved" },
      { role: "jev", provider: "AI Gateway", key: "failed", error: "401 from the gateway" }
    ])
  })
})

describe("Setup capacity", () => {
  test("capacity 0 names the limiting term and its fix", () => {
    expect(SetupCardSchema.parse(fixtures.no_capacity.model).this_mac).toEqual({
      memory_gb: 8,
      disk_free_gb: 18,
      capacity: 0,
      limit: { term: "memory", fix: { tag: "settings", label: "Close apps to free 6 GB", args: { step: "machine" } } }
    })
  })
  test("capacity is a non-negative whole number", () => {
    for (const capacity of [0, 3, -1, 0.5]) {
      expect(SetupCardSchema.safeParse({ ...done, this_mac: { ...done.this_mac, capacity } }).success).toBe(
        capacity === 0 || capacity === 3
      )
    }
  })
})

describe("Setup fix and person-only key retry", () => {
  test.each(["", "arbitrary.command", "/settings"])("rejects fix tag %j", (tag) => {
    const model = fixtures.no_capacity.model
    const fix = { ...model.this_mac.limit!.fix, tag }
    expect(
      SetupCardSchema.safeParse({
        ...model,
        this_mac: { ...model.this_mac, limit: { term: "memory", fix } }
      }).success
    ).toBe(false)
  })
  test("rejects the old prose fix and non-string bound args", () => {
    const model = fixtures.no_capacity.model
    for (const fix of ["Close apps to free 6 GB", { tag: "settings", label: "Fix", args: { step: 1 } }]) {
      expect(
        SetupCardSchema.safeParse({
          ...model,
          this_mac: { ...model.this_mac, limit: { term: "memory", fix } }
        }).success
      ).toBe(false)
    }
  })
  test.each(["password", "hidden", "Secret", ""])("rejects retry input kind %j", (kind) => {
    const action = fixtures.models_failed.actions[0]!
    expect(
      ActionSchema.safeParse({
        ...action,
        input: [{ ...action.input![0], kind }]
      }).success
    ).toBe(false)
  })
  test("the person retries with an unfilled secret; agents receive no form", () => {
    expect(fixtures.models_failed.actions).toEqual([{
      tag: "settings.model-key",
      label: "Retry",
      primary: true,
      args: { role: "jev", provider: "AI Gateway" },
      input: [{ name: "key", label: "AI Gateway key", kind: "secret", required: true }]
    }])
    expect(personOnlyFixtures.models_failed_agent.actions).toEqual([])
    for (const story of Object.values(fixtures)) {
      for (const action of story.actions) {
        for (const field of action.input ?? []) {
          if (field.kind === "secret") expect(field).not.toHaveProperty("value")
        }
      }
    }
  })
})
