/**
 * `Fault` is the one classification every failure seam reads: owners register
 * rows, `of` walks a cause chain to the innermost registered one, and
 * `respond` is the one ladder over the classes.
 */
import { describe, expect, it } from "@effect/vitest"
import { Action, ExternalJob, Fault, Flow, HumanTask } from "@smthrs/flow"

const tagged = (tag: string, fields: Record<string, unknown> = {}) => ({ _tag: tag, ...fields })

describe("register and of", () => {
  it("answers one class for a whole tag, with the code in the tag when there is one", () => {
    Fault.register("test/Whole", "infra")
    expect(Fault.of(tagged("test/Whole"))).toEqual({ class: "infra", tag: "test/Whole" })
    expect(Fault.of(tagged("test/Whole", { code: "x" }))).toEqual({ class: "infra", tag: "test/Whole/x" })
  })

  it("answers the row of the code, and bug for a code the table does not name", () => {
    Fault.register("test/Coded", { slow: "wait", broken: "dependency" })
    expect(Fault.of(tagged("test/Coded", { code: "slow" }))).toEqual({ class: "wait", tag: "test/Coded/slow" })
    expect(Fault.of(tagged("test/Coded", { code: "new" }))).toEqual({ class: "bug", tag: "test/Coded/new" })
    expect(Fault.of(tagged("test/Coded", { code: "toString" }))).toEqual({ class: "bug", tag: "test/Coded/toString" })
    expect(Fault.of(tagged("test/Coded"))).toEqual({ class: "bug", tag: "test/Coded" })
  })

  it("reads the field an owner names instead of code", () => {
    Fault.register("test/Reasoned", { unconfigured: "policy" }, "reason")
    expect(Fault.of(tagged("test/Reasoned", { reason: "unconfigured", code: "ignored" })))
      .toEqual({ class: "policy", tag: "test/Reasoned/unconfigured" })
  })

  it("answers the innermost registered tag, because the cause says why", () => {
    Fault.register("test/Wrapper", { model_failed: "dependency" })
    Fault.register("test/Quota", "wait")
    const error = tagged("test/Wrapper", {
      code: "model_failed",
      cause: new Error("plain", { cause: tagged("test/Quota", { code: "quota_exceeded" }) })
    })
    expect(Fault.of(error)).toEqual({ class: "wait", tag: "test/Quota/quota_exceeded" })
    expect(Fault.of(tagged("test/Wrapper", { code: "model_failed", cause: new Error("plain") })))
      .toEqual({ class: "dependency", tag: "test/Wrapper/model_failed" })
  })

  it("is bug and unregistered for anything no owner registered", () => {
    for (const error of [undefined, null, "usage limit reached", 42, new Error("boom"), tagged("test/Nobody")]) {
      expect(Fault.of(error)).toEqual({ class: "bug", tag: "unregistered" })
    }
  })

  it("stops on a cyclic cause and past sixteen links", () => {
    Fault.register("test/Deep", "infra")
    const cyclic: { _tag: string; cause?: unknown } = tagged("test/Nobody")
    cyclic.cause = cyclic
    expect(Fault.of(cyclic)).toEqual({ class: "bug", tag: "unregistered" })
    let chain: unknown = tagged("test/Deep")
    for (let index = 0; index < 16; index++) chain = { cause: chain }
    expect(Fault.of(chain)).toEqual({ class: "bug", tag: "unregistered" })
    let reachable: unknown = tagged("test/Deep")
    for (let index = 0; index < 15; index++) reachable = { cause: reachable }
    expect(Fault.of(reachable)).toEqual({ class: "infra", tag: "test/Deep" })
  })

  it("accepts the same rows twice and refuses a second owner's different rows", () => {
    Fault.register("test/Twice", { a: "wait" })
    expect(() => Fault.register("test/Twice", { a: "wait" })).not.toThrow()
    expect(() => Fault.register("test/Twice", { a: "infra" })).toThrow("already registered")
    expect(() => Fault.register("test/Twice", { a: "wait" }, "reason")).toThrow("already registered")
  })

  it("reads a throwing getter as absent instead of failing the settlement", () => {
    Fault.register("test/Hostile", { x: "infra" })
    const hostile = Object.defineProperty(tagged("test/Hostile"), "code", {
      get: () => {
        throw new Error("boom")
      }
    })
    expect(Fault.of(hostile)).toEqual({ class: "bug", tag: "test/Hostile" })
    const trap = Object.defineProperty(tagged("test/Nobody"), "cause", {
      get: () => {
        throw new Error("boom")
      }
    })
    expect(Fault.of(trap)).toEqual({ class: "bug", tag: "unregistered" })
  })

  it("lists every registered tag", () => {
    Fault.register("test/Listed", "user")
    expect(Fault.registered().has("test/Listed")).toBe(true)
  })
})

