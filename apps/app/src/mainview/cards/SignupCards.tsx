import { flowArgs } from "../flows/FlowArgs"
/*
 * The signup onboarding, rendered in the chat log (state/Signup.ts). One
 * live projection of the session's signup row: the current stage is the
 * open card, and every stage before it collapses to a one-line receipt. Each
 * button is a signup.* flow (or auth.sign-in for GitHub); typed fields ride
 * signup.set so a reload keeps what was typed. No prose beyond the stage's
 * own question or label (MINIMAL TEXT).
 */
import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "../ControllerContext"
import { flowAction, flowProps } from "../flows/FlowAction"
import type { Signup } from "../state/Signup"
import { accountSlug, initialSignup, SIGNUP_QUESTIONS, signupOpening, validAccountName } from "../state/Signup"
import type { RunCommand } from "./CardFamily"
import "./SignupCards.css"

export interface SignupRepo { readonly id: string }

const Check = () => <svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
const GitHubMark = () => <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 .5A11.5 11.5 0 0 0 8.36 22.9c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.05.78 2.12v3.14c0 .31.2.67.8.56A11.5 11.5 0 0 0 12 .5z" /></svg>

const Receipt = ({ text, you }: { text: string; you?: boolean }) => <div className="signup-receipt" data-you={you || undefined}><Check /><b>{text}</b></div>

const HERO_WORDS = ["Automate", "maintaining", "your", "codebase"]

// Keep the editor's newest input while signup.set waits for its command receipt.
// The session draft remains the authority once that exact value is projected.
const pendingSignupValues = new WeakMap<HTMLInputElement | HTMLTextAreaElement, string>()
const signupEditor = (value: string, field: string, onRunCommand: RunCommand) => ({
  defaultValue: value,
  onInput: (event: { currentTarget: HTMLInputElement | HTMLTextAreaElement }) => {
    const typed = event.currentTarget.value
    pendingSignupValues.set(event.currentTarget, typed)
    onRunCommand("signup.set", flowArgs("signup.set", { field, value: typed }))
  },
  ref: (node: HTMLInputElement | HTMLTextAreaElement | null) => {
    if (node === null) return
    const pending = pendingSignupValues.get(node)
    if (pending !== undefined) {
      if (pending !== value) return
      pendingSignupValues.delete(node)
    }
    if (node.ownerDocument.activeElement !== node && node.value !== value) node.value = value
  }
})

/** `doors` false paints the title alone: identity has not answered, so no door is offered yet. */
export function SignupCardBody({ signup, repos, onRunCommand, doors = true }: { signup: Signup; repos: ReadonlyArray<SignupRepo>; onRunCommand: RunCommand; doors?: boolean }) {
  const draft = signup.draft
  const past = (stage: Signup["stage"]) => STAGE_ORDER.indexOf(stage) < STAGE_ORDER.indexOf(signup.stage)
  const receipts = <>
    {past("sign-in") && signup.door !== undefined && <Receipt you text="Signed in with GitHub" />}
    {past("account") && signup.account !== undefined && <Receipt you text={`smithers.sh/${signup.account}`} />}
    {past("poll") && <Receipt you text="Answered" />}
  </>
  return <div className="signup" data-testid="signup" data-stage={signup.stage}>
    {signup.stage === "sign-in" && <section className="signup-hero" aria-label="Smithers">
      <h1>{HERO_WORDS.map((word, i) => <span key={word} className="signup-word" data-accent={i === 3 || undefined} style={{ "--i": i } as React.CSSProperties}>{word}</span>).flatMap((span, i) => i === 0 ? [span] : [" ", span])}</h1>
      <i className="signup-rule" aria-hidden="true" />
    </section>}
    {receipts}
    {signup.stage === "sign-in" && doors && <section className="signup-card signup-doors-card" aria-label="Sign in">
      <div className="signup-doors">
        <button type="button" className="signup-door" data-testid="signup-github" {...flowAction(onRunCommand, "auth.sign-in")}><GitHubMark />Continue with GitHub</button>
      </div>
    </section>}
    {signup.stage === "account" && <section className="signup-card" aria-label="Finish creating your account">
      <h2>Finish creating your account</h2>
      <form className="signup-stack" {...flowProps("signup.account")} onSubmit={event => { event.preventDefault(); onRunCommand("signup.account") }}>
        <label className="signup-field"><span>Full name</span>
          <input type="text" name="name" autoComplete="name" {...signupEditor(draft.name ?? signup.name ?? "", "name", onRunCommand)} data-testid="signup-name" /></label>
        <label className="signup-field"><span>Account</span>
          <span className="signup-url" data-valid={validAccountName(accountSlug(draft.account ?? signup.account ?? "")) || undefined}>
            <span className="signup-prefix">smithers.sh/</span>
            <input type="text" name="account" autoComplete="off" spellCheck={false} {...signupEditor(draft.account ?? signup.account ?? "", "account", onRunCommand)} data-testid="signup-account" />
            {validAccountName(accountSlug(draft.account ?? signup.account ?? "")) && <Check />}
          </span></label>
        <div className="signup-actions"><button type="submit" className="signup-primary" data-testid="signup-account-continue">Continue</button></div>
      </form>
    </section>}
    {signup.stage === "poll" && <PollCard signup={signup} repos={repos} onRunCommand={onRunCommand} />}
    {signup.stage === "ready" && <section className="signup-card signup-ready" aria-label="Your workspace is ready">
      <svg className="signup-mark" viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="32" cy="32" r="29" /><path d="M20 33l8 8 16-17" /></svg>
      <h2>Your workspace is ready!</h2>
      <div className="signup-url-line">smithers.sh/<b>{signup.account}</b></div>
      <button type="button" className="signup-giant" data-testid="signup-finish" {...flowAction(onRunCommand, "signup.finish")}>Start Automating</button>
      <div className="signup-video" data-testid="signup-video" aria-label="Tutorial video"><span className="signup-play" aria-hidden="true"><svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor"><path d="M7 4.5v15l13-7.5z" /></svg></span></div>
    </section>}
  </div>
}

