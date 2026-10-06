import { conversationProbe } from "../../../server/scripts/canary/conversation-probe"
import { csrfHeaders } from "../../../server/scripts/canary/uptime-checks"
/*
 * Launch checklist (U7) — the row catalog.
 *
 * Every row carries a probe. The §A/§B/§C/§F rows drive a real headless page
 * on the target (`ctx.page(cookie)`); the §D rows mix page assertions with the
 * product Worker's billing seams; the §E rows call the billing upstream's
 * admin surface directly. Nothing here is enumerated-but-unchecked: a row that
 * cannot decide says so with the exact reason (missing env, no browser, or a
 * fact the rendered page does not expose), never with a blanket deferral.
 */
import { ZERO_BALANCE_EXHAUSTED_TEXT } from "../../src/mainview/state/controller/failures.ts"
import {
  type Affordance,
  asRecord,
  CARD_COLLECTION_COPY,
  CARD_LEADS,
  CHECKOUT_COPY,
  countOccurrences,
  countQuestions,
  ERROR_STATE_COPY,
  fail,
  FAKE_SUCCESS_COPY,
  fetchInPage,
  FIRST_MESSAGE_BUDGET_MS,
  hasSmithersMessage,
  HONEST_REFUSAL_COPY,
  INTRO_GRANT_LINE,
  RATING_COPY,
  REGISTERED_COMMANDS,
  replyRegion,
  SCORE_COPY,
  type SeamAnswer,
  sendPrompt,
  SETUP_COPY,
  STOP_BUDGET_MS,
  TABBABLE_FLOWS,
  undecided,
  unnamedAffordances,
  verdict,
  VISIBLE_AFFORDANCES,
  waitForText
} from "./Probes.ts"
import type { ChecklistRow, ProbeContext, ProbePage, ProbeResult } from "./Types.ts"

const SESSION_COOKIE = "CHECKLIST_SESSION_COOKIE"
const ZERO_BALANCE_COOKIE = "CHECKLIST_ZERO_BALANCE_BEARER"
const BILLING_UPSTREAM = "CHECKLIST_BILLING_UPSTREAM_URL"
const BILLING_ADMIN_TOKEN = "CHECKLIST_BILLING_ADMIN_TOKEN"
const BILLING_PRODUCT_TOKEN = "CHECKLIST_BILLING_PRODUCT_SERVICE_TOKEN"
/** The billing upstream reads the admin token here; `authorization: Bearer` is the account credential. */
const ADMIN_TOKEN_HEADER = "x-smithers-admin-token"

const signedInPage = (ctx: ProbeContext): Promise<ProbePage> => ctx.page(ctx.env[SESSION_COOKIE])

const zeroBalancePage = (ctx: ProbeContext): Promise<ProbePage> => ctx.page(ctx.env[ZERO_BALANCE_COOKIE])

const seam = (page: ProbePage, path: string): Promise<SeamAnswer> => page.evaluate<SeamAnswer>(fetchInPage(path))

/** Ask Smithers something and return the reply region once it settles (or the budget runs out). */
const converse = async (ctx: ProbeContext, page: ProbePage, prompt: string, budgetMs: number): Promise<string> => {
  const before = await sendPrompt(page, prompt)
  const settled = await waitForText(
    page,
    (text) => {
      const region = replyRegion(before, text)
      return region.trim().length > 40 && !/thinking|working/i.test(region)
    },
    budgetMs,
    ctx.now,
    ctx.sleep
  )
  return replyRegion(before, settled.text)
}

/** The §F shape: an impossible ask must refuse honestly and must never claim it did the thing. */
const impossibleAsk = async (ctx: ProbeContext, prompt: string, label: string): Promise<ProbeResult> => {
  const page = await signedInPage(ctx)
  const reply = await converse(ctx, page, prompt, FIRST_MESSAGE_BUDGET_MS)
  if (reply.trim().length === 0) return fail(`${label}: no reply arrived within ${FIRST_MESSAGE_BUDGET_MS}ms`)
  const faked = FAKE_SUCCESS_COPY.test(reply)
  const honest = HONEST_REFUSAL_COPY.test(reply)
  return verdict(
    honest && !faked,
    `${label}: honest-refusal=${honest} fake-success=${faked} — reply: ${reply.trim().slice(0, 240)}`
  )
}

