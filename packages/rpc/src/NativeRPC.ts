/**
 * Privileged native operations exposed to the application renderer.
 *
 * @since 1.0.0
 */

import type { ApplicationTargetDocument } from "./ApplicationTarget.ts"
/*
 * The one native door the local app keeps on Electrobun RPC (LOCAL-APP.md,
 * "Runtime topology"). Chat rides the local HTTP origin (/api/chat/*), so the
 * agent requests and the agentFrame message are gone. Privileged native
 * operations deliberately have no renderer-controlled HTTP fallback.
 */
/*
 * Structurally an Electrobun `ElectrobunRPCSchema` (`{ bun, webview }`, each
 * with `requests` and `messages`); packages/rpc does not depend on the SDK,
 * which in 2.x lives only in apps/app's Hutch devkit. apps/app's
 * `BrowserView.defineRPC<SmithersNativeRPC>` checks the shape at the use site.
 */
/**
 * The smithers native rpc contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export interface SmithersNativeRPC {
  readonly bun: {
    readonly requests: {
      /**
       * Open a URL in the SYSTEM browser (never the webview). The native
       * sign-in handoff runs GitHub OAuth there because an embedded webview
       * has no platform authenticator; passkeys only work outside.
       */
      readonly openExternal: {
        readonly params: { readonly url: string }
        readonly response: { readonly opened: boolean }
      }
      /**
       * The packaging supervisor's resolved backend. This is configuration,
       * not a native product API: all product traffic still uses HTTP.
       */
      readonly applicationTarget: {
        readonly params: Record<never, never>
        readonly response: { readonly target: ApplicationTargetDocument }
      }
      /** Switch the local API relay and credential together. */
      readonly switchApplicationTarget: {
        readonly params: { readonly origin: string; readonly token: string }
        readonly response: { readonly target: ApplicationTargetDocument }
      }
      /** Token material stays outside the runtime target document. */
      readonly applicationToken: {
        readonly params: Record<never, never>
        readonly response: { readonly token: string | null }
      }
      /**
       * First-owner setup material supplied by the owned native supervisor.
       * It is requested only when the setup form submits and is never part of
       * the persisted target document or renderer state.
       */
      readonly applicationBootstrapToken: {
        readonly params: Record<never, never>
        readonly response: { readonly token: string | null }
      }
    }
    readonly messages: Record<never, never>
  }
  readonly webview: {
    readonly requests: Record<never, never>
    readonly messages: Record<never, never>
  }
}
