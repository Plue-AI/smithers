/**
 * Every tagged error an agent run can fail with has a fault class.
 *
 * The sweep reads the source of each owner package, loads every module that
 * declares a `Schema.TaggedError`, and asserts its tag is registered, so a new
 * error without a row fails here rather than reaching a person as `bug`. The
 * repository flows' errors are swept by `flows/test/coding-fault.test.ts`.
 */
import { describe, expect, it } from "@effect/vitest"
import { Fault } from "@smthrs/flow"
import * as Harness from "@smthrs/harness/HarnessError"
import * as FailureCopy from "@smthrs/model/FailureCopy"
import * as ModelError from "@smthrs/model/ModelError"
import { readdirSync, readFileSync } from "node:fs"
import { join, relative } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import * as Budget from "../src/Budget.ts"
import * as RunawayGuard from "../src/RunawayGuard.ts"
import * as Seat from "../src/Seat.ts"

const smithers = fileURLToPath(new URL("../..", import.meta.url))
const owners = ["flows/flow/src", "agent/model/src", "agent/harness/src", "agent/src", "control/src"]

const files = (directory: string): ReadonlyArray<string> =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : entry.name.endsWith(".ts") && !entry.name.endsWith(".d.ts")
      ? [join(directory, entry.name)]
      : []
  )

const declared = owners.flatMap((owner) =>
  files(join(smithers, owner)).flatMap((file) => {
    const source = readFileSync(file, "utf8")
    // `TaggedError<X>()("tag", …)` or `TaggedError<X>("identifier")("tag", …)`.
    return [...source.matchAll(/TaggedError<\w+>\((?:\s*"[^"]*"\s*)?\)\(\s*(?:"([^"]+)"|(\w+))/g)].map((match) => {
      const constant = match[2] === undefined
        ? undefined
        : new RegExp(`const ${match[2]} = "([^"]+)"`).exec(source)?.[1]
      return { file, tag: match[1] ?? constant }
    })
  })
)

describe("the fault sweep", () => {
  it("finds the owners' errors, including one tagged through a constant", () => {
    const tags = declared.map((entry) => entry.tag)
    expect(declared.length).toBeGreaterThan(40)
    expect(tags).toContain("flows/model/ModelError")
    expect(tags).toContain("/harness/HarnessError")
    expect(tags).toContain(Budget.skippedTag)
    expect(tags).toContain("InvalidStep")
    expect(tags).toContain("/control/LaunchFailed")
    expect(declared.filter((entry) => entry.tag === undefined)).toEqual([])
  })

  it("registers a class for every tagged error an owner declares", async () => {
    for (const file of new Set(declared.map((entry) => entry.file))) await import(pathToFileURL(file).href)
    const registered = Fault.registered()
    const missing = declared
      .filter((entry) => !registered.has(entry.tag!))
      .map((entry) => `${relative(smithers, entry.file)}: ${entry.tag}`)
    expect(missing).toEqual([])
  })
})

describe("the owners' classes", () => {
  it("classifies unfinished work as factory failure and keeps recovery bounded", () => {
    const report = "I could not finish because access was denied."
    const fault = Fault.of(new Harness.HarnessError({ code: "completion_incomplete", message: report }))
    expect(fault).toEqual({ class: "factory", tag: "/harness/HarnessError/completion_incomplete" })
    const state = { attempt: 1, seatsLeft: 2, parksLeft: 8, replans: 0, veryHard: false }
    expect(Fault.respond(fault, state)).toBe("replan")
    expect(Fault.respond(fault, { ...state, replans: 1 })).toBe("replan")
    expect(Fault.respond(fault, { ...state, replans: 2 })).toBe("very_hard")
    expect(Fault.respond(fault, { ...state, replans: 2, veryHard: true })).toBe("help")
  })

  it("reads a quota failure under a harness wrapper as a wait, not a dependency", () => {
    const quota = new ModelError.ModelError({ code: "quota_exceeded", message: "limit" })
    const wrapped = new Harness.HarnessError({ code: "model_failed", message: "model", cause: quota })
    expect(Fault.of(wrapped)).toEqual({ class: "wait", tag: "flows/model/ModelError/quota_exceeded" })
  })

  it("hands spent hosted credit to the person, since waiting never refills it", () => {
    const credit = new ModelError.ModelError({ code: "out_of_credit", message: "no credit" })
    const wrapped = new Harness.HarnessError({ code: "model_failed", message: "model", cause: credit })
    expect(Fault.of(wrapped)).toEqual({ class: "user", tag: "flows/model/ModelError/out_of_credit" })
  })

  it("blames the factory, never the person, for a request our agent built", () => {
    expect(Fault.of(new ModelError.ModelError({ code: "invalid_request", message: "bad" })).class).toBe("factory")
    expect(Fault.of(new ModelError.ModelError({ code: "context_overflow", message: "full" })).class).toBe("factory")
    expect(Fault.of(new Harness.HarnessError({ code: "claim_unproven", message: "no proof" })).class).toBe("factory")
    expect(Fault.of(new Harness.HarnessError({ code: "read_only_cap", message: "read only" })).class).toBe("factory")
  })

  it("calls a spent cap policy, at the refusal and at a later skipped step", () => {
    const exceeded = new Budget.BudgetExceeded({
      scope: "tokens",
      onExceeded: "fail",
      used: 11,
      max: 10,
      next: 1,
      message: "cap"
    })
    expect(Fault.of(exceeded).class).toBe("policy")
    expect(Fault.of(new Budget.Skipped({ budget: exceeded, message: "skipped" })).class).toBe("policy")
  })

  it("gives FailureCopy the owners' class for a harness or budget failure it words", () => {
    const exceeded = new Budget.BudgetExceeded({
      scope: "daily",
      onExceeded: "fail",
      used: 2100,
      max: 2000,
      next: 1,
      message: "cap"
    })
    expect(FailureCopy.describe(new Harness.HarnessError({ code: "model_failed", message: "m", cause: exceeded })))
      .toMatchObject({ headline: "Daily token cap reached", fault: "policy" })
    expect(FailureCopy.describe(new Harness.HarnessError({ code: "engine_failed", message: "raw" })))
      .toMatchObject({ headline: "Worker engine stopped", fault: "infra" })
  })

  it("reads an operator's Stop as a stop, never as the model wrapper around it", () => {
    const stop = RunawayGuard.stopped({ classification: "Stuck", source: "cell", message: "ran past 60 s" })
    expect(Fault.of(stop)).toEqual({ class: "policy", tag: RunawayGuard.stoppedTag })
    expect(Fault.respond(Fault.of(stop), { attempt: 1, seatsLeft: 2, parksLeft: 8, replans: 0, veryHard: false }))
      .toBe("stop")
  })

  it("asks the person to sign in for an unresolved seat, and reads a routing failure by its reason", () => {
    expect(Fault.of(new Seat.SeatUnresolved({ seat: "anthropic:x", message: "login" })).class).toBe("user")
    const unrouted = (reason: Seat.SeatUnrouted["reason"]) =>
      Fault.of(new Seat.SeatUnrouted({ seat: "auto", reason, message: "m" }))
    expect(unrouted("unconfigured")).toEqual({ class: "policy", tag: "@smthrs/agent/Seat/SeatUnrouted/unconfigured" })
    expect(unrouted("unreachable").class).toBe("dependency")
    expect(unrouted("no_candidates").class).toBe("factory")
    expect(unrouted("invalid_question").class).toBe("bug")
  })
})