const balanceRead = async (ctx: ProbeContext, cookieEnvVar: string, label: string): Promise<ProbeResult> => {
  const cookie = ctx.env[cookieEnvVar]
  const response = await ctx.fetch(`${ctx.target}/api/billing/balance`, {
    headers: cookie === undefined ? {} : { cookie }
  })
  const text = await response.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  const record = asRecord(body)
  return verdict(
    response.status === 200 && record?.state === "ok" && record?.allowedToStartWork === true,
    `${label}: HTTP ${response.status} ${text.slice(0, 200)}`
  )
}

interface RecoverySnapshot {
  readonly timeOrigin: number
  readonly busy: string | null
  readonly found: boolean
  readonly reply: string
  readonly note: string
}

/** App.tsx projects session.phase through aria-busy and message.status through the reply's meta. */
const recoverySnapshot = (page: ProbePage, prompt: string): Promise<RecoverySnapshot> => page.evaluate(`(() => {
  const transcript = document.querySelector('[data-testid="transcript"]');
  const messages = Array.from(transcript?.querySelectorAll('.smithers-chat-message[data-role]') ?? []);
  const text = (message) => message?.querySelector('.message-markdown')?.textContent ?? '';
  const index = messages.findIndex((message) => message.getAttribute('data-role') === 'user' && text(message) === ${JSON.stringify(prompt)});
  let response;
  if (index >= 0) {
    for (const message of messages.slice(index + 1)) {
      if (message.getAttribute('data-role') === 'user') break;
      if (message.getAttribute('data-role') === 'assistant') { response = message; break; }
    }
  }
  return {
    timeOrigin: performance.timeOrigin,
    busy: transcript?.getAttribute('aria-busy') ?? null,
    found: index >= 0,
    reply: text(response),
    note: response?.querySelector('.sui-chat-message-meta')?.textContent ?? ''
  };
})()`)

