import { readFileSync } from "node:fs"
import { expect, expectTypeOf, test } from "vitest"
import { z } from "zod"
import {
  type AppBootstrap,
  AppBootstrapSchema,
  type RuntimeCapability,
  RuntimeCapabilitySchema
} from "../src/AppBootstrap.ts"

// A released client contract stays independent of schemas on the candidate.
const released = z.fromJSONSchema(
  JSON.parse(readFileSync(new URL("../contracts/app-bootstrap-v1.schema.json", import.meta.url), "utf8"))
)
const bootstrap = {
  apiVersion: 1,
  host: "cloud",
  version: "1",
  buildSha: "abc",
  capabilities: ["identity", "agent"],
  authFlow: "redirect",
  sandbox: null
}

test("all current producer capabilities and future additions remain consumable by the released client", () => {
  const capabilities = [...RuntimeCapabilitySchema.options, "future.workspace", "future.deploy"]
  const candidate = { ...bootstrap, capabilities, futureMetadata: { enabled: true } }
  expect(released.safeParse(candidate).success).toBe(true)
  expect(AppBootstrapSchema.parse(candidate).capabilities).toEqual(RuntimeCapabilitySchema.options)
})

test("released input acceptance does not widen producer types or decoded capabilities", () => {
  expectTypeOf<AppBootstrap["capabilities"][number]>().toEqualTypeOf<RuntimeCapability>()
  expectTypeOf<string>().not.toExtend<RuntimeCapability>()
  expect(RuntimeCapabilitySchema.safeParse("future.workspace").success).toBe(false)
})

test("the released contract continues to reject structural and API changes", () => {
  for (
    const changed of [
      { apiVersion: 2 },
      { capabilities: ["identity", null] },
      { capabilities: [7] },
      { capabilities: "agent" },
      { host: "future" },
      { authFlow: "future" },
      { sandbox: { platform: "linux", mode: "future" } },
      { buildSha: undefined }
    ]
  ) {
    expect(released.safeParse({ ...bootstrap, ...changed }).success).toBe(false)
    expect(AppBootstrapSchema.safeParse({ ...bootstrap, ...changed }).success).toBe(false)
  }
})
