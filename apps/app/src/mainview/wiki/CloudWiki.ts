import { Context, Data, Effect, Stream } from "effect"
import { Sse } from "effect/unstable/encoding"
import * as Y from "yjs"
import { z } from "zod"
import { cloudFailure, createCloudClient } from "../state/seams/CloudClient"
import type { SeamFetch } from "../state/seams/SeamContext"

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
/** A wiki space: the public part or the private part of one repository's wiki (#1922). */
export const WikiSpace = z.enum(["public", "private"])
export type WikiSpace = z.infer<typeof WikiSpace>
export const CloudWikiAttachment = z.object({ digest: z.string(), media_type: z.string(), size: z.number().int().nonnegative() })
export const CloudWikiPage = z.object({
  id: positiveId,
  slug: z.string().min(1),
  title: z.string(),
  body: z.string().refine((value) => new TextEncoder().encode(value).length <= 1024 * 1024).default(""),
  revision: positiveId,
  author: z.object({ id: positiveId, login: z.string() }),
  created_at: z.string(),
  updated_at: z.string(),
  /* The space and path the wiki backend added (#1922); absent from an older backend's answer, which is public and slug-named. */
  visibility: WikiSpace.optional(),
  path: z.string().optional(),
  content_digest: z.string().optional(),
  attachment: CloudWikiAttachment.optional()
})
export const CloudWikiDocument = z.object({
  page: CloudWikiPage,
  state: z.string().max(Math.ceil(8 * 1024 * 1024 / 3) * 4),
  state_vector: z.string().max(Math.ceil(8 * 1024 * 1024 / 3) * 4)
})
export type CloudWikiDocument = z.infer<typeof CloudWikiDocument>
export const CloudWikiPageIndex = CloudWikiPage.omit({ body: true })
export const CloudWikiAck = z.object({
  document: CloudWikiDocument,
  update_id: z.string().uuid(),
  accepted_revision: positiveId
})
export const CloudWikiRevision = z.object({
  id: positiveId,
  page_id: positiveId,
  revision: positiveId,
  update_id: z.string().uuid().nullish(),
  deleted: z.boolean(),
  slug: z.string().min(1)
})
export type CloudWikiRevision = z.infer<typeof CloudWikiRevision>

/** One revision as the page history lists it (`GET /wiki/history/{pageID}`): renames and the deletion included. */
export const CloudWikiHistoryRevision = z.object({
  page_id: positiveId,
  revision: positiveId,
  path: z.string(),
  title: z.string(),
  content_digest: z.string(),
  deleted: z.boolean(),
  author: z.object({ id: positiveId, login: z.string() }),
  updated_at: z.string(),
  attachment: CloudWikiAttachment.optional()
})
export type CloudWikiHistoryRevision = z.infer<typeof CloudWikiHistoryRevision>

const wikiLink = z.object({ target: z.string(), heading: z.string().optional(), alias: z.string().optional(), embed: z.boolean(), page_id: positiveId.optional() })
/** The navigation index (`GET /wiki/navigation/index`): every page's metadata and backlinks, the folders, the tags. */
export const CloudWikiIndex = z.object({
  pages: z.array(CloudWikiPage.omit({ body: true }).extend({
    metadata: z.object({
      frontmatter: z.record(z.string(), z.unknown()).nullish(),
      aliases: z.array(z.string()).nullish(),
      tags: z.array(z.string()).nullish(),
      headings: z.array(z.string()).nullish(),
      links: z.array(wikiLink).nullish(),
      error: z.string().optional()
    }),
    backlinks: z.array(z.object({ page_id: positiveId, path: z.string(), heading: z.string().optional(), embed: z.boolean() })).nullish()
  })),
  folders: z.array(z.string()).nullish(),
  tags: z.array(z.string()).nullish()
})
export type CloudWikiIndex = z.infer<typeof CloudWikiIndex>

/** A Wiki failure: one sentence in product words (authored here, or a `refusalLine`), never a server's raw text. */
export class CloudWikiError extends Data.TaggedError("CloudWikiError")<{
  readonly sentence: string
  readonly status?: number
}> {
  /** The sentence is also the error's message, for diagnostics and thrown-value checks. */
  override get message(): string { return this.sentence }
}

