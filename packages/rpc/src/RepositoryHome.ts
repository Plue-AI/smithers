/**
 * The server-resolved homepage of a repository at main.
 *
 * @since 1.0.0
 */
import { z } from "zod"

const title = z.string().min(1).max(120)
const flow = z.string().regex(/^[a-z0-9_-]+(?:[./][a-z0-9_-]+)*$/)
const path = z.string().min(1).max(1024).refine((value) =>
  !value.startsWith("/") && !value.includes("\\") &&
  !/[%:?#\x00-\x1f]/.test(value) &&
  value.split("/").every((part) => part !== "" && part !== "." && part !== "..")
)

/** One homepage block after the server resolves markdown content.
 * @category schemas
 * @since 1.0.0
 */
export const RepositoryHomeBlockSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("prompt"), flow: flow.optional(), title: title.optional(), placeholder: title.optional() }),
  /* An app: a featured flow with a picture (D-18); the tiles of the app home. */
  z.object({ type: z.literal("app"), flow, title, picture: z.enum(["issue", "review", "wiki", "schedule"]) }),
  z.object({ type: z.literal("flows"), title: title.optional() }),
  z.object({ type: z.literal("markdown"), path, title: title.optional(), markdown: z.string().max(256 * 1024) }),
  z.object({ type: z.literal("text"), title: title.optional(), text: z.string().min(1).max(4096) }),
  /* The repository's live mythical stack; the app reads it from `@smthrs/rpc/Mythical`. */
  z.object({ type: z.literal("stack"), title: title.optional() }),
  z.object({
    type: z.literal("links"),
    title: title.optional(),
    links: z.array(z.object({
      label: title,
      url: z.url().refine((value) => /^https?:\/\//.test(value))
    })).min(1)
  })
])

/** The homepage resolution result at main.
 * @category schemas
 * @since 1.0.0
 */
export const RepositoryHomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("blocks"), blocks: z.array(RepositoryHomeBlockSchema).max(32) }),
  z.object({ kind: z.literal("readme"), markdown: z.string().max(256 * 1024) }),
  z.object({ kind: z.literal("none") })
])
/** The homepage resolution result at main.
 * @category models
 * @since 1.0.0
 */
export type RepositoryHome = z.infer<typeof RepositoryHomeSchema>