describe("the flow's own rows", () => {
  it("classifies the flow errors a run can fail with", () => {
    expect(Fault.of(new Action.InfraInterrupt({})))
      .toEqual({ class: "infra", tag: "@smthrs/flow/InfraInterrupt/infra_interrupt" })
    const rounds = { flowName: "f", lineageId: "l", maxRounds: 3, roundOrdinal: 4, message: "loop" }
    expect(Fault.of(new Flow.MaxRoundsExceeded(rounds)).class).toBe("bug")
    const failed = (code: "rejected" | "timeout" | "request_invalid") =>
      new HumanTask.HumanTaskFailed({ code, task: "t", attempts: 1, rejections: [], message: "m" })
    expect(Fault.of(failed("rejected"))).toEqual({ class: "user", tag: "@smthrs/flow/HumanTaskFailed/rejected" })
    expect(Fault.of(failed("timeout")).class).toBe("factory")
    expect(Fault.of(failed("request_invalid")).class).toBe("bug")
    expect(Fault.of(new ExternalJob.Again({ message: "replacement needed" })).class).toBe("dependency")
    expect(Fault.of(
      new Flow.DeadlineExceeded({
        flowName: "bounded",
        executionId: "expired",
        deadlineMs: 10,
        startedAtMs: 0,
        message: "deadline elapsed"
      })
    )).toEqual({ class: "policy", tag: "@smthrs/flow/DeadlineExceeded/deadline_exceeded" })
  })

  it("classifies an attempt that outlived its bound as a dependency fault", () => {
    const timedOut = new Action.AttemptTimedOut({
      actionName: "a",
      attempt: 1,
      bound: "heartbeat",
      timeoutMs: 5,
      message: "late"
    })
    expect(Fault.of(timedOut)).toEqual({ class: "dependency", tag: "@smthrs/flow/AttemptTimedOut/attempt_timed_out" })
    expect(Fault.registered().has("@smthrs/flow/AttemptTimedOut")).toBe(true)
  })
})

describe("respond", () => {
  const fault = (kind: Fault.Class, tag = "t"): Fault.Fault => ({ class: kind, tag })
  const state = (overrides: Partial<Fault.State> = {}): Fault.State => ({
    attempt: 1,
    seatsLeft: 0,
    parksLeft: 8,
    replans: 0,
    veryHard: false,
    ...overrides
  })

  it("backs up a wait or a dependency while a seat is left", () => {
    expect(Fault.respond(fault("wait"), state({ seatsLeft: 1 }))).toBe("backup")
    expect(Fault.respond(fault("dependency"), state({ seatsLeft: 1 }))).toBe("backup")
  })

  it("parks a wait while parks are left, then stops", () => {
    expect(Fault.respond(fault("wait"), state({ parksLeft: 1 }))).toBe("park")
    expect(Fault.respond(fault("wait"), state({ parksLeft: 0 }))).toBe("stop")
  })

  it("retries a dependency or infra fault for three attempts", () => {
    expect(Fault.respond(fault("dependency"), state({ attempt: 2 }))).toBe("retry")
    expect(Fault.respond(fault("dependency"), state({ attempt: 3 }))).toBe("stop")
    expect(Fault.respond(fault("infra"), state({ attempt: 2 }))).toBe("retry")
    expect(Fault.respond(fault("infra"), state({ attempt: 3 }))).toBe("park")
  })

  it("replans a factory fault twice, continues once as very hard, then asks for help", () => {
    expect(Fault.respond(fault("factory"), state({ replans: 1 }))).toBe("replan")
    expect(Fault.respond(fault("factory"), state({ replans: 2 }))).toBe("very_hard")
    expect(Fault.respond(fault("factory"), state({ replans: 2, veryHard: true }))).toBe("help")
  })

  it("closes only a declined request, and asks the person about every other user fault", () => {
    expect(Fault.respond(fault("user", "coding/Error/declined"), state())).toBe("close")
    expect(Fault.respond(fault("user", "coding/Error/source_missing"), state())).toBe("help")
  })

  it("stops a policy or bug fault whatever the state", () => {
    const generous = state({ seatsLeft: 3, attempt: 1 })
    expect(Fault.respond(fault("policy"), generous)).toBe("stop")
    expect(Fault.respond(fault("bug"), generous)).toBe("stop")
  })
})
