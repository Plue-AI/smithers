import type { ComponentType } from "react"
import type { SecretsCardSchema, SecretsViewProps } from "@smthrs/rpc/SecretsCard"
import type { CatalogItem, CommandState } from "../../flows/registry"
import type { LiveTopics } from "../useTopic"
import type { SeamContext } from "./SeamContext"

/** Concrete bindings shared by the install mount and command seam. */
export interface SecretsProviders {
  readonly View: ComponentType<SecretsViewProps> | undefined
  readonly decoder: typeof SecretsCardSchema | undefined
  readonly live: LiveTopics | undefined
  readonly authority: (() => CommandState["viewerRole"]) | undefined
  readonly catalog: (() => ReadonlyArray<CatalogItem> | undefined) | undefined
  /** Scoped Secrets API door; a save receipt never asserts machine delivery. */
  readonly scopedWrite: ((context: SeamContext, url: string, init: RequestInit) => Promise<Response>) | undefined
  readonly family: Readonly<Record<string, unknown>> | undefined
}

export const secretsReadAvailable = (providers: SecretsProviders | undefined): boolean =>
  !!providers?.View && !!providers.decoder && !!providers.live &&
  typeof providers.authority === "function" &&
  providers.catalog?.()?.some(entry => entry.name === "secrets") === true &&
  !!providers.family?.secrets && !("provider-accounts" in providers.family)

export const secretsWriteAvailable = (providers: SecretsProviders | undefined): boolean => {
  if (!secretsReadAvailable(providers) || !providers?.scopedWrite) return false
  const role = providers.authority?.()
  const snapshot = providers.live?.getSnapshot("secrets")
  return (role === "owner" || role === "maintainer") && !!snapshot && !snapshot.error &&
    providers.decoder?.safeParse(snapshot.data).success === true
}
