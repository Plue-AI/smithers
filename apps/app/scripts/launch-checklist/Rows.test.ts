/*
 * The row catalog: every checklist row is actually checked, and the probes
 * that decide the hard rows decide them for the stated reason.
 *
 * The panel finding this answers: "those rows have no probes, and D-4 does not
 * assert that workflow launch pauses". Both are asserted here against a fake
 * page, so a regression that quietly drops a probe fails the gate.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, describe, expect, test } from "bun:test"
import { ZERO_BALANCE_EXHAUSTED_TEXT } from "../../src/mainview/state/controller/failures.ts"
import { ROWS } from "./Rows.ts"
import { runChecklist } from "./Runner.ts"
import { BrowserUnavailableError, type ChecklistRow, type ProbeContext, type ProbePage } from "./Types.ts"

interface FakePageOptions {
  /** Successive `document.body.innerText` values; the last one repeats. */
  readonly texts: ReadonlyArray<string>
  readonly evaluate: (expression: string) => unknown
}

interface Recorder {
  readonly typed: Array<string>
  readonly pressed: Array<string>
  reloads: number
}

const fakePage = (options: FakePageOptions, recorder: Recorder): ProbePage => {
  let index = 0
  return {
    text: async () => {
      const value = options.texts[Math.min(index, options.texts.length - 1)] ?? ""
      index += 1
      return value
    },
    evaluate: async <T>(expression: string) => options.evaluate(expression) as T,
    type: async (value: string) => {
      recorder.typed.push(value)
    },
    press: async (key: string) => {
      recorder.pressed.push(key)
    },
    reload: async () => {
      recorder.reloads += 1
    }
  }
}

const contextFor = (
  options: {
    readonly page?: ProbePage
    readonly env?: Record<string, string | undefined>
    readonly fetch?: ProbeContext["fetch"]
  } = {}
): ProbeContext => {
  // A clock that jumps a full second per read so budgeted waits end fast.
  let clock = 0
  return {
    target: "https://example.test",
    env: options.env ?? {},
    page: async () => options.page ?? Promise.reject(new BrowserUnavailableError("no browser configured in this test")),
    fetch: options.fetch ?? (() => Promise.reject(new Error("no fetch configured"))),
    now: () => (clock += 1_000),
    sleep: () => Promise.resolve()
  }
}

const rowById = (id: string): ChecklistRow => {
  const found = ROWS.find((row) => row.id === id)
  if (found === undefined) throw new Error(`no row ${id}`)
  return found
}

const recorder = (): Recorder => ({ typed: [], pressed: [], reloads: 0 })

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status })

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())

