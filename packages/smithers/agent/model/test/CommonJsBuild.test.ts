import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { beforeAll, describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)
const expectedExports = [
  "AnthropicMessages",
  "Auth",
  "CanonicalJson",
  "Classifier",
  "DeferredTools",
  "Endpoint",
  "Evaluator",
  "EvaluatorBackup",
  "FailureCopy",
  "Framing",
  "Model",
  "ModelCatalog",
  "ModelError",
  "ModelEvent",
  "ModelRequest",
  "OpenAIChatCompletions",
  "OpenAIChatGPT",
  "OpenAIResponses",
  "Protocol",
  "RequestExecutor",
  "Route",
  "ToolStream"
] as const

describe("CommonJS build", () => {
  beforeAll(
    () => {
      execFileSync(process.execPath, ["scripts/build.mjs"], {
        cwd: new URL("..", import.meta.url),
        stdio: "pipe"
      })
    },
    // Declaration generation traverses workspace dependencies; a loaded
    // checkout can spend more than 30 seconds building before tests start.
    120_000
  )

  it("shares ModelError identity across independently imported subpaths", () => {
    const anthropic = require("../dist/cjs/AnthropicMessages.js") as {
      readonly protocol: {
        readonly classifyError: (status: number, body: string) => unknown
      }
    }
    const errors = require("../dist/cjs/ModelError.js") as {
      readonly ModelError: new(...args: ReadonlyArray<never>) => Error
    }
    const error = anthropic.protocol.classifyError(
      429,
      "{\"error\":{\"type\":\"rate_limit_error\",\"message\":\"limited\"}}"
    )

    expect(error).toBeInstanceOf(errors.ModelError)
  })

  it("exports the exact public namespace set from ESM", async () => {
    const index = await import("../src/index.ts")
    expect(Object.keys(index).sort()).toEqual(expectedExports)
  })

  it("exports the exact public namespace set from CommonJS", () => {
    const index = require("../dist/cjs/index.js") as Readonly<Record<string, unknown>>
    expect(Object.keys(index).sort()).toEqual(expectedExports)
  })

  it("keeps the README namespace list synchronized with the barrel", async () => {
    const index = await import("../src/index.ts")
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8")
    const section = readme.split(/^## /m).find((chunk) => chunk.startsWith("Public API\n"))
    expect(section).toBeDefined()
    const documented = [...(section ?? "").matchAll(/^- \*\*`([^`]+)`\*\*:/gm)].map((match) => match[1]).sort()

    expect(documented).toEqual(Object.keys(index).sort())
    expect(documented).toEqual(expectedExports)
  })
})
