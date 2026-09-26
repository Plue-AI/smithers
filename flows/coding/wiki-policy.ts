/**
 * Fingerprint the review task the running host asks the reviewer to perform,
 * independently of target-repo copies and of the rest of the host build.
 */
import * as Digest from "@smthrs/core/Digest"
import { Effect, FileSystem, Stream } from "effect"
import { fileURLToPath } from "node:url"
import { policySources } from "../wiki/reuse.ts"

// The deployment bundler (build.mjs) injects wikiPolicyIdentity over these
// same files, read at bundle time. Source mode reads them beside this module.
declare const __SMITHERS_CODING_WIKI_POLICY__: string | undefined

const maximumBytes = 2 * 1024 * 1024

/**
 * The identity of the review task: exactly the wiki review policy sources,
 * keyed by repository path. Nothing else in the host build is covered, so a
 * host deploy that leaves the review task alone keeps prior reviews reusable;
 * the reviewer seat and model are part of the reviewer identity beside it.
 */
export const wikiPolicyIdentity = (texts: ReadonlyMap<string, string>): string => {
  const captured = policySources.map((source) => {
    const text = texts.get(source)
    if (text === undefined) throw new Error(`Missing wiki review policy source ${source}`)
    if (new TextEncoder().encode(text).length > maximumBytes) {
      throw new Error("Coding reviewer policy source exceeds 2 MiB")
    }
    return { source, digest: Digest.digest(text) }
  })
  return `policy:${Digest.digest(Digest.canonical(captured))}`
}

export const runningWikiPolicy = Effect.gen(function*() {
  if (typeof __SMITHERS_CODING_WIKI_POLICY__ !== "undefined") {
    if (!/^policy:[a-f0-9]{64}$/.test(__SMITHERS_CODING_WIKI_POLICY__)) {
      return yield* Effect.fail(new Error("Invalid coding host wiki policy fingerprint"))
    }
    return __SMITHERS_CODING_WIKI_POLICY__
  }
  const fs = yield* FileSystem.FileSystem
  const texts = new Map<string, string>()
  for (const source of policySources) {
    const data = yield* Stream.runFoldEffect(
      fs.stream(fileURLToPath(new URL(`../../${source}`, import.meta.url)), {
        bytesToRead: maximumBytes + 1,
        chunkSize: 64 * 1024
      }),
      () => ({ chunks: [] as Array<Uint8Array>, bytes: 0 }),
      (state, chunk) => {
        if (state.bytes + chunk.length > maximumBytes) {
          return Effect.fail(new Error("Coding reviewer policy source exceeds 2 MiB"))
        }
        state.chunks.push(chunk)
        state.bytes += chunk.length
        return Effect.succeed(state)
      }
    )
    const bytes = new Uint8Array(data.bytes)
    let offset = 0
    for (const chunk of data.chunks) {
      bytes.set(chunk, offset)
      offset += chunk.length
    }
    texts.set(source, new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes))
  }
  return yield* Effect.try({ try: () => wikiPolicyIdentity(texts), catch: (error) => error as Error })
})
