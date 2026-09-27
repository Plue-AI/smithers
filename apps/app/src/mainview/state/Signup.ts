/*
 * The signup onboarding (Will, 2026-09-20): the chat log's opening for a
 * visitor with no account. Hero + GitHub door → account →
 * poll → ready → done. The stage and every answer live on the session row so
 * a reload resumes where the person stopped; `done` is what every later
 * visit reads, and it outlives sign-out as a content-free receipt
 * (AppProjection forgetAccountState). A session saved before this field existed has no stage: a
 * signed-in visitor with none skips the onboarding, a signed-out one starts it.
 */
import { z } from "zod"

export const SIGNUP_STAGES = ["sign-in", "account", "poll", "ready", "done"] as const
export type SignupStage = (typeof SIGNUP_STAGES)[number]

export const SignupSchema = z.object({
  stage: z.enum(SIGNUP_STAGES),
  door: z.literal("github").optional(),
  name: z.string().optional(),
  /** Login prefill at the account step; Continue saves the chosen draft here. */
  account: z.string().optional(),
  /** Index into SIGNUP_QUESTIONS while the stage is `poll`. */
  question: z.number().int().nonnegative(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  /** `owner/repo`, `new`, or absent when skipped. */
  repo: z.string().optional(),
  /** Typed-but-unsubmitted field values, keyed by field name. */
  draft: z.record(z.string(), z.string())
})
export type Signup = z.infer<typeof SignupSchema>

export const initialSignup = (): Signup => ({ stage: "sign-in", question: 0, answers: {}, draft: {} })

export interface SignupQuestion {
  readonly id: string
  readonly text: string
  readonly required: boolean
  readonly kind: "single" | "multi" | "repo" | "free"
  readonly options: ReadonlyArray<string>
}

export const SIGNUP_QUESTIONS: ReadonlyArray<SignupQuestion> = [
  { id: "size", text: "What is the size of your company?", required: false, kind: "single", options: ["Just me", "2–10", "11–50", "51–200", "201–1,000", "1,000+"] },
  { id: "role", text: "What best describes your role?", required: false, kind: "single", options: ["Executive/Owner", "Engineering", "Support", "Marketing", "Product & Design", "Sales", "IT", "Other"] },
  { id: "heard", text: "How did you hear about Smithers?", required: false, kind: "single", options: ["X / Twitter", "GitHub", "YouTube", "Hacker News", "A friend or colleague", "Search", "Other"] },
  { id: "know", text: "Do you already know what you want to automate?", required: false, kind: "single", options: ["Yes", "Not yet"] },
  { id: "models", text: "What models do you usually prefer?", required: false, kind: "multi", options: ["Codex", "Claude", "Open Source", "Gemini", "Grok", "Other"] },
  { id: "repo", text: "Do you have a repo you would like to connect?", required: false, kind: "repo", options: [] },
  { id: "more", text: "Do you have anything else you would like to share?", required: false, kind: "free", options: [] }
]

/** Account names are URL path segments under smithers.sh/: lowercase, digits, hyphens, 2–39 characters. */
export const ACCOUNT_NAME = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/
export const accountSlug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 39)
export const validAccountName = (value: string): boolean => ACCOUNT_NAME.test(value) && value.length >= 2

type IdentityState = "unknown" | "signed-out" | "signed-in" | "unavailable" | undefined

/** Whether the onboarding owns the transcript: a stage short of done, or a signed-out visitor who has not started. */
export const signupActive = (signup: Signup | undefined, identity: IdentityState): boolean =>
  signup === undefined ? identity === "signed-out" : signup.stage !== "done"

/**
 * What the transcript shows while identity has not answered yet. A browser
 * that retains no account owner and no signup row is a first visit: the
 * title paints at once and the doors wait for the definitive signed-out
 * answer, so nothing else flashes first. A retained owner is a returning
 * person, whose transcript is their own.
 */
export const signupOpening = (signup: Signup | undefined, identity: IdentityState, owner: string | null | undefined): "full" | "title" | false => {
  if (signupActive(signup, identity)) return "full"
  if (signup === undefined && (identity === undefined || identity === "unknown") && !owner) return "title"
  return false
}

/**
 * The stage a definitive identity answer moves an unfinished signup to. A
 * browser with no row and no retained owner is meeting its first sign-in:
 * the GitHub door is auth.sign-in's own redirect, so the row starts here, at
 * the account step. A browser that retained an owner is a returning person.
 */
export const signupAfterIdentity = (signup: Signup | undefined, state: "signed-in" | "signed-out", login: string | null, previousOwner: string | null | undefined): Signup | undefined => {
  if (state !== "signed-in" || login === null) return signup
  if (signup === undefined) {
    if (previousOwner) return undefined
    return { ...initialSignup(), stage: "account", door: "github", account: accountSlug(login), draft: { account: accountSlug(login) } }
  }
  // Old releases retained the automatic prefill across an account change.
  // Repair only an untouched form: entered legacy details have no owner
  // receipt, and a chosen slug is not evidence of whose account supplied it.
  if (signup.stage === "account" && signup.question === 0 && signup.account !== undefined &&
    signup.account !== accountSlug(login) && (signup.name ?? "") === "" && signup.repo === undefined &&
    Object.keys(signup.answers).length === 0 &&
    (signup.draft.account === undefined || signup.draft.account === signup.account) &&
    Object.entries(signup.draft).every(([field, value]) => field === "account" || value === "")) {
    return { ...signup, account: accountSlug(login), draft: { ...signup.draft, account: accountSlug(login) } }
  }
  if (signup.stage !== "sign-in") return signup
  return { ...signup, stage: "account", door: signup.door ?? "github", account: signup.account ?? accountSlug(login), draft: { ...signup.draft, account: signup.draft.account ?? accountSlug(login) } }
}
