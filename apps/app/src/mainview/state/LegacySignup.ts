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

/** Reconstruct only an old unfinished account row during projector upgrade. */
export const legacySignupForOwner = (login: string): Signup => ({
  ...initialSignup(), stage: "account", door: "github", account: accountSlug(login),
  draft: { account: accountSlug(login) }
})
