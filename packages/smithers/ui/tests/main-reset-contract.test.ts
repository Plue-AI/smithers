import { describe, expect, test as it } from "bun:test"
import { Schema } from "effect"
import { pendingControls } from "../src/app-operations/controls"

const reset = pendingControls.find(operation => operation.name === "main.reset-to-github")!
const binding = { id: "force-19", old: "1".repeat(40), new: "2".repeat(40) }

describe("main reset contract", () => {
  it("binds the stored attention and both tips in the shared catalog", () => {
    expect(reset).toMatchObject({ agent: "never", minimumRole: "owner", actors: ["person"], visibility: "in-card", http: { method: "POST", path: "/api/stack/attention/{id}", body: { old: "old", new: "new" } } })
    expect(Schema.decodeUnknownSync(reset.input)(binding)).toEqual(binding)
  })
  it("refuses incomplete, malformed and superseded revision-only inputs", () => {
    for (const input of [{ revision: "old-revision" }, { ...binding, id: "" }, { ...binding, old: "abc" }, { ...binding, new: "-bad" }, { id: binding.id, old: binding.old }]) {
      expect(() => Schema.decodeUnknownSync(reset.input)(input)).toThrow()
    }
  })
})
