import { FailureNotice } from "../FailureNotice"
import { ATTACHMENT_UNAVAILABLE } from "./WikiAttachmentStore"
import { useCallback, useContext, useSyncExternalStore } from "react"
import type { ReactNode } from "react"
import { ControllerContext } from "../ControllerContext"
import type { WikiIndexPage, WikiSpace } from "../state/AppState"
import { attachmentUrl } from "./WikiNavigation"

/** Images and downloads share the selected application's authenticated byte transport. */
export const WikiAttachment = ({ repo, space, page, alt, children }: {
  readonly repo: string
  readonly space: WikiSpace
  readonly page: WikiIndexPage
  readonly alt?: string
  readonly children?: ReactNode
}) => {
  const store = useContext(ControllerContext)?.wikiAttachments
  const path = attachmentUrl(repo, space, page)
  const subscribe = useCallback((listener: () => void) => store?.subscribe(path, listener) ?? (() => {}), [store, path])
  const snapshot = useSyncExternalStore(subscribe, () => store?.get(path), () => undefined)
  const failure = store === undefined ? ATTACHMENT_UNAVAILABLE.error : snapshot?.error
  if (failure !== undefined) return <FailureNotice failure={failure} />
  if (alt !== undefined) return <img src={snapshot?.url} alt={alt} />
  return <a href={snapshot?.url} download={page.path.split("/").pop()} aria-disabled={snapshot?.url === undefined}>{children}</a>
}