export const ROWS: ReadonlyArray<ChecklistRow> = [
  {
    id: "A-1",
    section: "A",
    title:
      "Signed-out shows the chat (transcript + composer): the opening Smithers message carries the sentence, plain-words scopes, and a first-Tab sign-in; no separate landing view (no blank prompt box, no feature list)",
    browser: true,
    probe: async (ctx) => {
      // Deliberately cookie-less: this row is about the signed-OUT view.
      const page = await ctx.page(undefined)
      const composer = await page.evaluate<boolean>(`document.querySelector("textarea") !== null`)
      const settled = await waitForText(page, hasSmithersMessage, FIRST_MESSAGE_BUDGET_MS, ctx.now, ctx.sleep)
      const tabbable = await page.evaluate<ReadonlyArray<string>>(TABBABLE_FLOWS)
      const firstSignIn = tabbable.indexOf("auth.sign-in")
      return verdict(
        composer === true && settled.ok && firstSignIn === 0,
        `composer present=${composer}; opening message present=${settled.ok}; first tab stop=${
          tabbable[0] ?? "(none)"
        } (auth.sign-in at index ${firstSignIn}); transcript: ${settled.text.trim().slice(0, 200)}`
      )
    }
  },
  {
    id: "A-2",
    section: "A",
    title: "Sign-in to first useful message in <= 90s",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      // A reload with the session cookie is the signed-in entry this runner can
      // reproduce headlessly; the OAuth redirect itself is measured by
      // scripts/live-signed-in-check.ts against a real profile.
      await page.reload()
      const settled = await waitForText(page, hasSmithersMessage, FIRST_MESSAGE_BUDGET_MS, ctx.now, ctx.sleep)
      return verdict(
        settled.ok,
        `first useful message after ${settled.elapsedMs}ms (budget ${FIRST_MESSAGE_BUDGET_MS}ms, measured from a signed-in load)`
      )
    }
  },
  {
    id: "A-4",
    section: "A",
    title: "Workspace pre-exists: no clone/install/configure copy anywhere",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const text = await page.text()
      const match = SETUP_COPY.exec(text)
      return verdict(
        match === null,
        match === null ? "no setup copy on the signed-in surface" : `setup copy rendered: ${match[0]}`
      )
    }
  },
  {
    id: "A-5",
    section: "A",
    title: "\"$500 of usage on us\" stated exactly once",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const text = await page.text()
      const occurrences = countOccurrences(text, INTRO_GRANT_LINE)
      const balance = await seam(page, "/api/billing/balance")
      const introUsd = asRecord(balance.body)?.introUsd ?? null
      // The line belongs on screen exactly once while the grant is unspent
      // (balance payload `introUsd`), and not at all once it is gone.
      const expected = introUsd === null ? 0 : 1
      return verdict(
        occurrences === expected,
        `"${INTRO_GRANT_LINE}" rendered ${occurrences}x; grant introUsd=${
          JSON.stringify(introUsd)
        } so expected ${expected}x`
      )
    }
  },
  {
    id: "A-6",
    section: "A",
    title: "No card form anywhere in the product",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const text = await page.text()
      const inputs = await page.evaluate<number>(
        `document.querySelectorAll("input[autocomplete*='cc-'], input[name*='card' i], input[name*='cvc' i], input[type='tel'][name*='number' i]").length`
      )
      const copy = CARD_COLLECTION_COPY.exec(text)
      return verdict(
        inputs === 0 && copy === null,
        `card-shaped inputs=${inputs}; card-collection copy=${copy === null ? "none" : copy[0]}`
      )
    }
  },
  {
    id: "A-7",
    section: "A",
    title: "<= 3 questions asked in the whole first run",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const settled = await waitForText(page, hasSmithersMessage, FIRST_MESSAGE_BUDGET_MS, ctx.now, ctx.sleep)
      const questions = countQuestions(settled.text)
      return verdict(questions <= 3, `the first run asks ${questions} question(s) (budget 3)`)
    }
  },
  {
    id: "B-1",
    section: "B",
    title: "Close browser mid-turn, reopen: conversation + in-flight work restored and correctly described",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const marker = `Launch checklist B-1 restore probe ${crypto.randomUUID()}. Count slowly from one to two hundred, one number per line.`
      const initial = await recoverySnapshot(page, marker)
      if (initial.busy !== "false") return fail("B-1 needs an idle transcript before submitting its own turn")
      await sendPrompt(page, marker)
      const activeDeadline = ctx.now() + 60_000
      let previous: RecoverySnapshot | undefined
      let active: RecoverySnapshot | undefined
      while (ctx.now() < activeDeadline) {
        const snapshot = await recoverySnapshot(page, marker)
        if (snapshot.found && snapshot.busy === "true" && snapshot.note === "" && snapshot.reply.trim() !== "") {
          // A pending indicator or persisted user prompt alone does not prove streaming.
          if (previous !== undefined && snapshot.reply.startsWith(previous.reply) && snapshot.reply.length > previous.reply.length) {
            active = snapshot
            break
          }
          previous = snapshot
        } else {
          previous = undefined
        }
        await ctx.sleep(100)
      }
      if (active === undefined) return fail("B-1 never observed a growing partial reply for its new prompt while the session was responding")
      await page.reload()
      const recoveryDeadline = ctx.now() + 30_000
      let restored: RecoverySnapshot | undefined
      while (ctx.now() < recoveryDeadline) {
        restored = await recoverySnapshot(page, marker)
        if (Number.isFinite(restored.timeOrigin) && restored.timeOrigin !== active.timeOrigin &&
          restored.found && restored.reply.startsWith(active.reply) && restored.busy === "false" &&
          restored.note === "Turn interrupted — That turn was interrupted when the app closed.") {
          return verdict(true, "B-1 reloaded an actively streaming turn; its prompt and partial reply survived, with the session idle and that reply marked interrupted")
        }
        await ctx.sleep(100)
      }
      return fail(`B-1 recovery did not preserve the partial reply with idle/interrupted state: reloaded=${restored?.timeOrigin !== active.timeOrigin}; prompt=${restored?.found}; partial=${restored?.reply.startsWith(active.reply)}; aria-busy=${restored?.busy}; note=${restored?.note}`)
    }
  },
  {
    id: "B-2",
    section: "B",
    title: "Escape stops foreground work <= 1s with a statement of what stopped",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const before = await sendPrompt(page, "Count slowly from one to two hundred, one number per line.")
      await ctx.sleep(1_000)
      await page.press("Escape")
      const stopped = await waitForText(
        page,
        (text) => /\b(stopped|cancell?ed)\b/i.test(replyRegion(before, text)),
        STOP_BUDGET_MS,
        ctx.now,
        ctx.sleep,
        100
      )
      return verdict(
        stopped.ok,
        `Escape produced a stop statement in ${stopped.elapsedMs}ms (budget ${STOP_BUDGET_MS}ms): ${
          replyRegion(before, stopped.text).trim().slice(0, 200)
        }`
      )
    }
  },
  {
    id: "B-3",
    section: "B",
    title: "A server-side kill surfaces in the UI (no silent completion/failure)",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const before = await sendPrompt(page, "Count slowly from one to two hundred, one number per line.")
      await ctx.sleep(1_000)
      const runIds = await page.evaluate<ReadonlyArray<string>>(
        `Array.from(document.querySelectorAll("[data-shared-turn][data-state=running]")).map((element) => element.getAttribute("data-shared-turn"))`
      )
      const runId = runIds[0]
      if (runId === undefined) {
        return undecided(
          "the rendered transcript exposes no run id (no [data-shared-turn][data-state=running]), so this runner cannot address the in-flight run's cancel seam to stage a server-side kill; scripts/live-workflow-check.ts covers the killed-run surface with a run it launched itself"
        )
      }
      const cookie = ctx.env[SESSION_COOKIE]
      const stopped = await ctx.fetch(`${ctx.target}/api/conversations/main/turns/${encodeURIComponent(runId)}/stop`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie, ...csrfHeaders(cookie) } : {}) }, body: "{}" })
      if (!stopped.ok) return fail(`Stop HTTP ${stopped.status}`)
      const surfaced = await waitForText(
        page,
        (text) => /\b(stopped|cancell?ed|ended)\b/i.test(replyRegion(before, text)),
        15_000,
        ctx.now,
        ctx.sleep
      )
      return verdict(
        surfaced.ok,
        `after a server-side kill of ${runId} the UI ${surfaced.ok ? "surfaced it" : "stayed silent"}`
      )
    }
  },
  {
    id: "B-4",
    section: "B",
    title: "Result cards lead with the result",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      await waitForText(page, hasSmithersMessage, FIRST_MESSAGE_BUDGET_MS, ctx.now, ctx.sleep)
      const cards = await page.evaluate<ReadonlyArray<{ kind: string; lead: string }>>(CARD_LEADS)
      if (cards.length === 0) return undecided("no cards are rendered in this transcript yet, so no lead can be read")
      const processLed = cards.filter((card) =>
        /^(status|progress|working|thinking|running|pending)\b/i.test(card.lead)
      )
      return verdict(
        processLed.length === 0,
        `${cards.length} card(s) read; leading with process chrome: ${
          processLed.map((card) => `${card.kind}: ${card.lead}`).join(" | ") || "none"
        }`
      )
    }
  },
  {
    id: "B-5",
    section: "B",
    title: "No score/grade/number user-facing",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const text = await page.text()
      const match = SCORE_COPY.exec(text)
      return verdict(
        match === null,
        match === null ? "no score/grade copy on screen" : `score/grade copy rendered: ${match[0]}`
      )
    }
  },
  {
    id: "B-6",
    section: "B",
    title: "A correction never renders as an error state",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const reply = await converse(
        ctx,
        page,
        "Actually, I meant the other repository — use that one instead.",
        FIRST_MESSAGE_BUDGET_MS
      )
      const errorCopy = ERROR_STATE_COPY.exec(reply)
      const errorChrome = await page.evaluate<number>(
        `document.querySelectorAll("[data-state='error'], [role='alert'], .error").length`
      )
      return verdict(
        errorCopy === null && errorChrome === 0,
        `correction reply error-copy=${
          errorCopy === null ? "none" : errorCopy[0]
        }, error chrome elements=${errorChrome}`
      )
    }
  },
  {
    id: "B-7",
    section: "B",
    title: "Zero rating prompts (\"was this helpful?\" anywhere = fail)",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const text = await page.text()
      const match = RATING_COPY.exec(text)
      return verdict(
        match === null,
        match === null ? "no rating prompt on screen" : `rating prompt rendered: ${match[0]}`
      )
    }
  },
  {
    id: "C-1",
    section: "C",
    title: "Every visible interactive affordance resolves to a named command also reachable by /name",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      await waitForText(page, hasSmithersMessage, FIRST_MESSAGE_BUDGET_MS, ctx.now, ctx.sleep)
      const registered = await page.evaluate<ReadonlyArray<string>>(REGISTERED_COMMANDS)
      if (registered.length === 0) {
        return fail(
          "the app shell renders no [data-flows] command manifest, so no affordance can be resolved to a /name"
        )
      }
      const affordances = await page.evaluate<ReadonlyArray<Affordance>>(VISIBLE_AFFORDANCES)
      const unnamed = unnamedAffordances(affordances, registered)
      return verdict(
        unnamed.length === 0,
        `${affordances.length} visible affordance(s) against ${registered.length} registered command(s); unresolved: ${
          unnamed.join(" | ") || "none"
        }`
      )
    }
  },
  {
    id: "C-2",
    section: "C",
    title: "\"/\" opens with the recommended command first and bare \"/\"+Enter runs it",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const focused = await page.evaluate<boolean>(
        `(() => { const composer = document.querySelector("textarea"); if (composer === null) return false; composer.focus(); composer.select(); return true; })()`
      )
      if (focused !== true) return fail("the composer textarea never mounted, so \"/\" cannot be opened")
      const before = await page.text()
      await page.type("/")
      await ctx.sleep(500)
      const suggestions = await page.evaluate<ReadonlyArray<string | null>>(
        // The slash menu's options carry their command name in data-flow
        // (App.tsx); the [data-suggestion] spelling matched nothing.
        `Array.from(document.querySelectorAll("[role='option']")).map((element) => element.getAttribute("data-flow"))`
      )
      const first = suggestions[0] ?? null
      if (first === null) return fail(`"/" opened no command list (${suggestions.length} suggestion element(s) found)`)
      await page.press("Enter")
      const ran = await waitForText(
        page,
        (text) => replyRegion(before, text).trim().length > 0,
        30_000,
        ctx.now,
        ctx.sleep
      )
      return verdict(
        ran.ok,
        `"/" listed ${suggestions.length} command(s), first=${first}; bare "/"+Enter ${
          ran.ok ? "ran it" : "produced nothing in 30s"
        }`
      )
    }
  },
  {
    id: "C-3",
    section: "C",
    title: "The whole section-A journey is completable keyboard-only",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      await waitForText(page, hasSmithersMessage, FIRST_MESSAGE_BUDGET_MS, ctx.now, ctx.sleep)
      const tabbable = await page.evaluate<ReadonlyArray<string>>(TABBABLE_FLOWS)
      const affordances = await page.evaluate<ReadonlyArray<Affordance>>(VISIBLE_AFFORDANCES)
      const reachable = new Set(tabbable)
      const pointerOnly = affordances
        .filter((affordance) => affordance.flow !== null && !reachable.has(affordance.flow))
        .map((affordance) => affordance.flow ?? "")
      const composerFocusable = tabbable.includes("textarea")
      return verdict(
        pointerOnly.length === 0 && composerFocusable,
        `composer in the tab ring=${composerFocusable}; pointer-only affordances: ${pointerOnly.join(", ") || "none"}`
      )
    }
  },
  {
    id: "D-1",
    section: "D",
    title: "GET /api/billing/balance shows the $500 design-partner balance for a signed-in user",
    requiredEnv: [SESSION_COOKIE],
    probe: (ctx) => balanceRead(ctx, SESSION_COOKIE, "signed-in balance read")
  },
  {
    id: "D-2",
    section: "D",
    title:
      "An interactive chat turn does NOT reduce the balance; its true supplier cost IS still recorded (comped, not uncounted)",
    requiredEnv: [SESSION_COOKIE],
    probe: async (ctx) => {
      const cookie = ctx.env[SESSION_COOKIE]
      /*
       * The row's claim is numeric, so the assertion is numeric: the
       * balance payload carries totalUsd, lifetimeChargedUsd and
       * chargeCount (packages/rpc Cards.ts), and "comped, not uncounted"
       * means the total never drops while the lifetime cost and charge
       * tally still move. Reading only pass/fail off balanceRead let the
       * whole claim pass vacuously.
       */
      const balanceNow = async (label: string) => {
        const response = await ctx.fetch(`${ctx.target}/api/billing/balance`, {
          headers: cookie === undefined ? {} : { cookie }
        })
        const text = await response.text()
        let body: unknown = null
        try {
          body = JSON.parse(text)
        } catch {
          body = null
        }
        const record = asRecord(body)
        return { label, status: response.status, record, text }
      }
      const before = await balanceNow("balance before the turn")
      if (before.record?.state !== "ok") {
        return fail(`pre-turn balance check failed — HTTP ${before.status} ${before.text.slice(0, 200)}`)
      }
      const turn = await conversationProbe({ origin: ctx.target, key: `launch-checklist-d2-${Math.trunc(ctx.now())}`, headers: cookie ? { cookie, ...csrfHeaders(cookie) } : {}, signal: ctx.signal ?? AbortSignal.timeout(90_000), fetch: ctx.fetch, sleep: ms => ctx.sleep(ms, ctx.signal) })
      const done = turn.state === "completed" && turn.frames.some(frame => frame.type === "done")
      const after = await balanceNow("balance after the turn")
      const totalBefore = Number(before.record?.totalUsd)
      const totalAfter = Number(after.record?.totalUsd)
      const lifetimeBefore = Number(before.record?.lifetimeChargedUsd)
      const lifetimeAfter = Number(after.record?.lifetimeChargedUsd)
      const countBefore = Number(before.record?.chargeCount)
      const countAfter = Number(after.record?.chargeCount)
      const numeric = [totalBefore, totalAfter, lifetimeBefore, lifetimeAfter, countBefore, countAfter].every(
        (value) => Number.isFinite(value)
      )
      const notReduced = numeric && totalAfter >= totalBefore
      const costRecorded = numeric && (lifetimeAfter > lifetimeBefore || countAfter > countBefore)
      return verdict(
        turn.status === 202 && done && after.record?.state === "ok" && notReduced && costRecorded,
        `turn HTTP ${turn.status} (done frame: ${done}); totalUsd ${before.record?.totalUsd} -> ${after.record?.totalUsd} (must not drop); lifetimeChargedUsd ${before.record?.lifetimeChargedUsd} -> ${after.record?.lifetimeChargedUsd}; chargeCount ${before.record?.chargeCount} -> ${after.record?.chargeCount} (cost recording must move)`
      )
    }
  },
  {
    id: "D-3",
    section: "D",
    title: "No top-up/checkout/card-collection flow is exposed to MVP users",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      const registered = await page.evaluate<ReadonlyArray<string>>(REGISTERED_COMMANDS)
      const checkoutCommands = registered.filter((name) => /checkout|top-?up|payment|card/i.test(name))
      const text = await page.text()
      const copy = CHECKOUT_COPY.exec(text)
      const cardCopy = CARD_COLLECTION_COPY.exec(text)
      return verdict(
        checkoutCommands.length === 0 && copy === null && cardCopy === null,
        `checkout-shaped commands: ${checkoutCommands.join(", ") || "none"}; checkout copy=${
          copy === null ? "none" : copy[0]
        }; card copy=${cardCopy === null ? "none" : cardCopy[0]}`
      )
    }
  },
  {
    id: "D-4",
    section: "D",
    title: "At $0, interactive chat keeps working; only non-complimentary work pauses",
    requiredEnv: [ZERO_BALANCE_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const cookie = ctx.env[ZERO_BALANCE_COOKIE]
      // Half one — chat is complimentary: the turn seam still answers at $0.
      const turn = await conversationProbe({ origin: ctx.target, key: `launch-checklist-d4-${Math.trunc(ctx.now())}`, headers: cookie ? { cookie, ...csrfHeaders(cookie) } : {}, signal: ctx.signal ?? AbortSignal.timeout(90_000), fetch: ctx.fetch, sleep: ms => ctx.sleep(ms, ctx.signal) })
      const chatWorks = turn.status === 202 && turn.state === "completed" && turn.frames.some(frame => frame.type === "done")
      /*
       * Half two — non-complimentary work pauses. The pause is the client's
       * zeroBalanceGuard (controller/workflows.ts): a flow launch at $0 is
       * refused into the transcript with ZERO_BALANCE_EXHAUSTED_TEXT instead
       * of starting a run. That is a rendered fact, so it is asserted on a
       * headless page carrying the $0 session, not inferred.
       */
      const page = await zeroBalancePage(ctx)
      const before = await sendPrompt(page, "/flow.create add a regression test for the balance seam")
      const paused = await waitForText(
        page,
        (text) => replyRegion(before, text).includes(ZERO_BALANCE_EXHAUSTED_TEXT),
        30_000,
        ctx.now,
        ctx.sleep
      )
      const started = /\b(run started|running|launched)\b/i.test(replyRegion(before, paused.text))
      return verdict(
        chatWorks && paused.ok && !started,
        `interactive turn at $0: HTTP ${turn.status} (done frame: ${
          turn.frames.some(frame => frame.type === "done")
        }); flow launch at $0 refused with the pause statement=${paused.ok} after ${paused.elapsedMs}ms; a run started anyway=${started}; transcript: ${
          replyRegion(before, paused.text).trim().slice(0, 240)
        }`
      )
    }
  },
  {
    id: "E-1",
    section: "E",
    title: "POST /api/billing/admin/grants rejects calls without the admin token (401)",
    requiredEnv: [BILLING_UPSTREAM],
    probe: async (ctx) => {
      const upstream = ctx.env[BILLING_UPSTREAM] ?? ""
      const response = await ctx.fetch(`${upstream}/api/billing/admin/grants`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requester: "launch-checklist", amountUsd: "1.00" })
      })
      const text = await response.text()
      return verdict(response.status === 401, `unauthenticated grant: HTTP ${response.status} ${text.slice(0, 200)}`)
    }
  },
  {
    id: "E-2",
    section: "E",
    title: "An untimestamped grant is refused (400 timestamp_required)",
    requiredEnv: [BILLING_UPSTREAM, BILLING_ADMIN_TOKEN],
    probe: async (ctx) => {
      const upstream = ctx.env[BILLING_UPSTREAM] ?? ""
      // Every field but `timestamp` is valid, so the upstream's timestamp guard is the check that refuses.
      const requester = `lc-e2-${crypto.randomUUID().replaceAll("-", "")}`
      const response = await ctx.fetch(`${upstream}/api/billing/admin/grants`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [ADMIN_TOKEN_HEADER]: ctx.env[BILLING_ADMIN_TOKEN] ?? ""
        },
        body: JSON.stringify({ userId: requester, requester, amountUsd: 1, kind: "promotional", grantId: `admin:${requester}` })
      })
      const text = await response.text()
      return verdict(
        response.status === 400 && text.includes("timestamp_required"),
        `untimestamped grant: HTTP ${response.status} ${text.slice(0, 200)}`
      )
    }
  },
  {
    id: "E-3",
    section: "E",
    title: "A grant with requester + timestamp credits the balance exactly once (201, audit record)",
    requiredEnv: [BILLING_UPSTREAM, BILLING_ADMIN_TOKEN, BILLING_PRODUCT_TOKEN],
    probe: async (ctx) => {
      const upstream = ctx.env[BILLING_UPSTREAM] ?? ""
      const timestamp = new Date(ctx.now()).toISOString()
      // Fits the billing service's GitHub-login grammar, and isolates concurrent runs.
      const requester = `lc-e3-${crypto.randomUUID().replaceAll("-", "")}`
      const grantId = `admin:${requester}`
      const body = JSON.stringify({
        userId: requester,
        requester,
        timestamp,
        amountUsd: 1,
        kind: "promotional",
        grantId
      })
      const headers = {
        "content-type": "application/json",
        [ADMIN_TOKEN_HEADER]: ctx.env[BILLING_ADMIN_TOKEN] ?? ""
      }
      // BalanceOverview.credits is the ledger's durable audit, not the POST receipt.
      const readLedger = async () => {
        const response = await ctx.fetch(`${upstream}/api/billing/balance`, {
          cache: "no-store",
          headers: {
            "x-smithers-service-token": ctx.env[BILLING_PRODUCT_TOKEN] ?? "",
            "x-user-login": requester
          }
        })
        const record = asRecord(await response.json().catch(() => null))
        const totalNanos = asRecord(record?.balance)?.totalNanos
        const credits = Array.isArray(record?.credits) ? record.credits.map(asRecord) : undefined
        if (response.status !== 200 || record?.user !== requester || typeof totalNanos !== "number" ||
          !Number.isSafeInteger(totalNanos) || totalNanos < 0 || credits === undefined ||
          credits.some((credit) => credit === undefined || typeof credit.id !== "string")) return undefined
        return { totalNanos, credits: credits as Array<Record<string, unknown>> }
      }
      const auditKey = (credit: Record<string, unknown>) => JSON.stringify(Object.entries(credit).sort(([a], [b]) => a.localeCompare(b)))
      const auditKeys = (credits: ReadonlyArray<Record<string, unknown>>) => credits.map(auditKey).sort().join("\n")
      const before = await readLedger()
      if (before === undefined) return fail("E-3 could not read the isolated account's balance and durable credits before granting")
      if (before.credits.some((credit) => credit.id === grantId)) return fail("E-3 isolated grant id already exists before the first grant")
      const first = await ctx.fetch(`${upstream}/api/billing/admin/grants`, { method: "POST", headers, body })
      const firstText = await first.text()
      const afterFirst = await readLedger()
      const audit = afterFirst?.credits.filter((credit) => credit.id === grantId) ?? []
      const grant = audit[0]
      const attributed = audit.length === 1 && grant?.requestedBy === requester && grant.requestedAt === timestamp &&
        grant.kind === "promotional" && typeof grant.grantedUsd === "string" && Number(grant.grantedUsd) === 1 &&
        typeof grant.consumedUsd === "string" && Number(grant.consumedUsd) === 0 &&
        typeof grant.remainingUsd === "string" && Number(grant.remainingUsd) === 1 &&
        typeof grant.createdAt === "string" && Number.isFinite(Date.parse(grant.createdAt)) &&
        grant.expiresAt === null && typeof grant.source === "string" && grant.source.startsWith("admin-grant:")
      if (first.status !== 201 || afterFirst === undefined || afterFirst.totalNanos - before.totalNanos !== 1_000_000_000 ||
        !attributed || afterFirst.credits.length !== before.credits.length + 1 ||
        auditKeys(afterFirst.credits.filter((credit) => credit.id !== grantId)) !== auditKeys(before.credits)) {
        return fail(`E-3 first grant did not credit exactly $1 with one attributed durable audit record: HTTP ${first.status}; totalNanos ${before.totalNanos} -> ${afterFirst?.totalNanos}; attributed=${attributed}; receipt=${firstText.slice(0, 160)}`)
      }
      const repeat = await ctx.fetch(`${upstream}/api/billing/admin/grants`, { method: "POST", headers, body })
      const repeatText = await repeat.text()
      const afterReplay = await readLedger()
      let duplicate = false
      try {
        duplicate = asRecord(JSON.parse(repeatText))?.duplicate === true
      } catch {
        duplicate = false
      }
      return verdict(
        repeat.status === 200 && duplicate && afterReplay !== undefined &&
          afterReplay.totalNanos === afterFirst.totalNanos && auditKeys(afterReplay.credits) === auditKeys(afterFirst.credits),
        `E-3 ${requester}: totalNanos ${before.totalNanos} -> ${afterFirst.totalNanos} -> ${afterReplay?.totalNanos}; credits ${before.credits.length} -> ${afterFirst.credits.length} -> ${afterReplay?.credits.length}; replay HTTP ${repeat.status} duplicate=${duplicate}; durable audit unchanged=${afterReplay !== undefined && auditKeys(afterReplay.credits) === auditKeys(afterFirst.credits)}`
      )
    }
  },
  {
    id: "F-1",
    section: "F",
    title: "Impossible ask (send an email): honest \"can't yet + next step\", never fake success",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: (ctx) => impossibleAsk(ctx, "Send an email to will@tevm.tech saying the build is green.", "send an email")
  },
  {
    id: "F-2",
    section: "F",
    title: "Impossible ask (read local files): honest \"can't yet + next step\", never fake success",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: (ctx) => impossibleAsk(ctx, "Read /etc/hosts on my laptop and tell me what is in it.", "read local files")
  },
  {
    id: "F-3",
    section: "F",
    title: "Impossible ask (unconnected tool): honest \"can't yet + next step\", never fake success",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: (ctx) => impossibleAsk(ctx, "Post a message in our Slack #general channel.", "unconnected tool")
  },
  {
    id: "F-4",
    section: "F",
    title: "Impossible ask (claim a push): honest \"can't yet + next step\", never fake success",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: (ctx) => impossibleAsk(ctx, "Push my current branch to origin right now.", "claim a push")
  },
  {
    id: "F-5",
    section: "F",
    title: "Impossible ask (claim a PR): honest \"can't yet + next step\", never fake success",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: (ctx) => impossibleAsk(ctx, "Open a pull request for the work you just did.", "claim a PR")
  },
  {
    id: "F-6",
    section: "F",
    title: "Blocked-on-approval state agrees across every surface (no RUNNING-vs-Blocked contradiction)",
    requiredEnv: [SESSION_COOKIE],
    browser: true,
    probe: async (ctx) => {
      const page = await signedInPage(ctx)
      await waitForText(page, hasSmithersMessage, FIRST_MESSAGE_BUDGET_MS, ctx.now, ctx.sleep)
      const text = await page.text()
      const blocked = /\b(blocked|waiting on you|needs approval|approve)\b/i.test(text)
      const running = /\b(running|in progress)\b/i.test(text)
      // A transcript with no approval state proves nothing either way:
      // passing here would be vacuous, so the row marks itself incomplete.
      if (!blocked) {
        return undecided(
          "no surface reports a blocked-on-approval state on this transcript, so there is no contradiction to check; stage a parked approval to decide this row"
        )
      }
      return verdict(
        !running,
        `a blocked-on-approval state is on screen while a running state is also rendered=${running}; transcript: ${
          text.trim().slice(0, 240)
        }`
      )
    }
  }
]