describe("E-3 (grant replay preserves the durable balance and audit)", () => {
  const env = {
    CHECKLIST_BILLING_UPSTREAM_URL: "https://billing.test",
    CHECKLIST_BILLING_ADMIN_TOKEN: "admin-fixture",
    CHECKLIST_BILLING_PRODUCT_SERVICE_TOKEN: "product-fixture"
  }
  const ledger = (fault = "none") => {
    let totalNanos = 500_000_000_000
    let posts = 0
    let user = ""
    const credits: Array<Record<string, unknown>> = []
    const calls: Array<string> = []
    const bodies: Array<Record<string, unknown>> = []
    const fetch: ProbeContext["fetch"] = async (url, init) => {
      const headers = new Headers(init?.headers)
      if (init?.method !== "POST") {
        expect(url).toBe("https://billing.test/api/billing/balance")
        expect(headers.get("x-smithers-service-token")).toBe("product-fixture")
        expect(headers.has("authorization")).toBe(false)
        expect(init?.cache).toBe("no-store")
        user ||= headers.get("x-user-login") ?? ""
        expect(headers.get("x-user-login")).toBe(user)
        calls.push("read")
        if (fault === "unreadable") return jsonResponse({}, 503)
        return jsonResponse({
          user: fault === "wrong-account" ? "another-account" : user,
          balance: { totalNanos: fault === "malformed" ? null : totalNanos },
          credits
        })
      }
      calls.push("grant")
      const body = JSON.parse(String(init.body)) as Record<string, unknown>
      bodies.push(body)
      posts += 1
      if (posts === 1 || fault === "double-credit") totalNanos += 1_000_000_000
      if (posts === 1 && fault !== "missing-audit") credits.push({
        id: body.grantId ?? body.idempotencyKey,
        kind: "promotional", grantedUsd: "1", consumedUsd: "0", remainingUsd: "1",
        createdAt: "2026-09-08T00:00:00.000Z", expiresAt: null,
        source: "admin-grant:manual-admin-grant",
        requestedBy: body.requester, requestedAt: body.timestamp
      })
      if (posts === 2 && fault === "duplicate-audit") credits.push({ ...credits[0] })
      if (posts === 2 && fault === "rewritten-audit") credits[0]!.createdAt = "2026-09-09T00:00:00.000Z"
      if (fault === "bad-attribution" && credits[0]) credits[0].requestedBy = "someone-else"
      if (posts === 1 && fault === "wrong-first-credit") totalNanos += 1_000_000_000
      if (posts === 2 && fault === "wrong-first-credit") totalNanos -= 1_000_000_000
      return jsonResponse(posts === 1 ? { granted: true } : { duplicate: true }, posts === 1 ? 201 : 200)
    }
    return { fetch, calls, bodies }
  }

  test("reads before, after the grant, and after replay for one isolated account", async () => {
    const first = ledger()
    expect((await rowById("E-3").probe(contextFor({ env, fetch: first.fetch }))).status).toBe("pass")
    expect(first.calls).toEqual(["read", "grant", "read", "grant", "read"])
    expect(first.bodies[0]).toEqual(first.bodies[1])
    expect(first.bodies[0]?.amountUsd).toBe(1)
    expect(first.bodies[0]?.grantId).toMatch(/^admin:/)
    expect(first.bodies[0]?.userId).toBe(first.bodies[0]?.requester)
    const second = ledger()
    expect((await rowById("E-3").probe(contextFor({ env, fetch: second.fetch }))).status).toBe("pass")
    expect(second.bodies[0]?.userId).not.toBe(first.bodies[0]?.userId)
  })

  for (const fault of ["double-credit", "missing-audit", "duplicate-audit", "rewritten-audit", "bad-attribution", "wrong-first-credit", "wrong-account", "malformed", "unreadable"]) {
    test(`fails despite duplicate:true when the ledger has ${fault}`, async () => {
      const fixture = ledger(fault)
      expect((await rowById("E-3").probe(contextFor({ env, fetch: fixture.fetch }))).status).toBe("fail")
    })
  }
})

describe("B-1 (recover an observed streaming turn)", () => {
  const recoveryPage = (fault = "none") => {
    const doc = document.implementation.createHTMLDocument()
    const track = recorder()
    let submitted = false
    let reads = 0
    const render = () => {
      doc.body.replaceChildren()
      doc.body.append(doc.createElement("textarea"))
      const transcript = doc.createElement("div")
      transcript.setAttribute("data-testid", "transcript")
      transcript.setAttribute("aria-busy", String(submitted && (track.reloads === 0 || fault === "still-running") && fault !== "never-started" && fault !== "already-complete"))
      doc.body.append(transcript)
      const message = (role: string, text: string, note = "") => {
        const article = doc.createElement("article")
        article.className = "smithers-chat-message"
        article.setAttribute("data-role", role)
        const markdown = doc.createElement("div")
        markdown.className = "message-markdown"
        markdown.textContent = text
        article.append(markdown)
        const meta = doc.createElement("div")
        meta.className = "sui-chat-message-meta"
        meta.textContent = note
        article.append(meta)
        transcript.append(article)
      }
      message("user", "Launch checklist B-1 restore probe")
      message("assistant", "An old reply", "Turn interrupted")
      if (!submitted || fault === "stale-marker") return
      message("user", track.typed[0] ?? "")
      if (fault === "never-started") return
      reads += 1
      const partial = reads === 1 ? "one" : "one two"
      if (fault === "unrelated-reply") message("user", "A different turn")
      message("assistant", track.reloads > 0 && fault === "lost-work" ? "" : partial,
        track.reloads > 0 && fault !== "missing-status"
          ? fault === "failed-recovery" ? "Turn interrupted — Recovery failed to load the session." : "Turn interrupted — That turn was interrupted when the app closed."
          : "")
    }
    const page: ProbePage = {
      text: async () => { render(); return doc.body.textContent ?? "" },
      evaluate: async <T>(expression: string) => {
        render()
        return new Function("document", "performance", `return (${expression})`)(doc, { timeOrigin: fault === "no-reload" ? 1 : track.reloads + 1 }) as T
      },
      type: async (text) => { track.typed.push(text) },
      press: async (key) => { track.pressed.push(key); if (key === "Enter") submitted = true },
      reload: async () => { track.reloads += 1 }
    }
    return { page, track }
  }

  test("interrupts a new streaming reply and restores its partial text with idle/interrupted state", async () => {
    const first = recoveryPage()
    expect((await rowById("B-1").probe(contextFor({ page: first.page }))).status).toBe("pass")
    expect(first.track.reloads).toBe(1)
    const second = recoveryPage()
    expect((await rowById("B-1").probe(contextFor({ page: second.page }))).status).toBe("pass")
    expect(second.track.typed[0]).not.toBe(first.track.typed[0])
  })

  for (const fault of ["stale-marker", "never-started", "already-complete", "lost-work", "still-running", "missing-status", "failed-recovery", "unrelated-reply", "no-reload"]) {
    test(`fails recovery with ${fault}`, async () => {
      const fixture = recoveryPage(fault)
      expect((await rowById("B-1").probe(contextFor({ page: fixture.page }))).status).toBe("fail")
    })
  }
})

