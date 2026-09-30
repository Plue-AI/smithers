import { describe, expect, test } from "vitest"
import { PLUE_FAILURES, PLUE_FAULTS } from "../src/PlueFailureCodes.ts"
import type { PlueFailureCode } from "../src/PlueFailureCodes.ts"
import { clientRefusal, mayAutoRetry, refusalFromStored, refusalOf } from "../src/Refusal.ts"
import {
  agentFaultNote,
  agentRefusalText,
  INFRA_NOT_YOUR_FAULT,
  leadingRefusal,
  NOTHING_ANSWERED,
  REFUSAL_COPY,
  refusalCopy,
  refusalDoors,
  refusalLead,
  refusalLine,
  refusalSentence,
  refusalUserFailure
} from "../src/RefusalCopy.ts"
import { WORKER_FAILURE_CODES, WORKER_FAILURES } from "../src/WorkerFailureCodes.ts"
import type { WorkerFailureCode } from "../src/WorkerFailureCodes.ts"
import { workerRefusal } from "./refusalFixtures.ts"

/** A refusal exactly as plue answers for this code, through its own registry row. */
const forCode = (code: PlueFailureCode, message = "plue's own words") =>
  refusalOf({ body: { code, fault: PLUE_FAILURES[code].fault }, status: PLUE_FAILURES[code].status, message })

/** Every code plue calls `infra`, read off the vendored registry rather than listed here. */
const INFRA_CODES = (Object.keys(PLUE_FAILURES) as ReadonlyArray<PlueFailureCode>).filter(
  (code) => PLUE_FAILURES[code].fault === "infra"
)

/**
 * The infra codes that really are a shortage of infra — the only ones licensed
 * to say we ran out and to point at @fucory.
 *
 * Written out rather than derived, because "is this a capacity shortage?" is a
 * fact about the failure and not about anything in the row. A code plue adds
 * is NOT on this list, which is the safe default: it must earn the sentence.
 */
const CAPACITY_CODES: ReadonlyArray<PlueFailureCode> = ["no_capacity"]

describe("legacy and empty-message copy units", () => {
  test("a legacy never-answered refusal names the connection and offers only retry", () => {
    const refusal = refusalFromStored({ status: 0, message: "Load failed" })
    expect(refusalSentence(refusal)).toBe(
      "Load failed. Nothing answered at all — that's the connection, not something you did. Try it again."
    )
    expect(refusalDoors(refusal)).toEqual(["retry"])
  })

  test.each([
    {
      status: 400,
      message: "Change the request",
      doors: ["retry"],
      sentence: "Change the request. Smithers can't do that as asked."
    },
    {
      status: 409,
      message: "Transition unavailable",
      doors: ["retry", "resume"],
      sentence: "Transition unavailable. Smithers can't do that as asked."
    },
    {
      status: 409,
      message: "Already stopped!",
      doors: ["retry", "resume"],
      sentence: "Already stopped! Smithers can't do that as asked."
    },
    { status: 400, message: "  \n\t", doors: ["retry"], sentence: "Smithers can't do that as asked." }
  ])(
    "uncoded HTTP $status preserves the public sentence and doors for '$message'",
    ({ status, message, doors, sentence }) => {
      const refusal = refusalOf({ status, body: {}, message })
      expect(refusalSentence(refusal)).toBe(sentence)
      expect(refusalDoors(refusal)).toEqual(doors)
    }
  )

  test("a recognized conflict's stated doors do not acquire the uncoded Resume fallback", () => {
    const refusal = refusalOf({ status: 409, body: { code: "conflict" }, message: "Conflict" })
    expect(refusalDoors(refusal)).toEqual(["retry"])
    expect(refusalSentence(refusal)).toBe("conflict — Conflict. Smithers can't do that as asked.")
  })

  test("an empty client message still gives the connection explanation without a stray separator", () => {
    const refusal = clientRefusal(new Error("Internal details"), "")
    expect(refusalSentence(refusal)).toBe(
      "Nothing answered at all — that's the connection, not something you did. Try it again."
    )
    expect(refusalDoors(refusal)).toEqual(["retry"])
  })

  test("a coded empty message preserves its code without inserting punctuation", () => {
    const refusal = forCode("no_capacity", " \n\t ")
    expect(refusalSentence(refusal)).toBe(
      "no_capacity — This is not your fault — Smithers ran out of infra. Yell at @fucory to buy more."
    )
    expect(refusalDoors(refusal)).toEqual(["retry", "report"])
  })
})

