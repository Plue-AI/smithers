/**
 * Runtime-selected application/backend targets shared by every Smithers UI host.
 *
 * The document is deployment data, not a build flag. It contains no secret;
 * token material is supplied by the host's auth adapter at request time.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/** Runtime target document version.
 * @since 1.0.0
 * @category models
 */
export const APPLICATION_TARGET_VERSION = 1 as const

/** Supported application shell and backend ownership combinations.
 * @since 1.0.0
 * @category models
 */
export const ApplicationTargetModeSchema = z.enum([
  "web-selfhost",
  "web-plue",
  "local-own",
  "local-plue",
  "native-own",
  "native-plue"
])
/** A supported application shell and backend ownership combination.
 * @since 1.0.0
 * @category models
 */
export type ApplicationTargetMode = z.infer<typeof ApplicationTargetModeSchema>

/** Authentication mechanism applied by the shared application client.
 * @since 1.0.0
 * @category models
 */
export const ApplicationAuthSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("session") }).strict(),
  z.object({ kind: z.literal("bearer") }).strict(),
  z.object({ kind: z.literal("token") }).strict()
])
/** Authentication mechanism applied by the shared application client.
 * @since 1.0.0
 * @category models
 */
export type ApplicationAuth = z.infer<typeof ApplicationAuthSchema>

/** The serializable, secret-free document a web server or native host supplies.
 * @since 1.0.0
 * @category models
 */
export const ApplicationTargetDocumentSchema = z.object({
  apiVersion: z.literal(APPLICATION_TARGET_VERSION),
  mode: ApplicationTargetModeSchema,
  /** Empty means the page's origin. Otherwise this must be an absolute HTTP(S) origin. */
  apiOrigin: z.string().max(2048).default(""),
  auth: ApplicationAuthSchema,
  /** Required when a web page deliberately calls a different Plue origin. */
  cors: z.enum(["same-origin", "credentialed"]).default("same-origin"),
  /** Cross-origin Plue is a developer-only topology and must be opted into explicitly. */
  developerExternal: z.boolean().default(false)
}).strict()
/** A serializable, secret-free runtime target document.
 * @since 1.0.0
 * @category models
 */
export type ApplicationTargetDocument = z.infer<typeof ApplicationTargetDocumentSchema>

/** Application presentation shell.
 * @since 1.0.0
 * @category models
 */
export type ApplicationShell = "web" | "local" | "native"
/** Backend tenancy and ownership model.
 * @since 1.0.0
 * @category models
 */
export type BackendOwnership = "owner" | "plue"
/** Backend process relationship for the selected shell.
 * @since 1.0.0
 * @category models
 */
export type BackendLaunch = "none" | "connect" | "supervisor"

/** Validated target facts used by application transports.
 * @since 1.0.0
 * @category models
 */
export interface ApplicationTarget extends ApplicationTargetDocument {
  readonly shell: ApplicationShell
  readonly ownership: BackendOwnership
  readonly launch: BackendLaunch
  /** Empty for same-origin requests; otherwise the normalized external origin. */
  readonly baseUrl: string
}

const modeFacts: Readonly<
  Record<ApplicationTargetMode, {
    readonly shell: ApplicationShell
    readonly ownership: BackendOwnership
    readonly launch: BackendLaunch
  }>
> = {
  "web-selfhost": { shell: "web", ownership: "owner", launch: "none" },
  "web-plue": { shell: "web", ownership: "plue", launch: "none" },
  "local-own": { shell: "local", ownership: "owner", launch: "connect" },
  "local-plue": { shell: "local", ownership: "plue", launch: "none" },
  "native-own": { shell: "native", ownership: "owner", launch: "supervisor" },
  "native-plue": { shell: "native", ownership: "plue", launch: "none" }
}

const normalizedOrigin = (raw: string): string => {
  const value = raw.trim()
  if (value === "") return ""
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Application API origin must be an absolute HTTP(S) origin.")
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Application API origin must use HTTP(S).")
  }
  if (
    url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error("Application API origin cannot contain credentials, a path, a query, or a fragment.")
  }
  return url.origin
}

/** Validate deployment combinations once, before any product request is sent.
 * @since 1.0.0
 * @category conversions
 */
export const resolveApplicationTarget = (
  input: unknown,
  pageOrigin?: string
): ApplicationTarget => {
  const document = ApplicationTargetDocumentSchema.parse(input)
  const facts = modeFacts[document.mode]
  const apiOrigin = normalizedOrigin(document.apiOrigin)
  const normalizedPageOrigin = pageOrigin === undefined ? undefined : normalizedOrigin(pageOrigin)
  const external = apiOrigin !== "" && (normalizedPageOrigin === undefined || apiOrigin !== normalizedPageOrigin)

  if (document.mode === "web-selfhost" && external) {
    throw new Error("web-selfhost must use its serving origin.")
  }
  if (facts.ownership === "owner" && document.auth.kind === "bearer") {
    throw new Error("Owner backends use the owner session or an owner token, not Plue bearer auth.")
  }
  if (facts.ownership === "plue" && external) {
    if (facts.shell === "web" && !document.developerExternal) {
      throw new Error("An external web Plue origin requires developerExternal.")
    }
    if (document.cors !== "credentialed") {
      throw new Error("An external Plue origin requires credentialed CORS.")
    }
    if (document.auth.kind === "session") {
      throw new Error("An external Plue origin requires explicit token auth.")
    }
  }
  if (!external && document.cors === "credentialed") {
    throw new Error("Credentialed CORS is only valid for an external API origin.")
  }
  if ((document.mode === "local-own" || document.mode === "native-own") && apiOrigin === "") {
    throw new Error(`${document.mode} requires the owned backend launch handshake origin.`)
  }

  return { ...document, apiOrigin, ...facts, baseUrl: external ? apiOrigin : "" }
}
