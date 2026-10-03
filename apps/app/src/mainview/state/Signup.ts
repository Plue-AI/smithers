/* Legacy signup records remain decodable for persisted session history and privacy migrations. */
import { z } from "zod"

export const SIGNUP_STAGES = ["sign-in", "account", "poll", "ready", "done"] as const
export type SignupStage = (typeof SIGNUP_STAGES)[number]

export const SignupSchema = z.object({
  stage: z.enum(SIGNUP_STAGES),
  door: z.literal("github").optional(),
  name: z.string().optional(),
  /** Login prefill at the account step; Continue saves the chosen draft here. */
  account: z.string().optional(),
  /** Legacy poll question index. */
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
export const accountSlug = (value: string): string => value.toLowerCase().replace(/[^a-z0-9-]/g, "").slice(0, 39)

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