/**
 * The infra codes a Retry can never satisfy: nothing changes until Smithers
 * ships, migrates, or the reader opens a different box. Offering them a Retry
 * button is a door onto a wall, and telling the model to suggest one is worse.
 */
const TERMINAL_UNTIL_WE_SHIP: ReadonlyArray<PlueFailureCode> = [
  "authentication_not_configured",
  "coding_gateway_not_configured",
  "coding_host_unavailable",
  "coding_reporter_upgrade_required",
  "coding_unsupported_jj",
  "desktop_tools_unavailable",
  "environment_image_unavailable",
  "feature_not_enabled",
  "secret_delivery_unavailable"
]

describe("the copy table", () => {
  test("every fault has a row, and every row says something", async () => {
    for (const fault of PLUE_FAULTS) {
      const row = REFUSAL_COPY[fault]
      expect(row.lead, fault).not.toBe("")
      expect(row.agent, fault).toContain(`fault=${fault}`)
    }
    expect(Object.keys(REFUSAL_COPY).sort()).toEqual([...PLUE_FAULTS].sort())
  })

  test("every one of plue's codes resolves to a lead line and an agent sentence", async () => {
    // The exhaustiveness that matters at runtime: the table is keyed by fault,
    // so a code plue adds is covered the moment it has a registry row — and a
    // code whose fault somehow has no row would surface here rather than as a
    // blank line in front of a user.
    for (const code of Object.keys(PLUE_FAILURES) as ReadonlyArray<PlueFailureCode>) {
      const copy = refusalCopy(forCode(code))
      expect(copy.lead, code).not.toBe("")
      expect(copy.agent, code).not.toBe("")
    }
  })

  test("a busy build cache is a wait with a stated pace, never the caller's request to change", async () => {
    // plue's build cache refuses with 429 when the CACHE is at its own
    // concurrency ceiling, not the caller's budget. The Worker proxy forwards
    // `code` and `retry_after` but drops `fault`, so a build that predates the
    // code guesses from the status and tells the reader to change a request
    // that works unchanged a second later.
    expect(PLUE_FAILURES.build_cache_busy).toEqual({ fault: "wait", status: 429, retryAfter: 1 })
    const refusal = refusalOf({
      body: { code: "build_cache_busy", retry_after: 1 },
      status: 429,
      message: "build cache is busy"
    })
    expect(refusal.code).toBe("build_cache_busy")
    expect(refusal.fault).toBe("wait")
    expect(refusal.origin).toBe("plue")
    expect(mayAutoRetry(refusal)).toBe(true)
    expect(refusalLead(refusal)).toBe(REFUSAL_COPY.wait.lead)
    expect(refusalDoors(refusal)).toEqual(["retry"])
    expect(agentRefusalText(refusal)).toContain("fault=wait")
    expect(agentRefusalText(refusal)).not.toContain("@fucory")
  })

  test("a contended control transaction says nothing changed and paces the re-ask, instead of the generic infra line that forbids one", async () => {
    // plue paces this one itself (503, retry_after 2) and its doc says the
    // identical request works once the contention clears. The default infra
    // copy says the opposite — "do not retry it on a timer" — so the reader
    // and the model are both told to stop at a refusal that clears itself.
    expect(PLUE_FAILURES.sandbox_control_busy).toEqual({ fault: "infra", status: 503, retryAfter: 2 })
    const refusal = forCode("sandbox_control_busy", "control transaction contended")
    const copy = refusalCopy(refusal)
    expect(copy.lead).not.toBe(REFUSAL_COPY.infra.lead)
    expect(copy.lead.toLowerCase()).toContain("not your fault")
    expect(copy.lead.toLowerCase()).toContain("nothing changed")
    expect(copy.agent).not.toContain("do not retry it on a timer")
    expect(copy.agent.toLowerCase()).toContain("worth asking again")
    expect(refusalDoors(refusal)).toEqual(["retry"])
  })

  test("each fault renders its own lead line", async () => {
    const leads = PLUE_FAULTS.map((fault) => REFUSAL_COPY[fault].lead)
    expect(new Set(leads).size).toBe(PLUE_FAULTS.length)
  })
})