export const wikiPagePath = (repo: string, slug: string): string => {
  const parts = repo.split("/")
  if (parts.length !== 2 || parts.some((part) => !/^[\w.-]+$/.test(part) || part === "." || part === "..")) {
    throw new CloudWikiError({ sentence: "Choose a repository as owner/repo." })
  }
  if (!slug || slug === "." || slug === ".." || /[\s/\\]/.test(slug)) {
    throw new CloudWikiError({ sentence: "Choose a Wiki page slug without spaces or slashes." })
  }
  return `/repos/${parts.map(encodeURIComponent).join("/")}/wiki/${encodeURIComponent(slug)}`
}

export const wikiDocumentId = (repo: string, pageId: number): string => `wiki:${repo}:${pageId}`
export const wikiDocumentPath = (repo: string, slug: string): string => `${repo}/wiki/${slug}.md`

/** The collection route of a repository's wiki. */
export const wikiRootPath = (repo: string): string => wikiPagePath(repo, "home").replace(/\/home$/, "")

/** Every wiki request carries its space (#1922): `?visibility=public|private`, joined to whatever query the path already has. */
export const withSpace = (path: string, space: WikiSpace): string => `${path}${path.includes("?") ? "&" : "?"}visibility=${space}`

/** A revision's exact bytes: the route an `<img>` or a download link reads, scoped by page, revision and space. */
export const wikiContentPath = (repo: string, space: WikiSpace, pageId: number, revision: number): string =>
  withSpace(`${wikiRootPath(repo)}/history/${pageId}/${revision}/content`, space)

/** A Markdown path's folder (`Guides/Start.md` → `Guides`), or "" at the root. */
export const wikiFolderOf = (path: string): string => path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""

