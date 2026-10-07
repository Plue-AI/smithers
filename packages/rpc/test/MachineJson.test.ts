import { expect, test } from "vitest"
import { addImagePackage, MachineJsonRejected } from "../src/MachineJson.ts"

test("preserves order and proposes only machine.json", () => {
  const result = addImagePackage("{\"packages\":[\"git\",\"g++\"]}", "figlet")
  expect(JSON.parse(result.next)).toEqual({ packages: ["git", "g++", "figlet"] })
  expect(result.diff.split("\n").filter((line) => line.startsWith("---") || line.startsWith("+++"))).toEqual([
    "--- a/.smithers/machine.json",
    "+++ b/.smithers/machine.json"
  ])
  expect(addImagePackage(undefined, "figlet").diff).toContain("--- /dev/null\n+++ b/.smithers/machine.json")
})
test("refuses duplicate, a 65th name, invalid names and malformed declarations", () => {
  expect(() => addImagePackage("{\"packages\":[\"figlet\"]}", "figlet")).toThrow("already present")
  expect(() => addImagePackage(JSON.stringify({ packages: Array.from({ length: 64 }, (_, n) => `p${n}`) }), "figlet"))
    .toThrow("64")
  for (const name of ["Fig Let", "", "a".repeat(129), "git;id", "git\n"]) {
    expect(() => addImagePackage(null, name)).toThrow()
  }
  for (
    const current of [
      "[]",
      "null",
      "{\"packages\":null}",
      "{\"packages\":[1]}",
      "{\"packages\":[],\"command\":\"id\"}",
      "{\"packages\":[],\"packages\":[\"git\"]}",
      "{\"packages\":[],\"\\u0070ackages\":[\"git\"]}"
    ]
  ) expect(() => addImagePackage(current, "figlet")).toThrow()
  expect(JSON.parse(addImagePackage("{}", "a".repeat(128)).next).packages).toHaveLength(1)
})

test.each([
  [null, "", "invalid_name"],
  ["{", "git", "invalid_json"],
  ["null", "git", "invalid_document"],
  ["{\"packages\":[1]}", "git", "invalid_packages"],
  ["{\"packages\":[\"git\"]}", "git", "duplicate_package"],
  [JSON.stringify({ packages: Array.from({ length: 64 }, (_, n) => `p${n}`) }), "git", "package_limit"]
])("reports a tagged refusal for %s / %s", (current, name, code) => {
  expect(() => addImagePackage(current, name!)).toThrow(MachineJsonRejected)
  expect(() => addImagePackage(current, name!)).toThrow(expect.objectContaining({ _tag: "MachineJsonRejected", code }))
})