describe("the infra line", () => {
  test("appears for no_capacity, names @fucory, and says it is not the user's fault", async () => {
    const lead = refusalLead(forCode("no_capacity", "no sandbox slots are free"))
    expect(lead).toBe(INFRA_NOT_YOUR_FAULT)
    expect(lead).toContain("not your fault")
    expect(lead).toContain("@fucory")
    expect(lead).toContain("infra")
  })

  test("does NOT appear for quota_exceeded — that one is the account's own cap", async () => {
    const refusal = forCode("quota_exceeded", "you already have 5 boxes running")
    expect(refusal.fault).toBe("user")
    expect(refusalLead(refusal)).not.toContain("@fucory")
    expect(refusalLead(refusal)).not.toBe(INFRA_NOT_YOUR_FAULT)
    expect(agentRefusalText(refusal)).not.toContain("@fucory")
    expect(agentRefusalText(refusal)).toContain("Never tell them it is not their fault")
  })

  /*
   * This used to read "@fucory appears iff the fault is infra", which quietly
   * required every infra code to claim a capacity shortage. Most of them are
   * one; `desktop_tools_unavailable` is not — nothing is full, an image is
   * old — and the iff forced that refusal to say we ran out. The half of the
   * ruling that is always true is kept and now checked on EVERY infra lead:
   * say plainly whose fault it is. The claim about the fleet is checked in the
   * other direction, so no refusal outside a real shortage can borrow it.
   */
  test("every infra lead says plainly it is not the reader's fault", async () => {
    for (const code of INFRA_CODES) {
      expect(refusalLead(forCode(code)).toLowerCase(), code).toContain("not your fault")
    }
  })

  /*
   * The other half of the ruling, and the half that was only ever checked on a
   * handful of codes: the sentence has to be TRUE. "Smithers ran out of infra"
   * is a claim about a shortage, and a shortage is what exactly one of plue's
   * codes reports. The other twenty are a deployment that was never migrated, a
   * box on an old image, a component that is not answering — nothing is full in
   * any of them, and pointing the reader at @fucory to buy more sends them
   * after a problem that does not exist.
   */
  test("only a genuine shortage claims we ran out, or names @fucory", async () => {
    for (const code of INFRA_CODES) {
      const lead = refusalLead(forCode(code))
      const claims = lead.includes("@fucory") || lead.includes("ran out")
      expect(claims, code).toBe(CAPACITY_CODES.includes(code))
    }
  })

  /* And the model is told the same thing, in as many words, on every one of them. */
  test("a non-capacity infra code forbids the capacity claim to the model", async () => {
    for (const code of INFRA_CODES) {
      if (CAPACITY_CODES.includes(code)) continue
      const agent = refusalCopy(forCode(code)).agent
      expect(agent.toLowerCase(), code).toContain("do not say smithers ran out of infra")
      expect(agent, code).not.toContain("@fucory")
    }
  })

  /* The Worker's own infra refusals are not a shortage either, and say so. */
  test("the Worker's infra codes forbid it too", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      if (WORKER_FAILURES[code].fault !== "infra") continue
      const refusal = await workerRefusal(code, "the Worker's own words")
      expect(refusalLead(refusal).toLowerCase(), code).toContain("not your fault")
      expect(refusalLead(refusal), code).not.toContain("@fucory")
      expect(refusalCopy(refusal).agent.toLowerCase(), code).toContain("do not say smithers ran out of infra")
    }
  })

  /*
   * A door that cannot open. `retry` is the human's re-ask button, and on these
   * codes the re-ask fails identically until Smithers ships something or the
   * reader opens a different box — plue says so in the registry doc itself
   * ("Retrying does not help until the deployment is migrated", "terminal for
   * that box"). The lead has to say so instead of offering the button.
   */
  test("no infra refusal offers a Retry that cannot work", async () => {
    for (const code of TERMINAL_UNTIL_WE_SHIP) {
      expect(PLUE_FAILURES[code].fault, code).toBe("infra")
      expect(refusalDoors(forCode(code)), code).not.toContain("retry")
      expect(refusalCopy(forCode(code)).agent.toLowerCase(), code).toContain("fails identically")
    }
  })

  /* The inverse: where plue itself paces a re-ask, the button has to be there. */
  test("a paced infra refusal offers the Retry plue asked for", async () => {
    for (const code of INFRA_CODES) {
      if (PLUE_FAILURES[code].retryAfter === 0) continue
      expect(refusalDoors(forCode(code)), code).toContain("retry")
    }
  })

  /* No infra refusal is a dead end: something is always offered. */
  test("every infra refusal offers at least one door", async () => {
    for (const code of INFRA_CODES) {
      expect(refusalDoors(forCode(code)).length, code).toBeGreaterThan(0)
    }
  })

  test("no code outside infra claims we ran out", async () => {
    for (const code of Object.keys(PLUE_FAILURES) as ReadonlyArray<PlueFailureCode>) {
      if (PLUE_FAILURES[code].fault === "infra") continue
      const lead = refusalLead(forCode(code))
      expect(lead, code).not.toContain("@fucory")
      expect(lead, code).not.toContain("ran out")
    }
  })

  /*
   * The two refusals that are ours and are NOT a shortage: a box whose image
   * predates the desktop helpers, and a deployment with no image registered
   * for a kind. Both are plue's rollout lag (both answer 409 `infra` since
   * plue a695bed7), and both were told, by the iff above, to say we ran out.
   */
  test("does NOT appear for our own rollout lag — nothing is full, an image is old", async () => {
    for (const code of ["desktop_tools_unavailable", "environment_image_unavailable"] as const) {
      expect(PLUE_FAILURES[code].fault, code).toBe("infra")
      const lead = refusalLead(forCode(code))
      expect(lead, code).not.toContain("@fucory")
      expect(lead, code).not.toContain("ran out")
      expect(lead, code).not.toBe(INFRA_NOT_YOUR_FAULT)
      expect(lead.toLowerCase(), code).toContain("not your fault")
    }
  })

  /*
   * The line says one thing — our fleet is full and somebody has to buy more.
   * A fetch that never got an answer is `infra` by fault, because nobody
   * judged the request, but it is not that failure and we are in no position
   * to claim it is: nothing answered, so nothing is known about the fleet.
   */
  test("does NOT appear for a fetch nothing answered — that is the connection, and we cannot see our own fleet from there", async () => {
    const refusal = clientRefusal(new Error("Load failed"))
    expect(refusal.fault).toBe("infra")
    const lead = refusalLead(refusal)
    expect(lead).toBe(NOTHING_ANSWERED)
    expect(lead).not.toBe(INFRA_NOT_YOUR_FAULT)
    expect(lead).not.toContain("@fucory")
    expect(lead).not.toContain("ran out")
    /* Still says plainly that it was not the reader, and still offers the way on. */
    expect(lead).toContain("not something you did")
    expect(refusalDoors(refusal)).toEqual(["retry"])
    /* And there is nothing to report to us: we were never reached. */
    expect(refusalDoors(refusal)).not.toContain("report")
  })

  test("the model is corrected too: it must not claim we ran out when nothing answered", async () => {
    const text = agentRefusalText(clientRefusal(new Error("Load failed")))
    expect(text).toContain("origin=client")
    expect(text).toContain("fault=infra")
    expect(text).toContain("Do NOT say Smithers ran out of infra")
    expect(text).not.toContain("@fucory")
    expect(text).toContain("worth trying again")
  })
})

