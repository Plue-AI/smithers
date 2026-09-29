import { expect, test } from "bun:test"
import * as Fault from "@smthrs/flow/Fault"
import { HarnessError, HarnessErrorCode } from "@smthrs/harness/HarnessError"
import { ModelError, ModelErrorCode } from "@smthrs/model/ModelError"
import { REFUSAL_COPY } from "@smthrs/rpc/RefusalCopy"
import { runCause } from "./RunCause"

const harness = (code: string) => `/harness/HarnessError/${code}`
const model = (code: string) => `flows/model/ModelError/${code}`
const MODEL_WORDED = ModelErrorCode.literals.filter((code) => runCause(`flows/model/ModelError/${code}`) !== undefined)

test("every harness code and the model's worded codes read as their own sentence", () => {
  expect(MODEL_WORDED).toHaveLength(10)
  const said = [...HarnessErrorCode.literals.map(harness), ...MODEL_WORDED.map(model)].map((tag) => runCause(tag))
  expect(said.every((sentence) => sentence !== undefined)).toBe(true)
  expect(new Set(said).size).toBe(said.length)
  for (const sentence of said) expect(sentence).not.toBe(REFUSAL_COPY.infra.lead)
})

test("a code is worded only under its own author, so another vocabulary's spelling reads as its class", () => {
  for (
    const tag of [
      "@smthrs/jj/JjError/unknown",
      "coding/Error/invalid_request",
      "@smthrs/std/StdError/rate_limited",
      "coding/NativeCodingError/transport",
      "model_failed",
      "unregistered",
      ""
    ]
  ) expect(runCause(tag)).toBeUndefined()
  expect(runCause(model("model_failed"))).toBeUndefined()
  expect(runCause(harness("no_route"))).toBeUndefined()
})

test("no sentence a person reads carries a code, an internal id, or a thrown message", () => {
  for (const tag of [...HarnessErrorCode.literals.map(harness), ...MODEL_WORDED.map(model)]) {
    const sentence = runCause(tag)!
    expect(sentence).not.toMatch(/[a-z]_[a-z]/)
    expect(sentence).not.toMatch(/\b(run-|Error|Exception|undefined|null|session ")/)
    expect(sentence.endsWith(".")).toBe(true)
  }
})

test("a sentence agrees with its registered class: the person's names an act, every other says not your fault", () => {
  const cases = [
    ...HarnessErrorCode.literals.map((code) => [harness(code), new HarnessError({ code, message: "m" })] as const),
    ...MODEL_WORDED.map((code) => [model(code), new ModelError({ code: code as never, message: "m" })] as const)
  ]
  for (const [tag, error] of cases) {
    const fault = Fault.of(error)
    expect(fault.tag).toBe(tag)
    if (fault.class === "user") expect(runCause(tag)).not.toContain("Not your")
    else expect(runCause(tag)).toContain("Not your")
  }
})
