import { isWriterOwnershipError, StorageWriteFailedError, type WriterOwnershipError } from "./state/StorageRecoveryContract"
import { useSmithersHere } from "./state/WriterOwnership"
import { useMemo, useState, type CSSProperties } from "react"
import { Data } from "effect"
import { failureDetail, presentUserFailure, type UserFailure, type UserFailureCopy, type UserFailureRegistry } from "@smthrs/rpc/UserFailure"
import { FailureNotice } from "./FailureNotice"
import { createStartupRecovery } from "./StartupRecovery"
import { presentStartupFailure } from "./StartupFailure"
import { BootstrapFailure, type BootstrapFailureKind } from "./runtime/Runtime"
import { switchBackendTarget } from "./runtime/BackendTargetSelection"

/*
 * Both panels below render the same declarations. They are written once, as
 * React style objects, and the DOM builder derives its `style` attribute from
 * them — a cosmetic edit here reaches both paths. Every value is a string so
 * that neither path has to reproduce React's unit handling for numbers.
 *
 * Colours are theme tokens, so dark theme gets light text on a dark page. Each
 * fallback is a light colour for the DOM panel a bundle that never ran shows
 * without tokens.css.
 */

/** The page behind a startup panel; the watchdog's overlay paints it too. */
export const STARTUP_PAGE_BACKGROUND = "var(--bg, #ffffff)"

const PANEL_STYLE = {
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  maxWidth: "44rem",
  margin: "4rem auto",
  padding: "2rem",
  color: "var(--text, #1a1a1a)",
  background: STARTUP_PAGE_BACKGROUND
} as const satisfies CSSProperties

const DETAIL_STYLE = {
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  background: "var(--surface, #f4f1ea)",
  padding: "1rem",
  borderRadius: "8px"
} as const satisfies CSSProperties

const ACTIONS_STYLE = {
  display: "flex",
  flexWrap: "wrap",
  gap: "0.5rem",
  alignItems: "flex-start",
  margin: "1rem 0"
} as const satisfies CSSProperties

const cssText = (style: Readonly<Record<string, string>>): string =>
  Object.entries(style)
    .map(([property, value]) => `${property.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}: ${value}`)
    .join("; ")

/**
 * The detail text one failure gets.
 *
 * Boot survives some errors — a dying OPFS worker is recovered by the
 * localStorage fallback — so an earlier error is offered as context rather than
 * stated as the cause.
 */
export const startupErrorMessage = (reason: unknown, earlier?: unknown): string =>
  earlier === undefined
    ? failureDetail(reason)
    : [
      failureDetail(reason),
      "",
      "Earliest error while the page was blank (some are recovered, so this may not be the cause):",
      failureDetail(earlier)
    ].join("\n")

/** The panel React renders when a boot failure reaches the error boundary. */
type StartupFailure = { readonly kind: "generic" } | WriterOwnershipError | BootstrapFailure | StorageWriteFailedError

const startupFailure = (reason: unknown): StartupFailure =>
  isWriterOwnershipError(reason) || reason instanceof BootstrapFailure || reason instanceof StorageWriteFailedError
    ? reason : { kind: "generic" }

/** Points this shell at another backend; resolves once the page is leaving for it. */
export type BackendSwitch = (origin: string, token: string) => Promise<void>

const nativeBackendSwitch: BackendSwitch = async (origin, token) => {
  const { nativeSwitchBackendTarget } = await import("./native/NativeBridge")
  await nativeSwitchBackendTarget(origin, token)
  window.location.reload()
}

/** The backend address is not a bare http(s) origin. */
export class BackendOriginInvalid extends Data.TaggedError("BackendOriginInvalid")<{ readonly origin: string }> {}

const httpOrigin = (origin: string): string => {
  let url: URL
  try {
    url = new URL(origin)
  } catch {
    throw new BackendOriginInvalid({ origin })
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new BackendOriginInvalid({ origin })
  }
  return url.origin
}