/*
 * The desktop app's own host answers the same `/api/cloud/*` routes the Worker
 * does, under the same codes. Only the noun in the sentence differs, and
 * "this deployment" is wrong for a program on the reader's own laptop.
 */
describe("a refusal the native host wrote", () => {
  const local = (code: WorkerFailureCode, message: string) => workerRefusal(code, message, { origin: "local" })

  test("is told apart from the Worker's, which is the point of widening origin", async () => {
    expect((await local("seam_not_configured", "x")).origin).toBe("local")
    expect((await workerRefusal("seam_not_configured", "x")).origin).toBe("worker")
  })

  test("never talks about a deployment, or about whoever deployed it", async () => {
    for (const code of ["deployment_not_configured", "seam_not_configured"] as const) {
      const lead = refusalLead(await local(code, "x"))
      expect(lead).toContain("This build")
      expect(lead).not.toContain("deployment")
      expect(lead).not.toContain("deployed")
      expect(lead).not.toContain("@fucory")
      expect(lead).toContain("Not your fault")
      const agent = agentRefusalText(await local(code, "x"))
      expect(agent).toContain("origin=local")
      expect(agent).toContain("do NOT say Smithers ran out of infra")
      /* Told in as many words not to send the reader after a deployment that does not exist. */
      expect(agent).toMatch(/never tell them to contact whoever deployed it|do not refer to a deployment/u)
    }
  })

  test("keeps its origin when it reaches the model as a string", async () => {
    const refusal = await local("deployment_not_configured", "The cloud seam is not set up.")
    const sentence = refusalSentence(refusal)
    expect(sentence.startsWith("deployment_not_configured@local — ")).toBe(true)
    const note = agentFaultNote(sentence)
    expect(note).toContain("[fault=infra code=deployment_not_configured]")
    expect(note).toBe(`[fault=infra code=deployment_not_configured] ${refusalCopy(refusal).agent}`)
    expect(note).toContain("origin=local")
    const worker = agentFaultNote(refusalSentence(await workerRefusal("deployment_not_configured", "x")))
    expect(worker).not.toBe(note)
  })

  test("keeps the Worker's wording for every code that has no local rewording", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      if (code === "deployment_not_configured" || code === "seam_not_configured") continue
      expect(refusalLead(await local(code, "x"))).toBe(refusalLead(await workerRefusal(code, "x")))
    }
  })

  test("is read back off the wire from the origin it states, not guessed from its code", async () => {
    const refusal = refusalOf({
      body: { status: "error", code: "feature_unavailable_here", origin: "local" },
      status: 501,
      message: "The cloud seam is disabled in this build."
    })
    expect(refusal.origin).toBe("local")
    /* An origin nobody states, or one outside the closed set, still reads as the Worker's. */
    expect(refusalOf({ body: { code: "feature_unavailable_here" }, status: 501, message: "x" }).origin).toBe("worker")
    expect(
      refusalOf({ body: { code: "feature_unavailable_here", origin: "somewhere" }, status: 501, message: "x" }).origin
    ).toBe("worker")
  })
})

