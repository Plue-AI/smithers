import { Button } from "@smthrs/ui"
import { useCallback, useSyncExternalStore, type FormEvent } from "react"
import type { UserFailure, UserFailureCopy } from "@smthrs/rpc/UserFailure"
import { describedFailure, FailureNotice } from "./FailureNotice"
import type { LocalAuthController, LocalAuthSnapshot } from "./state/LocalAuth"

/*
 * What the panel was doing when its error arrived: reading whether sign-in is
 * set up, finding it turned off, or signing in. The error text itself (a
 * server body or an exception message) is only the Details.
 */
export type LocalAuthFailureStage = "status" | "unavailable" | "submit"

export const LOCAL_AUTH_FAILURES: Readonly<Record<LocalAuthFailureStage, UserFailureCopy>> = {
  status: { fault: "infra", sentence: "Smithers could not reach sign-in. Not your fault.", actions: ["retry"] },
  unavailable: { fault: "policy", sentence: "Sign-in is turned off on this host.", actions: [] },
  submit: { fault: "user", sentence: "Sign-in didn't work. Check what you entered and try again.", actions: [] }
}

export const localAuthFailure = (state: LocalAuthSnapshot): UserFailure | null => {
  if (state.error === null) return null
  const stage: LocalAuthFailureStage = state.status === null ? "status" : state.status.enabled ? "submit" : "unavailable"
  return describedFailure(`LocalAuth.${stage}`, LOCAL_AUTH_FAILURES[stage], state.error)
}

const value = (form: HTMLFormElement, name: string): string => {
  const control = form.elements.namedItem(name)
  return control instanceof HTMLInputElement ? control.value : ""
}

export const LocalAuthPanel = ({ auth }: { readonly auth: LocalAuthController }) => {
  const state = useSyncExternalStore(auth.subscribe, auth.snapshot, auth.snapshot)
  const focus = useCallback((form: HTMLFormElement | null) => {
    if (form === null || form.dataset.focused === "true") return
    form.dataset.focused = "true"
    const username = form.elements.namedItem("username")
    if (username instanceof HTMLElement) username.focus()
  }, [state.status?.initialized])
  if (!state.open) return null
  const failure = localAuthFailure(state)

  const close = (document: Document): void => {
    auth.close()
    document.querySelector<HTMLElement>('[data-testid="login-github"]')?.focus()
  }

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    const form = event.currentTarget
    const password = value(form, "password")
    const bootstrapToken = value(form, "bootstrapToken")
    void auth.submit({
      username: value(form, "username"),
      password,
      ...(bootstrapToken === "" ? {} : { bootstrapToken })
    }).finally(() => {
      const secret = form.elements.namedItem("password")
      if (secret instanceof HTMLInputElement) secret.value = ""
      const bootstrap = form.elements.namedItem("bootstrapToken")
      if (bootstrap instanceof HTMLInputElement) bootstrap.value = ""
    })
  }

  return (
    <section className="local-auth-dialog" role="dialog" aria-modal="true" aria-label="Sign in" tabIndex={-1}
      ref={node => {
        if (node && !node.contains(node.ownerDocument.activeElement)) {
          (node.querySelector<HTMLElement>("input:not(:disabled), button:not(:disabled), summary") ?? node).focus()
        }
      }}
      onKeyDown={(event) => {
        if (event.key === "Tab") {
          const dialog = event.currentTarget
          const controls = [...dialog.querySelectorAll<HTMLElement>("input:not(:disabled), button:not(:disabled), summary")]
          event.preventDefault()
          if (controls.length === 0) { dialog.focus(); return }
          const current = controls.indexOf(dialog.ownerDocument.activeElement as HTMLElement)
          const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0)
            : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length
          controls[next]!.focus()
          return
        }
        if (event.key !== "Escape") return
        event.preventDefault()
        event.stopPropagation()
        close(event.currentTarget.ownerDocument)
      }}>
      {state.status === null
        ? failure === null ? <div className="local-auth-loading" role="status">Loading…</div>
          : <FailureNotice failure={failure} className="local-auth-loading" data-testid="local-auth-failure"
            actions={{ retry: { onClick: () => auth.open(), disabled: state.pending } }} />
        : <form ref={focus} className="flow-form" onSubmit={submit}>
          <strong>{state.status.initialized ? "Sign in" : "Set up owner"}</strong>
          <label className="flow-form-row" data-required="true">
            <span>Username</span>
            <input name="username" autoComplete="username" defaultValue={state.status.username ?? ""} required disabled={state.pending} />
          </label>
          <label className="flow-form-row" data-required="true">
            <span>Password</span>
            <input name="password" type="password" autoComplete={state.status.initialized ? "current-password" : "new-password"} required disabled={state.pending} />
          </label>
          {!state.status.initialized && auth.requiresBootstrapTokenInput && <label className="flow-form-row" data-required="true">
            <span>Token</span>
            <input name="bootstrapToken" type="password" autoComplete="off" required disabled={state.pending} />
          </label>}
          {failure !== null && <FailureNotice failure={failure} className="local-auth-error" data-testid="local-auth-failure" />}
          <div className="flow-run-actions">
            <Button type="button" variant="ghost" size="sm" onClick={(event) => close(event.currentTarget.ownerDocument)} disabled={state.pending}>Cancel</Button>
            <Button type="submit" size="sm" disabled={state.pending}>{state.status.initialized ? "Sign in" : "Set up"}</Button>
          </div>
        </form>}
      {state.status === null && <Button type="button" variant="ghost" size="sm" onClick={(event) => close(event.currentTarget.ownerDocument)}>Cancel</Button>}
    </section>
  )
}
