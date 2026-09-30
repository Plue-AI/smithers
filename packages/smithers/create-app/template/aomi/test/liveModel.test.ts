/**
 * The recording seat's credential source.
 *
 * `liveModel` runs only under `SMTHRS_RECORD=1`, so a replayed `pnpm test`
 * never reaches it and a wrong switch name stays hidden until someone records.
 * `SMITHERS_OPENAI_AUTH=chatgpt` is the spelling the CLI and its docs give the
 * ChatGPT-subscription credential. This module used to read a pre-rename
 * `FLOWS_OPENAI_AUTH`, so an operator who set the documented variable was asked
 * for an `OPENAI_API_KEY` they had deliberately left unset.
 */
import * as ModelRequest from "@smthrs/model/ModelRequest"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { liveModel } from "./support/liveModel.ts"

const homes: Array<string> = []

afterEach(() => {
  vi.unstubAllEnvs()
  while (homes.length > 0) rmSync(homes.pop()!, { recursive: true, force: true })
})

// No `maxTokens`: the ChatGPT-subscription route refuses a budget before it
// reads any credential.
const request = ModelRequest.ModelRequest.make({
  modelId: "gpt-5",
  system: [],
  messages: [],
  tools: [],
  params: ModelRequest.GenerationParams.make({})
})

describe("liveModel", () => {
  it("routes an openai seat to the codex ChatGPT session under SMITHERS_OPENAI_AUTH=chatgpt", async () => {
    // The ChatGPT session is the vendor's signed-in Codex CLI. With no `codex`
    // on PATH the route refuses before any request leaves the process, and
    // names the sign-in that fixes it rather than the API key left unset.
    const home = mkdtempSync(join(tmpdir(), "smthrs-codex-home-"))
    homes.push(home)
    vi.stubEnv("SMITHERS_OPENAI_AUTH", "chatgpt")
    vi.stubEnv("OPENAI_API_KEY", undefined)
    vi.stubEnv("CODEX_HOME", home)
    vi.stubEnv("PATH", home)

    const model = liveModel("openai:gpt-5")
    const failure = await Effect.runPromise(Effect.flip(Stream.runCollect(model.stream(request))))

    expect(failure.message).toContain("install Codex, then run `codex login --device-auth`")
    expect(failure.message).not.toContain("OPENAI_API_KEY")
  })
})