/** A tokenless switch navigates to the origin; a token switch lasts for this tab only. */
export const webBackendSwitch: BackendSwitch = async (origin, token) => {
  const target = httpOrigin(origin)
  if (token === "") {
    window.location.assign(target)
    return
  }
  switchBackendTarget(target, token, window.location.origin)
  window.location.reload()
}

const BACKEND_SWITCH_FAILURES: UserFailureRegistry<BackendOriginInvalid> = {
  BackendOriginInvalid: { fault: "user", sentence: "Enter an http or https origin, like https://backend.example.", actions: [] }
}

const BACKEND_SWITCH_UNKNOWN: UserFailureCopy = { fault: "infra", sentence: "Smithers could not switch to that backend. Not your fault.", actions: [] }

/** What a failed backend switch shows. */
export const presentBackendSwitchFailure = (error: unknown): UserFailure =>
  presentUserFailure(BACKEND_SWITCH_FAILURES, error, { unknown: BACKEND_SWITCH_UNKNOWN })

/* Every bootstrap failure is the backend's, never the person's. */
export const BOOTSTRAP_SENTENCES: Readonly<Record<BootstrapFailureKind, string>> = {
  unreachable: "Smithers could not reach its backend. Not your fault.",
  missing: "This backend does not serve Smithers. Not your fault.",
  server: "The backend could not start Smithers. Not your fault.",
  invalid: "The backend sent a startup reply Smithers cannot read. Not your fault."
}

/** What a bootstrap failure shows. Its kind is the whole story, so it has no detail. */
export const presentBootstrapFailure = (failure: BootstrapFailure): UserFailure => ({
  tag: `BootstrapFailure:${failure.kind}`,
  fault: "infra",
  sentence: BOOTSTRAP_SENTENCES[failure.kind],
  actions: ["retry"],
  detail: ""
})

/** Hosted builds offer Retry only; switching backends is a native and dev tool. */
const shellBackendSwitch = (): BackendSwitch | undefined =>
  window.__electrobun !== undefined ? nativeBackendSwitch
  : (import.meta.env?.DEV as boolean | string | undefined) === true ? webBackendSwitch
  : undefined

function BootstrapErrorPanel({ failure, switchBackend }: {
  readonly failure: BootstrapFailure
  readonly switchBackend: BackendSwitch | undefined
}) {
  const [choosing, setChoosing] = useState(false)
  const [switchFailure, setSwitchFailure] = useState<UserFailure>()
  return <main style={PANEL_STYLE}>
    <h1>Backend unavailable</h1>
    <FailureNotice failure={presentBootstrapFailure(failure)} role="status"
      actions={{ retry: { onClick: () => window.location.reload() } }}>
      {switchBackend !== undefined && <>
        {" "}<button type="button" onClick={() => setChoosing(true)}>Switch backend</button>
      </>}
    </FailureNotice>
    {switchBackend !== undefined && choosing && <form onSubmit={async (event) => {
      event.preventDefault()
      setSwitchFailure(undefined)
      const data = new FormData(event.currentTarget)
      const origin = String(data.get("origin") ?? "").trim()
      const token = String(data.get("token") ?? "").trim()
      try {
        await switchBackend(origin, token)
      } catch (thrown) {
        setSwitchFailure(presentBackendSwitchFailure(thrown))
      }
    }}>
      <label>Backend URL <input name="origin" type="url" required placeholder="https://backend.example" /></label>
      <label>Access token <input name="token" type="password" autoComplete="off" /></label>
      <button type="submit">Connect</button>
      {switchFailure !== undefined && <FailureNotice failure={switchFailure} />}
    </form>}
  </main>
}

