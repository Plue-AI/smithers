import { Effect } from "effect"
import type { PlanningWikiProvider } from "./planning-memory.ts"
import { CodingError } from "./schema.ts"

/** Host-owned relay adapter. The shared selector and activation authorizer are
 * required bindings, never repository configuration or a second selector. */
export const relayWikiProvider = (options: {
  readonly relayURL: string
  readonly owner: string
  readonly repository: string
  readonly runCredential: string
  readonly authorize: PlanningWikiProvider["authorize"]
  readonly select: PlanningWikiProvider["select"]
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}): PlanningWikiProvider => {
  const unavailable = () =>
    new CodingError({ code: "unavailable", message: "Authorized wiki relay read is unavailable" })
  const binding = Effect.try({
    try: () => {
      const url = new URL(options.relayURL)
      if (
        !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
        !options.owner || !options.repository || !options.runCredential.trim()
      ) throw unavailable()
      return url
    },
    catch: unavailable
  })
  return {
    authorize: () => binding.pipe(Effect.flatMap(() => options.authorize())),
    select: (request) => binding.pipe(Effect.flatMap(() => options.select(request))),
    read: (slug) =>
      Effect.gen(function*() {
        const base = yield* binding
        yield* options.authorize()
        if (!slug || slug.split("/").some((part) => !part || part === "." || part === "..")) return yield* unavailable()
        const path = `/api/repos/${encodeURIComponent(options.owner)}/${encodeURIComponent(options.repository)}/wiki/${
          encodeURIComponent(slug)
        }`
        return yield* Effect.tryPromise({
          try: async (signal) => {
            const response = await (options.fetch ?? fetch)(new URL(path, base), {
              headers: { Authorization: `Bearer ${options.runCredential}`, Accept: "application/json" },
              redirect: "error",
              signal
            })
            if (!response.ok) {
              await response.body?.cancel()
              throw unavailable()
            }
            const page = await response.json() as Record<string, unknown>
            if (
              typeof page.id !== "number" || !Number.isSafeInteger(page.id) || page.id < 1 ||
              page.slug !== slug || typeof page.revision !== "number" || !Number.isSafeInteger(page.revision) ||
              page.revision < 1 ||
              typeof page.content_digest !== "string" || !/^[0-9a-f]{64}$/.test(page.content_digest) ||
              typeof page.title !== "string" || typeof page.body !== "string" || page.attachment != null
            ) throw unavailable()
            // Generated pages require metadata bound to these same revision bytes;
            // wikiMemory checks their declared inputs inside the machine.
            // Explicit null means authored, including a person-edited generated
            // page. Older APIs without classification cannot enable planning.
            if (!Object.hasOwn(page, "generated")) throw unavailable()
            const generated = page.generated === null ? undefined : page.generated as Record<string, unknown>
            if (
              generated !== undefined && (generated === null || typeof generated.id !== "string" ||
                typeof generated.inputDigest !== "string" || !/^[0-9a-f]{64}$/.test(generated.inputDigest) ||
                typeof generated.sourceRevision !== "string" || !generated.sourceRevision)
            ) throw unavailable()
            return {
              pageID: String(page.id),
              slug,
              revision: page.revision,
              digest: page.content_digest,
              title: page.title,
              markdown: page.body,
              ...(generated === undefined ? {} : {
                generated: {
                  id: generated.id as string,
                  inputDigest: generated.inputDigest as string,
                  sourceRevision: generated.sourceRevision as string
                }
              })
            }
          },
          catch: unavailable
        })
      })
  }
}

/** The configured coding host's binding (T-FLW-10). Selection is the shared
 * preflight selector behind the host API, called with the provisioned run
 * credential, never a second selector here. Only a host whose workspace
 * binding the machine provisioned is isolated; a process runtime refuses
 * citation-enabled planning with isolation_required. */
export const boundRelayWikiProvider = (options: {
  readonly apiBaseUrl: string
  readonly repositorySlug: string
  readonly runCredential: string
  readonly isolated: boolean
  readonly fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>
}): PlanningWikiProvider => {
  const parts = options.repositorySlug.split("/")
  const [owner, repository] = parts.length === 2 ? parts as [string, string] : ["", ""]
  const unavailable = () => new CodingError({ code: "unavailable", message: "Shared wiki selection is unavailable" })
  return relayWikiProvider({
    relayURL: options.apiBaseUrl,
    owner,
    repository,
    runCredential: options.runCredential,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    authorize: () =>
      options.isolated ? Effect.void : Effect.fail(
        new CodingError({ code: "isolation_required", message: "Plans cite wiki pages only inside a branch machine" })
      ),
    select: (request) =>
      Effect.tryPromise({
        try: async (signal) => {
          if (request.kinds.length !== 1 || request.kinds[0] !== "wiki" || !request.prompt.trim()) throw unavailable()
          const path = `/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}/wiki/selection`
          const response = await (options.fetch ?? fetch)(new URL(path, options.apiBaseUrl), {
            method: "POST",
            headers: {
              Authorization: `Bearer ${options.runCredential}`,
              Accept: "application/json",
              "Content-Type": "application/json"
            },
            body: JSON.stringify({ prompt: request.prompt }),
            redirect: "error",
            signal
          })
          if (!response.ok) {
            await response.body?.cancel()
            throw unavailable()
          }
          const body = await response.json() as { readonly pages?: unknown; readonly model?: unknown }
          if (!Array.isArray(body.pages) || typeof body.model !== "string" || !body.model) throw unavailable()
          const slugs: Array<{ readonly slug: string }> = []
          for (const page of body.pages as ReadonlyArray<Record<string, unknown>>) {
            if (
              typeof page?.slug !== "string" || !page.slug || typeof page.revision !== "number" ||
              !Number.isSafeInteger(page.revision) || page.revision < 1 || typeof page.reason !== "string" ||
              slugs.some(({ slug }) => slug === page.slug)
            ) throw unavailable()
            slugs.push({ slug: page.slug })
          }
          return slugs
        },
        catch: unavailable
      })
  })
}