const STAGE_ORDER: ReadonlyArray<Signup["stage"]> = ["sign-in", "account", "poll", "ready", "done"]

function PollCard({ signup, repos, onRunCommand }: { signup: Signup; repos: ReadonlyArray<SignupRepo>; onRunCommand: RunCommand }) {
  const question = SIGNUP_QUESTIONS[signup.question]
  if (question === undefined) return null
  const chosen = [signup.answers[question.id] ?? []].flat()
  const back = signup.question > 0 ? <button type="button" className="signup-ghost signup-back" {...flowAction(onRunCommand, "signup.back")}>Back</button> : null
  const skip = !question.required ? <button type="button" className="signup-ghost" data-testid="signup-skip" {...flowAction(onRunCommand, "signup.next")}>Skip</button> : null
  return <section className="signup-card signup-poll" aria-label={question.text} data-testid="signup-question" data-question={question.id}
    onKeyDown={event => {
      if (question.kind !== "single" && question.kind !== "multi") return
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return
      const index = event.key.length === 1 ? event.key.toUpperCase().charCodeAt(0) - 65 : -1
      const option = question.options[index]
      if (option !== undefined) { event.preventDefault(); onRunCommand("signup.answer", option) }
    }}>
    <div className="signup-progress" aria-hidden="true"><i style={{ width: `${(signup.question / SIGNUP_QUESTIONS.length) * 100}%` }} /></div>
    <h2>{question.text}{question.required && <span className="signup-required" aria-label="required">*</span>}</h2>
    {(question.kind === "single" || question.kind === "multi") && <div className="signup-choices" role={question.kind === "multi" ? "group" : "radiogroup"} aria-label={question.text}>
      {/* The first choice takes focus as each question opens, so the letter keys answer without a pointer. */}
      {question.options.map((option, i) => <button type="button" key={`${question.id}:${option}`} className="signup-choice" role={question.kind === "multi" ? "checkbox" : "radio"} autoFocus={i === 0}
        aria-checked={chosen.includes(option)} style={{ "--i": i } as React.CSSProperties} {...flowAction(onRunCommand, "signup.answer", option)}>
        <span className="signup-key">{String.fromCharCode(65 + i)}</span><span>{option}</span><span className="signup-tick"><Check /></span>
      </button>)}
    </div>}
    {question.kind === "repo" && <div className="signup-repos">
      {repos.map(repo => <button type="button" key={repo.id} className="signup-repo" {...flowAction(onRunCommand, "signup.repo", repo.id)}>
        <span className="signup-repo-name">{repo.id}</span></button>)}
      <button type="button" className="signup-tile" data-testid="signup-new-repo" {...flowAction(onRunCommand, "signup.repo", "new")}>+ Try Smithers on a new repo</button>
    </div>}
    {question.kind === "free" && <textarea className="signup-free" aria-label={question.text} {...signupEditor(signup.draft.more ?? "", "more", onRunCommand)} data-testid="signup-more" />}
    <div className="signup-actions">{back}{skip}
      {question.kind === "multi" && <button type="button" className="signup-primary" disabled={chosen.length === 0} data-testid="signup-continue" {...flowAction(onRunCommand, "signup.next")}>Continue</button>}
      {question.kind === "free" && <button type="button" className="signup-primary" data-testid="signup-send" {...flowAction(onRunCommand, "signup.next")}>Send</button>}
    </div>
  </section>
}

/** Live session projection; the onboarding owns the transcript until its stage is done. */
export function SignupCards() {
  const controller = useController()
  const { collections } = controller.store
  const { data: sessions } = useLiveQuery(q => q.from({ session: collections.sessions }).select(({ session }) => ({ signup: session.signup })))
  const { data: identities } = useLiveQuery(collections.identitySessions)
  const { data: repositories } = useLiveQuery(collections.repositories)
  const signup = sessions[0]?.signup ?? controller.store.session().signup
  // The signup is the hosted GitHub door's; an origin signed in with owner credentials has no account to create.
  const opening = controller.bootstrap !== undefined && controller.identityProvider === "github" && (signup !== undefined || controller.repositoryApp === null) ? signupOpening(signup, identities[0]?.state, identities[0]?.accountOwnerLogin) : false
  if (opening === false) return null
  // Pending DOM input belongs to this owner too, even before its command saves.
  // Same-owner refreshes retain the editor; retirement replaces its nodes.
  return <SignupCardBody key={identities[0]?.ownerRevision ?? 0} signup={signup ?? initialSignup()} doors={opening === "full"} repos={repositories.filter(row => row.catalog !== true).map(row => ({ id: row.id }))} onRunCommand={controller.runCommand} />
}
