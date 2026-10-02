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
  /** Index into SIGNUP_QUESTIONS while the stage is `poll`; openSignupQuestion clamps an older row's. */
  question: z.number().int().nonnegative(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  /** `owner/repo`, or absent when skipped. A row saved before 2026-10-01 may hold `new`, which reads as skipped. */
  repo: z.string().optional(),
  /** Typed-but-unsubmitted field values, keyed by field name. */
  draft: z.record(z.string(), z.string())
})
export type Signup = z.infer<typeof SignupSchema>

export const initialSignup = (): Signup => ({ stage: "sign-in", question: 0, answers: {}, draft: {} })

/**
 * The signup profile the backend keeps for the signed-in person
 * (`/api/user/settings/signup`, onboarding_answers): the account claim and the
 * poll answers, so another browser resumes them. It exists once the account
 * step is saved, so its stage is never before `poll`.
 */
export const SIGNUP_PROFILE_PATH = "/api/user/settings/signup"
export const SignupProfileSchema = z.object({
  name: z.string().min(1),
  account: z.string(),
  stage: z.enum(["poll", "ready", "done"]),
  question: z.number().int().nonnegative(),
  answers: z.record(z.string(), z.union([z.string(), z.array(z.string())])),
  repo: z.string().optional()
})
export type SignupProfile = z.infer<typeof SignupProfileSchema>

/** The saved profile of a row, or undefined while nothing is claimed. */
export const signupProfileOf = (signup: Signup): SignupProfile | undefined => {
  const parsed = SignupProfileSchema.safeParse({
    name: signup.name, account: signup.account, stage: signup.stage, question: signup.question, answers: signup.answers,
    ...(signup.repo === undefined ? {} : { repo: signup.repo })
  })
  return parsed.success ? parsed.data : undefined
}

export interface SignupQuestion {
  readonly id: string
  readonly text: string
}

/** The poll is the repository question alone (Will, 2026-10-01): nothing read the other answers. */
export const SIGNUP_QUESTIONS: ReadonlyArray<SignupQuestion> = [
  { id: "repo", text: "Do you have a repo you would like to connect?" }
]

/**
 * The open poll question. A row or saved profile from the seven-question poll
 * can point past this list; it reopens the last question, so nobody mid-poll
 * is left without one.
 */
export const openSignupQuestion = (signup: Pick<Signup, "question">): SignupQuestion =>
  SIGNUP_QUESTIONS[Math.min(signup.question, SIGNUP_QUESTIONS.length - 1)]!

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
 *
 * The account step it opens prefills Full name with the person's GitHub
 * profile name (`displayName`) unless a name was already typed or saved. The
 * backend falls back to the login when GitHub has no name; a login is not a
 * full name, so that fallback prefills nothing.
 */
export const signupAfterIdentity = (signup: Signup | undefined, state: "signed-in" | "signed-out", login: string | null, previousOwner: string | null | undefined, displayName?: string): Signup | undefined => {
  if (state !== "signed-in" || login === null) return signup
  const named = (row: Signup): Signup => displayName === undefined || displayName === login ||
    (row.draft.name ?? "") !== "" || (row.name ?? "") !== "" ? row : { ...row, draft: { ...row.draft, name: displayName } }
  if (signup === undefined) {
    if (previousOwner) return undefined
    return named({ ...initialSignup(), stage: "account", door: "github", account: accountSlug(login), draft: { account: accountSlug(login) } })
  }
  // Old releases retained the automatic prefill across an account change.
  // Repair only an untouched form: entered legacy details have no owner
  // receipt, and a chosen slug is not evidence of whose account supplied it.
  if (signup.stage === "account" && signup.question === 0 && signup.account !== undefined &&
    signup.account !== accountSlug(login) && (signup.name ?? "") === "" && signup.repo === undefined &&
    Object.keys(signup.answers).length === 0 &&
    (signup.draft.account === undefined || signup.draft.account === signup.account) &&
    Object.entries(signup.draft).every(([field, value]) => field === "account" || value === "")) {
    return named({ ...signup, account: accountSlug(login), draft: { ...signup.draft, account: accountSlug(login) } })
  }
  if (signup.stage !== "sign-in") return signup
  return named({ ...signup, stage: "account", door: signup.door ?? "github", account: signup.account ?? accountSlug(login), draft: { ...signup.draft, account: signup.draft.account ?? accountSlug(login) } })
}

/**
 * The signup editor's owner: it keeps its nodes (and typed input) while the
 * same person (provider and login) is signed in, and replaces them when
 * that person changes or signs out. A visitor whose identity answers signed-out after the title
 * painted has no owner either way, so the title never repaints.
 */
export const signupOwnerKey = (identity: { readonly state?: string; readonly provider?: string | null; readonly login?: string | null; readonly accountOwnerLogin?: string | null } | undefined): string =>
  identity?.state === "signed-in" ? `owner:${identity.provider ?? ""}:${identity.accountOwnerLogin ?? identity.login ?? ""}` : "none"