export function StartupErrorPanel({ message, reason = message, switchBackend = shellBackendSwitch() }: {
  readonly message?: string
  readonly reason?: unknown
  /** How this shell switches backends; hosted builds have none. */
  readonly switchBackend?: BackendSwitch
}) {
  const failure = startupFailure(reason)
  switch (failure.kind) {
    case "write-failed":
      return <main style={PANEL_STYLE} role="alert">
        <h1>Changes could not be saved</h1>
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </main>
    case "unreachable":
    case "missing":
    case "server":
    case "invalid": return <BootstrapErrorPanel failure={failure} switchBackend={switchBackend} />
    case "writer-held":
      return <main style={PANEL_STYLE}>
        <h1>Smithers is open in another tab</h1>
        <p>Use Smithers here or close that tab and reload.</p>
        <button type="button" onClick={useSmithersHere}>Use Smithers here</button>{" "}
        <button type="button" onClick={() => window.location.reload()}>Reload</button>
      </main>
    case "writer-moved":
      return <main style={PANEL_STYLE}>
        <h1>Smithers moved to another tab</h1>
        <button type="button" onClick={useSmithersHere}>Use Smithers here</button>
      </main>
    case "generic": break
    default: { const exhaustive: never = failure; return exhaustive }
  }
  return <GenericFailurePanel reason={reason} />
}

/** React mounts the DOM panel below, so both paths render one set of declarations. */
function GenericFailurePanel({ reason }: { readonly reason: unknown }) {
  const mount = useMemo(() => {
    const failure = presentStartupFailure(reason)
    return (host: HTMLDivElement | null): (() => void) | undefined => {
      if (host === null) return undefined
      const panel = createStartupErrorElement(host.ownerDocument, failure)
      host.append(panel.element)
      return () => {
        panel.element.remove()
        void panel.dispose().catch(() => {
          console.warn("Smithers: local recovery cleanup could not finish.")
        })
      }
    }
  }, [reason])
  return <div ref={mount} />
}

/** The label of each plain button; the recovery doors bring their own. */
const BUTTON_LABELS = { retry: "Retry", "sign-in": "Sign in", "use-here": "Use Smithers here" } as const

/**
 * The generic failure panel as DOM: one sentence, the failure's actions in
 * order, and the raw detail behind a collapsed Details. The watchdog uses it
 * for a boot that never resolves or a bundle that never ran; React mounts the
 * same builder for a boot that rejected.
 */
export const createStartupErrorElement = (documentTarget: Document, failure: UserFailure) => {
  const view = documentTarget.defaultView
  const panel = documentTarget.createElement("main")
  panel.setAttribute("style", cssText(PANEL_STYLE))
  panel.dataset.fault = failure.fault
  if (failure.tag !== null) panel.dataset.failure = failure.tag
  const heading = documentTarget.createElement("h1")
  heading.textContent = failure.sentence
  const actions = documentTarget.createElement("div")
  actions.setAttribute("style", cssText(ACTIONS_STYLE))
  const button = (label: string, act: () => void): HTMLButtonElement => {
    const element = documentTarget.createElement("button")
    element.type = "button"
    element.textContent = label
    element.onclick = act
    return element
  }
  let recovery: ReturnType<typeof createStartupRecovery> | undefined
  for (const action of failure.actions) {
    switch (action) {
      case "retry":
        actions.append(button(BUTTON_LABELS.retry, () => view?.location.reload()))
        break
      case "sign-in":
        actions.append(button(BUTTON_LABELS["sign-in"], () => view?.location.assign("/")))
        break
      case "use-here":
        actions.append(button(BUTTON_LABELS["use-here"], useSmithersHere))
        break
      case "download-recovery":
      case "reset-local-data":
        if (recovery === undefined) {
          recovery = createStartupRecovery(documentTarget, undefined, undefined, {
            download: failure.actions.includes("download-recovery"),
            reset: failure.actions.includes("reset-local-data")
          })
          actions.append(recovery.element)
        }
        break
      default: {
        const exhaustive: never = action
        return exhaustive
      }
    }
  }
  const details = documentTarget.createElement("details")
  const summary = documentTarget.createElement("summary")
  summary.textContent = "Details"
  const detail = documentTarget.createElement("pre")
  detail.setAttribute("style", cssText(DETAIL_STYLE))
  detail.textContent = failure.detail
  details.append(summary, detail)
  panel.append(heading, actions, details)
  return { element: panel, dispose: (): Promise<void> => recovery?.dispose() ?? Promise.resolve() }
}