describe("the row catalog", () => {
  test("covers every checklist section", () => {
    expect([...new Set(ROWS.map((row) => row.section))].sort()).toEqual(["A", "B", "C", "D", "E", "F"])
  })

  test("every row carries a probe — nothing is enumerated but unchecked", () => {
    const unprobed = ROWS.filter((row) => typeof row.probe !== "function").map((row) => row.id)
    expect(unprobed).toEqual([])
  })

  test("probe is the only lifecycle a row runs — setup belongs inside the probe", () => {
    const extraHooks = ROWS.flatMap((row) =>
      Object.entries(row).filter(([key, value]) => key !== "probe" && typeof value === "function").map(([key]) => `${row.id}.${key}`)
    )
    expect(extraHooks).toEqual([])
  })

  test("row ids are unique", () => {
    expect(new Set(ROWS.map((row) => row.id)).size).toBe(ROWS.length)
  })

  test("the signed-in rows drive a headless page, so the checklist runs headlessly rather than by hand", () => {
    const browserRows = ROWS.filter((row) => row.browser === true).map((row) => row.id)
    for (const id of ["A-1", "B-2", "C-1", "C-2", "D-4", "F-1", "F-6"]) {
      expect(browserRows).toContain(id)
    }
  })

  test("the browser rows say which session they need instead of failing on absent auth", async () => {
    const results = await runChecklist({ rows: ROWS, mode: "run", context: contextFor() })
    const sessionRows = results.filter((row) => row.status === "not-testable-yet")
    expect(sessionRows.length).toBeGreaterThan(0)
    expect(results.filter((row) => row.status === "fail")).toEqual([])
  })
})

describe("A-1 (signed-out chat, no separate landing view)", () => {
  const evaluate = (expression: string): unknown => {
    if (expression.includes("textarea") && expression.includes("!== null")) return true
    if (expression.includes("tabindex")) return ["auth.sign-in", "textarea"]
    return null
  }

  test("passes when the composer, the opening message, and a first-Tab sign-in are all there", async () => {
    const page = fakePage({ texts: ["x".repeat(200)], evaluate }, recorder())
    const result = await rowById("A-1").probe(contextFor({ page }))
    expect(result.status).toBe("pass")
  })

  test("fails when sign-in is not the first tab stop", async () => {
    const page = fakePage(
      {
        texts: ["x".repeat(200)],
        evaluate: (e) => (e.includes("tabindex") ? ["textarea", "auth.sign-in"] : evaluate(e))
      },
      recorder()
    )
    const result = await rowById("A-1").probe(contextFor({ page }))
    expect(result.status).toBe("fail")
    expect(result.detail).toContain("auth.sign-in at index 1")
  })
})

