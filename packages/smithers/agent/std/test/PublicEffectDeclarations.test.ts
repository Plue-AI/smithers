import { describe, expect, it } from "vitest"
import * as Manifest from "../src/Manifest.ts"

describe("public per-call effect declarations", () => {
  it.each([false, true])(
    "keeps retrievals sealed, posts irreversible and exploration read-only with optional input=%s",
    (optional) => {
      const result = {
        fetch: Manifest.effectsFor.fetch(
          optional
            ? { url: "https://example.test/private", headers: { Authorization: "dummy secret" }, timeout: 120 }
            : { url: "https://example.test/" }
        ),
        post: Manifest.effectsFor["http-post"](
          optional
            ? {
              url: "https://example.test/private",
              body: "payload",
              headers: { Authorization: "dummy secret" },
              timeout: 120,
              contentType: "text/plain"
            }
            : { url: "https://example.test/", body: "" }
        ),
        webfetch: Manifest.effectsFor.webfetch(
          optional
            ? { url: "https://example.test/private", timeout: 120, format: "html" }
            : { url: "https://example.test/" }
        ),
        websearch: Manifest.effectsFor.websearch(
          optional
            ? { query: "source question", numResults: 20, freshness: "year" }
            : { query: "source question" }
        ),
        explore: Manifest.effectsFor.explore({
          prompt: optional ? "Inspect another package and cite its source" : "Find the entry point"
        })
      }
      expect(result).toEqual({
        fetch: { tier: "sealed", mode: "expected", reads: [], writes: [], onConflict: "serialize" },
        post: { tier: "irreversible", mode: "expected", reads: [], writes: [], onConflict: "serialize" },
        webfetch: { tier: "sealed", mode: "expected", reads: [], writes: [], onConflict: "serialize" },
        websearch: { tier: "sealed", mode: "expected", reads: [], writes: [], onConflict: "serialize" },
        explore: { tier: "sealed", mode: "hermetic", reads: ["/**"], writes: [], onConflict: "serialize" }
      })
    }
  )
})
