/**
 * HTTP and WebSocket contracts for local code intelligence: language-server
 * routes, caps, requests, and answers.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/*
 * Code intelligence on the local origin (apps/app/docs/code-intel/PLAN.md §3):
 * one language server per (repository, language), owned by the Bun host and
 * reached over POST routes the way PTYs are; the renderer never names a
 * binary, an argv, or a cwd. Positions are 1-based on the wire and in flows
 * and converted once at the session. Paths are relative to the repository
 * root and pass the repository path segment check; access is a read.
 * The caps are what the host applies before answering, and the schemas
 * refuse anything past them, so an over-cap answer fails to parse instead of
 * rendering. A missing language server is stated with its install line and
 * never installed.
 */
/** v1 is TypeScript (`typescript-language-server --stdio`); the host's server table gains a row here first.
 * @since 1.0.0
 * @category constants
 */
export const LSP_LANGUAGE_IDS = ["typescript"] as const
/**
 * Validates lsp language id values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LspLanguageIdSchema = z.enum(LSP_LANGUAGE_IDS)
/**
 * The decoded value accepted by {@link LspLanguageIdSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspLanguageId = z.infer<typeof LspLanguageIdSchema>
/**
 * The file extensions each language's server handles. The host registry
 * (apps/app/src/bun/lsp/LanguageServers.ts) reads its rows from here, and the
 * renderer asks the same table which file cards code intelligence serves at
 * all, so a host without the `local.lsp` door can say so on exactly those.
 * @since 1.0.0
 * @category constants
 */
export const LSP_LANGUAGE_EXTENSIONS: Readonly<Record<LspLanguageId, ReadonlyArray<string>>> = {
  typescript: [".ts", ".mts", ".cts", ".tsx", ".js", ".mjs", ".cjs", ".jsx"]
}
/** The language whose server handles the path's extension, or null when no row does.
 * @since 1.0.0
 * @category conversions
 */
export const lspLanguageFor = (path: string): LspLanguageId | null => {
  const extension = /\.[^./]+$/.exec(path)?.[0]?.toLowerCase()
  if (extension === undefined) return null
  return LSP_LANGUAGE_IDS.find((id) => LSP_LANGUAGE_EXTENSIONS[id].includes(extension)) ?? null
}

/** Hover text is cut here; the card and the model see the same text.
 * @since 1.0.0
 * @category constants
 */
export const LSP_HOVER_CAP_CHARS = 4 * 1024
/**
 * Shared lsp diagnostics cap used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const LSP_DIAGNOSTICS_CAP = 50
/**
 * Shared lsp locations cap used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const LSP_LOCATIONS_CAP = 20
/** A request body past this answers 413.
 * @since 1.0.0
 * @category constants
 */
export const LSP_REQUEST_BODY_CAP_BYTES = 64 * 1024
/** One request's ceiling at the host and the client.
 * @since 1.0.0
 * @category constants
 */
export const LSP_REQUEST_TIMEOUT_MS = 5_000
/** The error code of the 409 whose `install` line the card prints.
 * @since 1.0.0
 * @category constants
 */
export const LSP_LANGUAGE_SERVER_MISSING = "language_server_missing"

const lspOrdinal = z.number().int().min(1)
const lspRepoId = z.string().min(1)
/*
 * A repository-root-relative path: no leading slash, no backslash, no control
 * characters, and no empty, `.` or `..` segment, so the contract itself never
 * names a file outside the root. A symlink can still leave it, so a host
 * serving these routes checks containment on disk as well.
 */
const isRootRelativePath = (value: string): boolean =>
  !value.startsWith("/") && !/[\\\u0000-\u001f\u007f]/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
const lspRepoPath = z.string().min(1).max(4096).refine(isRootRelativePath, {
  message: "Expected a path relative to the repository root."
})
/**
 * The digest (the file card's `digest`) of the file text the server was
 * asked about. A file card whose own digest differs shows a file the answer
 * is not about; the renderer re-reads the card before it draws the answer.
 */
const lspDigest = z.string().min(1)
const lspCount = z.number().int().nonnegative()

/** A span, 1-based on both ends; `endCharacter` is exclusive, as the server's is. */
const lspRangeShape = { line: lspOrdinal, character: lspOrdinal, endLine: lspOrdinal, endCharacter: lspOrdinal }
/**
 * Validates lsp range values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LspRangeSchema = z.object(lspRangeShape)
/**
 * The decoded value accepted by {@link LspRangeSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspRange = z.infer<typeof LspRangeSchema>

/** `POST /api/lsp/hover` and `/api/lsp/definition`.
 * @since 1.0.0
 * @category schemas
 */
export const LspPositionRequestSchema = z.object({
  repoId: lspRepoId,
  /** Relative to the repository root. */
  path: lspRepoPath,
  line: lspOrdinal,
  character: lspOrdinal
}).strict()
/**
 * The decoded value accepted by {@link LspPositionRequestSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspPositionRequest = z.infer<typeof LspPositionRequestSchema>
/** `POST /api/lsp/diagnostics`.
 * @since 1.0.0
 * @category schemas
 */
export const LspFileRequestSchema = z.object({ repoId: lspRepoId, path: lspRepoPath }).strict()
/**
 * The decoded value accepted by {@link LspFileRequestSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspFileRequest = z.infer<typeof LspFileRequestSchema>

/**
 * Shared lsp severities used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const LSP_SEVERITIES = ["error", "warning", "information", "hint"] as const
/**
 * Validates lsp severity values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LspSeveritySchema = z.enum(LSP_SEVERITIES)
/**
 * The decoded value accepted by {@link LspSeveritySchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspSeverity = z.infer<typeof LspSeveritySchema>

/** One diagnostic as the card and the model see it; the session maps the server's numeric severity once.
 * @since 1.0.0
 * @category schemas
 */