describe("doors", () => {
  test("a stopped box offers resume, a dead session offers sign-in, a wait offers retry", async () => {
    expect(refusalDoors(forCode("desktop_not_running"))).toContain("resume")
    expect(refusalDoors(forCode("unauthorized"))).toContain("sign-in")
    expect(refusalDoors(forCode("invalid_token"))).toEqual(["sign-in"])
    expect(refusalDoors(forCode("desktop_not_ready"))).toContain("retry")
  })

  test("report is offered for infra and bug, and is not offered for a user fault", async () => {
    expect(refusalDoors(forCode("no_capacity"))).toContain("report")
    expect(refusalDoors(forCode("internal"))).toContain("report")
    expect(refusalDoors(forCode("quota_exceeded"))).not.toContain("report")
  })

  /*
   * plue calls this one terminal for that box: the helpers are missing from
   * the image it booted, so the identical request fails identically forever.
   * A Retry is therefore a door onto a wall. The door that works is a new box,
   * which boots the current image.
   */
  test("a box with no desktop tools offers a new box, never a retry", async () => {
    const doors = refusalDoors(forCode("desktop_tools_unavailable"))
    expect(doors).toContain("new-box")
    expect(doors).not.toContain("retry")
    expect(doors).not.toContain("resume")
  })
})

