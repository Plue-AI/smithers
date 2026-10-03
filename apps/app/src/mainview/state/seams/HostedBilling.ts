import { BILLING_OVERVIEW_PATH, BILLING_PLANS_PATH } from "@smthrs/rpc/AgentApiRoutes"
import { BillingOverviewSchema, BillingPlansResponseSchema } from "@smthrs/rpc/BillingPlans"
import { z } from "zod"
import { refusalOf, storedRefusal, type Refusal } from "@smthrs/rpc/Refusal"
import { refusalSentence } from "@smthrs/rpc/RefusalCopy"
import type { Card } from "../AppState"
import type { AppStore } from "../AppStore"

/*
 * The billing checkout seam: POST /api/billing/checkout {plan} and
 * POST /api/billing/portal answer Stripe URLs the browser navigates to.
 * User-only commands — the agent never opens a payment flow. Reference:
 * multi src/smithersCloud/billing.ts.
 */
import type { SeamContext } from "./SeamContext"
import { readErrorMessage, readResult } from "./SeamContext"

/** The overview plus the account's model credit, integer cents. */
const OverviewSchema = BillingOverviewSchema.extend({ credit_balance_cents: z.number().int().optional() })

/** Integer cents as dollars: 1000 is "$10.00". */
export const creditDollars = (cents: number): string =>
  `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`

export interface BillingSeam {
  readonly showBillingPlans: () => Promise<string | { readonly value: string }>
  readonly startCheckout: (plan?: string) => Promise<string | void>
  readonly openBillingPortal: () => Promise<string | void>
}

/** The Stripe session URL out of a billing response body (multi billing.ts sessionUrl). */
const sessionUrl = (body: unknown): string | undefined => {
  const url = (body as { url?: unknown } | null | undefined)?.url
  return typeof url === "string" && url !== "" ? url : undefined
}

/** Only an https: URL is worth opening — anything else is refused, not navigated. */
const isHttps = (url: string): boolean => {
  try {
    return new URL(url).protocol === "https:"
  } catch {
    return false
  }
}

/*
 * The shared session dance: POST, read {url}, refuse non-https, open a tab
 * when a window exists, and always state the act in the transcript so the
 * link survives a blocked popup.
 */
const openSession = async (
  ctx: SeamContext,
  path: string,
  init: RequestInit,
  what: string,
  announce: (url: string) => string,
  current: () => boolean
): Promise<string | void> => {
  let response: Response
  try {
    response = await ctx.http(`${ctx.baseUrl}${path}`, init)
  } catch {
    return `${what} couldn't start — the billing service didn't answer.`
  }
  if (!response.ok) return readErrorMessage(response, `${what} couldn't start right now.`)
  const body = (await response.json().catch(() => undefined)) as unknown
  if (!current()) return "The account changed while billing was loading."
  const url = sessionUrl(body)
  if (url === undefined) return `${what} couldn't start — the billing service didn't return a URL.`
  if (!isHttps(url)) return `${what} was refused — the billing service answered with a non-https URL.`
  await ctx.dispatch({ type: "message.appended", actor: "system", text: announce(url) }).isPersisted.promise
  if (current() && typeof window !== "undefined") window.open(url, "_blank", "noopener")
}

/** A refusal can precede workspace creation; its upgrade door still embeds in the transcript. */
export const renderPlanLimit = async (store: AppStore, refusal: Refusal, checkout: boolean, actor: "user" | "smithers" | "system",
  card: { readonly id: string; readonly title: string } = { id: "billing-plan-limit", title: "Sandbox limit" }) => {
  if (!checkout) return refusalSentence(refusal)
  const account = store.collections.billingAccounts.get("billing")
  await store.dispatch({ type: "card.upsert", actor, card: {
    id: card.id, kind: "billing-plans", title: card.title, status: "active",
    createdAt: Date.now(), ordinal: store.nextOrdinal(), payload: {
      planKey: refusal.plan_key ?? account?.planKey ?? null,
      sandbox: account?.sandbox ?? null, plans: account?.plans ?? [], checkout,
      refusal: storedRefusal(refusal)
    }
  } }).isPersisted.promise
  return refusalSentence(refusal)
}

/** The one out-of-credit refusal the app states when Plue named none: its door buys Pro. */
export const outOfCreditRefusal = (message: string): Refusal =>
  refusalOf({ status: 402, message, body: { code: "out_of_credit", message, upgrade_plan_key: "pro" } })

/**
 * Out of model credit: the plans card with the refusal and its Upgrade door,
 * embedded in the transcript, so the person's next act is one press away.
 */
export const renderCreditExhausted = (store: AppStore, refusal: Refusal, checkout: boolean, actor: "user" | "smithers" | "system") =>
  renderPlanLimit(store, refusal.upgrade_plan_key == null ? { ...refusal, upgrade_plan_key: "pro" } : refusal, checkout, actor,
    { id: "billing-credit-exhausted", title: "Out of model credit" })

export interface BillingCapabilities {
  readonly overview: boolean
  readonly plans: boolean
  readonly checkout: boolean
  readonly portal: boolean
}