export const LspDiagnosticSchema = z.object({
  ...lspRangeShape,
  severity: LspSeveritySchema,
  message: z.string(),
  /** The producer as the server names it (`ts`); absent when it names none. */
  source: z.string().optional(),
  /** The server's code as text (`2551`); absent when it names none. */
  code: z.string().optional()
})
/**
 * The decoded value accepted by {@link LspDiagnosticSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspDiagnostic = z.infer<typeof LspDiagnosticSchema>

/** A definition target. `path` is relative to the repository root; the host omits targets outside it.
 * @since 1.0.0
 * @category schemas
 */
export const LspLocationSchema = z.object({ path: z.string().min(1), ...lspRangeShape })
/**
 * The decoded value accepted by {@link LspLocationSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspLocation = z.infer<typeof LspLocationSchema>

/**
 * Validates lsp hover values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LspHoverSchema = z.object({
  /**
   * Markdown as the server wrote it, with the host's absolute paths made
   * repository-relative (or cut to their last segment outside it), then cut
   * at LSP_HOVER_CAP_CHARS.
   */
  contents: z.string().max(LSP_HOVER_CAP_CHARS),
  /** True when the cap cut the server's text; the card and the model state the cut. */
  truncated: z.boolean(),
  /** The token the hover describes, when the server says. */
  range: LspRangeSchema.optional()
})
/**
 * The decoded value accepted by {@link LspHoverSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspHover = z.infer<typeof LspHoverSchema>

/** `POST /api/lsp/hover`: `hover` is null when the server has nothing at the position.
 * @since 1.0.0
 * @category schemas
 */
export const LspHoverResponseSchema = z.object({ hover: LspHoverSchema.nullable(), digest: lspDigest })
/**
 * The decoded value accepted by {@link LspHoverResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspHoverResponse = z.infer<typeof LspHoverResponseSchema>
/**
 * `POST /api/lsp/definition`: `total` is how many targets the server named,
 * `omitted` how many of them lie outside the repository (not a file card the
 * renderer can open), and `locations` the rest up to the cap — so an empty
 * list with `omitted > 0` is a definition elsewhere, never "none found".
 * @since 1.0.0
 * @category schemas
 */
export const LspDefinitionResponseSchema = z.object({
  locations: z.array(LspLocationSchema).max(LSP_LOCATIONS_CAP),
  total: lspCount,
  omitted: lspCount,
  digest: lspDigest
})
/**
 * The decoded value accepted by {@link LspDefinitionResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspDefinitionResponse = z.infer<typeof LspDefinitionResponseSchema>
/**
 * `POST /api/lsp/diagnostics`: `items` is what the server published for
 * `version` up to the cap and `total` how many it published, or both null
 * when it published nothing within the wait. An unread file has no count:
 * the card states none until the stream carries one.
 * @since 1.0.0
 * @category schemas
 */
export const LspDiagnosticsResponseSchema = z.object({
  path: z.string(),
  /** The server's document version the items belong to; null when it names none or has not published. */
  version: z.number().int().nonnegative().nullable(),
  items: z.array(LspDiagnosticSchema).max(LSP_DIAGNOSTICS_CAP).nullable(),
  total: lspCount.nullable(),
  digest: lspDigest
})
/**
 * The decoded value accepted by {@link LspDiagnosticsResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspDiagnosticsResponse = z.infer<typeof LspDiagnosticsResponseSchema>

/** One frame on the WS topic `lsp:<repoId>`: the server's publication for one file.
 * @since 1.0.0
 * @category schemas
 */
export const LspDiagnosticsMessageSchema = z.object({
  type: z.literal("lsp.diagnostics"),
  repoId: z.string(),
  path: z.string(),
  version: z.number().int().nonnegative().nullable(),
  items: z.array(LspDiagnosticSchema).max(LSP_DIAGNOSTICS_CAP),
  total: lspCount,
  digest: lspDigest
})
/**
 * The decoded value accepted by {@link LspDiagnosticsMessageSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspDiagnosticsMessage = z.infer<typeof LspDiagnosticsMessageSchema>

/**
 * Shared lsp server states used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const LSP_SERVER_STATES = ["starting", "ready", "exited"] as const
/**
 * Validates lsp server status values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const LspServerStatusSchema = z.object({
  repoId: z.string(),
  language: LspLanguageIdSchema,
  state: z.enum(LSP_SERVER_STATES)
})
/**
 * The decoded value accepted by {@link LspServerStatusSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspServerStatus = z.infer<typeof LspServerStatusSchema>
/** `GET /api/lsp/servers`
 * @since 1.0.0
 * @category schemas
 */
export const LspServersResponseSchema = z.object({ servers: z.array(LspServerStatusSchema) })
/**
 * The decoded value accepted by {@link LspServersResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspServersResponse = z.infer<typeof LspServersResponseSchema>

/**
 * A failed answer, the `{ error: { code, message } }` envelope the repository
 * routes use. `409 language_server_missing` carries the install line verbatim
 * in `install`; the card prints it and nothing installs it.
 * @since 1.0.0
 * @category schemas
 */
export const LspErrorResponseSchema = z.object({
  error: z.object({ code: z.string(), message: z.string(), install: z.string().optional() })
})
/**
 * The decoded value accepted by {@link LspErrorResponseSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type LspErrorResponse = z.infer<typeof LspErrorResponseSchema>
