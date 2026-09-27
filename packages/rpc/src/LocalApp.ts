/**
 * HTTP and WebSocket contracts for repositories, harnesses, terminals, and targets.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/*
 * The local-app wire model (apps/app/docs/LOCAL-APP.md "HTTP and WebSocket
 * API"): the harness, repository, and PTY session records the local server
 * answers and the SPA stores. Runtime-free zod, like Cards.ts, so the Bun
 * server, the SPA, and the Playwright doubles validate the same shapes.
 */

/**
 * Shared harness ids used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const HARNESS_IDS = [
  "claude",
  "codex",
  "gemini",
  "kimi",
  "opencode",
  "opencode-kimi",
  "opencode-cerebras",
  "crush",
  "amp",
  "cursor-agent",
  "hermes",
  "pi"
] as const

/**
 * Validates harness values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const HarnessSchema = z.object({
  id: z.enum(HARNESS_IDS),
  displayName: z.string(),
  binary: z.string().nullable(),
  version: z.string().nullable(),
  status: z.enum(["signed-in", "api-key", "binary-only", "unavailable"]),
  account: z.object({ email: z.string().optional(), label: z.string().optional() }).nullable(),
  launch: z.object({ argv: z.array(z.string()) }),
  /**
   * How this harness takes a model (the `HarnessModels` table in
   * @smthrs/harness-detect): the table's verified
   * suggestions and whether it has a list command
   * (`GET /api/harnesses/{id}/models` runs it). Absent when the binary's
   * `--help` names no model flag the app has verified — such a harness runs
   * only as itself, never as a custom agent. Optional so rows persisted
   * before custom agents parse.
   */
  models: z.object({ suggestions: z.array(z.string()), listable: z.boolean() }).optional()
})
/**
 * The decoded value accepted by {@link HarnessSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Harness = z.infer<typeof HarnessSchema>

/**
 * Validates repo workspace values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RepoWorkspaceSchema = z.object({
  /** Relative to the repo root; "." for the root itself. */
  path: z.string(),
  /** The last path segment, or the repo name for the root. */
  title: z.string()
})
/**
 * The decoded value accepted by {@link RepoWorkspaceSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RepoWorkspace = z.infer<typeof RepoWorkspaceSchema>

/**
 * Validates repo values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RepoSchema = z.object({
  id: z.string(),
  path: z.string(),
  name: z.string(),
  git: z.object({ branch: z.string().nullable(), remote: z.string().nullable() }).nullable(),
  /*
   * The jj probe (lane piper): the checkout's own position — its change and
   * commit ids, how many commits it is ahead of trunk, and trunk's bookmark
   * name. Absent when the checkout is not a jj repo or the probe failed;
   * never a fake zero.
   */
  jj: z.object({
    changeId: z.string().nullable(),
    commitId: z.string().nullable(),
    ahead: z.number().int().nonnegative().nullable(),
    bookmark: z.string().nullable()
  }).optional(),
  /** Loader and manifest problems surfaced at open; empty when the open was clean. */
  warnings: z.array(z.string()),
  smithers: z.object({
    detected: z.boolean(),
    workspaceFile: z.string().nullable(),
    declarationFiles: z.array(z.string()),
    reason: z.string(),
    /** Root and child workspaces (LOCAL-APP.md "Repository detection"); detection is nonempty. */
    workspaces: z.array(RepoWorkspaceSchema)
  })
})
/**
 * The decoded value accepted by {@link RepoSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Repo = z.infer<typeof RepoSchema>

/**
 * Validates repo file entry values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RepoFileEntrySchema = z.object({ name: z.string(), kind: z.enum(["file", "dir"]) })
/**
 * The decoded value accepted by {@link RepoFileEntrySchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RepoFileEntry = z.infer<typeof RepoFileEntrySchema>

/*
 * One Smithers target as `smithers-build query '//...' --format json` lists it
 * (LOCAL-APP.md "Targets: load and run"): the loader's `{ label, target,
 * kinds }` row plus the label split into its package and name.
 */
/**
 * Validates target definition values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const TargetDefinitionSchema = z.object({
  label: z.string(),
  target: z.string(),
  /** Open strings: whatever the rule declares, not a closed set the contract pins. */
  kinds: z.array(z.string()),
  package: z.string(),
  name: z.string(),
  /** The detected workspace the loader ran in ("." for the repo root). */
  workspace: z.string(),
  /** The declaration's one-line summary (PACKAGE.ts `summary: "..."`), shown under the label. */
  summary: z.string().optional(),
  /** The declaration marks the target featured (PACKAGE.ts `featured: true`): it leads the Featured view. */
  featured: z.boolean().optional()
})
/**
 * The decoded value accepted by {@link TargetDefinitionSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type TargetDefinition = z.infer<typeof TargetDefinitionSchema>

/** The browser receives an opaque id minted by the local repository authority.
 * @since 1.0.0
 * @category schemas
 */
export const TargetSchema = TargetDefinitionSchema.extend({ id: z.string().min(1) })
/**
 * The decoded value accepted by {@link TargetSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type Target = z.infer<typeof TargetSchema>

/** Splits a `//pkg/path:name` label into its package and name.
 * @since 1.0.0
 * @category conversions
 */
export const splitLabel = (label: string): { readonly package: string; readonly name: string } => {
  const colon = label.lastIndexOf(":")
  if (colon < 0) return { package: label, name: label.replace(/^\/\//, "").split("/").pop() ?? label }
  return { package: label.slice(0, colon), name: label.slice(colon + 1) }
}
