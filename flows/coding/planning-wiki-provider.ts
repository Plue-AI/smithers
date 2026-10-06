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
            const generated = page.generated as Record<string, unknown> | undefined
            if (
              generated !== undefined && (generated === null || typeof generated.id !== "string" ||
                typeof generated.inputDigest !== "string" || !/^[0-9a-f]{64}$/.test(generated.inputDigest) ||
                typeof generated.sourceRevision !== "string" || !generated.sourceRevision)
            ) throw unavailable()
            if (slug.startsWith("generated-") && generated === undefined) throw unavailable()
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
