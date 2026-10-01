import { describe, expect, it } from "@effect/vitest"
import { Fault } from "@smthrs/flow"
import { Schema } from "effect"
import { ProviderError, ProviderErrorCode } from "../src/RemoteChildProcessSpawner/ProviderError.ts"

const classes = {
  unavailable: "infra",
  timeout: "infra",
  spawn_error: "bug",
  not_found: "bug",
  unknown: "bug",
  aborted: "bug"
} as const satisfies Fault.Rows<ProviderErrorCode>

describe("provider fault registry", () => {
  it("registers every code of the public provider error schema", () => {
    const tag = "@smthrs/sandbox/RemoteChildProcessSpawner/ProviderError"
    expect(Fault.registered().has(tag)).toBe(true)
    for (const [code, expected] of Object.entries(classes)) {
      const validCode = Schema.decodeUnknownSync(ProviderErrorCode)(code)
      const failure = new ProviderError({ code: validCode, message: code })
      expect(Fault.of(failure)).toEqual({ class: expected, tag: `${tag}/${code}` })
    }
  })

  it("keeps the infrastructure cause through a provider wrapper", () => {
    const cause = new ProviderError({ code: "timeout", message: "probe timed out" })
    const failure = new ProviderError({ code: "unknown", message: "SDK failed", cause })
    expect(Fault.of(failure)).toEqual({ class: "infra", tag: `${cause._tag}/timeout` })
  })
})