describe("the agent's tool result", () => {
  test("carries the fault class, the code and the pacing as machine facts", async () => {
    const text = agentRefusalText(
      refusalOf({
        body: { code: "no_capacity", fault: "infra", retry_after: 30 },
        status: 503,
        message: "no sandbox slots are free"
      })
    )
    expect(text.startsWith("failed: ")).toBe(true)
    expect(text).toContain("fault=infra")
    expect(text).toContain("code=no_capacity")
    expect(text).toContain("status=503")
    expect(text).toContain("retry_after=30s")
    expect(text).toContain("origin=plue")
    // plue's own words survive into the model's view of it.
    expect(text).toContain("no sandbox slots are free")
    expect(text).toContain("@fucory")
  })

  test("a fetch that threw is told to the model as infra, not as a bare failure string", async () => {
    const text = agentRefusalText(clientRefusal(new Error("Load failed")))
    expect(text).toContain("fault=infra")
    expect(text).toContain("origin=client")
    expect(text).toContain("Load failed")
    // The old shape was exactly `failed: Load failed`, with no verdict in it.
    expect(text).not.toBe("failed: Load failed")
  })

  test("every fault produces a distinct instruction to the model", async () => {
    const sentences = PLUE_FAULTS.map((fault) => REFUSAL_COPY[fault].agent)
    expect(new Set(sentences).size).toBe(PLUE_FAULTS.length)
  })

  /*
   * The model gets the same correction the reader does. Left to the fault's
   * own sentence it would tell the user to yell for more infra about a box
   * whose image is simply old, and would have nothing to offer them.
   */
  test("the model is told a missing desktop tool is our rollout, not a shortage", async () => {
    const text = agentRefusalText(forCode("desktop_tools_unavailable", "this box's image has no desktop tools"))
    expect(text).toContain("fault=infra")
    expect(text).toContain("code=desktop_tools_unavailable")
    expect(text).not.toContain("@fucory")
    /* The correction is explicit, the way deployment_not_configured's is. */
    expect(text).toContain("nothing is full")
    expect(text).toContain("do NOT say Smithers ran out of infra")
    expect(text).toContain("open a new box")
  })
})

describe("refusalUserFailure", () => {
  test.each([
    { label: "missing code", fields: {} },
    { label: "null code", fields: { code: null } }
  ])("a legacy status-0 refusal with $label gets connection copy and only Retry", ({ fields }) => {
    const refusal = refusalFromStored({ status: 0, message: "Load failed", ...fields })
    const sentence = "Nothing answered at all — that's the connection, not something you did. Try it again."
    expect(refusalLead(refusal)).toBe(sentence)
    expect(refusalSentence(refusal)).toBe(`Load failed. ${sentence}`)
    expect(refusalDoors(refusal)).toEqual(["retry"])
    expect(refusalUserFailure(refusal)).toEqual({
      tag: null,
      fault: "infra",
      sentence,
      actions: ["retry"],
      detail: "Load failed"
    })
    const agent = agentRefusalText(refusal)
    expect(agent).toContain("origin=client")
    expect(agent).toContain("fault=infra")
    expect(agent).toContain("Load failed")
    expect(agent).toContain("Do NOT say Smithers ran out of infra")
    expect(agent).not.toContain("@fucory")
  })

  test("the lead is the sentence and the server's words stay in the detail", () => {
    const refusal = forCode("no_capacity", "fleet full: 0 of 40 slots free")
    const failure = refusalUserFailure(refusal)
    expect(failure.sentence).toBe(refusalLead(refusal))
    expect(failure.sentence).not.toContain("fleet full")
    expect(failure.detail).toBe("no_capacity — fleet full: 0 of 40 slots free")
    expect(failure.tag).toBe("no_capacity")
    expect(failure.fault).toBe(refusal.fault)
  })

  test("only doors that are user failure actions become actions", () => {
    for (const fault of PLUE_FAULTS) {
      const refusal = { ...clientRefusal(new Error("socket hang up")), origin: "plue" as const, fault }
      const doors = refusalDoors(refusal)
      expect(refusalUserFailure(refusal).actions).toEqual(
        doors.filter((door) => door === "retry" || door === "sign-in")
      )
    }
  })

  test("a refusal with no code keeps its words, and nothing answering gets the connection sentence", () => {
    const failure = refusalUserFailure(clientRefusal(new Error("Load failed")))
    expect(failure.tag).toBeNull()
    expect(failure.sentence).toBe(NOTHING_ANSWERED)
    expect(failure.detail).toBe("Load failed")
  })
})