export const createBillingSeam = (ctx: SeamContext,
  capabilities: BillingCapabilities,
  disposed: () => boolean = () => false): BillingSeam => {
  const { checkout } = capabilities
  const currentAccount = () => {
    const identity = ctx.store.collections.identitySessions.get("identity")
    return () => !disposed() && ctx.store.collections.identitySessions.get("identity") === identity
  }
  return {
  showBillingPlans: async () => {
    if (!capabilities.plans) return "Plans are unavailable on this host."
    const current = currentAccount()
    try {
      const [overviewResponse, plansResponse] = await Promise.all([
        capabilities.overview ? ctx.http(`${ctx.baseUrl}${BILLING_OVERVIEW_PATH}`) : Promise.resolve(null), ctx.http(`${ctx.baseUrl}${BILLING_PLANS_PATH}`)
      ])
      if ((overviewResponse !== null && !overviewResponse.ok) || !plansResponse.ok) return "Your plans couldn't be refreshed right now."
      const overview = overviewResponse === null ? null : OverviewSchema.safeParse(await overviewResponse.json())
      const catalog = BillingPlansResponseSchema.safeParse(await plansResponse.json())
      if (!current()) return { value: "The account changed while plans were loading." }
      if ((overview !== null && !overview.success) || !catalog.success) return "Your plans couldn't be refreshed right now."
      const details = overview?.success ? overview.data : null
      const wire = details?.sandbox
      const sandbox = wire === undefined ? null : {
        concurrentSandboxes: wire.concurrent_sandboxes, concurrentInUse: wire.concurrent_in_use,
        idleTimeoutSecs: wire.idle_timeout_secs, hoursPerDay: wire.hours_per_day,
        secondsUsedToday: wire.seconds_used_today, dayResetsAt: wire.day_resets_at
      }
      const planKey = wire?.plan_key ?? catalog.data.current_plan_key
      const plans = catalog.data.plans
      const creditBalanceCents = details?.credit_balance_cents ?? null
      const creditResetsAt = details?.usage_period_end ?? null
      await ctx.dispatch({ type: "billing.plans.loaded", actor: ctx.actor(), planKey, sandbox, plans, creditBalanceCents, creditResetsAt }).isPersisted.promise
      if (!current()) return "The account changed while plans were loading."
      await ctx.dispatch({ type: "card.upsert", actor: ctx.actor(), card: {
        id: "billing-plans", kind: "billing-plans", title: "Plans", status: "active",
        createdAt: Date.now(), ordinal: ctx.nextOrdinal(), payload: { planKey, sandbox, plans, checkout }
      } }).isPersisted.promise
      if (!current()) return "The account changed while plans were loading."
      return readResult(`Current plan: ${planKey}.${creditBalanceCents === null ? "" : ` Credit: ${creditDollars(creditBalanceCents)}.`}${sandbox === null ? "" : ` Running sandboxes: ${sandbox.concurrentInUse} / ${sandbox.concurrentSandboxes}. Sandbox-hours today: ${sandbox.secondsUsedToday / 3600} / ${sandbox.hoursPerDay === -1 ? "unlimited" : sandbox.hoursPerDay}. Resets at ${sandbox.dayResetsAt}.`} Plans: ${plans.map(plan => `${plan.display_name} $${plan.price_cents / 100}`).join(", ")}.${checkout ? "" : " Checkout is not open yet."}`)
    } catch {
      return "Your plans couldn't be refreshed and saved right now."
    }
  },
  startCheckout: (plan) => {
    if (plan === "max") {
      return ctx.dispatch({ type: "message.appended", actor: ctx.actor(), text: "Max is not for sale. Upgrade to Pro." }).isPersisted.promise.then(() => undefined)
    }
    if (!checkout) {
      return ctx.dispatch({ type: "message.appended", actor: ctx.actor(), text: "Checkout is not open yet." }).isPersisted.promise.then(() => undefined)
    }
    return openSession(
      ctx,
      "/api/billing/checkout",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        // Name the plan: an omitted key would fall to a server default.
        body: JSON.stringify({ plan: plan ?? "pro" })
      },
      "Checkout",
      (url) => `Checkout is ready: ${url}`,
      currentAccount()
    )
  },
  openBillingPortal: () => {
    if (!capabilities.portal) return Promise.resolve("The billing portal is unavailable on this host.")
    return openSession(
      ctx,
      "/api/billing/portal",
      { method: "POST" },
      "The billing portal",
      (url) => `Your billing portal: ${url}`,
      currentAccount()
    )
  }
  }
}

export const showHostedBalance = async (store: AppStore, refreshBalance: () => Promise<void>, balanceAvailable: boolean): Promise<string | { readonly value: string }> => {
    if (!balanceAvailable) return "Balance is unavailable on this host."
    await refreshBalance()
    const account = store.collections.billingAccounts.get("billing")
    if (account === undefined || account.state === "unknown" || account.state === "unavailable") {
      return "The billing service didn't answer, so there is no balance to state right now."
    }
    // One balance card, re-surfaced at the end of the transcript each time it
    // is asked for: leaving it at its old ordinal would answer the command
    // with a silent no-op once the conversation has moved past it.
    const card: Card = {
      id: "billing-balance",
      kind: "balance",
      title: "Balance",
      status: "active",
      createdAt: Date.now(),
      ordinal: store.nextOrdinal(),
      payload: {
        totalUsd: account.totalUsd ?? "0",
        state: account.state,
        allowedToStartWork: account.allowedToStartWork,
        lifetimeChargedUsd: account.lifetimeChargedUsd ?? "0",
        chargeCount: account.chargeCount,
        // The first-run line, stated once: an untouched grant reads
        // "You have $500 of usage on us." — after any charge it is gone.
        introUsd: account.chargeCount === 0 ? account.totalUsd : null
      }
    }
    store.dispatch({ type: "card.upsert", actor: "system", card })
    return {
      value: `balance: $${account.totalUsd ?? "0"} left; $${
        account.lifetimeChargedUsd ?? "0"
      } spent across ${account.chargeCount} turn(s)`
    }
  }
