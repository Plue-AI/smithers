/*
 * The app itself as a flow target (docs/web-mode/PLAN.md §3): the web app's
 * one door to the native app.
 *
 * `app.download` opens the download URL through whatever shell the page has —
 * the native shell's openExternal door when present, otherwise a new browser
 * tab. `app.download.prompt` renders the refusal card whose action IS that
 * flow, mirroring auth.prompt / auth.sign-in: `window.open` outside a user
 * gesture is popup-blocked, so the card is the prompt and the click is the
 * human's. Commands.ts renders the same card for every native-only miss, so a
 * typed slash, a button and the agent's tool call all answer alike.
 *
 * The door exists only when there is something behind it: until a native
 * release carries an asset (AppLinks.ts, null today) no button is rendered
 * anywhere and the card says so in words.
 */
import { DOWNLOAD_URL } from "@smthrs/rpc/AppLinks"
import { downloadAnswers } from "../../flows/Commands"
import { identityMessage } from "../../Onboarding"
import type { AppServices } from "../AppController"
import { activeRepositoryId } from "../RepoContext"
import type { ControllerContext } from "./context"

export interface AppShellController {
  /** The download URL this page offers: the composition root's, else the shared constant; null when no native build is published. */
  readonly downloadUrl: string | null
  /** The `app.download` handler: open the download page; an honest refusal string when no door opened. */
  readonly openDownload: (reservedOpen?: (url: string) => Promise<boolean>) => Promise<string | void>
  /**
   * The `app.download.prompt` handler: the refusal card for the flow it is
   * given, classified against the registry so it never stamps "not in the web
   * app" on a flow that is; a refusal string when the native app is not the
   * answer. Blank or prose renders the generic card.
   */
  readonly promptDownload: (flow?: string) => string | void
  /**
   * The `smithers.who` handler: the identity line (Onboarding.ts
   * identityMessage) rendered as a Smithers message and handed back as the
   * value, so the human's slash, a button and the agent's tool call all read
   * the same sentence.
   */
  readonly introduce: () => { readonly value: string }
}

/** The sentence a local-door refusal card carries after the flow it names. */
export const NATIVE_ONLY_TEXT =
  "Local repositories, terminals, build targets and local agents need the native app."

/** The sentence a cloud.pat refusal card carries: the door is the native app's Smithers Cloud session. */
export const CLOUD_SESSION_TEXT = "It needs the native app's Smithers Cloud session."

/** What the card says instead of a button while no native release carries an asset. */
export const NOT_DOWNLOADABLE_TEXT = "The native app is not downloadable yet."

export const DOWNLOAD_ACTION = { flow: "app.download", label: "Download the app" } as const

/** The one place the page's download URL is resolved: injected by the composition root, else the shared constant. */
export const downloadUrlOf = (services: AppServices): string | null =>
  services.downloadUrl === undefined ? DOWNLOAD_URL : services.downloadUrl

export const createAppShellController = (ctx: ControllerContext): AppShellController => {
  const downloadUrl = downloadUrlOf(ctx.services)

  const openDownload = async (reservedOpen?: (url: string) => Promise<boolean>): Promise<string | void> => {
    if (downloadUrl === null) return NOT_DOWNLOADABLE_TEXT
    const openExternal = reservedOpen ?? ctx.services.openExternal
    if (openExternal !== undefined) {
      const opened = await openExternal(downloadUrl)
      return opened ? undefined : `The system browser did not open — the download page is ${downloadUrl}`
    }
    if (typeof window === "undefined") return `No browser window to open — the download page is ${downloadUrl}`
    // `noopener` makes the new tab a stranger to this one; per spec the call then returns null, so nothing is checked.
    window.open(downloadUrl, "_blank", "noopener")
  }

  const promptDownload = (flow?: string): string | void => {
    const named = flow?.trim().replace(/^\/+/, "") ?? ""
    if (named !== "" && ctx.commands.find(named) !== undefined) return `/${named} is in the web app — run it.`
    const absent = named === "" ? undefined : ctx.commands.explainAbsent(named)
    // A door the native app does not answer: the sentence is the whole answer, and no card claims otherwise.
    if (absent !== undefined && !downloadAnswers(absent.door)) return absent.reason
    // A named native-only flow reads by its door; blank or prose (a name no host has) reads generically.
    const subject = absent === undefined ? "That" : `/${named}`
    const door = absent?.door === "cloud.pat" ? CLOUD_SESSION_TEXT : NATIVE_ONLY_TEXT
    const text = `${subject} is not in the web app. ${door}`
    ctx.store.dispatch({
      type: "message.appended",
      actor: "system",
      text: downloadUrl === null ? `${text} ${NOT_DOWNLOADABLE_TEXT}` : text,
      ...(downloadUrl === null ? {} : { action: DOWNLOAD_ACTION })
    })
  }

  const introduce = (): { readonly value: string } => {
    const { collections } = ctx.store
    const value = identityMessage({
      bootstrap: ctx.services.bootstrap,
      connectors: [...collections.connectors.values()],
      repositories: [...collections.repositories.values()],
      // The same selection the agent runtime context reports (controller/turns.ts activeRepository).
      activeRepository: activeRepositoryId(ctx.store),
      registered: (flow) => ctx.commands.find(flow) !== undefined
    })
    ctx.store.dispatch({ type: "message.appended", actor: "smithers", text: value })
    return { value }
  }

  return { downloadUrl, openDownload, promptDownload, introduce }
}