describe("A-5 (the $500 grant line is stated exactly once)", () => {
  const evaluateWith = (introUsd: string | null) => (expression: string): unknown =>
    expression.includes("/api/billing/balance")
      ? { status: 200, body: { introUsd }, text: "" }
      : null

  test("passes with one statement while the grant is unspent", async () => {
    const page = fakePage({ texts: ["You have $500 of usage on us."], evaluate: evaluateWith("500.00") }, recorder())
    expect((await rowById("A-5").probe(contextFor({ page }))).status).toBe("pass")
  })

  test("fails when the line is repeated", async () => {
    const page = fakePage(
      { texts: ["$500 of usage on us ... and again $500 of usage on us"], evaluate: evaluateWith("500.00") },
      recorder()
    )
    const result = await rowById("A-5").probe(contextFor({ page }))
    expect(result.status).toBe("fail")
    expect(result.detail).toContain("2x")
  })

  test("fails when the line survives a spent grant", async () => {
    const page = fakePage({ texts: ["$500 of usage on us"], evaluate: evaluateWith(null) }, recorder())
    expect((await rowById("A-5").probe(contextFor({ page }))).status).toBe("fail")
  })
})

describe("C-1 (every affordance resolves to a /name)", () => {
  const evaluate = (affordances: unknown, commands: ReadonlyArray<string>) => (expression: string): unknown => {
    if (expression.includes("data-flows")) return commands
    if (expression.includes("role=button")) return affordances
    return null
  }

  test("passes when every visible affordance carries a registered command name", async () => {
    const page = fakePage(
      {
        texts: ["x".repeat(200)],
        evaluate: evaluate([{ label: "Accept", flow: "flow.run" }], ["flow.run", "flow.list"])
      },
      recorder()
    )
    expect((await rowById("C-1").probe(contextFor({ page }))).status).toBe("pass")
  })

  test("fails and names the affordance that has no command", async () => {
    const page = fakePage(
      {
        texts: ["x".repeat(200)],
        evaluate: evaluate(
          [
            { label: "Accept", flow: "flow.run" },
            { label: "Mystery", flow: null }
          ],
          ["flow.run"]
        )
      },
      recorder()
    )
    const result = await rowById("C-1").probe(contextFor({ page }))
    expect(result.status).toBe("fail")
    expect(result.detail).toContain("Mystery → no data-flow")
  })
})

describe("D-4 (at $0, chat keeps working and non-complimentary work pauses)", () => {
  const turnOk: ProbeContext["fetch"] = async (url, init) => {
    if (url.endsWith("/prompt")) {
      expect(init?.method).toBe("POST")
      const body = JSON.parse(String(init?.body)) as { idempotencyKey: string; prompt: string }
      expect(body.prompt).toBe("Say the word ok and nothing else.")
      expect(body.idempotencyKey).toMatch(/^launch-checklist-d4-/)
      return jsonResponse({ turnId: "zero-balance-turn" }, 202)
    }
    expect(url).toBe("https://example.test/api/conversations/main")
    return jsonResponse({ entries: [{ id: "zero-balance-turn", state: "completed" }] })
  }
  const evaluate = (expression: string): unknown => (expression.includes("textarea") ? true : null)
  const env = { CHECKLIST_ZERO_BALANCE_BEARER: "smithers_session=zero" }

  test("passes only when the flow launch is refused with the pause statement", async () => {
    const track = recorder()
    const page = fakePage({ texts: ["transcript", `transcript\n${ZERO_BALANCE_EXHAUSTED_TEXT}`], evaluate }, track)
    const result = await rowById("D-4").probe(contextFor({ page, env, fetch: turnOk }))
    expect(result.status).toBe("pass")
    expect(track.typed.join(" ")).toContain("/flow.create")
    expect(result.detail).toContain("pause statement=true")
  })

  test("fails on pause copy the product no longer dispatches", async () => {
    const page = fakePage(
      { texts: ["transcript", "transcript\nBalance is at $0 — workflow runs pause until more balance is added."], evaluate },
      recorder()
    )
    const result = await rowById("D-4").probe(contextFor({ page, env, fetch: turnOk }))
    expect(result.status).toBe("fail")
    expect(result.detail).toContain("pause statement=false")
  })

  test("fails when a flow launch at $0 does not pause", async () => {
    const page = fakePage({ texts: ["transcript", "transcript\nRun started."], evaluate }, recorder())
    const result = await rowById("D-4").probe(contextFor({ page, env, fetch: turnOk }))
    expect(result.status).toBe("fail")
    expect(result.detail).toContain("pause statement=false")
  })

  test("fails when interactive chat itself stops working at $0", async () => {
    const page = fakePage(
      { texts: ["transcript", `transcript\n${ZERO_BALANCE_EXHAUSTED_TEXT}`], evaluate },
      recorder()
    )
    const result = await rowById("D-4").probe(
      contextFor({ page, env, fetch: async () => jsonResponse("nope", 402) })
    )
    expect(result.status).toBe("fail")
  })
})

