/**
 * HTTP and WebSocket contracts for the Smithers Cloud seam on the local origin:
 * proxy and tunnel routes, frame caps, close codes, and browser sign-in.
 *
 * @since 1.0.0
 */

import { z } from "zod"
import { HttpUrlSchema } from "./WebUrl.ts"

/*
 * The Smithers Cloud seam on the local origin
 * (apps/app/docs/decisions/0001-piper-one-truth.md): `/api/cloud/*` proxies to
 * the cloud API (SMITHERS_CLOUD_API, default https://api.jjhub.tech) with the
 * Bun-held bearer attached, and the `/api/cloud-auth/*` routes run the CLI's
 * browser login. The token NEVER reaches the renderer: the session answer
 * carries only what a person sees.
 */
/**
 * The cloud route prefix route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_ROUTE_PREFIX = "/api/cloud/"
/*
 * Lane citc: the workspace-terminal WebSocket tunnel. A browser upgrade can
 * carry no custom header, so this route authorizes like `/ws` — the local
 * session capability rides the subprotocol — and Bun bridges the socket to
 * the cloud API's terminal WebSocket with the Bun-held bearer and plue's
 * `terminal` subprotocol attached upstream.
 */
/**
 * The cloud ws route prefix route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_WS_ROUTE_PREFIX = "/api/cloud-ws/"
/*
 * Lane L6 — the cloud language-server relay (plue #505; apps/app/docs/code-intel/
 * PLAN.md "Live"): the same tunnel carries `…/workspace/sessions/{id}/lsp`
 * with plue's `lsp` subprotocol. One JSON-RPC 2.0 message per text frame,
 * 1 MiB per frame; a larger message crosses as `{ seq, last, data }`
 * fragments (seq from 1) that the renderer reassembles, up to 16 MiB. The
 * session is `POST …/workspace/sessions { workspace_id, kind: "lsp",
 * language }`, one per (workspace, language), and the guest's checkout is the
 * server's one workspace folder. A refused upgrade reaches the renderer as a
 * 44xx close code that mirrors plue's HTTP status (ADR 0002's 4401 … 4429,
 * plus 4425 `workspace_session_pending` and 4503 `guest_not_ready`), its
 * reason plue's `code: message` verbatim and, when the refusal named a
 * `Retry-After`, that instruction in words at the end of the reason.
 */
/**
 * Shared cloud ws session kinds used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_WS_SESSION_KINDS = ["terminal", "lsp"] as const
/**
 * The cloud ws session kind contract shared by the host and its clients.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudWsSessionKind = (typeof CLOUD_WS_SESSION_KINDS)[number]
/**
 * Shared cloud lsp subprotocol used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_LSP_SUBPROTOCOL = "lsp"
/** plue's terminal route caps a message at 64 KiB.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_TERMINAL_FRAME_CAP_BYTES = 64 * 1024
/** plue's lsp route caps a frame at 1 MiB; hover and diagnostics exceed 64 KiB.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_LSP_FRAME_CAP_BYTES = 1024 * 1024
/** A fragmented message is reassembled up to this many bytes; past it the message is dropped.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_LSP_REASSEMBLY_CAP_BYTES = 16 * 1024 * 1024
/** The guest's checkout: the server's `rootUri` and its one workspace folder.
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_LSP_ROOT_URI = "file:///home/developer/workspace"
/** One fragment of a message larger than a frame: `seq` counts from 1 and `last` closes the set.
 * @since 1.0.0
 * @category schemas
 */
export const CloudLspFragmentSchema = z.object({ seq: z.number().int().min(1), last: z.boolean(), data: z.string() })
  .strict()
/**
 * The decoded value accepted by {@link CloudLspFragmentSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudLspFragment = z.infer<typeof CloudLspFragmentSchema>
/** The 201 of the session POST with `kind: "lsp"`, as far as the client reads it.
 * @since 1.0.0
 * @category schemas
 */
export const CloudLspSessionSchema = z.object({
  id: z.string().min(1),
  status: z.string(),
  kind: z.literal("lsp"),
  language: z.string().min(1)
})
/**
 * The decoded value accepted by {@link CloudLspSessionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudLspSession = z.infer<typeof CloudLspSessionSchema>
/**
 * Shared cloud ws pending close code used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_WS_PENDING_CLOSE_CODE = 4425
/**
 * Shared cloud ws not ready close code used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_WS_NOT_READY_CLOSE_CODE = 4503
/**
 * A WebSocket close reason is at most 123 UTF-8 bytes; a socket refuses a longer one.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOSE_REASON_MAX_BYTES = 123
/** The close reason with the refusal's `Retry-After` in words; `retryAfterOf` reads it back.
 * The message is shortened, never the suffix, so the result fits {@link CLOSE_REASON_MAX_BYTES}
 * and a host that cuts long reasons from the end cannot drop the wait.
 * @since 1.0.0
 * @category conversions
 */
export const withRetryAfter = (reason: string, seconds: number): string => {
  const encoder = new TextEncoder()
  const suffix = ` (retry after ${seconds} s)`
  const budget = CLOSE_REASON_MAX_BYTES - encoder.encode(suffix).byteLength
  let message = reason.replace(/\s+/g, " ").trim()
  if (encoder.encode(message).byteLength > budget) {
    const ellipsis = "…"
    const room = budget - encoder.encode(ellipsis).byteLength
    let cut = ""
    let used = 0
    for (const char of message) {
      const size = encoder.encode(char).byteLength
      if (used + size > room) break
      cut += char
      used += size
    }
    message = `${cut.trimEnd()}${ellipsis}`
  }
  return `${message}${suffix}`
}
/** The `Retry-After` seconds a close reason names, or null when it names none.
 * @since 1.0.0
 * @category conversions
 */
export const retryAfterOf = (reason: string): number | null => {
  const match = /\(retry after (\d+) s\)$/.exec(reason.trim())
  return match === null ? null : Number(match[1])
}
/**
 * The cloud auth start route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_AUTH_START_PATH = "/api/cloud-auth/start"
/**
 * The cloud auth session route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_AUTH_SESSION_PATH = "/api/cloud-auth/session"
/**
 * The cloud auth sign out route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const CLOUD_AUTH_SIGN_OUT_PATH = "/api/cloud-auth/sign-out"
/**
 * Validates cloud session values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const CloudSessionSchema = z.object({
  state: z.enum(["signed-out", "signing-in", "signed-in"]),
  username: z.string().nullable(),
  expiresAt: z.string().nullable(),
  /**
   * Set when the post-sign-in scope probe (GET /api/user/workspaces) answered
   * 403 insufficient-scope: the legacy token set lacks workspace/agent/
   * approval scopes, so those acts must say "sign in again to enable".
   */
  scopes: z.literal("degraded").optional()
})
/**
 * The decoded value accepted by {@link CloudSessionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudSession = z.infer<typeof CloudSessionSchema>
/** `POST /api/cloud-auth/start`: the sign-in page the app opens. http(s)
 * only, matching the API origins a self-hosted target may use.
 * @since 1.0.0
 * @category schemas
 */
export const CloudAuthStartResponseSchema = z.object({ url: HttpUrlSchema })
/**
 * The decoded value accepted by {@link CloudAuthStartResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type CloudAuthStartResponse = z.infer<typeof CloudAuthStartResponseSchema>
