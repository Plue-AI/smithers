import { describe, expect, test } from "bun:test"
import * as Suite from "./suite.ts"

describe("runLabel", () => {
  test("keeps a plain label and refuses one that leaves results/", () => {
    expect(Suite.runLabel("before-v2.1")).toBe("before-v2.1")
    for (const bad of ["../../x", "a/b", "..", ".", "", "a\\\\b"]) expect(() => Suite.runLabel(bad)).toThrow()
  })
})