export const decodeWikiState = (state: string): Uint8Array => {
  const text = atob(state)
  return Uint8Array.from(text, (character) => character.charCodeAt(0))
}
export const encodeWikiState = (bytes: Uint8Array): string => {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

/** Always reconstruct from causal state; seeding a second independent text duplicates it. */
const withDocument = <A>(states: ReadonlyArray<string>, use: (document: Y.Doc) => A): A => {
  const document = new Y.Doc()
  try {
    for (const state of states) Y.applyUpdate(document, decodeWikiState(state))
    return use(document)
  } finally {
    document.destroy()
  }
}

export const mergeWikiState = (...states: ReadonlyArray<string>): { state: string; body: string } =>
  withDocument(states, (document) => ({
    state: encodeWikiState(Y.encodeStateAsUpdate(document)),
    body: document.getText("markdown").toString()
  }))

/** An acknowledgement must contain the submitted causal update, including deletions. */
export const wikiStateContains = (state: string, update: string): boolean =>
  mergeWikiState(state).state === mergeWikiState(state, update).state

/** The editor supplies Markdown; splice only its changed range into the existing Y.Text. */
export const editWikiState = (state: string, body: string, clientId?: number): { state: string; update: string } =>
  withDocument([state], (document) => {
    if (new TextEncoder().encode(body).length > 1024 * 1024) {
      throw new CloudWikiError({ sentence: "A Wiki page cannot exceed 1 MiB of Markdown." })
    }
    if (clientId !== undefined) document.clientID = clientId
    const text = document.getText("markdown")
    const previous = text.toString()
    const vector = Y.encodeStateVector(document)
    let start = 0
    while (start < previous.length && start < body.length && previous[start] === body[start]) start++
    // Y.Text and JavaScript both index UTF-16. Never split a surrogate pair.
    if (start > 0 && /[\uD800-\uDBFF]/.test(previous[start - 1]!)) start--
    let tail = 0
    while (
      tail < previous.length - start && tail < body.length - start &&
      previous[previous.length - 1 - tail] === body[body.length - 1 - tail]
    ) tail++
    if (tail > 0 && /[\uDC00-\uDFFF]/.test(previous[previous.length - tail]!)) tail--
    document.transact(() => {
      text.delete(start, previous.length - start - tail)
      text.insert(start, body.slice(start, body.length - tail))
    })
    const update = Y.encodeStateAsUpdate(document, vector)
    if (update.length > 1024 * 1024) {
      throw new CloudWikiError({ sentence: "This Wiki edit exceeds the 1 MiB update limit." })
    }
    const encoded = Y.encodeStateAsUpdate(document)
    if (encoded.length > 8 * 1024 * 1024) {
      throw new CloudWikiError({ sentence: "This Wiki page exceeds the 8 MiB collaborative state limit." })
    }
    return { state: encodeWikiState(encoded), update: encodeWikiState(update) }
  })

/** Internal app seam: the existing cloud proxy supplies authentication and fetch. */
export class CloudWikiTransport extends Context.Service<CloudWikiTransport, {
  readonly list: (
    repo: string,
    page: number,
    space: WikiSpace
  ) => Effect.Effect<ReadonlyArray<z.infer<typeof CloudWikiPageIndex>>, CloudWikiError>
  readonly read: (repo: string, slug: string, space: WikiSpace) => Effect.Effect<CloudWikiDocument, CloudWikiError>
  readonly update: (
    repo: string,
    slug: string,
    pageId: number,
    updateId: string,
    update: string,
    space: WikiSpace
  ) => Effect.Effect<z.infer<typeof CloudWikiAck>, CloudWikiError>
  readonly revisions: (
    repo: string,
    slug: string,
    pageId: number,
    after: number,
    space: WikiSpace
  ) => Stream.Stream<CloudWikiRevision, CloudWikiError>
  /** The space's navigation index: pages with metadata and backlinks, folders, tags. */
  readonly index: (repo: string, space: WikiSpace) => Effect.Effect<CloudWikiIndex, CloudWikiError>
  /** One page's history, newest first, renames and the deletion included. */
  readonly history: (repo: string, space: WikiSpace, pageId: number, page: number) => Effect.Effect<ReadonlyArray<CloudWikiHistoryRevision>, CloudWikiError>
  /** Create a Markdown page in the space. */
  readonly create: (repo: string, space: WikiSpace, input: { readonly title: string; readonly body: string; readonly path?: string }) => Effect.Effect<z.infer<typeof CloudWikiPage>, CloudWikiError>
  /** Rename or retitle a page against the revision the person saw; a stale revision is a 409 refusal. */
  readonly patch: (repo: string, space: WikiSpace, slug: string, input: { readonly title?: string; readonly path?: string; readonly expected_revision: number }) => Effect.Effect<z.infer<typeof CloudWikiPage>, CloudWikiError>
  readonly remove: (repo: string, space: WikiSpace, slug: string) => Effect.Effect<void, CloudWikiError>
  /** Put an attachment's bytes under a slug: revision 0 creates, a later write names the exact current revision. */
  readonly attach: (repo: string, space: WikiSpace, slug: string, input: { readonly path: string; readonly mediaType: string; readonly expectedRevision: number; readonly bytes: Uint8Array }) => Effect.Effect<z.infer<typeof CloudWikiPage>, CloudWikiError>
}>()("smithers-ui/CloudWikiTransport") {}

export const makeCloudWikiTransport = (
  config: { readonly http: SeamFetch; readonly baseUrl: string }
): typeof CloudWikiTransport.Service => {
  const { url } = createCloudClient(config)
  const response = (path: string, init?: RequestInit) =>
    Effect.tryPromise({
      try: async (signal) => {
        const value = await config.http(url(path), { ...init, signal })
        if (!value.ok) {
          const failure = await cloudFailure(value, `Reading or saving this Wiki page failed (${value.status}).`)
          throw new CloudWikiError({ sentence: failure.error, status: value.status })
        }
        return value
      },
      catch: (error) =>
        error instanceof CloudWikiError ?
          error :
          new CloudWikiError({ sentence: "Could not reach the Wiki. Your pending edits are saved locally." })
    }).pipe(Effect.timeoutOrElse({
      duration: "20 seconds",
      orElse: () =>
        Effect.fail(
          new CloudWikiError({ sentence: "The Wiki request timed out. Pending edits are still saved locally." })
        )
    }))
  const json = <A>(path: string, schema: z.ZodType<A>, init?: RequestInit) =>
    Effect.flatMap(response(path, init), (value) =>
      Effect.tryPromise({
        try: async () => schema.parse(await value.json()),
        catch: () =>
          new CloudWikiError({ sentence: "The Wiki returned an invalid document. Local edits were retained." })
      }))
  const jsonBody = (body: unknown, method = "POST"): RequestInit => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return {
    list: (repo, page, space) =>
      Effect.suspend(() =>
        json(
          withSpace(`${wikiRootPath(repo)}?page=${page}&per_page=50`, space),
          z.array(CloudWikiPageIndex).max(50)
        )
      ),
    read: (repo, slug, space) => Effect.suspend(() => json(withSpace(`${wikiPagePath(repo, slug)}/document`, space), CloudWikiDocument)),
    update: (repo, slug, pageId, updateId, update, space) =>
      Effect.suspend(() =>
        json(
          withSpace(`${wikiPagePath(repo, slug)}/updates`, space),
          CloudWikiAck,
          jsonBody({ page_id: pageId, update_id: updateId, update })
        )
      ),
    index: (repo, space) => Effect.suspend(() => json(withSpace(`${wikiRootPath(repo)}/navigation/index`, space), CloudWikiIndex)),
    history: (repo, space, pageId, page) =>
      Effect.suspend(() => json(withSpace(`${wikiRootPath(repo)}/history/${pageId}?page=${page}&per_page=50`, space), z.array(CloudWikiHistoryRevision).max(50))),
    create: (repo, space, input) => Effect.suspend(() => json(withSpace(wikiRootPath(repo), space), CloudWikiPage, jsonBody(input))),
    patch: (repo, space, slug, input) => Effect.suspend(() => json(withSpace(wikiPagePath(repo, slug), space), CloudWikiPage, jsonBody(input, "PATCH"))),
    remove: (repo, space, slug) => Effect.suspend(() => Effect.asVoid(response(withSpace(wikiPagePath(repo, slug), space), { method: "DELETE" }))),
    attach: (repo, space, slug, input) =>
      Effect.suspend(() => json(
        withSpace(`${wikiRootPath(repo)}/attachments/${encodeURIComponent(slug)}?path=${encodeURIComponent(input.path)}&expected_revision=${input.expectedRevision}`, space),
        CloudWikiPage,
        { method: "PUT", headers: { "content-type": input.mediaType }, body: new Blob([input.bytes as BlobPart], { type: input.mediaType }) }
      )),
    revisions: (repo, slug, pageId, after, space) =>
      Stream.unwrap(Effect.map(
        response(withSpace(`${wikiPagePath(repo, slug)}/stream?page_id=${pageId}&after=${after}`, space), {
          headers: { accept: "text/event-stream" }
        }),
        (value) =>
          value.body === null || !value.headers.get("content-type")?.includes("text/event-stream")
            ? Stream.fail(new CloudWikiError({ sentence: "The Wiki revision stream could not be opened." }))
            : Stream.fromReadableStream({
              evaluate: () => value.body!,
              onError: () => new CloudWikiError({ sentence: "The Wiki revision stream disconnected." })
            }).pipe(
              Stream.decodeText(),
              Stream.pipeThroughChannel(Sse.decode({ maxEventSize: 16 * 1024 })),
              Stream.filter((event) => event.event === "wiki.update" || event.event === "revoked"),
              Stream.mapEffect((event) =>
                event.event === "revoked"
                  ? Effect.fail(new CloudWikiError({ sentence: "Access to this Wiki was revoked.", status: 403 }))
                  : Effect.try({
                    try: () => {
                      const revision = CloudWikiRevision.parse(JSON.parse(event.data))
                      if (
                        revision.page_id !== pageId || String(revision.revision) !== event.id ||
                        revision.id !== revision.revision
                      ) {
                        throw new Error("Mismatched Wiki revision")
                      }
                      return revision
                    },
                    catch: () => new CloudWikiError({ sentence: "The Wiki returned an invalid revision event." })
                  })
              ),
              Stream.mapError((error) =>
                error instanceof CloudWikiError ?
                  error :
                  new CloudWikiError({ sentence: "The Wiki revision stream disconnected." })
              )
            )
      ))
  }
}