describe("refusalLine", () => {
  const USER_CODE = (Object.keys(PLUE_FAILURES) as ReadonlyArray<PlueFailureCode>).find((code) =>
    PLUE_FAILURES[code].fault === "user"
  )!
  const NOT_USER_CODES = (Object.keys(PLUE_FAILURES) as ReadonlyArray<PlueFailureCode>).filter((code) =>
    PLUE_FAILURES[code].fault !== "user"
  )

  test("plue's words lead a refusal the person can act on", () => {
    expect(refusalLine(forCode(USER_CODE, "That name is taken."), "Renaming failed.")).toBe("That name is taken.")
    /* An upstream that named no code, refusing with a 4xx, wrote for a person too. */
    expect(
      refusalLine(refusalOf({ body: { message: "x" }, status: 404, message: "No such branch." }), "Reading failed.")
    ).toBe("No such branch.")
  })

  test("a refusal that is not the person's to fix never shows the server's words", () => {
    for (const code of NOT_USER_CODES) {
      const refusal = forCode(code, "pq: deadlock detected at 0x7f")
      const line = refusalLine(refusal, "Saving the page failed.")
      expect(line).toBe(`Saving the page failed. ${refusalLead(refusal)}`)
      expect(line).not.toContain("pq:")
    }
    const uncoded = refusalOf({ body: { message: "x" }, status: 500, message: "panic: runtime error" })
    expect(refusalLine(uncoded, "Reading issues failed (500)")).toBe(
      `Reading issues failed (500). ${refusalLead(uncoded)}`
    )
  })

  test("a Worker or desktop-host code speaks through its written lead, even when the person can act", async () => {
    for (const code of WORKER_FAILURE_CODES) {
      for (const origin of ["worker", "local"] as const) {
        const refusal = await workerRefusal(code, "raw worker words: stack at x.ts:12", { origin })
        const line = refusalLine(refusal, "Opening the box failed.")
        expect(line).toBe(`Opening the box failed. ${refusalLead(refusal)}`)
        expect(line).not.toContain("raw worker words")
      }
    }
  })

  test("nothing answering says what failed and that it was the connection", () => {
    const refusal = clientRefusal(new Error("Load failed"), "Load failed")
    expect(refusalLine(refusal, "Could not reach Smithers Cloud.")).toBe(
      `Could not reach Smithers Cloud. ${NOTHING_ANSWERED}`
    )
  })

  test("empty words and an empty context leave the lead alone", () => {
    const refusal = forCode(USER_CODE, "  ")
    expect(refusalLine(refusal, "")).toBe(refusalLead(refusal))
    expect(refusalLine(forCode("internal", "boom"), "")).toBe(refusalLead(forCode("internal", "boom")))
  })

  test("the context gains a full stop only when it lacks one", () => {
    const refusal = forCode("internal", "boom")
    expect(refusalLine(refusal, "Saving failed")).toBe(`Saving failed. ${refusalLead(refusal)}`)
    expect(refusalLine(refusal, "Saving failed!")).toBe(`Saving failed! ${refusalLead(refusal)}`)
  })
})

describe("leadingRefusal", () => {
  test("rebuilds a known leading code from the registries and never keeps the words after it", () => {
    const refusal = leadingRefusal("workspace_gone — upstream said: vm 7f3a destroyed at node-12")
    expect(refusal).toMatchObject({
      code: "workspace_gone",
      rawCode: "workspace_gone",
      fault: "infra",
      message: "",
      origin: "worker"
    })
    expect(refusalLead(refusal!)).toBe(
      "The workspace behind this setup is gone. Not your fault; retry creates a new one."
    )
    expect(leadingRefusal("native_node_missing — x")?.origin).toBe("local")
    expect(leadingRefusal("workspace_gone@local — x")?.origin).toBe("local")
  })

  test("answers null for no code, an unknown code, or a code not at the front", () => {
    expect(leadingRefusal("")).toBeNull()
    expect(leadingRefusal("nothing_like_this — x")).toBeNull()
    expect(leadingRefusal("The box failed: workspace_gone — x")).toBeNull()
  })
})
