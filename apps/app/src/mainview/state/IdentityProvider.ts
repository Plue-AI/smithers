import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import type { AppServices } from "./AppController"
import type { IdentitySession } from "./AppState"

export type IdentityProvider = "github" | "local"

/*
 * Which sign-in door an origin has travels as the bootstrap's `authFlow`,
 * never as its `host`: a self-hosted backend is a `cloud` host like the hosted
 * one (packages/rpc/src/AppBootstrap.ts) and differs only here. The Worker's
 * page resolves the default owner target, so the target alone cannot tell the
 * hosted GitHub session from owner credentials; the advertised sign-in flow can.
 */

/** GitHub sessions use either a redirect or a claimed handoff; the target rides that cookie. */
export const hostedSession = (services: Pick<AppServices, "bootstrap" | "applicationTarget">): boolean =>
  (services.bootstrap?.authFlow === "redirect" || signInByHandoff(services.bootstrap)) &&
  (services.applicationTarget === undefined || services.applicationTarget.auth.kind === "session")

/** The owner's own backend, signed in with its credentials (`/api/auth/local/*`): self-host and the owned native backend. */
export const ownerCredentials = (services: Pick<AppServices, "bootstrap" | "applicationTarget" | "localIdentity">): boolean =>
  !hostedSession(services) && services.localIdentity !== undefined &&
  services.applicationTarget?.ownership === "owner" && services.applicationTarget.auth.kind === "session"

/**
 * A sign-in that finishes on the identity upstream and is claimed back: the
 * Bun host's proxied identity (`both`) and the shell's handoff. In a browser
 * that is a popup; the desktop shell's `openExternal` door takes precedence.
 */
export const signInByHandoff = (bootstrap: Pick<AppBootstrap, "authFlow"> | undefined): boolean =>
  bootstrap?.authFlow === "native-handoff" || bootstrap?.authFlow === "both"

/** The selected authentication door, not the spelling of an account's login. */
export const identityProviderFor = (services: Pick<AppServices, "bootstrap" | "applicationTarget" | "applicationIdentity" | "localIdentity">): IdentityProvider =>
  ownerCredentials(services) || (!hostedSession(services) && services.applicationIdentity !== undefined) ? "local" : "github"

/** Backend credentials and bearer identities never establish a GitHub connection. */
export const hasGitHubIdentity = (identity: IdentitySession | undefined, provider: IdentityProvider): boolean =>
  provider === "github" && identity?.state === "signed-in" && identity.provider !== "local"
