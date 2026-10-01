/*
 * The signup onboarding's controller half (state/Signup.ts). Every act is a
 * merge onto the session's signup row; the one sign-in door is GitHub
 * (auth.sign-in), whose identity answer advances the row (signupAfterIdentity).
 *
 * Once the account step is saved, the backend keeps the profile
 * (SIGNUP_PROFILE_PATH): an act that changes it advances the row only after
 * the server's receipt, so a refusal leaves the typed input in place for a
 * retry. A sign-in restores a saved profile into an unclaimed row, which is how
 * a second browser resumes. Acts run one at a time, each reading the row the
 * previous one left.
 */
import { refusalOf } from "@smthrs/rpc/Refusal"
import { refusalSentence } from "@smthrs/rpc/RefusalCopy"
import type { Signup, SignupProfile } from "../Signup"
import { accountSlug, initialSignup, SIGNUP_PROFILE_PATH, SignupProfileSchema, signupProfileOf, validAccountName } from "../Signup"
import { refusalWords, unreachableSentence } from "../seams/SeamContext"
import type { ControllerContext } from "./context"

export interface SignupController {
  readonly signupChange: (patch: Partial<Signup>) => void
  readonly signupSet: (field: string, value: string) => void
  readonly signupAccount: () => Promise<string | void>
  readonly signupNext: () => Promise<string | void>
  readonly signupRepo: (repo: string) => Promise<string | void>
  readonly signupFinish: () => Promise<string | void>
}

const SAVE_FAILED = "Your signup could not be saved."
const READ_FAILED = "Your signup could not be read."

export const createSignupController = (ctx: ControllerContext): SignupController => {
  const { store } = ctx
  const current = (): Signup => store.session().signup ?? initialSignup()
  const change: SignupController["signupChange"] = (patch) => { store.dispatch({ type: "signup.changed", actor: ctx.commandActor, patch }) }

  let tail: Promise<unknown> = Promise.resolve()
  const serial = <T>(work: () => Promise<T>): Promise<T> => {
    const run = tail.then(work, work)
    tail = run.catch(() => undefined)
    return run
  }

  const refusal = async (response: Response, fallback: string): Promise<string> => {
    const body: unknown = await response.json().catch(() => null)
    return refusalSentence(refusalOf({ body, status: response.status, message: refusalWords(body, fallback, response.status) }))
  }

  /** The server's profile for this account generation, once read or written. */
  let known: { readonly epoch: number; readonly profile: SignupProfile | null } | undefined
  const remote = async (): Promise<SignupProfile | null | string> => {
    const epoch = ctx.accountEpoch
    if (known?.epoch === epoch) return known.profile
    let response: Response
    try { response = await ctx.boundedFetch(`${ctx.baseUrl}${SIGNUP_PROFILE_PATH}`, { credentials: "include" }) }
    catch (error) { return unreachableSentence("Smithers", error) }
    if (!response.ok) return refusal(response, READ_FAILED)
    const body: unknown = await response.json().catch(() => null)
    const raw = typeof body === "object" && body !== null && "profile" in body ? body.profile : undefined
    const parsed = raw === null ? null : SignupProfileSchema.safeParse(raw).data
    if (parsed === undefined) return READ_FAILED
    if (epoch !== ctx.accountEpoch) return "You signed in to another account."
    known = { epoch, profile: parsed }
    return parsed
  }

  /** Save the row the patch makes, then apply it. Nothing claimed yet means nothing to save. */
  const commit = async (patch: Partial<Signup>): Promise<string | void> => {
    const profile = signupProfileOf({ ...current(), ...patch })
    if (profile !== undefined) {
      const epoch = ctx.accountEpoch
      let response: Response
      try {
        response = await ctx.boundedFetch(`${ctx.baseUrl}${SIGNUP_PROFILE_PATH}`, {
          method: "PUT", credentials: "include", headers: { "content-type": "application/json" }, body: JSON.stringify(profile)
        })
      } catch (error) { return unreachableSentence("Smithers", error) }
      if (!response.ok) return refusal(response, SAVE_FAILED)
      if (epoch !== ctx.accountEpoch) return "You signed in to another account."
      known = { epoch, profile }
    }
    change(patch)
  }

  const restorable = (signup: Signup | undefined): boolean => signup?.stage === "sign-in" || signup?.stage === "account"

  /** Resume a saved profile into a row that has not claimed an account here. */
  const restore = (): Promise<void> => serial(async () => {
    if (!ctx.accountOwner() || !restorable(store.session().signup)) return
    const profile = await remote()
    if (typeof profile === "string") { ctx.failures.report("seam.failure", new Error(profile), "signup.restore"); return }
    if (profile === null || !restorable(store.session().signup)) return
    const { name: _name, account: _account, ...draft } = current().draft
    change({ ...profile, draft })
  })
  ctx.onDispose(ctx.onAccountChange(() => { void restore() }))

  const signupSet: SignupController["signupSet"] = (field, value) => {
    change({ draft: { ...current().draft, [field]: value } })
  }

  const signupAccount: SignupController["signupAccount"] = () => serial(async () => {
    const signup = current()
    const name = (signup.draft.name ?? signup.name ?? "").trim()
    const account = accountSlug(signup.draft.account ?? signup.account ?? "")
    if (name === "") return "Type your full name."
    if (!validAccountName(account)) return "An account name is 2–39 lowercase letters, digits or hyphens."
    // A profile saved from another browser keeps its answers under the new claim.
    const saved = await remote()
    if (typeof saved === "string") return saved
    const { name: _name, account: _account, ...kept } = saved ?? {}
    return commit(saved === null ? { stage: "poll", name, account, question: 0 } : { ...kept, name, account })
  })

  /*
   * The poll is one question (state/Signup.ts), so answering or skipping it
   * readies the workspace. A row that is not at the poll has no question open:
   * a repository choice cannot skip the account claim.
   */
  const signupNext: SignupController["signupNext"] = () => serial(async () => {
    if (current().stage !== "poll") return "No question is open."
    return commit({ stage: "ready" })
  })

  const signupRepo: SignupController["signupRepo"] = (repo) => serial(async () => {
    const signup = current()
    if (signup.stage !== "poll") return "No question is open."
    return commit({ repo: repo.trim(), answers: { ...signup.answers, repo: repo.trim() }, stage: "ready" })
  })

  const signupFinish: SignupController["signupFinish"] = () => serial(() => commit({ stage: "done" }))

  return { signupChange: change, signupSet, signupAccount, signupNext, signupRepo, signupFinish }
}