describe("F-1 (an impossible ask refuses honestly)", () => {
  const evaluate = (expression: string): unknown => (expression.includes("textarea") ? true : null)
  const env = { CHECKLIST_SESSION_COOKIE: "smithers_session=abc" }

  test("passes on a can't-yet answer", async () => {
    const page = fakePage(
      { texts: ["transcript", "transcript\nI can't yet send email — connect a mail tool and I will."], evaluate },
      recorder()
    )
    expect((await rowById("F-1").probe(contextFor({ page, env }))).status).toBe("pass")
  })

  test("fails on a faked success", async () => {
    const page = fakePage(
      { texts: ["transcript", "transcript\nDone — I have sent the email to will@tevm.tech as requested."], evaluate },
      recorder()
    )
    const result = await rowById("F-1").probe(contextFor({ page, env }))
    expect(result.status).toBe("fail")
    expect(result.detail).toContain("fake-success=true")
  })
})

describe("E-2 (an untimestamped grant is refused before any write)", () => {
  const env = { CHECKLIST_BILLING_UPSTREAM_URL: "https://billing.test", CHECKLIST_BILLING_ADMIN_TOKEN: "admin-fixture" }
  // Mirrors the billing worker's check order: admin header, target, grant id, amount, requester, then timestamp.
  const upstream: ProbeContext["fetch"] = async (url, init) => {
    expect(url).toBe("https://billing.test/api/billing/admin/grants")
    const headers = new Headers(init?.headers)
    expect(headers.has("authorization")).toBe(false)
    if (headers.get("x-smithers-admin-token") !== "admin-fixture") return jsonResponse({ error: "Unauthorized admin" }, 401)
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>
    if (typeof body.userId !== "string" || body.userId === "") return jsonResponse({ error: "userId or login is required" }, 400)
    if (typeof body.grantId !== "string" || !body.grantId.startsWith("admin:")) return jsonResponse({ error: "grantId is required" }, 400)
    if (typeof body.amountUsd !== "number") return jsonResponse({ error: "amountUsd must be a positive number" }, 400)
    if (typeof body.requester !== "string" || body.requester === "") return jsonResponse({ code: "requester_required" }, 400)
    if (typeof body.timestamp !== "string" || body.timestamp === "") return jsonResponse({ code: "timestamp_required" }, 400)
    return jsonResponse({ granted: true }, 201)
  }

  test("authenticates with x-smithers-admin-token and reaches the timestamp guard", async () => {
    expect((await rowById("E-2").probe(contextFor({ env, fetch: upstream }))).status).toBe("pass")
  })

  test("fails when the upstream credits the untimestamped grant", async () => {
    const result = await rowById("E-2").probe(contextFor({ env, fetch: async () => jsonResponse({ granted: true }, 201) }))
    expect(result.status).toBe("fail")
  })
})

describe("E-1 (the billing admin surface rejects an unauthenticated grant)", () => {
  test("passes on a 401 and fails on anything else", async () => {
    const env = { CHECKLIST_BILLING_UPSTREAM_URL: "https://billing.test" }
    const denied = await rowById("E-1").probe(
      contextFor({ env, fetch: async () => jsonResponse("unauthorized", 401) })
    )
    expect(denied.status).toBe("pass")
    const allowed = await rowById("E-1").probe(contextFor({ env, fetch: async () => jsonResponse({ id: "g1" }, 201) }))
    expect(allowed.status).toBe("fail")
  })
})
