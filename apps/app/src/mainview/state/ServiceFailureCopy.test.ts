import { expect, test } from "bun:test"
import { serviceFailureSentence } from "./ServiceFailureCopy"

test("service failure copy never echoes an unknown, inherited or hostile code or message", () => {
  for (const code of [undefined, "", "toString", "__proto__", "secret-key", "<script>"]) {
    const failure = { class: "infra" as const, code, message: "raw private diagnostic" }
    expect(serviceFailureSentence(failure)).toBe("The operation failed.")
  }
  expect(serviceFailureSentence({ class: "permission", code: "owner_required" })).toBe("Owner access required")
  expect(serviceFailureSentence({ class: "user", code: "host_refused" })).toBe("Key refused")
  expect(serviceFailureSentence({ class: "user", code: "unknown_github_user" })).toBe("Unknown GitHub user")
})
