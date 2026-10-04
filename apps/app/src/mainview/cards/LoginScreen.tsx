/*
 * The login screen (Will, 2026-10-03): what a signed-out visitor of the hosted
 * web app sees first, in the middle of the page (chat.css centers the
 * transcript while the screen owns it). The mark and "Welcome to Smithers"
 * over two doors: Continue with GitHub (sign-in) and an email address
 * (auth.email). No prose beside a button (MINIMAL TEXT). What the email door
 * can do on this host is the controller's answer (#3704).
 */
import { flowAction, flowProps } from "../flows/FlowAction"
import { flowArgs } from "../flows/FlowArgs"
import { WORDMARK } from "../Wordmark"
import type { RunCommand } from "./CardFamily"
import "./LoginScreen.css"

const GitHubMark = () => <svg aria-hidden="true" viewBox="0 0 24 24" width="18" height="18" fill="currentColor"><path d="M12 .5A11.5 11.5 0 0 0 8.36 22.9c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.52-1.33-1.28-1.68-1.28-1.68-1.05-.72.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.7 1.26 3.36.96.1-.75.4-1.26.73-1.55-2.55-.29-5.23-1.28-5.23-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.78 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.25 5.67.41.36.78 1.05.78 2.12v3.14c0 .31.2.67.8.56A11.5 11.5 0 0 0 12 .5z" /></svg>

/** The wordmark's "S" (its first 8 columns, as the favicon draws it), the mark above the welcome. */
const MARK = WORDMARK.map(row => [...row].slice(0, 8).join("")).join("\n")

export function LoginScreen({ onRunCommand }: { readonly onRunCommand: RunCommand }) {
  return <div className="login" data-testid="login">
    <section className="login-welcome" aria-label="Smithers">
      <span className="login-logo" aria-hidden="true"><pre>{MARK}</pre></span>
      <h1>Welcome to Smithers</h1>
    </section>
    <section className="login-doors" aria-label="Sign in">
      <button type="button" className="login-door" data-testid="login-github" {...flowAction(onRunCommand, "sign-in")}><GitHubMark />Continue with GitHub</button>
      <div className="login-or" role="separator" aria-label="or"><span>or</span></div>
      <form className="login-email" {...flowProps("auth.email")} onSubmit={event => {
        event.preventDefault()
        const input = event.currentTarget.elements.namedItem("email")
        const email = input instanceof HTMLInputElement ? input.value.trim() : ""
        if (email !== "") onRunCommand("auth.email", flowArgs("auth.email", { email }))
      }}>
        <input type="email" name="email" autoComplete="email" inputMode="email" spellCheck={false} required aria-label="Email address" placeholder="Email address" data-testid="login-email" />
        <button type="submit" className="login-primary" data-testid="login-email-continue">Continue</button>
      </form>
    </section>
  </div>
}
